/**
 * 潜伏评分（2026-09-26 扩展：三来源统一形状，各用**自己能测**的维度）
 *
 * 背景：原来的潜伏评分只覆盖 Roblox 未发售条目（发布确定性 / 日期精确度 / 内容面 / 社区地基 / 竞争饱和度）。
 *   于是潜伏列表里 Steam（约 40 条）与 App Store（约 40 条）的评估列只能写一句「未进雷达（…）」——
 *   用户问「要专门把潜伏雷达塞出来吗」，答案是：**不塞进「🎯 建站推荐」**（那页算的是上线后的可做性，
 *   未发售条目在那边只会显示「数据不足」），而是给每个来源一套自己能测的维度，让「该不该盯」在潜伏列表内部闭环。
 *
 * 🛑 三条口径（都踩过坑才定的，改之前先读）：
 *   ① **未测维度权重跳过**（重新归一化），**不是 0 分** ——「没测到」≠「没有」。缺哪几项写在 missing 里、如实显示。
 *   ② **跨来源不能比大小**：三个来源的维度不同（Steam 靠愿望单序位、App Store 靠榜单名次与口碑证据、
 *      Roblox 靠官方状态与社区地基），分数只在**同来源内**可比。跨来源请按「窗口」或「发售日」排。
 *   ③ 窗口（build/close/far）与评分是两件事：评分高但只剩 7 天照样来不及（band 会直接标 too-late）。
 *
 * 数据来源（每一项都是**已抓到的字段**，没有为了凑分去猜）：
 *   Steam    ：rank（popularcomingsoon 序位）· releaseInDays · releasePrecision · demo · stats（评价数/好评率/在线）
 *   App Store：rank（榜单名次）· releaseInDays · preorder · rating/ratings · genres · developer
 *   竞争      ：serp（SERP 缓存，与「🎯 建站推荐」共用）—— 目前只有 Roblox 通道在做，另两个来源标「未测」
 */
import { openScore, COMP_SATURATED_OPEN } from "./serp.mjs";

/**
 * 内容面分档（**与 Roblox 那套共用同一张表**：本文件是权威副本，roblox-upcoming.mjs 从这里 import）。
 * 🛑 这是**启发式**，不是实测：靠 genres 推断（页面没有「能写多少页」这种字段）→ 理由必须跟分一起显示，让人能一眼反驳。
 */
export const GENRE_TIERS = [
  { re: /monster catching|turn based|rpg|adventure|open world/i, score: 92, why: "有单位/技能/养成体系（图鉴·配队·流派页可写）" },
  { re: /survival|tycoon|simulator|simulation|sports|strategy/i, score: 70, why: "有系统/道具/升级线（攻略页中等）" },
  { re: /action|shooter|horror|anime|racing|puzzle|fighting|battle/i, score: 52, why: "攻略面偏薄（多为机制/通关说明）" },
  { re: /escape|obby|platformer|rng|party|casual|social|utility/i, score: 28, why: "内容面窄，通常只值得做 codes 页" },
];

/** 日期精确度（与 Roblox 同锚点）：确切日期 100 · 月份 70 · 季度 55 · 年份 40 · 未定档 15 */
export const DATE_CONF = { day: 100, month: 70, quarter: 55, year: 40, unknown: 15 };
export const DATE_LABEL = { day: "确切日期", month: "只有月份", quarter: "只有季度", year: "只有年份" };

export function surfaceScoreOf(genres) {
  const arr = genres == null ? [] : genres;
  if (!arr.length) return { score: 30, why: "无类型标注（按最低档计）", missing: "无类型标注" };
  for (const t of GENRE_TIERS) {
    if (arr.some(function (x) { return t.re.test(String(x)); })) return { score: t.score, why: arr.join("/") + " → " + t.why, missing: null };
  }
  return { score: 30, why: arr.join("/") + " → 类型不足以判断（按最低档计）", missing: null };
}

export function dateScoreOf(precision) {
  const k = precision == null ? "unknown" : precision;
  const v = DATE_CONF[k];
  return v == null ? 15 : v;
}

