/**
 * Google Trends 兴趣曲线 / 相关查询层（新游戏雷达用）
 *
 * explore 只调一次，两个 widget 复用同一份 token，所以「曲线 + 相关查询」只比单取曲线多 1 个请求：
 *   1) GET /trends/api/explore                          → widgets(token)
 *   2) GET /trends/api/widgetdata/multiline?token=…      → 7 天逐小时(169 点)兴趣值
 *      GET /trends/api/widgetdata/relatedsearches?token=… → 上升 / 热门相关查询（就是可做页面的攻略词）
 */
import { log, retry, iso, sleep } from "./util.mjs";
import { UA } from "./trends.mjs";

const BASE = "https://trends.google.com/trends/api";

function headers(session, referer) {
  const h = {
    "user-agent": UA,
    "accept-language": session.hl || "en-US",
    referer,
  };
  if (session.cookie) h.cookie = session.cookie;
  return h;
}

function stripPrefix(text) {
  return JSON.parse(text.replace(/^\)\]\}',?\s*/, ""));
}

const refererOf = (keyword, geo) =>
  `https://trends.google.com/trends/explore?q=${encodeURIComponent(keyword)}&geo=${geo}`;

/**
 * 获取 explore 页的 widgets（曲线与相关查询的 token 都在这里）。
 * @param {string} [compare] 对比基准词（`config.trendsCompare`）。给了就**在同一次请求里**加第二个
 *   `comparisonItem` —— Trends 会把两条线放在**同一 0~100 尺度**上归一化，于是"这个游戏比基准词强多少"
 *   变成可读数字（各卡自己归一化时，峰值恒为 100，卡片之间根本没法比大小）。
 *   ⚠️ 代价：加了基准词之后，小词的整数取值会被压得很低（实测见 README），形状会变糙 ——
 *   所以曲线上屏的那份 `series` 仍然用**不带基准词**的请求取，基准只用于算"相对强度"。
 */
export async function explore(session, terms, geo, timeframe = "now 7-d") {
  const list = (Array.isArray(terms) ? terms : [terms]).map((t) => String(t || "").trim()).filter(Boolean);
  // 同一次请求里的多个词**共享同一 0~100 尺度** —— 这是唯一能让曲线互相比较的办法。
  // Trends 上限 5 个词，且同一个词不能出现两次（自比会报错）→ 先按小写去重再截断。
  const uniq = [];
  for (const t of list) if (!uniq.some((x) => x.toLowerCase() === t.toLowerCase())) uniq.push(t);
  if (!uniq.length) throw new Error("explore 至少需要一个关键词");
  const req = {
    comparisonItem: uniq.slice(0, 5).map((keyword) => ({ keyword, geo, time: timeframe })),
    category: 0,
    property: "",
  };
  const url = `${BASE}/explore?hl=${session.hl || "en-US"}&tz=${session.tz || "-480"}&req=${encodeURIComponent(
    JSON.stringify(req)
  )}`;
  const text = await retry(
    async () => {
      const r = await fetch(url, { headers: headers(session, refererOf(uniq[0], geo)) });
      if (r.status === 429) throw new Error("429 限流");
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.text();
    },
    // 429 是"窗口级"限流，长退避重试只是在浪费配额 —— 队列会在下一轮补上，所以只轻试 2 次
    { retries: 2, base: 3000, label: `explore/${uniq[0]}` }
  );
  return stripPrefix(text).widgets || [];
}

/** 取某个 widget 的数据（曲线或相关查询共用） */
async function fetchWidget(session, widget, path, keyword, geo, label) {
  const url = `${BASE}/widgetdata/${path}?hl=${session.hl || "en-US"}&tz=${
    session.tz || "-480"
  }&req=${encodeURIComponent(JSON.stringify(widget.request))}&token=${widget.token}`;
  const text = await retry(
    async () => {
      const r = await fetch(url, { headers: headers(session, refererOf(keyword, geo)) });
      if (r.status === 429) throw new Error("429 限流");
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.text();
    },
    // 曲线/相关查询接口限流明显更严；同样别用长退避硬刚（见上）
    { retries: 2, base: 3000, label: `${label}/${keyword}` }
  );
  return stripPrefix(text);
}

