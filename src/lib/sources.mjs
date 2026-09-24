

/**
 * 候选来源层（多源）—— 原站 findnews.me「新游戏雷达」真正的 intake 就在这里。
 *
 * 实测依据（2026-09-20 逐名核对原站公开产物）：
 *  · 原站 data/games.json 的 404 个游戏里，"Ride A Pet" / "Build the Pyramid!" /
 *    "Rat Lab" / "Lumber Tycoon 2" / "Royale High" / "Anime Dice" 等与 Roblox
 *    Discover 榜单（apis.roblox.com/explore-api/v1/get-sorts）逐个吻合，且正是
 *    榜单名去掉 [UPD] / [ALPHA] / emoji 装饰后的结果；
 *  · 另一批（Angel Engine #4173750 / Infant God #4238140 / Aniimo #4126040 /
 *    Valheim / No Man's Sky / ENDLESS Legend 2）能在 Steam 的新发售、即将发售、
 *    特惠榜单里逐个找到。
 *  · 反证：原站自己发布的 7 天热搜留档（56,861 条）只覆盖其游戏列表的 14/404 ——
 *    所以"新游戏"不是从 Google Trends 热搜来的；热搜只用来验证"这游戏现在热不热"
 *    （见 interest.mjs）。
 */
import { randomUUID } from "node:crypto";
import { log, sleep, iso, readJson, writeJson, dataPath } from "./util.mjs";

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";
const STEAM = "https://store.steampowered.com";
const PLAY = "https://play.google.com";
const TAGS = /[™®©]/g;

/**
 * 非拉丁文字（CJK / 韩文 / 西里尔 / 阿拉伯 / 泰文 / 希伯来）。
 * 刻意**不**按"纯 ASCII"过滤 —— 那样会把 `Pokémon GO` 这类带音标的正常名字一起杀掉。
 */
const NON_LATIN = /[\u3000-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af\u0400-\u04ff\u0600-\u06ff\u0e00-\u0e7f\u0590-\u05ff]/;

// 榜单装饰：emoji、【】[]() 里的活动/版本标记、首尾符号
const EMOJI = /[\p{Extended_Pictographic}\p{Emoji_Presentation}\uFE0F\u200D]/gu;
const BRACKET = /\[[^\]]*\]|\([^)]*\)|【[^】]*】/g;
const EDGE = /^[\s\-–—:|/\\·•*+~]+|[\s\-–—:|/\\·•*+~]+$/g;