/** 竞争饱和度：与「🎯 建站推荐」共用 serp.mjs 的分档（0 个专站=100 · 1~2=75 · 3~4=50 · 5~7=25 · ≥8=10） */
export function compOf(serp) {
  if (!serp) return { score: null, why: "还没做过 SERP 核查 —— **未测不等于没人做**", saturated: false, missing: "竞争未测" };
  if (serp.open == null) return { score: null, why: "缓存里没有 open 值", saturated: false, missing: "竞争未测" };
  const ded = serp.dedicated == null ? (serp.dedicatedHosts == null ? [] : serp.dedicatedHosts).length : serp.dedicated;
  const hosts = serp.dedicatedHosts == null ? [] : serp.dedicatedHosts;
  const why = "专为它建的站 " + ded + " 个（前十共 " + serp.domains + " 个独立域名" +
    (ded ? "：" + hosts.slice(0, 3).join(" · ") : "，其余是通用媒体，不算对手") + "）";
  return { score: openScore(serp.open), why: why, saturated: serp.open <= COMP_SATURATED_OPEN, missing: null };
}

/** 分档（三来源共用；窗口档按来源解释） */
/** 分档门槛：Roblox 与 Steam 用同一档；App Store 上移（见注释） */
export const BAND_GO = { roblox: 70, steam: 70, appstore: 78 };
export const BAND_WATCH = { roblox: 55, steam: 55, appstore: 62 };

export function bandOf(score, o) {
  const opts = o == null ? {} : o;
  const d = opts.releaseInDays;
  // 🛑 为什么 App Store 的门槛比另两个来源高：那张清单是**新上架小榜**（new-paid / new-free），
  //   天然满足「刚上架 + 榜前 40」→ 名次与新鲜度两项天然接近满分，于是分数整体抬高。
  //   实测同一套门槛下 40 条里 38 条落进「值得潜伏」（该档等于失效）→ 按来源校准门槛，
  //   并把「开发者」这一项**从计分里去掉**（40/40 都有值 = 常数，只会整体抬分、不产生区分度）。
  const go = BAND_GO[opts.source] == null ? 70 : BAND_GO[opts.source];
  const watch = BAND_WATCH[opts.source] == null ? 55 : BAND_WATCH[opts.source];
  if (opts.source === "steam") { if (d != null) { if (d < 7) return { k: "too-late", t: "窗口已过（≤7 天）" }; } }
  if (opts.source === "appstore") { if (d != null) { if (d <= -60) return { k: "too-late", t: "已上线 >60 天" }; } }
  if (opts.saturated) return { k: "taken", t: "竞争已起（前十专用站 ≥5 个）" };
  if (score == null) return { k: "no", t: "数据不足" };
  if (score >= go) return { k: "go", t: "值得潜伏" };
  if (score >= watch) return { k: "watch", t: "观察" };
  return { k: "no", t: "暂不" };
}
// ────────────────────────────── Steam（未发售）──────────────────────────────
/**
 * 权重合计 1.00。为什么愿望单序位最重：Steam **不公开愿望单绝对数**，
 *   `popularcomingsoon` 的序位是我们能拿到的**唯一**发售前需求代理（该榜 10 万+ 条目按愿望单排）。
 *   官方热度（评价数/在线）留给已发售或 Early Access 的条目 —— 未发售时它是空的 → 权重跳过，不伪造。
 */
export const STEAM_W = { wish: 0.32, window: 0.20, playable: 0.14, official: 0.14, date: 0.10, comp: 0.10 };