/**
 * 一次拿到：7 天曲线 + 上升相关查询 + 热门相关查询
 * @returns {Promise<null|{series:number[], points:{t:string,v:number}[], peak:number, rising:string[], top:string[]}>}
 */
export async function fetchInterest(session, keyword, geo, opts = {}) {
  const { timeframe = "now 7-d", sampleEveryHours = 4, withRelated = true, compare = "" } = opts;
  const cmpWith = String(compare || "").trim().toLowerCase() === String(keyword).trim().toLowerCase() ? "" : String(compare || "").trim();
  const widgets = await explore(session, cmpWith ? [keyword, cmpWith] : keyword, geo, timeframe);

  const ts = widgets.find((w) => w.id === "TIMESERIES");
  if (!ts) return null;

  const tsData = await fetchWidget(session, ts, "multiline", keyword, geo, "multiline");
  const raw = tsData.default?.timelineData || [];
  // 带基准词时每点有 2 个值：[0]=本词 · [1]=基准词（**同一尺度**）
  const points = raw.map((p) => ({
    t: new Date(Number(p.time) * 1000).toISOString(),
    v: Number(p.value?.[0]) || 0,
    c: cmpWith && p.value && p.value.length > 1 ? Number(p.value[1]) || 0 : null,
  }));
  const step = Math.max(1, Math.round(sampleEveryHours));
  const sampled = points.filter((_, i) => i % step === 0);
  const series = sampled.map((p) => p.v);
  const cmpSeries = cmpWith ? sampled.map((p) => p.c) : null;

  let rising = [];
  let top = [];
  const rq = withRelated ? widgets.find((w) => w.id === "RELATED_QUERIES") : null;
  if (rq) {
    try {
      const d = await fetchWidget(session, rq, "relatedsearches", keyword, geo, "related");
      const lists = d.default?.rankedList || [];
      const pick = (ranked) => (ranked?.rankedKeyword || []).map((k) => k.query).filter(Boolean);
      top = pick(lists[0]);
      rising = pick(lists[1]);
    } catch (e) {
      log("dim", `related/${keyword} 跳过: ${e.message}`);
    }
  }

  return {
    series,
    points: sampled,
    peak: series.length ? Math.max(...series) : 0,
    rising,
    top,
    cmpSeries,                                        // 与 series **同尺度**的基准词曲线（没要基准时为 null）
    compareWith: cmpWith,
  };
}

/** 单独取相关查询（备用入口） */
export async function fetchRelatedQueries(session, keyword, geo, timeframe = "now 7-d") {
  const widgets = await explore(session, keyword, geo, timeframe);
  const rq = widgets.find((x) => x.id === "RELATED_QUERIES");
  if (!rq) return { top: [], rising: [] };
  try {
    const d = await fetchWidget(session, rq, "relatedsearches", keyword, geo, "related");
    const lists = d.default?.rankedList || [];
    const pick = (ranked) => (ranked?.rankedKeyword || []).map((k) => k.query).filter(Boolean);
    return { top: pick(lists[0]), rising: pick(lists[1]) };
  } catch (e) {
    log("dim", `related/${keyword} 跳过: ${e.message}`);
    return { top: [], rising: [] };
  }
}

/**
 * **同尺度批量对比**：一次请求里放最多 5 个词（Trends 上限），它们的曲线共享同一 0~100 尺度，
 * 于是既能算"这个词相对基准词多强"，也能算"同组几个游戏谁更强"。
 *
 * 成本：1 次 explore + 1 次 multiline（**不论比较几个词**）→ 按组算远比逐词算便宜（逐词是 2 次/词）。
 *
 * 🛑 只能拿它算**比值**，不能当显示曲线：加了基准词之后小词的整数取值会被压得很粗
 * （实测 `Slime Out Fish` 全程只有 3 个不同取值：0 / 1 / 73）→ 曲线形状会糊掉。
 * 所以曲线上屏的那份仍然用不带基准词的请求取（见 fetchInterest），基准只负责"可比性"。
 *
 * @param {string[]} terms 2~5 个词（约定最后一个放基准词，但函数不做强制）
 */
