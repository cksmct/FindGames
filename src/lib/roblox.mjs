/**
 * Roblox 官方数据补充层（零依赖、零密钥）
 *
 * 为什么需要：游戏雷达原先只有"热度"（曲线 / 曝光次数），没有官方体量数据。
 * 建站推荐的评分要用到三样东西，都来自这里：**访问量（需求规模）、好评率（口碑）、上线日（新鲜度）**。
 *
 * 🛑 2026-09-21 用户修正：**访问量是「需求」不是「竞争」**。
 *    旧注释里写的"访问量越大越挤不进去"是错的推理：访问量只说明有多少人在找，
 *    竞争强度必须独立测（人工 SERP 核查优先，其次用上线时长推断）。
 *    所以访问量在新评分里是**正向项（需求规模）**，不再是扣分项。
 *
 * 实测参考（Royale High）：访问 1045 亿（需求拉满），但上线 9 年 + 需求同比 -38% +
 * 7 家专业站 8 小时内发稿 —— 它是被**竞争与时长**否掉的，不是被访问量否掉的。
 *
 * 端点（实测确认可用，2026-09-21）：
 *   placeId  → universeId : apis.roblox.com/universes/v1/places/{placeId}/universe
 *   基础数据              : games.roblox.com/v1/games?universeIds={id}
 *   投票数据              : games.roblox.com/v1/games/votes?universeIds={id}
 * 🛑 不要用 games.roblox.com/v2/games（新接口）—— 未鉴权时不可靠；
 *    也不要回退到旧的 gamesV2 群组接口，实测对所有组都返回空数组（见 skill 护栏 1）。
 */
import { log, sleep, iso, dataPath, readJson, writeJson } from "./util.mjs";

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";
const HDR = { "user-agent": UA, accept: "application/json" };

/** 从 Roblox 游戏页 URL 里取数字 id。取不到返回 null（不外抛）。 */
export function robloxIdFromUrl(url) {
  const m = String(url || "").match(/roblox\.com\/games\/(\d+)/i);
  return m ? Number(m[1]) : null;
}

/**
 * 带退避的重试。Roblox 这几个接口会 429，但比搜索接口宽松。
 * 耗尽就抛错 —— 由调用方决定是"记失败"还是"保留旧值"，不在这里静默吞掉。
 */
async function getJson(url, { retries = 2, base = 1200, label = "" } = {}) {
  let last;
  for (let i = 0; i <= retries; i++) {
    try {
      const r = await fetch(url, { headers: HDR });
      if (r.ok) return await r.json();
      if (r.status !== 429 && r.status < 500) throw new Error(`HTTP ${r.status}`);
      last = new Error(`HTTP ${r.status}`);
    } catch (e) {
      last = e;
    }
    if (i < retries) await sleep(base * Math.pow(2, i));
  }
  throw new Error(`${label || "roblox"} 请求失败：${last?.message}`);
}

/**
 * 取单个游戏的官方数据。
 * @param {number} id placeId 或 universeId（先按 placeId 解析，失败再当 universeId 试）
 * @returns {Promise<object|null>} 取不到返回 null
 */
export async function fetchGameStats(id, { delayMs = 0 } = {}) {
  if (!id) return null;
  let universeId = null;

  // 先按 placeId 解析（sources.mjs 存进 srcUrl 的是 rootPlaceId）
  try {
    const u = await getJson(`https://apis.roblox.com/universes/v1/places/${id}/universe`, { label: "place→universe" });
    if (u?.universeId) universeId = u.universeId;
  } catch {
    // 不是 placeId 就按 universeId 直接试（下面会验证）
  }
  if (!universeId) universeId = id;

  const g = await getJson(`https://games.roblox.com/v1/games?universeIds=${universeId}`, { label: "games" });
  const d = g?.data?.[0];
  if (!d) return null;

  if (delayMs) await sleep(delayMs);
  let up = null;
  let down = null;
  try {
    const v = await getJson(`https://games.roblox.com/v1/games/votes?universeIds=${universeId}`, { label: "votes" });
    const vt = v?.data?.[0];
    if (vt) { up = vt.upVotes || 0; down = vt.downVotes || 0; }
  } catch {
    // 投票拿不到不影响主结论：approval 留 null，由前端标"未取得"（绝不写 0）
  }

  const tot = (up || 0) + (down || 0);
  return {
    universeId,
    visits: d.visits ?? null,
    favoritedCount: d.favoritedCount ?? null,
    playing: d.playing ?? null,
    maxPlayers: d.maxPlayers ?? null,
    created: d.created || null,
    updated: d.updated || null,
    creator: d.creator ? { id: d.creator.id, name: d.creator.name, type: d.creator.type } : null,
    upVotes: up,
    downVotes: down,
    approval: tot ? Number(((up / tot) * 100).toFixed(1)) : null,
  };
}

