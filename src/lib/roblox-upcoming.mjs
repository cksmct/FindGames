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
 *   ① 用 **Wayback 快照**取 BloxInformer Release Hub 的页面（直连被 Cloudflare 403，快照可抓）
 *   ② 从页面**内嵌 JSON** 里解析出结构化的即将发售清单（含发售日时间戳与状态）
 *   ③ 支持**本地覆盖文件**：把浏览器里另存的页面丢到 data/roblox-upcoming.html，
 *      就会优先用它（新鲜度可自控），快照只是兜底
 *
 * 三条硬护栏：
 *   · **绝不把快照当成"今天的实时数据"**：每条都带 snapshotAt，过期了要在页面上显式告警
 *   · **解析失败就报错，不返回空列表**（空 = "没有即将发售的游戏"，会误导）
 *   · 快照里已经发售的条目（releaseTimestamp 已过）默认**剔除并计数**，但要如实报出剔除了几条
 */
import { dataPath, readJson, writeJson, iso, log, sleep, retry } from "./util.mjs";

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
 * 优先级：本地覆盖文件 > 12 小时内的缓存 > Wayback 快照
 * @returns {Promise<{items:Array, snapshotAt:string, source:string, stale:boolean}>}
 */
export async function loadRobloxUpcoming(cfg) {
  const w = cfgOf(cfg);
  const fs = await import("node:fs");
  const cacheFile = dataPath(cfg, ".roblox-upcoming.json");
  const cache = readJson(cacheFile, null);
  const now = Date.now();
  const cacheFresh = cache && cache.parserVersion === PARSER_VERSION && cache.fetchedAt &&
    now - new Date(cache.fetchedAt).getTime() < (w.cacheHours || 12) * 3600000;

  // ① 本地覆盖文件（你在浏览器里另存的页面）——最新鲜，优先
  const overrideFile = dataPath(cfg, "roblox-upcoming.html");
  try {
    if (fs.existsSync(overrideFile)) {
      const st = fs.statSync(overrideFile);
      const ageDays = (now - st.mtimeMs) / 86400000;
      if (ageDays <= (w.overrideMaxDays || 3)) {
        const raw = parseBloxInformer(fs.readFileSync(overrideFile, "utf8")).games;
        const snapAt = iso(new Date(st.mtimeMs));
        writeJson(cacheFile, { parserVersion: PARSER_VERSION, fetchedAt: iso(), snapshotAt: snapAt, source: "local-override", raw }, true);
        return { items: raw, snapshotAt: snapAt, source: "local-override", stale: false };
      }
      log("dim", `  Roblox 即将发售：本地覆盖文件已过期（${ageDays.toFixed(1)} 天 > ${w.overrideMaxDays} 天），改用快照`);
    }
  } catch (e) {
    log("warn", `  Roblox 即将发售：本地覆盖文件解析失败（${e.message}），改用快照`);
  }

  // ② 缓存
  if (cacheFresh && cache.raw && cache.raw.length) {
    const ageDays = (now - new Date(cache.snapshotAt).getTime()) / 86400000;
    return { items: cache.raw, snapshotAt: cache.snapshotAt, source: cache.source, stale: ageDays > 21 };
  }

  // ③ Wayback 快照：三条通道依次试（实测稳定性 直链 > 最近快照入口 > CDX），
  //    全失败才降级用任何年龄的缓存 —— 旧数据也好过没有数据，只要如实标注。
  const channels = [];
  if (cache && cache.snapshotUrl) channels.push(["cached-url", () => fetchSnapshotUrl(cache.snapshotUrl)]);
  channels.push(["latest", () => fetchWaybackLatest(PAGE)]);
  channels.push(["cdx", async () => {
    const s = await waybackLatestViaCdx(PAGE);
    if (!s) throw new Error("CDX 里没有快照");
    return fetchSnapshotUrl(s.url);
  }]);

  let snap = null;
  let lastErr = null;
  for (const [name, fn] of channels) {
    try {
      snap = await fn();
      if (snap && snap.html) { snap.channel = name; break; }
    } catch (e) {
      lastErr = e;
      log("dim", `  Roblox 即将发售：通道 ${name} 失败（${e.message}），换下一个`);
    }
    await sleep(1200);
  }

  if (snap && snap.html) {
    try {
      const raw = parseBloxInformer(snap.html).games;
      const snapshotAt = tsToIso(snap.ts) || iso();
      writeJson(cacheFile, { parserVersion: PARSER_VERSION, fetchedAt: iso(), snapshotAt, snapshotUrl: snap.url, source: "wayback:" + snap.channel, raw }, true);
      const ageDays = (now - new Date(snapshotAt).getTime()) / 86400000;
      return { items: raw, snapshotAt, source: "wayback:" + snap.channel, stale: ageDays > 21 };
    } catch (e) {
      lastErr = e;
    }
  }

  if (cache && cache.parserVersion === PARSER_VERSION && Array.isArray(cache.raw) && cache.raw.length) {
    log("warn", `  Roblox 即将发售：快照不可用（${lastErr ? lastErr.message : "无快照"}），降级使用 ${String(cache.snapshotAt).slice(0, 10)} 的旧缓存`);
    return { items: cache.raw, snapshotAt: cache.snapshotAt, source: String(cache.source || "cache") + "+stale", stale: true, error: lastErr ? lastErr.message : "无快照" };
  }
  throw lastErr || new Error("Wayback 上没有该页快照");
}
