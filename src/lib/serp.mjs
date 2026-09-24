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
 *  2. **只测本来就会标未测的条目**（`onlyUnknownAge`，默认开）—— 其它平台已有更准的
 *     人工核查或上线时长推断，没必要花请求去覆盖；请求量另有 `maxPerRun` 封顶。
 *  3. **判据是域名数，不是结果总数**（谷歌早已取消精确结果数）：同一站点的子域算一个，
 *     并排掉应用商店 / 视频社交 / 通用百科 —— 它们不是"占位的专业站"。
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

/** 独立域名数 → 竞争档 open（1~5，5 = 最空）。🛑 这几档就是人工核查的判据，别随手调 */
const BANDS = [[0, 5], [2, 4], [4, 3], [7, 2], [Infinity, 1]];
const bandOf = (n) => (BANDS.find(([max]) => n <= max) || BANDS[BANDS.length - 1])[1];

/**
 * 自述随产物下发（`games.json.serp`）→ 前端规则块据实展示，**单一事实源在这里**，
 * 前端不再手抄一份档位（手抄过一次就已经抄错了，见 demandAnchorsText 的教训）。
 */
export const SERP_RULES = {
  title: "竞争 = 自动 SERP 核查（「<游戏名> codes」前十的独立域名数）",
  source: "DuckDuckGo HTML 结果页（零密钥，实测可直连）",
  query: "<游戏名> codes",
  bands: "独立域名数 → 0 个=100 · 1~2 个=75 · 3~4 个=50 · 5~7 个=25 · ≥8 个=10",
  noise: "不计入：应用商店（Play / App Store）· 视频社交（YouTube / Facebook / TikTok / X / Pinterest 等）· 通用百科（Wikipedia）",
  caveats: [
    "只数独立域名（同一站点的子域算一个）—— 对齐人工核查的口径「前十有几个独立域名占位」",
    "目前只覆盖拿不到官方上线日的条目（安卓）；其它平台已有人工核查 > 上线时长推断，不重复花请求",
    "查询词固定为「<游戏名> codes」：它是最值钱的长尾，也是竞争最先被占的位置",
    "自动通道默认走 DuckDuckGo 作代理（实测限流很紧，常返回反爬页）；人工核查建议看 Google —— 两者数字会略有差异",
    "测失败（限流 / 挑战页 / 页面结构变化）不写缓存，该条目保持「未测」—— 限流不等于没有竞争",
  ],
  note: "人工核查（config.json 的 games.competition）优先级仍高于它：人看一眼比机器数域名更准。",
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

/** 主机名列表 → 测量结果（只数前 topN 个独立站点，对齐"数前十"的口径） */
function measure(hosts, c) {
  const topN = c.topN || 10;
  const sites = [];
  for (const h of hosts) {
    const s = siteOf(h);
    if (!s || NOISE.test(s) || sites.includes(s)) continue;
    sites.push(s);
    if (sites.length >= topN) break;
  }
  return { domains: sites.length, hosts: sites, open: bandOf(sites.length) };
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
    { enabled: true, maxPerRun: 12, ttlDays: 7, gapMs: 3000, query: "{q} codes", topN: 10, onlyUnknownAge: true },
    (cfg && cfg.games && cfg.games.serpComp) || {}
  );
  const out = { tested: 0, ok: 0, failed: 0, cached: 0 };
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
  /** 拿不到官方上线日 → 竞争项本来只能标未测（只有这些值得花请求） */
  const noAge = (g) => !((g.stats && g.stats.created) || g.srcCreated);

  const todo = [];
  for (const g of items || []) {
    if (!g || !g.name) continue;
    const k = keyOf(g.name);
    const hit = cache[k];
    const fresh = hit && hit.at && now - new Date(hit.at).getTime() < ttl;
    if (fresh) { g.serp = hit; out.cached++; continue; }     // 命中缓存 → 直接挂上，不发请求
    if (c.onlyUnknownAge && !noAge(g)) continue;             // 其它平台有更准的来源，不覆盖
    todo.push(g);
  }
  todo.sort((a, b) => demandOf(b) - demandOf(a));

  for (const g of todo.slice(0, c.maxPerRun || 12)) {
    const q = String(c.query || "{q} codes").replace("{q}", g.name);
    out.tested++;
    try {
      const m = measure(await serpHosts(q, c), c);
      const rec = Object.assign({ at: iso(), query: q }, m);
      cache[keyOf(g.name)] = rec;
      g.serp = rec;
      out.ok++;
      log("dim", `    SERP ${g.name}：独立域名 ${m.domains} → 竞争档 ${m.open}（${m.hosts.slice(0, 3).join(" · ") || "无人占位"}）`);
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
