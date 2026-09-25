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
  /\b(roblox|minecraft|fortnite|steam|xbox|playstation|ps5|nintendo|switch|epic games|gta|grand theft auto|valorant|genshin|honkai|wuthering|zelda|pokemon|pokémon|among us|stardew|terraria|dota|league of legends|overwatch|apex|call of duty|pubg|free fire|mobile legends|clash|brawl stars|genshin impact)\b/i;
// 🛑 曾经把这个词表里的 \bgame\b 当成"游戏意图"证据，是严重设计错误：
//    英文里 "<队名> game"（chivas game / padres game / yankees game）语义恰恰是**比赛**，与游戏相反。
//    实测仅这一个词就让 4 条体育赛事通过。赛事语义改由 FIXTURE_FORM 单独处理。
const GAME_SIGNALS =
  /\b(gameplay|release date|early access|playtest|beta|demo|trailer|update|patch|codes|tier list|roblox|wiki|steam deck|playstation|xbox|switch 2|mobile)\b/i;
// 明确不是游戏的常见实体（避免把体育/影视续作/博彩当游戏）
const NOT_GAME =
  /\b(vs|nfl|nba|mlb|nhl|ufc|f1|premier league|netflix|hulu|disney\+|episode|season \d|box office|election|senate|congress|movie|film|pel[ií]cula|cinema)\b/i;
// Google 把"彩票/博彩"归到 Games 分类，必须显式剔除
// 注意：非 ASCII 词（xổ số 等）不能用 \b 包裹 —— JS 的 \b 只认 \w，越南语字母不算词字符，加了 \b 会永不匹配
const GAMBLING =
  /\b(lottery|lotteries|lotto\w*|sambad|kerala|jackpot|casino|betting|bet|slots?|poker|rummy|dear lottery|sikkim|nagaland|powerball|mega millions|tambola|matka|satta|win5|result[s]? (?:today|yesterday))\b/i;
// 博彩品牌 / 比分站：它们的分类**含 Games(6)**，所以"纯体育=噪音"的规则拦不住，必须单独列。
// 实测漏网：betmgm[17,6]、draftkings sportsbook[6,17]、livescore[6,17]
const BETTING_BRAND =
  /\b(draftkings|fanduel|betmgm|bet365|william ?hill|pokerstars|bovada|caesars|pointsbet|betano|betway|1xbet|melbet|pin-?up|betfair|livescore|flashscore|sofascore)\b/i;
// 体育媒体 / 联赛组织 —— 不是"新游戏作品"（实测漏网：cpbl[6,17,18]）
const SPORTS_MEDIA =
  /\b(espn|ncaa|cpbl|npb|kbo|premier league|la ?liga|serie a|bundesliga|eredivisie|mls|uefa|fifa ranking)\b/i;
// 技术组件 / 评测媒体 —— 不是作品本体（实测漏网：denuvo[6]、gamestar[6]）
// tcg/trading card 是实体集换卡（"pokemon cards" 类的热搜是买卡不是玩游戏）
const NOT_A_WORK = /\b(denuvo|gamestar|ign|gamespot|polygon|kotaku|eurogamer|unreal engine|unity engine|dlss|fsr|ray ?tracing|tcg|trading card)\b/i;
const GAMBLING_I18N =
  /(xổ số|kết quả xổ|xs(mb|mn|mt)|ngày \d{1,2} tháng|หวย|ロト|当選番号|toto|loto|sorteio|lotofácil|lotomania|quina|primitiva|sorteo|loter[ií]a|mega ?sena|loteria|caixa|timemania|melate|quiniela|bol[ãa]o|大樂透|威力彩|今彩|六合彩|双色球|大乐透|福利彩票|ロト7|로또|복권|福彩|體彩|당첨|\b539\b)/i;
// 赛事查询不是游戏作品："celtic game today" 是赛程，不是游戏名
// （只覆盖 "<赛事> + 时间词"；裸的 "<队名> game" 由 FIXTURE_FORM 覆盖）
const FIXTURE = /\b(game|match|fixture|kickoff)s? (today|tonight|live|score|result|on tv|time|channel)\b/i;
// 赛事 / 盘口词形。**必须与 Sports 分类(17)同时出现**才判定为赛事 ——
// 因为单个 "game" 太泛。这是修 chivas game 类误判的主力：
// Google 把球赛标为 [17]，但把博彩站标成 [6,17]（同时含 Games 分类），
// 所以"纯体育就判噪音"的规则拦不住博彩站，必须在这里拦。
const FIXTURE_FORM =
  /\b(game|games|match|fixture|kickoff|vs|versus|odds|sportsbook|standings|scoreboard|result|results|highlights|lineup|lineups|live stream|injur(?:y|ies)|transfer|transfers|squad|halftime|full ?time|recap|preview)\b/i;
