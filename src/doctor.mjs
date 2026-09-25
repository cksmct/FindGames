#!/usr/bin/env node
/**
 * 体检：node src/doctor.mjs [--data <dir>] [--peer <gitref>] [--strict] [--files-only]
 *
 * 两类检查：
 *   ① 文件体检 —— 控制字符 / BOM / 孤立 CR / markdown 围栏
 *      （这些是"肉眼几乎看不出来、但在 GitHub 上会出事"的问题：踩过一次 README 末尾混入
 *       UTF-16 垃圾，表现为"README 在 GitHub 上是一坨没排版的大段文字"）
 *   ② 数据体检 —— 产物新鲜度 / 覆盖率 / lead 分布 / 本地 vs radar-data
 *      （判级与排序跑在浏览器里，只看页面看不出"这一份数据其实是 20 小时前的快照"、
 *       "firstSeenAt 一条都没回填"、"竞争记录还是旧口径"这类结构性问题）
 *
 * 退出码：文件问题 = 1（可挂 CI 当门禁）；数据问题默认只报警告，加 --strict 才阻断。
 */
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { ROOT, parseArgs } from "./lib/util.mjs";

const args = parseArgs();
const SKIP_DIRS = new Set([".git", "node_modules", "data", "export", "dist", ".next", "out"]);
const TEXT_EXT = new Set([
  ".md", ".mjs", ".js", ".cjs", ".json", ".yml", ".yaml", ".css", ".html", ".txt", ".gitignore", "",
]);

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      walk(path.join(dir, e.name), out);
    } else out.push(path.join(dir, e.name));
  }
  return out;
}

const problems = [];
const files = walk(ROOT).filter((f) => TEXT_EXT.has(path.extname(f).toLowerCase()) || path.basename(f) === ".gitignore");