/** 愿望单序位 → 分档（越小越热）。锚点按榜单结构定：一页 100 条，前 10 = 六周内最热的一批 */
const WISH_TIERS = [
  { max: 3, score: 100, why: "最热的一档（前 3）" },
  { max: 5, score: 94, why: "前 5" },
  { max: 10, score: 86, why: "前 10" },
  { max: 20, score: 76, why: "前 20" },
  { max: 40, score: 62, why: "前 40" },
  { max: 70, score: 46, why: "前 70" },
  { max: 100, score: 34, why: "第一页内" },
  { max: Infinity, score: 20, why: "100 名开外" },
];
function wishScoreOf(rank) {
  if (rank == null) return null;
  for (const t of WISH_TIERS) {
    if (rank <= t.max) return { score: t.score, why: "榜上第 " + rank + " 位（" + t.why + "）" };
  }
  return { score: 20, why: "榜上第 " + rank + " 位" };
}

/** 发售窗口：8~21 天是甜区（够时间做站、热度已在积累）；未定档给中性分（高愿望单 + 没定档恰恰是典型潜伏标的） */
function steamWindowScore(d) {
  if (d == null) return { score: 55, why: "未定档（中性分：高愿望单 + 没定档恰恰是最典型的潜伏标的）" };
  if (d < 7) return { score: 20, why: "还有 " + d + " 天（≤7 天：新站在 7 天内排不上去，清单本来也不收）" };
  if (d <= 21) return { score: 100, why: "还有 " + d + " 天（8~21 天 = 甜区：够做站、热度已在积累）" };
  if (d <= 45) return { score: 78, why: "还有 " + d + " 天（22~45 天：偏早，但可先备内容）" };
  if (d <= 90) return { score: 55, why: "还有 " + d + " 天（46~90 天：太早，热度还没起来）" };
  return { score: 35, why: "还有 " + d + " 天（>90 天：太早）" };
}

/** 可玩信号：有 Demo = 玩家能试（社区与口碑最先在这里起来）；已开预购次之 */
function playableScore(demo, preorder) {
  if (demo === true) return { score: 100, why: "有 Demo（玩家能试 → 社区与口碑最先起来）" };
  if (preorder === true) return { score: 70, why: "已开预购（钱包投票，但还不能玩）" };
  return { score: 40, why: "无 Demo、未开预购" };
}

/** 官方热度（评价数 / 当前在线 / 好评率）—— 未发售时通常为空 → null（权重跳过） */
function reviewScoreOf(n) {
  if (n <= 50) return 35;
  if (n <= 500) return 60;
  if (n <= 5000) return 82;
  return 95;
}
function playingScoreOf(n) {
  if (n <= 100) return 30;
  if (n <= 1000) return 55;
  if (n <= 10000) return 80;
  return 95;
}
function steamOfficialScore(stats) {
  if (!stats) return null;
  const reviews = stats.reviews == null ? 0 : stats.reviews;
  const playing = stats.playing == null ? 0 : stats.playing;
  if (reviews === 0) {
    if (playing === 0) return null;
    return playingScoreOf(playing);
  }
  let s = reviewScoreOf(reviews);
  if (playing > 0) {
    const p = playingScoreOf(playing);
    if (p > s) s = p;
  }
  if (stats.approval != null) {
    if (stats.approval >= 90) s = Math.min(100, s + 5);
    else if (stats.approval < 60) s = Math.max(0, s - 10);
  }
  return s;
}

