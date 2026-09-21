/**
 * Steam 官方数据补充层（零密钥）——补上「建站推荐」里非 Roblox 游戏的评估依据。
 *
 * 为什么需要：Roblox 侧有 visits/approval/created 可算，Steam 侧原先什么都没有，
 * 于是所有 Steam 候选在推荐页上只能是「竞争未测」。这里补三件事：
 *   ① `appdetails`   → 发售日（新鲜度）、价格、类型、开发商、是否未发售
 *   ② `appreviews`   → 评价总数与好评率（口碑；评价数也是"销量代理"）
 *   ③ `ISteamUserStats/GetNumberOfCurrentPlayers` → 当前在线（需求规模）
 *
 * ⚠️ 三条实测约束（2026-09-21，别踩）：
 *   · `appdetails` **不支持多 appid 批量**（`appids=a,b,c` 返回 HTTP 400）→ 只能逐个请求；
 *     所以靠"缓存 TTL + 每轮上限"控制请求数（稳态下每轮请求接近 0）。
 *   · `appreviews` 的 `query_summary.num_reviews` 在 `num_per_page=0` 时恒为 0，
 *     真实条数看 **`total_reviews` / `total_positive` / `total_negative`**。
 *   · 未发售游戏这三项都会给 0 —— 0 不等于"没人要"，要标 `comingSoon` 交给潜伏线评估。
 *   · CCU 接口对**未发售 / 无效 appid** 返回 **404**（不是 200+0）→ 必须当"没有数据"处理，
 *     否则每次都要白等两轮退避重试。
 *
 * 🛑 一条数据安全铁律：**按名字关联外部数据必须先确认唯一标识**。
 *    "Deep Fishing" 在 Roblox 与 Steam 上都有 → 只按名字匹配会把 Steam 的评价数写到
 *    Roblox 游戏身上，覆盖它真实的 visits/approval。所以这里只对"来源未知或明确是 Steam"
 *    的条目做名字解析（见 enrichSteamStats 里的两道护栏）。
 */
import { dataPath, readJson, writeJson, iso, log, sleep, retry } from "./util.mjs";

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";
const HDR = { "user-agent": UA, "accept-language": "en-US", accept: "application/json" };
const STEAM = "https://store.steampowered.com";

const DEFAULTS = {
  enabled: true,
  refreshHours: 6,     // Steam 评价/在线变化比 Roblox 慢，且每个游戏要 3 次请求
  maxPerRun: 40,       // 每轮最多补多少个游戏（含新解析名字的）
  gapMs: 350,
  resolveByName: true, // 没有 appid 的条目按名字精确解析（严格同名，绝不模糊匹配）
  nameResolveMaxPerRun: 15, // 每轮最多做几次名字解析（storesearch），避免一轮打几十次
  nameNegativeDays: 7,      // "搜不到"的负结果缓存天数（否则每轮都会重搜同一批搜不到的名字）
};

const cfgOf = (cfg) => Object.assign({}, DEFAULTS, (cfg && cfg.steamStats) || {});

/** 从 Steam 商店 URL 取 appid；取不到返回 null */
export function steamIdFromUrl(url) {
  const m = String(url || "").match(/steampowered\.com\/app\/(\d+)/i) || String(url || "").match(/\/app\/(\d+)/);
  return m ? Number(m[1]) : null;
}

/** 归一化游戏名（去掉 ™/®/© 与所有符号，只留字母数字） */
const norm = (s) => String(s || "").toLowerCase().replace(/[™®©]/g, "").replace(/[^a-z0-9]+/g, " ").trim();

/**
 * @param {{ok404?:boolean, retries?:number}} opts
 *   ok404：把 404 当"没有这条数据"返回 null —— 实测 CCU 接口对**未发售 / 无效 appid**
 *          返回 404（不是 200 + 0），若按错误处理会白白重试两次（1.5s + 3s）。
 */
async function getJson(url, label, opts = {}) {
  const { ok404 = false, retries = 1 } = opts;
  return retry(async () => {
    const r = await fetch(url, { headers: HDR, signal: AbortSignal.timeout(20000) });
    if (r.status === 404 && ok404) return null;
    if (r.status === 429) throw new Error("429 限流");
    if (!r.ok) throw new Error("HTTP " + r.status);
    return r.json();
  }, { retries, base: 1500, label });
}