for (const abs of files) {
  const rel = path.relative(ROOT, abs).replace(/\\/g, "/");
  const buf = fs.readFileSync(abs);
  const text = buf.toString("utf8");

  // ① 控制字符（Tab / LF / CR 除外）
  const ctrl = [];
  for (let i = 0; i < buf.length; i++) {
    const c = buf[i];
    if (c === 0x09 || c === 0x0a || c === 0x0d) continue;
    if (c < 0x20 || c === 0x7f) ctrl.push(i);
  }
  if (ctrl.length) {
    problems.push(`${rel}: ${ctrl.length} 个控制字符（首个在字节 ${ctrl[0]}）—— GitHub 会当二进制、拒绝渲染 markdown`);
  }

  // BOM
  if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) problems.push(`${rel}: 带 UTF-8 BOM`);

  // ③ 行尾符
  const loneCr = (text.match(/\r(?!\n)/g) || []).length;
  if (loneCr) problems.push(`${rel}: ${loneCr} 个孤立 CR（行尾符混用，markdown 可能整篇不换行）`);

  // ② markdown 围栏
  if (rel.endsWith(".md")) {
    const lines = text.split(/\r?\n/);
    let open = false, openAt = 0;
    lines.forEach((ln, i) => {
      if (/^\s*```/.test(ln)) {
        if (!open) { open = true; openAt = i + 1; }
        else open = false;
      }
    });
    if (open) problems.push(`${rel}: 第 ${openAt} 行的 \`\`\` 未闭合 —— 后面所有内容都会被吞进代码块`);
  }
}

console.log(`文件体检：已检查 ${files.length} 个文本文件`);
if (!problems.length) {
  console.log("  ✓ 全部干净：无控制字符、无 BOM、无孤立 CR、markdown 围栏全部闭合");
} else {
  console.log("  发现 " + problems.length + " 个问题：");
  for (const p of problems) console.log("  ✗ " + p);
}

// ── ② 数据体检 ──
const warns = [];
const dataDir = args.data ? path.resolve(ROOT, String(args.data)) : path.join(ROOT, "data");
const HOUR = 3600000;

/** 中文列宽按 2 字符算（终端里中文占两格，否则表格会错位） */
function pad(s, n) {
  s = String(s == null ? "" : s);
  let w = 0;
  for (const ch of s) w += ch.codePointAt(0) > 0x2e80 ? 2 : 1;
  return s + " ".repeat(Math.max(0, n - w));
}
function readData(f) {
  try { return JSON.parse(fs.readFileSync(path.join(dataDir, f), "utf8")); } catch { return null; }
}
function hoursAgo(isoStr) {
  if (!isoStr) return null;
  const t = new Date(isoStr).getTime();
  return isFinite(t) ? (Date.now() - t) / HOUR : null;
}
function fmtAge(h) { return h == null ? "时间戳缺失" : (h < 48 ? h.toFixed(1) + " 小时前" : (h / 24).toFixed(1) + " 天前"); }
const pct = (n, total) => (total ? ((n / total) * 100).toFixed(1) + "%" : "0%");

/** 覆盖率：每个字段"有多少条真的拿到了"，而不是有多少条存在 */
function coverage(items) {
  const out = {};
  for (const g of items) {
    const st = g.stats || {};
    const plt = st.platform || (st.visits != null ? "roblox" : "none");
    const plats = (out.platform = out.platform || {});
    plats[plt] = (plats[plt] || 0) + 1;
  }
  out.statsOfficial = items.filter((g) => g.stats && (g.stats.created || g.stats.visits != null || g.stats.playing != null || g.stats.ratings != null)).length;
  out.series = items.filter((g) => (g.series || []).length >= 8).length;
  out.words = items.filter((g) => (g.words || []).length > 0).length;
  out.firstSeenAt = items.filter((g) => !!g.firstSeenAt).length;
  out.serpCurrent = items.filter((g) => g.serp && g.serp.dedicated != null).length;
  out.serpLegacy = items.filter((g) => g.serp && g.serp.dedicated == null).length;
  out.serpMissing = items.length - out.serpCurrent - out.serpLegacy;
  out.statsStale = items.filter((g) => {
    const t = g.statsAt || (g.stats && g.stats.fetchedAt);
    const h = hoursAgo(t);
    return h != null && h > 48;
  }).length;
  return out;
}

/** 发现提前量（与前端 discoveryLeadDays 同一口径：官方上线日 −（firstSeenAt || first），仅上线 ≤365 天可算） */
function leadStats(items) {
  const buckets = [
    ["发售前 ≥30 天", (d) => d >= 30],
    ["发售前 7~30 天", (d) => d >= 7 && d < 30],
    ["发售前 0~7 天", (d) => d > 0 && d < 7],
    ["上线后 0~7 天", (d) => d <= 0 && d >= -7],
    ["上线后 7~30 天", (d) => d < -7 && d >= -30],
    ["上线后 30~90 天", (d) => d < -30 && d >= -90],
    ["上线后 >90 天", (d) => d < -90],
  ].map((b) => ({ label: b[0], hit: b[1], n: 0 }));
  const vals = [];
  let positive = 0, fromFirstSeen = 0;
  for (const g of items) {
    const c = (g.stats && g.stats.created) || g.srcCreated;
    if (!c) continue;
    const ageDays = (Date.now() - new Date(c).getTime()) / 86400000;
    if (!(ageDays <= 365)) continue;                 // 与前端一致：老游戏该维度不适用（权重跳过）
    const f = g.firstSeenAt || g.first;
    if (!f) continue;
    if (g.firstSeenAt) fromFirstSeen++;
    const d = (new Date(c).getTime() - new Date(f).getTime()) / 86400000;
    if (!isFinite(d)) continue;
    vals.push(d);
    if (d > 0) positive++;
    for (const b of buckets) if (b.hit(d)) { b.n++; break; }
  }
  vals.sort((a, b) => a - b);
  return { n: vals.length, median: vals.length ? vals[Math.floor(vals.length / 2)] : null, positive, fromFirstSeen, buckets };
}

function dataReport() {
  console.log("");
  console.log("数据体检：" + dataDir + (args["files-only"] ? "（--files-only：已跳过）" : ""));
  if (args["files-only"]) return;
  const games = readData("games.json");
  if (!games) {
    console.log("  ✗ 读不到 games.json —— 先跑一次 npm run collect");
    warns.push("games.json 缺失");
    return;
  }
  const items = games.items || [];

  // ① 产物新鲜度
  console.log("");
  console.log("  产物新鲜度（采集每小时一轮；本地只有跑过 collect 才会更新）");
  const freshFiles = [["trends.json", 3], ["games.json", 6], ["watchlist.json", 6], ["keywords.json", 6], ["history.json", 6]];
  for (const [f, maxH] of freshFiles) {
    const doc = readData(f);
    const h = hoursAgo(doc && doc.updated);
    const bad = h == null || h > maxH;
    console.log("    " + pad(f, 18) + pad(doc && doc.updated ? String(doc.updated).slice(0, 19).replace("T", " ") : "—", 22) + pad(fmtAge(h), 14) + (bad ? "⚠️ 阈值 " + maxH + "h" : "✓"));
    if (bad) warns.push(f + " 不新鲜（" + fmtAge(h) + "，阈值 " + maxH + " 小时）");
  }

  // ② 覆盖率
  const c = coverage(items);
  console.log("");
  console.log("  覆盖率（games.json " + items.length + " 条）");
  const cov = [
    ["官方数据 stats", c.statsOfficial],
    ["7 天曲线 series", c.series],
    ["可做攻略词 words", c.words],
    ["潜伏首见 firstSeenAt", c.firstSeenAt],
    ["竞争记录（当前口径）", c.serpCurrent],
    ["竞争记录（旧口径·不作数）", c.serpLegacy],
  ];
  for (const [label, n] of cov) console.log("    " + pad(label, 28) + pad(n, 8) + pct(n, items.length));
  console.log("    " + pad("平台构成", 28) + Object.entries(c.platform || {}).sort((a, b) => b[1] - a[1]).map((e) => e[0] + " " + e[1]).join(" · "));
  console.log("    " + pad("官方数据超过 48h", 28) + c.statsStale + (c.statsStale ? "（Roblox 侧每小时刷一批，超过 48h 说明这一条很久没被刷到）" : ""));
  if (c.serpLegacy) warns.push("竞争记录里有 " + c.serpLegacy + " 条旧口径（无 dedicated）—— 前后端都已当未测，等重测补齐");
  if (!c.firstSeenAt) warns.push("firstSeenAt 一条都没有 —— lead（发现提前量，权重 24）只能拿雷达入库时间兜底，恒为负");

  // ③ lead 分布
  const L = leadStats(items);
  console.log("");
  console.log("  发现提前量 lead（官方上线日 − 我们首见日；仅上线 ≤365 天的条目可算）");
  console.log("    可算 " + L.n + " 条 · 其中用 firstSeenAt 的 " + L.fromFirstSeen + " 条 · 中位 " +
    (L.median == null ? "—" : Math.round(L.median * 10) / 10 + " 天") + " · 发售前发现(lead>0) " + L.positive + " 条（" + pct(L.positive, L.n) + "）");
  console.log("    " + L.buckets.map((b) => b.label + " " + b.n).join(" ｜ "));

  // ④ 本地 vs radar-data（CI 每小时的快照；本地 data/ 只有跑过 collect 才更新）
  const ref = args.peer ? String(args.peer) : "origin/radar-data";
  console.log("");
  console.log("  本地 vs " + ref + "（本地缓存的远端引用；要最新先 git fetch origin radar-data）");
  let peer = null;
  try {
    const buf = execFileSync("git", ["show", ref + ":data/games.json"], { cwd: ROOT, maxBuffer: 512 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] });
    peer = JSON.parse(buf.toString("utf8"));
  } catch (e) { peer = null; }
  if (!peer) {
    console.log("    ⚠️ 取不到 " + ref + " 的 data/games.json —— 先 git fetch origin radar-data（本地结果不代表线上）");
    warns.push("取不到 " + ref + "，无法核对线上是否更新");
  } else {
    const lh = hoursAgo(games.updated);
    const ph = hoursAgo(peer.updated);
    console.log("    远端 " + pad(String(peer.updated || "").slice(0, 19).replace("T", " "), 22) + pad(fmtAge(ph), 14) + (peer.items || []).length + " 条");
    console.log("    本地 " + pad(String(games.updated || "").slice(0, 19).replace("T", " "), 22) + pad(fmtAge(lh), 14) + items.length + " 条");
    const pc = coverage(peer.items || []);
    console.log("    远端覆盖率：首见 " + pc.firstSeenAt + " · 旧口径竞争 " + pc.serpLegacy + " · 当前口径竞争 " + pc.serpCurrent);
    if (ph != null && lh != null && lh > ph) {
      console.log("    ⚠️ 本地落后线上 " + (lh - ph).toFixed(1) + " 小时（少 " + ((peer.items || []).length - items.length) + " 条）—— **本地复算的判级分布不代表线上现状**");
      console.log("       线上判级复算：node src/audit-verdicts.mjs --from-ref " + ref + " --top 12");
      warns.push("本地数据落后 " + ref + " " + (lh - ph).toFixed(1) + " 小时");
    } else {
      console.log("    ✓ 本地不落后于线上快照");
    }
  }
}

dataReport();

console.log("");
if (problems.length) {
  console.log("✗ 文件体检有 " + problems.length + " 个问题 → 退出码 1");
  process.exit(1);
}
if (warns.length) {
  console.log((args.strict ? "✗" : "!") + " 数据体检有 " + warns.length + " 条提醒：");
  for (const w of warns) console.log("  · " + w);
  if (args.strict) {
    console.log("  （--strict 生效 → 退出码 1）");
    process.exit(1);
  }
  console.log("  （默认只提醒，不阻断；加 --strict 可当门禁）");
} else {
  console.log("✓ 数据体检无提醒");
}