export function scoreUpcomingSteam(it) {
  const reasons = [], missing = [];
  const W = STEAM_W;
  let sum = 0, wsum = 0;
  const add = function (w, v) { if (v == null) return; sum += w * v; wsum += w; };

  const wish = wishScoreOf(it.rank);
  if (wish == null) missing.push("愿望单序位");
  else reasons.push("愿望单热度 " + wish.score + "（" + wish.why + "：Steam 不公开绝对愿望单数，序位只作热度代理）");
  add(W.wish, wish == null ? null : wish.score);

  const win = steamWindowScore(it.releaseInDays);
  reasons.push("发售窗口 " + win.score + "（" + win.why + "）");
  add(W.window, win.score);

  const pl = playableScore(it.demo, it.preorder);
  reasons.push("可玩信号 " + pl.score + "（" + pl.why + "）");
  add(W.playable, pl.score);

  const off = steamOfficialScore(it.stats);
  if (off == null) missing.push("官方热度（未发售：还没有评价/在线）");
  else {
    const st = it.stats;
    reasons.push("官方热度 " + off + "（Steam " + (st.reviews == null ? "—" : "评价 " + st.reviews) +
      (st.approval == null ? "" : " · 好评 " + st.approval + "%") + (st.playing == null ? "" : " · 在线 " + st.playing) + "）");
  }
  add(W.official, off);

  const ds = dateScoreOf(it.releasePrecision);
  reasons.push("日期精确度 " + ds + "（" + (DATE_LABEL[it.releasePrecision] == null ? "未定档" : DATE_LABEL[it.releasePrecision]) + "：" + (it.released == null ? "—" : it.released) + "）");
  add(W.date, ds);

  const cp = compOf(it.serp);
  if (cp.missing != null) missing.push(cp.missing);
  reasons.push("竞争饱和度 " + (cp.score == null ? "未测" : cp.score) + "（" + cp.why + "）");
  add(W.comp, cp.score);

  if (!wsum) return { score: null, band: { k: "no", t: "数据不足" }, reasons: reasons, missing: missing };
  const score = Math.round(sum / wsum);
  return {
    score: score,
    band: bandOf(score, { source: "steam", releaseInDays: it.releaseInDays, saturated: cp.saturated }),
    reasons: reasons, missing: missing,
  };
}
// ────────────────────────────── App Store（新上架 / 预购）──────────────────────────────
/**
 * 权重合计 1.00。与 Steam 的差别：iOS **没有愿望单**，但 App Store 榜单名次是真实序位
 *   （top-free / top-grossing / new 榜，我们读的就是它），而**评分人数**是装机量的唯一代理。
 *   实测（线上 40 条）：榜单名次 40/40 有值，评分只有 8/40 有值 —— 其余是「刚上架还没人评」，
 *   那是**真的没有数据**（不是缺抓）→ 按「未测」跳过权重，绝不按 0 分算。
 */
// 🛑 为什么没有「开发者」这一项：实测 40/40 都有值 = **常数**，只会整体抬分、不产生区分度
//   （与雷达分删掉「识别权重」同一条理由：榜单里恒定的输入是噪音，不是信号）。
export const IOS_W = { rank: 0.34, fresh: 0.22, ratings: 0.24, surface: 0.10, comp: 0.10 };

const IOS_RANK_TIERS = [
  { max: 3, score: 100, why: "榜上前 3" },
  { max: 10, score: 85, why: "榜上前 10" },
  { max: 30, score: 65, why: "榜上前 30" },
  { max: 60, score: 45, why: "榜上前 60" },
  { max: 100, score: 30, why: "榜上前 100" },
  { max: Infinity, score: 20, why: "100 名开外" },
];
/**
 * 榜单类型权重：`top-free` / `top-grossing` 是全站大榜（#1 量级很大）；`new-*` 是新上架小榜（窄得多）。
 * 🛑 名次分**只在同一张榜内可比** —— 小榜第 3 不能和大榜第 3 同分，所以这里按榜单类型缩放。
 */
function iosListWeight(list) {
  const s = String(list == null ? "" : list).toLowerCase();
  if (s.indexOf("top-free") >= 0) return 1;
  if (s.indexOf("top-grossing") >= 0) return 1;
  if (s.indexOf("new-") >= 0) return 0.62;
  return 0.8;
}
function iosRankScore(rank, list) {
  if (rank == null) return null;
  const w = iosListWeight(list);
  for (const t of IOS_RANK_TIERS) {
    if (rank <= t.max) return { score: Math.round(t.score * w), why: "榜上第 " + rank + " 位（" + t.why + (w < 1 ? " · 新上架小榜，按 0.62 折算" : "") + "）" };
  }
  return { score: Math.round(20 * w), why: "榜上第 " + rank + " 位" };
}

