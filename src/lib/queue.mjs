/**
 * 候选队列：来源层每轮会产出几百个新名字，而 Google Trends 曲线接口限流严格，
 * 必须排队逐轮验证 —— 原站 findnews.me 也是这样：来源池远大于它每天新增的 ~27 个。
 *
 * 文件：data/.queue.json（以 . 开头 → 不会被打包进静态站点）
 */
import { dataPath, readJson, writeJson, iso } from "./util.mjs";

const KEY = (s) => String(s || "").trim().toLowerCase();

/**
 * 队列优先级（4 最高）：
 *   4  Roblox 榜单      —— 原站的主要来源，最接近"新游戏"口径
 *   3  真·新上架        —— Steam 新发售/未发售、App Store「最新上架」、itch/Poki 的新作
 *   2  网页小游戏       —— itch / Poki：竞争几乎为零的小游戏，验证的价值高于再验一遍热门榜
 *   1  榜单常客          —— Steam 特惠/热销、App Store 下载榜、Google Play 分类热门榜
 *                          （Play 没有可抓的"新游"入口，拿到的都是饱和热门游戏）
 */
const PRIO = (it) => {
  // 显式 prio 优先：调用方明确说"这条更急"时必须听它的。
  // 实测用得上：潜伏清单发现某个 Roblox 游戏**已经上线**时会把它推进队列，
  // 那条比几百个排队等验证的候选更急（我们知道它已经可玩，早一轮验证就早一轮能建站）。
  if (it.prio) return it.prio;
  if (it.source === "roblox") return 4;
  if (it.source === "appstore") return String(it.kind || "").startsWith("new") ? 3 : 1;
  if (it.source === "itch" || it.source === "poki" || it.source === "crazygames") return 2;
  // 🛑 这个 prio 只管「曲线验证顺序」，**不是**收录门槛（2026-09-24 实测纠偏）。
  //    Play 没有新游入口 → 条目全是热榜 → 一律 prio 1，本意是"别把 Trends 配额花在饱和热榜上"。
  //    但它一度被当成"不让它进 games.json"的门槛，结果整源 509 条一条都进不来（唯一放行的曲线通道
  //    只收进 6 条全球大作）。收录与否现在由 collect.mjs 的 `catalogDirect.allowLowPrioSources` 决定。
  if (it.source === "googleplay") return 1;
  if (it.kind === "new" || it.kind === "upcoming") return 3;
  return 1;
};

export function loadQueue(cfg) {
  const j = readJson(dataPath(cfg, ".queue.json"));
  const items = j && Array.isArray(j.items) ? j.items : [];
  return { updated: (j && j.updated) || null, items };
}

/**
 * 来源候选入队。已在追踪 / 本轮已入选的名字不进队，但会作为 seen 返回：
 * 来源里再次出现 = 原站卡片上的"最新信号 ×N"，由调用方去刷新 last / sightings。
 * @returns {{added:number,total:number,seen:string[]}}
 */
export function pushQueue(cfg, incoming, known) {
  const q = loadQueue(cfg);
  const have = new Map(q.items.map((x) => [KEY(x.name), x]));
  const seen = [];
  let added = 0;
  let bumped = 0;
  const now = iso();
  for (const it of incoming || []) {
    const k = KEY(it && it.name);
    if (!k || k.length < 2) continue;
    if (known && known.has(k)) { seen.push(k); continue; }
    const prio = PRIO(it);
    const exist = have.get(k);
    if (exist) {
      // 已在队列里：**只升不降**地抬优先级，并同步新带的元数据。
      // 为什么：同一批候选可能先以普通优先级入队，之后我们拿到了更强的信号
      // （实测：潜伏清单发现它已经上线 → prio 5 + via 标记），此时必须让它插队，
      // 否则要排在几百条后面等好几轮。
      // ⚠️ 元数据也必须一起同步 —— 实测踩过：只改 prio 不同步 `via`，
      //    下游那条"潜伏转正免曲线门槛"的规则永远看不到 via，条目照样被丢弃。
      if (prio > (exist.prio || 0)) { exist.prio = prio; bumped++; }
      for (const k of Object.keys(it)) {
        if (k === "addedAt" || k === "prio") continue;
        if (it[k] !== undefined) exist[k] = it[k];
      }
      continue;
    }
    const item = Object.assign({}, it, { addedAt: now, prio });
    have.set(k, item);
    q.items.push(item);
    added++;
  }
  const g = cfg.games || {};
  const max = (g.queue && g.queue.max) || 5000;
  const ttl = ((g.queue && g.queue.ttlDays) || 21) * 86400000;
  const nowMs = Date.now();
  q.items = q.items.filter((x) => x.addedAt && nowMs - new Date(x.addedAt).getTime() <= ttl).slice(-max);
  writeJson(dataPath(cfg, ".queue.json"), { updated: now, items: q.items }, true);
  return { added, bumped, total: q.items.length, seen };
}

/**
 * 取优先级最高的 n 个（不删除：验证成功的下一轮会因"已追踪"被跳过，验证失败的自然过期）。
 *
 * 🛑 **按来源公平抽样（fairShare，默认开）—— 2026-09-24 实测教训**：
 * 来源变多之后（Roblox / Steam / iOS / Android / itch / Poki 六个），
 * 单纯"按优先级排序后取前 n"会让**单一来源吃光全部名额**：
 * 实测 Roblox 一次产出 217 条且优先级最高，于是本轮 7 个验证名额全是 Roblox，
 * 手游与网页小游戏**永远排不到**（队列里积压上千条，21 天后直接过期）——
 * 等于新增的来源白加。改成按来源轮流各取一条，保证每轮每个来源都能轮到。
 * 想要旧的"严格按优先级"行为：`games.queue.fairShare = false`。
 */
export function peekQueue(cfg, n) {
  const limit = Math.max(0, n);
  const items = loadQueue(cfg).items.slice()
    .sort((a, b) => (b.prio || 0) - (a.prio || 0) || String(a.addedAt).localeCompare(String(b.addedAt)));
  const g = (cfg && cfg.games) || {};
  if ((g.queue && g.queue.fairShare) === false) return items.slice(0, limit);

  // 按来源分桶（桶内已按优先级 + FIFO 排好），来源之间轮流转
  const bySrc = new Map();
  for (const it of items) {
    const k = it.source || "unknown";
    if (!bySrc.has(k)) bySrc.set(k, []);
    bySrc.get(k).push(it);
  }
  // 先轮优先级高的来源（桶内首条的 prio 就是该来源的最急程度）
  const order = Array.from(bySrc.keys())
    .sort((a, b) => ((bySrc.get(b)[0] || {}).prio || 0) - ((bySrc.get(a)[0] || {}).prio || 0));
  const cursor = new Map(order.map((k) => [k, 0]));
  const out = [];
  while (out.length < limit) {
    let advanced = false;
    for (const k of order) {
      if (out.length >= limit) break;
      const arr = bySrc.get(k);
      const i = cursor.get(k);
      if (i >= arr.length) continue;
      cursor.set(k, i + 1);
      out.push(arr[i]);
      advanced = true;
    }
    if (!advanced) break; // 全部来源都取空了
  }
  return out;
}

/** 出队：把本轮已处理过的名字移出队列 */
export function dropQueue(cfg, names) {
  const kill = new Set((names || []).map(KEY));
  const q = loadQueue(cfg);
  const items = q.items.filter((x) => !kill.has(KEY(x.name)));
  writeJson(dataPath(cfg, ".queue.json"), { updated: iso(), items }, true);
  return q.items.length - items.length;
}