/** placeId → universeId 的永久缓存文件（映射关系不会变，只有"没查过"才需要请求） */
function universeMapFile(cfg) {
  return dataPath(cfg, ".roblox-universe-map.json");
}

const chunk = (arr, n) => {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
};

/** 批量取 games 数据（一次最多 50 个 universeId） */
async function fetchGamesByIds(ids, gapMs) {
  const out = new Map();
  const errors = [];
  for (const part of chunk(ids, 50)) {
    try {
      const j = await getJson(`https://games.roblox.com/v1/games?universeIds=${part.join(",")}`, { label: "games(batch)" });
      for (const d of j?.data || []) out.set(Number(d.id), d);
    } catch (e) {
      errors.push(`games 批量(${part.length} 个)：${e.message}`);
    }
    await sleep(gapMs);
  }
  return { map: out, errors };
}

/** 批量取投票数据（同样最多 50 个） */
async function fetchVotesByIds(ids, gapMs) {
  const out = new Map();
  const errors = [];
  for (const part of chunk(ids, 50)) {
    try {
      const j = await getJson(`https://games.roblox.com/v1/games/votes?universeIds=${part.join(",")}`, { label: "votes(batch)" });
      for (const d of j?.data || []) out.set(Number(d.id), d);
    } catch (e) {
      errors.push(`votes 批量(${part.length} 个)：${e.message}`);
    }
    await sleep(gapMs);
  }
  return { map: out, errors };
}

/** 把批量接口返回的一条记录整形成前端用的 stats（缺失写 null，绝不写 0） */
function shapeStats(d, v) {
  const up = v?.upVotes ?? null;
  const down = v?.downVotes ?? null;
  const tot = (up ?? 0) + (down ?? 0);
  return {
    universeId: d.id ?? null,
    visits: d.visits ?? null,
    favoritedCount: d.favoritedCount ?? null,
    playing: d.playing ?? null,
    maxPlayers: d.maxPlayers ?? null,
    created: d.created || null,
    updated: d.updated || null,
    creator: d.creator ? { id: d.creator.id, name: d.creator.name, type: d.creator.type } : null,
    upVotes: up,
    downVotes: down,
    approval: tot ? Number(((up / tot) * 100).toFixed(1)) : null,
  };
}

/**
 * 给游戏列表就地补官方数据（**批量版**）。
 *
 * 🛑 2026-09-21 重写（用户要求"推荐列表要有实时性"）：
 *    旧版**逐个游戏**请求（每个 3 次：place→universe + games + votes）+ 每个之间 sleep 900ms，
 *    刷 40 个 = 120+ 次请求 + 36 秒 —— 所以只能定 7 天 TTL。这不成立：
 *    `games.roblox.com/v1/games?universeIds=a,b,c…` **本身就支持一次 50 个**，
 *    55 个游戏只要 2 批 = 2 次请求（加 votes 共 4 次）。既然请求数从 120 降到 4，
 *    就**没有理由**再限制成 7 天 —— 现在默认 **1 小时** TTL，推荐列表因此每小时都是新的。
 *
 * 四条设计（不要随手改）：
 *  ① **批量 + place→universe 永久缓存**：这是能把 TTL 从 7 天压到 1 小时的前提。
 *     （限制频率的是请求数，不是"访问量变化慢"这个理由 —— 旧注释里的说法是错的。）
 *  ② **只补有 Roblox 链接的**：Steam / App Store 来源没有 Roblox 页，跳过即可（不编数据）。
 *  ③ **失败保留旧值**：网络抖动时沿用上一次的 stats，绝不写成 0 或 null 覆盖真数据。
 *  ④ **优先刷新分数高的**：配额万一不够，先保推荐页会展示的那批。
 */