/** 新鲜度：刚上架 ≤7 天 = 100（需求还没被占，正是新站的机会窗）；预购 = 90（还没上线，最强潜伏位） */
function iosFreshScore(d, preorder) {
  if (preorder === true) return { score: 90, why: "预购中（还没上线 → 最强潜伏位）" };
  if (d == null) return { score: 40, why: "没有确切上线日（App Store 的 new 榜实测常有冻结批次、缺日期）" };
  if (d > 0) return { score: 80, why: "还有 " + d + " 天上线（未上架但已定档）" };
  const ago = Math.abs(d);
  // 🛑 清单本身只收「刚上架」，所以 7 天内还要再分档 —— 否则这一项也是常数（同 ②）
  if (ago <= 2) return { score: 100, why: "上线 " + ago + " 天（最新一批：需求还没被占）" };
  if (ago <= 7) return { score: 86, why: "上线 " + ago + " 天（刚上架）" };
  if (ago <= 21) return { score: 68, why: "上线 " + ago + " 天（还在窗口内）" };
  if (ago <= 60) return { score: 45, why: "上线 " + ago + " 天（偏晚）" };
  return { score: 25, why: "上线 " + ago + " 天（>60 天）" };
}

/** 口碑证据 = 评分人数（装机量唯一代理）+ 星级；**0 人 = 未测**（刚上架还没人评，不伪造分数） */
const RATING_TIERS = [
  { max: 50, score: 45, why: "还很小众" },
  { max: 500, score: 65, why: "有真实装机量" },
  { max: 5000, score: 85, why: "已有一定规模" },
  { max: Infinity, score: 95, why: "规模很大" },
];
function ratingScoreOf(ratings, rating) {
  if (ratings == null) return null;
  if (ratings === 0) return null;
  let s = 45, why = "还很小众";
  for (const t of RATING_TIERS) {
    if (ratings <= t.max) { s = t.score; why = t.why; break; }
  }
  let extra = "";
  if (rating != null) {
    if (rating >= 4.5) { s = Math.min(100, s + 5); extra = " · 星级 " + rating + "（≥4.5 加 5）"; }
    else if (rating > 0) {
      if (rating < 3) { s = Math.max(0, s - 10); extra = " · 星级 " + rating + "（<3 扣 10）"; }
      else extra = " · 星级 " + rating;
    }
  }
  return { score: s, why: "评分人数 " + ratings + "（" + why + "）" + extra };
}

function devScoreOf(developer) {
  if (developer) return { score: 100, why: "有开发者名（可查历史作品与更新记录）" };
  return { score: 50, why: "无开发者名" };
}

export function scoreUpcomingAppStore(it) {
  const reasons = [], missing = [];
  const W = IOS_W;
  let sum = 0, wsum = 0;
  const add = function (w, v) { if (v == null) return; sum += w * v; wsum += w; };

  const rk = iosRankScore(it.rank, it.list);
  if (rk == null) missing.push("榜单名次");
  else reasons.push("榜单名次 " + rk.score + "（" + rk.why + " · " + (it.list == null ? "榜单" : it.list) + "）");
  add(W.rank, rk == null ? null : rk.score);

  const fr = iosFreshScore(it.releaseInDays, it.preorder);
  reasons.push("新鲜度 " + fr.score + "（" + fr.why + "）");
  add(W.fresh, fr.score);

  const rt = ratingScoreOf(it.ratings, it.rating);
  if (rt == null) missing.push("评分人数（刚上架还没人评）");
  else reasons.push("口碑证据 " + rt.score + "（" + rt.why + "）");
  add(W.ratings, rt == null ? null : rt.score);

  const sf = surfaceScoreOf(it.genres);
  if (sf.missing != null) missing.push(sf.missing);
  reasons.push("内容面 " + sf.score + "（" + sf.why + "）");
  add(W.surface, sf.score);

  // 开发者只作**上下文**（不计分，见 IOS_W 的注释）—— 理由里照样写出来，便于核对
  const dv = devScoreOf(it.developer);
  reasons.push("开发者（不计分）" + "（" + dv.why + "）");

  const cp = compOf(it.serp);
  if (cp.missing != null) missing.push(cp.missing);
  reasons.push("竞争饱和度 " + (cp.score == null ? "未测" : cp.score) + "（" + cp.why + "）");
  add(W.comp, cp.score);

  if (!wsum) return { score: null, band: { k: "no", t: "数据不足" }, reasons: reasons, missing: missing };
  const score = Math.round(sum / wsum);
  return {
    score: score,
    band: bandOf(score, { source: "appstore", releaseInDays: it.releaseInDays, saturated: cp.saturated }),
    reasons: reasons, missing: missing,
  };
}
/**
 * 潜伏评分的**算法自述（Steam / App Store 部分）**：与 Roblox 那份（UPCOMING_RULES）在 watchlist 里合并下发，
 * 前端 rulesHtml() 直接渲染 weights / items / caveats / bands / note —— 所以这里写的必须与上面的实现一致（铁律 7）。
 */