/**
 * 名字 → appid。**只认严格同名**（归一化后相等）。
 *
 * 🛑 为什么必须严格：`gta v` 的搜索结果第一条可能是 `GTA VI`，
 *    模糊匹配会把两个游戏的体量张冠李戴（roblox-game-breakout-scanner 技能里
 *    有同类事故：`Bizarre` 命中了另一个组的 `Bizarre Piece`，分数虚高 40%）。
 *    名字是弱键，解析不到就返回 null，由上层标「补不到」，绝不猜。
 */
export async function resolveAppIdByName(name) {
  const j = await getJson(`${STEAM}/api/storesearch/?term=${encodeURIComponent(name)}&cc=us&l=english`, `storesearch/${name}`);
  const target = norm(name);
  if (!target) return null;
  for (const it of j.items || []) {
    if (norm(it.name) === target) return it.id;
  }
  return null;
}

/** 取单个游戏的 Steam 官方数据（三次请求，任一失败按 null 处理，不编数字） */
export async function fetchSteamStats(appid, { gapMs = 0 } = {}) {
  if (!appid) return null;
  const out = { platform: "steam", appid: Number(appid) };

  // ① 详情：发售日 / 价格 / 类型 / 是否未发售
  try {
    const j = await getJson(`${STEAM}/api/appdetails?appids=${appid}&cc=us&l=english&filters=basic,developers,genres,price_overview,release_date`, `appdetails/${appid}`);
    const d = j?.[appid]?.data || j?.[String(appid)]?.data;
    if (d) {
      out.name = d.name || null;
      out.created = (d.release_date && !d.release_date.coming_soon && d.release_date.date) ? d.release_date.date : null;
      out.releaseText = (d.release_date && d.release_date.date) || null;
      out.comingSoon = !!(d.release_date && d.release_date.coming_soon);
      out.developer = (d.developers || [])[0] || null;
      out.genres = (d.genres || []).map((g) => g.description);
      out.price = d.is_free ? "免费" : ((d.price_overview && d.price_overview.final_formatted) || null);
    }
  } catch (e) {
    out.error = "appdetails " + e.message;
  }

  await sleep(gapMs);

  // ② 评价：条数 + 好评率（num_reviews 恒为 0，必须用 total_*）
  try {
    const j = await getJson(`${STEAM}/appreviews/${appid}?json=1&language=all&purchase_type=all&num_per_page=0`, `appreviews/${appid}`);
    const q = j?.query_summary || {};
    const up = q.total_positive ?? null;
    const down = q.total_negative ?? null;
    out.reviews = q.total_reviews ?? null;
    out.upVotes = up;
    out.downVotes = down;
    out.reviewDesc = q.review_score_desc || null;
    out.approval = (up != null && down != null && up + down > 0) ? Number(((up / (up + down)) * 100).toFixed(1)) : null;
  } catch (e) {
    out.error = (out.error ? out.error + " · " : "") + "appreviews " + e.message;
  }

  await sleep(gapMs);

  // ③ 当前在线（需求规模的"当下"口径）。未发售 → 404 → 记 null，不当失败。
  try {
    const j = await getJson(`https://api.steampowered.com/ISteamUserStats/GetNumberOfCurrentPlayers/v1/?appid=${appid}`, `ccu/${appid}`, { ok404: true });
    out.playing = j?.response?.player_count ?? null;
  } catch (e) {
    out.error = (out.error ? out.error + " · " : "") + "ccu " + e.message;
  }

  out.fetchedAt = iso();
  return out;
}

/**
 * 给游戏列表就地补 Steam 官方数据（缓存 + 每轮上限）。
 *
 * 覆盖两类条目：
 *   a) `src === "steam"`（srcUrl 里有 appid）—— 必定处理；
 *   b) 其它没有官方数据的条目 —— 按名字**精确**解析 appid（`resolveByName`），
 *      解析到的记录下来，下次直接用缓存。
 * 失败一律保留旧值，并如实计数（不写 0 假装"没有需求"）。
 */
