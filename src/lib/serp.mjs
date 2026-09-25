/**
 * 竞争的**自动 SERP 核查**（2026-09-24 新增）
 *
 * ── 为什么需要它 ─────────────────────────────────────────────────────────────
 * `compRoom()`（前端算分）的竞争项只有两条来源：**人工 SERP 核查**（最准，但要人一条条看）
 * 与**上线时长推断**（拿官方上线日当代理）。而**安卓条目永远拿不到上线日**
 * （实测 Play 详情页既无 `datePublished` 也无 "Released on"，只有 "Updated on"）——
 * 于是它们的竞争项恒为「未测」→ 按既定护栏**总分只能是 null** → 在 🎯 建站推荐里
 * 「看得见、判不了」。这不是数据缺一点，而是整条安卓来源没有出口。
 *
 * ── 为什么是 DuckDuckGo ────────────────────────────────────────────────────
 * 实测 2026-09-24：`html.duckduckgo.com/html/?q=<查询词>` 可**直连**（200，约 33KB，
 * 40 条结果链接，标题正常）。结果链接形如 `/l/?uddg=<urlencoded>` —— 解码后即可
 * 数出**独立域名**，而"数一下前十有几个独立域名占位"正是人工核查的那一步
 * （见前端「查竞争（SERP）」按钮的提示）。把它自动化 = 把"人工优先"的口径变成每轮自动跑。
 * （对照：AppBrain / APKPure / APKMirror 对 Node fetch 与 curl 均 403；QooApp 202 空响应。）
 *
 * ── 三条护栏（都是既有纪律的重复应用）──────────────────────────────────────
 *  1. **限流不等于没有竞争**：429 / 挑战页 / 结构变化一律**不写缓存**，该条目继续显示「未测」，
 *     绝不当成"0 个域名 = 竞争极低"（负缓存禁令，与 Roblox 429 同源）。
 *  2. **取样范围（2026-09-25 修正）**：原先只测「拿不到官方上线日」的条目 —— 结果是
 *     **最需要核查的新游戏反而被跳过**（有官方上线日 → 跳过 → 竞争项被"上线时长推断"接管
 *     → 白送满分）。Dressmaker 事故就是这么来的：上线 4 天拿到 comp=100，
 *     而真实 SERP 上已有 8+ 个专为该游戏新建的站。现在**抢首发区间（≤ maxAgeDays）也测**；
 *     老条目才有 age 推断可用，不重复花请求。前端 `compRoom` 是配套改的（两边必须同改）。
 *  3. **判据是域名数，不是结果总数**（谷歌早已取消精确结果数）：同一站点的子域算一个，
 *     并排掉应用商店 / 视频社交 / 通用百科 —— 它们不是"占位的专业站"。
 *
 * ── 🆕 2026-09-25：Wayback CDX 查「首个专站出现日」──────────────────────────
 * 竞争项回答的是"**对手有几个站**"，但决定成败的是"**我们比最早进场者晚了多少**"
 * （用户口径：「我们不惧怕竞争，只是不能比别人晚太多」）。后者需要"第一个专站何时出现"。
 * 做法：对 SERP 前十的独立域名各查一次 Wayback CDX 的**最早快照**，取最早的日期写进
 * `g.serp.competitorFirstSeen` → 前端 `lagMultOf()` 据此算 `ourLagDays` 并乘在总分上。
 * 实测（2026-09-25）：`dressmakers.wiki` 最早快照 `20260914023600` —— 发售（9-21）前 7 天就存在。
 *   🛑 这是**下界**：未被 Wayback 收录的域名查不到（`dressmaker.wiki` 就没被收录）→ 实际可能更早。
 *      查不到就返回 null（不猜、不罚）。
 */
import { dataPath, readJson, writeJson, iso, log, sleep } from "./util.mjs";

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";
const DDG = "https://html.duckduckgo.com/html/?q=";