export async function enrichGameStats(items, cfg) {
  const g = cfg.games || {};
  if (g.statsEnabled === false) return { mode: "off", checked: 0, fetched: 0, skipped: 0, failed: 0 };
  // 新配置优先（小时），老的 statsRefreshDays 仍兼容
  const ttlHours = g.statsRefreshHours != null ? g.statsRefreshHours : (g.statsRefreshDays != null ? g.statsRefreshDays * 24 : 1);
  const maxPerRun = g.statsMaxPerRun ?? 300;
  const gapMs = g.statsDelayMs ?? 250; // 现在是"每批之间"的间隔，不是每个游戏之间
  const ttlMs = ttlHours * 3600_000;
  const now = Date.now();
  const errors = [];

  const pool = items.filter((it) => it && it.srcUrl && robloxIdFromUrl(it.srcUrl));
  const need = pool
    .filter((it) => {
      const age = it.statsAt ? now - new Date(it.statsAt).getTime() : Infinity;
      return age >= ttlMs;
    })
    .sort((a, b) => (b.score || 0) - (a.score || 0))
    .slice(0, maxPerRun);
  const skipped = items.length - need.length;
  if (!need.length) {
    log("dim", `  Roblox 数据：全部在 ${ttlHours}h 保鲜期内，跳过（${pool.length} 个有 Roblox 页）`);
    return { mode: "on", checked: 0, fetched: 0, skipped, failed: 0, errors, requests: 0 };
  }

  // ① placeId → universeId（永久缓存）
  const mapFile = universeMapFile(cfg);
  const cache = readJson(mapFile, { map: {} });
  cache.map = cache.map || {};
  const resolved = new Map();
  let requests = 0;
  for (const it of need) {
    const placeId = robloxIdFromUrl(it.srcUrl);
    if (cache.map[placeId]) { resolved.set(it, cache.map[placeId]); continue; }
    try {
      requests++;
      const u = await getJson(`https://apis.roblox.com/universes/v1/places/${placeId}/universe`, { retries: 1, base: 800, label: "place→universe" });
      if (u?.universeId) { cache.map[placeId] = u.universeId; resolved.set(it, u.universeId); }
      else errors.push(`${it.name}: place→universe 无 universeId`);
    } catch (e) {
      errors.push(`${it.name}: ${e.message}`);
    }
    await sleep(gapMs);
  }
  writeJson(mapFile, { updated: iso(), map: cache.map }, true);

  const ids = [...new Set([...resolved.values()])];
  const games = await fetchGamesByIds(ids, gapMs);
  const votes = await fetchVotesByIds(ids, gapMs);
  requests += chunk(ids, 50).length * 2;
  errors.push(...games.errors, ...votes.errors);

  let fetched = 0;
  let failed = 0;
  for (const it of need) {
    const uid = resolved.get(it);
    const d = uid ? games.map.get(uid) : null;
    if (!d) { failed++; continue; } // 保留旧 stats（宁可用上次的数字，也不要留空）
    it.stats = shapeStats(d, votes.map.get(uid));
    it.statsAt = iso();
    fetched++;
  }
  if (failed) errors.push(`${failed} 个没拿到 games 记录（沿用旧值）`);

  log("dim", `  Roblox 数据：刷新 ${fetched} 个 · 沿用缓存 ${skipped} 个 · 失败 ${failed} 个 · 请求 ${requests} 次（批量）`);
  if (errors.length) {
    for (const e of errors.slice(0, 5)) log("dim", `    ! ${e}`);
    if (errors.length > 5) log("dim", `    …还有 ${errors.length - 5} 个`);
  }
  return { mode: "on", checked: need.length, fetched, skipped, failed, errors, requests };
}