export async function enrichSteamStats(items, cfg) {
  const s = cfgOf(cfg);
  if (s.enabled === false) return { mode: "off", fetched: 0, skipped: 0, failed: 0, requests: 0 };

  const cacheFile = dataPath(cfg, ".steam-stats-cache.json");
  const cache = readJson(cacheFile, { items: {}, names: {} });
  cache.items = cache.items || {};
  cache.names = cache.names || {};
  const ttlMs = (s.refreshHours || 6) * 3600_000;
  const now = Date.now();

  // 名字解析缓存：{appid:number|null, at:iso}；null = 确认搜不到，7 天内不再重搜
  const nameHit = (name) => {
    const c = cache.names[norm(name)];
    if (!c) return undefined;
    if (typeof c === "number") return c;                 // 兼容旧格式
    if (c.appid) return c.appid;                          // 正向结果永久有效
    const ageOk = now - new Date(c.at).getTime() < (s.nameNegativeDays ?? 7) * 86400_000;
    return ageOk ? null : undefined;                      // 负结果有 TTL
  };

  // 先定候选：优先「已经有 appid 的」，再按名字尝试解析
  const targets = [];
  let nameToResolve = 0;
  for (const it of items) {
    if (!it) continue;
    if (it.statsAt && it.stats && it.stats.platform === "steam" && now - new Date(it.statsAt).getTime() < ttlMs) continue;
    const appid = steamIdFromUrl(it.srcUrl);
    if (appid) { targets.push({ it, appid, via: "url" }); continue; }

    // 🛑 两道护栏（实测踩过，别删）：
    //   ① **已知是别的平台（roblox / appstore）的条目，绝不去 Steam 按名字找同名** ——
    //      "Deep Fishing" 在 Roblox 和 Steam 上都有同名游戏，按名字关联会把 Steam 的
    //      评价数/好评率**写进 Roblox 游戏身上**，覆盖掉它的官方 visits/approval。
    //   ② 已经有**非 Steam** 的 stats 的条目同理跳过（二次防线）。
    const src = String(it.src || "");
    if (src && src !== "steam") continue;
    if (it.stats && it.stats.platform !== "steam" && it.stats.visits != null) continue;
    if (!s.resolveByName) continue;
    const known = nameHit(it.name);
    if (known === undefined) {
      // 需要新解析：受每轮上限约束（避免一轮打几十次 storesearch）
      if (nameToResolve >= (s.nameResolveMaxPerRun ?? 15)) continue;
      nameToResolve++;
      targets.push({ it, appid: null, via: "name" });
    } else if (known) {
      targets.push({ it, appid: known, via: "name-cache" });
    }
    // known === null → 已确认搜不到，跳过（不再重搜）
  }

  let fetched = 0;
  let failed = 0;
  let requests = 0;
  let resolvedByName = 0;
  const errors = [];

  for (const t of targets) {
    if (fetched >= (s.maxPerRun || 40)) break;
    let appid = t.appid;
    if (!appid && t.via === "name") {
      const key = norm(t.it.name);
      try {
        requests++;
        appid = await resolveAppIdByName(t.it.name);
        await sleep(s.gapMs ?? 350);
        if (appid) { cache.names[key] = { appid, at: iso() }; resolvedByName++; }
        else { cache.names[key] = { appid: null, at: iso() }; continue; } // 严格同名找不到 → 记负结果，不猜
      } catch (e) {
        failed++;
        errors.push(`${t.it.name} 名字解析失败：${e.message}`);
        continue;
      }
    }
    if (!appid) continue;
    const hit = cache.items[appid];
    if (hit && now - new Date(hit.fetchedAt).getTime() < ttlMs) {
      t.it.stats = hit;
      t.it.statsAt = hit.fetchedAt;
      continue;
    }
    try {
      requests += 3;
      const st = await fetchSteamStats(appid, { gapMs: s.gapMs ?? 350 });
      if (st && (st.name || st.reviews != null)) {
        cache.items[appid] = st;
        t.it.stats = st;
        t.it.statsAt = st.fetchedAt;
        fetched++;
      } else {
        failed++;
        errors.push(`${t.it.name} 无有效数据`);
      }
    } catch (e) {
      failed++;
      errors.push(`${t.it.name}: ${e.message}`);
    }
    await sleep(s.gapMs ?? 350);
  }

  writeJson(cacheFile, { updated: iso(), names: cache.names, items: cache.items }, true);

  const withStats = items.filter((x) => x.stats && x.stats.platform === "steam").length;
  log("dim", `  Steam 数据：刷新 ${fetched} 个（按名解析 ${resolvedByName}）· 覆盖 ${withStats} 个 · 失败 ${failed} · 请求约 ${requests} 次`);
  if (errors.length) {
    for (const e of errors.slice(0, 5)) log("dim", `    ! ${e}`);
    if (errors.length > 5) log("dim", `    …还有 ${errors.length - 5} 个`);
  }
  return { mode: "on", fetched, skipped: targets.length - fetched, failed, requests, resolvedByName, errors };
}
