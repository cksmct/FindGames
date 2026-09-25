#!/usr/bin/env node
/**
 * 采集主流程（建议每小时跑一次）
 *
 *   1. 拉取 N 个国家的 Google Trends 实时上升热搜
 *   2. 标注噪音 / 命中监控词 / 判定是否新词
 *   3. 合并进 7 天留档（峰值合并 + 分片输出）
 *   4. 新游戏雷达：识别游戏候选 → 拉 7 天兴趣曲线 → 打分
 *   5. 聚合关键词池（相关搜索词）
 *
 * 用法:
 *   node src/collect.mjs                         全量
 *   node src/collect.mjs --geos US,GB,JP         指定国家
 *   node src/collect.mjs --no-games              跳过游戏雷达
 *   node src/collect.mjs --only-games            只跑游戏雷达
 */
import path from "node:path";
import { loadConfig, parseArgs, log, iso, sleep, pMap, readJson, writeJson, dataPath } from "./lib/util.mjs";
import { createSession, collectGeo } from "./lib/trends.mjs";
import { fetchInterest, hypeRatio, enrichCompare, enrichCurveRefresh } from "./lib/interest.mjs";
import {
  noiseLabel, gameCandidate, scoreKeyword, matchWatch, tokensOf, relevantTo,
  feedbackVerdict, FEEDBACK_BOOST_PTS, SCORE_RULES,
} from "./lib/detect.mjs";
import { judgeCandidates } from "./lib/judge.mjs";
import {
  loadHistory, mergeHistory, writeHistory, writeTrends,
  loadGames, writeGames, readState, writeState,
} from "./lib/store.mjs";
import { buildKeywordPool } from "./lib/pool.mjs";
import { translateToZh } from "./lib/translate.mjs";
import { collectSourceCandidates } from "./lib/sources.mjs";
import { enrichGameStats } from "./lib/roblox.mjs";
import { enrichSteamStats } from "./lib/steam.mjs";
import { enrichMobileStats } from "./lib/mobile.mjs";
import { enrichSerpComp, SERP_RULES } from "./lib/serp.mjs";
import { pushQueue, peekQueue, dropQueue, loadQueue } from "./lib/queue.mjs";
import { buildWatchlist } from "./lib/watchlist.mjs";

const t0 = Date.now();
const args = parseArgs();
const cfg = loadConfig();

if (args.geos) cfg.geos = String(args.geos).split(",").map((s) => s.trim()).filter(Boolean);
if (args["no-games"]) cfg.games.enabled = false;
if (args["only-games"]) { cfg._onlyGames = true; cfg.games.enabled = true; }
if (args.translate) cfg.translate = true;
if (args.minvol) cfg.minVol = Number(args.minvol);
if (args["max-curves"]) cfg.games.maxCurvesPerRun = Number(args["max-curves"]);
if (args["no-sources"]) cfg.games.sources = { roblox: false, steam: false, appstore: false, googleplay: false, itch: false, poki: false, crazygames: false };
if (args["no-watchlist"]) cfg.watchlist = { ...(cfg.watchlist || {}), enabled: false };
if (args["only-watchlist"]) cfg._onlyWatchlist = true;
// 把浏览器里另存的 BloxInformer 页面直接喂进来（无视保鲜期检查，因为是你刚存的）
if (args["roblox-html"]) cfg._robloxHtmlPath = path.resolve(String(args["roblox-html"]));

const session = await createSession();
log("info", `会话就绪 ${session.cookie ? "(已获取 cookie)" : "(无 cookie)"}`);

// ── 0. 潜伏清单（未发售 / 刚起量）──
// 刻意放在热搜采集【之前】：它不依赖 Google Trends（默认零配额），
// 所以哪怕热搜被限流到本轮中止，潜伏清单也已经写好了 —— 这是"必须能看到"的那份数据。
if (cfg.watchlist?.enabled !== false) {
  try {
    const wl = await buildWatchlist(cfg, session);
    if (wl) {
      const wn = Object.entries(wl.stats.windows || {}).map(([k, v]) => `${k}:${v}`).join(" ");
      log("ok", `潜伏清单：共 ${wl.stats.total} 条（Steam ${wl.stats.steam} / Roblox ${wl.stats.roblox} / iOS 新上架 ${wl.stats.appstore || 0}）${wn ? " · 窗口 " + wn : ""} · Trends 检查 ${wl.stats.trendsChecked}`);
      for (const n of wl.notes.slice(0, 3)) log("dim", `  ${n}`);
    }
  } catch (e) {
    log("warn", `潜伏清单生成失败：${e.message}（不影响其它环节）`);
  }
}