/** 不算"占位专业站"的域名：应用商店 / 视频社交 / 通用百科 */
const NOISE = /^(play\.google\.com|apps\.apple\.com|itunes\.apple\.com|youtube\.com|youtu\.be|facebook\.com|instagram\.com|tiktok\.com|x\.com|twitter\.com|pinterest\.[a-z.]+|twitch\.tv|discord\.com|discord\.gg|wikipedia\.org|amazon\.[a-z.]+|google\.[a-z.]+|bing\.com|duckduckgo\.com|linkedin\.com|threads\.net|snapchat\.com)$/;

// 多段后缀（co.uk / com.br / co.jp …）：算站点时要多取一层，否则会把不同站点并成一个
const MULTI_TLD = /\.(co|com|net|org|gov|edu|ac|or|ne|go)\.[a-z]{2}$/;

/** 主机名 → 站点（剥 www；近似 eTLD+1） */
function siteOf(host) {
  const h = String(host || "").toLowerCase().replace(/^www\./, "");
  if (!h) return "";
  const parts = h.split(".");
  if (MULTI_TLD.test(h)) return parts.slice(-3).join(".");
  return parts.slice(-2).join(".");
}

/**
 * **专用站数** → 竞争档 open（1~5，5 = 最空）。🛑 这几档就是人工核查的判据，别随手调。
 *
 * 🛑 2026-09-25 口径修正（用户：「**我们的对手当然是新建的站**」）：
 *   分档输入从"前十独立域名**总数**"改为"**专为这个游戏建的站数**"。
 *   原因（实测 2026-09-25 真实采集）：Roblox 潜伏条目的前十全是
 *   `progameguides.com / pocketgamer.com / beebom.com / destructoid.com / tryhardguides.com / bloxinformer.com` ——
 *   这些**通用游戏媒体/数据站**对**每个**游戏都写 `codes` 页，是基线噪音；
 *   按总数分档会让 5/5 条 Roblox 条目全被判「竞争已起」（档 1~2），把最该做的标的误杀。
 *   而 Dressmaker 的 `dressmaker.wiki / dressmakers.wiki / dressmaker-game.wiki …` 才是真对手。
 */
const BANDS = [[0, 5], [2, 4], [4, 3], [7, 2], [Infinity, 1]];
const bandOf = (n) => (BANDS.find(([max]) => n <= max) || BANDS[BANDS.length - 1])[1];

/** 归一化成 slug（只留 a-z0-9）—— 用于判断"这个域名是不是为这个游戏建的" */
const slugOf = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "");

/**
 * 判断一个域名是不是**专为这个游戏建的站**：域名（eTLD+1）里含游戏名 slug。
 *   实测：`dressmaker.wiki` → 含 `dressmaker` ✅ · `nethros.wiki` → 含 `nethros` ✅
 *         `progameguides.com` / `pocketgamer.com` → 不含游戏名 ❌（通用媒体）
 * 🛑 游戏名 slug 短于 4 字符时**不做判断**（避免 `abc` 这类误匹配）→ 一律算通用站。
 */
export function isDedicatedSite(site, name) {
  const g = slugOf(name);
  if (g.length < 4) return false;
  return slugOf(site).includes(g);
}

/**
 * open(1~5) → 分数（分高 = 竞争低）。**人工核查 / 自动 SERP / 潜伏评分三处共用同一张表**，
 * 口径才可比。
 * 🛑 前端 `web/app.js` 有一份同值的 `OPEN_SCORE`（浏览器端无法 import），
 *    改这里必须同步改那边 —— 两处不一致会让"人工填的 open"和"机器测的域名数"失去可比性。
 */
export const OPEN_SCORE = [10, 25, 50, 75, 100];
export const openScore = (v) => OPEN_SCORE[Math.max(1, Math.min(5, Math.round(v))) - 1];
/** 竞争"已被占满"的判据：≥5 个独立域名（open ≤ 2）。潜伏评分据此直接标「竞争已起」 */
export const COMP_SATURATED_OPEN = 2;

/**
 * 自述随产物下发（`games.json.serp`）→ 前端规则块据实展示，**单一事实源在这里**，
 * 前端不再手抄一份档位（手抄过一次就已经抄错了，见 demandAnchorsText 的教训）。
 */
