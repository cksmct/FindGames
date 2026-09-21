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
import { fetchSteamPopularUpcoming, fetchSteamList, fetchRobloxSortGames } from "./sources.mjs";
import { loadRobloxUpcoming, normalizeEntry } from "./roblox-upcoming.mjs";
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
const WINDOW_ORDER = { build: 0, far: 1, live: 2, close: 3, "too-late": 4 };

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

  for (const s of steamItems) {
    const meta = info.get(String(s.appid)) || {};
    const released = meta.releaseDate || s.released || "";
    const p = parseRelease(released, now);
    // ≤7 天就发售的不进清单：新站在 7 天内不可能排上去（除非只要一个快速长尾页）。
    // 未定档（days=null）的**要留** —— 高愿望单 + 没定档恰恰是最典型的"潜伏"标的。
    if (!w.includeTooLate && p.days != null && p.days < 7) continue;
    const key = String(s.name).toLowerCase();
    seenName.add(key);
    items.push({
      id: "steam:" + s.appid,
      name: s.name,
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
  // Roblox 即将发售（BloxInformer 快照）——真正的"未 release"清单
  let rbxDroppedPast = 0;
  if (rbxUpcoming) {
    const normalized = rbxUpcoming.items
      .map((g) => normalizeEntry(g, now))
      .filter((g) => g.name && g.name.length >= 2);
    for (const g of normalized) {
      // 快照可能已过期：已经发售的条目默认剔除，但要计数（不静默吞）
      if (g.releaseInDays != null && g.releaseInDays < 0) { rbxDroppedPast++; if (w.dropPast !== false) continue; }
      if (!w.includeTooLate && g.releaseInDays != null && g.releaseInDays < 7) continue;
      const key = g.name.toLowerCase();
      if (seenName.has(key)) continue;
      seenName.add(key);
      const page = g.robloxUrl || g.sourceUrl;
      items.push({
        id: g.id,
        name: g.name,
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
        snapshotAt: rbxUpcoming.snapshotAt,
        trends: { status: "not-queried" },
      });
    }
    if (rbxDroppedPast) log("dim", `  Roblox 即将发售：剔除 ${rbxDroppedPast} 条快照里已经发售的（快照 ${rbxUpcoming.snapshotAt.slice(0, 10)}）`);
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

  // ── 排序：**发售日从近到远**（未定档沉底）。
  //
  // 🛑 2026-09-21 用户反馈后改的：旧版按"窗口"分组（build 优先），结果 Roblox 的
  //    「未定档 / TBA」条目全部挤在清单最前面，看不出哪个游戏最近发售 = 没有信息量。
  //    现在以"还有几天发售"为主键 —— 服务端这个顺序同时决定 maxItems 截断时保留谁，
  //    所以有日期的条目必须先被保住。
  items.sort((a, b) => {
    const da = a.releaseInDays == null ? 1e9 : a.releaseInDays;
    const db = b.releaseInDays == null ? 1e9 : b.releaseInDays;
    if (da !== db) return da - db;
    if (a.source === "steam" && b.source === "steam") return (a.rank || 1e9) - (b.rank || 1e9);
    if (a.source === "roblox" && b.source === "roblox") return (b.players || 0) - (a.players || 0);
    return a.source === "steam" ? -1 : 1;
  });

  const limited = items.slice(0, w.maxItems);
  const tr = await checkTrends(cfg, session, limited, w, geo);
  stats.trendsChecked = tr.checked;
  stats.trendsFailed = tr.failed;
  stats.trendsMode = tr.mode;
  stats.steam = limited.filter((x) => x.source === "steam").length;
  stats.roblox = limited.filter((x) => x.source === "roblox").length;
  stats.robloxUpcoming = rbxUpcoming ? rbxUpcoming.items.length : 0;
  stats.robloxDroppedPast = rbxDroppedPast;
  stats.robloxSource = rbxUpcoming ? rbxUpcoming.source : "none";
  stats.robloxSnapshotAt = rbxUpcoming ? rbxUpcoming.snapshotAt : "";
  stats.robloxStale = rbxUpcoming ? !!rbxUpcoming.stale : false;
  stats.total = limited.length;
  for (const it of limited) stats.windows[it.window] = (stats.windows[it.window] || 0) + 1;

  notes.push("Steam 不公开愿望单数量：popularcomingsoon 的名次只作**热度代理**，不是绝对需求。");
  notes.push("Steam 没有「3~6 个月后发售的高愿望单」官方榜（实测深翻页仍是近月发售的游戏）——所以远期候选只能靠人工渠道（官方公告 / 预告片 / 社区）补，本清单偏「近月高热度」。");
  if (rbxUpcoming) {
    notes.push("Roblox 侧是**未发售清单**：Roblox 官方没有这类公开列表（官方 up-and-coming 是「已上线刚起量」，不是未发布），数据来自第三方 BloxInformer Release Hub，经 Wayback 快照获取。" +
      "快照时间 " + rbxUpcoming.snapshotAt.slice(0, 10) + "（来源 " + rbxUpcoming.source + "）" +
      "—— 快照偏旧时发售日可能已经变动，以来源页为准。");
    if (rbxUpcoming.stale) notes.push("⚠️ Roblox 快照已超过 21 天：日期请以 BloxInformer 来源页为准（可把页面另存为 data/roblox-upcoming.html 换成实时数据）。");
    if (rbxDroppedPast) notes.push("Roblox 快照里已有 " + rbxDroppedPast + " 条在快照后被发售，已从清单剔除（说明快照确实过期了）。");
  }
  notes.push("Roblox 条目里的「状态」来自 BloxInformer（如 In Development / Confirmed / Delayed），是第三方核对结果，不是 Roblox 官方声明。");
  if (stats.trendsMode === "off") notes.push("Trends 本轮未查（省配额）：每条都带 Google Trends 与 SERP 直链，可自己点开看。");
  notes.push("未测 ≠ 没有需求：字段标「未测」时请以链接实测为准。");

  const doc = {
    updated: iso(),
    geo,
    compareWith: compare,
    defaultGeo: cfg.trendsDefaultGeo || geo,
    stats,
    notes,
    items: limited,
  };
  writeJson(dataPath(cfg, "watchlist.json"), doc);
  return doc;
}
