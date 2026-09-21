/**
 * Roblox 官方数据补充层（零依赖、零密钥）
 *
 * 为什么需要：游戏雷达原先只有"热度"（曲线 / 曝光次数），没有"竞争强度"。
 * 而决定"这个游戏值不值得做攻略站"的**首要因素恰恰是竞争强度** ——
 * 实测案例（2026-09-21）：Royale High 访问量 1045 亿、好评 85.9%、2 天前还在更新，
 * 从"游戏好不好"看是满分，但从"我能不能挤进去"看是零分（需求同比 -38%、
 * 7 家专业站 8 小时内发稿、长尾被社区垄断）。
 *
 * 访问量是竞争强度最好的免费代理指标：访问量越大 → 攻略站越多、权重越高 → 越挤不进去。
 * 所以在评分里它是【扣分项】，而不是加分项（与 games.json 的 score 正好相反）。
 *
 * 端点（实测确认可用，2026-09-21）：
 *   placeId  → universeId : apis.roblox.com/universes/v1/places/{placeId}/universe
 *   基础数据              : games.roblox.com/v1/games?universeIds={id}
 *   投票数据              : games.roblox.com/v1/games/votes?universeIds={id}
 * 🛑 不要用 games.roblox.com/v2/games（新接口）—— 未鉴权时不可靠；
 *    也不要回退到旧的 gamesV2 群组接口，实测对所有组都返回空数组（见 skill 护栏 1）。
 */
import { log, sleep, iso } from "./util.mjs";

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

/**
 * 给游戏列表就地补官方数据。
 *
 * 三条重要设计（不要随手改）：
 *  ① **按需刷新**：访问量变化慢，它是"竞争强度"的代理指标，不需要每小时更新。
 *     默认 7 天刷新一次，避免每轮 20+ 次请求把配额浪费在几乎不变的数上。
 *  ② **只补有 Roblox 链接的**：Steam / App Store 来源没有 Roblox 页，跳过即可（不编数据）。
 *  ③ **失败保留旧值**：网络抖动时沿用上一次的 stats，绝不写成 0 或 null 覆盖掉真数据。
 */
export async function enrichGameStats(items, cfg) {
  const g = cfg.games || {};
  if (g.statsEnabled === false) return { mode: "off", checked: 0, fetched: 0, skipped: 0, failed: 0 };
  const ttlDays = g.statsRefreshDays ?? 7;
  const maxPerRun = g.statsMaxPerRun ?? 40;
  const delayMs = g.statsDelayMs ?? 900;
  const ttlMs = ttlDays * 86400_000;
  const now = Date.now();

  // 优先刷新"分数高"的：它们更可能被推荐，值得花请求
  const pool = [...items]
    .filter((it) => it && it.srcUrl && robloxIdFromUrl(it.srcUrl))
    .sort((a, b) => (b.score || 0) - (a.score || 0));

  let checked = 0;
  let fetched = 0;
  let skipped = 0;
  let failed = 0;
  const errors = [];

  for (const it of pool) {
    const age = it.statsAt ? now - new Date(it.statsAt).getTime() : Infinity;
    if (age < ttlMs) { skipped++; continue; }
    if (fetched >= maxPerRun) { skipped++; continue; }
    checked++;
    try {
      const s = await fetchGameStats(robloxIdFromUrl(it.srcUrl), { delayMs });
      if (s) { it.stats = s; it.statsAt = iso(); fetched++; }
      else { failed++; errors.push(`${it.name}: 无 games 记录`); }
    } catch (e) {
      // 保留旧 stats（不覆盖）—— 宁可用 7 天前的访问量，也不要留空
      failed++;
      errors.push(`${it.name}: ${e.message}`);
    }
    await sleep(delayMs);
  }

  if (fetched || failed) {
    log("dim", `  Roblox 数据：刷新 ${fetched} 个 · 沿用缓存 ${skipped} 个 · 失败 ${failed} 个`);
  }
  if (errors.length) {
    for (const e of errors.slice(0, 5)) log("dim", `    ! ${e}`);
    if (errors.length > 5) log("dim", `    …还有 ${errors.length - 5} 个`);
  }
  return { mode: "on", checked, fetched, skipped, failed, errors };
}