export const SERP_RULES = {
  title: "竞争 = 自动 SERP 核查（「<游戏名> codes」前十的「专用站」数）",
  source: "DuckDuckGo HTML 结果页（零密钥，实测可直连）",
  query: "<游戏名> codes",
  bands: "**专用站**数（域名含游戏名 slug ＝「专为这个游戏建的站」）→ 0 个=100 · 1~2 个=75 · 3~4 个=50 · 5~7 个=25 · ≥8 个=10",
  noise: "不计入：应用商店（Play / App Store）· 视频社交（YouTube / Facebook / TikTok / X / Pinterest 等）· 通用百科（Wikipedia）",
  caveats: [
    "🛑 2026-09-25 口径修正（用户：「**我们的对手当然是新建的站**」）：分档输入从「前十独立域名**总数**」改为「**专用站数**」（域名含游戏名 slug，如 `dressmaker.wiki` / `nethros.wiki`）。实测反例：Roblox 潜伏条目的前十全是 `progameguides.com` / `pocketgamer.com` / `beebom.com` / `destructoid.com` / `tryhardguides.com` —— 这些通用媒体对**每个**游戏都写 codes 页，按总数分档会把 5/5 条全判「竞争已起」，误杀最该做的标的",
    "通用站数仍如实记在 `domains` / `hosts` 里（那是事实），只是**不参与分档**；`dedicated` / `dedicatedHosts` 才是判据",
    "🛑 2026-09-25 取样范围修正：旧版只测「拿不到官方上线日」的条目，结果**最需要核查的新游戏反而被跳过**（有上线日 → 跳过 → 竞争项被上线时长推断接管 → 白送满分，Dressmaker 事故）。现在「无上线日 **或** 上线 ≤ `maxAgeDays`（默认 180 天）」都测",
    "🛑 2026-09-25 加**需求门槛**（方案 A）：上面那两类还要再满足 `minVisits 1e6`（Roblox 终身访问）/ `minPlaying 100` 或 `minReviews 100`（Steam）/ `minRatings 1000`（手游）才测。原因：线上 1115 条里需要实测的有 950 条，而 DDG 通道每轮只成功约 2 条 → 铺满要 20 天，期间 950 条长期「竞争未测（不给总分）」。加门槛后降到约 151 条（Brave 1 天 / DDG 3 天）。**低需求条目因此会长期停在「未测」——这是刻意的取舍，不是故障**",
    "🆕 `g.serp.competitorFirstSeen` ＝ 前十**专用站**的 Wayback CDX 最早快照（**下界**：未被收录的域名查不到，如 `dressmaker.wiki`）。前端据此算 `ourLagDays`（我们比首个专站晚了多少）→ **>30 天直接判「我们晚了」**；查不到就跳过，不猜",
    "查询词固定为「<游戏名> codes」：它是最值钱的长尾，也是竞争最先被占的位置",
    "自动通道默认走 DuckDuckGo 作代理（实测限流很紧，常返回反爬页）；人工核查建议看 Google —— 两者数字会略有差异",
    "测失败（限流 / 挑战页 / 页面结构变化）不写缓存，该条目保持「未测」—— 限流不等于没有竞争",
  ],
  note: "人工核查（config.json 的 games.competition）优先级仍高于它：人看一眼比机器数域名更准。人工核查时也请只数「**专为该游戏建的站**」。",
};

/**
 * 取一次 SERP 的原始主机名列表（未去噪、未去重）。
 * @throws 解析不出结果页结构时抛错（**由调用方决定不写缓存**）
 */
async function serpHosts(query, c) {
  const provider = String(c.provider || "ddg").toLowerCase();
  if (provider === "brave") return braveHosts(query, c);
  if (provider !== "ddg") throw new Error("未知 provider：" + provider + "（只认 ddg / brave）");
  return ddgHosts(query, c);
}