export async function fetchCompareGroup(session, terms, geo, opts = {}) {
  const { timeframe = "now 7-d", sampleEveryHours = 4 } = opts;
  const list = (terms || []).map((t) => String(t || "").trim()).filter(Boolean).slice(0, 5);
  if (list.length < 2) throw new Error("对比至少需要 2 个词");
  const widgets = await explore(session, list, geo, timeframe);
  const ts = widgets.find((w) => w.id === "TIMESERIES");
  if (!ts) throw new Error("没有 TIMESERIES widget");
  const label = "compare/" + list.join("|");
  const tsData = await fetchWidget(session, ts, "multiline", label, geo, label);
  const raw = tsData.default?.timelineData || [];
  if (!raw.length) throw new Error("曲线为空");
  // 每个时间点应当返回与请求**同数**的列；列数不符说明有的词没数据 → 直接算失败（不猜、不写缓存）
  const cols = (raw[0].value || []).length;
  if (cols !== list.length) throw new Error(`列数不符（要 ${list.length} 列，返回 ${cols} 列）`);
  const step = Math.max(1, Math.round(sampleEveryHours));
  const sampled = raw.filter((_, i) => i % step === 0);
  const seriesByTerm = {};
  list.forEach((t, k) => { seriesByTerm[t] = sampled.map((p) => Number((p.value || [])[k]) || 0); });
  // `hasData[k]` 是 Google 自己给的"这个词这个点有没有可报告的量"标记（实测每个点都有）。
  // 用途：区分两种 0 —— ① 有数据但低于取整下限 ② 整个窗口根本没有数据（实测 Fishing Inc 全 169 点都是 false）。
  const hasDataByTerm = {};
  list.forEach((t, k) => {
    const flags = sampled.map((p) => (p.hasData ? p.hasData[k] : undefined));
    hasDataByTerm[t] = flags.some((x) => x === true) ? true
      : flags.every((x) => x === undefined) ? null
        : false;
  });
  return { geo, timeframe, terms: list, seriesByTerm, hasDataByTerm };
}

const peakOf = (a) => (a && a.length ? Math.max(...a) : 0);
const avgOf = (a) => (a && a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);

/**
 * **小基准刻度**（2026-09-25 新增）：候选 + 小量级参照词放进**同一次** Trends 请求，
 * 回答「这个小游戏到底有没有可行情」—— 替代已停用的 GPTs 基准（它太大，2/3 条目被取整成 0）。
 *
 * 判读（🛑 与「未测」严格分开）：
 *   · 参照词在本组尺度有数据、候选峰值 **< 参照峰值** → `g.baseline.floor = true`
 *     → 前端判「需求低于最小参照」—— 连最小可行情都够不到，几乎确定没法做（用户口径）。
 *   · 候选峰值 ≥ 参照峰值 → 有量（大小看 ratio），不设硬结论。
 *   · 参照词本身无数据 → 本组**作废**（不写缓存，保持未测）—— 绝不编比值（负缓存禁令）。
 *
 * 只测「没有平台需求口径」的条目（itch / poki / crazygames / 热搜候选）——
 * 有 visits / ratings / reviews 的走「绝对需求地板」（那更准），不在这里重复花配额。
 *
 * ⚠️ 参照词（`games.baseline.refs`，默认 gimkit / blooket）是**启动假设**：
 *    两个教育游戏品牌，量级远小于 GPTs、又确有"养得起攻略站"的持续需求。
 *    跑两周后必须按成功/失败样本重标定（见 README 校准流程），别把默认值当真理。
 *
 * 有界：每轮 `maxPerRun`（默认 8）· 按来源公平抽样（pickFairShare）· 成功缓存 `ttlDays`（默认 7）·
 *       连续 `rateLimitStop`（默认 2）组限流即本轮收工。
 */
