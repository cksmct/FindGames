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
import { loadConfig, parseArgs, log, iso, sleep, pMap, readJson, writeJson, dataPath } from "./lib/util.mjs";
import { createSession, collectGeo } from "./lib/trends.mjs";
import { fetchInterest, hypeRatio } from "./lib/interest.mjs";
import {
  noiseLabel, gameCandidate, scoreKeyword, matchWatch, tokensOf, relevantTo,
  feedbackVerdict, FEEDBACK_BOOST_PTS,
} from "./lib/detect.mjs";
import { judgeCandidates } from "./lib/judge.mjs";
import {
  loadHistory, mergeHistory, writeHistory, writeTrends,
  loadGames, writeGames, readState, writeState,
} from "./lib/store.mjs";
import { buildKeywordPool } from "./lib/pool.mjs";
import { translateToZh } from "./lib/translate.mjs";
import { collectSourceCandidates } from "./lib/sources.mjs";
import { pushQueue, peekQueue, dropQueue } from "./lib/queue.mjs";

const t0 = Date.now();
const args = parseArgs();
const cfg = loadConfig();

if (args.geos) cfg.geos = String(args.geos).split(",").map((s) => s.trim()).filter(Boolean);
if (args["no-games"]) cfg.games.enabled = false;
if (args["only-games"]) { cfg._onlyGames = true; cfg.games.enabled = true; }
if (args.translate) cfg.translate = true;
if (args.minvol) cfg.minVol = Number(args.minvol);
if (args["max-curves"]) cfg.games.maxCurvesPerRun = Number(args["max-curves"]);
if (args["no-sources"]) cfg.games.sources = { roblox: false, steam: false };

const session = await createSession();
log("info", `会话就绪 ${session.cookie ? "(已获取 cookie)" : "(无 cookie)"}`);

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
  const cap = cfg.games.maxCurvesPerRun || 12;
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
    try {
      const curve = await fetchInterest(session, c.q, geo, {
        timeframe: cfg.games.timeframe || "now 7-d",
        sampleEveryHours: cfg.games.sampleEveryHours || 4,
        withRelated: needRelated,
      });
      if (!curve || curve.series.length < 2 || curve.peak <= 0) continue; // 零信号不要
      const hype = hypeRatio(curve.series);
      const score = scoreKeyword({
        vol: c.vol, growth: c.growth, hype, weight: c.weight,
        // feedback.boost 里的词加分：你判断值得做的，让它排前面
        feedbackBoost: feedbackVerdict(c.q, cfg.feedback) === "boost" ? FEEDBACK_BOOST_PTS : 0,
      });
      // Rising 先做相关性过滤（剔除同期爆红的无关词），Top 本身质量高、不过滤
      const nameTokens = tokensOf(c.q);
      const rising = (curve.rising || []).filter((w) => relevantTo(w, nameTokens)).slice(0, maxWords);
      const top = (curve.top || []).slice(0, maxWords);
      // 优先收「上升」词，不足再用「最热门」词补齐 ——
      // 实测很多词只有 top、rising 是空的（如 wordle hints / xbox game pass）
      const words = [];
      for (const w of [...rising, ...top]) {
        if (words.length >= maxWords) break;
        if (!words.includes(w)) words.push(w);
      }
      known.set(key, {
        name: c.q,
        series: curve.series,
        chart_at: iso(),
        related_at: needRelated ? iso() : prev?.related_at || iso(),
        chart_geo: geo,
        first: prev?.first || iso(),
        last: iso(),
        sightings: (prev?.sightings || 0) + 1,
        hype,
        score,
        reason: prev?.reason || c.reason,
        src: prev?.src || (c.trusted ? c.srcInfo.source : ""),
        srcUrl: prev?.srcUrl || (c.trusted ? c.srcInfo.url : ""),
        srcList: prev?.srcList || (c.trusted ? c.srcInfo.kind || c.srcInfo.list || "" : ""),
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
      log("ok", `  🎮 ${c.q} (${geo}) score=${score} hype=${hype} 峰值=${curve.peak} 攻略词=${words.length}`);
    } catch (e) {
      log("warn", `  ${c.q} 曲线失败: ${e.message}`);
      if (/429|限流/.test(e.message)) {
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
  }

  // 本轮处理过的来源候选出队：成功的已进 known（下一轮不会再被选），失败的不再堵队首
  const doneSrc = todo.filter((c) => c.trusted && !rlFailed.has(c.q)).map((c) => c.q);
  if (doneSrc.length) {
    const out = dropQueue(cfg, doneSrc);
    if (out) log("dim", `  来源队列出队 ${out} 个`);
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
  list.sort((a, b) => new Date(b.first) - new Date(a.first));
  writeGames(cfg, list);
  log("ok", `输出 data/games.json（${list.length} 个，本轮新增 ${added}，挖到攻略词 ${kwAdded} 个）`);
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