/** 把 Roblox 榜单名洗成可直接当 Google Trends 关键词、也可直接当页面标题的名字 */
export function cleanName(raw) {
  return String(raw || "")
    .replace(BRACKET, " ")
    .replace(EMOJI, " ")
    .replace(/\s+/g, " ")
    .replace(EDGE, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Roblox Discover 榜单（原站最大的一类来源） */
export async function fetchRoblox() {
  const url = "https://apis.roblox.com/explore-api/v1/get-sorts?sessionId=" + randomUUID();
  const r = await fetch(url, { headers: { "user-agent": UA, accept: "application/json" } });
  if (!r.ok) throw new Error("HTTP " + r.status);
  const j = await r.json();
  const out = [];
  const seen = new Set();
  for (const s of j.sorts || []) {
    const list = s.sortDisplayName || s.sortId || "";
    // 实测结构：游戏在 sorts[].games[]；另有 sorts[].content[].games[] 这种形态，两种都吃
    const buckets = [...(s.games ? [s.games] : []), ...(s.content || []).map((c) => c.games || [])];
    for (const bucket of buckets) {
      for (const g of bucket) {
        const raw = String(g.name || "");
        const name = cleanName(raw);
        const key = name.toLowerCase();
        if (!name || name.length < 2 || seen.has(key)) continue;
        seen.add(key);
        out.push({
          name, rawName: raw, source: "roblox", list,
          universeId: g.universeId || 0,
          players: g.playerCount || 0,
          url: g.universeId ? "https://www.roblox.com/games/" + (g.rootPlaceId || g.universeId) : "",
        });
      }
    }
  }
  // 玩家数高的先验证：它们更可能真有 Google Trends 数据（长尾小游戏往往查不到曲线）
  out.sort((a, b) => (b.players || 0) - (a.players || 0));
  return out;
}

/** Steam 商店榜单：新发售 / 即将发售 / 特惠 / 热销 */
export async function fetchSteamFeatured() {
  const r = await fetch(STEAM + "/api/featuredcategories?cc=us&l=en", { headers: { "user-agent": UA, "accept-language": "en-US" } });
  if (!r.ok) throw new Error("HTTP " + r.status);
  const j = await r.json();
  const kinds = [["new_releases", "new"], ["coming_soon", "upcoming"], ["specials", "special"], ["top_sellers", "top"]];
  const out = [];
  for (const [key, kind] of kinds) {
    for (const it of (j[key] && j[key].items) || []) {
      if (!it || !it.name) continue;
      const name = String(it.name).replace(TAGS, "").trim();
      if (!name) continue;
      out.push({ name, rawName: it.name, source: "steam", kind, appid: it.id, url: STEAM + "/app/" + it.id });
    }
  }
  return out;
}

/**
 * 解析 Steam 搜索页返回的 results_html。
 * 三种榜单（新发售 / 即将发售 / 愿望单最热）共用这一套解析，避免三份正则各自漂移。
 */
function parseSteamSearch(html, kind) {
  const dq = String.fromCharCode(34);
  const parts = String(html || "").split("<a href=" + dq + STEAM + "/app/");
  const out = [];
  for (let i = 1; i < parts.length; i++) {
    const b = parts[i];
    const appid = b.slice(0, b.indexOf("/"));
    const t = b.indexOf("title" + dq + ">");
    if (t < 0) continue;
    const name = b.slice(t + 7, b.indexOf("</span>", t)).replace(TAGS, "").replace(/&amp;/g, "&").trim();
    if (!name) continue;
    const rl = b.indexOf("search_released");
    let released = "";
    if (rl >= 0) {
      const gt = b.indexOf(">", rl);
      released = b.slice(gt + 1, b.indexOf("<", gt)).replace(/\s+/g, " ").trim();
    }
    out.push({ name, rawName: name, source: "steam", kind, appid, released, url: STEAM + "/app/" + appid });
  }
  return out;
}

async function steamSearch(url, kind) {
  const r = await fetch(url, { headers: { "user-agent": UA, "accept-language": "en-US" } });
  if (!r.ok) throw new Error("HTTP " + r.status);
  const j = await r.json();
  return { items: parseSteamSearch(j.results_html, kind), total: j.total_count || 0 };
}

/** Steam 搜索页：按发售时间排序，能拿到更多"刚上架 / 未发售"的游戏名与发售日 */
export async function fetchSteamList(limit = 60, upcoming = false) {
  const sort = upcoming ? "&sort_by=Released_ASC&filter=comingsoon" : "&sort_by=Released_DESC";
  const url = STEAM + "/search/results/?query=&start=0&count=" + limit + sort + "&category1=998&infinite=1&cc=us&l=en";
  const { items } = await steamSearch(url, upcoming ? "upcoming" : "new");
  return items;
}

/**
 * Steam「未发售里最受关注的」——按**愿望单热度**排序，带发售日。
 *
 * 为什么单独要这个榜：`featuredcategories.coming_soon` 只有 10 条且是人工编排；
 * 而 popularcomingsoon 实测有 5.5 万条、按愿望单序位排 —— 愿望单是**发售前唯一可测的需求代理**
 * （Steam 不公开愿望单数量，只能用名次近似），所以它才是「潜伏清单」的主力来源。
 * 注意 ⚠️：不能用 `sort_by=Released_DESC` 的 comingsoon 榜（实测会混入 9998 / 2104 这类占位年份）。
 */
export async function fetchSteamPopularUpcoming(limit = 40) {
  const url = STEAM + "/search/results/?query=&start=0&count=" + limit +
    "&category1=998&filter=popularcomingsoon&infinite=1&cc=us&l=en";
  const { items, total } = await steamSearch(url, "popular-upcoming");
  return { items, total };
}

/**
 * Roblox 指定榜单（默认取 up-and-coming）。
 *
 * 与 fetchRoblox() 的区别：后者把所有榜单混在一起按玩家数排序（用于"发现新游戏"），
 * 会丢掉"来自哪个榜"这一层含义；潜伏清单要的恰恰是 **官方「新晋」榜** 这个语义
 * （Roblox 没有"未发布"公开列表，Up-and-Coming 是官方最接近的一档）。
 */
export async function fetchRobloxSortGames(sortIds = ["up-and-coming"], limitPerSort = 60) {
  const url = "https://apis.roblox.com/explore-api/v1/get-sorts?sessionId=" + randomUUID();
  const r = await fetch(url, { headers: { "user-agent": UA, accept: "application/json" } });
  if (!r.ok) throw new Error("HTTP " + r.status);
  const j = await r.json();
  const want = new Set(sortIds.map((s) => String(s).toLowerCase()));
  const out = [];
  for (const s of j.sorts || []) {
    if (!want.has(String(s.sortId || "").toLowerCase())) continue;
    const listName = s.sortDisplayName || s.sortId || "";
    const buckets = [...(s.games ? [s.games] : []), ...(s.content || []).map((c) => c.games || [])];
    let n = 0;
    for (const bucket of buckets) {
      if (n >= limitPerSort) break;
      for (const g of bucket) {
        if (n >= limitPerSort) break;
        const raw = String(g.name || "");
        const name = cleanName(raw);
        if (!name || name.length < 2) continue;
        n++;
        out.push({
          name, rawName: raw, source: "roblox", kind: "rising", list: listName,
          universeId: g.universeId || 0,
          players: g.playerCount || 0,
          url: g.universeId ? "https://www.roblox.com/games/" + (g.rootPlaceId || g.universeId) : "",
        });
      }
    }
  }
  return out;
}

/** 汇总所有来源：单个来源失败不影响其它来源 */
export async function collectSourceCandidates(cfg) {
  const g = cfg.games || {};
  const on = (k) => (g.sources ? g.sources[k] !== false : true);
  const jobs = [];
  if (on("roblox")) jobs.push(["roblox", () => fetchRoblox()]);
  if (on("steam")) jobs.push(["steam", () => fetchSteamFeatured()]);
  if (on("steam")) jobs.push(["steam-new", () => fetchSteamList(g.steamListCount || 60, false)]);
  if (on("steam")) jobs.push(["steam-upcoming", () => fetchSteamList(g.steamUpcomingCount || 40, true)]);
  if (on("appstore")) jobs.push(["appstore", () => fetchAppStore(cfg)]);
  if (on("googleplay")) jobs.push(["googleplay", () => fetchGooglePlay(cfg)]);
  if (on("itch")) jobs.push(["itch", () => fetchItch(cfg)]);
  if (on("poki")) jobs.push(["poki", () => fetchPoki(cfg)]);
  if (on("crazygames")) jobs.push(["crazygames", () => fetchCrazyGames(cfg)]);
  const out = [];
  for (const [label, fn] of jobs) {
    try {
      const list = await fn();
      log("dim", "  来源 " + label + "：" + list.length + " 个");
      out.push(...list);
    } catch (e) {
      log("warn", "来源 " + label + " 失败：" + e.message);
    }
  }

  // 只留拉丁名字（默认开，`games.sourceLatinOnly`）——
  // 这是"做英文站"的推荐配置，与 games.latinOnly 同一套判断标准。
  // 为什么必须默认过滤：日本/韩国/台湾的榜单里大量非拉丁名（刀剣乱舞ぱずぎり / 애니모 …），
  // 它们对英文站没有可用关键词，而**队列是共享的稀缺资源**（每轮只验证 sourceBatch=120 个），
  // 让它们占位会直接挤掉真正能做的候选。要做小语种站时把它设成 false 即可。
  if (g.sourceLatinOnly !== false) {
    const before = out.length;
    const kept = out.filter((it) => it.name && !NON_LATIN.test(it.name));
    if (kept.length !== before) log("dim", `  非拉丁名过滤：-${before - kept.length} 个（games.sourceLatinOnly）`);
    return kept;
  }
  return out;
}

// ══════════════════════════════════════════════════════════════════════════
// 榜单来源的「请求预算器」：轮转抽样 + 结果缓存
//
// 为什么必须有这一层（实测 2026-09-24）：
//   · App Store 一个"地区 × 榜单"就要 ~380KB（limit=100），全量 = 18 地区 × 5 榜 ≈ 34MB；
//   · Google Play 一个"类别 × 地区"页面 1.7~2.6MB，全量 ×8 地区 ≈ 180MB。
//   按每小时/每 6 小时跑一次的话，这是每天几百 MB —— 既慢又是不礼貌的抓取。
//
// 做法：把"要抓的组合"排成一个固定顺序的清单，每轮只按游标取 `maxPerRun` 个，
// 抓完的结果进缓存；返回值 = 缓存里所有**未过期**条目 → 覆盖面随轮次逐步铺满，
// 而单轮成本恒定。TTL 必须 ≥ 走完一整圈所需时间，否则缓存会在铺满前就开始过期。
//
// ⚠️ 顺序不是随便排的：清单靠前的组合信息量最大（如 Apple 的"最新上架"、
//    Play 的"全部游戏"），游标从 0 开始，所以每圈最先抓到的就是它们。
// ══════════════════════════════════════════════════════════════════════════

/**
 * @returns {{cursor:number, picked:string[], cached:Record<string,{at:string,items:object[]}>, ttl:number}}
 */
/**
 * 缓存结构版本：**改了条目字段就必须 +1**。
 * 为什么：缓存里存的是"拼好的条目"，字段修了但缓存没失效的话，要等到 TTL 过期才会生效 ——
 * 实测踩过：Apple 的 `link` 解析修好后，旧缓存里的条目 `url` 仍是空串，
 * 于是"手机端详情补不上"，看起来像新代码没生效。
 */
const BUDGET_VERSION = 2;

function budget(cfg, key, pairs, maxPerRun, cacheHours) {
  const file = dataPath(cfg, ".source-budget.json");
  let all = readJson(file, {});
  // 版本不符 → 整份缓存作废（各来源共用一个文件，所以全清）
  if (all.version !== BUDGET_VERSION) all = { version: BUDGET_VERSION };
  const st = all[key] || { cursor: 0, cache: {} };
  st.cache = st.cache || {};
  const n = Math.max(1, pairs.length);
  const picked = [];
  // 取短：组合数少于预算时不要重复抓同一个组合
  for (let i = 0; i < pairs.length && picked.length < maxPerRun; i++) {
    picked.push(pairs[(st.cursor + i) % n]);
  }
  st.cursor = (st.cursor + picked.length) % n;
  return { file, all, key, st, picked, ttl: (cacheHours || 24) * 3600_000 };
}

/** 存回预算文件（所有来源共用一份，键隔离） */
function budgetSave(ctx, cfg) {
  ctx.all[ctx.key] = ctx.st;
  writeJson(ctx.file, ctx.all, true);
}

/** 缓存里未过期的条目（合并输出用）——过期的会先清掉，避免清单里混着几天前的旧名次 */
function budgetItems(ctx, now) {
  const out = [];
  let expired = 0;
  for (const [k, v] of Object.entries(ctx.st.cache)) {
    if (!v || !v.at) continue;
    if (now - new Date(v.at).getTime() > ctx.ttl) { delete ctx.st.cache[k]; expired++; continue; }
    out.push(...(v.items || []));
  }
  return { items: out, expired };
}

// ══════════════════════════════════════════════════════════════════════════
// 手机端来源（iOS / Android）—— 2026-09-24 新增与升级
//
// 实测边界（先看清再改，这决定了"能发现什么"）：
//
//   ① iOS 有**真·新游榜**：`newfreeapplications` / `newpaidapplications` 是"最新上架"，
//      实测每 100 条里约 10 条是游戏（US/JP 相似、KR 16 条）→ 用 limit=200 能捞到 ~20 个新游。
//      而且 `itunes.apple.com/lookup?id=<trackId>` **批量**可查（50 个一批），
//      能给到 `releaseDate`（真实上线日）/ `currentVersionReleaseDate` / `price` / 评分 / 开发商
//      → 所以 iOS 侧的新游可以走完整的"新鲜度"判断（见 mobile.mjs）。
//
//   ② Android **没有"新游"入口**（实测所有入口都是 0 个 app）：
//      `/store/apps/collection/*`（topnew / topselling_new_free / topselling_trending /
//      promotion_3001960_new_and_updated）全都返回 200 但**页面里没有任何 app 链接**（要登录/JS）。
//      可用的只有**分类热门榜**：`/store/apps/category/<cat>?gl=<国家>&hl=en`
//      （实测 40~124 个 app，各地区榜单不同：US 101 / BR 124 / DE 117 / JP 64 / TW 36）。
//      → Android 是"发现**流行**手游"的来源，不是"发现**新**手游"的来源。
//      且 Play 详情页**没有首发日期**（实测无 `datePublished` / "Released on"，只有 "Updated on"）
//      → Android 的上线日只能标「未测」，不许拿更新日冒充上线日。
//
//   ③ 名字解析的坑：Play 各国卡片模板不一样。US/BR/DE 的卡片里有 `<div title="游戏名">`，
//      而 JP/TW/KR 走 `aria-label="Play 游戏名"`（要先剥掉 "Play " 前缀），
//      且同页还会有 `aria-label="Rated 4.4 stars out of five stars"` 这种**评分**串
//      —— 不显式排掉，榜单里会混进叫 "Rated 4.4 stars..." 的"游戏"。
// ══════════════════════════════════════════════════════════════════════════

const APP_ID = "6014"; // iTunes genre id：Games
const GAME_LABEL = /^(Games?|ゲーム|게임|遊戲|游戏|Spiele|Jeux|Jogos|Giochi|Игры|Oyunlar|Juegos|ألعاب)$/i;

/**
 * App Store 榜单族。**顺序 = 信息量**（预算器从游标 0 开始，靠前的每圈最先抓到）：
 * 先"最新上架"（发现新游），再热度/收入榜（判断饱和度）。
 */
const APPSTORE_FEEDS = [
  ["newfreeapplications", "new-free", true, 200],
  ["newpaidapplications", "new-paid", true, 200],
  ["topfreeapplications", "top-free", false, 100],
  ["toppaidapplications", "top-paid", false, 100],
  ["topgrossingapplications", "top-grossing", false, 100],
];

/**
 * HTML 实体解码。
 * 🛑 必须处理**数字实体**（`&#039;` / `&#x27;`）：实测 itch 的标题里 `One Night at Miku&#039;s`
 * 如果只替换具名实体，就会带着 `&#039;` 进库，之后拿去查 Trends 是一条查不到的假词。
 */
const unescape = (s) => String(s || "")
  .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
  .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
  .replace(/&quot;|&apos;/g, '"')
  .replace(/&lt;/g, "<").replace(/&gt;/g, ">")
  .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").trim();

/**
 * 取网页文本：带一次重试。
 * 为什么需要（实测）：itch.io / Poki 是偶发失败（同一 URL 连抓三次都成功，但流水线里偶尔 0 条），
 * 而"一次失败就跳过"会让这个来源**静默断流一轮**——没人会发现少了一天的候选。
 */
async function getText(url, opts = {}) {
  const tries = opts.retries == null ? 1 : opts.retries;
  const timeoutMs = opts.timeoutMs || 20000;
  let last = null;
  for (let i = 0; i <= tries; i++) {
    try {
      const r = await fetch(url, {
        headers: { "user-agent": UA, "accept-language": "en-US,en;q=0.9" },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!r.ok) throw new Error("HTTP " + r.status);
      return await r.text();
    } catch (e) {
      last = e;
      if (i < tries) await sleep(900 * (i + 1));
    }
  }
  throw new Error((opts.label ? opts.label + " " : "") + (last ? last.message : "未知错误"));
}

/** 同一名字保留"更值得看"的那条（新游榜 > 名次靠前 > 后抓的） */
function dedupeBest(items, better) {
  const map = new Map();
  for (const it of items) {
    const k = String(it.name || "").toLowerCase();
    if (!k) continue;
    const cur = map.get(k);
    if (!cur || better(it, cur) > 0) map.set(k, it);
  }
  return Array.from(map.values());
}

/** 新游榜优先（kind 以 new 开头），同级比名次 */
const appStoreBetter = (a, b) => {
  const na = /^new/.test(String(a.kind)) ? 1 : 0;
  const nb = /^new/.test(String(b.kind)) ? 1 : 0;
  if (na !== nb) return na - nb;
  return (b.rank || 0) - (a.rank || 0) ? (a.rank || 1e9) - (b.rank || 1e9) : 0;
};

/**
 * App Store 游戏榜（iOS）。
 * 端点：`itunes.apple.com/<cc>/rss/<榜单>/limit=<n>/genre=6014/json`
 * （6014 = Games；旧版 RSS 仍在服务，实测各地区 200 且是干净 JSON。
 *   ⚠️ `rss.marketingtools.apple.com` 的新版 `/games.json` 实测 404，别用。）
 *
 * `genre=6014` 在所有地区都生效（jp 显示「ゲーム」/ kr「게임」/ tw「遊戲」/ br「Jogos」），
 * 所以地区覆盖可以放心开大 —— 真正的限制是"每轮抓几组"，由预算器控制。
 */
export async function fetchAppStore(cfg) {
  const g = (cfg && cfg.games) || {};
  const geos = (g.appStoreGeos || ["US", "GB", "CA", "AU"]).map((x) => String(x).toLowerCase());
  const want = new Set(g.appStoreFeeds || APPSTORE_FEEDS.map((f) => f[0]));
  const feeds = APPSTORE_FEEDS.filter((f) => want.has(f[0]));
  // 组合顺序：先扫完"最新上架"的所有地区，再换下一个榜 —— 保证每圈开头都在捞新游
  const pairs = [];
  for (const f of feeds) for (const cc of geos) pairs.push(cc + "|" + f[0]);

  const ctx = budget(cfg || {}, "appstore", pairs, g.appStoreMaxPerRun ?? 12, g.appStoreCacheHours ?? 48);
  const now = Date.now();
  let ok = 0;
  let failed = 0;

  for (const pair of ctx.picked) {
    const [cc, path] = pair.split("|");
    const meta = feeds.find((f) => f[0] === path);
    const gamesOnly = meta ? meta[2] : false;
    // 新游榜**不裁**：它是全品类的（每 100 条里只有约 10 条是游戏），要 limit=200 才捞得到 ~20 个新游戏。
    // 热度榜只取前 `appStoreTopN`（默认 50）：那是饱和游戏的榜单，多抓的只是队列体积与带宽。
    const lim = gamesOnly ? (meta ? meta[3] : 200) : Math.min(meta ? meta[3] : 100, g.appStoreTopN ?? 50);
    const kind = meta ? meta[1] : path;
    try {
      const r = await fetch(`https://itunes.apple.com/${cc}/rss/${path}/limit=${lim}/genre=${APP_ID}/json`,
        { headers: { "user-agent": UA, accept: "application/json" }, signal: AbortSignal.timeout(20000) });
      if (!r.ok) throw new Error("HTTP " + r.status);
      const j = await r.json();
      const items = [];
      let rank = 0;
      for (const e of (j.feed && j.feed.entry) || []) {
        const cat = (e.category && e.category.attributes) || {};
        // 新游榜是全品类的：按 genre id 过滤（label 只作兜底 —— 各国语言不同）
        if (gamesOnly && cat["im:id"] !== APP_ID && !GAME_LABEL.test(cat.label || "")) continue;
        const raw = String((e["im:name"] && e["im:name"].label) || "");
        const name = cleanName(unescape(raw));
        if (!name || name.length < 2) continue;
        rank++;
        const appid = (e.id && e.id.attributes && e.id.attributes["im:id"]) || "";
        // 🛑 `link` 在 Apple RSS 里可能是**对象**也可能是数组（实测是这个 bug 的老家：
        //    只写 `e.link[0]` 时对象形态会静默变成空串 → 条目没有 srcUrl →
        //    ① 手机端详情补不上（trackId 要从 URL 里取）② 看板上的"商店页"链接点不出来）
        const linkObj = Array.isArray(e.link) ? e.link[0] : e.link;
        const href = (linkObj && linkObj.attributes && linkObj.attributes.href) || "";
        items.push({
          name, rawName: raw, source: "appstore", kind,
          list: kind + " " + cc.toUpperCase(), geo: cc.toUpperCase(), rank,
          appid,
          // 兜底用 trackId 拼一个必定有效的商店链接（比留空好：下游要靠它拿 trackId）
          url: href || (appid ? `https://apps.apple.com/${cc}/app/id${appid}` : ""),
        });
      }
      ctx.st.cache[pair] = { at: iso(), items };
      ok++;
    } catch (e) {
      failed++;
      log("warn", `  appstore ${cc}/${path} 失败：${e.message}`);
    }
    await sleep(g.appStoreGapMs ?? 150);
  }

  const { items, expired } = budgetItems(ctx, now);
  budgetSave(ctx, cfg || {});
  log("dim", `  iOS 榜：本轮抓 ${ctx.picked.length} 组（成功 ${ok}/失败 ${failed}）→ 合并 ${items.length} 条 · 缓存 ${Object.keys(ctx.st.cache).length} 组（过期清理 ${expired}）`);
  return dedupeBest(items, appStoreBetter);
}

/**
 * iOS 手游候选（只给潜伏清单用，走独立通道不占轮转预算）。
 *
 * 🛑 **为什么不能只靠 Apple 的 `new*` feed（2026-09-24 实测）**：
 *    那个 feed 的 `updated` 时间戳是新的（实测 2026-09-23），但**里面每个游戏的上线日都停在
 *    2026-07-03 ~ 07-08**（80~84 天前，113/114 条挤在 76~83 天）——
 *    也就是说它返回的是**一个冻结的旧批次**，不是"刚上架"。用它做"刚上线"会得出全错的结论。
 *
 * ✅ 所以改成**两条腿**：
 *    ① `newfreeapplications` / `newpaidapplications`：Apple 在推的新面孔（上线日普遍 ~2 个半月，
 *       但**评分人数极少 = 竞争低**，仍值得盯）；
 *    ② `topfreeapplications` / `topgrossingapplications`：**真·刚上线就冲榜**的游戏会出现在这里 ——
 *       这条才是"新上线"的主力信号。
 *    两条合并后，由调用方用 `lookup` 拿到的**真实 releaseDate** 过滤（见 watchlist 的 mobile 段）。
 */
export async function fetchIosNewGames(cfg, opts = {}) {
  const g = (cfg && cfg.games) || {};
  const geos = (opts.geos || g.appStoreNewGeos || ["US", "GB", "JP", "KR", "BR", "DE"]).map((x) => String(x).toUpperCase());
  // ⚠️ 顺序 = 谁先占用 `maxLookup` 的详情预算。**top 榜必须排在 new 榜前面**：
  //    实测 new* feed 里的游戏上线日普遍 ~80 天（冻结批次），放进 lookups 预算后一条都通不过 60 天门槛，
  //    等于白花 2/3 的查询量。真正"刚上线就冲榜"的候选来自 topfree / topgrossing。
  const feeds = opts.feeds || [
    ["topfreeapplications", "top-free", 100],
    ["topgrossingapplications", "top-grossing", 100],
    ["newfreeapplications", "new-free", 200],
    ["newpaidapplications", "new-paid", 200],
  ];
  const out = [];
  const seen = new Set();
  for (const cc of geos) {
    for (const [path, kind, lim] of feeds) {
      try {
        const r = await fetch(`https://itunes.apple.com/${cc.toLowerCase()}/rss/${path}/limit=${lim}/genre=${APP_ID}/json`,
          { headers: { "user-agent": UA, accept: "application/json" }, signal: AbortSignal.timeout(20000) });
        if (!r.ok) throw new Error("HTTP " + r.status);
        const j = await r.json();
        let rank = 0;
        for (const e of (j.feed && j.feed.entry) || []) {
          const cat = (e.category && e.category.attributes) || {};
          if (cat["im:id"] !== APP_ID && !GAME_LABEL.test(cat.label || "")) continue;   // 新游榜是全品类的
          const raw = String((e["im:name"] && e["im:name"].label) || "");
          const name = cleanName(unescape(raw));
          if (!name || name.length < 2) continue;
          const key = name.toLowerCase();
          if (seen.has(key)) continue;
          seen.add(key);
          rank++;
          const appid = (e.id && e.id.attributes && e.id.attributes["im:id"]) || "";
          const linkObj = Array.isArray(e.link) ? e.link[0] : e.link;
          const href = (linkObj && linkObj.attributes && linkObj.attributes.href) || "";
          out.push({
            name, rawName: raw, source: "appstore", kind,
            list: kind + " " + cc, geo: cc, rank, appid,
            url: href || (appid ? `https://apps.apple.com/${cc.toLowerCase()}/app/id${appid}` : ""),
          });
        }
      } catch (e) {
        log("warn", `  iOS 榜 ${cc}/${path} 失败：${e.message}`);
      }
      await sleep(g.appStoreGapMs ?? 150);
    }
  }
  // 排序决定"先给谁做详情 lookup"（有上限）：**top 榜优先**（实测那才是"刚上线"的来源），再按榜上名次
  const kindPri = (x) => (String(x.kind).startsWith("top") ? 0 : 1);
  return dedupeBest(out, (a, b) => kindPri(a) - kindPri(b) || (a.rank || 1e9) - (b.rank || 1e9));
}

/** Google Play 游戏分类（实测：GAME 是全部游戏，子类各自独立榜） */
const PLAY_CATS = [
  ["GAME", "全部游戏"],
  ["GAME_ACTION", "动作"],
  ["GAME_CASUAL", "休闲"],
  ["GAME_PUZZLE", "益智"],
  ["GAME_STRATEGY", "策略"],
  ["GAME_ROLE_PLAYING", "角色扮演"],
  ["GAME_SIMULATION", "模拟"],
  ["GAME_ADVENTURE", "冒险"],
  ["GAME_ARCADE", "街机"],
  ["GAME_RACING", "竞速"],
  ["GAME_SPORTS", "体育"],
  // ↓ 2026-09-24 实测新增（每个都是 200 且能解析出 app）：**小游戏主要藏在这些冷门子类里**，
  //   大类的头部全是重度大作，而文字/棋牌/卡牌/问答/音乐/教育这几类的榜尾才是"小游戏"那一段。
  //   实测条数：WORD 109 · BOARD 92 · CARD 90 · TRIVIA 31 · MUSIC 87 · EDUCATIONAL 105。
  //   （试过但 404 的别再加：GAME_PRETEND_PLAY / GAME_MOVIE / GAME_FAMILY。）
  ["GAME_WORD", "文字"],
  ["GAME_BOARD", "棋牌桌游"],
  ["GAME_CARD", "卡牌"],
  ["GAME_TRIVIA", "问答"],
  ["GAME_MUSIC", "音乐"],
  ["GAME_EDUCATIONAL", "教育"],
];

/**
 * Google Play 分类热门榜（Android）。
 *
 * 为什么必须自己解析 HTML：Play 没有公开 API，但榜单页把 app 链接放在服务端渲染的 HTML 里
 * （每个卡片一个 `/store/apps/details?id=<包名>`）。实测解析成功率：
 * US 83/90 · JP 67/67 · TW 35/35 · KR 63/63 · TH 63/63 · ID 65/65 · BR 55/55 · DE 55/55。
 */
function parsePlayCharts(html) {
  const out = [];
  const seen = new Set();
  // 按卡片切开（每段以包名开头），比"整页一条大正则"稳，也不容易跨卡片串味
  const parts = String(html || "").split("/store/apps/details?id=").slice(1);
  for (const p of parts) {
    const appid = (p.match(/^([a-zA-Z0-9._]+)/) || [])[1];
    if (!appid || seen.has(appid)) continue;
    const b = p.slice(0, 2500);
    // 名字的多档回退：各国卡片模板不同，少一档就有整片解不出来（JP/TW/KR 实测走第 1 档为 0）
    let name =
      (b.match(/<div title="([^"]{2,80})">/) || [])[1] ||
      (b.match(/<div class="Epkrse[^"]*">([^<]{2,80})<\/div>/) || [])[1] ||
      (b.match(/alt="Icon image ([^"]{2,80})"/) || [])[1] ||
      (b.match(/aria-label="([^"]{2,80})"/) || [])[1] ||
      "";
    name = unescape(name);
    // 🛑 排掉"评分"串：同一个 aria-label 位置在部分卡片里是 "Rated 4.4 stars out of five stars"，
    //    不排掉榜单里就会出现叫 "Rated 4.4 stars..." 的游戏（实测踩到）。
    if (/\b(rated|stars?)\b|评分|점|評価/i.test(name)) continue;
    // 🛑 JP/TW/KR 的 aria-label 形如 "Play Township" → 剥掉本地化的动词前缀
    const stripped = name.replace(/^(Play|Jugar|Jouer|Spielen|Играть|Плай|Gioca|Oyna|Mainkan|เล่น|遊玩|플레이|ابدأ اللعب)\s+/i, "").trim();
    if (stripped.length >= 2) name = stripped;
    if (!name || name.length < 2) continue;
    seen.add(appid);
    out.push({ appid, name, rawName: name });
  }
  return out;
}

/**
 * Google Play 分类榜 × 国家（Android）。
 * ⚠️ 这是**热门榜**，不是新游榜（Play 没有可抓的"最新上架"入口，见文件头实测①）。
 *    所以 Android 侧发现的是"当前流行的手机游戏"，新游要靠 iOS 侧和热搜侧补。
 */
export async function fetchGooglePlay(cfg) {
  const g = (cfg && cfg.games) || {};
  const geos = (g.playGeos || ["US", "JP", "KR", "TW", "ID", "BR"]).map((x) => String(x).toUpperCase());
  const wantCats = new Set(g.playCategories || PLAY_CATS.map((c) => c[0]));
  const cats = PLAY_CATS.filter((c) => wantCats.has(c[0]));
  // 组合顺序：先"全部游戏 × 所有国家"（信息量最大），再逐个子类 —— 保证每圈开头就有覆盖面
  const pairs = [];
  for (const c of cats) for (const gl of geos) pairs.push(gl + "|" + c[0]);

  const ctx = budget(cfg || {}, "googleplay", pairs, g.playMaxPerRun ?? 4, g.playCacheHours ?? 72);
  const now = Date.now();
  let ok = 0;
  let failed = 0;

  for (const pair of ctx.picked) {
    const [gl, cat] = pair.split("|");
    const label = (PLAY_CATS.find((c) => c[0] === cat) || ["", cat])[1];
    try {
      const r = await fetch(`${PLAY}/store/apps/category/${cat}?gl=${gl}&hl=en`,
        { headers: { "user-agent": UA, "accept-language": "en-US,en;q=0.9" }, signal: AbortSignal.timeout(30000) });
      if (!r.ok) throw new Error("HTTP " + r.status);
      const html = await r.text();
      // 只取榜单前 N：Play 分类页一页就 40~124 个，而这是**热门榜**（多为饱和游戏），
      // 全量入库只会把队列灌满、挤掉真正值得看的候选（队列是共享的稀缺资源）。
      const parsed = parsePlayCharts(html).slice(0, g.playTopN ?? 40);
      const items = parsed.map((x, i) => ({
        name: x.name, rawName: x.rawName, source: "googleplay", kind: "top",
        list: label + " " + gl, geo: gl, rank: i + 1,
        appid: x.appid, url: PLAY + "/store/apps/details?id=" + x.appid,
      }));
      if (!items.length) throw new Error("页面里没有解析出 app（结构可能变了）");
      ctx.st.cache[pair] = { at: iso(), items };
      ok++;
      log("dim", `    play ${gl}/${cat}：${items.length} 个`);
    } catch (e) {
      failed++;
      log("warn", `  play ${gl}/${cat} 失败：${e.message}`);
    }
    await sleep(g.playGapMs ?? 400);
  }

  const { items, expired } = budgetItems(ctx, now);
  budgetSave(ctx, cfg || {});
  const playBetter = (a, b) => (/^全部游戏/.test(a.list || "") ? 1 : 0) - (/^全部游戏/.test(b.list || "") ? 1 : 0) || (a.rank || 1e9) - (b.rank || 1e9);
  log("dim", `  Android 榜：本轮抓 ${ctx.picked.length} 组（成功 ${ok}/失败 ${failed}）→ 合并 ${items.length} 条 · 缓存 ${Object.keys(ctx.st.cache).length} 组（过期清理 ${expired}）`);
  return dedupeBest(items, playBetter);
}

/**
 * itch.io「最新游戏」（网页小游戏 / 独立小游戏）。
 *
 * 为什么加它：这里全是**刚上架、竞争为零**的小游戏，正好是"早期发现"该覆盖的那一段；
 * 而且页面自带 `game_genre` / `game_author`，能直接判断"内容面大不大"。
 * 代价是绝大多数没有搜索量 —— 那由下游的趋势验证去筛，来源层只管把候选捞全。
 */
export async function fetchItch(cfg) {
  const g = ((cfg && cfg.games) || {}).webGames || {};
  const bases = g.itch || ["https://itch.io/games/newest"];
  const pages = Math.max(1, g.itchPages || 3);   // 每页 36 条；默认抓 3 页 ≈ 108 条
  const out = [];
  const seen = new Set();
  for (const base of bases) {
    for (let page = 1; page <= pages; page++) {
      const xmlUrl = base.replace(/\/+$/, "") + ".xml" + (page > 1 ? "?page=" + page : "");
      const before = out.length;
      try {
        const xml = await getText(xmlUrl, { retries: 1, timeoutMs: 20000, label: "itch" });
        for (const m of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
          const b = m[1];
          // `plainTitle` 是干净名字；`title` 带 [Free] [Platformer] 这类装饰（用来兜底并剥掉尾部标记）
          const name = unescape(
            (b.match(/<plainTitle>([\s\S]*?)<\/plainTitle>/) || [])[1] ||
            ((b.match(/<title>([\s\S]*?)<\/title>/) || [])[1] || "").replace(/\s*\[[^\]]*\]\s*$/, "")
          ).trim();
          const url = ((b.match(/<link>([\s\S]*?)<\/link>/) || [])[1] || (b.match(/<guid>([\s\S]*?)<\/guid>/) || [])[1] || "").trim();
          if (!name || name.length < 2 || !url) continue;
          const key = name.toLowerCase();
          if (seen.has(key)) continue;
          seen.add(key);
          const created = ((b.match(/<createDate>([\s\S]*?)<\/createDate>/) || [])[1] || "").trim();
          out.push({
            name, rawName: name, source: "itch", kind: "new",
            list: "itch newest p" + page,
            developer: ((b.match(/<dc:creator>([\s\S]*?)<\/dc:creator>/) || [])[1] || "").trim(),
            // 🆕 XML feed 独有的**上架日期**（HTML 页面拿不到）→ 能判"多久前上架的"
            created,
            price: ((b.match(/<price>([\s\S]*?)<\/price>/) || [])[1] || "").trim(),
            browserPlayable: /<html>\s*yes\s*<\/html>/.test(b),
            appid: String(url).split("/").filter(Boolean).pop() || "",
            url,
          });
        }
        log("dim", `    itch ${xmlUrl.replace("https://itch.io", "")}：解析 ${out.length - before} 条`);
        if (out.length === before) throw new Error("XML 里没有 item（结构可能变了）");
      } catch (e) {
        log("warn", `  itch 失败（${xmlUrl}）：${e.message}`);
      }
      await sleep(250);
    }
  }
  // 兜底：XML 挂了才退回 HTML 解析（两种卡片写法都能吃，见下）
  if (!out.length) {
    for (const base of bases) {
      try {
        const html = await getText(base, { retries: 1, timeoutMs: 20000, label: "itch-html" });
        for (const c of html.split('class="game_cell').slice(1)) {
          const anchor = c.match(/<a[^>]*data-label="game:\d+:title"[^>]*>([^<]{1,90})<\/a>/);
          if (!anchor) continue;
          const name = unescape(anchor[1]);
          const url = (anchor[0].match(/href="([^"]+)"/) || [])[1];
          if (!name || !url || name.length < 2) continue;
          out.push({
            name, rawName: name, source: "itch", kind: "new",
            list: unescape((c.match(/<div class="game_genre">([^<]{1,40})<\/div>/) || [])[1]) || "itch newest",
            genre: unescape((c.match(/<div class="game_genre">([^<]{1,40})<\/div>/) || [])[1]),
            developer: unescape((c.match(/<div class="game_author"><a[^>]*>([^<]{1,60})<\/a>/) || [])[1]),
            appid: (c.match(/data-label="game:(\d+):title"/) || [])[1] || "", url,
          });
        }
        log("warn", `  itch 已退回 HTML 解析：${out.length} 条（建议查一下 XML feed 是不是变了）`);
      } catch (e) {
        log("warn", `  itch HTML 兜底也失败（${base}）：${e.message}`);
      }
      if (out.length) break;
    }
  }
  return dedupeBest(out, (a, b) => (a.developer ? 1 : 0) - (b.developer ? 1 : 0) || (a.genre ? 1 : 0) - (b.genre ? 1 : 0));
}

/**
 * CrazyGames「新游戏」（免费在线小游戏，每天上新）。
 *
 * 页面是服务端渲染的：锚点带 `aria-label="游戏名"` + `href="https://www.crazygames.com/game/<slug>"`，
 * 实测 `/new` 一页 **70 个**游戏。老实说之前漏掉它，是因为我把链接正则写成了相对路径 `/game/...`
 * （CrazyGames 用的是**绝对** URL），于是误判为"抓不到"。
 * 没有 sitemap（`/sitemap.xml`、`/sitemap-games.xml` 都 404），所以只能解析这个页面。
 */
export async function fetchCrazyGames(cfg) {
  const g = ((cfg && cfg.games) || {}).webGames || {};
  const urls = g.crazygames || ["https://www.crazygames.com/new"];
  const out = [];
  for (const u of urls) {
    const before = out.length;
    try {
      const html = await getText(u, { retries: 1, timeoutMs: 20000, label: "crazygames" });
      const re = /aria-label="([^"]{2,70})"[^>]*href="https:\/\/www\.crazygames\.com\/game\/([a-z0-9-]{2,60})"/g;
      let rank = 0;
      for (const m of html.matchAll(re)) {
        const name = unescape(m[1]);
        if (!name || name.length < 2) continue;
        rank++;
        out.push({
          name, rawName: name, source: "crazygames", kind: "new",
          list: "CrazyGames new", rank, appid: m[2],
          url: "https://www.crazygames.com/game/" + m[2],
        });
      }
      log("dim", `    crazygames ${u.replace("https://www.crazygames.com", "")}：解析 ${out.length - before} 条`);
      if (out.length === before) throw new Error("页面解析出 0 条（结构可能变了）");
    } catch (e) {
      log("warn", `  crazygames 失败（${u}）：${e.message}`);
    }
    await sleep(300);
  }
  return dedupeBest(out, (a, b) => (a.rank || 1e9) - (b.rank || 1e9));
}

/**
 * Poki「新游戏」（免费在线小游戏）。
 *
 * 为什么加它：Poki 的"新"页同时在展示"本週热门"和"新上架"两类磁贴（`data-tile-list` 区分），
 * 而 Poki 上的游戏往往**有真实搜索量**（subway-surfers / steal-a-brainrot 这类）——
 * 是"网页小游戏站"里最容易做出流量的一段。
 */
export async function fetchPoki(cfg) {
  const g = ((cfg && cfg.games) || {}).webGames || {};
  const urls = g.poki || ["https://poki.com/en/new"];
  const out = [];
  for (const u of urls) {
    const before = out.length;
    try {
      const html = await getText(u, { retries: 1, timeoutMs: 20000, label: "poki" });
      // 磁贴前缀随语言变（/en/g/...）：从配置 URL 里推导，别硬编码
      const seg = (new URL(u).pathname.split("/")[1] || "en").toLowerCase();
      const parts = html.split(`href="/${seg}/g/`).slice(1);
      let rank = 0;
      for (const p of parts) {
        const slug = (p.match(/^([a-z0-9-]{2,60})"/) || [])[1];
        if (!slug) continue;
        const name = unescape((p.slice(0, 1500).match(/alt="([^"]{2,60})"/) || [])[1]);
        if (!name) continue;
        rank++;
        const list = (p.match(/data-tile-list="([^"]{2,40})"/) || [])[1] || "";
        // 🛑 分组名实测（`/en/new` 页）：`popularWeekGames` = 顶部的"本周热门"（12 个），
        //    其余 141 个都在 `basic-game` 组 —— 那才是"New Games"网格。
        //    所以不能按"列表名里有没有 new"判断（会全部判成 hot），只能按"是不是热门/趋势组"排除。
        out.push({
          name, rawName: name, source: "poki",
          kind: /popular|trend|top|featured/i.test(list) ? "hot" : "new",
          list: list || "poki", appid: slug, rank,
          url: `https://poki.com/${seg}/g/${slug}`,
        });
      }
      log("dim", `    poki ${u}：解析 ${out.length - before} 条`);
      if (out.length === before) throw new Error("页面解析出 0 条（结构可能变了，或被拦了）");
    } catch (e) {
      log("warn", `  poki 失败（${u}）：${e.message}`);
    }
    await sleep(300);
  }
  return dedupeBest(out, (a, b) => (/^new/.test(String(a.kind)) ? 1 : 0) - (/^new/.test(String(b.kind)) ? 1 : 0) || (a.rank || 1e9) - (b.rank || 1e9));
}