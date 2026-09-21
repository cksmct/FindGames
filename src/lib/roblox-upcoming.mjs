/**
 * Roblox「即将发售」来源 —— 补上官方没有的那一块。
 *
 * 🛑 先说清楚一个事实（实测 2026-09-21）：
 *   **Roblox 官方没有任何"未发布体验"的公开列表**。
 *   · 官方 Discover 只有 `up-and-coming`（= **已经上线**、刚起量的游戏，不是未发布）
 *   · `bloxinformer.com` / `robipedia.com` / `rolimons.com` 里只有 BloxInformer 有这份清单，
 *     而它自述数据来自「官方公告 + Discord 爆料 + 开发者社媒」——即**第三方人工核实**，不是官方 API
 *
 * 所以本模块做三件事：
 *   ① **直连** BloxInformer Release Hub（Node fetch 会被 Cloudflare 按 TLS 指纹拦，
 *      自动换 `curl` 通道即可 200 —— 见 web-fetch.mjs）
 *   ② 从页面**内嵌 JSON**（`window.urgArchiveData`）里解析出结构化清单（发售日时间戳 + 状态 + 社媒）
 *   ③ 三级兜底：本地覆盖文件（你在浏览器里另存的页面）> 1 小时缓存 > Wayback 存档 + 旧缓存
 *
 * 三条硬护栏：
 *   · **绝不把快照当成"今天的实时数据"**：每条都带 snapshotAt，过期了要在页面上显式告警
 *   · **解析失败就报错，不返回空列表**（空 = "没有即将发售的游戏"，会误导）
 *   · 快照里已经发售的条目（releaseTimestamp 已过）默认**剔除并计数**，但要如实报出剔除了几条
 */
import { dataPath, readJson, writeJson, iso, log, sleep, retry } from "./util.mjs";
import { fetchPage } from "./web-fetch.mjs";

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";
const PAGE = "https://bloxinformer.com/upcoming-roblox-games/";

const DEFAULTS = {
  enabled: true,
  cacheHours: 12,          // 快照内容变化慢，别每小时都去 Wayback 打
  overrideMaxDays: 3,      // 本地覆盖文件的保鲜期
  dropPast: true,          // 剔除已经发售的（快照可能已过期）
  maxItems: 80,
};

const cfgOf = (cfg) => Object.assign({}, DEFAULTS, (cfg && cfg.watchlist && cfg.watchlist.robloxUpcoming) || {});

/** 解析器结构版本：改了字段/解析策略就 +1，让旧缓存自动作废（否则要等 TTL 过期才生效） */
const PARSER_VERSION = 5;

/**
 * 平衡括号扫描（跳过字符串内部），返回与 s[start] 配对的结束下标。
 * 不能简单用 indexOf("]}") —— 描述文本里出现过 `]}`。
 */
