import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 读取配置(config.json)，可被命令行覆盖 */
export function loadConfig() {
  const file = path.join(ROOT, "config.json");
  const cfg = JSON.parse(fs.readFileSync(file, "utf8"));
  return cfg;
}

export function parseArgs(argv = process.argv.slice(2)) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) out[key] = true;
      else { out[key] = next; i++; }
    } else out._.push(a);
  }
  return out;
}

/** 带指数退避的重试 */
export async function retry(fn, { retries = 3, base = 800, label = "" } = {}) {
  let lastErr;
  for (let i = 0; i <= retries; i++) {
    try {
      return await fn(i);
    } catch (e) {
      lastErr = e;
      if (i === retries) break;
      const wait = base * Math.pow(2, i);
      log("warn", `${label} 失败(${e.message})，${wait}ms 后重试 ${i + 1}/${retries}`);
      await sleep(wait);
    }
  }
  throw lastErr;
}

const COLORS = { info: "\x1b[36m", ok: "\x1b[32m", warn: "\x1b[33m", err: "\x1b[31m", dim: "\x1b[90m" };
const useColor = process.stdout.isTTY;

export function log(level, msg) {
  const tag = { info: "·", ok: "✓", warn: "!", err: "✗", dim: " " }[level] || "·";
  const c = useColor ? COLORS[level] || "" : "";
  const rst = useColor ? "\x1b[0m" : "";
  console.log(`${c}${tag} ${msg}${rst}`);
}

export function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

export function writeJson(file, data, pretty = false) {
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, pretty ? JSON.stringify(data, null, 2) : JSON.stringify(data));
}

export function readJson(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

export function dataPath(cfg, ...parts) {
  return path.join(ROOT, cfg.dataDir || "data", ...parts);
}

/** 并发受限的 map */
export async function pMap(items, worker, concurrency = 3) {
  const results = new Array(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (cursor < items.length) {
      const i = cursor++;
      results[i] = await worker(items[i], i);
    }
  });
  await Promise.all(runners);
  return results;
}

export const iso = (d = new Date()) => d.toISOString();

/** 相对时间(用于报表) */
export function relTime(isoStr, now = Date.now()) {
  if (!isoStr) return "";
  const m = Math.round((now - new Date(isoStr).getTime()) / 60000);
  if (m < 60) return `${m} 分钟前`;
  if (m < 1440) return `${Math.round(m / 60)} 小时前`;
  return `${Math.round(m / 1440)} 天前`;
}

/** 数字缩写 20000 -> 20K */
export function fmtVol(v) {
  if (!v) return "—";
  if (v >= 1e6) return `${v / 1e6}M`;
  if (v >= 1e3) return `${v / 1e3}K`;
  return String(v);
}