// 订阅服务 / 云游戏平台 —— 是服务，不是"新游戏作品"。
// 实测 "xbox game pass" 会被收录，且它的分类是 [18,6]（不含 17），躲过了赛事规则。
const SERVICE_ONLY =
  /\b(xbox game ?pass|game ?pass|ps ?plus|playstation plus|nintendo switch online|switch online|ea play|geforce now|stadia|amazon luna)\b/i;
// 赛马 / 赛事（Google 有时归到 Games 分类）
const HORSE_RACING = /\b(horse racing|racing disqualification|grand national|kentucky derby|race card|chess olympiad|olympiad 20\d\d)\b/i;
// 主机/外设本身不是"新游戏"
const HARDWARE_ONLY =
  /^(playstation( ?[3-5])?|ps ?[3-5]|xbox( series [xs])?|nintendo( switch( ?2)?)?|switch ?2|steam deck|graphics card|gpu)$/i;
// 应用商店/发行平台本身不是游戏（Google 把它们归进 Games 分类，实测 "google play" 会被误收）
const STORE_ONLY =
  /^(google play( ?store)?|play store|app ?store|microsoft store|steam( store)?|epic games( store)?|nintendo e?shop|itch\.io)$/i;
// ── 人名检测（零依赖，无需任何 API key）─────────────────────────
// 为什么需要：人名与真游戏【词形完全同形】，正则区分不了 ——
//   Leslie Benzies / Don Lee / Mia Ristic / Bruce Straley / Bill Skarsgård / Diogo Morgado
//   Poly Loot     / Blox Fruits / Rat Lab / Slayers 2 / Infant God / Sword Warriors
// 词典能让"首词是不是常见教名"成为区分信号，覆盖实测 24% 的人名噪音，且不联网、不花钱。
//
// 边界（诚实交代）：
//  · 覆盖不了非西方人名，也不如 LLM —— 它只是"没有 key 时也能用"的兜底，不是等价替代
//  · 只在"仅靠 Google 分类这一条证据"时才启用（见 gameCandidate 里的调用），
//    有平台词/意图词（weight≥3）的候选实测几乎全是真游戏，不能误伤
const GIVEN_NAMES = new Set(
  (
    // 英语
    "aaron adam adrian alan albert alex alexander alfred alice alicia allen alvin amanda amber amy andrea andrew angela angelo anita ann anna anne anthony antonio april arnold arthur ashley aubrey audrey barbara barry benjamin bernard bernie beth betty beverly bill billy blake bob bobby bonnie brad bradley brandon brenda brent brett brian bruce bryan caleb calvin cameron carl carla carlos carmen carol caroline carrie catherine cathy chad charles charlie charlotte chase chelsea cheryl chris christian christina christine christopher cindy claire clara clarence claude clifford clint clyde cody colin connie connor conrad corey courtney craig crystal curtis cynthia daisy dale dallas dana dan dana daniel danielle danny darlene darrell darren daryl dave david dawn dean deborah debra denise dennis derek derrick desmond diana diane diego dolores dominic don donald donna dora doris dorothy douglas duncan dustin dwayne dwight dylan earl ed eddie edgar edith edward edwin eileen elaine eleanor elena elias elizabeth ella ellen elmer eloise elsa elsie emily emma eric erica erik erin ernest esther eugene eva evan evelyn everett felix fernando flora florence floyd frances francis francisco frank franklin fred freda frederick gabriel gail gary gene george gerald geraldine gilbert gina giovanni gladys glen glenn gloria gordon grace graham grant greg gregory gwendolyn hank hannah hans harold harriet harry harvey hazel heather hector helen henry herbert herman hilda holly homer hope howard hugh hugo ian irene iris irma isaac isabel ivan jack jackie jacob jacqueline jaime jake james jamie jan jane janet janice jared jason javier jay jean jeff jeffrey jenny jenna jennifer jeremy jerome jerry jesse jessica jesus jill jim jimmy joan joanna joanne joe joel joey johanna john johnny jon jonathan jordan jorge jose josef joseph josephine josh joshua joy joyce juan judith judy julia julian julie julio june justin kara karen kate katherine kathleen kathy katie keith kelly ken kenneth kent kerry kevin kim kimberly kirk kristen kristin kurt kyle lance larry laura lauren laurie lawrence lee leo leon leonard leroy leslie lester lewis liam lila lillian lily linda lisa lloyd lois lori lorraine louis louise lucas lucia lucille lucy luis luke luther lydia lynn mabel mabel madeline mae maggie malcolm manuel marc marcia marco marcus margaret maria marian marie marilyn marion mark marlene marsha marshall martha martin marvin mary mason matt matthew maureen maurice max maxine may mei mel melanie melissa melody melvin mercedes meredith mia michael michele michelle miguel mike mildred miles milton minnie miriam mitchell molly monica morgan morris moses murray myra myrtle nancy naomi natalie nathan nathaniel neil nelson nestor nicholas nick nicolas nina noah nora norma norman nathan olga olive oliver olivia oscar otis owen pablo pam pamela pat patricia patrick patsy paul paula pauline pearl pedro peggy penny percy perry pete peter phil philip phillip phoebe phyllis pierre polly rachel ralph ramon randall randy raul ray raymond rebecca regina reginald rene rex rhonda ricardo richard rick ricky rita robert roberta roberto robin rodney roger roland ron ronald ronnie rosa rose ross roy ruben ruby rudolph russell ruth ryan sally salvador sam samantha samuel sandra santiago sara sarah saul scott sean selena serena seth shane shannon sharon shawn sheila shelley sherry shirley sidney simon sofia sonia sonny sophia sophie spencer stacey stacy stan stanley stella stephen steve steven stuart sue susan susie suzanne sylvia tamara tammy tanya tara ted teresa terrance terrence terry tessa thelma theodore theresa thomas tiffany tim timothy tina toby todd tom tommy toni tony tracy travis trevor tricia trisha troy tyler tyrone ursula valerie van vanessa vera vernon veronica victor victoria vincent violet virginia vivian vivien wade wallace walt walter wanda warren wayne wendell wendy wesley whitney wilbur wilfred will willard william willie wilma winifred winston yolanda yvonne zachary zoe"
    +
    // 西/葡/法/德/意/北欧/其他常见名
    " adolfo agustin alejandra alejandro alessandro alfonso alonso alvaro amparo ana andres angeles antonia antonio arturo aurelio beatriz benito bernardo blanca camila carmela carmen carolina catalina cesar claudia concepcion consuelo cristian cristina dolores eduardo elena emilio enrique ernesto esperanza esteban estela esther eugenio federico felipe fernanda fernando francisca francisco gabriela gerardo gloria gonzalo graciela gregorio guadalupe guillermo gustavo hernando hugo ignacio ines isabel javier jenaro jesus joaquin jorge jose juan julia luis luz manuel marcela margarita maria marisol marta martin mateo mauricio mercedes miguel monica natalia nicolas octavio pablo paloma patricia paula pedro pilar rafael ramon raquel raul ricardo roberto rodrigo rosa rosario ruben salvador sandra santiago sergio silvia sofia sonia teresa tomas valentina veronica vicente victor virginia ximena "
    +
    " adrien alain albert andre antoine armand arnaud aurelie benoit bernard brigitte camille catherine cedric celeste chantal charles claire claude corinne damien daniel david denis denise didier dominique edouard elodie emilie emmanuel etienne fabrice florence franck francois frederic gabriel genevieve georges gerald geraldine gilbert gilles gregory guillaume helene henri herve hugues isabelle jacques jean jerome joel joseph julien laurent laurence luc lucie madeleine marc marcel marguerite marie mathieu mathilde maurice michel monique nathalie nicolas noel olivier pascal patrice patrick philippe pierre raymond rene robert roland sabine sebastien serge simone sophie stephane sylvie therese thierry valerie veronique vincent yves "
    +
    " andreas anke annette ansgar barbara bernd birgit brigitte claudia dieter dirk elke frank franz gerd gerhard gisela gunther hans hartmut heike heinz helga helmut ingrid jens joachim johannes jurgen karin klaus konrad lars manfred marcus martina matthias monika olaf otto petra rainer ralf reinhard renate rudolf sabine siegfried stefan steffen susanne thorsten thomas ulf ulrich ursula uta uwe volker werner wolfgang "
    +
    " alessandra alessio angelo antonio chiara cristina dario davide elena emanuele enrico fabio federica filippo francesca giacomo gianluca giorgio giovanni giulia giuseppe lorenzo luca luigi marco margherita maria matteo massimo michele paola paolo pietro riccardo roberto rossella salvatore sergio simone stefano valentina vittorio "
    +
    " anders anette anna bjorn carl christian dag erik espen fredrik geir gunnar hans ingrid jan jens johan jorgen karin karl kristian lars lena lise magnus marit martin mats nils ola olav per rasmus sigrid sofie stein sven sverre thor tobias trond ulla "
    +
    " ahmed ali amir ayesha fatima hassan hussein imran khalid mohammed muhammad omar rashid saeed salman tariq yusuf zara "
    +
    " aiko akiko daiki daisuke haruto haruka hina hiroshi ichiro kaito kaori kenji kenta mai maki masaru mei michiko naoko ryo sakura sato satoshi shinji takashi takeshi tomoko yuki yuko yumi "
    +
    " ananya arjun deepak ganesh kavya krishna lakshmi meera neha priya rahul rajesh ramesh sanjay sneha sunita vijay vikram "
    +
    // 葡语补充（实测漏网：diogo / tiago / joao 这类巴西、葡萄牙高频名）
    " diogo tiago joao joão pedro henrique lucas gabriel matheus guilherme felipe bruno thiago leandro fabio vinicius duarte joaquim caio murilo otavio renan vinicius"
  ).split(/\s+/).filter(Boolean)
);

