

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
import { log } from "./util.mjs";

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";
const STEAM = "https://store.steampowered.com";
const TAGS = /[™®©]/g;

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
  if (on("appstore")) jobs.push(["appstore", () => fetchAppStore(g.appStoreGeos || ["US", "GB", "CA", "AU"])]);
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
  return out;
}

/**
 * App Store 游戏榜（手机端来源）。
 * 端点：itunes.apple.com/<cc>/rss/<topfreeapplications|toppaidapplications>/limit=100/genre=6014/json
 * （6014 = Games 分类；这是 Apple 仍在服务的旧版 RSS，实测 200 且是干净 JSON）
 * 注意：rss.marketingtools.apple.com 的新版 /games.json 路径已 404，别用。
 */
export async function fetchAppStore(geos = ["US", "GB", "CA", "AU"]) {
  const out = [];
  const seen = new Set();
  // 前两个是"当前最热"榜；后两个是"最新上架"，新版 RSS 已忽略 genre 参数，所以本地按 category === Games 过滤
  const feeds = [["topfreeapplications", "top-free", false], ["toppaidapplications", "top-paid", false], ["newfreeapplications", "new-free", true], ["newapplications", "new", true]];
  for (const cc of geos) {
    for (const [path, kind, gamesOnly] of feeds) {
      const lim = gamesOnly ? 200 : 100;
      const url = "https://itunes.apple.com/" + String(cc).toLowerCase() + "/rss/" + path + "/limit=" + lim + "/genre=6014/json";
      try {
        const r = await fetch(url, { headers: { "user-agent": UA, accept: "application/json" } });
        if (!r.ok) throw new Error("HTTP " + r.status);
        const j = await r.json();
        for (const e of (j.feed && j.feed.entry) || []) {
          const cat = (e.category && e.category.attributes && e.category.attributes.label) || "";
          if (gamesOnly && cat !== "Games") continue;
          const name = String((e["im:name"] && e["im:name"].label) || "").trim();
          const key = name.toLowerCase();
          if (!name || key.length < 2 || seen.has(key)) continue;
          seen.add(key);
          out.push({
            name, rawName: name, source: "appstore", kind, geo: cc,
            appid: (e.id && e.id.attributes && e.id.attributes["im:id"]) || "",
            url: (e.link && e.link[0] && e.link[0].attributes && e.link[0].attributes.href) || "",
          });
        }
      } catch (e) {
        log("warn", "appstore " + cc + "/" + path + " 失败：" + e.message);
      }
    }
  }
  return out;
}