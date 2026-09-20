/**
 * 加工层：噪音标注、新游戏识别、可解释打分
 *
 * 说明：原站(FindNews)的 noise/游戏识别/score 具体规则无法从产物反推（只有结果没有规则），
 * 这里是我们自建的一套白盒规则，全部可读可改。
 */

// 官方分类 ID
export const CAT = {
  AUTOS: 1, BEAUTY: 2, BIZ: 3, ENT: 4, FOOD: 5, GAMES: 6, HEALTH: 7, HOBBIES: 8,
  JOBS: 9, LAW: 10, OTHER: 11, PETS: 13, POLITICS: 14, SCIENCE: 15, SHOPPING: 16,
  SPORTS: 17, TECH: 18, TRAVEL: 19, CLIMATE: 20,
};

// ── 噪音规则：给出"为什么这条对做站点的人没用"的短标签 ──
const ADULT = /\b(porn|xxx|sex|nude|escort|onlyfans|xnxx|xvideos)\b/i;
const WEATHER_WORDS = /\b(weather|rain|storm|typhoon|hurricane|monsoon|temperature|forecast|snow|flood|cyclone|heatwave)\b/i;
const RE_ONE_TOKEN = /^[\p{L}\p{N}][\p{L}\p{N}'-]*$/u;

const NOISE_RULES = [
  { label: "敏感", test: (q) => ADULT.test(q) },
  { label: "天气", test: (q, cats) => cats.includes(CAT.CLIMATE) || WEATHER_WORDS.test(q) },
  { label: "体育", test: (q, cats) => cats.length > 0 && cats.every((c) => c === CAT.SPORTS) },
  { label: "政治", test: (q, cats) => cats.includes(CAT.POLITICS) },
  { label: "纯人名词", test: (q, cats) => {
      const words = q.trim().split(/\s+/);
      return cats.includes(CAT.ENT) && words.length <= 3 && words.every((w) => /^[A-Z]/.test(w));
    } },
  { label: "单字泛词", test: (q) => {
      const words = q.trim().split(/\s+/);
      return words.length === 1 && RE_ONE_TOKEN.test(q) && q.length <= 8 && q === q.toLowerCase();
    } },
];

/** 返回噪音标签，空字符串表示非噪音 */
export function noiseLabel(q, cats = []) {
  for (const r of NOISE_RULES) {
    try {
      if (r.test(q, cats)) return r.label;
    } catch {
      /* 单条规则异常不影响整体 */
    }
  }
  return "";
}

// ── 新游戏识别 ──
const GAME_PLATFORMS =
  /\b(roblox|minecraft|fortnite|steam|xbox|playstation|ps5|nintendo|switch|epic games|gta|valorant|genshin|honkai|wuthering|zelda|pokemon|pokémon|among us|stardew|terraria|rust|dota|league of legends|overwatch|apex|call of duty|pubg|free fire|mobile legends|clash|brawl stars|genshin impact)\b/i;
const GAME_SIGNALS =
  /\b(game|gameplay|release date|early access|beta|demo|trailer|update|patch|codes|tier list|roblox|wiki|steam deck|playstation|xbox|switch 2|mobile)\b/i;
// 明确不是游戏的常见实体（避免把体育/影视续作/博彩当游戏）
const NOT_GAME =
  /\b(vs|nfl|nba|mlb|nhl|ufc|f1|premier league|netflix|hulu|disney\+|episode|season \d|box office|election|senate|congress)\b/i;
// Google 把"彩票/博彩"归到 Games 分类，必须显式剔除
// 注意：非 ASCII 词（xổ số 等）不能用 \b 包裹 —— JS 的 \b 只认 \w，越南语字母不算词字符，加了 \b 会永不匹配
const GAMBLING =
  /\b(lottery|sambad|kerala|jackpot|casino|betting|bet|slots?|lotto|poker|rummy|dear lottery|sikkim|nagaland|powerball|mega millions|tambola|matka|satta|result[s]? (?:today|yesterday))\b/i;
const GAMBLING_I18N =
  /(xổ số|kết quả xổ|xs(mb|mn|mt)|ngày \d{1,2} tháng|หวย|ロト|当選番号|toto|loto|sorteio|lotofácil|lotomania|quina|primitiva|sorteo|loter[ií]a|mega ?sena|timemania|melate|quiniela|大樂透|威力彩|六合彩|双色球|大乐透|로또|복권|福彩|體彩|당첨)/i;
// 赛事查询不是游戏作品："celtic game today" 是赛程，不是游戏名
const FIXTURE = /\b(game|match|fixture|kickoff)s? (today|tonight|live|score|result|on tv|time|channel)\b/i;
// 赛马 / 赛事（Google 有时归到 Games 分类）
const HORSE_RACING = /\b(horse racing|racing disqualification|grand national|kentucky derby|race card|chess olympiad|olympiad 20\d\d)\b/i;
// 主机/外设本身不是"新游戏"
const HARDWARE_ONLY =
  /^(playstation( ?[3-5])?|ps ?[3-5]|xbox( series [xs])?|nintendo( switch( ?2)?)?|switch ?2|steam deck|graphics card|gpu)$/i;
// 应用商店/发行平台本身不是游戏（Google 把它们归进 Games 分类，实测 "google play" 会被误收）
const STORE_ONLY =
  /^(google play( ?store)?|play store|app ?store|microsoft store|steam( store)?|epic games( store)?|nintendo e?shop|itch\.io)$/i;
// 泛化的游戏类词，没有具体指向
const GENERIC_WORD =
  /^(multi ?joueur|multiplayer|jeux|juegos|jogo|jogos|spiel|giochi|oyun|games?|gameplay|video ?game|videojuegos|gaming)$/i;
// 明确不是游戏的身份类词 / 平台类词（不是"新游戏"）
const NOT_GAME_EXTRA =
  /\b(vtuber|virtual youtuber|バーチャルyoutuber|youtuber|influencer|streamer|celebrity|twitch|discord|reddit|tiktok|instagram|facebook|spotify)\b/i;

// 非拉丁文字体系（做英文站时，这些词不可能是你要的页面标题）
// 用白名单：只放行拉丁字母/数字/标点/符号/空格，其余文字体系一律否决。
// 比"列举非拉丁脚本"可靠 —— 列举法一定会漏语种（藏文、蒙文、僧伽罗文、缅甸文……）
// 注意 \p{Script=Latin} 含变音符号，所以 "New Pokémon Snap" 能正常通过
const NON_LATIN =
  /[^\p{Script=Latin}\p{N}\p{P}\p{S}\p{Z}]/u; // 以下为废弃的旧列举法（有 typo）：\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Arabic}\p{Script=Thai}\p{Script{Cyrillic}\p{Script{Hebrew}\p{Script{Devanagari}\p{Script{Bengali}\p{Script{Tamil}\p{Script{Telugu}\p{Script{Khmer}\p{Script{Lao}\p{Script{Myanmar}\p{Script{Georgian}\p{Script{Armenian}]/u;

/**
 * 判断一条热搜是否"可能是新游戏"
 * @param {{q:string,cats:number[]}} item
 * @param {{latinOnly?:boolean}} [opts] latinOnly=true 时只收拉丁字母名（做英文站的推荐配置）
 * @returns {{ok:boolean, reason:string, weight:number}}
 */
export function gameCandidate(item, opts = {}) {
  const q = item.q || "";
  const cats = item.cats || [];
  if (opts.latinOnly && NON_LATIN.test(q)) return { ok: false, reason: "非英文名", weight: 0 };
  if (!q || NOT_GAME.test(q) || NOT_GAME_EXTRA.test(q)) return { ok: false, reason: "非游戏实体", weight: 0 };
  if (FIXTURE.test(q)) return { ok: false, reason: "赛事查询", weight: 0 };
  if (HORSE_RACING.test(q)) return { ok: false, reason: "赛马", weight: 0 };
  if (GAMBLING.test(q) || GAMBLING_I18N.test(q)) return { ok: false, reason: "博彩/彩票", weight: 0 };
  if (HARDWARE_ONLY.test(q.trim())) return { ok: false, reason: "主机硬件", weight: 0 };
  if (STORE_ONLY.test(q.trim())) return { ok: false, reason: "应用商店", weight: 0 };
  if (GENERIC_WORD.test(q.trim())) return { ok: false, reason: "泛化词", weight: 0 };
  const inGameCat = cats.includes(CAT.GAMES);
  const platform = GAME_PLATFORMS.test(q);
  const signal = GAME_SIGNALS.test(q);
  if (!inGameCat && !platform && !signal) return { ok: false, reason: "无游戏信号", weight: 0 };
  let weight = 0;
  if (inGameCat) weight += 2;
  if (platform) weight += 2;
  if (signal) weight += 1;
  return { ok: true, reason: [inGameCat && "Games分类", platform && "游戏平台词", signal && "游戏意图词"].filter(Boolean).join("+"), weight };
}

/**
 * 可解释打分：搜索量分 + 涨幅分 + 起飞分 + 发现权重
 * 与原站 score 数值不追求一致（其算法未知），仅保证越大越值得做。
 */
export function scoreKeyword({ vol = 0, growth = 0, hype = 0, weight = 0 }) {
  const volScore = vol > 0 ? Math.log2(vol / 1000) * 2 : 0; // 2万≈8.6, 200万≈22
  const growthScore = growth / 100;                          // 1000% → 10
  const hypeScore = hype >= 99 ? 8 : hype >= 3 ? 5 : hype >= 1.5 ? 2 : 0;
  return Math.round(volScore + growthScore + hypeScore + weight * 2);
}

// ── 相关查询的相关性过滤 ──
// Google 的 Rising 列表有已知问题：会混入同期爆红的**无关**词
// （实测 GTA VI 的 rising 里有 kroger / helldivers / brain eating amoeba）。
// Top 列表（最热门相关查询）质量高得多，所以只过滤 Rising，不动 Top。
const STOP = new Set(["the", "and", "of", "for", "with", "vs", "de", "la", "el", "le", "les", "des", "und", "der"]);

/** 把游戏名切成实词（长度 ≥3，去停用词；CJK 按空格切也一样work） */
export function tokensOf(name) {
  return String(name || "")
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t.length >= 3 && !STOP.has(t));
}

/** 相关词是否至少含游戏名里的一个实词 */
export function relevantTo(word, tokens) {
  if (!tokens || !tokens.length) return true; // 名字没有可用实词（如纯符号/短名），不过滤
  const w = String(word || "").toLowerCase();
  return tokens.some((t) => w.includes(t));
}

/** 判断是否命中"与我相关"监控词 */
export function matchWatch(q, watch = []) {
  const low = q.toLowerCase();
  return watch.filter((w) => w && low.includes(String(w).toLowerCase()));
}
