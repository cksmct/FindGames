#!/usr/bin/env node
/**
 * 文件体检：node src/doctor.mjs
 *
 * 检查三类"肉眼几乎看不出来、但在 GitHub 上会出事"的问题：
 *   ① 控制字符（NUL 等）—— 会让 GitHub 把文件判定为二进制，从而【拒绝渲染 markdown】，
 *      直接原样显示源码。踩过一次：README 末尾混入一段 UTF-16 垃圾（13 个 NUL），
 *      表现为"README 在 GitHub 上是一坨没排版的大段文字"。
 *   ② markdown 代码围栏不闭合 —— 一个未闭合的 ``` 会把后面所有内容吞进代码块。
 *   ③ 行尾符混用 —— 孤立 CR 会让 markdown 解析器把整个文件当成一行。
 *
 * 退出码：有问题 = 1（可以挂进 CI 当门禁）
 */
import fs from "node:fs";
import path from "node:path";
import { ROOT } from "./lib/util.mjs";

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

console.log(`已检查 ${files.length} 个文本文件`);
if (!problems.length) {
  console.log("✓ 全部干净：无控制字符、无 BOM、无孤立 CR、markdown 围栏全部闭合");
  process.exit(0);
}
console.log("\n发现 " + problems.length + " 个问题：");
for (const p of problems) console.log("  ✗ " + p);
process.exit(1);
