#!/usr/bin/env node
/**
 * 终端报表 + CSV 导出
 *   node src/report.mjs               看板摘要
 *   node src/report.mjs --top 40      改条数
 *   node src/report.mjs --csv         同时导出 export/*.csv
 *   node src/report.mjs --watch       只看命中监控词
 */
import fs from "node:fs";
import path from "node:path";
import { loadConfig, parseArgs, dataPath, readJson, ensureDir, ROOT, iso, fmtVol, relTime, log } from "./lib/util.mjs";

const args = parseArgs();
const cfg = loadConfig();
const TOP = Number(args.top) || 20;

const cats = cfg.catLabels || {};
const geoName = (g) => (cfg.geoLabels?.[g] ? `${cfg.geoLabels[g]}` : g);
const catName = (ids) => (ids || []).map((c) => cats[c]).filter(Boolean).slice(0, 2).join("·") || "—";
const pad = (s, n) => String(s).padEnd(n).slice(0, n);
const padL = (s, n) => String(s).padStart(n).slice(0, n);

const trends = readJson(dataPath(cfg, "trends.json"));
const games = readJson(dataPath(cfg, "games.json"));
const pool = readJson(dataPath(cfg, "keywords.json"));

/** 历史是分片的：首片 + history-pN.json，必须全部读进来 */
function loadAllHistory() {
  const first = readJson(dataPath(cfg, "history.json"));
  const all = [...(first?.items || [])];
  for (let i = 2; i <= (first?.chunks || 1); i++) {
    const p = readJson(dataPath(cfg, `history-p${i}.json`));
    if (p?.items) all.push(...p.items);
  }
  return all.sort((a, b) => (b.vol_peak || 0) - (a.vol_peak || 0));
}
const historyItems = loadAllHistory();

if (!trends) {
  log("err", "还没有数据，先跑：npm run collect");
  process.exit(1);
}

const rows = [];
for (const [geo, arr] of Object.entries(trends.items || {})) {
  for (const it of arr) rows.push({ ...it, geo });
}
const onlyWatch = !!args.watch;
const shown = (list) => (onlyWatch ? list.filter((r) => r.watch?.length) : list);

console.log("\n=== 关键词雷达 · 快照 ===");
console.log(`更新于 ${trends.updated}  (${relTime(trends.updated)})`);
console.log(`地区 ${Object.keys(trends.items || {}).length} 个 · 热搜 ${rows.length} 条 · 留档 ${historyItems.length} 条 · 新游戏 ${games?.items?.length || 0} 个 · 词池 ${pool?.total || 0} 个`);
console.log(`噪音 ${rows.filter((r) => r.noise).length} 条 · 命中监控词 ${rows.filter((r) => r.watch?.length).length} 条`);

function table(title, list, extraCol = null) {
  console.log(`\n── ${title} ──`);
  if (!list.length) return console.log("  (无)");
  list.forEach((r, i) => {
    const star = r.watch?.length ? "★" : r.new ? "🆕" : " ";
    console.log(
      `  ${padL(i + 1, 2)}. ${star} ${pad(r.q, 34)} ${pad(geoName(r.geo), 7)} ${padL(fmtVol(r.vol), 6)} +${padL(
        r.growth || 0, 5
      )}%  ${pad(catName(r.cats), 12)}${extraCol ? extraCol(r) : ""}`
    );
  });
}

table(`搜索量 TOP${TOP}`, shown(rows).slice().sort((a, b) => b.vol - a.vol).slice(0, TOP));
table(
  `涨幅 TOP${TOP}`,
  shown(rows).slice().sort((a, b) => (b.growth || 0) - (a.growth || 0) || b.vol - a.vol).slice(0, TOP)
);
table(
  `新词(本轮首次出现) TOP${TOP}`,
  shown(rows).filter((r) => r.new).slice().sort((a, b) => b.vol - a.vol).slice(0, TOP)
);

if (games?.items?.length) {
  console.log(`\n── 🎮 新游戏雷达 ──`);
  games.items.slice(0, TOP).forEach((g, i) => {
    console.log(
      `  ${padL(i + 1, 2)}. ${pad(g.name, 34)} score=${padL(g.score || 0, 3)} 首次 ${pad(relTime(g.first), 10)} 信号×${
        g.sightings || 1
      } 峰值=${g.series?.length ? Math.max(...g.series) : "—"}`
    );
  });
}

if (pool?.items?.length) {
  console.log(`\n── 🔑 词池 · 被最多热搜带出的相关词 TOP${TOP} ──`);
  pool.items
    .filter((x) => x.kind === "related")
    .slice(0, TOP)
    .forEach((x, i) => {
      console.log(`  ${padL(i + 1, 2)}. ${pad(x.q, 40)} ×${padL(x.count, 3)}  ← ${(x.parents || []).slice(0, 2).join(", ")}`);
    });
}

// ── CSV 导出 ──
function csv(rowsArr, cols, file) {
  const dir = path.join(ROOT, "export");
  ensureDir(dir);
  const esc = (v) => {
    const s = v == null ? "" : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const body = [cols.join(","), ...rowsArr.map((r) => cols.map((c) => esc(r[c])).join(","))].join("\n");
  fs.writeFileSync(path.join(dir, file), "\uFEFF" + body, "utf8");
  log("ok", `导出 export/${file} (${rowsArr.length} 行)`);
}

if (args.csv) {
  csv(
    rows.map((r) => ({ ...r, cats: (r.cats || []).join("|"), watch: (r.watch || []).join("|"), rel: (r.rel || []).join("|") })),
    ["q", "geo", "vol", "growth", "cats", "noise", "watch", "new", "rel"],
    "trending.csv"
  );

  csv(
    historyItems.map((r) => ({ ...r, cats: (r.cats || []).join("|") })),
    ["q", "geo", "vol_peak", "growth_peak", "first", "last", "sightings", "cats", "noise"],
    "history-7d.csv"
  );

  if (pool?.items?.length) {
    csv(
      pool.items.map((r) => ({ ...r, geo: (r.geo || []).join("|"), parents: (r.parents || []).join("|"), watch: (r.watch || []).join("|"), cats: (r.cats || []).join("|") })),
      ["q", "kind", "count", "vol", "growth", "geo", "parents", "watch", "cats", "first", "last"],
      "keyword-pool.csv"
    );
  }
  if (games?.items?.length) {
    csv(
      games.items.map((g) => ({ ...g, series: (g.series || []).join("|"), geos: (g.geos || []).join("|") })),
      ["name", "score", "hype", "first", "last", "chart_at", "chart_geo", "sightings", "series"],
      "games.csv"
    );
  }
}

console.log("");
