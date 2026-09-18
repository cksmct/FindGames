/**
 * 可选：把热搜词翻译成中文（config.translate = true 时启用）
 * 走 Google 翻译的公开端点，无需 key；失败一律静默降级为原名。
 */
import { retry, log } from "./util.mjs";

const cache = new Map();
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";

export async function translateToZh(text, targetLang = "zh-CN") {
  if (!text) return "";
  const key = `${targetLang}|${text}`;
  if (cache.has(key)) return cache.get(key);
  try {
    const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=${targetLang}&dt=t&q=${encodeURIComponent(
      text
    )}`;
    const r = await retry(
      async () => {
        const res = await fetch(url, { headers: { "user-agent": UA } });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
      },
      { retries: 2, label: `translate/${text}` }
    );
    const out = (r?.[0] || []).map((seg) => seg?.[0] || "").join("").trim();
    cache.set(key, out);
    return out;
  } catch (e) {
    log("dim", `翻译失败(${text}): ${e.message}`);
    cache.set(key, "");
    return "";
  }
}
