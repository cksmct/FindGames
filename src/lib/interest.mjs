/**
 * Google Trends 兴趣曲线 / 相关查询层（新游戏雷达用）
 *
 * 两步走：
 *   1) GET  /trends/api/explore            → 拿到 widgets(token)
 *   2) GET  /trends/api/widgetdata/multiline?token=...  → 7 天逐小时(169 点)兴趣值
 *   相关查询走 /trends/api/widgetdata/relatedsearches
 */
import { log, retry } from "./util.mjs";
import { UA } from "./trends.mjs";

const BASE = "https://trends.google.com/trends/api";

function headers(session, referer) {
  const h = {
    "user-agent": UA,
    "accept-language": session.hl || "en-US",
    referer,
  };
  if (session.cookie) h.cookie = session.cookie;
  return h;
}

function stripPrefix(text) {
  return JSON.parse(text.replace(/^\)\]\}',?\s*/, ""));
}

/** 获取 explore 页的 widgets */
export async function explore(session, keyword, geo, timeframe = "now 7-d") {
  const req = {
    comparisonItem: [{ keyword, geo, time: timeframe }],
    category: 0,
    property: "",
  };
  const url = `${BASE}/explore?hl=${session.hl || "en-US"}&tz=${session.tz || "-480"}&req=${encodeURIComponent(
    JSON.stringify(req)
  )}`;
  const referer = `https://trends.google.com/trends/explore?q=${encodeURIComponent(keyword)}&geo=${geo}`;
  const text = await retry(
    async () => {
      const r = await fetch(url, { headers: headers(session, referer) });
      if (r.status === 429) throw new Error("429 限流");
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.text();
    },
    // explore 与 multiline 两个接口都会限流，退避统一拉长
    { retries: 4, base: 2500, label: `explore/${keyword}` }
  );
  return stripPrefix(text).widgets || [];
}

/**
 * 取 7 天兴趣曲线
 * @returns {{series:number[], points:{t:string,v:number}[], peak:number}}
 */
export async function fetchInterest(session, keyword, geo, opts = {}) {
  const { timeframe = "now 7-d", sampleEveryHours = 4 } = opts;
  const widgets = await explore(session, keyword, geo, timeframe);
  const ts = widgets.find((w) => w.id === "TIMESERIES");
  if (!ts) return null;

  const url = `${BASE}/widgetdata/multiline?hl=${session.hl || "en-US"}&tz=${
    session.tz || "-480"
  }&req=${encodeURIComponent(JSON.stringify(ts.request))}&token=${ts.token}`;
  const referer = `https://trends.google.com/trends/explore?q=${encodeURIComponent(keyword)}&geo=${geo}`;
  const text = await retry(
    async () => {
      const r = await fetch(url, { headers: headers(session, referer) });
      if (r.status === 429) throw new Error("429 限流");
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.text();
    },
    // 曲线接口限流明显更严，退避拉长
    { retries: 4, base: 2500, label: `multiline/${keyword}` }
  );

  const raw = (stripPrefix(text).default?.timelineData) || [];
  const points = raw.map((p) => ({
    t: new Date(Number(p.time) * 1000).toISOString(),
    v: Number(p.value?.[0]) || 0,
  }));
  const step = Math.max(1, Math.round(sampleEveryHours));
  const sampled = points.filter((_, i) => i % step === 0);
  const series = sampled.map((p) => p.v);
  return {
    series,
    points: sampled,
    peak: series.length ? Math.max(...series) : 0,
  };
}

/**
 * 相关查询(上升 + 热门) —— 扩词用
 * @returns {{top:string[], rising:string[]}}
 */
export async function fetchRelatedQueries(session, keyword, geo, timeframe = "now 7-d") {
  const widgets = await explore(session, keyword, geo, timeframe);
  const w = widgets.find((x) => x.id === "RELATED_QUERIES");
  if (!w) return { top: [], rising: [] };
  const url = `${BASE}/widgetdata/relatedsearches?hl=${session.hl || "en-US"}&tz=${
    session.tz || "-480"
  }&req=${encodeURIComponent(JSON.stringify(w.request))}&token=${w.token}`;
  const referer = `https://trends.google.com/trends/explore?q=${encodeURIComponent(keyword)}&geo=${geo}`;
  try {
    const r = await fetch(url, { headers: headers(session, referer) });
    if (!r.ok) return { top: [], rising: [] };
    const d = stripPrefix(await r.text());
    const lists = d.default?.rankedList || [];
    const pick = (ranked) => (ranked?.rankedKeyword || []).map((k) => k.query).filter(Boolean);
    return { top: pick(lists[0]), rising: pick(lists[1]) };
  } catch (e) {
    log("dim", `related/${keyword} 跳过: ${e.message}`);
    return { top: [], rising: [] };
  }
}

/** 判断曲线是否为"新近起飞"：后半段均值显著高于前半段 */
export function hypeRatio(series) {
  if (!series || series.length < 8) return 0;
  const mid = Math.floor(series.length / 2);
  const first = series.slice(0, mid);
  const last = series.slice(mid);
  const avg = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
  const f = avg(first);
  const l = avg(last);
  if (f <= 0.5 && l > 0) return 99; // 从零起步 = 全新
  return f > 0 ? Number((l / f).toFixed(2)) : 0;
}