/**
 * ✅ **推荐通道**：Brave Search API（免费额度 2,000 次/月，稳定、有 JSON）。
 * 需要环境变量 `BRAVE_API_KEY`（或用 `serpComp.apiKey`）—— 没配就按失败处理（不写缓存，保持「未测」）。
 * 为什么推荐它：下面的 DDG 通道实测**第 3 次请求起就被挡**（202 → 反爬页），自动化不可靠。
 */
async function braveHosts(query, c) {
  const key = (c.apiKey || process.env.BRAVE_API_KEY || "").trim();
  if (!key) throw new Error("未配置 BRAVE_API_KEY（provider=brave 需要它；或把 provider 换回 ddg）");
  const r = await fetch("https://api.search.brave.com/res/v1/web/search?count=20&q=" + encodeURIComponent(query), {
    headers: { accept: "application/json", "x-subscription-token": key },
    signal: AbortSignal.timeout(20000),
  });
  if (!r.ok) throw new Error("HTTP " + r.status + (r.status === 401 || r.status === 403 ? "（key 无效或额度用尽）" : ""));
  const j = await r.json();
  const hosts = ((j.web && j.web.results) || [])
    .map((x) => { try { return new URL(x.url).host; } catch { return ""; } })
    .filter(Boolean);
  if (!hosts.length) throw new Error("返回里没有结果（查询词太窄或额度受限）");
  return hosts;
}

/**
 * ⚠️ 兜底通道：DuckDuckGo HTML 结果页（零密钥，但**限流很紧**）。
 * 实测 2026-09-24：单 IP 连打时**前 2 次 200、第 3 次起返回 202 反爬页**（约 14KB，无 `result__a`）。
 * 所以它只适合"每轮少量 + 长间隔"，成功率高度依赖当时的 IP 与配额；
 * 失败会被记成 failures 并保持「未测」（**绝不写负缓存**）。
 */
async function ddgHosts(query, c) {
  const r = await fetch(DDG + encodeURIComponent(query), {
    headers: { "user-agent": UA, "accept-language": "en-US,en;q=0.9" },
    signal: AbortSignal.timeout(c.timeoutMs || 25000),
  });
  if (!r.ok) throw new Error("HTTP " + r.status + (r.status === 202 ? "（被限流/反爬页）" : ""));
  const html = await r.text();
  if (!/result__a/.test(html)) {
    // 明确的"无结果"是有效测量（真的没人占位）；其余一律当失败，绝不写缓存
    if (/no results/i.test(html)) return [];
    throw new Error("结果页结构变了/被挑战（" + html.length + "B）");
  }
  const hosts = [];
  for (const m of html.matchAll(/uddg=([^&"']+)/g)) {
    try { hosts.push(new URL(decodeURIComponent(m[1])).host); } catch { /* 解不开的链接直接丢 */ }
  }
  if (!hosts.length) throw new Error("结果页里没解析出链接（结构可能变了）");
  return hosts;
}

/**
 * 主机名列表 → 测量结果（只数前 topN 个独立站点，对齐"数前十"的口径）。
 * 🛑 分档（`open`）用 **专用站数**，不是独立域名总数 —— 见 BANDS 上的口径说明。
 *    两个数都留下：`domains`/`hosts` 是原始事实（含通用媒体），`dedicated`/`dedicatedHosts` 才是判据。
 */
function measure(hosts, c, name) {
  const topN = c.topN || 10;
  const sites = [];
  for (const h of hosts) {
    const s = siteOf(h);
    if (!s || NOISE.test(s) || sites.includes(s)) continue;
    sites.push(s);
    if (sites.length >= topN) break;
  }
  const dedicated = sites.filter((s) => isDedicatedSite(s, name));
  return {
    domains: sites.length,                    // 前十独立域名总数（含通用游戏媒体）
    hosts: sites,
    dedicated: dedicated.length,              // 🆕 其中"专为这个游戏建的站"
    dedicatedHosts: dedicated,
    open: bandOf(dedicated.length),           // 🛑 分档输入 = 专用站数
  };
}

/**
 * Wayback CDX：某域名**最早一次快照**的日期（YYYY-MM-DD）。
 * 用途：估计"首个专站是什么时候出现的" → 前端算 `ourLagDays = 我们首次发现日 − 这个日期`。
 *
 * 三种返回（必须分清，别混成一种）：
 *   - 有快照 → 日期字符串
 *   - 明确没有快照（`[]` / 只有表头）→ `null`（**是有效测量**："这个域名 Wayback 没收录"，不是失败）
 *   - HTTP 失败 / 超时 → **抛错**（由调用方跳过，不写任何东西）
 */
async function cdxFirstSeen(domain, c) {
  const url = "http://web.archive.org/cdx/search/cdx?url=" + encodeURIComponent(domain) +
    "&output=json&limit=1&fl=timestamp";
  // 🛑 2026-09-25 实测：**批量请求时 Wayback 会大量返回 503 / 超时**
  //    （首轮真实采集：15 次 CDX 只成功 1 次，间隔当时是 1.2s 且无重试）。
  //    所以这里加线性退避重试 + 拉长间隔；仍失败则抛错，由调用方跳过（不猜、不罚）。
  const tries = Math.max(1, c.tries == null ? 2 : c.tries);
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, {
        headers: { "user-agent": UA, accept: "application/json" },
        signal: AbortSignal.timeout(c.timeoutMs || 15000),
      });
      if (r.status === 429 || r.status === 503) throw new Error("HTTP " + r.status + "（Wayback 限流）");
      if (!r.ok) throw new Error("HTTP " + r.status);
      const t = (await r.text()).trim();
      if (!t || t === "[]") return null;                   // 无快照（≠ 失败）
      let j;
      try { j = JSON.parse(t); } catch { throw new Error("CDX 返回不是 JSON（" + t.length + "B）"); }
      const ts = j && j[1] && j[1][0];                     // j[0] 是表头行，j[1] 才是首条记录
      if (!ts || !/^\d{14}$/.test(String(ts))) return null;
      const s = String(ts);
      return s.slice(0, 4) + "-" + s.slice(4, 6) + "-" + s.slice(6, 8);
    } catch (e) {
      lastErr = e;
      if (i < tries - 1) await sleep((c.retryGapMs == null ? 3000 : c.retryGapMs) * (i + 1));
    }
  }
  throw lastErr;
}

