/**
 * 取网页层（通用）—— **直连优先，curl 兜底**。
 *
 * 为什么需要它（2026-09-21 用户质问"为什么走 Wayback，不能直接抓吗"，实测结论）：
 *   Cloudflare 拦的不是 User-Agent，而是 **TLS / HTTP-2 指纹**。
 *   · Node 的 `fetch`（undici）握手特征明显不是浏览器 → 对 bloxinformer.com 稳定返回
 *     403「Attention Required / you have been blocked」（改 UA、加 header 都没用）；
 *   · 无头 Chrome（`--headless=new --dump-dom`）同样被硬拦（更严格的规则）；
 *   · **`curl.exe`（Windows 10+ / Linux 自带）却能直接 200**，拿到完整 38KB 页面。
 *   所以正确姿势不是"退回存档"，而是"换一个指纹像正常客户端的取页器"。
 *
 * 两条通道：
 *   ① `fetch`：最快、无进程开销，绝大多数站点够用；
 *   ② `curl` ：只在 ① 拿到 403/挑战页时启用（Schannel/OpenSSL 指纹，实测能过 CF）。
 *
 * 🛑 判定"挑战页"必须看**内容特征**而不是只看状态码：CF 的托管挑战经常返回 200 + 一段 JS。
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { log } from "./util.mjs";

const run = promisify(execFile);

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";
const ACCEPT = "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8";

/** 被 Cloudflare / 人机验证挡住的特征（页面很短 + 命中这些串） */
const CHALLENGE_MARKERS = [
  "Attention Required!",
  "Just a moment",
  "_cf_chl_opt",
  "cf-error-details",
  "you have been blocked",
  "Enable JavaScript and cookies to continue",
  "Checking your browser before accessing",
];

export function looksLikeChallenge(html) {
  const s = String(html || "");
  if (s.length > 60000) return false; // 真页面通常远大于挑战页
  return CHALLENGE_MARKERS.some((m) => s.includes(m));
}

/** curl 直取（stdout 取字节后按 UTF-8 解，避免 Windows 终端编码问题） */
export async function curlGet(url, { timeoutMs = 30000, label = "curl" } = {}) {
  const bin = process.platform === "win32" ? "curl.exe" : "curl";
  const args = [
    "-sS", "-L", "--compressed",
    "--max-time", String(Math.max(5, Math.round(timeoutMs / 1000))),
    "-A", UA,
    "-H", "Accept: " + ACCEPT,
    "-H", "Accept-Language: en-US,en;q=0.9",
    "-H", "Sec-Fetch-Mode: navigate",
    "-H", "Sec-Fetch-Site: none",
    "-H", "Upgrade-Insecure-Requests: 1",
    "-w", "\n__STATUS__%{http_code}",
    url,
  ];
  const { stdout } = await run(bin, args, { encoding: "buffer", maxBuffer: 64 * 1024 * 1024 });
  let text = Buffer.isBuffer(stdout) ? stdout.toString("utf8") : String(stdout);
  let status = 0;
  const m = text.match(/\n__STATUS__(\d{3})\s*$/);
  if (m) { status = Number(m[1]); text = text.slice(0, m.index); }
  if (status && (status < 200 || status >= 300)) throw new Error(label + " HTTP " + status);
  return text;
}

/**
 * 取一个页面：先 fetch，遇到拦截再 curl。
 * @returns {Promise<{html:string, via:"fetch"|"curl", status:number}>}
 * @throws 两条通道都失败时抛错（调用方决定回退到缓存还是存档）
 */
export async function fetchPage(url, { timeoutMs = 30000, label = "page", forceCurl = false } = {}) {
  const errors = [];

  if (!forceCurl) {
    try {
      const r = await fetch(url, {
        headers: { "user-agent": UA, accept: ACCEPT, "accept-language": "en-US,en;q=0.9" },
        redirect: "follow",
        signal: AbortSignal.timeout(timeoutMs),
      });
      const html = await r.text();
      if (r.ok && !looksLikeChallenge(html)) return { html, via: "fetch", status: r.status };
      errors.push(`fetch HTTP ${r.status}${looksLikeChallenge(html) ? "（人机验证页）" : ""}`);
    } catch (e) {
      errors.push("fetch " + e.message);
    }
  }

  try {
    const html = await curlGet(url, { timeoutMs, label: label + "/curl" });
    if (!looksLikeChallenge(html)) return { html, via: "curl", status: 200 };
    errors.push("curl 也拿到人机验证页");
  } catch (e) {
    errors.push("curl " + e.message);
  }

  throw new Error(`${label} 取页失败：${errors.join(" · ")}`);
}

/** 需要时把过程写进日志（默认静默，避免每轮刷屏） */
export function logFetch(result, label) {
  if (result && result.via === "curl") log("dim", `  ${label}：走 curl 通道（Node fetch 被拦截）`);
}
