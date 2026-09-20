/**
 * 关键词池：把每轮热搜自带的"相关搜索词"(item[9]) + 热搜词本身聚合成一个可检索的词池。
 * 这是原站没有利用、但对做内容站最有价值的部分。
 */
import { iso, readJson, writeJson, dataPath } from "./util.mjs";
import { matchWatch, feedbackVerdict } from "./detect.mjs";

const keyOf = (q) => q.trim().toLowerCase();

/** 类型优先级：热搜词 > 游戏攻略词 > 一般相关词 */
const KIND_RANK = { trending: 2, game: 1, related: 0 };

/**
 * @param {Array} fresh 本轮热搜条目 [{q,geo,vol,growth,cats,noise,rel[]}]
 * @param {object} cfg
 * @param {Array} [gameKw] 游戏雷达产出的攻略词 [{q,parents,geo}]，kind 记为 "game"
 */
export function buildKeywordPool(fresh, cfg, gameKw = []) {
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
    // 类型只在优先级更高时升级（热搜词 > 游戏攻略词 > 一般相关词）
    if ((KIND_RANK[patch.kind] ?? -1) > (KIND_RANK[cur.kind] ?? -1)) cur.kind = patch.kind;
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

  // 游戏雷达产出的攻略词（xxx codes / tier list …）：这是"可直接起标题"的词
  for (const g of gameKw) {
    if (!g || !g.q) continue;
    bump(g.q, { kind: "game", count: g.count || 1, parents: g.parents || [], geo: g.geo || [] });
  }

  let items = Array.from(map.values()).filter((it) => nowMs - new Date(it.last).getTime() <= keepMs);
  // 你的反馈优先：feedback.block 里的词不进词池。
  // 必须在这里过滤而不是只在 bump 里拦 —— 存量条目是从上一轮读进来的，不在这里清就会一直留着。
  items = items.filter((it) => feedbackVerdict(it.q, cfg.feedback) !== "block");
  for (const it of items) {
    it.parents = (it.parents || []).slice(0, 5);
    it.geo = (it.geo || []).slice(0, 8);
  }
  const rank = (it) => KIND_RANK[it.kind] ?? 0;
  items.sort((a, b) => rank(b) - rank(a) || (b.count || 0) - (a.count || 0) || (b.vol || 0) - (a.vol || 0));

  const CAP = cfg.pool?.maxItems || 20000;
  const truncated = items.length > CAP;
  items = items.slice(0, CAP);

  writeJson(file, { updated: now, total: items.length, truncated, items });
  return {
    total: items.length,
    related: items.filter((x) => x.kind === "related").length,
    game: items.filter((x) => x.kind === "game").length,
  };
}