/**
 * **单条** SERP 核查（含 CDX 首个专站）—— 主循环与**潜伏清单**共用这一份实现。
 *
 * 2026-09-25 抽出：潜伏清单（未发售条目）也需要"竞争饱和度"，
 *   因为**未发售 ≠ 空位** —— 实测 Dressmaker 在发售前（2026-08 甚至 6 月）就有专站在做。
 *   两条链共用同一份测量逻辑，口径才不会漂。
 *
 * @returns {object} rec（可直接写缓存 / 挂到 `g.serp`）；**抛错 = 测量失败**，调用方不得写缓存
 */
export async function checkOneSerp(name, cfg) {
  const c = Object.assign(
    { query: "{q} codes", topN: 10, cdx: { enabled: true, maxDomains: 3, timeoutMs: 15000, gapMs: 1200 } },
    (cfg && cfg.games && cfg.games.serpComp) || {}
  );
  const q = String(c.query || "{q} codes").replace("{q}", name);
  const m = measure(await serpHosts(q, c), c, name);
  const rec = Object.assign({ at: iso(), query: q }, m);
  // 🛑 CDX 只查**专用站**（`dedicatedHosts`）—— 我们要回答的是"**第一个为这个游戏建的站**
  //    什么时候出现"，通用媒体站（progameguides 等）的首次快照没有意义（它们对所有游戏都有页）。
  //    附带收益：请求量大降（多数条目的专用站是 0~1 个），Wayback 的限流压力随之变小。
  //    没有专用站 → 完全不查 CDX（正确：没人专门做，就不存在"我们晚了"）。
  if (c.cdx && c.cdx.enabled !== false && (m.dedicatedHosts || []).length) {
    const seen = [];
    for (const d of (m.dedicatedHosts || []).slice(0, c.cdx.maxDomains || 3)) {
      try {
        const at = await cdxFirstSeen(d, c.cdx);
        if (at) seen.push({ domain: d, at });
      } catch (e) {
        log("dim", `      CDX ${d} 跳过（不猜）：${e.message}`);
      }
      await sleep(c.cdx.gapMs || 1200);
    }
    if (seen.length) {
      seen.sort((a, b) => String(a.at).localeCompare(String(b.at)));
      rec.competitorFirstSeen = seen[0].at;              // 最早 = 首个专站出现日（**下界**）
      rec.competitorSeenList = seen;
    }
  }
  return rec;
}

