/**
 * LLM 终审层：判断"这个词是不是一个游戏作品标题"
 *
 * ── 为什么需要它（实测依据）──────────────────────────────
 * 正则能挡住体育赛事/博彩/订阅服务，但挡不住【人名】：
 * 实测 games.json 29 条里有 7 条是人名（leslie benzies / diogo morgado / don lee /
 * bruce straley / bill skarsgård / mia ristic），占 24%。
 * 而人名与真游戏在词形上完全同形（都是 2~3 个首字母大写的词）——
 * 真游戏 Poly Loot / Blox Fruits / Rat Lab / Slayers 2 与人名 Leslie Benzies / Don Lee
 * 无法用正则区分，再加规则一定会误伤。
 *
 * ── 五条设计原则（都很重要，别随手改）────────────────────
 * ① 正则先粗筛，只把"已通过正则"的候选交给模型（每轮约 20~50 个）→ 省 token
 * ② 全部候选打成一个请求（一次调用），绝不每个词调一次
 * ③ 判定结果持久化缓存：同一个热词每小时都会再出现，不缓存等于每小时烧一次钱
 * ④ 模型不可用/超时/输出不合规 → 退回正则结果，**绝不中断采集**
 * ⑤ 模型只有【否决权】，没有【录用权】——
 *    只允许它把候选踢掉，不允许它新增。防止幻觉把无关词塞进雷达。
 */
import { readJson, writeJson, dataPath, log, retry } from "./util.mjs";

