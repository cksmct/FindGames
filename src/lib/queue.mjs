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
 *   3  真·新上架        —— Steam 新发售/未发售、App Store「最新上架」
 *   1  榜单常客          —— Steam 特惠/热销、App Store 下载榜（多为饱和老游戏，验证价值低）
 */
const PRIO = (it) => {
  // 显式 prio 优先：调用方明确说"这条更急"时必须听它的。
  // 实测用得上：潜伏清单发现某个 Roblox 游戏**已经上线**时会把它推进队列，
  // 那条比几百个排队等验证的候选更急（我们知道它已经可玩，早一轮验证就早一轮能建站）。
  if (it.prio) return it.prio;
  if (it.source === "roblox") return 4;
  if (it.source === "appstore") return String(it.kind || "").startsWith("new") ? 3 : 1;
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

/** 取优先级最高的 n 个（不删除：验证成功的下一轮会因"已追踪"被跳过，验证失败的自然过期） */
export function peekQueue(cfg, n) {
  const items = loadQueue(cfg).items.slice().sort((a, b) => (b.prio || 0) - (a.prio || 0) || String(a.addedAt).localeCompare(String(b.addedAt)));
  return items.slice(0, Math.max(0, n));
}

/** 出队：把本轮已处理过的名字移出队列 */
export function dropQueue(cfg, names) {
  const kill = new Set((names || []).map(KEY));
  const q = loadQueue(cfg);
  const items = q.items.filter((x) => !kill.has(KEY(x.name)));
  writeJson(dataPath(cfg, ".queue.json"), { updated: iso(), items }, true);
  return q.items.length - items.length;
}