// 人名词形：纯拉丁字母词（含重音/连字符/撇号）。
// 🛑 曾经写成"首字母必须大写" —— 但 **Google 热搜词全是小写**（"leslie benzies" 而非
//    "Leslie Benzies"），导致该规则实测命中 0 个。所以只校验"是不是纯字母词"，
//    大小写在比较教名时统一转小写，不靠大小写做判断。
const ALPHA_WORD = /^[\p{Script=Latin}\p{M}][\p{Script=Latin}\p{M}'’\-]*$/u;
const hasDigit = /\d/;

/**
 * 是否"像人名"。零依赖兜底 —— 没有 LLM key 时也能过滤掉最大的一类噪音（实测占 24%）。
 * 判据：2~3 个纯字母词 + 无数字 + 首词是常见教名。
 * @param {string} q
 * @returns {boolean}
 */
export function looksLikePerson(q) {
  const s = String(q || "").trim();
  const words = s.split(/\s+/);
  if (words.length < 2 || words.length > 3) return false; // 人名通常 2~3 个词
  if (hasDigit.test(s)) return false;                     // 游戏常带数字（slayers 2 / gta 6）
  if (!words.every((w) => ALPHA_WORD.test(w))) return false; // 混入符号/缩写就不算人名
  return GIVEN_NAMES.has(words[0].toLowerCase());
}

// 泛化的游戏类词，没有具体指向
const GENERIC_WORD =
  /^(multi ?joueur|multiplayer|jeux|juegos|jogo|jogos|spiel|spiele|giochi|oyun|games?|gameplay|video ?game|videojuegos|gaming)$/i;
// 必须先剥掉修饰词再判断 —— 实测 "free games" / "jeux gratuit" 正是靠修饰词躲过锚定匹配的
const GENERIC_MODIFIER =
  /\b(free|new|best|top|all|online|gratis|gratuit|gratuits|gratuite|kostenlos|gratuitos|completo|espanol|español)\b/gi;
const stripGenericModifiers = (q) => q.trim().replace(GENERIC_MODIFIER, " ").replace(/\s+/g, " ").trim();
// 明确不是游戏的身份类词 / 平台类词（不是"新游戏"）
const NOT_GAME_EXTRA =
  /\b(vtuber|virtual youtuber|バーチャルyoutuber|youtuber|influencer|streamer|celebrity|twitch|discord|reddit|tiktok|instagram|facebook|spotify)\b/i;

// 非拉丁文字体系（做英文站时，这些词不可能是你要的页面标题）
// 用白名单：只放行拉丁字母/数字/标点/符号/空格，其余文字体系一律否决。
// 比"列举非拉丁脚本"可靠 —— 列举法一定会漏语种（藏文、蒙文、僧伽罗文、缅甸文……）
// 注意 \p{Script=Latin} 含变音符号，所以 "New Pokémon Snap" 能正常通过
const NON_LATIN =
  /[^\p{Script=Latin}\p{N}\p{P}\p{S}\p{Z}]/u; // 以下为废弃的旧列举法（有 typo）：\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Arabic}\p{Script=Thai}\p{Script{Cyrillic}\p{Script{Hebrew}\p{Script{Devanagari}\p{Script{Bengali}\p{Script{Tamil}\p{Script{Telugu}\p{Script{Khmer}\p{Script{Lao}\p{Script{Myanmar}\p{Script{Georgian}\p{Script{Armenian}]/u;

// ── AAA 大作 / 饱和品牌 ───────────────────────────────────────
// 这些不是"新游戏该不该建站"的问题，而是"**根本不可能排上去**"的问题。
// `gta 6` / `fifa 27` / `roblox` 这类词，攻略站多如牛毛、且官方站权重极高，
// 对做内容站的人是纯噪音 —— 出现在雷达里只会浪费取曲线的配额。
// 注意：默认**关闭**（`games.excludeAAA`），因为也有人想拿它看大盘热度。
// 自建 IP 续作不在名单里（那种恰恰是能做的新赛道）。
// 🛑 2026-09-25 导出：目录直收 / 队列曲线通道也要过这道闸（collect.mjs 共用）——
//    excludeAAA 只在热搜候选里生效时，Roblox 榜单 / Play 热榜照样把 AAA 灌进库
//    （实测线上 25 条：Roblox / Clash of Clans / Township / Royal Match…）。
export const AAA_FRANCHISES =
  /^(fortnite|minecraft|gta.*|grand theft auto.*|call of duty.*|cod|warzone|valorant|apex legends|overwatch|league of legends|lol|roblox|genshin impact|honkai.*|counter[- ]strike.*|cs ?2|csgo|fifa.*|ea sports fc.*|nba ?2k.*|pubg.*|brawl stars|clash royale|clash of clans|mobile legends|free fire|honor of kings|pokémon go|pokemon go|candy crush.*|among us|township.*|royal match.*|block ?blast.*|pou|fishdom.*|gardenscapes.*|homescapes.*|coin master.*|subway surf.*|whiteout survival.*|last war.*|rise of kingdoms.*|state of survival.*)$/i;

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
  // AAA 大作 / 饱和品牌：可选开关（games.excludeAAA），默认关
  if (opts.excludeAAA && AAA_FRANCHISES.test(q.trim())) return { ok: false, reason: "AAA大作(不可做)", weight: 0 };
  if (!q || NOT_GAME.test(q) || NOT_GAME_EXTRA.test(q)) return { ok: false, reason: "非游戏实体", weight: 0 };
  // 体育分类 + 赛事词形 = 比赛/盘口，不是游戏作品
  if (cats.includes(CAT.SPORTS) && FIXTURE_FORM.test(q)) return { ok: false, reason: "体育赛事/盘口", weight: 0 };
  if (SERVICE_ONLY.test(q)) return { ok: false, reason: "订阅服务", weight: 0 };
  if (FIXTURE.test(q)) return { ok: false, reason: "赛事查询", weight: 0 };
  if (HORSE_RACING.test(q)) return { ok: false, reason: "赛马", weight: 0 };
  if (GAMBLING.test(q) || GAMBLING_I18N.test(q) || BETTING_BRAND.test(q)) return { ok: false, reason: "博彩/彩票", weight: 0 };
  if (SPORTS_MEDIA.test(q)) return { ok: false, reason: "体育媒体/联赛", weight: 0 };
  if (NOT_A_WORK.test(q)) return { ok: false, reason: "非作品实体", weight: 0 };
  if (HARDWARE_ONLY.test(q.trim())) return { ok: false, reason: "主机硬件", weight: 0 };
  if (STORE_ONLY.test(q.trim())) return { ok: false, reason: "应用商店", weight: 0 };
  // 剥掉修饰词后仍是泛化词 → 泛化词（"free games" / "jeux gratuit"）
  if (GENERIC_WORD.test(q.trim()) || GENERIC_WORD.test(stripGenericModifiers(q))) return { ok: false, reason: "泛化词", weight: 0 };
  const inGameCat = cats.includes(CAT.GAMES);
  const platform = GAME_PLATFORMS.test(q);
  const signal = GAME_SIGNALS.test(q);
  if (!inGameCat && !platform && !signal) return { ok: false, reason: "无游戏信号", weight: 0 };
  let weight = 0;
  if (inGameCat) weight += 2;
  if (platform) weight += 2;
  if (signal) weight += 1;
  // 只在"仅靠 Google 分类"这一条证据（weight≤2 且无平台词）时才用词典判人名 ——
  // 有平台词/意图词的候选（weight≥3）实测几乎全是真游戏，判人名会误伤。
  if (weight <= 2 && !platform && looksLikePerson(q)) return { ok: false, reason: "疑似人名", weight: 0 };
  return { ok: true, reason: [inGameCat && "Games分类", platform && "游戏平台词", signal && "游戏意图词"].filter(Boolean).join("+"), weight };
}