export async function enrichBaseline(items, session, cfg) {
  const g = (cfg && cfg.games) || {};
  const c = Object.assign(
    { enabled: true, maxPerRun: 8, ttlDays: 7, gapMs: 2500, rateLimitStop: 2, refs: ["gimkit", "blooket"] },
    g.baseline || {}
  );
  const out = { groups: 0, ok: 0, floor: 0, failed: 0, cached: 0, skipped: 0, eligible: 0, limited: 0 };
  if (!c.enabled || !session) return out;
  const refs = (Array.isArray(c.refs) ? c.refs : []).map((x) => String(x || "").trim()).filter(Boolean).slice(0, 2);
  if (!refs.length) return out;

  const now = Date.now();
  const ttl = (c.ttlDays || 7) * 86400000;
  const geoDefault = (g.geos || ["US"])[0];

  const todo = [];
  for (const it of items || []) {
    if (!it || !it.name) continue;
    // 有平台需求口径的条目走「绝对需求地板」（更准），不在这里花配额
    if (it.stats && (it.stats.visits != null || it.stats.platform === "steam" ||
        it.stats.platform === "ios" || it.stats.platform === "android")) continue;
    if (it.baseline && it.baseline.at && now - new Date(it.baseline.at).getTime() < ttl) { out.cached++; continue; }
    todo.push(it);
  }
  todo.sort((a, b) => (b.score || 0) - (a.score || 0));
  const picked = pickFairShare(todo, c.maxPerRun || 8);
  out.eligible = todo.length + out.cached;
  out.skipped = todo.length - picked.length;

  const slot = Math.max(1, 5 - refs.length);            // Trends 上限 5 词：候选 + 参照
  for (let i = 0; i < picked.length; i += slot) {
    const group = picked.slice(i, i + slot);
    const names = group.map((x) => String(x.name).trim());
    const geo = group[0].chart_geo || geoDefault;
    out.groups++;
    try {
      const d = await fetchCompareGroup(session, names.concat(refs), geo, {
        timeframe: g.timeframe || "now 7-d",
        sampleEveryHours: g.sampleEveryHours || 4,
      });
      const measurable = (term) => {
        const peak = peakOf(d.seriesByTerm[term] || []);
        const has = d.hasDataByTerm ? d.hasDataByTerm[term] : undefined;
        return (peak > 0 || has === true) ? peak : null;
      };
      const refPeaks = refs.map(measurable);
      const floorPeak = Math.min(...refPeaks.filter((v) => v != null));
      if (floorPeak == null || !isFinite(floorPeak)) {
        // 参照词全部无数据 → 本组作废（不写缓存，保持未测）
        out.failed += group.length;
        log("dim", `    小基准（${geo}）：参照词 ${refs.join("/")} 在本组尺度无数据 → 本组作废（不写缓存，保持未测）`);
      } else {
        const parts = [];
        for (const it of group) {
          const term = String(it.name).trim();
          const termPeak = peakOf(d.seriesByTerm[term] || []);
          const termHas = d.hasDataByTerm ? d.hasDataByTerm[term] : undefined;
          const measurableTerm = termPeak > 0 || termHas === true;
          const below = !measurableTerm || termPeak < floorPeak;
          it.baseline = {
            at: iso(), geo, refs, refPeaks, floorPeak, termPeak,
            termHasData: termHas ?? null,
            ratio: measurableTerm ? Number((termPeak / floorPeak).toFixed(3)) : null,
            floor: below,
          };
          if (below) out.floor++; else out.ok++;
          parts.push((measurableTerm ? termPeak + "/" + floorPeak : "无数据") + " " + term);
        }
        log("dim", `    小基准（${geo}·参照 ${refs.join("/")} 峰值 ${floorPeak}）：${parts.join(" · ")}`);
        out.limited = 0;
      }
    } catch (e) {
      out.failed += group.length;
      const limited = /429/.test(String(e.message));
      if (limited) out.limited++;
      log("warn", `    小基准取数失败（${names.join(" / ")}）：${e.message} —— 不写缓存，保持「未测」`);
      if (limited && out.limited >= (c.rateLimitStop || 2)) {
        log("warn", `    小基准连续 ${out.limited} 组限流 → 本轮提前结束（剩余留给下一轮）`);
        break;
      }
    }
    await sleep(c.gapMs || 2500);
  }
  return out;
}

/**
 * 按来源**公平抽样**（`enrichCompare` / `enrichCurveRefresh` 共用）。
 *
 * 🛑 为什么不能只按分数排序取前 N：实测"纯分数排序"会把 Roblox 饿死 ——
 *    它有 119 条曲线、只被抽到 5 条（4.2%），而同期的 itch/poki 都在 28%+，
 *    因为 Roblox 条目分数普遍偏低、数量却最多。和 `queue.mjs` 的 fairShare 同一个道理：
 *    想让"每个来源都被轮到"，就得让来源轮着来。
 */
