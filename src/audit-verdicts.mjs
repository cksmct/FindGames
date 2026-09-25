#!/usr/bin/env node
/**
 * 判级分布复算（验收工具）
 *   node src/audit-verdicts.mjs [--data <dir>] [--from-ref <ref>] [--logic current|<ref>] [--compare [ref]] [--top N]
 *                                   [--breakdown [N]] [--html]
 *
 * 为什么需要它：本项目的「判断力」全在浏览器里（web/app.js 的 rankability / pickVerdict）。
 * 每改一次判级规则，只有打开页面才知道分布变成什么样 —— 「推荐页被打瘫」还是「误判被修掉」
 * 都需要可复算的证据，不能凭感觉。本脚本把 app.js **原文**装进 vm 复算判级分布：
 *   · 同一份数据上做「修复前 vs 修复后」对照（--compare 同时跑工作区版本与指定 git 版本）
 *   · 线上快照（--from-ref origin/radar-data）与本地 data/ 对照
 * 🛑 刻意**不重写第二份判级逻辑**：抄一份公式必然与前端漂移（铁律 7），
 *    这里直接取源码里的真实函数 —— 靠注入只读导出钩子（见 patch）。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadEngine, appSourceOf } from "./lib/verdict.mjs";
import { execFileSync } from "node:child_process";
import { ROOT, parseArgs, log } from "./lib/util.mjs";

const args = parseArgs();

/** 数据集：默认本地 data/；--from-ref <gitref> 则从该版本导出到系统临时目录（不污染仓库） */
function resolveDataset() {
  if (args.data) return path.resolve(ROOT, String(args.data));
  const ref = args["from-ref"] ? String(args["from-ref"]) : "";
  if (!ref) return path.join(ROOT, "data");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "findnews-audit-"));
  for (const f of ["games.json", "config.json", "watchlist.json", "trends.json"]) {
    try {
      const buf = execFileSync("git", ["show", ref + ":data/" + f], { cwd: ROOT, maxBuffer: 512 * 1024 * 1024 });
      fs.writeFileSync(path.join(dir, f), buf);
    } catch (e) {
      log("warn", "  " + ref + ":data/" + f + " 取不到（跳过）：" + String(e.message).split("\n")[0]);
    }
  }
  if (!fs.existsSync(path.join(dir, "games.json"))) throw new Error(ref + " 里没有 data/games.json —— 先 git fetch origin radar-data");
  log("dim", "  数据集：从 " + ref + " 导出到 " + dir);
  return dir;
}

/** 判级引擎装载（实现集中在 src/lib/verdict.mjs —— 采集端与验收端共用同一份） */
async function loadLogic(logic, dir) {
  if (!fs.existsSync(path.join(dir, "games.json"))) throw new Error("games.json 没读到（" + dir + "）");
  const L = await loadEngine({ dir: dir, appSource: appSourceOf(logic), logic: logic });
  for (const w of L.__warnings || []) log("warn", "  " + w);
  return L;
}

const VERDICT_LABEL = { yes: "值得做", warn: "观察", no: "否", unknown: "未测" };
const MISSING_LABEL = { demand: "需求规模", surface: "内容面", lead: "发现提前量", comp: "竞争", momentum: "需求动能", fresh: "新鲜度", quality: "口碑" };

/** 发现提前量分桶（与前端 discoveryLeadScore 的分档同源） */
const LEAD_BUCKETS = [
  { label: "发售前 ≥30 天", hit: function (d) { return d >= 30; } },
  { label: "发售前 7~30 天", hit: function (d) { return d >= 7 && d < 30; } },
  { label: "发售前 0~7 天", hit: function (d) { return d > 0 && d < 7; } },
  { label: "上线后 0~7 天", hit: function (d) { return d <= 0 && d >= -7; } },
  { label: "上线后 7~30 天", hit: function (d) { return d < -7 && d >= -30; } },
  { label: "上线后 30~90 天", hit: function (d) { return d < -30 && d >= -90; } },
  { label: "上线后 >90 天", hit: function (d) { return d < -90; } },
];

/**
 * 上线时长分桶：回答「越老是不是越不值得做」。
 * 与前端同一口径的年龄 = `stats.created || srcCreated`（**绝不用 g.first**，那只是我们入库的时间）。
 * 最后两桶是"没有官方上线日"与"其它"，避免总数对不上。
 */
