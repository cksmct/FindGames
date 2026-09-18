/**
 * 关键词池：把每轮热搜自带的"相关搜索词"(item[9]) + 热搜词本身聚合成一个可检索的词池。
 * 这是原站没有利用、但对做内容站最有价值的部分。
 */
import { iso, readJson, writeJson, dataPath } from "./util.mjs";
import { matchWatch } from "./detect.mjs";

const keyOf = (q) => q.trim().toLowerCase();

/**
 * @param {Array} fresh 本轮热搜条目 [{q,geo,vol,growth,cats,noise,rel[]}]
 * @param {object} cfg
 */
export function buildKeywordPool(fresh, cfg) {
  const file = dataPath(cfg, "keywords.json");
  const prev = readJson(file) || { items: [] };
  const map = new Map();
  for (const it of prev.items || []) if (it?.q) map.set(keyOf(it.q), it);

  const now = iso();
  const nowMs = Date.now();
  const keepMs = (cfg.historyDays || 7) * 86400_000;

  const bump = (q, patch) => {
    const k = keyOf(q);
    if (!q || q.length < 2) return;
    let cur = map.get(k);
    if (!cur) {
      cur = {
        q: q.trim(), kind: patch.kind || "related", count: 0, parents: [], geo: [], cats: [],
        vol: 0, growth: 0, noise: "", watch: [], first: now, last: now,
      };
      map.set(k, cur);
    }
    cur.count += patch.count || 0;
    cur.last = now;
    if (patch.vol > (cur.vol || 0)) cur.vol = patch.vol;
    if (patch.growth > (cur.growth || 0)) cur.growth = patch.growth;
    if (patch.kind === "trending") cur.kind = "trending";
    if (patch.noise && !cur.noise) cur.noise = patch.noise;
    for (const g of patch.geo || []) if (g && cur.geo.length < 20 && !cur.geo.includes(g)) cur.geo.push(g);
    for (const c of patch.cats || []) if (!cur.cats.includes(c)) cur.cats.push(c);
    for (const p of patch.parents || []) {
      if (p && !cur.parents.includes(p) && cur.parents.length < 20) cur.parents.push(p);
    }
    cur.watch = matchWatch(cur.q, cfg.watch);
    return cur;
  };

  // 相关词只从"够热"的父词收，避免小语区低量长尾灌爆词池
  const minParentVol = cfg.pool?.minParentVol ?? 0;

  for (const it of fresh) {
    bump(it.q, { kind: "trending", count: 1, vol: it.vol, growth: it.growth, cats: it.cats, geo: [it.geo], noise: it.noise });
    if ((it.vol || 0) < minParentVol) continue;
    for (const r of it.rel || []) {
      bump(r, { kind: "related", count: 1, parents: [it.q], geo: [it.geo], cats: it.cats, vol: 0, growth: 0 });
    }
  }

  let items = Array.from(map.values()).filter((it) => nowMs - new Date(it.last).getTime() <= keepMs);
  for (const it of items) {
    it.parents = (it.parents || []).slice(0, 5);
    it.geo = (it.geo || []).slice(0, 8);
  }
  const rank = (it) => (it.kind === "trending" ? 1 : 0);
  items.sort((a, b) => rank(b) - rank(a) || (b.count || 0) - (a.count || 0) || (b.vol || 0) - (a.vol || 0));

  const CAP = cfg.pool?.maxItems || 20000;
  const truncated = items.length > CAP;
  items = items.slice(0, CAP);

  writeJson(file, { updated: now, total: items.length, truncated, items });
  return { total: items.length, related: items.filter((x) => x.kind === "related").length };
}