export const UPCOMING_RULES_EXTRA = {
  weights: [
    ["Steam · 愿望单热度", "0.32", "popularcomingsoon 序位（越小越热）—— Steam 不公开绝对愿望单数，序位是唯一可测的需求代理"],
    ["Steam · 发售窗口", "0.20", "8~21 天 = 甜区（100）· 22~45 天 78 · 46~90 天 55 · >90 天 35 · 未定档 55（中性）"],
    ["Steam · 可玩信号", "0.14", "有 Demo 100 · 已开预购 70 · 都没有 40"],
    ["Steam · 官方热度", "0.14", "评价数 / 当前在线 / 好评率（未发售时这三项都是空的 → 权重跳过，不按 0 算）"],
    ["Steam · 日期精确度", "0.10", "与 Roblox 同锚点：确切日期 100 · 月份 70 · 季度 55 · 年份 40 · 未定档 15"],
    ["Steam · 竞争饱和度", "0.10", "SERP 前十**专用站**数（目前 Steam 侧还没做 → 未测跳过）"],
    ["App Store · 榜单名次", "0.30", "top-free / top-grossing / new 榜序位：前 3 = 100 · 前 10 = 85 · 前 30 = 65 · 前 60 = 45 · 前 100 = 30"],
    ["App Store · 新鲜度", "0.20", "预购 90 · 刚上架 ≤7 天 100 · 21 天内 75 · 60 天内 50 · 更久 25 · 无日期 40"],
    ["App Store · 口碑证据", "0.20", "评分人数（装机量唯一代理）+ 星级：0 人 = **未测跳过**（刚上架还没人评，不是口碑差）"],
    ["App Store · 内容面", "0.15", "与 Roblox **共用同一张类型表**（图鉴/配队类 92 · 模拟策略类 70 · 动作射击 52 · 小游戏 28）"],
    ["App Store · 开发者", "0.05", "有开发者名 100（可查历史作品与更新记录）· 无 50"],
    ["App Store · 竞争饱和度", "0.10", "同上（目前 App Store 侧未做 → 未测跳过）"],
  ],
  items: [
    "🛑 **未测维度权重跳过**（重新归一化），**不是 0 分**：「刚上架还没人评」是**真的没有数据**，不是口碑差；「竞争未测」也不等于没人做",
    "🛑 **跨来源不能直接比大小**：三个来源的维度不同（Steam 靠愿望单序位 · App Store 靠榜单名次与评分人数 · Roblox 靠官方状态与社区地基）→ 分数只在**同来源内**可比；跨来源请按「窗口 / 发售日」排",
    "🛑 窗口与评分是两件事：评分高但只剩 7 天照样来不及（分档会直接标「窗口已过」）",
    "🛑 分数高只说明「值得先盯」，不等于「值得建站」—— 上线后的可做性在「🎯 建站推荐」页（需求 / 内容面 / 竞争 / 新鲜度那套）",
  ],
  caveats: [],
  note: "Steam 愿望单序位是**热度代理**、不是绝对需求（Steam 不公开愿望单数量）。App Store 的评分人数是我们的取数地区（默认 US）口径；new 榜实测常有冻结批次、日期缺失，日期一缺新鲜度那项按「无确切上线日」给 40。",
};