const AGE_BUCKETS = [
  { label: "≤7 天", hit: (d) => d != null && d <= 7 },
  { label: "8~30 天", hit: (d) => d != null && d > 7 && d <= 30 },
  { label: "31~180 天", hit: (d) => d != null && d > 30 && d <= 180 },
  { label: "181~365 天", hit: (d) => d != null && d > 180 && d <= 365 },
  { label: "1~3 年", hit: (d) => d != null && d > 365 && d <= 1095 },
  { label: "3~5 年", hit: (d) => d != null && d > 1095 && d <= 1825 },
  { label: ">5 年", hit: (d) => d != null && d > 1825 },
  { label: "无官方上线日", hit: (d) => d == null },
];

/** 用前端**真实函数**复算：每条一次 rankability + pickVerdict，再汇总成分布 */
function analyze(L, gamesDoc) {
  const items = gamesDoc.items || [];
  const a = {
    total: items.length,
    verdicts: {}, reasons: new Map(), compSources: {}, missing: {}, unscoredWhy: {},
    // 旧口径（v1，无 dedicated 字段）竞争记录：前后端都已当"未测"，这里单独数一遍，
    // 验证"作废"确实生效（它们不该再拿到任何竞争分）
    legacySerp: { total: 0, verdicts: {} },
    lead: {
      firstSeenAt: 0, count: 0, positive: 0, sum: 0, vals: [], median: null, avg: null,
      buckets: LEAD_BUCKETS.map(function (b) { return { label: b.label, hit: b.hit, n: 0 }; }),
    },
    scored: 0, unscored: 0, rows: [],
    // 按上线时长看判级（回答"越老越不值得做吗"）
    byAge: AGE_BUCKETS.map(function (b) { return { label: b.label, hit: b.hit, total: 0, verdicts: {}, scored: 0, scoreSum: 0 }; }),
    // 雷达窗口：`first` 是"雷达入库时间"，超过 30 天就会被 30 天滚动窗口滚出去
    window: { d7: 0, d14: 0, d25: 0, d30: 0, over: 0 },
  };
  for (const g of items) {
    const r = L.rankability(g);
    const v = L.pickVerdict(g, r);
    a.verdicts[v.k] = (a.verdicts[v.k] || 0) + 1;
    a.reasons.set(v.t, (a.reasons.get(v.t) || 0) + 1);
    const cs = (r.comp && r.comp.source) || "unknown";
    a.compSources[cs] = (a.compSources[cs] || 0) + 1;
    if (g.serp && g.serp.dedicated == null) {
      a.legacySerp.total++;
      a.legacySerp.verdicts[v.k] = (a.legacySerp.verdicts[v.k] || 0) + 1;
    }
    for (const k in L.PICK_W) if (r.parts[k] == null) a.missing[k] = (a.missing[k] || 0) + 1;
    if (r.score == null) {
      a.unscored++;
      const w = r.reason || (cs === "unknown" ? "competition-unknown" : "weights-empty");
      a.unscoredWhy[w] = (a.unscoredWhy[w] || 0) + 1;
    } else a.scored++;
    if (g.firstSeenAt) a.lead.firstSeenAt++;
    if (r.leadDays != null && isFinite(r.leadDays)) {
      const d = r.leadDays;
      a.lead.count++; a.lead.sum += d; a.lead.vals.push(d);
      if (d > 0) a.lead.positive++;
      for (const b of a.lead.buckets) if (b.hit(d)) { b.n++; break; }
    }
    a.rows.push({ name: g.name, k: v.k, t: v.t, score: r.score, leadDays: r.leadDays, lagDays: (r.lag && r.lag.lagDays != null) ? r.lag.lagDays : null, comp: cs, src: g.src, g: g, r: r });
    const cr = (g.stats && g.stats.created) || g.srcCreated;
    const ageD = cr ? (Date.now() - new Date(cr).getTime()) / 86400000 : null;
    const ab = a.byAge.filter(function (x) { return x.hit(ageD); })[0];
    if (ab) {
      ab.total++;
      ab.verdicts[v.k] = (ab.verdicts[v.k] || 0) + 1;
      if (r.score != null) { ab.scored++; ab.scoreSum += r.score; }
    }
    const fa = g.first ? (Date.now() - new Date(g.first).getTime()) / 86400000 : null;
    if (fa != null) {
      if (fa <= 7) a.window.d7++;
      else if (fa <= 14) a.window.d14++;
      else if (fa <= 25) a.window.d25++;
      else if (fa <= 30) a.window.d30++;
      else a.window.over++;
    }
  }
  a.lead.vals.sort(function (x, y) { return x - y; });
  a.lead.median = a.lead.vals.length ? a.lead.vals[Math.floor(a.lead.vals.length / 2)] : null;
  a.lead.avg = a.lead.count ? a.lead.sum / a.lead.count : null;
  return a;
}