/**
 * 可解释打分：搜索量分 + 涨幅分 + 起飞分 + 发现权重
 * 与原站 score 数值不追求一致（其算法未知），仅保证越大越值得做。
 */
export function scoreKeyword({ vol = 0, growth = 0, hype = 0, weight = 0, feedbackBoost = 0 }) {
  const volScore = vol > 0 ? Math.log2(vol / 1000) * 2 : 0; // 2万≈8.6, 200万≈22
  const growthScore = growth / 100;                          // 1000% → 10
  const hypeScore = hype >= 99 ? 8 : hype >= 3 ? 5 : hype >= 1.5 ? 2 : 0;
  return Math.round(volScore + growthScore + hypeScore + weight * 2 + feedbackBoost);
}

/**
 * 雷达分数的**算法自述**：随 games.json 下发，前端据实展示（单一事实源在这里，别在前端再抄一份）。
 * 🛑 措辞必须说清它是「优先级分」不是「可做性分」—— 否则用户会把 score=14 当成"比 6 分的可做性高"。
 */
export const SCORE_RULES = {
  title: "雷达分数 = 验证优先级，不是可做性",
  formula: "score = log₂(搜索量/1000)×2 + 涨幅%÷100 + 起飞档(0/2/5/8) + 识别权重×2 + 人工加分(+6)",
  items: [
    "搜索量：log₂ 尺度 —— 2 千 ≈ 2 · 2 万 ≈ 8.6 · 20 万 ≈ 15 · 200 万 ≈ 22",
    "涨幅：+100% 加 1 分，+1000% 加 10 分（⚠️ 低量噪音的涨幅往往更高，所以它排在权重之后）",
    "起飞档：hype（7 天曲线后半段 ÷ 前半段）≥99 → 8 · ≥3 → 5 · ≥1.5 → 2 · 其余 0",
    "识别权重 ×2：分类 + 平台词/意图词（权重 ≥3 才算强信号，人名噪音全在 2）",
    "人工加分：feedback.boost 里的词 +6（够提前、但盖不过全新游戏）",
  ],
  note: "用途：决定本轮先验证谁。0~100 的「建站可做性」分数在「🎯 建站推荐」，那是另一套（加权平均 + 竞争门槛）。",
};

/**
 * 用户反馈：block = 永久否决（"我说了不要就别再推"）；boost = 加分（"我认为值得做"）。
 *
 * 为什么加这个：噪音过滤规则只能靠"猜词形"，而人看一眼就知道该不该做。
 * 反馈是**确定性信号**，优先级高于任何启发式规则。
 * 精确匹配（忽略大小写与首尾空格），刻意不做模糊匹配 —— 模糊会连带误伤相似的真词。
 *
 * @param {string} q
 * @param {{block?:string[], boost?:string[]}} [fb]
 * @returns {""|"block"|"boost"}
 */
export function feedbackVerdict(q, fb) {
  if (!fb) return "";
  const k = String(q || "").trim().toLowerCase();
  if (!k) return "";
  for (const b of fb.block || []) if (String(b).trim().toLowerCase() === k) return "block";
  for (const b of fb.boost || []) if (String(b).trim().toLowerCase() === k) return "boost";
  return "";
}

/** 反馈加分的分值：够大能显著提前，但不至于盖过"全新游戏"的优先级 */
export const FEEDBACK_BOOST_PTS = 6;

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
