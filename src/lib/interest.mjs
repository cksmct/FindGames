/**
 * Google Trends 兴趣曲线 / 相关查询层（新游戏雷达用）
 *
 * explore 只调一次，两个 widget 复用同一份 token，所以「曲线 + 相关查询」只比单取曲线多 1 个请求：
 *   1) GET /trends/api/explore                          → widgets(token)
 *   2) GET /trends/api/widgetdata/multiline?token=…      → 7 天逐小时(169 点)兴趣值
 *      GET /trends/api/widgetdata/relatedsearches?token=… → 上升 / 热门相关查询（就是可做页面的攻略词）
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

const refererOf = (keyword, geo) =>
  `https://trends.google.com/trends/explore?q=${encodeURIComponent(keyword)}&geo=${geo}`;

/** 获取 explore 页的 widgets（曲线与相关查询的 token 都在这里） */
export async function explore(session, keyword, geo, timeframe = "now 7-d") {
  const req = {
    comparisonItem: [{ keyword, geo, time: timeframe }],
    category: 0,
    property: "",
  };
  const url = `${BASE}/explore?hl=${session.hl || "en-US"}&tz=${session.tz || "-480"}&req=${encodeURIComponent(
    JSON.stringify(req)
  )}`;
  const text = await retry(
    async () => {
      const r = await fetch(url, { headers: headers(session, refererOf(keyword, geo)) });
      if (r.status === 429) throw new Error("429 限流");
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.text();
    },
    { retries: 4, base: 2500, label: `explore/${keyword}` }
  );
  return stripPrefix(text).widgets || [];
}

/** 取某个 widget 的数据（曲线或相关查询共用） */
async function fetchWidget(session, widget, path, keyword, geo, label) {
  const url = `${BASE}/widgetdata/${path}?hl=${session.hl || "en-US"}&tz=${
    session.tz || "-480"
  }&req=${encodeURIComponent(JSON.stringify(widget.request))}&token=${widget.token}`;
  const text = await retry(
    async () => {
      const r = await fetch(url, { headers: headers(session, refererOf(keyword, geo)) });
      if (r.status === 429) throw new Error("429 限流");
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.text();
    },
    // 曲线/相关查询接口限流明显更严，退避拉长
    { retries: 4, base: 2500, label: `${label}/${keyword}` }
  );
  return stripPrefix(text);
}

/**
 * 一次拿到：7 天曲线 + 上升相关查询 + 热门相关查询
 * @returns {Promise<null|{series:number[], points:{t:string,v:number}[], peak:number, rising:string[], top:string[]}>}
 */
export async function fetchInterest(session, keyword, geo, opts = {}) {
  const { timeframe = "now 7-d", sampleEveryHours = 4, withRelated = true } = opts;
  const widgets = await explore(session, keyword, geo, timeframe);

  const ts = widgets.find((w) => w.id === "TIMESERIES");
  if (!ts) return null;

  const tsData = await fetchWidget(session, ts, "multiline", keyword, geo, "multiline");
  const raw = tsData.default?.timelineData || [];
  const points = raw.map((p) => ({
    t: new Date(Number(p.time) * 1000).toISOString(),
    v: Number(p.value?.[0]) || 0,
  }));
  const step = Math.max(1, Math.round(sampleEveryHours));
  const sampled = points.filter((_, i) => i % step === 0);
  const series = sampled.map((p) => p.v);

  let rising = [];
  let top = [];
  const rq = withRelated ? widgets.find((w) => w.id === "RELATED_QUERIES") : null;
  if (rq) {
    try {
      const d = await fetchWidget(session, rq, "relatedsearches", keyword, geo, "related");
      const lists = d.default?.rankedList || [];
      const pick = (ranked) => (ranked?.rankedKeyword || []).map((k) => k.query).filter(Boolean);
      top = pick(lists[0]);
      rising = pick(lists[1]);
    } catch (e) {
      log("dim", `related/${keyword} 跳过: ${e.message}`);
    }
  }

  return {
    series,
    points: sampled,
    peak: series.length ? Math.max(...series) : 0,
    rising,
    top,
  };
}

/** 单独取相关查询（备用入口） */
export async function fetchRelatedQueries(session, keyword, geo, timeframe = "now 7-d") {
  const widgets = await explore(session, keyword, geo, timeframe);
  const rq = widgets.find((x) => x.id === "RELATED_QUERIES");
  if (!rq) return { top: [], rising: [] };
  try {
    const d = await fetchWidget(session, rq, "relatedsearches", keyword, geo, "related");
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