// ── 输出（中文列宽按 2 个字符算，避免表格错位）──
function pad(s, n) {
  s = String(s == null ? "" : s);
  let w = 0;
  for (const ch of s) w += ch.codePointAt(0) > 0x2e80 ? 2 : 1;
  return s + " ".repeat(Math.max(0, n - w));
}
function pct(n, total) { return total ? ((n / total) * 100).toFixed(1) + "%" : "0%"; }
function fmt1(v) { return v == null ? "—" : String(Math.round(v * 10) / 10); }
function byCount(x, y) { return y[1] - x[1]; }
function list(map, labelOf, limit) {
  return Object.entries(map).sort(byCount).slice(0, limit || 99)
    .map(function (e) { return (labelOf(e[0]) || e[0]) + " " + e[1]; }).join(" · ");
}
function reasons(a, limit) {
  return [...a.reasons.entries()].sort(byCount).slice(0, limit || 12);
}

function report(L, a, meta) {
  const compLabel = function (k) { return (L.COMP_LABEL || {})[k] || k; };
  console.log("");
  console.log("══ " + meta.title + " ══");
  console.log("  数据集 " + meta.dir + " · app.js 逻辑 " + meta.logic + " · 人工竞争判断 " + meta.manual + " 条");
  console.log("  条目 " + a.total + " · 给出总分 " + a.scored + " · 给不出总分 " + a.unscored);
  console.log("");
  console.log("  判级分布");
  for (const k of ["yes", "warn", "no", "unknown"]) {
    const n = a.verdicts[k] || 0;
    console.log("    " + pad(VERDICT_LABEL[k] + " (" + k + ")", 20) + pad(n, 8) + pct(n, a.total));
  }
  console.log("");
  console.log("  判级理由 Top");
  for (const [t, n] of reasons(a, 12)) console.log("    " + pad(t, 26) + pad(n, 8) + pct(n, a.total));
  console.log("");
  console.log("  竞争来源：" + list(a.compSources, compLabel, 6));
  if (a.legacySerp.total) {
    console.log("  旧口径竞争记录 " + a.legacySerp.total + " 条（不作数，等重测）→ 判级：" +
      Object.entries(a.legacySerp.verdicts).map(function (e) { return (VERDICT_LABEL[e[0]] || e[0]) + " " + e[1]; }).join(" · "));
  }
  console.log("  缺项条数：" + list(a.missing, function (k) { return MISSING_LABEL[k]; }));
  console.log("  无总分根因：" + list(a.unscoredWhy, function (k) { return k; }));
  console.log("  权重：" + Object.entries(L.PICK_W || {}).map(function (e) { return (MISSING_LABEL[e[0]] || e[0]) + " " + e[1]; }).join(" · "));
  console.log("");
  console.log("  发现提前量 lead（官方上线日 − 我们首见日；仅上线 ≤365 天的条目可算）");
  console.log("    firstSeenAt 覆盖 " + a.lead.firstSeenAt + " 条（" + pct(a.lead.firstSeenAt, a.total) + "），其余退回雷达入库时间 first（会系统性低估提前量）");
  console.log("    可算 " + a.lead.count + " 条 · 中位 " + fmt1(a.lead.median) + " 天 · 均值 " + fmt1(a.lead.avg) + " 天 · 发售前发现(lead>0) " + a.lead.positive + " 条（" + pct(a.lead.positive, a.lead.count) + "）");
  console.log("    " + a.lead.buckets.map(function (b) { return b.label + " " + b.n; }).join(" ｜ "));
  console.log("");
  console.log("  按上线时长看判级（回答「越老是不是越不值得做」）");
  console.log("    " + pad("上线时长", 18) + pad("条目", 8) + pad("值得做", 8) + pad("观察", 8) + pad("否", 8) + pad("未测", 8) + pad("有总分", 8) + "平均分");
  for (const b of a.byAge) {
    if (!b.total) continue;
    const avg = b.scored ? Math.round(b.scoreSum / b.scored) : null;
    console.log("    " + pad(b.label, 18) + pad(b.total, 8) + pad(b.verdicts.yes || 0, 8) + pad(b.verdicts.warn || 0, 8) +
      pad(b.verdicts.no || 0, 8) + pad(b.verdicts.unknown || 0, 8) + pad(b.scored, 8) + (avg == null ? "—" : avg));
  }
  const w = a.window;
  const expiring = w.d30 + w.over;
  console.log("  雷达窗口（按雷达入库时间 first，30 天滚动 —— 超期即从推荐里消失，不是降档）");
  console.log("    ≤7 天 " + w.d7 + " · 8~14 天 " + w.d14 + " · 15~25 天 " + w.d25 + " · >25 天 " + expiring +
    "（占 " + pct(expiring, a.total) + "，下几轮内会滚出去；只有被来源/热搜**重新发现**时才以新的 first 回来）");
}