export function matchBracket(s, start) {
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') { inStr = true; continue; }
    if (c === "[" || c === "{") depth++;
    else if (c === "]" || c === "}") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/**
 * 从 BloxInformer 页面 HTML 里解析即将发售清单。
 *
 * ⚠️ 实测该页在网络层是**转义存放**的（属性写成 \"、URL 写成 \/），
 *    所以必须先还原一层反转义，否则 JSON.parse 必失败。
 * @returns {{games:Array<object>, start:number, end:number}} 原始游戏对象数组与它在文档中的位置
 */
export function parseBloxInformer(html) {
  const variants = [String(html || "")];
  const unwrapped = unwrapArchiveBody(variants[0]);
  if (unwrapped && unwrapped !== variants[0]) variants.push(unwrapped);

  let best = null;
  const consider = (r) => {
    if (r && r.games && r.games.length && (!best || r.games.length > best.games.length)) best = r;
  };
  for (const s of variants) {
    try { consider(byAnchor(s)); } catch { /* 试下一种 */ }
    try { consider(byScan(s)); } catch { /* 试下一种 */ }
  }
  if (!best) throw new Error("未识别出游戏清单（锚点与扫描都没命中，页面结构可能已变）");
  return best;
}

/** ① 锚点解析：清单挂在 window.urgArchiveData = {"games":[…]} 上（实测 41 条） */
function byAnchor(s) {
  const anchor = s.indexOf("urgArchiveData");
  if (anchor < 0) throw new Error("没有 urgArchiveData 锚点");
  const brace = s.indexOf("{", anchor);
  if (brace < 0) throw new Error("锚点后没有 {");
  const end = matchBracket(s, brace);
  if (end < 0) throw new Error("锚点对象括号不闭合");
  const obj = JSON.parse(s.slice(brace, end + 1));
  const games = Array.isArray(obj.games) ? obj.games : [];
  if (!games.length) throw new Error("锚点里没有 games");
  return { games, start: brace, end, via: "anchor" };
}

/**
 * ② 扫描兜底：取**条目最多**的游戏数组。
 *    页面上还有很多小数组（statuses / platforms / Featured / Recently Added），
 *    实测"第一个匹配的"只有 8 条 —— 用长度取胜比位置启发式稳。
 */
function byScan(s) {
  const attempts = [];
  let i = -1;
  while ((i = s.indexOf("[{", i + 1)) >= 0) {
    attempts.push(i);
    if (attempts.length > 300) break;
  }
  if (!attempts.length) throw new Error("没有内嵌 JSON 数组");
  let best = null;
  for (const start of attempts) {
    const end = matchBracket(s, start);
    if (end < 0) continue;
    let arr;
    try {
      arr = JSON.parse(s.slice(start, end + 1));
    } catch {
      continue;
    }
    if (!Array.isArray(arr) || arr.length < 3) continue;
    const games = arr.filter((x) => x && typeof x === "object" && typeof x.name === "string" && x.name &&
      ("permalink" in x || "releaseTimestamp" in x || "statuses" in x));
    if (games.length < 3) continue;
    if (!best || games.length > best.games.length) best = { games, start, end, via: "scan" };
  }
  if (!best) throw new Error(`扫描没找到游戏数组（试了 ${attempts.length} 个起点）`);
  return best;
}

/**
 * 还原"整份文档被当成 JSON 字符串"的情况（少数镜像/代理会这样存）。
 *
 * 🛑 曾经的错误做法：只要正文里出现 `\"` 就整体正则反转义。
 *    实测该页面本来就是**普通 HTML**（引号就是普通引号），`\"` 只出现在它自己的 JS 里；
 *    一正则替换就把 JSON 结构"松掉"，锚点解析失败并退化成只认到 8 条（踩过）。
 *    现在只在"整份文档能被 JSON.parse 成含 <html> 的字符串"时才还原，否则原样返回。
 */
function unwrapArchiveBody(raw) {
  const s = String(raw || "").trim();
  if (!s.startsWith('"')) return null;
  try {
    const v = JSON.parse(s);
    if (typeof v === "string" && v.indexOf("<html") >= 0) return v;
  } catch {
    /* 不是 JSON 包裹，保持原样 */
  }
  return null;
}

const MONTHS = { january: 0, february: 1, march: 2, april: 3, may: 4, june: 5, july: 6, august: 7, september: 8, october: 9, november: 10, december: 11 };
const MONTH_ABBR = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * 去掉 Wayback 的 URL 前缀。
 *
 * ⚠️ 实测坑：Wayback 会把**页面内所有 URL 一并重写**（包括内嵌 JSON 里的 permalink /
 *    robloxLink / discord），于是清单里每条链接都变成
 *    `http://web.archive.org/web/<ts>/https://bloxinformer.com/...` ——
 *    直接给用户点，等于每次都要先过一遍存档页。这里还原成原始 URL。
 */
export function cleanUrl(u) {
  const s = String(u || "").trim();
  if (!s) return "";
  const m = s.match(/^https?:\/\/web\.archive\.org\/web\/\d{14}[a-z_]*\/(https?:\/\/.+)$/i)
    || s.match(/^\/web\/\d{14}[a-z_]*\/(https?:\/\/.+)$/i);
  return m ? m[1] : s;
}

function utcMidnight(ms) {
  const d = new Date(ms);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

/**
 * 把 BloxInformer 的一条记录正规化。
 * 官方页面给了两种日期形态：① releaseTimestamp（倒计时用，精确到日）② releaseDateLabel 文本（如 "Sometime in August 2026"）
 */
export function normalizeEntry(g, now = Date.now()) {
  const statuses = (g.statuses || []).map((x) => x && x.label).filter(Boolean);
  const genres = (g.genres || []).filter(Boolean);
  let ts = Number(g.releaseTimestamp) || null;
  let precision = ts ? "day" : "unknown";
  let label = String(g.releaseDateLabel || "").trim();

  // 文本形态：能认出「<Month> <Year>」就降级成月份精度（只用于排序提示，不假装知道具体哪天）
  if (!ts && label) {
    const m = label.match(/([A-Za-z]+)\s+(\d{4})/);
    if (m) {
      const mi = MONTHS[String(m[1]).toLowerCase()];
      if (mi != null) {
        ts = Date.UTC(Number(m[2]), mi, 1);
        precision = "month";
      } else if (/^\d{4}$/.test(m[2])) {
        ts = Date.UTC(Number(m[2]), 0, 1);
        precision = "year";
      }
    }
  }

  const days = ts == null ? null : Math.round((utcMidnight(ts) - utcMidnight(now)) / 86400000);
  const dateText = ts == null
    ? (label || "未定档")
    : (precision === "month" ? MONTH_ABBR[new Date(ts).getUTCMonth()] + " " + new Date(ts).getUTCFullYear()
      : precision === "year" ? String(new Date(ts).getUTCFullYear())
        : MONTH_ABBR[new Date(ts).getUTCMonth()] + " " + new Date(ts).getUTCDate() + ", " + new Date(ts).getUTCFullYear());

  return {
    id: "bloxinformer:" + (g.id || g.name),
    name: String(g.name || "").trim(),
    status: statuses.join(" / "),
    genres,
    developer: String(g.developer || "").trim(),
    platforms: (g.platforms || []).map((p) => p && p.label).filter(Boolean),
    released: dateText,
    releasePrecision: precision,
    releaseInDays: days,
    robloxUrl: cleanUrl(g.robloxLink),
    sourceUrl: cleanUrl(g.permalink),
    social: {
      robloxGroup: cleanUrl(g.social && g.social.robloxGroup),
      discord: cleanUrl(g.social && g.social.discord),
      youtube: cleanUrl(g.social && g.social.youtube),
      tiktok: cleanUrl(g.social && g.social.tiktok),
    },
    ts,
  };
}

/** 单次 GET（带超时 + 轻退避），取文本。Wayback 会限流也会很慢，没超时会把整轮采集拖住。 */
async function getText(url, label, timeoutMs = 30000, retries = 1) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    return await retry(async () => {
      const r = await fetch(url, { headers: { "user-agent": UA }, signal: ac.signal, redirect: "follow" });
      if (r.status === 429) throw new Error("429 限流");
      if (!r.ok) throw new Error("HTTP " + r.status);
      return { text: await r.text(), url: r.url };
    }, { retries, base: 4000, label });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 潜伏评分（0~100）——**只用于"还没上线"的候选**，四个维度都是上线前可测的：
 *
 *   发布确定性 35  官方/开发者口风（Confirmed > Beta/Early Access > In Development > Pre-Alpha > Delayed > Maybe Cancelled）
 *   日期精确度 25  确切日期 > 月份 > 季度 > 年份 > 未定档（决定"现在动手来不来得及"）
 *   内容面     20  由 genres 推断"能写多少页面"（图鉴/配队类 ≫ 只值得做 codes 的玩法）
 *   社区地基   20  有无 Discord / YouTube / Roblox 群组（有社群才有需求地基）
 *
 * 它与"窗口"(build/close/far) 是两个正交维度：评分高但窗口只剩 7 天 = 来不及；
 * 评分低哪怕还有 3 个月 = 也不值得投。
 *
 * 🛑 这是**启发式**，不是实测：内容面靠 genres 推断（页面没有"能写多少页"这种字段）。
 *    所以理由必须跟着分数一起显示，让人能一眼反驳它。
 */
const GENRE_TIERS = [
  { re: /monster catching|turn based|rpg|adventure|open world/i, score: 92, why: "有单位/技能/养成体系（图鉴·配队·流派页可写）" },
  { re: /survival|tycoon|simulator|simulation|sports|strategy/i, score: 70, why: "有系统/道具/升级线（攻略页中等）" },
  { re: /action|shooter|horror|anime|racing|puzzle|fighting|battle/i, score: 52, why: "攻略面偏薄（多为机制/通关说明）" },
  { re: /escape|obby|platformer|rng|party|casual|social|utility/i, score: 28, why: "内容面窄，通常只值得做 codes 页" },
];
const STATUS_TIERS = [
  { re: /confirmed|release date|launch date/i, score: 100, label: "已确认" },
  { re: /beta|early access/i, score: 82, label: "测试中" },
  // 容忍站方拼写错误（实测有 "In Deveopment" 这种）
  { re: /in deve?lop/i, score: 55, label: "开发中" },
  { re: /pre-?alpha|alpha/i, score: 40, label: "早期原型" },
  { re: /delayed/i, score: 30, label: "已延期" },
  { re: /maybe cancelled|cancelled|canceled/i, score: 5, label: "可能取消" },
];

/** @param {object} g normalizeEntry 的输出（含 status/genres/social/releasePrecision/releaseInDays） */
export function scoreUpcoming(g) {
  const reasons = [];
  const missing = [];

  // ① 发布确定性
  const statusStr = String(g.status || "");
  let st = { score: 45, label: "未标注" };
  for (const t of STATUS_TIERS) if (t.re.test(statusStr)) { st = t; break; }
  if (!statusStr) missing.push("状态未标注");
  reasons.push(`发布确定性 ${st.score}（${st.label}：${statusStr || "未标注"}）`);

  // ② 日期精确度
  const dp = g.releasePrecision || "unknown";
  const CONF = { day: 100, month: 70, quarter: 55, year: 40, unknown: 15 };
  const dateScore = CONF[dp] == null ? 15 : CONF[dp];
  reasons.push(`日期 ${dateScore}（${{ day: "确切日期", month: "只有月份", quarter: "只有季度", year: "只有年份" }[dp] || "未定档"}：${g.released || "—"}）`);

  // ③ 内容面（取命中里**最高**的一档）
  let surface = 30;
  let surfaceWhy = "类型不足以判断（按最低档计）";
  for (const t of GENRE_TIERS) {
    if ((g.genres || []).some((x) => t.re.test(String(x)))) { surface = t.score; surfaceWhy = t.why; break; }
  }
  if (!(g.genres || []).length) missing.push("无类型标注");
  reasons.push(`内容面 ${surface}（${(g.genres || []).join("/") || "无类型"} → ${surfaceWhy}）`);

  // ④ 社区地基
  const social = g.social || {};
  let community = 0;
  const have = [];
  if (social.discord) { community += 8; have.push("Discord"); }
  if (social.youtube) { community += 6; have.push("YouTube"); }
  if (social.robloxGroup) { community += 6; have.push("Roblox 群组"); }
  community = Math.min(20, community);
  if (!have.length) missing.push("无任何社媒链接");
  reasons.push(`社区地基 ${community}（${have.join(" + ") || "无"}）`);

  const score = Math.round(st.score * 0.35 + dateScore * 0.25 + surface * 0.2 + community * 0.2);

  // 风险与窗口
  const risky = /maybe cancelled|cancelled|canceled|delayed/i.test(statusStr);
  const d = g.releaseInDays;
  let band;
  if (d != null && d < 7) band = { k: "too-late", t: "窗口已过（≤7 天）" };
  else if (risky) band = { k: "risk", t: "风险（延期 / 可能取消）" };
  else if (score >= 75) band = { k: "go", t: "值得潜伏" };
  else if (score >= 55) band = { k: "watch", t: "观察" };
  else band = { k: "no", t: "暂不" };

  return { score, band, reasons, missing };
}

/** 时间戳 → ISO（必须用 UTC，本机 UTC+8 用本地时区会差一天） */
export function tsToIso(ts) {
  if (!ts || ts.length < 8) return "";
  return new Date(Date.UTC(Number(ts.slice(0, 4)), Number(ts.slice(4, 6)) - 1, Number(ts.slice(6, 8)))).toISOString();
}

/**
 * 直接取一个已知的快照 URL（`/web/<ts>id_/<原页>`）。
 * 实测**直链最稳** —— `/web/2/`（最近快照入口）与 CDX 都更容易被 429。
 */
export async function fetchSnapshotUrl(url) {
  const { text, url: finalUrl } = await getText(url, "wayback-direct");
  const m = String(finalUrl).match(/\/web\/(\d{14})/);
  return { html: text, ts: m ? m[1] : "", url: finalUrl };
}

/** 取「最近一次快照」：`/web/2/<url>` 会跳到真正的快照，时间戳在跳转后的 URL 里 */
export async function fetchWaybackLatest(pageUrl = PAGE) {
  const { text, url } = await getText("http://web.archive.org/web/2/" + pageUrl, "wayback-latest");
  const m = String(url).match(/\/web\/(\d{14})/);
  return { html: text, ts: m ? m[1] : "", url };
}

/** CDX 列出该页最近的 200 快照，返回最后一条（兜底通道；实测最容易慢/限流） */
export async function waybackLatestViaCdx(pageUrl = PAGE) {
  const cdx = "http://web.archive.org/cdx/search/cdx?url=" + encodeURIComponent(pageUrl) +
    "&output=json&limit=-8&filter=statuscode:200";
  const { text } = await getText(cdx, "wayback-cdx");
  const rows = JSON.parse(text || "[]");
  const body = rows.slice(1).filter((x) => x && x[1]);
  if (!body.length) return null;
  const last = body[body.length - 1];
  return { ts: last[1], url: "http://web.archive.org/web/" + last[1] + "id_/" + pageUrl };
}

/**
 * 取「即将发售」原始记录（带缓存）。
 *
 * 🛑 2026-09-21 重排优先级（用户质问"为什么走 Wayback，不能直接抓吗"）：
 *    实测 **curl 直连 bloxinformer.com 返回 200 + 完整页面** —— 根本不需要 Wayback。
 *    所以现在的顺序是：
 *      ① 本地覆盖文件（你自己另存的页面，最新鲜）
 *      ② 1 小时内的缓存
 *      ③ **直连**（`fetchPage`：Node fetch → 被 CF 拦就换 curl 通道）
 *      ④ Wayback 快照（仅当直连也不通时的兜底；实测 Internet Archive 会整站 503）
 *      ⑤ 任意年龄的旧缓存 + stale 标记（旧数据也好过没有，但要如实标注）
 * @returns {Promise<{items:Array, snapshotAt:string, source:string, stale:boolean}>}
 */
export async function loadRobloxUpcoming(cfg) {
  const w = cfgOf(cfg);
  const fs = await import("node:fs");
  const cacheFile = dataPath(cfg, ".roblox-upcoming.json");
  const cache = readJson(cacheFile, null);
  const now = Date.now();
  const cacheFresh = cache && cache.parserVersion === PARSER_VERSION && cache.fetchedAt &&
    now - new Date(cache.fetchedAt).getTime() < (w.cacheHours || 1) * 3600000;
  const save = (raw, snapshotAt, source, extra = {}) =>
    writeJson(cacheFile, Object.assign({ parserVersion: PARSER_VERSION, fetchedAt: iso(), snapshotAt, source, raw }, extra), true);

  // ① 本地覆盖文件（你在浏览器里另存的页面）——最新鲜，优先
  const overrideFile = cfg._robloxHtmlPath || dataPath(cfg, "roblox-upcoming.html");
  try {
    if (fs.existsSync(overrideFile)) {
      const st = fs.statSync(overrideFile);
      const ageDays = (now - st.mtimeMs) / 86400000;
      if (cfg._robloxHtmlPath || ageDays <= (w.overrideMaxDays || 3)) {
        const raw = parseBloxInformer(fs.readFileSync(overrideFile, "utf8")).games;
        const snapAt = iso(new Date(st.mtimeMs));
        save(raw, snapAt, "local-override");
        return { items: raw, snapshotAt: snapAt, source: "local-override", stale: false };
      }
      log("dim", `  Roblox 即将发售：本地覆盖文件已过期（${ageDays.toFixed(1)} 天 > ${w.overrideMaxDays} 天），改用直连`);
    }
  } catch (e) {
    log("warn", `  Roblox 即将发售：本地覆盖文件解析失败（${e.message}），改用直连`);
  }

  // ② 缓存（默认 1 小时）
  if (cacheFresh && cache.raw && cache.raw.length) {
    const ageH = (now - new Date(cache.snapshotAt).getTime()) / 3600000;
    return { items: cache.raw, snapshotAt: cache.snapshotAt, source: cache.source, stale: ageH > 26 };
  }

  let lastErr = null;

  // ③ 直连（Node fetch → curl 兜底）
  if (w.directFetch !== false) {
    try {
      const res = await fetchPage(PAGE, { timeoutMs: 30000, label: "bloxinformer/upcoming" });
      const raw = parseBloxInformer(res.html).games;
      const snapshotAt = iso();
      save(raw, snapshotAt, "direct:" + res.via);
      if (res.via === "curl") log("dim", "  Roblox 即将发售：Node fetch 被 Cloudflare 拦，curl 通道直连成功");
      return { items: raw, snapshotAt, source: "direct:" + res.via, stale: false };
    } catch (e) {
      lastErr = e;
      log("dim", `  Roblox 即将发售：直连失败（${e.message}）`);
    }
  }

  // ④ Wayback 兜底：三条通道依次试（实测稳定性 直链 > 最近快照入口 > CDX）
  if (w.waybackFallback !== false) {
    const channels = [];
    if (cache && cache.snapshotUrl) channels.push(["cached-url", () => fetchSnapshotUrl(cache.snapshotUrl)]);
    channels.push(["latest", () => fetchWaybackLatest(PAGE)]);
    channels.push(["cdx", async () => {
      const s = await waybackLatestViaCdx(PAGE);
      if (!s) throw new Error("CDX 里没有快照");
      return fetchSnapshotUrl(s.url);
    }]);

    let snap = null;
    for (const [name, fn] of channels) {
      try {
        snap = await fn();
        if (snap && snap.html) { snap.channel = name; break; }
      } catch (e) {
        lastErr = e;
        log("dim", `  Roblox 即将发售：存档通道 ${name} 失败（${e.message}）`);
      }
      await sleep(1200);
    }

    if (snap && snap.html) {
      try {
        const raw = parseBloxInformer(snap.html).games;
        const snapshotAt = tsToIso(snap.ts) || iso();
        save(raw, snapshotAt, "wayback:" + snap.channel, { snapshotUrl: snap.url });
        const ageDays = (now - new Date(snapshotAt).getTime()) / 86400000;
        log("warn", `  Roblox 即将发售：直连不通，退回 Wayback 快照（${snapshotAt.slice(0, 10)}）`);
        return { items: raw, snapshotAt, source: "wayback:" + snap.channel, stale: ageDays > 21 };
      } catch (e) {
        lastErr = e;
      }
    }
  }

  // ⑤ 任意年龄的旧缓存
  if (cache && cache.parserVersion === PARSER_VERSION && Array.isArray(cache.raw) && cache.raw.length) {
    log("warn", `  Roblox 即将发售：直连与存档都不可用（${lastErr ? lastErr.message : "无可用通道"}），降级使用 ${String(cache.snapshotAt).slice(0, 16)} 的旧缓存`);
    return { items: cache.raw, snapshotAt: cache.snapshotAt, source: String(cache.source || "cache") + "+stale", stale: true, error: lastErr ? lastErr.message : "无可用通道" };
  }
  throw lastErr || new Error("BloxInformer 页面取不到（直连与存档都失败）");
}
