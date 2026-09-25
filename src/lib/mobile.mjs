/**
 * 手机端官方数据补充层（iOS / Android，零密钥）—— 与 roblox.mjs / steam.mjs 同一目的：
 * 让「建站推荐」对手游也能算需求规模 / 口碑 / 新鲜度，而不是只显示「未测」。
 *
 * 两个平台的**能力完全不对等**，这里如实处理，不假装对称：
 *
 *   iOS（Apple iTunes Lookup）—— 强：
 *     `https://itunes.apple.com/lookup?id=<trackId1,trackId2,...>&country=<cc>`
 *     实测**支持批量**（50 个一批 ≈ 400KB），一次请求能给到：
 *       releaseDate（**真实上线日**，预购游戏会是未来日期 → 这就是"未发售手游"信号）
 *       currentVersionReleaseDate（最后更新）· price · averageUserRating · userRatingCount（评分人数=需求代理）
 *       sellerName（开发商）· genres（含子类，如 Games/Strategy/Action → 判断内容面）
 *
 *   Android（Play 详情页）—— 弱，且必须说清弱在哪：
 *     Play **没有公开 API**，也没有 `datePublished`；实测详情页里
 *     "Released on" ❌ / `datePublished` ❌ / 安装量 ❌，只有 "Updated on" ✅ 和 JSON-LD 里的
 *     评分/评分数/分类。所以：
 *       · `created`（首发日）**只能标 null** —— 绝不许拿 "Updated on" 冒充首发日
 *       · `installs` 同样是 null（拿不到，不猜）
 *     且一个详情页 ~1.3MB → 每轮只允许补极少量（`androidMaxPerRun`，默认 4）。
 *
 * 🛑 两条护栏（与 steam.mjs 同源，别删）：
 *   ① 只处理**来源明确是本平台**的条目（`src === "appstore"` / `"googleplay"`），
 *      绝不按名字去别的平台找同名 —— "Deep Fishing" 在 Roblox 与 Steam 上就是两个游戏。
 *   ② 拿不到就写 null 并保留旧值，绝不写 0（0 分 ≠ 没人玩，未测 ≠ 0）。
 */
import { dataPath, readJson, writeJson, iso, log, sleep, keepStatsPrev } from "./util.mjs";

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";

const DEFAULTS = {
  enabled: true,
  iosRefreshHours: 24,     // 上线日/价格几乎不变；评分人数变化慢 → 一天一次足够
  iosMaxPerRun: 400,       // 每轮最多补多少个 iOS 条目（按 50 个/请求打包）
  iosBatchSize: 50,
  androidRefreshHours: 168, // Play 详情页太大（~1.3MB/个），一周一次
  androidMaxPerRun: 4,      // 每轮最多抓几个 Android 详情页（硬上限，别调大）
  gapMs: 300,
};

const cfgOf = (cfg) => Object.assign({}, DEFAULTS, (cfg && cfg.games && cfg.games.mobileStats) || {});

/** iTunes 商店 URL → trackId（apps.apple.com/us/app/<slug>/id1536404612） */
export function iosIdFromUrl(url) {
  const m = String(url || "").match(/\/id(\d{6,})/);
  return m ? m[1] : null;
}

/** Play 商店 URL → 包名 */
export function androidIdFromUrl(url) {
  const m = String(url || "").match(/[?&]id=([a-zA-Z0-9._]+)/);
  return m ? m[1] : null;
}

const day = (v) => (v ? String(v).slice(0, 10) : null);

/**
 * iOS 批量详情。
 * ⚠️ `country` 只影响价格/币种，**不影响 releaseDate**（实测 us/jp/kr 返回同一上线日），
 *    所以统一用条目自己的 geo，缺省 us。
 */