// OpenAI 兼容的服务商（都用 /chat/completions，所以一套实现全覆盖）
// ⚠️ 模型名会随时间变动。若报 "model not found / 404"，去服务商控制台复制当前可用模型名填到 judge.model。
const PROVIDERS = {
  deepseek: { baseUrl: "https://api.deepseek.com/v1", model: "deepseek-chat", keyEnv: "DEEPSEEK_API_KEY" },
  openai: { baseUrl: "https://api.openai.com/v1", model: "gpt-4o-mini", keyEnv: "OPENAI_API_KEY" },
  // ── 下面几家都有免费额度且**不需要绑卡**（2026-09 核实仍在运营）──
  gemini: { baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai", model: "gemini-2.5-flash", keyEnv: "GEMINI_API_KEY" },
  groq: { baseUrl: "https://api.groq.com/openai/v1", model: "llama-3.3-70b-versatile", keyEnv: "GROQ_API_KEY" },
  cerebras: { baseUrl: "https://api.cerebras.ai/v1", model: "llama-3.3-70b", keyEnv: "CEREBRAS_API_KEY" },
  // ── 国内 ──
  moonshot: { baseUrl: "https://api.moonshot.cn/v1", model: "moonshot-v1-8k", keyEnv: "MOONSHOT_API_KEY" },
  zhipu: { baseUrl: "https://open.bigmodel.cn/api/paas/v4", model: "glm-4-flash", keyEnv: "ZHIPU_API_KEY" },
  siliconflow: { baseUrl: "https://api.siliconflow.cn/v1", model: "Qwen/Qwen2.5-7B-Instruct", keyEnv: "SILICONFLOW_API_KEY" },
  openrouter: { baseUrl: "https://openrouter.ai/api/v1", model: "openai/gpt-4o-mini", keyEnv: "OPENROUTER_API_KEY" },
  // ── 本地：完全免费、不需要任何密钥（但只能在你自己机器上跑，Actions 上不可用）──
  ollama: { baseUrl: "http://localhost:11434/v1", model: "qwen2.5:7b", keyEnv: null },
};

// 🛑 曾有个「零成本在 CI 里免 key 调 LLM」的路子：GitHub Models + 自动注入的 GITHUB_TOKEN。
//    该服务已于 2026-07-30 全面退役 —— 实测端点返回 410 Gone。不要再走这条路。
const RETIRED = {
  "github-models": "GitHub Models 已于 2026-07-30 全面退役（实测端点返回 410 Gone）",
  github: "GitHub Models 已于 2026-07-30 全面退役（实测端点返回 410 Gone）",
};

const SYSTEM = `你在为一个"游戏攻略站"的选题系统做最终质检。
输入是一批 Google 热搜词，已被规则粗筛过，但仍混有非游戏词。
你的任务：判断每个词是不是【一个可玩游戏的名称（作品本体）】。

必须判为"不是游戏"的类别：
- person   人名。例如：leslie benzies / diogo morgado / don lee / bill skarsgård / mia ristic
- sports   体育赛事、球队、联赛、球员。例如：chivas game / padres game / mark allen / cpbl
- gambling 博彩、彩票、盘口。例如：lottozahlen samstag / bolão / euromilhões / pmu résultats / betmgm
- media    影视、剧集、节目、动漫。例如：game of thrones / street fighter movie / caribeña noche
- cards    实体集换卡（买卡，不是玩游戏）。例如：pokemon cards / 30th anniversary pokemon cards
- hardware 主机、外设、公司、技术组件。例如：sony playstation / denuvo / gamestar
- service  订阅服务、配套 App。例如：xbox game pass / companion app fc 27
- generic  泛化词，没有具体指向。例如：free games / jeux gratuit

必须判为"是游戏"的：具体的游戏作品名，含续作与系列。
例如：gta 6 / fifa 27 / ea sports fc 27 / aion 2 / fire emblem / horizon forbidden west /
      brawl stars / blox fruits / poly loot / rat lab / slayers 2 / wow forever beta / wordle hints

⚠️ 最容易犯的错：真实游戏名也常常是两三个普通单词（Poly Loot / Rat Lab / Blox Fruits），
不要因为"读起来像人名"就否决它 —— 要判断它是不是一个游戏作品。
人名通常能认出是"名 + 姓"的真人；不确定时倾向判为游戏（宁可漏杀，不可错杀）。

只输出 JSON，不要任何解释文字。`;

const userPrompt = (words) =>
  `请判断下面 ${words.length} 个热搜词。每个词后面附上 Google 给的分类 ID 作为参考
（6=游戏 17=体育 4=娱乐 18=科技 3=商业 11=其他；分类只是参考，Google 经常标错）。

${words.map((w, i) => `${i + 1}. "${w.q}"  [cats=${JSON.stringify(w.cats || [])}]`).join("\n")}

输出严格如下 JSON（verdicts 数组长度必须等于 ${words.length}，q 必须原样照抄，不要改大小写）：
{"verdicts":[{"q":"原词","game":true,"kind":"game","why":"不超过15字的理由"}]}
kind 取值只能是：game / person / sports / gambling / media / cards / hardware / service / generic / other`;

/** 解析模型输出。抽出 JSON，并**丢弃所有不在入参里的 q**（防幻觉新增）。 */
export function parseVerdicts(text, queries) {
  if (!text) return { verdicts: [], error: "空响应" };
  let obj = null;
  // 容错：模型可能包 ```json 围栏，或前后带解释文字
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidates = [fence?.[1], text];
  for (const c of candidates) {
    if (!c) continue;
    try { obj = JSON.parse(c.trim()); break; } catch { /* 试下一个 */ }
    const brace = c.match(/\{[\s\S]*\}/);
    if (brace) { try { obj = JSON.parse(brace[0]); break; } catch { /* 继续 */ } }
  }
  if (!obj || !Array.isArray(obj.verdicts)) return { verdicts: [], error: "输出不是合法 JSON 或缺少 verdicts" };

  const valid = new Set(queries.map((q) => q.toLowerCase().trim()));
  const out = [];
  let dropped = 0;
  for (const v of obj.verdicts) {
    const q = String(v?.q ?? "").toLowerCase().trim();
    // 🛑 只接受入参里存在的词：模型幻觉出来的新词一律丢弃
    if (!valid.has(q)) { dropped++; continue; }
    out.push({
      q,
      game: v?.game !== false, // 只有明确 false 才算否决
      kind: String(v?.kind || "other").slice(0, 20),
      why: String(v?.why || "").slice(0, 60),
    });
  }
  return { verdicts: out, dropped, error: null };
}

function resolveProvider(cfgJudge = {}) {
  const key = cfgJudge.provider || "deepseek";
  // 已退役的服务商要给出明确原因，而不是静默按别的服务商跑（那样报错会很难懂）
  if (RETIRED[key]) {
    log("err", `  judge.provider="${key}" 不可用：${RETIRED[key]}。请改用：${Object.keys(PROVIDERS).join(" / ")}`);
  } else if (cfgJudge.provider && !PROVIDERS[key]) {
    log("warn", `  judge.provider="${key}" 不是内置服务商，将按 deepseek 处理。可选：${Object.keys(PROVIDERS).join(" / ")}`);
  }
  const preset = PROVIDERS[key] || PROVIDERS.deepseek;
  // 允许用环境变量覆盖（换服务商/换模型时不必改 config.json，也方便本地用 mock 服务测试）
  const baseUrl = process.env.JUDGE_BASE_URL || cfgJudge.baseUrl || preset.baseUrl;
  const model = process.env.JUDGE_MODEL || cfgJudge.model || preset.model;
  // key 查找顺序：显式配置 → 通用 JUDGE_API_KEY（CI 推荐）→ 服务商默认变量 → 本地 config
  const envNames = [cfgJudge.apiKeyEnv, "JUDGE_API_KEY", preset.keyEnv].filter(Boolean);
  let apiKey = "";
  let from = "";
  for (const n of envNames) {
    if (process.env[n]) { apiKey = process.env[n]; from = n; break; }
  }
  if (!apiKey && cfgJudge.apiKey) { apiKey = cfgJudge.apiKey; from = "config.json(不推荐)"; }
  return { baseUrl, model, apiKey, from, provider: key, needsKey: preset.keyEnv !== null };
}

function loadCache(cfg) {
  const c = readJson(dataPath(cfg, ".judge-cache.json"));
  return c && typeof c.entries === "object" ? c : { updated: null, entries: {} };
}

/**
 * 读取已缓存的判定结果，供"按当前规则重筛"复用。
 * 为什么需要：LLM 否决过的词如果只在取曲线时被跳过，
 * 它一旦进了 games.json 就再也不会被清掉（和噪音规则踩过的是同一个坑）。
 */
export function loadVerdicts(cfg) {
  const c = loadCache(cfg);
  const m = new Map();
  for (const [k, v] of Object.entries(c.entries || {})) m.set(k, v);
  return m;
}

/**
 * 对候选做终审。
 *
 * ⚠️ `existing` 参数是必需的，不是可选优化：
 * 候选列表 `cands` 是在【新鲜度过滤之后】才构建的 —— 已经追踪过、且曲线还新的词
 * 根本不会出现在 cands 里。若只送审 cands，games.json 里的存量脏词（人名等）
 * 永远拿不到否决判定，就会一直留在库里（实测：只送审新词时 13 个存量脏词一个都没清掉）。
 * 所以必须把"已追踪的游戏名"一并送审。
 *
 * @param {Array} cands 新候选 [{q, cats, geo, ...}]
 * @param {object} cfg
 * @param {string[]} [existing] 已追踪的游戏名（用于清存量脏词）
 * @returns {Promise<{kept:Array, dropped:Array, stats:object, verdicts:Map}>} 只做否决，不会新增
 */
export async function judgeCandidates(cands, cfg, existing = []) {
  const j = cfg.judge || {};
  const stats = { mode: "off", judged: 0, cached: 0, dropped: 0, error: null, model: "", via: "" };
  const verdictOf = new Map();
  if (j.enabled === false) return { kept: cands, dropped: [], stats, verdicts: verdictOf };

  const p = resolveProvider(j);
  stats.model = p.model;
  stats.via = p.provider;
  if (p.needsKey && !p.apiKey) {
    // 🛡 没配 key 不是错误：静默退回正则结果，采集照常完成
    log("dim", `  LLM 终审未启用（未找到 ${[j.apiKeyEnv, "JUDGE_API_KEY", PROVIDERS[p.provider]?.keyEnv].filter(Boolean)[0] || "API Key"}），沿用规则结果`);
    stats.mode = "no-key";
    return { kept: cands, dropped: [], stats, verdicts: verdictOf };
  }

  // 候选 + 存量 合并去重后一起送审（一次调用，省 token 也省钱）
  const all = new Map();
  for (const c of cands) all.set(String(c.q).toLowerCase().trim(), { q: c.q, cats: c.cats || [] });
  for (const n of existing) {
    const k = String(n).toLowerCase().trim();
    if (k && !all.has(k)) all.set(k, { q: n, cats: [] });
  }

  const cache = loadCache(cfg);
  const ttlMs = (j.cacheDays || 30) * 86400_000;
  const now = Date.now();

  // 先看缓存：同一个热词每小时都会再出现，缓存是省钱的关键
  const needJudge = [];
  for (const [k, w] of all) {
    const hit = cache.entries[k];
    if (hit && now - new Date(hit.at).getTime() < ttlMs) {
      verdictOf.set(k, hit);
      stats.cached++;
    } else if (needJudge.length < (j.maxPerRun || 80)) {
      needJudge.push(w);
    }
  }

  if (needJudge.length) {
    try {
      const fresh = await callLLM(p, needJudge, j);
      stats.judged = fresh.length;
      for (const v of fresh) {
        verdictOf.set(v.q, { ...v, at: new Date().toISOString(), model: p.model });
        cache.entries[v.q] = { ...v, at: new Date().toISOString(), model: p.model };
      }
      // 缓存瘦身：只留最近的 N 条，避免无限增长
      const keys = Object.keys(cache.entries);
      const CAP = j.cacheMax || 5000;
      if (keys.length > CAP) {
        keys.sort((a, b) => new Date(cache.entries[b].at) - new Date(cache.entries[a].at));
        for (const k of keys.slice(CAP)) delete cache.entries[k];
      }
      cache.updated = new Date().toISOString();
      writeJson(dataPath(cfg, ".judge-cache.json"), cache);
    } catch (e) {
      // 🛡 终审失败绝不中断采集：退回正则结果，只记 warn
      log("warn", `  LLM 终审失败（${e.message}），本轮沿用规则结果`);
      stats.error = e.message;
      stats.mode = "failed";
      return { kept: cands, dropped: [], stats, verdicts: verdictOf };
    }
  }

  const kept = [];
  const dropped = [];
  for (const c of cands) {
    const v = verdictOf.get(String(c.q).toLowerCase().trim());
    if (v && v.game === false) {
      dropped.push({ ...c, judgeKind: v.kind, judgeWhy: v.why });
    } else kept.push(c);
  }
  stats.dropped = dropped.length;
  stats.mode = "on";
  return { kept, dropped, stats, verdicts: verdictOf };
}

async function callLLM(p, words, j) {
  const url = `${p.baseUrl.replace(/\/$/, "")}/chat/completions`;
  const body = {
    model: p.model,
    temperature: 0,
    messages: [
      { role: "system", content: SYSTEM },
      { role: "user", content: userPrompt(words) },
    ],
  };
  if (j.jsonMode !== false) body.response_format = { type: "json_object" };

  const doFetch = async (payload) => {
    const r = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(p.apiKey ? { authorization: `Bearer ${p.apiKey}` } : {}),
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(j.timeoutMs || 60000),
    });
    if (!r.ok) {
      const t = (await r.text()).slice(0, 200);
      const err = new Error(`HTTP ${r.status} ${t}`);
      err.status = r.status;
      throw err;
    }
    return r.json();
  };

  let data;
  try {
    data = await retry(() => doFetch(body), { retries: 2, base: 2000, label: "judge" });
  } catch (e) {
    // 有些服务商不支持 response_format，会返回 400 —— 去掉再试一次
    if (e.status === 400 && body.response_format) {
      delete body.response_format;
      data = await retry(() => doFetch(body), { retries: 2, base: 2000, label: "judge(no-json-mode)" });
    } else throw e;
  }

  const text = data?.choices?.[0]?.message?.content || "";
  const { verdicts, dropped, error } = parseVerdicts(text, words.map((w) => w.q));
  if (error) throw new Error(`输出解析失败：${error}`);
  if (dropped) log("dim", `  终审丢弃了 ${dropped} 个模型幻觉出来的词（不在入参里）`);
  return verdicts;
}
