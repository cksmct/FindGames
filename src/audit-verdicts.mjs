#!/usr/bin/env node
/**
 * 判级分布复算（验收工具）
 *   node src/audit-verdicts.mjs [--data <dir>] [--from-ref <ref>] [--logic current|<ref>] [--compare [ref]] [--top N]
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
import vm from "node:vm";
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

/** app.js 源码：current = 工作区文件；其它值 = 某个 git 版本（修复前对照用 HEAD） */
function appSource(logic) {
  if (!logic || logic === "current") return fs.readFileSync(path.join(ROOT, "web", "app.js"), "utf8");
  return execFileSync("git", ["show", logic + ":web/app.js"], { cwd: ROOT, maxBuffer: 64 * 1024 * 1024 }).toString("utf8");
}

/**
 * 注入导出钩子：在「切换」那一段（纯函数定义之后、事件绑定之前）插一段只读导出。
 * 用 eval 逐个取名并 null 兜底 —— 跨版本对照时旧版缺少某个函数也不会整体报错。
 */
const HOOK = `
  // ── Node 复算钩子（src/audit-verdicts.mjs 注入；浏览器里不存在这一段）──
  var __auditPick = function (n) { try { return eval(n); } catch (e) { return null; } };
  globalThis.__RADAR_LOGIC__ = {
    rankability: __auditPick("rankability"),
    pickVerdict: __auditPick("pickVerdict"),
    compRoom: __auditPick("compRoom"),
    discoveryLeadDays: __auditPick("discoveryLeadDays"),
    discoveryLeadScore: __auditPick("discoveryLeadScore"),
    lagMultOf: __auditPick("lagMultOf"),
    platformOf: __auditPick("platformOf"),
    PICK_W: __auditPick("PICK_W"),
    PRE_W: __auditPick("PRE_W"),
    COMP_LABEL: __auditPick("COMP_LABEL"),
    get games() { return __auditPick("games"); },
    get manualComp() { return __auditPick("MANUAL_COMP"); },
  };
`;

function patch(src) {
  const anchor = "\n  // ── 切换 ──";
  if (src.includes(anchor)) return src.replace(anchor, function () { return HOOK + anchor; });
  const tail = "\n})();";
  if (!src.includes(tail)) throw new Error("app.js 结构变了：找不到注入锚点（切换段 / IIFE 收尾）—— 请更新 src/audit-verdicts.mjs 的锚点");
  return src.replace(tail, function () { return HOOK + tail; });
}

/** 万能 DOM 桩：任何属性 / 调用都返回它自己（够用即可 —— 我们只取纯函数，不校验渲染） */
function makeStub() {
  const target = function () {};
  const stub = new Proxy(target, {
    get(t, k) {
      if (k === Symbol.toPrimitive) return function () { return ""; };
      if (k === "then" || k === "toJSON") return undefined;
      if (k === "length") return 0;
      if (k === "innerHTML" || k === "innerText" || k === "textContent" || k === "value") return "";
      if (k === "nextSibling" || k === "previousSibling" || k === "firstChild" || k === "lastChild" ||
        k === "parentNode" || k === "parentElement" || k === "firstElementChild" || k === "lastElementChild") return null;
      if (k === "children" || k === "childNodes") return [];
      if (k === "forEach" || k === "map" || k === "filter" || k === "slice") return function () { return stub; };
      if (k === "closest") return function () { return null; };
      if (k === "contains" || k === "hasAttribute" || k === "matches") return function () { return false; };
      return stub;
    },
    set() { return true; },
    apply() { return stub; },
    construct() { return stub; },
    has() { return true; },
  });
  return stub;
}

/** fetch 桩：把 data/xxx.json 映射到数据集目录；取不到就当 404（前端本来就有 catch） */
function makeFetch(dir) {
  return function (url) {
    const u = String(url || "");
    const rel = u.replace(/^\.?\//, "").replace(/^data\//, "");
    try {
      const txt = fs.readFileSync(path.join(dir, rel), "utf8");
      const data = JSON.parse(txt);
      return Promise.resolve({ ok: true, status: 200, json: function () { return Promise.resolve(data); }, text: function () { return Promise.resolve(txt); } });
    } catch (e) {
      return Promise.reject(new Error("404 " + u));
    }
  };
}

/** 在 vm 里加载 app.js **真实源码**，并等 data/*.json 加载完成 */
async function loadLogic(logic, dir) {
  const src = patch(appSource(logic));
  const stub = makeStub();
  const sandbox = {
    console: { log() {}, warn() {}, error() {}, info() {} },
    fetch: makeFetch(dir),
    document: stub, window: stub, location: stub, navigator: stub,
    localStorage: stub, sessionStorage: stub, history: stub,
    setTimeout: function (fn, ms) { const t = setTimeout(fn, ms); if (t.unref) t.unref(); return t; },
    clearTimeout: function (t) { clearTimeout(t); },
    setInterval: function () { return 0; }, clearInterval: function () {},
    requestAnimationFrame: function () { return 0; },
    Blob: function () {}, URL: { createObjectURL: function () { return ""; }, revokeObjectURL: function () {} },
  };
  sandbox.globalThis = sandbox;
  const ctx = vm.createContext(sandbox);
  vm.runInContext(src, ctx, { filename: "web/app.js@" + logic });
  const L = ctx.__RADAR_LOGIC__;
  if (!L) throw new Error("导出钩子没跑到：app.js 顶层同步抛错了");
  for (let i = 0; i < 500; i++) {
    if (L.games && (L.games.items || []).length) break;
    await new Promise(function (r) { setTimeout(r, 20); });
  }
  if (!L.games || !(L.games.items || []).length) throw new Error("games.json 没进沙箱（数据集缺文件 / fetch 桩路径不对）");
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
    a.rows.push({ name: g.name, k: v.k, t: v.t, score: r.score, leadDays: r.leadDays, lagDays: (r.lag && r.lag.lagDays != null) ? r.lag.lagDays : null, comp: cs, src: g.src });
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