function printTop(a, n) {
  const rows = a.rows.filter(function (r) { return r.score != null; })
    .sort(function (x, y) { return y.score - x.score; }).slice(0, n);
  console.log("");
  console.log("  分数最高的 " + rows.length + " 条");
  for (const r of rows) {
    console.log("    " + pad(Math.round(r.score), 6) + pad(VERDICT_LABEL[r.k] || r.k, 10) + pad(r.name, 34) +
      "lead " + (r.leadDays == null ? "—" : Math.round(r.leadDays)) + " · 竞争 " + r.comp +
      (r.lagDays == null ? "" : " · 晚于首个专站 " + Math.round(r.lagDays) + " 天"));
  }
}

/** 修复前 vs 修复后：分布对照 + 判级迁移 + 迁移样本 */
function compare(Lold, aOld, aNew, ref) {
  console.log("");
  console.log("══ 对照：" + ref + "（修复前） vs 当前工作区（修复后）· 同一份数据 ══");
  console.log("  判级分布");
  for (const k of ["yes", "warn", "no", "unknown"]) {
    const o = aOld.verdicts[k] || 0, n = aNew.verdicts[k] || 0, d = n - o;
    console.log("    " + pad(VERDICT_LABEL[k] + " (" + k + ")", 20) + pad(n, 8) + pad("(" + (d >= 0 ? "+" : "") + d + ")", 8) + "修复前 " + o);
  }
  const oldByName = new Map(aOld.rows.map(function (r) { return [r.name, r]; }));
  const trans = new Map();
  const movedRows = [];
  for (const r of aNew.rows) {
    const o = oldByName.get(r.name);
    if (!o) continue;
    if (o.k === r.k && o.t === r.t) continue;
    const key = (VERDICT_LABEL[o.k] || o.k) + " · " + o.t + "  →  " + (VERDICT_LABEL[r.k] || r.k) + " · " + r.t;
    trans.set(key, (trans.get(key) || 0) + 1);
    movedRows.push({ name: r.name, o: o, n: r });
  }
  console.log("  判级发生变化 " + movedRows.length + " 条（占 " + pct(movedRows.length, aNew.total) + "）");
  for (const [k, n] of [...trans.entries()].sort(byCount).slice(0, 12)) console.log("    " + pad(n, 7) + k);
  const toYes = movedRows.filter(function (x) { return x.n.k === "yes" && x.o.k !== "yes"; });
  const fromYes = movedRows.filter(function (x) { return x.o.k === "yes" && x.n.k !== "yes"; });
  console.log("    新增「值得做」 " + toYes.length + " 条：" + toYes.slice(0, 5).map(function (x) { return x.name; }).join(" · ") || "");
  console.log("    退出「值得做」 " + fromYes.length + " 条：" + fromYes.slice(0, 5).map(function (x) { return x.name; }).join(" · ") || "");
  const toUnknown = movedRows.filter(function (x) { return x.n.k === "unknown" && x.o.k !== "unknown"; });
  console.log("    新沉入「未测」 " + toUnknown.length + " 条" + (toUnknown.length ? "（竞争项不再用上线时长推断 + 旧口径记录作废 —— 都要等 SERP 实测补齐）：" + toUnknown.slice(0, 5).map(function (x) { return x.name; }).join(" · ") : ""));
}

/**
 * 分数明细（文本版，2026-09-25）：把「这一分是怎么来的」逐项打出来。
 * 为什么：用户要按分数给算法反馈 —— 只给一个总分没法讨论，必须能看见每项的输入、权重与贡献。
 * 同时做三件事：
 *   ① 可做性分：每维「值 × 权重 = 贡献」→ Σ ÷ Σ权重 → × 乘数；
 *   ② 雷达分：后端 scoreParts 的每一项（老条目没回填则注明）；
 *   ③ 前端那两个明细块的 HTML 渲染冒烟（确认页面上的折叠块不会抛错）。
 */
