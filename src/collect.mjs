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
import { loadConfig, parseArgs, log, iso, sleep, pMap, readJson, dataPath } from "./lib/util.mjs";
import { createSession, collectGeo } from "./lib/trends.mjs";
import { fetchInterest, hypeRatio } from "./lib/interest.mjs";
import { noiseLabel, gameCandidate, scoreKeyword, matchWatch } from "./lib/detect.mjs";
import {
  loadHistory, mergeHistory, writeHistory, writeTrends,
  loadGames, writeGames, readState, writeState,
} from "./lib/store.mjs";
import { buildKeywordPool } from "./lib/pool.mjs";
import { translateToZh } from "./lib/translate.mjs";

const t0 = Date.now();
const args = parseArgs();
const cfg = loadConfig();

if (args.geos) cfg.geos = String(args.geos).split(",").map((s) => s.trim()).filter(Boolean);
if (args["no-games"]) cfg.games.enabled = false;
if (args["only-games"]) { cfg._onlyGames = true; cfg.games.enabled = true; }
if (args.translate) cfg.translate = true;
if (args.minvol) cfg.minVol = Number(args.minvol);

const session = await createSession();
log("info", `会话就绪 ${session.cookie ? "(已获取 cookie)" : "(无 cookie)"}`);

// ── 1. 采集热搜 ──
let fresh = [];
const failures = [];

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
  });
  log("ok", `输出 data/trends.json`);

  const pool = buildKeywordPool(fresh, cfg);
  log("ok", `输出 data/keywords.json（词池 ${pool.total} 个，其中相关词 ${pool.related}）`);
}

// ── 3. 新游戏雷达 ──
if (cfg.games.enabled) {
  const gamesDoc = loadGames(cfg);
  const known = new Map(gamesDoc.items.map((g) => [g.name.toLowerCase(), g]));
  const prefGeos = new Set(cfg.games.geos || []);
  const refreshMs = (cfg.games.refreshHours || 6) * 3600_000;

  // 候选：来自本轮热搜
  // 同一个游戏常常同时出现在多个国家的榜单上，必须按游戏名去重，
  // 否则会给同一个游戏重复取多次曲线（白白多耗配额、更容易被限流）
  const candMap = new Map();
  for (const it of fresh) {
    if (it.noise) continue;
    if ((it.vol || 0) < (cfg.games.minVol || 0)) continue;
    const gc = gameCandidate(it);
    if (!gc.ok) continue;
    const key = it.q.toLowerCase();
    const cur = known.get(key);
    const chartAge = cur?.chart_at ? Date.now() - new Date(cur.chart_at).getTime() : Infinity;
    if (chartAge < refreshMs) continue; // 曲线还新，本轮不重复取
    const cand = { ...it, weight: gc.weight, reason: gc.reason, tracked: !!cur };
    const prev = candMap.get(key);
    if (!prev) { candMap.set(key, cand); continue; }
    const better =
      (prefGeos.has(cand.geo) ? 1 : 0) - (prefGeos.has(prev.geo) ? 1 : 0) ||
      (cand.vol || 0) - (prev.vol || 0);
    if (better > 0) candMap.set(key, cand);
  }
  const cands = Array.from(candMap.values());

  // 新发现优先 → 目标市场优先 → 搜索量高优先
  cands.sort((a, b) =>
    (a.tracked ? 1 : 0) - (b.tracked ? 1 : 0) ||
    (prefGeos.has(b.geo) ? 1 : 0) - (prefGeos.has(a.geo) ? 1 : 0) ||
    (b.vol || 0) - (a.vol || 0) ||
    b.weight - a.weight
  );
  const todo = cands.slice(0, cfg.games.maxCurvesPerRun || 12);
  log("info", `游戏雷达：候选 ${cands.length} 个（新 ${cands.filter((c) => !c.tracked).length}），本轮取曲线 ${todo.length} 个`);

  let added = 0;
  // 曲线接口限流严格：串行 + 间隔，避免 429
  for (const c of todo) {
    const geo = prefGeos.has(c.geo) ? c.geo : (cfg.games.geos || ["US"])[0];
    await sleep(cfg.games.delayMs ?? 2500);
    try {
      const curve = await fetchInterest(session, c.q, geo, {
        timeframe: cfg.games.timeframe || "now 7-d",
        sampleEveryHours: cfg.games.sampleEveryHours || 4,
      });
      if (!curve || curve.series.length < 2 || curve.peak <= 0) continue; // 零信号不要
      const hype = hypeRatio(curve.series);
      const score = scoreKeyword({ vol: c.vol, growth: c.growth, hype, weight: c.weight });
      const prev = known.get(c.q.toLowerCase());
      known.set(c.q.toLowerCase(), {
        name: c.q,
        series: curve.series,
        chart_at: iso(),
        chart_geo: geo,
        first: prev?.first || iso(),
        last: iso(),
        sightings: (prev?.sightings || 0) + 1,
        hype,
        score,
        reason: c.reason,
        cats: c.cats,
        geos: Array.from(new Set([...(prev?.geos || []), c.geo])).slice(0, 8),
      });
      added++;
      log("ok", `  🎮 ${c.q} (${geo}) score=${score} hype=${hype} 峰值=${curve.peak}`);
    } catch (e) {
      log("warn", `  ${c.q} 曲线失败: ${e.message}`);
    }
  }

  let list = Array.from(known.values());
  const cutoff = Date.now() - 30 * 86400_000;
  list = list.filter((g) => new Date(g.first).getTime() >= cutoff);
  list.sort((a, b) => new Date(b.first) - new Date(a.first));
  writeGames(cfg, list);
  log("ok", `输出 data/games.json（${list.length} 个，本轮新增 ${added}）`);
}

// ── 4. 状态与汇总 ──
const state = readState(cfg);
writeState(cfg, {
  runs: (state.runs || 0) + 1,
  lastGeoCount: cfg.geos.length,
  lastFreshCount: fresh.length,
  lastFailures: failures,
});

log("ok", `全部完成，用时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