if (cfg._onlyWatchlist) {
  log("ok", `仅潜伏清单模式，完成。用时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  process.exit(0);
}

// ── 1. 采集热搜 ──
let fresh = [];
const failures = [];
const gameKw = []; // 游戏雷达挖出的攻略词，最后汇入关键词池

if (!cfg._onlyGames) {
  log("info", `开始采集 ${cfg.geos.length} 个国家的实时上升热搜…`);
  const results = await pMap(
    cfg.geos,
    async (geo) => {
      await sleep(Math.random() * (cfg.delayMs || 500));
      try {
        const items = await collectGeo(session, geo, {
          minVol: cfg.minVol || 0,
          maxRelated: cfg.maxRelated || 6,
          hours: cfg.hours || 24,
        });
        process.stdout.write(`\r  ${geo} ${items.length} 条      `);
        return { geo, items };
      } catch (e) {
        failures.push(`${geo}: ${e.message}`);
        return { geo, items: [] };
      }
    },
    cfg.concurrency || 3
  );
  process.stdout.write("\r" + " ".repeat(40) + "\r");

  const byGeo = {};
  for (const r of results) {
    byGeo[r.geo] = r.items.map((it) => ({
      ...it,
      geo: r.geo,
      noise: noiseLabel(it.q, it.cats),
      watch: matchWatch(it.q, cfg.watch),
    }));
    fresh.push(...byGeo[r.geo]);
  }
  log("ok", `采集完成：${Object.values(byGeo).reduce((a, b) => a + b.length, 0)} 条热搜`);
  if (failures.length) log("warn", `失败 ${failures.length} 个地区：${failures.slice(0, 5).join("; ")}`);
  if (fresh.length === 0) {
    log("err", "本轮抓到 0 条：疑似被限流或接口已变动。中止写入，避免用空数据覆盖既有留档。");
    process.exit(1);
  }
  cfg._byGeo = byGeo;
} else {
  // --only-games：不重新抓热搜，沿用上一轮 trends.json 作为候选来源
  const t = readJson(dataPath(cfg, "trends.json"));
  for (const [geo, arr] of Object.entries(t?.items || {})) {
    for (const it of arr) {
      fresh.push({ ...it, geo, noise: noiseLabel(it.q, it.cats), watch: matchWatch(it.q, cfg.watch) });
    }
  }
  log("info", `仅游戏雷达模式：沿用上一轮 trends.json 的 ${fresh.length} 条作为候选来源`);
}

// ── 2. 合并历史 & 输出 ──
const hist = loadHistory(cfg);
log("info", `载入历史留档 ${hist.items.length} 条`);

let newKeys = new Set();
if (!cfg._onlyGames) {
  const merged = mergeHistory(hist.items, fresh, cfg);
  newKeys = merged.newKeys;
  const chunks = writeHistory(cfg, merged.items);
  log("ok", `历史留档更新：${merged.stats.total} 条（新增 ${merged.stats.added}，过期清理 ${merged.stats.pruned}，分 ${chunks} 片）`);

  // 新词标记 + 翻译
  for (const it of fresh) it.new = newKeys.has(`${it.geo}|${it.q}`);
  if (cfg.translate) {
    const uniq = Array.from(new Set(fresh.map((i) => i.q).filter(Boolean))).slice(0, 400);
    const map = new Map();
    await pMap(uniq, async (q) => { map.set(q, await translateToZh(q)); }, 4);
    for (const it of fresh) it.zh = map.get(it.q) || "";
  }

  // trends.json：按地区分组，组内按搜索量降序
  const items = {};
  for (const geo of cfg.geos) {
    const arr = (cfg._byGeo[geo] || []).slice().sort((a, b) => (b.vol || 0) - (a.vol || 0));
    // 相关词不进 trends.json（体积考虑），统一放 keywords.json 词池
    items[geo] = arr.map((it) => ({
      q: it.q, vol: it.vol, growth: it.growth, cats: it.cats, noise: it.noise,
      ...(it.new ? { new: 1 } : {}),
      ...(it.watch?.length ? { watch: it.watch } : {}),
      ...(it.zh ? { zh: it.zh } : {}),
    }));
  }
  writeTrends(cfg, {
    updated: iso(),
    geos: cfg.geos,
    cats: cfg.catLabels || {},
    items,
    compareWith: cfg.trendsCompare || "",
    // 看板点"查看趋势"时 geo 的缺省值（"全部地区"视图用）。缺 geo 会退回全球口径，
    // 与"从某个地区榜单点进来"的上下文不符，所以必须给一个确定值。
    defaultGeo: cfg.trendsDefaultGeo || "US",
  });
  log("ok", `输出 data/trends.json`);

  // 向前端发布一份【脱敏】的 config.json：
  //  ① 只放"只影响界面"的字段 —— 看板改 trendsCompare / trendsDefaultGeo 能立刻生效，不必等下一轮采集
  //  ② 🛑 绝不能整份 config.json 直接发布：judge.apiKey 这类字段一旦被写进配置，
  //     会随静态站点公开（工作流原先是 `cp config.json dist/data/config.json`，有泄漏风险）。
  //     白名单制而不是黑名单制 —— 以后新增敏感字段也不会误发。
  const PUBLIC_CFG = ["trendsCompare", "trendsDefaultGeo", "watch", "geos", "catLabels", "geoLabels", "feedback"];
  const publicCfg = {};
  for (const k of PUBLIC_CFG) if (cfg[k] !== undefined) publicCfg[k] = cfg[k];
  // 竞争强度的人工判断（专用 wiki / 专业站抢首发这类信息只能人查，自动抓不到）。
  // 单独透出给看板的「🎯 建站推荐」用 —— 否则那页会把竞争饱和的游戏排在第一位。
  if (cfg.games?.competition) publicCfg.competition = cfg.games.competition;
  writeJson(dataPath(cfg, "config.json"), publicCfg);
}

// ── 3. 新游戏雷达 ──
if (cfg.games.enabled) {
  const gamesDoc = loadGames(cfg);
  const known = new Map(gamesDoc.items.map((g) => [g.name.toLowerCase(), g]));
  const prefGeos = new Set(cfg.games.geos || []);
  const refreshMs = (cfg.games.refreshHours || 6) * 3600_000;
  // 默认只收拉丁字母名（做英文站的推荐配置）；config 里显式写 false 才放开
  const latinOnly = cfg.games.latinOnly !== false;

  // 候选：来自本轮热搜
  // 同一个游戏常常同时出现在多个国家的榜单上，必须按游戏名去重，
  // 否则会给同一个游戏重复取多次曲线（白白多耗配额、更容易被限流）
  const candMap = new Map();
  // 分层门槛：低量区必须有多重识别信号
  const lowBelow = cfg.games.strongSignal?.belowVol ?? 1000;
  const lowMinWeight = cfg.games.strongSignal?.minWeight ?? 3;

  const excludeAAA = cfg.games.excludeAAA === true;

  for (const it of fresh) {
    if (it.noise) continue;
    // 你的明确判断优先于任何启发式规则：feedback.block 里的词直接不进雷达
    if (feedbackVerdict(it.q, cfg.feedback) === "block") continue;
    const vol = it.vol || 0;
    if (vol < (cfg.games.minVol ?? 0)) continue;
    const gc = gameCandidate(it, { latinOnly, excludeAAA });
    if (!gc.ok) continue;
    // 低量区（刚冒头的新游戏就在这里）只放行"强信号"候选：
    // 实测 32 个 vol<1000 的候选里，权重≥3 的全是真游戏；
    // 而人名类噪音（bill skarsgård / don lee / truls möregårdh）全部落在权重=2。
    // 所以"权重"比"搜索量"更能区分"早期真游戏"和"低量噪音"。
    if (vol < lowBelow && gc.weight < lowMinWeight) continue;
    const key = it.q.toLowerCase();
    const cur = known.get(key);
    // 曲线与「攻略词」必须分别判新鲜度。
    // 只看 chart_at 会出现这个坑：曲线刚取过但当时还没写词（或当时取词失败），
    // 该游戏就会被整个跳过 6 小时，词永远补不上。所以单独记 related_at。
    const ageOf = (t) => (t ? Date.now() - new Date(t).getTime() : Infinity);
    const chartFresh = ageOf(cur?.chart_at) < refreshMs;
    const relatedFresh = cur?.related_at
      ? ageOf(cur.related_at) < refreshMs
      : (cur?.words?.length || 0) > 0; // 旧数据没有 related_at：已有词就当新鲜，没有就得补
    if (chartFresh && relatedFresh) continue; // 两者都新，本轮跳过
    const cand = {
      ...it,
      weight: gc.weight,
      reason: gc.reason,
      tracked: !!cur,
      needRelated: !relatedFresh,
    };
    const prev = candMap.get(key);
    if (!prev) { candMap.set(key, cand); continue; }
    const better =
      (prefGeos.has(cand.geo) ? 1 : 0) - (prefGeos.has(prev.geo) ? 1 : 0) ||
      (cand.vol || 0) - (prev.vol || 0);
    if (better > 0) candMap.set(key, cand);
  }
  // ── 多源候选：原站真正的 intake ──
  // 实测（2026-09-20）：原站的游戏来自"游戏目录"——Roblox Discover 榜单与 Steam 商店榜单，
  // 逐个名字都能对上；而它自己发布的 7 天热搜留档只覆盖其游戏列表的 14/404。
  // 所以这里把来源候选入队，再由曲线配额逐个做"热度验证"，通过才进雷达。
  const src = await collectSourceCandidates(cfg);
  let queued = { added: 0, total: 0, seen: [] };
  if (src.length) {
    queued = pushQueue(cfg, src, new Set([...candMap.keys(), ...known.keys()]));
    log("info", `来源候选 ${src.length} 个 → 入队新增 ${queued.added} 个（队列 ${queued.total}）`);
  }
  // 来源里再次出现 = "最新信号"：刷新 last / sightings（原站卡片上的 ×N）
  const srcSeen = new Set(queued.seen);
  if (srcSeen.size) {
    let bumped = 0;
    for (const g of known.values()) {
      if (!g.src) continue;
      if (!srcSeen.has(String(g.name).toLowerCase())) continue;
      g.last = iso();
      g.sightings = (g.sightings || 1) + 1;
      bumped++;
    }
    if (bumped) log("dim", `  来源重申 ${bumped} 个已追踪游戏，刷新 last/sightings`);
  }
  // ── 目录直收（2026-09-24 实测标定后新增）──
  //
  // 🛑 标定结果（24 个队列候选，来源混合、间隔 3s）：
  //    有曲线 4 个 · **无曲线数据 20 个（83%）** · 429 只碰到 1 次瞬时（重试即成功）。
  //    → 队列排得慢**不是配额问题**（接口容得下更多），而是**大多数候选根本没有可验证的热度数据**。
  //      它们每轮被白跑一遍 → 出队 → 永远进不了站；跑再勤也看不到"完整数据"。
  //
  // 所以给"来源型目录条目"开一条**有界的直收通道**：不要求曲线，直接入库，
  // 并如实标注（reason + 需求动能未测）。理由：这些是**目录里的作品本体**（榜单/新游页抓来的），
  // 不是热搜噪音；它们的价值在"更早被发现"，而曲线只是"需求动能"这一个维度的输入。
  // 有界 = 每轮总量上限 + 单来源上限，避免一个来源把 games.json 灌满。
  const cd = Object.assign({ enabled: true, maxPerRun: 60, perSourceCap: 25, minPrio: 2 }, cfg.games.catalogDirect || {});
  let directAdded = 0;
  if (cd.enabled) {
    const perSrc = {};
    const done = [];
    const scan = peekQueue(cfg, Math.max(cfg.games.sourceBatch || 120, cd.maxPerRun * 4));
    for (const it of scan) {
      if (directAdded >= cd.maxPerRun) break;
      const key = String(it.name || "").toLowerCase();
      if (!key || known.has(key)) continue;
      if (!it.source) continue;                       // 热搜词不吃这条通道（它们靠曲线）
      if (feedbackVerdict(it.name, cfg.feedback) === "block") continue;
      // 🛑 2026-09-24 实测纠偏：**低优先级 ≠ 不该收**。
      //    原规则「prio < minPrio 一律不收」把 Google Play **整源**挡在门外：
      //    Play 没有新游入口 → 全部条目都是热榜 → queue.mjs 一律给 prio 1
      //    → 实测队列里 509 条 googleplay **无一条有资格**；唯一剩下的曲线通道只放进来 6 条，
      //      且全是全球大作（Township / Fortnite / Royal Match / Whiteout Survival …）——
      //      方向与"发现小游戏"完全相反（曲线门槛本质是**出名度门槛**：有曲线的必然已出名）。
      //    现在：仍按 minPrio 把关，但 `allowLowPrioSources` 里的来源豁免 ——
      //    它们已经通过"是目录里的作品本体"这一关，缺的只是趋势数据；榜单名次本身就是排序信号。
      //    （googleplay 保持 prio 1 是对的：那条 prio 只管"曲线验证顺序"，别把稀缺的 Trends 配额花在饱和热榜上。）
      const lowPrioOk = (cd.allowLowPrioSources || []).includes(String(it.source || ""));
      if (!lowPrioOk && (it.prio || 0) < cd.minPrio) continue;
      if ((perSrc[it.source] || 0) >= cd.perSourceCap) continue;
      perSrc[it.source] = (perSrc[it.source] || 0) + 1;
      directAdded++;
      known.set(key, {
        name: it.name,
        series: [],                                    // 没有曲线 → 需求动能显示"未测"（不是 0）
        chart_at: iso(),                               // 记时间：6 小时后会再尝试取曲线（若它后来有量，能被补上）
        related_at: iso(),
        chart_geo: (cfg.games.geos || ["US"])[0],
        first: iso(), last: iso(), sightings: 1, hype: 0,
        reason: "目录直收（" + it.source + (it.kind ? ":" + it.kind : "") + " · 无 Trends 曲线）",
        src: it.source,
        srcUrl: it.url || "",
        srcList: it.kind || it.list || "",
        srcCreated: it.created || "",
        direct: true,
        cats: [], geos: [(cfg.games.geos || ["US"])[0]], rising: [], words: [],
      });
      done.push(key);
    }
    if (done.length) {
      const out = dropQueue(cfg, done);
      log("info", `目录直收：${done.length} 条直接入库并出队（${Object.entries(perSrc).map(([k, v]) => k + " " + v).join(" · ")}）${out ? " · 出队 " + out : ""}`);
    }
  }
  for (const it of peekQueue(cfg, cfg.games.sourceBatch || 120)) {
    const key = String(it.name).toLowerCase();
    if (candMap.has(key)) continue;
    // 你的反馈永远优先：写进 feedback.block 的名字不验证、不入库（存量条目也会被后面的重筛清掉）
    if (feedbackVerdict(it.name, cfg.feedback) === "block") continue;
    const cur = known.get(key);
    if (cur && Date.now() - new Date(cur.chart_at || 0).getTime() < refreshMs) continue;
    candMap.set(key, {
      q: it.name,
      geo: (cfg.games.geos || ["US"])[0],
      vol: 0,
      growth: 0,
      cats: [],
      weight: 3,
      reason: "来源:" + it.source + (it.kind ? ":" + it.kind : ""),
      trusted: true,
      tracked: !!cur,
      needRelated: !cur,
      srcInfo: it,
    });
  }

  const cands = Array.from(candMap.values());

  // ── LLM 终审 ──
  // 必须放在"取曲线"之前：曲线接口限流最严、配额最贵，不能浪费在非游戏上。
  // 它只做否决（人名/赛事/博彩/影视/卡牌/硬件/服务/泛化词），不会新增候选。
  // 必须把"已追踪的游戏名"一并送审：cands 只在新鲜度过滤之后构建，
  // 存量脏词（人名等）不会出现在 cands 里，只送审新词就永远清不掉它们。
  // 来源型候选是目录里的作品本体，不需要 LLM 判"是不是游戏"（只做热度验证），直接放行，也省 token
  const judged = await judgeCandidates(cands.filter((c) => !c.trusted), cfg, Array.from(known.values()).map((g) => g.name));
  const candsOk = [...judged.kept, ...cands.filter((c) => c.trusted)];
  if (judged.stats.mode === "on") {
    log("info", `终审：送审 ${judged.stats.judged} · 缓存命中 ${judged.stats.cached} · 否决 ${judged.stats.dropped}（模型 ${judged.stats.model}）`);
    for (const d of judged.dropped.slice(0, 10)) log("dim", `    ✕ ${d.q}  [${d.judgeKind}] ${d.judgeWhy}`);
    if (judged.dropped.length > 10) log("dim", `    …还有 ${judged.dropped.length - 10} 个`);
  }

  // 优先级：全新游戏(0) > 老游戏补攻略词(1) > 单纯刷曲线(2)
  // 同级排序：目标市场 →【识别权重】→ 涨幅 → 搜索量
  //
  // 为什么这么排（实测依据，不要随手改回按搜索量排）：
  //  · 雷达的目的是"尽早发现新游戏"，而新游戏刚冒头时量必然小 ——
  //    实测 50 个候选里 32 个（64%）落在 vol≤500 桶。若按搜索量排序，
  //    配额会被"量大但已不新"的词吃光，恰好漏掉最新的那批。
  //  · 但也不能只按涨幅排：低量噪音（人名，如 bill skarsgård / truls möregårdh）
  //    涨幅反而最高（+300%~+900%）。而"识别权重"能有效区分 ——
  //    实测权重 ≥3（分类+平台词/意图词）的几乎全是真游戏，人名噪音全挤在权重=2。
  //  · 所以顺序是：先权重（精度）→ 再涨幅（新鲜度）→ 最后才看搜索量。
  const prio = (c) => (c.tracked ? (c.needRelated ? 1 : 2) : 0);
  const byTrend = (a, b) =>
    prio(a) - prio(b) ||
    (prefGeos.has(b.geo) ? 1 : 0) - (prefGeos.has(a.geo) ? 1 : 0) ||
    b.weight - a.weight ||
    (b.growth || 0) - (a.growth || 0) ||
    (b.vol || 0) - (a.vol || 0);
  // 配额按 sourceShare 分给两个入口：来源（Roblox/Steam 目录）优先 —— 那才是原站口径的"新游戏"；
  // 热搜候选保留一份，因为它能抓到目录之外的爆款（也是我们比原站多的一条腿）。
  // ── 自适应曲线预算（2026-09-24）──
  // `maxCurvesPerRun` 是**上限**（有积压时才用），`minCurvesPerRun` 是**空闲档**。
  // 为什么需要：排空队列时要把预算开到 120，但清空之后队列里没东西可验，
  // 静态的 120 会每轮空烧配额（转去反复刷已知游戏的曲线）。让它随积压量滑动：
  //   积压 2000 → 顶到 120 ｜ 积压 300 → ~124→120 ｜ 积压 0 → 回落到 24（≈原来的轻量节奏）
  const backlogForBudget = loadQueue(cfg).items.length;
  const capMax = cfg.games.maxCurvesPerRun ?? 24;
  const capMin = cfg.games.minCurvesPerRun ?? 24;
  // ⚠️ 必须处理 `--max-curves 2` 这类"上限比空闲档还小"的调用（快速测试用）：那时直接用上限，不能反过来把它顶到 24
  const cap = capMax <= capMin
    ? capMax
    : Math.max(capMin, Math.min(capMax, capMin + Math.round(backlogForBudget / 3)));
  if (cap !== capMax || backlogForBudget > 0) {
    log("dim", `  曲线预算：积压 ${backlogForBudget} → 本轮 ${cap}（空闲档 ${capMin} / 上限 ${capMax}，随积压自适应）`);
  }
  const capSrc = Math.max(1, Math.round(cap * (cfg.games.sourceShare ?? 0.7)));
  const srcOk = candsOk.filter((c) => c.trusted).sort((a, b) => prio(a) - prio(b));
  const trendOk = candsOk.filter((c) => !c.trusted).sort(byTrend);
  const todoSrc = srcOk.slice(0, capSrc);
  const todo = [...todoSrc, ...trendOk.slice(0, Math.max(0, cap - todoSrc.length))];
  log("info", `游戏雷达：候选 ${candsOk.length} 个（来源 ${srcOk.length} / 热搜 ${trendOk.length}），本轮取曲线 ${todo.length} 个（其中来源 ${todoSrc.length}）`);

  let added = 0;
  let kwAdded = 0;
  const maxWords = cfg.games.relatedWords ?? 12;

  // 曲线 / 相关查询接口限流严格：串行 + 间隔，避免 429。
  // 再加一道熔断：连续 429 就结束本轮（否则会把 IP 越打越黑，还白等退避时间），
  // 没验证完的来源候选留在队列里，下一轮继续。
  const rlFailed = new Set();
  const rlStop = cfg.games.rateLimitStop ?? 2;
  let consecutive429 = 0;
  for (const c of todo) {
    const geo = prefGeos.has(c.geo) ? c.geo : (cfg.games.geos || ["US"])[0];
    const key = c.q.toLowerCase();
    const prev = known.get(key);
    const needRelated = !!c.needRelated; // 已由候选筛选阶段判定
    await sleep(cfg.games.delayMs ?? 2500);

    // 先单独取曲线：**让"取不到曲线"和"曲线是空的"都能被统一处理**
    let curve = null;
    let curveErr = null;
    try {
      curve = await fetchInterest(session, c.q, geo, {
        timeframe: cfg.games.timeframe || "now 7-d",
        sampleEveryHours: cfg.games.sampleEveryHours || 4,
        withRelated: needRelated,
      });
    } catch (e) {
      curveErr = e;
    }

    // 曲线门槛（第 ⑧ 道）：零信号不要 —— 但**来自潜伏清单的"已上线"条目例外**。
    // 为什么例外：它们是我们在潜伏清单里盯到上线的游戏，官方数据（访问/好评/上线日）已经拿到，
    // 曲线只影响"需求动能"与攻略词，不该当准入门槛。
    // 实测：不加这条例外，Starforged / Magoi / A Bizarre Race 这类新游戏
    //   ① 在 Trends 上本来就没有曲线 → 被整条丢弃；
    //   ② 或者恰好碰到 429 → 被当失败 → 盯了几个月的成果直接蒸发。
    // 例外名单：这些来源"没有曲线"是**常态**，不该因此被丢掉
    //   ① 潜伏清单盯到上线的（via=watchlist-live）
    //   ② 手机端 / 网页小游戏的**新游**（iOS「最新上架」、itch/Poki 的新作）——
    //      刚上架的游戏在 Trends 上本来就没有曲线，而它们恰恰是"零竞争"的那一段（2026-09-24 新增）
    // 每轮条数由来源配额 capSrc 天然封顶，所以不会因为这两条例外把列表灌爆。
    const freshCatalog = c.srcInfo && (
      (c.srcInfo.source === "appstore" && /^new/.test(String(c.srcInfo.kind || ""))) ||
      ((c.srcInfo.source === "itch" || c.srcInfo.source === "poki" || c.srcInfo.source === "crazygames") && c.srcInfo.kind === "new")
    );
    const promoted = !!(c.srcInfo && (c.srcInfo.via === "watchlist-live" || freshCatalog));
    const hasCurve = curve && curve.series.length >= 2 && curve.peak > 0;

    if (!hasCurve && !promoted) {
      if (curveErr) {
        log("warn", `  ${c.q} 曲线失败: ${curveErr.message}`);
        if (/429|限流/.test(curveErr.message)) {
          consecutive429++;
          rlFailed.add(c.q);
          if (consecutive429 >= rlStop) {
            log("warn", `曲线接口连续 ${consecutive429} 次限流，本轮提前结束（未验证的候选留在队列，下轮继续）`);
            break;
          }
        } else {
          consecutive429 = 0;
        }
      }
      continue;
    }
    if (curveErr) log("dim", `  ${c.q} 曲线拿不到（${curveErr.message}）→ 来源目录条目，用官方数据收录`);

    const hype = hasCurve ? hypeRatio(curve.series) : 0;
    const score = scoreKeyword({
      vol: c.vol, growth: c.growth, hype, weight: c.weight,
      // feedback.boost 里的词加分：你判断值得做的，让它排前面
      feedbackBoost: feedbackVerdict(c.q, cfg.feedback) === "boost" ? FEEDBACK_BOOST_PTS : 0,
    });
    // Rising 先做相关性过滤（剔除同期爆红的无关词），Top 本身质量高、不过滤
    // （无曲线时 curve 为 null，必须都做空值保护）
    const nameTokens = tokensOf(c.q);
    const rising = ((curve && curve.rising) || []).filter((w) => relevantTo(w, nameTokens)).slice(0, maxWords);
    const top = ((curve && curve.top) || []).slice(0, maxWords);
    // 优先收「上升」词，不足再用「最热门」词补齐 ——
    // 实测很多词只有 top、rising 是空的（如 wordle hints / xbox game pass）
    const words = [];
    for (const w of [...rising, ...top]) {
      if (words.length >= maxWords) break;
      if (!words.includes(w)) words.push(w);
    }
    known.set(key, {
      name: c.q,
      series: hasCurve ? curve.series : (prev?.series || []),   // 无曲线时保留旧曲线，不写空数组覆盖
      chart_at: iso(),
      related_at: needRelated ? iso() : prev?.related_at || iso(),
      chart_geo: geo,
      first: prev?.first || iso(),
      // 🆕 2026-09-25：**潜伏期首次发现时间**（我们还没上线就盯上它的那天）。
      //    `first` = 雷达入库时间（用于 30 天过期 + "最新发现"排序），语义不动；
      //    `lead`（发现提前量）问的是"我们**最早**什么时候看到它" → 必须用 `firstSeenAt`。
      //    没有这个字段，潜伏转正的条目 lead 恒为负（实测 1115 条里 712 条 lead<0、**0 条 lead>0**），
      //    "发售前发现"的先手红利在架构里就兑现不了。
      //    通路：watchlist.mjs 的 firstSeen → pushQueue → 这里。
      firstSeenAt: prev?.firstSeenAt || (c.srcInfo && c.srcInfo.firstSeen) || "",
      last: iso(),
      sightings: (prev?.sightings || 0) + 1,
      hype,
      score,
      reason: prev?.reason || (promoted && !hasCurve
        ? (c.srcInfo.via === "watchlist-live" ? "潜伏清单转正（Trends 暂无曲线）" : "新游目录收录（Trends 暂无曲线）")
        : c.reason),
      src: prev?.src || (c.trusted ? c.srcInfo.source : ""),
      srcUrl: prev?.srcUrl || (c.trusted ? c.srcInfo.url : ""),
      srcList: prev?.srcList || (c.trusted ? c.srcInfo.kind || c.srcInfo.list || "" : ""),
      // 来源自带上架日期的（itch 的 createDate / iOS 的 releaseDate）→ 存下来给"新鲜度"用，
      // 别浪费：这几个小游戏平台**没有别的官方数据**，上架日期是唯一能判"竞争窗口"的输入。
      srcCreated: prev?.srcCreated || (c.trusted && c.srcInfo.created ? String(c.srcInfo.created) : ""),
      cats: c.cats && c.cats.length ? c.cats : prev?.cats || [],
      geos: Array.from(new Set([...(prev?.geos || []), c.geo])).slice(0, 8),
      rising: rising.length ? rising : prev?.rising || [],
      words: words.length ? words : prev?.words || [],
    });
    // 这些就是可直接起标题的攻略词，一并汇入关键词池
    for (const w of words) gameKw.push({ q: w, parents: [c.q], geo: [c.geo] });
    kwAdded += words.length;
    added++;
    consecutive429 = 0;
    log("ok", `  🎮 ${c.q} (${geo}) score=${score} hype=${hype} 峰值=${hasCurve ? curve.peak : "无"} 攻略词=${words.length}${promoted && !hasCurve ? "（潜伏转正）" : ""}`);
  }

  // 本轮处理过的来源候选出队：成功的已进 known（下一轮不会再被选），失败的不再堵队首
  const doneSrc = todo.filter((c) => c.trusted && !rlFailed.has(c.q)).map((c) => c.q);
  if (doneSrc.length) {
    const out = dropQueue(cfg, doneSrc);
    if (out) log("dim", `  来源队列出队 ${out} 个`);
  }

  // ── 队列进度与 ETA：给"还要多久清空"一个数字，而不是感觉 ──
  // 关键：要减掉**本轮新增的入队量**（进 > 出时永远清不完，必须如实说，不能报一个假的乐观数字）。
  {
    const left = loadQueue(cfg).items.length;
    const cleared = directAdded + doneSrc.length;
    const inflow = queued.added || 0;
    const net = cleared - inflow;
    const eta = net > 0
      ? `约 ${Math.ceil(left / net)} 轮（采集每小时一轮 → 约 ${Math.ceil(left / net)} 小时）`
      : `**净增**（本轮进 ${inflow} / 出 ${cleared}）→ 按当前节奏不会清空，只会涨到队列上限后开始过期`;
    log("info", `队列：剩余 ${left} · 本轮清 ${cleared}（直收 ${directAdded} + 曲线 ${doneSrc.length}）· 本轮新增 ${inflow} → ${eta}`);
  }

  let list = Array.from(known.values());
  const cutoff = Date.now() - 30 * 86400_000;
  list = list.filter((g) => new Date(g.first).getTime() >= cutoff);
  // 规则可能已经改过（比如新开了 latinOnly、补了排除词）：按【当前规则】再筛一遍，
  // 否则旧条目会一直留在列表里直到 30 天过期 —— 改了配置却看不到变化
  const ruleFiltered = list.length;
  // 用本轮终审的判定（含缓存命中）清存量，而不是另读一次缓存文件 —— 口径保持一致
  const verdicts = judged.verdicts;
  list = list.filter((g) => {
    // 来源型条目（Roblox 榜单 / Steam 商店）是目录里的作品本体，不套"热搜游戏识别"规则 ——
    // 否则 "Mall" / "Cars" / "Find" 这类原名会被噪音 / 泛化词规则误杀
    if (g.src) return true;
    const cats = g.cats || [];
    // 噪音规则也必须重跑：只重跑 gameCandidate 的话，
    // 靠 noise 才被挡住的脏条目（如体育赛事）一旦入了库就再也清不掉，要等 30 天过期。
    if (noiseLabel(g.name, cats)) return false;
    // LLM 终审否决过的同样要清掉，否则它进了库就永远留着（同一个坑的第二遍）
    if (verdicts.get(String(g.name).toLowerCase().trim())?.game === false) return false;
    // 你的反馈同样能清存量：把词加进 feedback.block，下一轮它就从列表里消失
    if (feedbackVerdict(g.name, cfg.feedback) === "block") return false;
    return gameCandidate({ q: g.name, cats }, { latinOnly, excludeAAA }).ok;
  });
  if (list.length < ruleFiltered) log("dim", `  按当前规则清掉 ${ruleFiltered - list.length} 个不再符合条件的旧条目`);
  // ── 体积护栏（2026-09-24）──
  // 开了"目录直收"之后，发现量会真实反映出来（每轮十几到几十条），而看板要**整份加载** games.json：
  // 不设上限的话一个月能涨到几万条 → 页面加载不动。
  // 淘汰策略：先保住**有曲线的**（可评估的那批），再按首次发现时间新旧，超出部分如实计数。
  // ⚠️ 这里的 `games.maxItems`（games.json 条数上限）与 `pool.maxItems`（关键词池上限）**同名不同义**，
  //    两个都在 config.json 里 —— 改的时候别看错行。保留 `|| 3000`：写 0 时走默认值，而不是把列表清空。
  const gymMax = cfg.games.maxItems || 3000;
  if (list.length > gymMax) {
    const before = list.length;
    list = list.slice().sort((a, b) =>
      (((b.series || []).length > 1 ? 1 : 0) - ((a.series || []).length > 1 ? 1 : 0)) ||
      (new Date(b.first) - new Date(a.first)));
    list = list.slice(0, gymMax);
    log("dim", `  games.json 体积护栏：${before} → ${gymMax} 条（优先保留有曲线的条目）`);
  }
  // ── 补 Roblox 官方数据（访问量 / 好评率 / 上线时间 / 更新 / 在线人数）──
  // 这是"建站可做性"评分里【需求规模 / 口碑 / 新鲜度】三项的输入，必须写在 writeGames 之前。
  // 零密钥（Roblox 公开接口）。批量请求（一次 50 个 universeId），所以默认**每小时**刷新：
  // 55 个游戏稳态只要 2 次请求，不必再为了省配额把它压到 7 天。失败保留旧值。
  const statRes = await enrichGameStats(list, cfg);

  // ── 补 Steam 官方数据（发售日 / 评价数 / 好评率 / 在线人数）──
  // 与 Roblox 侧同一目的：让"建站推荐"对非 Roblox 游戏也能算需求/口碑/新鲜度。
  // 注意 appdetails 不支持多 appid 批量 → 每个游戏 3 次请求，所以靠 TTL + 每轮上限控制。
  const steamRes = await enrichSteamStats(list, cfg);

  // ── 补手机端官方数据（iOS：真实上线日/价格/评分人数；Android：只有评分，且**没有**首发日）──
  // 与前一层的分工：这一层只认来源明确的 appstore / googleplay 条目，绝不跨平台按名字找同名。
  const mobRes = await enrichMobileStats(list, cfg);

  // ── 曲线保鲜（2026-09-24 新增）──
  // 卡片的曲线是**发现那一刻的快照**，之后从不更新 → 一个几天前爆过、现在已经没人搜的游戏，
  // 卡片上还挂着漂亮的曲线、还占着高分。这里按 `hours` 定期重取：
  //   · 重取成功且有量 → 覆盖曲线（卡片跟着更新，动能与推荐分也跟着重算）
  //   · 重取成功但**没有量** → `coolStreak++`，连续 `coolStreak` 次 → 标 `cooled`（❄️ 已转凉）
  //   · 重取**失败**（429 等）→ 什么都不改 —— 限流 ≠ 这游戏凉了（负缓存禁令）
  const crRes = await enrichCurveRefresh(list, session, cfg);
  if (crRes.eligible) {
    log("info", `曲线保鲜：本轮 ${crRes.tested}（刷新 ${crRes.ok} · 转凉 ${crRes.cooled} · 失败 ${crRes.failed}）· ` +
      `待保鲜 ${crRes.eligible}${crRes.skipped ? ` · 留到下一轮 ${crRes.skipped}` : ""}`);
  }

  // ── 「vs 基准词」同尺度对比（2026-09-24 新增，**同日已停用**）──
  // 每张卡的迷你曲线是**各卡自己归一化**的（峰值恒 100）→ 卡片之间比不了大小（小词的平线会被拉得和大词一样高）。
  // 这里把最多 4 个候选 + 1 个基准词（`config.trendsCompare`，页面链接用的也是它）放进**同一次** Trends 请求，
  // 拿到共享尺度后算出 `g.cmp`（峰值比 / 周均比）—— 页面那行"一眼可比"的数字来自这里。
  // 有界：每轮 `maxPerRun` 8 个、4 个一组（每组 2 次请求）、间隔 4s、成功缓存 7 天；
  // 失败（429 / 列数不符）**不写 `g.cmp`** → 页面显示「未测」，绝不编一个比值。
  const cmpRes = await enrichCompare(list, session, cfg);
  if (cmpRes.eligible) {
    const pct = ((cmpRes.measured / cmpRes.eligible) * 100).toFixed(1);
    log("info", `vs ${cfg.trendsCompare || "基准词"}：本轮 ${cmpRes.batches} 组（成功 ${cmpRes.ok} · 失败 ${cmpRes.failed}）· ` +
      `覆盖率 ${cmpRes.measured}/${cmpRes.eligible}（${pct}%）` + (cmpRes.skipped ? ` · 留到下一轮 ${cmpRes.skipped}` : ""));
  }

  // ── 竞争的**自动 SERP 核查**（2026-09-24 新增）──
  // 为什么：安卓条目拿不到官方上线日（实测 Play 无首发日）→ 竞争项只能标「未测」
  // → 按既有护栏**总分为 null**，在🎯建站推荐里"看得见、判不了"。这里用可得的口径补上：
  // 「<游戏名> codes」前十的独立域名数（= 人工核查的那一步，机器来做）。
  // 有界：`maxPerRun 12` / 间隔 `gapMs 3000` / 成功缓存 `ttlDays 7`；失败**不写缓存**（限流≠没竞争）。
  const serpRes = await enrichSerpComp(list, cfg);
  if (serpRes.tested || serpRes.cached) {
    log("info", `自动竞争核查（SERP）：本轮测 ${serpRes.tested}（成功 ${serpRes.ok} · 失败 ${serpRes.failed}）· 沿用缓存 ${serpRes.cached}`);
  }

  list.sort((a, b) => new Date(b.first) - new Date(a.first));
  // 雷达分数的算法自述随产物下发 → 前端"评分规则"折叠块据实展示（单一事实源在 detect.mjs）
  writeGames(cfg, list, { scoring: SCORE_RULES, serp: SERP_RULES });
  log("ok", `输出 data/games.json（${list.length} 个，本轮新增 ${added}，挖到攻略词 ${kwAdded} 个）`);
  if (statRes.mode === "on") {
    const rbx = list.filter((x) => x.stats?.visits != null).length;
    const stm = list.filter((x) => x.stats?.platform === "steam").length;
    const ios = list.filter((x) => x.stats?.platform === "ios").length;
    const and = list.filter((x) => x.stats?.platform === "android").length;
    // "有官方数据"的判定按平台分开 —— 手游没有 visits，不能因此被算进"仍缺"
    const hasOfficial = (x) => !!x.stats && (x.stats.visits != null || x.stats.platform === "steam" ||
      x.stats.platform === "ios" || x.stats.platform === "android");
    const unknown = list.filter((x) => !hasOfficial(x)).length;
    const srcMix = {};
    for (const x of list) if (x.src) srcMix[x.src] = (srcMix[x.src] || 0) + 1;
    log("dim", `  官方数据覆盖：Roblox ${rbx} · Steam ${stm} · iOS ${ios} · Android ${and} · 仍缺 ${unknown}/${list.length}（缺的多是热搜候选：AAA 或根本不是游戏）`);
    log("dim", `  来源构成：${Object.entries(srcMix).sort((a, b) => b[1] - a[1]).map(([k, v]) => k + " " + v).join(" · ") || "无来源型条目"}`);
  }
}

// ── 4. 关键词池：热搜的相关词 + 游戏雷达挖出的攻略词 ──
// --only-games 模式下 fresh 来自上一轮 trends.json，若再喂进词池会让 count 重复累加，故传空数组
const pool = buildKeywordPool(cfg._onlyGames ? [] : fresh, cfg, gameKw);
log("ok", `输出 data/keywords.json（词池 ${pool.total} 个：相关词 ${pool.related}，游戏攻略词 ${pool.game}）`);

// ── 5. 状态与汇总 ──
const state = readState(cfg);
writeState(cfg, {
  runs: (state.runs || 0) + 1,
  lastGeoCount: cfg.geos.length,
  lastFreshCount: fresh.length,
  lastFailures: failures,
});

log("ok", `全部完成，用时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
