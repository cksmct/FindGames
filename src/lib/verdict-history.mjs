/**
 * 判级历史留档（`.verdict-history.jsonl`）—— 回答"某个游戏 / 整体判级是怎么随时间变的"。
 *
 * 为什么必须单独留档（2026-09-25 定案）：
 *   `games.json` 只有**当前窗口**（留存策略 + 体积护栏），`radar-data` 分支又是**单提交 force push**
 *   → 过去的判级结果事后查不到。于是"我们上周是不是把它判成值得做、后来为什么降了"永远无解。
 *
 * 🛑 关键设计：**只记变化，不记全量快照**。
 *   全量（1900 条）× 每轮 ≈ 300KB → 一天 7MB，会把 force-push 的分支撑坏。
 *   所以逐条只记「可做档（yes/warn）的升降」，其余（新进/退出）聚合计数 + 采样几个名字；
 *   另加每轮一行 `dist`，用来画整体分布趋势。
 *
 * 行的形态（JSONL，字段扁平、可直接 grep）：
 *   {"at","kind":"dist","total":1912,"yes":2,"warn":53,"no":636,"unknown":1221,"meas":13,"cap":3000}
 *   {"at","kind":"verdict","name","from":"warn","to":"yes","s":72,"prevS":58,"comp":"serp","age":12}
 *   {"at","kind":"enter","name","k":"yes","s":71,"src":"steam"}
 *   {"at","kind":"exit","name","k":"warn","s":63,"why":"...","last":"ISO"}
 *   {"at","kind":"exit-many","count":57,"why":"...","sample":["A","B","C"]}
 *   {"at","kind":"comp","name","from":"unknown","to":"serp","s":71}
 *
 * 状态侧车 `.verdict-state.json`（每轮覆写，约 100KB）：`{ at, items: { 名字: [判级, 分数, 竞争来源, 年龄] } }`
 *   —— 只用来算"这一轮变了什么"，本身不是档案。
 */
import fs from "node:fs";
import path from "node:path";
import { dataPath, readJson, writeJson, iso, log } from "./util.mjs";
import { loadEngine } from "./verdict.mjs";

export const HISTORY_FILE = ".verdict-history.jsonl";
export const STATE_FILE = ".verdict-state.json";

/** 可做档（只有这几档的升降才逐条记账 —— 见文件头） */
const ACTIONABLE = { yes: true, warn: true };

function appendJsonl(file, rows) {
  fs.appendFileSync(file, rows.map(function (r) { return JSON.stringify(r); }).join("\n") + "\n");
}
function countLines(file) {
  try {
    const txt = fs.readFileSync(file, "utf8").trim();
    return txt ? txt.split("\n").length : 0;
  } catch (e) { return 0; }
}
/** 超出上限就截到最新的一段（老历史按上限滚掉，如实记一行 trim） */
function trimJsonl(file, maxLines, keepRatio) {
  const lines = fs.readFileSync(file, "utf8").trim().split("\n");
  if (lines.length <= maxLines) return 0;
  const keep = Math.max(1, Math.floor(maxLines * (keepRatio || 0.7)));
  const dropped = lines.length - keep;
  writeJson0(file, [JSON.stringify({ at: iso(), kind: "trim", dropped: dropped, kept: keep })].concat(lines.slice(dropped)).join("\n") + "\n");
  return dropped;
}
function writeJson0(file, text) { fs.writeFileSync(file, text); }

/** 归档体检（doctor 用）：行数 / 覆盖天数 / 最近一行 / 各类行计数 */
export function readHistoryStats(cfg, dir = null) {
  const file = dir ? path.join(dir, HISTORY_FILE) : dataPath(cfg, HISTORY_FILE);
  const out = { file: file, exists: fs.existsSync(file), bytes: 0, lines: 0, days: null, firstAt: null, lastAt: null, kinds: {}, recent: [] };
  try {
    out.bytes = fs.statSync(file).size;
    const lines = fs.readFileSync(file, "utf8").trim().split("\n").filter(Boolean);
    out.lines = lines.length;
    for (const ln of lines) {
      let r = null;
      try { r = JSON.parse(ln); } catch (e) { continue; }
      out.kinds[r.kind] = (out.kinds[r.kind] || 0) + 1;
      if (!out.firstAt) out.firstAt = r.at;
      out.lastAt = r.at;
    }
    if (out.firstAt && out.lastAt) out.days = Math.round((new Date(out.lastAt) - new Date(out.firstAt)) / 86400000 * 10) / 10;
    out.recent = lines.slice(-5).map(function (l) { try { return JSON.parse(l); } catch (e) { return null; } }).filter(Boolean);
  } catch (e) { /* 不存在就是没留档，不是错误 */ }
  return out;
}

/**
 * 用**页面上的真实口径**给一批条目判级（复用 src/lib/verdict.mjs 的 vm 引擎，绝不抄公式）。
 * @returns {Promise<Array>} 每条一行：{ name, k, t, score, comp, age, src, manual }
 */