function pickFairShare(sorted, max) {
  const bySrc = new Map();
  for (const g of sorted) {
    const k = g.src || "(heat)";
    if (!bySrc.has(k)) bySrc.set(k, []);
    bySrc.get(k).push(g);
  }
  const cursors = new Map(Array.from(bySrc.keys()).map((k) => [k, 0]));
  const out = [];
  while (out.length < max) {
    let advanced = false;
    for (const k of bySrc.keys()) {
      if (out.length >= max) break;
      const arr = bySrc.get(k), i = cursors.get(k);
      if (i >= arr.length) continue;
      cursors.set(k, i + 1);
      out.push(arr[i]);
      advanced = true;
    }
    if (!advanced) break;                                  // 所有来源都取完了
  }
  return out;
}

/**
 * 给雷达条目加"相对基准词的强度"（写入 `g.cmp`）—— 页面上一眼可比的那一行就是它。
 * ⛔ 已停用（2026-09-24 同日回退）：实测 2/3 命中 0，0 里混着"已经凉了"与"基准太大取整"两类，
 * 当否决用会大面积错杀。原因与重启要点见 `web/app.js` 顶部的回退记录与 README。
 *
 * 为什么必须有：每张卡的迷你曲线是**按自己峰值归一化**的（`sparkSvg` 用自己的 min/max），
 * 峰值恒为 100 → **卡片高度互相不可比**（小词的平线会被拉得和大词一样高）。
 * 要"一目了然"地比大小，就必须有一条共同尺度，而这只能由 Trends 在同一次请求里给出。
 *
 * 有界：每轮最多 `maxPerRun` 个（默认 8），按 `batch`（默认 4）分组 + 基准词 = 最多 5 个一组；
 * 成功后挂在条目上（`g.cmp.at`），`ttlDays` 内不重测 —— 不另开缓存文件。
 * 失败（429 / 列数不符 / 无曲线）一律**不写** `g.cmp`，页面显示「未测」，绝不编一个比值。
 */
