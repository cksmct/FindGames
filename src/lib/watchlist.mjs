/**
 * 潜伏清单（未发售 / 刚起量）—— 与「新游戏雷达」是两个问题：
 *
 *   🎮 新游戏雷达：哪个游戏**在火**（要曲线、要搜索量、吃 Trends 配额）
 *   🚀 潜伏清单：**还没火的时候我该盯谁**（看愿望单序位、发售日、官方新晋榜）
 *
 * 实测教训（Batomon Showdown，2026-09-21）：等游戏上线才动手就已经晚了 ——
 * 上线 6 天内 SERP 上出现了 7 个专用站，最值钱的词前 8 位被 5 个域名瓜分。
 * 所以"潜伏"的判据必须是**上线前可测的**：愿望单序位 / 发售日确切度 / 是否有 Demo。
 *
 * 三条设计约束（不要随手改）：
 *   1. **绝不消耗 Trends 配额**（默认 trendsCheck=false）。列表本身零配额、可每小时跑；
 *      要不要看需求趋势由人点链接决定 —— 每个条目都带 Google Trends / SERP 直链。
 *   2. **任何失败都不删条目**。Trends 429、appdetails 失败、某来源挂掉，条目照样在，
 *      只是对应字段标「未测」—— 链接永远有效（用户明确要求：429 也要能自己点过去看）。
 *   3. **占位日期必须识别**。Steam 上大量未定档游戏写着 2099 / 9998 这类占位年份，
 *      当成真发售日会把清单按荒谬顺序排（实测 Released_DESC 榜 40 条里 15 条是占位值）。
 */
import { dataPath, readJson, writeJson, iso, log, sleep } from "./util.mjs";
import { fetchSteamPopularUpcoming, fetchSteamList, fetchRobloxSortGames, fetchIosNewGames } from "./sources.mjs";
import { loadRobloxUpcoming, normalizeEntry, scoreUpcoming, UPCOMING_RULES } from "./roblox-upcoming.mjs";
import { linkUpcomingToRoblox } from "./roblox.mjs";
import { fetchIosBatch } from "./mobile.mjs";
import { pushQueue } from "./queue.mjs";
// 潜伏评分第五维「竞争饱和度」用的单条 SERP 核查（与建站推荐共用同一份实现 + 同一份缓存）
import { checkOneSerp } from "./serp.mjs";
import { fetchInterest, hypeRatio } from "./interest.mjs";

const STEAM = "https://store.steampowered.com";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";

const DEFAULTS = {
  enabled: true,
  steamPopularCount: 100,  // 愿望单榜取多少条（实测一页 100 条已覆盖到 ~6 周后，深翻页几乎全是"已发售/临门"）
  comingSoonCount: 40,     // 近发售窗口扫多少条（再按 comingSoonDays 过滤）
  comingSoonDays: 180,     // 窗口上限：潜伏要的是"还有时间建站"的那批
  includeTooLate: false,   // ≤7 天就发售的默认不进清单（新站来不及排上去，只适合做快速长尾页）
  minPlayers: 300,         // Roblox 侧在线人数下限（过滤刚上线还没量的体验）
  robloxSorts: ["up-and-coming"],
  robloxPerSort: 40,
  enrichCount: 40,         // 每轮最多补多少个 Steam 详情（其余用缓存/留空）
  enrichCacheDays: 7,      // 详情缓存：未发售游戏的类型/价格变化很慢，别每小时重打
  enrichDelayMs: 250,
  maxItems: 120,
  trendsCheck: false,      // 默认关闭：省配额，链接已足够人工判断
  trendsPerRun: 3,         // 开启时每轮最多查几个词
  trendsFreshDays: 3,
};

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };

const cfgOf = (cfg) => Object.assign({}, DEFAULTS, (cfg && cfg.watchlist) || {});

