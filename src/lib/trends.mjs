/**
 * Google Trends 采集层
 *
 * 数据源：trends.google.com 的 batchexecute 内部接口 rpcid=i0OFE
 * （即 "Trending Now / 实时上升热搜" 面板背后那一个请求）。
 *
 * 单项返回结构（已实测确认）：
 *   [0]  query      热搜词
 *   [2]  geo        地区码
 *   [3]  [ts]       时间戳(秒)
 *   [6]  vol        搜索量分桶 100/200/.../1000000/2000000
 *   [8]  growth     涨幅分桶 50/75/100/200/.../1000 (%)
 *   [9]  rel[]      相关搜索词(最多 150+)
 *   [10] cats[]     官方分类 ID 数组(可多个)
 */
import { log, retry, sleep } from "./util.mjs";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";

const HOME = "https://trends.google.com/?geo=US";
const BATCH =
  "https://trends.google.com/_/TrendsUi/data/batchexecute?rpcids=i0OFE&hl=en-US&tz=-480&sct=1";

/** 建立会话：拿到 NID 等 cookie，后续请求带上可显著降低被拦概率 */
export async function createSession() {
  const session = { cookie: "", tz: "-480", hl: "en-US" };
  try {
    const r = await fetch(HOME, { headers: { "user-agent": UA, "accept-language": session.hl } });
    const sc = r.headers.getSetCookie ? r.headers.getSetCookie() : [];
    session.cookie = sc.map((c) => c.split(";")[0]).join("; ");
  } catch (e) {
    log("warn", `获取 Google cookie 失败(${e.message})，将不带 cookie 继续`);
  }
  return session;
}

function headers(session, referer) {
  const h = {
    "content-type": "application/x-www-form-urlencoded;charset=UTF-8",
    "user-agent": UA,
    "accept-language": session.hl,
    origin: "https://trends.google.com",
    referer,
  };
  if (session.cookie) h.cookie = session.cookie;
  return h;
}

/** 解析 batchexecute 的 )]}' 前缀响应，取出目标 rpc 的 JSON */
function unwrapBatch(text) {
  for (const line of text.split("\n")) {
    if (!line.includes('"wrb.fr"')) continue;
    try {
      const arr = JSON.parse(line);
      if (arr?.[0]?.[1] !== "i0OFE") continue;
      return JSON.parse(arr[0][2]);
    } catch {
      /* 继续找 */
    }
  }
  return null;
}

/**
 * 拉取某地区的实时上升热搜（原始 item 数组）
 * @param {object} session
 * @param {string} geo 地区码，如 "US"
 * @param {number} hours 观察窗口小时数(实测 48 与 24 差异不大)
 */
export async function fetchRealtime(session, geo, hours = 48) {
  const payload = JSON.stringify([null, null, geo, 0, null, hours, 1]);
  const body = "f.req=" + encodeURIComponent(JSON.stringify([[["i0OFE", payload, null, "generic"]]]));
  const url = BATCH;
  const referer = `https://trends.google.com/trends/trendingsearches/realtime?geo=${geo}&category=all`;

  const text = await retry(
    async () => {
      const r = await fetch(url, { method: "POST", headers: headers(session, referer), body });
      if (r.status === 429) throw new Error("429 限流");
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const t = await r.text();
      if (!t || t.length < 50) throw new Error("空响应");
      return t;
    },
    { label: `trends/${geo}` }
  );

  const data = unwrapBatch(text);
  if (!data || !Array.isArray(data[1])) throw new Error("响应结构异常");
  return data[1];
}

/** 归一化单条 item */
export function normalizeItem(item, geo) {
  const q = typeof item?.[0] === "string" ? item[0].trim() : "";
  if (!q) return null;
  const tsSec = Array.isArray(item[3]) ? item[3][0] : null;
  return {
    q,
    geo: item[2] || geo,
    ts: tsSec ? new Date(tsSec * 1000).toISOString() : null,
    vol: Number(item[6]) || 0,
    growth: Number(item[8]) || 0,
    cats: Array.isArray(item[10]) ? item[10].map(Number).filter(Boolean) : [],
    rel: Array.isArray(item[9]) ? item[9].filter((x) => typeof x === "string" && x.trim()) : [],
  };
}

/** 采集一个地区并归一化 + 同词去重(保留更高搜索量) */
export async function collectGeo(session, geo, opts = {}) {
  const { minVol = 0, maxRelated = 20, hours = 24 } = opts;
  const raw = await fetchRealtime(session, geo, hours);
  const byQ = new Map();
  for (const it of raw) {
    const n = normalizeItem(it, geo);
    if (!n) continue;
    if (n.vol < minVol) continue;
    const prev = byQ.get(n.q);
    if (!prev || n.vol > prev.vol) {
      n.rel = n.rel.slice(0, maxRelated);
      byQ.set(n.q, n);
    }
  }
  return Array.from(byQ.values());
}

export { UA, sleep };