export async function rankItems(items, { config = {}, dir = null } = {}) {
  const L = await loadEngine({ files: { "games.json": { updated: iso(), items: items }, "config.json": config }, dir: dir });
  for (const w of L.__warnings || []) log("warn", "  " + w);
  const ageOf = function (g) {
    const c = (g.stats && g.stats.created) || g.srcCreated;
    return c ? (Date.now() - new Date(c).getTime()) / 86400000 : null;
  };
  const manual = L.manualComp || {};
  return (items || []).map(function (g) {
    const r = L.rankability(g);
    const v = L.pickVerdict(g, r);
    return {
      name: g.name,
      k: v.k,
      t: v.t,
      score: r.score == null ? null : Math.round(r.score),
      comp: (r.comp && r.comp.source) || "unknown",
      age: ageOf(g),
      src: g.src || "",
      manual: Object.prototype.hasOwnProperty.call(manual, String(g.name || "").trim().toLowerCase()),
    };
  });
}

const keyOfName = function (n) { return String(n || "").trim().toLowerCase(); };

/**
 * 每轮记账：对比上一轮状态 → 只把"变化"追加进 jsonl，同时覆写状态侧车。
 * @param exits Map(名字小写 → { name, why, last, first })  由留存策略 / 体积护栏给出（谁走了、为什么）
 * @returns {{rows:number, changed:number, lines:number}}
 */
export async function recordRound(cfg, { items, exits, config }) {
  const hist = (cfg.games && cfg.games.history) || {};
  const histFile = dataPath(cfg, HISTORY_FILE);
  if (hist.enabled === false) return { rows: 0, changed: 0, lines: countLines(histFile), skipped: true };
  const now = iso();
  const stateFile = dataPath(cfg, STATE_FILE);
  const prev = readJson(stateFile, null) || { items: {} };
  const prevItems = prev.items || {};
  const ranked = await rankItems(items, { config: config, dir: dataPath(cfg) });

  const rows = [];
  const next = { at: now, items: {} };
  const inList = new Set();

  for (const r of ranked) {
    const k = keyOfName(r.name);
    if (!k) continue;
    inList.add(k);
    next.items[k] = [r.k, r.score, r.comp, r.age == null ? null : Math.round(r.age)];
    const p = prevItems[k];
    if (!p) {
      // 新进：只有"进来就可做"或带人工判断的才逐条记 —— 其余每轮几十上百条，会把档案淹掉
      if (ACTIONABLE[r.k] || r.manual) rows.push({ at: now, kind: "enter", name: r.name, k: r.k, s: r.score, src: r.src });
      continue;
    }
    if (p[0] !== r.k) {
      // 判级变化：只有涉及可做档（yes/warn）才记
      if (ACTIONABLE[p[0]] || ACTIONABLE[r.k]) {
        rows.push({ at: now, kind: "verdict", name: r.name, from: p[0], to: r.k, s: r.score, prevS: p[1], comp: r.comp, age: r.age == null ? null : Math.round(r.age) });
      }
      continue;
    }
    // 竞争从"未测"变成实测（花过配额的事实，量小且有价值）
    if (p[2] !== r.comp && r.comp !== "unknown") {
      rows.push({ at: now, kind: "comp", name: r.name, from: p[2] || "unknown", to: r.comp, s: r.score });
    }
  }

  const gone = [];
  for (const k of Object.keys(prevItems)) {
    if (inList.has(k)) continue;
    const p = prevItems[k];
    const info = (exits && exits.get(k)) || null;
    const rec = { name: (info && info.name) || k, k: p[0], s: p[1], why: (info && info.why) || "rule-filtered", last: (info && info.last) || "" };   // rule-filtered = 未登记（被规则清掉：噪音 / AAA / feedback / LLM 否决）
    if (ACTIONABLE[p[0]]) rows.push(Object.assign({ at: now, kind: "exit" }, rec));
    else gone.push(rec);
  }
  if (gone.length) {
    rows.push({ at: now, kind: "exit-many", count: gone.length, why: gone[0].why, sample: gone.slice(0, 5).map(function (x) { return x.name; }) });
  }

  const dist = { at: now, kind: "dist", total: ranked.length, yes: 0, warn: 0, no: 0, unknown: 0, meas: 0, cap: (cfg.games && cfg.games.maxItems) || 3000 };
  for (const r of ranked) {
    dist[r.k] = (dist[r.k] || 0) + 1;
    if (r.comp && r.comp !== "unknown") dist.meas++;
  }
  rows.push(dist);

  appendJsonl(histFile, rows);
  writeJson(stateFile, next, false);
  const dropped = trimJsonl(histFile, hist.maxLines == null ? 40000 : hist.maxLines, hist.keepRatio == null ? 0.7 : hist.keepRatio);
  if (dropped) log("dim", `  判级历史：超过上限，滚掉最早 ${dropped} 行`);
  return { rows: rows.length, changed: rows.length - 1, lines: countLines(histFile) };
}
