/**
 * 判级引擎装载器：把 `web/app.js` 的**真实判级逻辑**装进 node 的 vm。
 *
 * 为什么要有这个模块：`rankability` / `pickVerdict` 是"页面上的口径"，抄第二份必然漂移
 * （设计铁律 7）。而两个地方都要用它 ——
 *   · 采集端：每轮把判级结果写进历史归档（`src/lib/verdict-history.mjs`）
 *   · 验收端：`src/audit-verdicts.mjs` 复算分布、做修复前后对照
 * 所以抽到这里，单一事实源。
 *
 * 用法（`files` 与 `dir` 可同时给：`files` 优先，缺的从 `dir` 读盘）：
 *   const L = await loadEngine({ files: { "games.json": doc, "config.json": publicCfg }, dir: dataDir });
 *   const r = L.rankability(item);      // 分数 / 分项 / 缺项 / 竞争来源 / lead
 *   const v = L.pickVerdict(item, r);   // { k: yes|warn|no|unknown, t, why }
 * 🛑 `files` 里的 `config.json` 必须是**下发版**（含 competition），否则人工竞争判断读不到。
 * 🛑 另一个坑（2026-09-25 实测踩到）：app.js 把 config.json 的 fetch **嵌在 trends.json 的 .then 里** ——
 *    所以必须同时能拿到 trends.json（`dir` 里有，或 `files` 里给一份），否则 `applyTrendsConfig` 根本不跑、
 *    人工竞争判断静默为空。loadEngine 会自检这一点并写进 `L.__warnings`。
 */
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { execFileSync } from "node:child_process";
import { ROOT } from "./util.mjs";

/** app.js 源码：current = 工作区文件；其它值 = 某个 git 版本（做"旧口径 vs 新口径"对照用） */
export function appSourceOf(logic) {
  if (!logic || logic === "current") return fs.readFileSync(path.join(ROOT, "web", "app.js"), "utf8");
  return execFileSync("git", ["show", logic + ":web/app.js"], { cwd: ROOT, maxBuffer: 64 * 1024 * 1024 }).toString("utf8");
}

/**
 * 注入只读导出钩子：插在「切换」段之前（纯函数定义之后、事件绑定之前）。
 * 用 eval 逐个取名并 null 兜底 —— 跨版本对照时旧版缺少某个函数也不会整体报错。
 */
const HOOK = `
  // ── Node 复算钩子（src/lib/verdict.mjs 注入；浏览器里不存在这一段）──
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
    PICK_LABEL: __auditPick("PICK_LABEL"),
    // 潜伏列表的两行渲染（2026-09-26）：验收"走建站推荐评估"改成可操作后到底长什么样
    assessCell: __auditPick("assessCell"),
    watchRowHtml: __auditPick("watchRowHtml"),
    storeLinkHtml: __auditPick("storeLinkHtml"),
    gameByName: __auditPick("gameByName"),
    get watch() { return __auditPick("watch"); },
    // 口径常量（2026-09-25）：缺项按中性值计入固定分母 —— 工具直接取，别自己写一份
    PICK_NEUTRAL: __auditPick("PICK_NEUTRAL"),
    PICK_W_TOTAL: __auditPick("PICK_W_TOTAL"),
    // 前端两个「分数明细」渲染函数（2026-09-25）：只为冒烟验证不抛错，不重算分数
    scoreDetail: __auditPick("scoreDetail"),
    pickDetail: __auditPick("pickDetail"),
    get games() { return __auditPick("games"); },
    get manualComp() { return __auditPick("MANUAL_COMP"); },
  };
`;

export function patchSource(src) {
  const anchor = "\n  // ── 切换 ──";
  if (src.includes(anchor)) return src.replace(anchor, function () { return HOOK + anchor; });
  const tail = "\n})();";
  if (!src.includes(tail)) throw new Error("app.js 结构变了：找不到注入锚点（切换段 / IIFE 收尾）—— 更新 src/lib/verdict.mjs 的锚点");
  return src.replace(tail, function () { return HOOK + tail; });
}

/** 万能 DOM 桩：任何属性 / 调用都返回它自己（我们只取纯函数，不校验渲染） */
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

/**
 * fetch 桩：`data/xxx.json` → 先查内存 `files`（键是文件名），没有再读 `dir` 里的文件；都没有就当 404。
 * 为什么两种都要：调用方常常只想覆盖其中几个（例如"用**刚算出来的** games.json 去判级"），
 * 而 app.js 还依赖别的产物（trends.json —— 见文件头的坑）。
 */
function makeFetch({ files = null, dir = null } = {}) {
  return function (url) {
    const u = String(url || "");
    const rel = u.replace(/^\.?\//, "").replace(/^data\//, "");
    let doc;
    if (files && Object.prototype.hasOwnProperty.call(files, rel)) doc = files[rel];
    else if (dir) {
      try { doc = JSON.parse(fs.readFileSync(path.join(dir, rel), "utf8")); } catch (e) { doc = undefined; }
    }
    if (doc === undefined) return Promise.reject(new Error("404 " + u));
    return Promise.resolve({
      ok: true, status: 200,
      json: function () { return Promise.resolve(doc); },
      text: function () { return Promise.resolve(JSON.stringify(doc)); },
    });
  };
}

/**
 * 装载引擎并等产物进沙箱，返回 app.js 作用域里的真实函数（用法见文件头）。
 * 🛑 结构变化 / 超时一律抛错，**不吞**：调用方负责降级（采集端 catch 后照常出产物）。
 */
export async function loadEngine({ files = null, dir = null, appSource: src = null, logic = "current", filename = "web/app.js", timeoutMs = 8000 } = {}) {
  const patched = patchSource(src || appSourceOf(logic));
  const stub = makeStub();
  const warnings = [];
  const sandbox = {
    console: { log() {}, warn() {}, error() {}, info() {} },
    fetch: makeFetch({ files: files, dir: dir }),
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
  vm.runInContext(patched, ctx, { filename: filename + "@" + logic });
  const L = ctx.__RADAR_LOGIC__;
  if (!L) throw new Error("导出钩子没跑到：app.js 顶层同步抛错了");
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (L.games && (L.games.items || []).length) break;
    await new Promise(function (r) { setTimeout(r, 20); });
  }
  if (!L.games || !(L.games.items || []).length) throw new Error("games.json 没进沙箱（files / dir 里没给 games.json？）");
  // 让其它产物的 .then 链跑完：config.json 的 fetch 嵌在 trends.json 的 .then 里（见文件头）
  await new Promise(function (r) { setTimeout(r, 30); });
  const wantsComp = !!(files && files["config.json"] && files["config.json"].competition &&
    Object.keys(files["config.json"].competition).length);
  if (wantsComp && !Object.keys(L.manualComp || {}).length) {
    await new Promise(function (r) { setTimeout(r, 60); });
    if (!Object.keys(L.manualComp || {}).length) {
      warnings.push("人工竞争判断没进引擎：app.js 把 config.json 的 fetch 嵌在 trends.json 的 .then 里，必须同时提供 trends.json（dir 里有，或 files 里给一份）");
    }
  }
  Object.defineProperty(L, "__warnings", { value: warnings, enumerable: false });
  return L;
}