export async function fetchIosBatch(ids, cc = "us") {
  const url = `https://itunes.apple.com/lookup?id=${ids.join(",")}&country=${cc || "us"}`;
  const r = await fetch(url, { headers: { "user-agent": UA, accept: "application/json" }, signal: AbortSignal.timeout(25000) });
  if (!r.ok) throw new Error("HTTP " + r.status);
  const j = await r.json();
  const out = new Map();
  const now = Date.now();
  for (const x of j.results || []) {
    if (!x.trackId) continue;
    const rel = x.releaseDate ? new Date(x.releaseDate) : null;
    out.set(String(x.trackId), {
      platform: "ios",
      appid: String(x.trackId),
      name: x.trackName || null,
      // 首发日：预购 / 未上线的游戏这里是未来日期 → 留成"未发售"信号，不要当成"已上线 N 天"
      created: day(x.releaseDate),
      comingSoon: !!(rel && rel.getTime() > now),
      updated: day(x.currentVersionReleaseDate),
      // ⚠️ 价格/分类是**按该条目所在地区的商店**返回的：JP 条目会给 ¥ 与日文分类。
      //    所以带上 currency，避免清单里 "$4.99 / ¥300 / ₩6,600" 混在一起说不清口径。
      price: x.price === 0 ? "免费" : (x.formattedPrice || null),
      currency: x.currency || null,
      // 评分：**0 分 + 0 人评** 是"刚上架还没人评"，不是"口碑差" → 展示层要当未测处理
      rating: typeof x.averageUserRating === "number" ? Number(x.averageUserRating.toFixed(2)) : null,
      ratings: x.userRatingCount ?? null,      // 评分人数 ≈ 装机规模代理
      developer: x.sellerName || null,
      genres: x.genres || [],
      primaryGenre: x.primaryGenreName || null,
      minOs: x.minimumOsVersion || null,
      langCount: (x.languageCodesISO2A || []).length || null,
      fetchedAt: iso(),
    });
  }
  return out;
}

/**
 * Android 详情页（Play 没有 API，只能解析页面）。
 * 能拿到：评分 / 评分数 / 分类（JSON-LD）+ 最后更新日（"Updated on"）+ 是否有内购。
 * 拿不到（**必须标 null，不许编**）：首发日、安装量。
 */
export async function fetchAndroidDetail(pkg) {
  const url = `https://play.google.com/store/apps/details?id=${pkg}&hl=en&gl=US`;
  const r = await fetch(url, { headers: { "user-agent": UA, "accept-language": "en-US,en;q=0.9" }, signal: AbortSignal.timeout(30000) });
  if (!r.ok) throw new Error("HTTP " + r.status);
  const html = await r.text();
  const out = {
    platform: "android",
    appid: pkg,
    name: null,
    // 🛑 这两个是 Play 拿不到的字段：明确标 null + 原因，而不是留空让人误读成 0
    created: null,
    createdUnknown: "Play 详情页无首发日期（实测无 datePublished / Released on）",
    installs: null,
    installsUnknown: "Play 页面未暴露安装量",
    updated: null,
    updatedKind: "最后更新日（非首发日）",
    rating: null,
    ratings: null,
    category: null,
    iap: null,
    fetchedAt: iso(),
  };
  const ld = html.match(/<script type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/);
  if (ld) {
    try {
      const o = JSON.parse(ld[1]);
      out.name = o.name || null;
      out.category = o.applicationCategory || null;
      out.rating = o.aggregateRating?.ratingValue ? Number(Number(o.aggregateRating.ratingValue).toFixed(2)) : null;
      out.ratings = o.aggregateRating?.ratingCount ? Number(o.aggregateRating.ratingCount) : null;
    } catch { /* JSON-LD 解析失败就不填，不猜 */ }
  }
  const upd = html.match(/Updated on<\/div>\s*<div[^>]*>([A-Za-z]{3} \d{1,2}, \d{4})</);
  if (upd) out.updated = upd[1];
  out.iap = /In-app purchases/.test(html) ? true : null;
  return out;
}

/** 补一个 iOS 条目（来自缓存或批量请求结果） */
function applyIos(it, st) {
  if (!st) return false;
  keepStatsPrev(it, st.fetchedAt);   // 旧观测挪进 statsPrev → 前端可算「评分增速」
  it.stats = st;
  it.statsAt = st.fetchedAt;
  return true;
}

/**
 * 给游戏列表就地补手机端官方数据（缓存 + 每轮上限，失败保留旧值）。
 * @returns {{mode:string, ios:number, android:number, failed:number, requests:number}}
 */