function r1(v) {
  if (v == null) return "—";
  if (!isFinite(v)) return "—";
  return String(Math.round(Number(v) * 10) / 10);
}
const pickLabelOf = (L, k) => String((L.PICK_LABEL && L.PICK_LABEL[k]) ? L.PICK_LABEL[k] : k).replace(/\(.*?\)/g, "");
function printBreakdown(L, a, n) {
  const rows = a.rows.filter((x) => x.r && x.r.score != null).sort((x, y) => y.r.score - x.r.score).slice(0, n);
  console.log("");
  console.log("══ 分数明细 Top " + rows.length + "（可做性分；雷达分另列一行）══");
  for (const x of rows) {
    const r = x.r, g = x.g, p = r.parts;
    console.log("");
    console.log("  " + pad(r.score, 5) + pad(VERDICT_LABEL[x.k], 6) + x.name + "　（竞争来源 " + (r.comp && r.comp.source) + "）");
    const cells = [];
    let sum = 0, wsum = 0;
    for (const k in L.PICK_W) {
      const v = p[k];
      if (v == null) { cells.push(pad(pickLabelOf(L, k), 14) + "缺项"); continue; }
      sum += v * L.PICK_W[k];
      wsum += L.PICK_W[k];
      cells.push(pad(pickLabelOf(L, k), 14) + Math.round(v) + "×" + L.PICK_W[k] + "=" + Math.round(v * L.PICK_W[k]));
    }
    console.log("    " + cells.join(" "));
    console.log("    Σ(值×权重)=" + Math.round(sum) + " ÷ Σ权重=" + wsum + " = " + (wsum ? (sum / wsum).toFixed(1) : "—") +
      " × 乘数 " + (r.mult == null ? "—" : Number(r.mult.toFixed(2))) + " → " + r.score +
      (r.missing && r.missing.length ? "　（缺项 " + r.missing.length + " 项：未计入、也没归一化）" : ""));
    const sp = g.scoreParts;
    if (sp) {
      console.log("    雷达分 " + (g.score == null ? 0 : g.score) + " = 搜索量 " + sp.vol + "→" + r1(sp.volScore) +
        " + 涨幅 " + sp.growth + "%→" + r1(sp.growthScore) + " + 起飞档(hype " + r1(sp.hype) + ")→" + r1(sp.hypeScore) +
        " + 权重 " + sp.weight + "×2=" + r1(sp.weightScore) + " + 人工 " + (sp.feedbackBoost == null ? 0 : sp.feedbackBoost));
    } else {
      console.log("    雷达分 " + (g.score == null ? 0 : g.score) + "（scoreParts 未回填：字段 2026-09-25 才加，等下一轮采集）");
    }
    try {
      const v2 = L.pickVerdict(g, r);
      const h1 = L.pickDetail ? String(L.pickDetail(g, r, v2)) : "";
      const h2 = L.scoreDetail ? String(L.scoreDetail(g)) : "";
      const ok = h1.indexOf("分数明细") >= 0 && h2.indexOf("分数明细") >= 0;
      console.log("    HTML 明细渲染：" + (ok ? "✓ 建站推荐 " + h1.length + " 字符 · 雷达 " + h2.length + " 字符" : "✗ 没渲染出明细块"));
      if (args.html && h1) console.log("    " + h1.slice(0, 400));
    } catch (e) {
      console.log("    ✗ HTML 明细渲染抛错：" + e.message);
    }
  }
}
// ── 主流程 ──
const dir = resolveDataset();
const logic = args.logic ? String(args.logic) : "current";
const L = await loadLogic(logic, dir);
const a = analyze(L, L.games);
report(L, a, {
  title: args.title ? String(args.title) : "判级复算",
  dir: dir, logic: logic,
  manual: L.manualComp ? Object.keys(L.manualComp).length : 0,
});
if (args.top) printTop(a, Number(args.top));
if (args.compare) {
  const ref = args.compare === true ? "HEAD" : String(args.compare);
  const LOld = await loadLogic(ref, dir);
  compare(LOld, analyze(LOld, LOld.games), a, ref);
}
// 分数明细（--breakdown [N]）：逐项打出「分是怎么来的」—— 给算法反馈用，也顺带冒烟前端两个明细块
if (args.breakdown) printBreakdown(L, a, Number(args.breakdown) > 0 ? Number(args.breakdown) : 10);