/** 当天 0 点（UTC），用于算"还有几天" */
function utcMidnight(ms) {
  const d = new Date(ms);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

/**
 * 解析 Steam 的发售日字符串。
 * @returns {{precision:"day"|"quarter"|"year"|"unknown", days:number|null}}
 */
export function parseRelease(raw, now = Date.now()) {
  const s = String(raw || "").trim();
  if (!s) return { precision: "unknown", days: null };
  const dm = s.match(/^([A-Za-z]{3})[a-z]*\.? (\d{1,2}), (\d{4})$/);
  if (dm) {
    const mi = MONTHS[dm[1].toLowerCase()];
    const year = Number(dm[3]);
    if (mi) {
      // 占位年份守卫：> 当前年 + 5 一律视为"未定档"（9998 / 2099 / 2104 都是占位）
      if (year > new Date(now).getUTCFullYear() + 5) return { precision: "unknown", days: null };
      const days = Math.round((Date.UTC(year, mi - 1, Number(dm[2])) - utcMidnight(now)) / 86400000);
      return { precision: "day", days };
    }
  }
  if (/^Q[1-4]\s*\d{4}$/i.test(s)) return { precision: "quarter", days: null };
  if (/^\d{4}$/.test(s)) return { precision: "year", days: null };
  return { precision: "unknown", days: null };
}

/**
 * 潜伏窗口：决定"现在做还来不来得及"。
 *   build     30~180 天  ← 最佳潜伏窗口：够建站、够被收录
 *   far       >180 天或未定档
 *   close     ≤30 天（临门，窗口很窄）
 *   too-late  ≤7 天（新站来不及排上去，只适合做一个快速长尾页）
 *   live      已经上线（Roblox 侧）
 */
export function windowOf(days) {
  if (days == null) return "far";
  if (days < 7) return "too-late";
  if (days <= 30) return "close";
  if (days <= 180) return "build";
  return "far";
}
const WINDOW_ORDER = { build: 0, fresh: 1, far: 2, live: 3, close: 4, "too-late": 5 };
/** 统计面板用的中文标签（顺序与 WINDOW_ORDER 一致） */
const WINDOW_LABEL_ZH = {
  build: "🟢 黄金窗口 30~180 天",
  fresh: "🆕 新上架 ≤60 天（手游）",
  close: "🟡 临门 ≤30 天",
  far: "⚪ 远期 / 未定档",
  "too-late": "🔴 已来不及 ≤7 天",
  live: "🔵 已上线",
};

export function trendsUrl(term, geo, compare) {
  const t = String(term || "").trim();
  if (!t) return "https://trends.google.com/explore";
  const g = geo || "US";
  const q = compare && String(compare).toLowerCase() !== t.toLowerCase() ? t + "," + compare : t;
  return "https://trends.google.com/explore?date=now%207-d&geo=" + encodeURIComponent(g) + "&q=" + encodeURIComponent(q);
}

/** 让人自己一眼看竞争盘面：该游戏的 wiki / tier list / comps 占位情况 */
export function serpUrl(name) {
  return "https://www.google.com/search?q=" + encodeURIComponent("\"" + name + "\" wiki tier list comps guide");
}

function linkSet(name, url, geo, compare) {
  return { page: url || "", trends: trendsUrl(name, geo, compare), serp: serpUrl(name) };
}

/**
 * 补 Steam 详情：类型 / 开发商 / 价格 / 是否有 Demo / 确切发售日。
 *
 * ⚠️ 必须**逐个** appid 请求：实测 `appids=a,b,c` 多值批量返回 **HTTP 400**
 *    （老接口支持批量，现在只认单个）。所以这里靠"缓存 + 每轮上限"控制请求数，
 *    而不是靠合并请求 —— 缓存命中后稳态下每轮请求接近 0。
 */
/** 缓存结构版本：改了字段语义就 +1，让旧缓存自动作废（否则新字段要等 TTL 过期才生效） */
const CACHE_VERSION = 2;

async function enrichSteam(cfg, items, w) {
  const cacheFile = dataPath(cfg, ".steam-detail-cache.json");
  let cache = readJson(cacheFile, { items: {} });
  if (cache.version !== CACHE_VERSION) cache = { version: CACHE_VERSION, items: {} };
  cache.items = cache.items || {};
  cache.version = CACHE_VERSION;
  const ttl = (w.enrichCacheDays || 7) * 86400000;
  const now = Date.now();
  const byId = new Map();
  let fetched = 0;
  let failed = 0;

  for (const it of items) {
    const key = String(it.appid);
    const hit = cache.items[key];
    if (hit && hit.data && now - new Date(hit.at).getTime() < ttl) { byId.set(key, hit.data); continue; }
    if (fetched >= (w.enrichCount || 0)) { if (hit && hit.data) byId.set(key, hit.data); continue; }
    try {
      const url = STEAM + "/api/appdetails?appids=" + key +
        "&cc=us&l=english&filters=basic,developers,publishers,genres,price_overview,release_date";
      const r = await fetch(url, { headers: { "user-agent": UA, "accept-language": "en-US" } });
      if (!r.ok) throw new Error("HTTP " + r.status);
      const j = await r.json();
      const d = j[key] && j[key].data;
      if (!d) throw new Error("无 data");
      const data = {
        genres: (d.genres || []).map((g) => g.description),
        developer: (d.developers || [])[0] || "",
        publisher: (d.publishers || [])[0] || "",
        // 未定价 ≠ 免费：未发售游戏常常还没挂价格，写「未定价」比留空更诚实
        price: d.is_free ? "免费" : ((d.price_overview && d.price_overview.final_formatted) || "未定价"),
        demo: !!(d.demos && d.demos.length),
        releaseDate: (d.release_date && d.release_date.date) || "",
        comingSoon: !!(d.release_date && d.release_date.coming_soon),
      };
      cache.items[key] = { at: iso(), data };
      byId.set(key, data);
      fetched++;
    } catch (e) {
      failed++;
      if (hit && hit.data) byId.set(key, hit.data);
    }
    await sleep(w.enrichDelayMs == null ? 250 : w.enrichDelayMs);
  }
  writeJson(cacheFile, cache);
  if (failed) log("dim", `  潜伏清单：Steam 详情 ${failed} 个未取得（沿用缓存或留空，条目仍保留）`);
  return byId;
}

/**
 * 可选的需求验证（默认关闭）。开启后每轮只查 trendsPerRun 个词，
 * 429 一律记状态并**停止本轮**（把剩下的标 not-queried），条目永不删除。
 */
async function checkTrends(cfg, session, items, w, geo) {
  if (!w.trendsCheck || !w.trendsPerRun) return { checked: 0, failed: 0, mode: "off" };
  const cacheFile = dataPath(cfg, ".watchlist-state.json");
  const cache = readJson(cacheFile, { items: {} });
  cache.items = cache.items || {};
  const freshMs = (w.trendsFreshDays || 3) * 86400000;
  const now = Date.now();

  const todo = items.filter((it) => {
    const c = cache.items[String(it.name).toLowerCase()];
    const okFresh = c && c.status === "ok" && now - new Date(c.at).getTime() < freshMs;
    return !okFresh;
  }).slice(0, w.trendsPerRun);

  let checked = 0;
  let failed = 0;
  for (const it of todo) {
    const key = String(it.name).toLowerCase();
    try {
      await sleep(4000); // 曲线接口限流严格，必须慢
      const curve = await fetchInterest(session, it.name, geo, { timeframe: "now 7-d", sampleEveryHours: 4, withRelated: false });
      if (!curve || !curve.series || curve.series.length < 2) {
        it.trends = { status: "empty" };
        cache.items[key] = { status: "empty", at: iso() };
      } else {
        it.trends = { status: "ok", peak: curve.peak, series: curve.series, hype: hypeRatio(curve.series) };
        cache.items[key] = { status: "ok", at: iso() };
        checked++;
      }
    } catch (e) {
      const limited = /429|限流/.test(e.message);
      it.trends = { status: limited ? "429" : "error", error: e.message };
      cache.items[key] = { status: limited ? "429" : "error", at: iso() };
      failed++;
      if (limited) {
        log("warn", `潜伏清单：Trends 限流，本轮停止检查（条目保留，链接照给）`);
        break;
      }
    }
  }
  // 回填缓存里已有的结果（不重新请求）
  for (const it of items) {
    if (it.trends && it.trends.status !== "not-queried") continue;
    const c = cache.items[String(it.name).toLowerCase()];
    if (c && c.status === "ok" && now - new Date(c.at).getTime() < freshMs) it.trends = { status: "ok", cached: true };
    else if (c && c.status === "429") it.trends = { status: "429", cached: true };
  }
  writeJson(cacheFile, cache, true);
  return { checked, failed, mode: "on" };
}

/**
 * 生成潜伏清单并写 data/watchlist.json。
 * @returns {Promise<null|object>} 产物文档；enabled=false 时返回 null
 */
export async function buildWatchlist(cfg, session) {
  const w = cfgOf(cfg);
  if (w.enabled === false) return null;
  const geo = (cfg.games && cfg.games.geos && cfg.games.geos[0]) || cfg.trendsDefaultGeo || "US";
  const compare = cfg.trendsCompare || "";
  const now = Date.now();
  const notes = [];
  const stats = { steam: 0, roblox: 0, total: 0, trendsChecked: 0, trendsFailed: 0, trendsMode: "off", windows: {} };

  // ── 🆕 2026-09-25：潜伏条目的「首次发现时间」持久化 ──────────────────────────
  // 为什么必须持久化：`lead`（发现提前量）= 官方上线日 − **我们最早看到它的时间**。
  //   但潜伏列表**每轮重建、不留历史**（刻意的设计，见 README）→ 条目转正进 games.json 时，
  //   只能拿"入库时刻"当发现日 → `lead` 永远为负。
  //   实测规模（线上 1115 条）：`lead < 0` **712 条**、`lead > 0` **0 条**，中位滞后 78 天
  //   → "发售前发现"的先手红利在架构里**根本产生不了**，`lead` 项此前只实现了"惩罚晚发现"那一半。
  // 做法：把每个名字的首次出现时间跨轮存进 `.watchlist-firstseen.json`（点文件，不上站），
  //   转正时随队列带进 games.json 的 `firstSeenAt`。
  //   （`pushQueue` 用 Object.assign 保留任意字段，老条目还会同步新元数据 → 队列层不用改。）
  const firstSeenFile = dataPath(cfg, ".watchlist-firstseen.json");
  const firstSeenDoc = readJson(firstSeenFile, {}) || {};
  const fsItems = firstSeenDoc.items || {};
  const markFirstSeen = (name) => {
    const k = String(name || "").trim().toLowerCase();
    if (!k) return "";
    const rec = fsItems[k];
    if (rec && rec.firstSeen) { rec.lastSeen = iso(); return rec.firstSeen; }
    fsItems[k] = { name: String(name), firstSeen: iso(), lastSeen: iso() };
    return fsItems[k].firstSeen;
  };

  // ── Steam：愿望单榜（主力）+ 近发售窗口 ──
  const steamMap = new Map();
  try {
    const { items } = await fetchSteamPopularUpcoming(w.steamPopularCount);
    items.forEach((it, i) => {
      steamMap.set(String(it.appid), Object.assign({}, it, { bucket: "popular", list: "Popular Upcoming", rank: i + 1 }));
    });
  } catch (e) {
    notes.push("Steam 愿望单榜（popularcomingsoon）未取得：" + e.message);
  }
  try {
    const soon = await fetchSteamList(w.comingSoonCount, true);
    for (const it of soon) {
      const p = parseRelease(it.released, now);
      if (p.days == null || p.days > w.comingSoonDays) continue;
      const key = String(it.appid);
      if (steamMap.has(key)) { steamMap.get(key).alsoInSoon = true; continue; }
      steamMap.set(key, Object.assign({}, it, { bucket: "soon", list: "Coming Soon", rank: null }));
    }
  } catch (e) {
    notes.push("Steam 近发售窗口（comingsoon）未取得：" + e.message);
  }

  // ── Roblox：**未发售**（官方没有这份数据，用 BloxInformer Release Hub 的快照）──
  const rbx = Object.assign({ upcoming: true, rising: false, risingSorts: ["up-and-coming"], risingPerSort: 40, minPlayers: 300 }, w.roblox || {});
  let rbxUpcoming = null;
  if (rbx.upcoming) {
    try {
      rbxUpcoming = await loadRobloxUpcoming(cfg);
      log("dim", `  Roblox 即将发售：来源 ${rbxUpcoming.source} · 快照 ${rbxUpcoming.snapshotAt.slice(0, 10)} · 原始 ${rbxUpcoming.items.length} 条${rbxUpcoming.stale ? "（快照偏旧）" : ""}`);
    } catch (e) {
      notes.push("Roblox 即将发售清单未取得：" + e.message + "（可把页面另存为 data/roblox-upcoming.html 作为本地来源）");
    }
  }
  const rbxRising = [];
  if (rbx.rising) {
    try {
      rbxRising.push(...(await fetchRobloxSortGames(rbx.risingSorts, rbx.risingPerSort)));
    } catch (e) {
      notes.push("Roblox 官方榜单（get-sorts）未取得：" + e.message);
    }
  }

  // ── 组条目 ──
  // 先用榜单页自带的发售日粗筛一遍（省掉对"已来不及"游戏的详情请求），
  // 并按【最终展示顺序】去补详情 —— 每轮详情请求有上限，必须让最该看的先拿到。
  const wKey = (days) => { const k = windowOf(days); return WINDOW_ORDER[k] == null ? 9 : WINDOW_ORDER[k]; };
  const steamItems = Array.from(steamMap.values())
    .filter((s) => w.includeTooLate || (() => { const p = parseRelease(s.released, now); return p.days == null || p.days >= 7; })())
    .sort((a, b) => wKey(parseRelease(a.released, now).days) - wKey(parseRelease(b.released, now).days) ||
      (a.rank || 1e9) - (b.rank || 1e9));
  const info = await enrichSteam(cfg, steamItems, w);
  const items = [];
  const seenName = new Set();
  // 🆕 发售即转正的收集桶（见下面循环内的注释）
  const steamPromote = [];

  for (const s of steamItems) {
    const meta = info.get(String(s.appid)) || {};
    const released = meta.releaseDate || s.released || "";
    const p = parseRelease(released, now);
    // ≤7 天就发售的不进清单：新站在 7 天内不可能排上去（除非只要一个快速长尾页）。
    // 未定档（days=null）的**要留** —— 高愿望单 + 没定档恰恰是最典型的"潜伏"标的。
    if (!w.includeTooLate && p.days != null && p.days < 7) {
      // 🆕 2026-09-25：**发售即转正**（Steam 侧一直缺的"潜伏 → 上线"接班）。
      //    旧版把"临门 ≤7 天 / 已发售"的直接丢弃 —— 潜伏盯了几个月的游戏在兑现日
      //    从清单消失，且永远不会进建站推荐（转正逻辑此前只存在于 Roblox 分支）。
      //    现在：临门（0~7 天）与已发售 ≤14 天的推进雷达队列 —— prio 5、via=watchlist-live
      //    （免"必须有 Trends 曲线"门槛）、带 firstSeen；清单本体仍只服务"还没上线"。
      if (p.days >= -14 && s.appid) {
        steamPromote.push({
          name: s.name, source: "steam", kind: "new", url: s.url,
          appid: Number(s.appid),
          prio: 5,
          via: "watchlist-live",
          firstSeen: markFirstSeen(s.name),
        });
      }
      continue;
    }
    const key = String(s.name).toLowerCase();
    seenName.add(key);
    items.push({
      id: "steam:" + s.appid,
      name: s.name,
      // 🆕 我们**最早**看到它的时间（跨轮持久化）→ 转正进 games.json 后用来算 lead
      firstSeen: markFirstSeen(s.name),
      source: "steam",
      list: s.list,
      rank: s.rank,
      bucket: s.bucket,
      alsoInSoon: !!s.alsoInSoon,
      appid: Number(s.appid),
      released,
      releasePrecision: p.precision,
      releaseInDays: p.days,
      window: windowOf(p.days),
      genres: meta.genres || [],
      developer: meta.developer || "",
      publisher: meta.publisher || "",
      price: meta.price || "",
      demo: !!meta.demo,
      url: s.url,
      links: linkSet(s.name, s.url, geo, compare),
      trends: { status: "not-queried" },
    });
  }

  // ── Steam 发售即转正：推进雷达队列（与 Roblox 的 watchlist-live 共用同一套下游链路）──
  let steamPromoted = 0;
  if (steamPromote.length) {
    try {
      const knownDoc = readJson(dataPath(cfg, "games.json"), { items: [] });
      const knownNames = new Set((knownDoc.items || []).map((x) => String(x.name).toLowerCase()));
      const res = pushQueue(cfg, steamPromote, knownNames);
      // added + bumped 都算"本轮交给了雷达"：已在队列里的会被抬优先级而不是重复入队。
      steamPromoted = res.added + (res.bumped || 0);
      notes.push("Steam **发售即转正**：" + steamPromote.length + " 条临门 / 已发售的游戏推进雷达队列（新增 " + res.added +
        " · 提权 " + (res.bumped || 0) + "）—— 潜伏盯到上线后由「🎯 建站推荐」接班，潜伏期首见时间（firstSeen）随行，" +
        "这是「发现提前量」正分的来源之一。");
    } catch (e) {
      notes.push("Steam 发售即转正失败：" + e.message + "（不影响清单本体）");
    }
  }
  // Roblox 未发售（BloxInformer Release Hub）——真正的"未 release"清单 + 潜伏评分
  let rbxDroppedPast = 0;
  let rbxStat = null;
  if (rbxUpcoming) {
    const normalized = rbxUpcoming.items
      .map((g) => normalizeEntry(g, now))
      .filter((g) => g.name && g.name.length >= 2);

    // ── 关联官方 universeId（为"上线后自动接班"铺路）──
    // 用 BloxInformer 给的名字去官方搜索接口解析，并用它的社媒账号做归属校验。
    // 结果就地写回每个 entry（universeId / robloxPage / live / matchConfidence）。
    let rbxLink = null;
    try {
      // 只给"能进清单的"做搜索解析：已经发售的（releaseInDays<0）和 ≤7 天的都会被下面的过滤器丢掉，
      // 给它们花搜索配额是浪费（搜索接口限流最严，每轮上限只有 12 次）。
      const toLink = normalized.filter((g) => g.releaseInDays == null || g.releaseInDays >= (w.includeTooLate ? 0 : 7));
      rbxLink = await linkUpcomingToRoblox(toLink, cfg);
    } catch (e) {
      notes.push("Roblox 官方关联（搜索接口）失败：" + e.message + "（清单照常出，只是没有官方页链接）");
    }

    // 🆕 2026-09-25：给 Roblox 潜伏条目补「竞争饱和度」—— **未发售 ≠ 空位**
    //    实测 Dressmaker（Steam 发售 4 天 / 12,205 在线 / 97% 好评）在**发售前**
    //    （2026-08 甚至 6 月）就已经有多家专站建好，等它上线时 SERP 已被 8+ 个站占满。
    //    → 潜伏期就必须问"现在有多少人已经在做了"，否则"未发售"会被误当成"没人做"。
    //    有界：每轮最多 `watchlist.serpCheck.maxPerRun` 条（默认 5）+ 只在缓存过期时才发请求；
    //    缓存与「建站推荐」共用 `.serp-cache.json`（同一份测量、同一张分档表）。
    //    🛑 失败不写缓存（限流 ≠ 没竞争）→ 该维标「未测」，前端会显示"未测不等于没人做"。
    const serpCacheFile = dataPath(cfg, ".serp-cache.json");
    const serpCache = readJson(serpCacheFile, {}) || {};
    const serpCfg = w.serpCheck || {};
    const serpBudget = serpCfg.enabled === false ? 0 : (serpCfg.maxPerRun == null ? 5 : serpCfg.maxPerRun);
    const serpTtlMs = (serpCfg.ttlDays == null ? 14 : serpCfg.ttlDays) * 86400000;
    // 🛑 2026-09-25：**节流**（实测踩过的配额冲突）。
    //    本函数跑在 `enrichSerpComp`（建站推荐）**之前**，而 DDG 通道每轮只有约 2 条成功配额
    //    → 潜伏若每轮都抢，建站推荐的竞争实测会被**饿死**（实测：潜伏 5 条尝试吃光配额，
    //      紧接着建站推荐那 6 条几乎全失败 → 168 条主要数据一条都补不上）。
    //    潜伏条目 TTL 14 天、总量少（~25 条），**不需要每小时都跑**：
    //    每 `everyHours`（默认 6）小时才开一次窗口，其余轮次只读缓存、不发请求。
    const serpEveryMs = (serpCfg.everyHours == null ? 6 : serpCfg.everyHours) * 3600000;
    const serpStateFile = dataPath(cfg, ".watchlist-serp-state.json");
    const serpState = readJson(serpStateFile, {}) || {};
    const serpWindowOpen = serpCfg.enabled !== false && serpBudget > 0 &&
      (!serpState.lastAt || now - new Date(serpState.lastAt).getTime() >= serpEveryMs);
    let serpUsed = 0;
    let serpCached = 0;
    const serpKeyOf = (n) => String(n || "").trim().toLowerCase();
    const serpFor = async (name) => {
      const k = serpKeyOf(name);
      const hit = serpCache[k];
      if (hit && hit.at && now - new Date(hit.at).getTime() < serpTtlMs) { serpCached++; return hit; }
      if (!serpWindowOpen) return hit || null;             // 未到窗口：只读缓存，把配额让给建站推荐
      if (serpUsed >= serpBudget) return hit || null;      // 超预算：沿用旧结果；没有就留「未测」
      serpUsed++;
      try {
        const rec = await checkOneSerp(name, cfg);
        serpCache[k] = rec;
        log("dim", `    潜伏 SERP ${name}：独立域名 ${rec.domains} → 竞争档 ${rec.open}` +
          (rec.competitorFirstSeen ? `；首个专站最早快照 ${rec.competitorFirstSeen}` : ""));
        return rec;
      } catch (e) {
        log("dim", `    潜伏 SERP ${name} 失败（保持「未测」，不写缓存）：${e.message}`);
        return hit || null;
      }
    };

    const pushed = [];
    for (const g of normalized) {
      // 数据可能过期：已经发售的条目默认剔除，但要计数（不静默吞）
      if (g.releaseInDays != null && g.releaseInDays < 0) { rbxDroppedPast++; if (w.dropPast !== false) continue; }
      if (!w.includeTooLate && g.releaseInDays != null && g.releaseInDays < 7) continue;
      const key = g.name.toLowerCase();
      if (seenName.has(key)) continue;
      seenName.add(key);
      // 优先给**官方游戏页**；解析不到才退回第三方来源页
      const page = g.robloxPage || g.robloxUrl || g.sourceUrl;
      // 竞争饱和度（潜伏评分第五维）：读缓存 / 在预算内实测。拿不到就是 null（未测），不猜。
      g.serp = await serpFor(g.name);
      const assess = scoreUpcoming(g);
      const item = {
        id: g.id,
        name: g.name,
        // 🆕 我们**最早**看到它的时间（跨轮持久化）→ 转正进 games.json 后用来算 lead
        firstSeen: markFirstSeen(g.name),
        source: "roblox",
        list: "BloxInformer Release Hub",
        rank: null,
        status: g.status || "",
        genres: g.genres,
        developer: g.developer,
        platforms: g.platforms,
        released: g.released,
        releasePrecision: g.releasePrecision,
        releaseInDays: g.releaseInDays,
        window: windowOf(g.releaseInDays),
        url: page,
        links: Object.assign(linkSet(g.name, page, geo, compare), {
          // 来源页（带倒计时与状态）另行给出：Roblox 页往往还没建
          source: g.sourceUrl,
          discord: (g.social && g.social.discord) || "",
          youtube: (g.social && g.social.youtube) || "",
        }),
        assess,
        // 🆕 2026-09-25：SERP 测量结果随条目落盘（此前只进 assess.reasons 文本，前端看不到测量时间与明细）
        serp: g.serp || null,
        // 官方关联结果（有就带上；没有就如实留空，不编）
        universeId: g.universeId || null,
        matchType: g.matchType || "",
        matchConfidence: g.matchConfidence || "",
        linkRejected: g.linkRejected || "",
        live: !!g.live,
        liveStats: g.liveStats || null,
        dataAt: rbxUpcoming.snapshotAt,
        trends: { status: "not-queried" },
      };
      items.push(item);
      pushed.push(item);
    }
    if (serpUsed) {
      writeJson(serpCacheFile, serpCache, true);
      writeJson(serpStateFile, { lastAt: iso(), used: serpUsed }, true);   // 节流窗口记账
    }
    if (serpUsed || serpCached) {
      notes.push("Roblox 条目的**竞争饱和度**（潜伏评分第五维）本轮实测 " + serpUsed + " 条 · 沿用缓存 " + serpCached +
        " 条 —— 用「<游戏名> codes」前十的**专用站**数（域名含游戏名 = 专为它建的站）衡量「**现在有多少人已经在做**」；" +
        "通用游戏媒体（progameguides / pocketgamer 等）对每个游戏都有 codes 页，只如实记数、**不算对手**。" +
        "未测的条目**不等于没人做**，只是还没轮到测（每 " + Math.round(serpEveryMs / 3600000) + " 小时开一次窗口、每次上限 " + serpBudget + " 条 —— " +
        "刻意节流：DuckDuckGo 每轮只有约 2 条成功配额，而潜伏跑在「🎯 建站推荐」**之前**，" +
        "不能把它的配额吃光，否则建站推荐那 168 条主要数据一条都补不上）。");
    }

    // ── 已经能玩的（官方数据有访问/在线）→ 推进雷达队列，让它在建站推荐里"接班" ──
    // 这一步就是"潜伏 → 上线"的交接：走的是现有队列 → 取曲线 → 补官方数据 → 进 games.json 的完整链路。
    let promoted = 0;
    const liveItems = pushed.filter((x) => x.live && x.links.page.includes("roblox.com"));
    if (liveItems.length) {
      try {
        const knownDoc = readJson(dataPath(cfg, "games.json"), { items: [] });
        const knownNames = new Set((knownDoc.items || []).map((x) => String(x.name).toLowerCase()));
        // prio 5 = 最高优先级：队列里躺着几百个 Roblox 候选，而这几条**已经确认可玩**，
        // 必须让它们插队，否则会排在新候选后面等好几轮（实测：默认 prio 4 时 6 条只进了 2 条）。
        const res = pushQueue(cfg, liveItems.map((x) => ({
          name: x.name, source: "roblox", kind: "new", url: x.links.page,
          prio: 5,                 // 插队：已确认可玩，比排队等验证的候选更急
          via: "watchlist-live",   // 标记来源：雷达对这类条目免"必须有 Trend 曲线"的门槛
          // 🆕 把**潜伏期首次发现时间**带进队列 → collect.mjs 入库时写成 `firstSeenAt`
          //    （这是"发售前发现"能兑现成 lead 正分的唯一通路）
          firstSeen: x.firstSeen || "",
        })), knownNames);
        // added + bumped 都算"本轮交给了雷达"：已在队列里的会被抬优先级而不是重复入队，
        // 只报 added 会让人误以为漏掉了（实测：7 条转正，added 只有 2）。
        promoted = res.added + (res.bumped || 0);
      } catch (e) {
        notes.push("把已上线的 Roblox 条目推进雷达队列失败：" + e.message);
      }
    }

    // ── 统计（用户明确要的"统计"）：按状态 / 窗口 / 评估档 / 类型 / 数据完整度 ──
    const tally = (arr, key) => {
      const m = {};
      for (const x of arr) { const k = key(x) || "(未标注)"; m[k] = (m[k] || 0) + 1; }
      return Object.entries(m).sort((a, b) => b[1] - a[1]);
    };
    // 🆕 2026-09-25 校准观测：分数分位数 —— 「值得潜伏」长期为 0 时，先看分布再动阈值/锚点，
    //    不拍脑袋（p25/p50/p75 + 各维平均分量从 reasons 里抽不出来，先用总分分布定位压缩点）。
    const scores = pushed.map((x) => x.assess.score).sort((a, b) => a - b);
    const pct = (q) => (scores.length ? scores[Math.min(scores.length - 1, Math.floor(q * scores.length))] : null);
    const genreCount = {};
    for (const x of pushed) for (const gg of x.genres || []) genreCount[gg] = (genreCount[gg] || 0) + 1;
    rbxStat = {
      fetchedFromSource: rbxUpcoming.items.length,
      valid: normalized.length,
      droppedPast: rbxDroppedPast,
      kept: pushed.length,
      dataAt: rbxUpcoming.snapshotAt,
      source: rbxUpcoming.source,
      sourceLabel: rbxUpcoming.source.startsWith("direct") ? "直连实时抓取"
        : rbxUpcoming.source.startsWith("local") ? "本地导入的页面"
          : rbxUpcoming.source.startsWith("wayback") ? "Wayback 存档（直连失败时的兜底）"
            : "旧缓存（所有通道都失败）",
      dated: pushed.filter((x) => x.releaseInDays != null).length,
      withRobloxPage: pushed.filter((x) => x.links.page.includes("roblox.com")).length,
      withDiscord: pushed.filter((x) => x.links.discord).length,
      withYoutube: pushed.filter((x) => x.links.youtube).length,
      // 官方关联（搜索接口）的结果
      linked: pushed.filter((x) => x.universeId).length,
      linkedHighConfidence: pushed.filter((x) => x.matchConfidence === "high").length,
      linkRejected: pushed.filter((x) => x.linkRejected).length,
      liveDetected: pushed.filter((x) => x.live).length,
      promotedToRadar: promoted,
      linkSearched: rbxLink ? rbxLink.searched : 0,
      byStatus: tally(pushed, (x) => x.status),
      byWindow: tally(pushed, (x) => WINDOW_LABEL_ZH[x.window] || x.window),
      byBand: tally(pushed, (x) => x.assess.band.t),
      byGenre: Object.entries(genreCount).sort((a, b) => b[1] - a[1]).slice(0, 8),
      avgScore: pushed.length ? Math.round(pushed.reduce((a, x) => a + x.assess.score, 0) / pushed.length) : null,
      scoreP25: pct(0.25), scoreP50: pct(0.5), scoreP75: pct(0.75),
      top: pushed.slice().sort((a, b) => b.assess.score - a.assess.score).slice(0, 5)
        .map((x) => ({ name: x.name, score: x.assess.score, band: x.assess.band.t, days: x.releaseInDays })),
    };
  }

  // Roblox 官方「新晋」榜（已上线，默认关闭 —— 用户要的是未发售清单）
  for (const r of rbxRising) {
    const key = String(r.name).toLowerCase();
    if (seenName.has(key)) continue;
    if ((r.players || 0) < (rbx.minPlayers || 0)) continue;
    seenName.add(key);
    items.push({
      id: "roblox:" + (r.universeId || r.name),
      name: r.name,
      // 🆕 我们**最早**看到它的时间（跨轮持久化）→ 转正进 games.json 后用来算 lead
      firstSeen: markFirstSeen(r.name),
      source: "roblox",
      list: r.list,
      rank: null,
      players: r.players || 0,
      universeId: r.universeId || 0,
      window: "live",
      url: r.url,
      links: linkSet(r.name, r.url, geo, compare),
      trends: { status: "not-queried" },
    });
  }

  // ── iOS：**新上架手游**（2026-09-24 新增，与用户约定）──
  //
  // 为什么手机端只有 iOS 能进这份清单：
  //   · iOS 的 `newfreeapplications` / `newpaidapplications` 是"**最新上架**"，而且
  //     `itunes.apple.com/lookup` 批量接口给得到**真实 releaseDate** → 能算"上线几天"，
  //     这才是判"竞争窗口"的依据（不是"我们什么时候发现它"）；
  //   · Android（Play）**没有可抓的"新游"入口、详情页也没有首发日** → 进不了潜伏线，
  //     它只能在雷达/推荐页按"评分人数 + 星级"评估。这不是偷懒，是那个平台没这个数据。
  const iosStat = { total: 0, dated: 0, undated: 0, tooOld: 0, kept: 0, preorder: 0 };
  {
    const mob = Object.assign({ ios: true, maxAgeDays: 45, maxItems: 40, lookupBatch: 50 }, w.mobile || {});
    if (mob.ios !== false) {
      try {
        const raw = await fetchIosNewGames(cfg, { geos: mob.geos });
        iosStat.total = raw.length;
        iosStat.picked = Math.min(raw.length, mob.maxLookup || 300);

        // 真实上线日：批量 lookup（50 个/请求）。**拿不到就不猜** —— 没有官方上线日的条目判不了窗口，直接不进清单。
        // ⚠️ 必须限量：top 榜 4 榜 × 多地区会让候选涨到上千，全量 lookup 的请求量不值得。
        //    `fetchIosNewGames` 已按"新面孔优先、名次靠前优先"排好序，截断不会漏掉最该看的那批。
        const picked = raw.slice(0, mob.maxLookup || 300);
        const info = new Map();
        const byId = new Map(picked.map((x) => [String(x.appid), x]));
        const ids = Array.from(byId.keys()).filter(Boolean);
        for (let i = 0; i < ids.length; i += (mob.lookupBatch || 50)) {
          const chunk = ids.slice(i, i + (mob.lookupBatch || 50));
          const cc = ((byId.get(chunk[0]) || {}).geo || "US").toLowerCase();
          try {
            const m2 = await fetchIosBatch(chunk, cc);
            for (const [k, v] of m2) info.set(k, v);
          } catch (e) {
            notes.push("iOS 详情批量未取得：" + e.message + "（清单照常出，缺的字段标未测）");
          }
          await sleep(200);
        }

        const nowMs = now;
        for (const it of picked) {
          const st = info.get(String(it.appid));
          const rel = (st && st.created) || "";
          if (!rel) { iosStat.undated++; continue; }
          const daysSince = Math.floor((nowMs - new Date(rel + "T00:00:00Z").getTime()) / 86400000);
          // 🆕 2026-09-25：**预购 / 未上架**（releaseDate 在未来）不再是丢弃项 ——
          //    lookup 给出的未来日期是**带确切发售日的新潜伏来源**（零新增请求），
          //    与 Steam / Roblox 的"还有几天发售"同一口径进清单（正数 releaseInDays）。
          const preorder = daysSince < 0;
          if (!preorder && daysSince > (mob.maxAgeDays || 45)) { iosStat.tooOld++; continue; }
          const key = String(it.name).toLowerCase();
          if (seenName.has(key)) continue;
          if (iosStat.kept >= (mob.maxItems || 40)) break;   // 别让手机端条目把整份清单挤出局
          seenName.add(key);
          iosStat.dated++;
          iosStat.kept++;
          if (preorder) iosStat.preorder++;
          items.push({
            id: "ios:" + it.appid,
            name: it.name,
            // 🆕 我们**最早**看到它的时间（跨轮持久化）→ 转正进 games.json 后用来算 lead
            firstSeen: markFirstSeen(it.name),
            source: "appstore",
            list: it.list,                 // 形如 `new-free US`
            rank: it.rank,
            appid: it.appid,
            geo: it.geo,
            released: rel,
            // 预购：正数 = 还有 N 天发售（与 Steam/Roblox 同口径）；已上架：负数 = 已上架 N 天
            releaseInDays: -daysSince,
            daysSince: preorder ? null : daysSince,   // 「已上架几天」只对已上架语义成立
            window: preorder ? windowOf(-daysSince) : "fresh",               // 新增窗口：🆕 刚上架
            preorder,
            genres: (st && st.genres) || [],
            developer: (st && st.developer) || "",
            price: (st && st.price) || "",
            rating: st ? st.rating : null,
            ratings: st ? st.ratings : null,
            url: it.url,
            links: linkSet(it.name, it.url, geo, compare),
            trends: { status: "not-queried" },
          });
        }
        log("dim", `  iOS 新上架：榜上抓 ${iosStat.total} · 查详情 ${iosStat.picked} → 进清单 ${iosStat.dated}（预购/未上架 ${iosStat.preorder} · 无日期 ${iosStat.undated} / 超过 ${mob.maxAgeDays} 天 ${iosStat.tooOld}）`);
      } catch (e) {
        notes.push("iOS 新上架清单未取得：" + e.message);
      }
    }
  }

  // ── 排序：**发售日从近到远**（未定档沉底）。
  //
  // 🛑 2026-09-21 用户反馈后改的：旧版按"窗口"分组（build 优先），结果 Roblox 的
  //    「未定档 / TBA」条目全部挤在清单最前面，看不出哪个游戏最近发售 = 没有信息量。
  //    现在以"还有几天发售"为主键 —— 服务端这个顺序同时决定 maxItems 截断时保留谁，
  //    所以有日期的条目必须先被保住。
  //
  // 🆕 2026-09-24：iOS 的"刚上架"条目用 `daysSince` 当同一个主键 ——
  //    语义上「3 天前上架」和「3 天后发售」都是"3 天的事"，都是现在该动手的信号。
  const primaryKey = (x) => {
    if (x.source === "appstore") {
      if (x.daysSince != null) return x.daysSince;          // 已上架：按「上架几天」
      if (x.releaseInDays != null) return x.releaseInDays;  // 🆕 预购：按「还有几天发售」
      return 1e9;
    }
    return x.releaseInDays == null ? 1e9 : x.releaseInDays;
  };
  items.sort((a, b) => {
    const da = primaryKey(a);
    const db = primaryKey(b);
    if (da !== db) return da - db;
    if (a.source === "steam" && b.source === "steam") return (a.rank || 1e9) - (b.rank || 1e9);
    if (a.source === "roblox" && b.source === "roblox") return (b.players || 0) - (a.players || 0);
    if (a.source === "appstore" && b.source === "appstore") return (a.rank || 1e9) - (b.rank || 1e9);
    return a.source === "steam" ? -1 : 1;
  });

  const limited = items.slice(0, w.maxItems);
  const tr = await checkTrends(cfg, session, limited, w, geo);
  stats.trendsChecked = tr.checked;
  stats.trendsFailed = tr.failed;
  stats.trendsMode = tr.mode;
  stats.steam = limited.filter((x) => x.source === "steam").length;
  stats.roblox = limited.filter((x) => x.source === "roblox").length;
  stats.appstore = limited.filter((x) => x.source === "appstore").length;
  stats.steamPromoted = steamPromoted;
  stats.ios = iosStat;
  stats.robloxUpcoming = rbxUpcoming ? rbxUpcoming.items.length : 0;
  stats.robloxDroppedPast = rbxDroppedPast;
  stats.robloxSource = rbxUpcoming ? rbxUpcoming.source : "none";
  stats.robloxSnapshotAt = rbxUpcoming ? rbxUpcoming.snapshotAt : "";
  stats.robloxStale = rbxUpcoming ? !!rbxUpcoming.stale : false;
  stats.robloxStats = rbxStat;
  stats.total = limited.length;
  for (const it of limited) stats.windows[it.window] = (stats.windows[it.window] || 0) + 1;

  notes.push("Steam 不公开愿望单数量：popularcomingsoon 的名次只作**热度代理**，不是绝对需求。");
  if (iosStat.total) {
    notes.push(`iOS 手游：来源 Apple 的 newfree/newpaid（Apple 在推的新面孔）+ topfree/topgrossing（**真·刚上线就冲榜**）` +
      `，再用 lookup 拿**真实上线日**过滤（榜上 ${iosStat.total} → 查详情 ${iosStat.picked} → 有日期 ${iosStat.dated}、无日期跳过 ${iosStat.undated}、超过 ${(w.mobile && w.mobile.maxAgeDays) || 60} 天 ${iosStat.tooOld}）。` +
      "窗口标「🆕 新上架」；评分人数是需求代理、星级是口碑（0 人评 = 刚上架，不是口碑差）。" +
      "🆕 **预购 / 未上架**（releaseDate 在未来）不再丢弃：按「N 天后发售」进清单 —— lookup 的未来日期是带确切发售日的潜伏来源（零新增请求）。");
    notes.push("🛑 **不要相信 Apple 的 new* feed 就等于「刚上线」**：实测 2026-09-24 该 feed 的 `updated` 是新的，" +
      "但里面每个游戏的上线日都停在 **2026-07-03~07-08**（113/114 条挤在 76~83 天）—— 它返回的是**冻结的旧批次**。" +
      "所以本清单靠 **lookup 的真实 releaseDate** 判窗口，而不是靠它在不在 new 榜上。");
    notes.push("⚠️ **Android 进不了这份清单**：Google Play 没有可抓的「新游」入口，详情页也没有首发日 → 判不了「上线几天」。" +
      "它只能在「🎮 新游戏雷达 / 🎯 建站推荐」里按评分人数 + 星级评估（竞争需人工点 SERP 核查）。");
  }
  notes.push("Steam 没有「3~6 个月后发售的高愿望单」官方榜（实测深翻页仍是近月发售的游戏）——所以远期候选只能靠人工渠道（官方公告 / 预告片 / 社区）补，本清单偏「近月高热度」。");
  if (rbxUpcoming && rbxStat) {
    notes.push("Roblox 侧是**未发售清单**：Roblox 官方没有这类公开列表（官方 up-and-coming 是「已上线刚起量」），数据来自第三方 BloxInformer Release Hub，" +
      rbxStat.sourceLabel + "。数据时间 " + rbxUpcoming.snapshotAt.slice(0, 16).replace("T", " ") +
      "（原始 " + rbxStat.fetchedFromSource + " 条 → 剔除已发售 " + rbxStat.droppedPast + " 条 → 保留 " + rbxStat.kept + " 条）。");
    notes.push("Roblox 条目的**潜伏评分（0~100）**＝发布确定性 28 + 日期精确度 18 + 内容面 14 + 社区地基 20 + 竞争饱和度 20（竞争未测时该项按权重跳过归一，不是 0 分）；" +
      "内容面与日期精确度是**按页面给的字段推断的启发式**（不是实测），所以每条都带理由，可一眼反驳。窗口(build/close/far)与评分是两件事：评分高但只剩 7 天照样来不及。");
    if (rbxUpcoming.stale) notes.push("⚠️ 这份 Roblox 数据已过期（>26 小时）：日期请以 BloxInformer 来源页为准。");
    if (rbxDroppedPast) notes.push("数据里已有 " + rbxDroppedPast + " 条在上次抓取后被发售，已从清单剔除（上线后请走「建站推荐」那条线评估）。");
    notes.push("已用 Roblox 官方搜索接口把条目关联到官方 universeId：关联上 " + rbxStat.linked + " 条（其中归属校验通过 " +
      rbxStat.linkedHighConfidence + " 条，拒绝 " + rbxStat.linkRejected + " 条同名仿作）。有官方页的条目链接直接指向 roblox.com。");
    if (rbxStat.liveDetected) {
      notes.push("其中 **" + rbxStat.liveDetected + " 条已经能玩**（官方数据里已有访问量/在线）→ 已自动推进雷达队列" +
        (rbxStat.promotedToRadar ? "（新增 " + rbxStat.promotedToRadar + " 条）" : "（已在队列或已在雷达里）") +
        "，下一轮采集就会带官方数据出现在「🎯 建站推荐」—— 这就是「潜伏 → 上线」的接班。");
    }
  }
  notes.push("Roblox 条目里的「状态」来自 BloxInformer（如 In Development / Confirmed / Delayed / Maybe Cancelled），是第三方核对结果，不是 Roblox 官方声明。");
  if (stats.trendsMode === "off") notes.push("Trends 本轮未查（省配额）：每条都带 Google Trends 与 SERP 直链，可自己点开看。");
  notes.push("未测 ≠ 没有需求：字段标「未测」时请以链接实测为准。");

  const doc = {
    updated: iso(),
    geo,
    compareWith: compare,
    defaultGeo: cfg.trendsDefaultGeo || geo,
    stats,
    notes,
    rules: UPCOMING_RULES,   // 算法自述随产物下发（前端据实展示，单一事实源在 scoreUpcoming 旁边）
    items: limited,
  };
  writeJson(dataPath(cfg, "watchlist.json"), doc);
  // firstSeen 写回：保留 180 天内出现过的，长期不出现的清掉（避免文件无限增长）
  const fsCutoff = now - 180 * 86400000;
  let fsDropped = 0;
  for (const [k, v] of Object.entries(fsItems)) {
    if (!v || !v.lastSeen || new Date(v.lastSeen).getTime() < fsCutoff) { delete fsItems[k]; fsDropped++; }
  }
  writeJson(firstSeenFile, { updated: iso(), items: fsItems }, true);
  return doc;
}