export async function enrichMobileStats(items, cfg) {
  const s = cfgOf(cfg);
  if (s.enabled === false) return { mode: "off", ios: 0, android: 0, failed: 0, requests: 0 };

  const cacheFile = dataPath(cfg, ".mobile-stats-cache.json");
  const cache = readJson(cacheFile, { ios: {}, android: {} });
  cache.ios = cache.ios || {};
  cache.android = cache.android || {};
  const now = Date.now();
  const iosTtl = (s.iosRefreshHours || 24) * 3600_000;
  const andTtl = (s.androidRefreshHours || 168) * 3600_000;

  // ── 选目标：只认「来源明确是本平台」的条目（护栏 ①）──
  const iosTargets = [];
  const andTargets = [];
  for (const it of items || []) {
    if (!it) continue;
    const src = String(it.src || "");
    if (src === "appstore") {
      const id = iosIdFromUrl(it.srcUrl);
      if (!id) continue;
      const hit = cache.ios[id];
      if (hit && now - new Date(hit.fetchedAt).getTime() < iosTtl) { applyIos(it, hit); continue; }
      iosTargets.push({ it, id });
    } else if (src === "googleplay") {
      const pkg = androidIdFromUrl(it.srcUrl);
      if (!pkg) continue;
      const hit = cache.android[pkg];
      if (hit && now - new Date(hit.fetchedAt).getTime() < andTtl) { it.stats = hit; it.statsAt = hit.fetchedAt; continue; }
      andTargets.push({ it, pkg });
    }
  }

  let requests = 0;
  let failed = 0;
  let iosOk = 0;
  let andOk = 0;

  // ── iOS：批量 lookup（50 个/请求）──
  const batchSize = Math.max(1, s.iosBatchSize || 50);
  const iosCap = s.iosMaxPerRun ?? 400;
  const picked = iosTargets.slice(0, iosCap);
  for (let i = 0; i < picked.length; i += batchSize) {
    const chunk = picked.slice(i, i + batchSize);
    // 同一批次里各地区混合时，用第一个条目的地区取价格口径（上线日不受影响）
    const cc = (chunk[0].it.geo || "US").toLowerCase();
    try {
      requests++;
      const map = await fetchIosBatch(chunk.map((c) => c.id), cc);
      for (const c of chunk) {
        const st = map.get(c.id);
        if (!st) { failed++; continue; }     // lookup 里没有这个 id → 记失败，不写假数据
        cache.ios[c.id] = st;
        applyIos(c.it, st);
        iosOk++;
      }
    } catch (e) {
      failed += chunk.length;
      log("warn", `  iOS 详情批量失败（${chunk.length} 个）：${e.message}`);
    }
    await sleep(s.gapMs ?? 300);
  }

  // ── Android：逐个详情页（页面大，严格限量）──
  for (const c of andTargets.slice(0, s.androidMaxPerRun ?? 4)) {
    try {
      requests++;
      const st = await fetchAndroidDetail(c.pkg);
      if (st) {
        cache.android[c.pkg] = st;
        keepStatsPrev(c.it, st.fetchedAt);   // 旧观测挪进 statsPrev → 前端可算「评分增速」
        c.it.stats = st;
        c.it.statsAt = st.fetchedAt;
        andOk++;
      }
    } catch (e) {
      failed++;
      log("warn", `  Android 详情失败（${c.pkg}）：${e.message}`);
    }
    await sleep(s.gapMs ?? 300);
  }

  writeJson(cacheFile, { updated: iso(), ios: cache.ios, android: cache.android }, true);

  const coveredIos = (items || []).filter((x) => x.stats && x.stats.platform === "ios").length;
  const coveredAnd = (items || []).filter((x) => x.stats && x.stats.platform === "android").length;
  log("dim", `  手机端数据：iOS 刷新 ${iosOk}（覆盖 ${coveredIos}）· Android 刷新 ${andOk}（覆盖 ${coveredAnd}）· 失败 ${failed} · 请求 ${requests} 次`);
  return { mode: "on", ios: iosOk, android: andOk, failed, requests, coveredIos, coveredAnd };
}
