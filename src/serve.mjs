#!/usr/bin/env node
/**
 * 本地静态服务
 *   node src/serve.mjs                     开发模式：web/ + data/
 *   node src/serve.mjs --root dist         预览生产构建产物（与 Cloudflare/Pages 上的目录结构一致）
 *   node src/serve.mjs --port 8787
 */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { loadConfig, parseArgs, ROOT, dataPath, log } from "./lib/util.mjs";

const args = parseArgs();
const cfg = loadConfig();
const PORT = Number(args.port) || 8787;
// --root 时整个目录按原样静态托管（模拟线上）
const PREVIEW_ROOT = args.root ? path.resolve(ROOT, String(args.root)) : null;

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
};

/** 解析出「文件路径 + 该路径所属的根目录」用于越权校验 */
function resolve(url) {
  if (PREVIEW_ROOT) {
    return { file: path.join(PREVIEW_ROOT, url.replace(/^\/+/, "")), root: PREVIEW_ROOT };
  }
  if (url.startsWith("/data/")) {
    const root = dataPath(cfg);
    return { file: path.join(root, url.slice("/data/".length)), root };
  }
  return { file: path.join(ROOT, "web", url.replace(/^\/+/, "")), root: path.join(ROOT, "web") };
}

const server = http.createServer((req, res) => {
  let url = decodeURIComponent((req.url || "/").split("?")[0]);
  if (url.endsWith("/")) url += "index.html";
  if (url === "/index.html" || url === "/") url = "/index.html";

  const { file, root } = resolve(url);

  if (!path.resolve(file).startsWith(path.resolve(root))) {
    res.writeHead(403).end("forbidden");
    return;
  }
  fs.readFile(file, (err, buf) => {
    if (err) {
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" }).end("404 " + url);
      return;
    }
    res.writeHead(200, {
      "content-type": MIME[path.extname(file).toLowerCase()] || "application/octet-stream",
      "cache-control": "no-store",
    });
    res.end(buf);
  });
});

server.listen(PORT, () => {
  log("ok", `看板已启动 → http://localhost:${PORT}/`);
  log("dim", PREVIEW_ROOT ? `托管目录（生产预览） ${PREVIEW_ROOT}` : `开发模式 · 数据目录 ${dataPath(cfg)}`);
});