export async function enrichCompare(items, session, cfg) {
  const g = (cfg && cfg.games) || {};
  const c = Object.assign(
    { enabled: true, batch: 4, maxPerRun: 40, ttlDays: 7, gapMs: 2500, rateLimitStop: 2 },
    g.compareYardstick || {}
  );
  // `measured` / `eligible` 是给日志和页面看"覆盖率"的：可测 = 有曲线且有量、又不是基准词自己
  const out = { batches: 0, ok: 0, failed: 0, cached: 0, skipped: 0, limited: 0, measured: 0, eligible: 0 };
  // 基准词**只有一处事实源**：`config.trendsCompare`（页面上「查看趋势（vs XXX）」用的也是它）。
  // compareYardstick.baseline 只在需要临时换个基准时才写。
  const base = String(c.baseline || (cfg && cfg.trendsCompare) || "").trim();
  if (!c.enabled || !session || !base) return out;

  const now = Date.now();
  const ttl = (c.ttlDays || 7) * 86400000;
  const geoDefault = (g.geos || ["US"])[0];

  const todo = [];
  for (const it of items || []) {
    if (!it || !it.name) continue;
    if ((it.series || []).length < 2) continue;                       // 没曲线 → 比不了，也不该为它花请求
    // 曲线全是 0 = 这 7 天基本没量（自己的峰值归一化会把它画得很好看）→ 花请求去比也没意义
    if (!(it.series || []).some((v) => Number(v) > 0)) continue;
    const name = String(it.name).trim();
    if (name.toLowerCase() === base.toLowerCase()) continue;          // 自比无意义
    if (it.cmp && it.cmp.at && now - new Date(it.cmp.at).getTime() < ttl) { out.cached++; continue; }
    todo.push(it);
  }
  todo.sort((a, b) => (b.score || 0) - (a.score || 0));
  const picked = pickFairShare(todo, c.maxPerRun || 40);
  out.skipped = todo.length - picked.length;
  out.eligible = todo.length + out.cached;

  const size = Math.max(1, Math.min(4, c.batch || 4));                // 4 个候选 + 基准 = 5（Trends 上限）
  for (let i = 0; i < picked.length; i += size) {
    const group = picked.slice(i, i + size);
    const names = group.map((x) => String(x.name).trim());
    const geo = group[0].chart_geo || geoDefault;
    out.batches++;
    try {
      const d = await fetchCompareGroup(session, names.concat(base), geo, {
        timeframe: g.timeframe || "now 7-d",
        sampleEveryHours: g.sampleEveryHours || 4,
      });
      const baseSeries = d.seriesByTerm[base] || [];
      const basePeak = peakOf(baseSeries);
      const baseAvg = avgOf(baseSeries);
      const groupPeak = Math.max(basePeak, ...names.map((n) => peakOf(d.seriesByTerm[n] || [])));
      const parts = [];
      for (const it of group) {
        const s = d.seriesByTerm[String(it.name).trim()] || [];
        const termPeak = peakOf(s);
        const termAvg = avgOf(s);
        it.cmp = {
          at: iso(), with: base, geo,
          termPeak, basePeak, groupPeak, points: s.length,
          // 峰值比 / 周均比：**两者都留**——新词常是"一次尖峰 + 平时为 0"，只报一个会误导
          ratioPeak: basePeak > 0 ? Number((termPeak / basePeak).toFixed(3)) : null,
          ratioAvg: baseAvg > 0 ? Number((termAvg / baseAvg).toFixed(3)) : null,
          // 这个词在本组共享尺度上到底有没有可报告的量（Google 的 hasData）
          termHasData: d.hasDataByTerm[String(it.name).trim()] ?? null,
          // 基准整列被取整成 0 = 量级差太大 → 比值不可测（如实标，不编数）
          note: basePeak > 0 ? "" : "基准词在本组尺度上取整为 0（量级差太大）→ 比值不可测",
        };
        out.ok++;
        parts.push((it.cmp.ratioPeak == null ? "不可测" : it.cmp.ratioPeak + "×") + " " + it.name);
      }
      log("dim", `    vs ${base}（${geo}）：${parts.join(" · ")}`);
      out.limited = 0;                                      // 成功即清零"连续限流"计数
    } catch (e) {
      out.failed += group.length;
      const limited = /429/.test(String(e.message));
      if (limited) out.limited++;
      log("warn", `    vs ${base} 取数失败（${names.join(" / ")}）：${e.message} —— 不写缓存，保持「未测」`);
      // 🛑 连续限流就本轮提前收工（和曲线循环同一策略）：继续打只是浪费配额，还会把自己打进更长的封禁。
      //    剩下的候选留在下一轮 —— 覆盖率是靠"每轮都补一点"慢慢铺满的，不是靠一轮硬刚。
      if (limited && out.limited >= (c.rateLimitStop || 2)) {
        log("warn", `    vs ${base} 连续 ${out.limited} 组限流 → 本轮提前结束（剩余 ${picked.length - i - group.length} 个留给下一轮）`);
        break;
      }
    }
    await sleep(c.gapMs || 2500);
  }
  out.measured = out.cached + out.ok;
  return out;
}

/**
 * **曲线保鲜**（2026-09-24 新增）：重取"有曲线"条目的曲线，让卡片别再挂着过期快照。
 *
 * 为什么需要：卡片的曲线是**发现那一刻的快照**（`chart_at`），之后从不更新 ——
 * 于是一个 5 天前爆过、现在已经没人搜的游戏，卡片上还挂着那条漂亮曲线。
 * 更糟的是它会**顶着一个高分留在推荐页**（分数用的是旧曲线推出来的动能）。
 *
 * 判定"转凉"的口径（**必须与"取数失败"严格分开**）：
 *   · 请求成功、但曲线为空 / 全为 0  → `coolStreak++`；连续 `coolStreak` 次（默认 2）→ 标 `cooled: true`
 *   · 请求成功且有量             → 覆盖 `series / points / peak / hype / chart_at`，并清零 `coolStreak`、
 *                                  若原先标了 `cooled` 就**撤掉**（复活）
 *   · 请求失败（429 / 结构异常）  → **什么都不改**（保持原曲线、不累加 `coolStreak`）——
 *                                  限流不等于"这游戏凉了"，这是本项目一贯的负缓存禁令
 * 有界：每轮最多 `maxPerRun`（默认 10）、间隔 `gapMs`、连续 `rateLimitStop` 次限流即本轮收工；
 *       只取曲线（`withRelated: false`）→ 每条 2 次请求。
 *
 * 📌 待验证的改进（今天配额已被打满，没法测）：同一次请求里放**同一个词的 7 天 + 28 天两个窗口**
 *    （`comparisonItem` 里同一 keyword 不同 time），若可行则一次拿到"新鲜曲线 + 真实衰减"，
 *    比现在只看"有没有量"更灵敏。验证脚本思路：看 multiline 是否返回 2 列。
 */