/**
 * 给"竞争项本来只能标未测"的条目做自动 SERP 核查，结果写进 `g.serp`。
 *
 * 有界：每轮最多 `maxPerRun` 次请求（默认 12）+ 间隔 `gapMs`（默认 3s）+ 成功后缓存 `ttlDays` 天。
 * 缓存里**只放测成功的**；过期条目会在预算内重测，重测不到就继续显示「未测」。
 *
 * @returns {{tested:number, ok:number, failed:number, cached:number}}
 */
export async function enrichSerpComp(items, cfg) {
  const c = Object.assign(
    {
      enabled: true, maxPerRun: 12, ttlDays: 7, gapMs: 3000, query: "{q} codes", topN: 10,
      onlyUnknownAge: true,   // 保留：无官方上线日的条目一律测（它们本来只能标未测）
      maxAgeDays: 180,        // 🆕 2026-09-25：抢首发区间（上线 ≤180 天）**也要测**
      cdx: { enabled: true, maxDomains: 3, timeoutMs: 15000, gapMs: 1200 },
    },
    (cfg && cfg.games && cfg.games.serpComp) || {}
  );
  const out = { tested: 0, ok: 0, failed: 0, cached: 0, firstSeen: 0 };
  if (!c.enabled) return out;

  const file = dataPath(cfg, ".serp-cache.json");
  const cache = readJson(file, {}) || {};
  const now = Date.now();
  const ttl = (c.ttlDays || 7) * 86400000;

  const keyOf = (name) => String(name || "").trim().toLowerCase();
  const demandOf = (g) => {
    const st = g.stats || {};
    return st.visits ?? st.playing ?? st.ratings ?? st.reviews ?? 0;
  };
  const ageDaysOf = (g) => {
    const cr = (g.stats && g.stats.created) || g.srcCreated;
    if (!cr) return null;
    const d = (Date.now() - new Date(cr).getTime()) / 86400000;
    return isFinite(d) ? d : null;
  };
  /**
   * 需求是否过实测门槛（🆕 2026-09-25，方案 A）。
   * 🛑 为什么必须有它：线上 `games.json` 1115 条里，「无上线日 403 + 抢首发区间 547」= **950 条**
   *    都需要实测，而 DDG 通道每轮只成功约 2 条 → 铺满要 **475 轮 ≈ 20 天**，
   *    期间会有 950 条长期挂在「竞争未测（不给总分）」，等于把推荐页打瘫。
   *    加门槛后（默认档）需实测降到 **约 151 条** → Brave 1 天 / DDG 3 天铺满。
   * 阈值按平台分开（数量级差 4~6 倍，绝不能共用一条线）：
   *   Roblox 终身访问 ≥ `minVisits` · Steam 在线 ≥ `minPlaying` 或评价数 ≥ `minReviews` · 手游评分人数 ≥ `minRatings`
   */
  const overDemand = (g) => {
    const st = g.stats || {};
    const p = st.platform || (st.visits != null ? "roblox" : "none");
    if (p === "steam") {
      return (st.playing == null ? 0 : st.playing) >= (c.minPlaying == null ? 100 : c.minPlaying) ||
        (st.reviews == null ? 0 : st.reviews) >= (c.minReviews == null ? 100 : c.minReviews);
    }
    if (p === "ios" || p === "android") {
      return (st.ratings == null ? 0 : st.ratings) >= (c.minRatings == null ? 1000 : c.minRatings);
    }
    if (p === "roblox") {
      return (st.visits == null ? 0 : st.visits) >= (c.minVisits == null ? 1e6 : c.minVisits);
    }
    // 🛑 无官方数据的条目（platform none，实测 449 条）：**拿不到任何需求数字**，
    //    按上面的口径它们永远过不了门槛 → 永久「未测」死角。
    //    而这里面恰恰有真游戏（实测样本：`aion 2` / `fire emblem` / `horizon forbidden west`）。
    //    → 改用**内容面**当门槛：有 ≥ `minWords`（默认 3）个可做词 = 有东西可写，才值得查竞争。
    return (g.words || []).length >= (c.minWords == null ? 3 : c.minWords);
  };

  /**
   * 哪些条目需要实测？
   *   - 拿不到官方上线日 → 只能靠实测（旧行为，安卓）
   *   - **抢首发区间（≤ maxAgeDays）→ 也测**（🆕 2026-09-25，见文件头第 2 条护栏）
   *   - 其余（>maxAgeDays 的老条目）已有 age 推断可用，不重复花请求
   * 🆕 上面两类都要**再过一道需求门槛**（`overDemand`）—— 低需求的长尾不值得占稀缺的请求配额。
   *    `onlyUnknownAge: false` 可退回"全部测"，仅调试用。
   */
  const needSerp = (g) => {
    const a = ageDaysOf(g);
    if (a != null && a > (c.maxAgeDays == null ? 180 : c.maxAgeDays)) return c.onlyUnknownAge === false;
    // 🆕 极新（≤ `minAgeDays`，默认 7 天）：**需求数据天然还没起来**（刚上线，在线/评价都是个位数），
    //    按普通门槛它们会被判"没需求"而永远不测 —— 但**这正是先手价值最高的一段**
    //    （实测样本：After the Silence / Garfield / Coin Rush 全是上线 2~7 天、需求未起量的新游）。
    //    → 对它们放宽为"只要有内容面（≥ minWords 个可做词）就测"，不因为"还没量"把先手机会漏掉。
    if (a != null && a <= (c.minAgeDays == null ? 7 : c.minAgeDays)) {
      return (g.words || []).length >= (c.minWords == null ? 3 : c.minWords) || overDemand(g);
    }
    return overDemand(g);
  };

  const todo = [];
  for (const g of items || []) {
    if (!g || !g.name) continue;
    const k = keyOf(g.name);
    const hit = cache[k];
    const fresh = hit && hit.at && now - new Date(hit.at).getTime() < ttl;
    if (fresh) { g.serp = hit; out.cached++; continue; }     // 命中缓存 → 直接挂上，不发请求
    if (!needSerp(g)) continue;
    todo.push(g);
  }
  todo.sort((a, b) => demandOf(b) - demandOf(a));

  for (const g of todo.slice(0, c.maxPerRun || 12)) {
    out.tested++;
    try {
      const rec = await checkOneSerp(g.name, cfg);
      cache[keyOf(g.name)] = rec;
      g.serp = rec;
      out.ok++;
      if (rec.competitorFirstSeen) out.firstSeen++;
      log("dim", `    SERP ${g.name}：独立域名 ${rec.domains} → 竞争档 ${rec.open}（${(rec.hosts || []).slice(0, 3).join(" · ") || "无人占位"}）` +
        (rec.competitorFirstSeen ? `；首个专站最早快照 ${rec.competitorFirstSeen}` : "；首个专站日期未取得（下界缺失，不猜）"));
    } catch (e) {
      // 🛑 失败一律不写缓存：限流/挑战 ≠ 没有竞争（写进去就成了负缓存）
      out.failed++;
      log("warn", `    SERP ${g.name} 失败（保持「未测」，不写缓存）：${e.message}`);
    }
    await sleep(c.gapMs || 3000);
  }

  // 清掉长期用不到的条目（列表 30 天滚动，缓存留 60 天足够）
  let dropped = 0;
  for (const [k, v] of Object.entries(cache)) {
    if (!v || !v.at || now - new Date(v.at).getTime() > 60 * 86400000) { delete cache[k]; dropped++; }
  }
  if (out.ok || dropped) writeJson(file, cache, true);
  return out;
}