export async function enrichCurveRefresh(items, session, cfg) {
  const g = (cfg && cfg.games) || {};
  const c = Object.assign(
    { enabled: true, hours: 48, maxPerRun: 10, gapMs: 2500, rateLimitStop: 2, coolStreak: 2 },
    g.curveRefresh || {}
  );
  const out = { tested: 0, ok: 0, failed: 0, limited: 0, cooled: 0, skipped: 0, eligible: 0 };
  if (!c.enabled || !session) return out;

  const now = Date.now();
  const maxAge = (c.hours || 48) * 3600000;
  const geoDefault = (g.geos || ["US"])[0];

  const todo = [];
  for (const it of items || []) {
    if (!it || !it.name) continue;
    if ((it.series || []).length < 2) continue;                       // 没曲线 → 不归这条通道管
    const at = it.chart_at || it.first;
    if (at && now - new Date(at).getTime() < maxAge) continue;        // 快照还新鲜
    todo.push(it);
  }
  // 最旧的快照优先（它们最可能是"过期的漂亮曲线"）；同级按分数
  todo.sort((a, b) => new Date(a.chart_at || a.first) - new Date(b.chart_at || b.first)
    || (b.score || 0) - (a.score || 0));
  const picked = pickFairShare(todo, c.maxPerRun || 10);
  out.eligible = todo.length;
  out.skipped = todo.length - picked.length;

  for (const it of picked) {
    out.tested++;
    try {
      const d = await fetchInterest(session, it.name, it.chart_geo || geoDefault, {
        timeframe: g.timeframe || "now 7-d",
        sampleEveryHours: g.sampleEveryHours || 4,
        withRelated: false,                                            // 只保鲜曲线，不重取相关词（省一半请求）
      });
      const series = (d && d.series) || [];
      const alive = series.length >= 2 && series.some((v) => Number(v) > 0);
      if (!alive) {
        it.coolStreak = (it.coolStreak || 0) + 1;
        it.cooled_at = iso();
        it.cool_geo = it.chart_geo || geoDefault;
        if (it.coolStreak >= (c.coolStreak || 2)) it.cooled = true;
        out.cooled++;
        log("dim", `    ❄️ ${it.name}：重取无数据（连续 ${it.coolStreak} 次）${it.cooled ? " → 标记「已转凉」" : "（还差 1 次）"}`);
      } else {
        it.series = series;
        if (d.points && d.points.length) it.points = d.points;
        it.peak = d.peak;
        it.hype = hypeRatio(series);                                   // 动能随新曲线更新。
        // 🛑 注意：`score` **不**随保鲜重算 —— 它的 vol/growth/weight 输入是发现时刻的快照，
        //    条目上没有存，硬算会失真。score 语义 = 「发现那一刻的验证优先级」（前端排序标签同此口径）。
        it.chart_at = iso();
        it.chart_geo = it.chart_geo || geoDefault;
        it.coolStreak = 0;
        if (it.cooled) { delete it.cooled; delete it.cooled_at; }       // 有量就复活：撤掉标记
        out.ok++;
      }
    } catch (e) {
      out.failed++;
      const limited = /429|限流/.test(String(e.message));
      if (limited) out.limited++;
      log("warn", `    ❄️ ${it.name} 曲线保鲜失败（**保持原样，不算转凉**）：${e.message}`);
      if (limited && out.limited >= (c.rateLimitStop || 2)) {
        log("warn", `    连续 ${out.limited} 次限流 → 本轮保鲜提前结束（剩余留给下一轮）`);
        break;
      }
    }
    await sleep(c.gapMs || 2500);
  }
  return out;
}

/** 判断曲线是否为"新近起飞"：后半段均值显著高于前半段 */
export function hypeRatio(series) {
  if (!series || series.length < 8) return 0;
  const mid = Math.floor(series.length / 2);
  const first = series.slice(0, mid);
  const last = series.slice(mid);
  const avg = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
  const f = avg(first);
  const l = avg(last);
  if (f <= 0.5 && l > 0) return 99; // 从零起步 = 全新
  return f > 0 ? Number((l / f).toFixed(2)) : 0;
}
