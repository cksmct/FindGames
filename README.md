# Keyword Radar · 自建全球热词与新游戏雷达

反推 `findnews.me` 的实现机制后，从零重建的一套「找词系统」。零第三方依赖（纯 Node 内建模块），产出静态 JSON + 本地看板。

> 📖 **想理解这套系统的原理与设计思路**（数据源机制、判断力从哪来、所有踩坑记录、怎么自己扩展），看 **[`docs/DESIGN.md`](docs/DESIGN.md)**。
> 本文档只讲「怎么用」和「反推结论」，那份讲「为什么」。

---

## 一、原站（findnews.me）实现机制反推

### 1. 站点形态（直接可验证）

| 项 | 结论 | 证据 |
|---|---|---|
| 架构 | 纯静态站，无后端、无数据库 | 首页 4.6 KB，只有 `style.css` / `app.js`，无框架 |
| 渲染 | 前端 `fetch` 读 `data/*.json` 后拼字符串渲染 | `app.js` 全文 14 KB，`fetchJson("data/trends.json")` |
| 数据文件 | `data/trends.json`、`data/history.json`(+`history-p2..p21.json`)、`data/games.json` | 直接 200 可下 |
| 分片策略 | `history.json` 存首 3000 条 + `chunks:21`，其余分片各 3000 条 | 实测 `history.json` 的 `items:3000, chunks:21` |
| 更新频率 | 每小时（页脚自述「数据每小时自动更新」） | 快照时间戳 `2026-09-18T07:12Z` |
| 商业闭环 | 微信引流建群（个人号 + 公众号） | 页面 `#community` 区 |

### 2. 数据源：Google Trends 实时上升热搜（关键突破）

数据字段与 Google Trends 内部接口逐字段对应，**可以确证**：

- `cats` 的取值是 `{1,2,3,...,10,11,13,14,...,20}` —— 这正是 **Google Trends 官方分类 ID 体系**（1 汽车、6 游戏、17 体育、20 气候…），原站只是把它翻译成了中文。任何其他数据源都不会恰好命中这套 ID。
- `vol` 取值集合 = `{100,200,500,1000,2000,5000,10000,20000,50000,100000,200000,1000000,2000000}` —— Google Trends 的**官方流量分桶**。
- `growth` 取值集合 = `{50,75,100,200,...,900,1000}` —— 官方涨幅分桶。
- 原站筛选按钮的档位 `≥2万 / ≥10万 / ≥50万`、`≥200% / ≥500% / ≥1000%` 正是上述分桶的原值。

接口是 `trends.google.com/_/TrendsUi/data/batchexecute` 的 `rpcid=i0OFE`（就是 Trends 网站「Trending Now / 实时上升热搜」面板背后那一个请求），POST 表单 `f.req=...`，返回 `)]}'` 前缀的 JSON。单项结构：

```
item[0]  = 热搜词
item[2]  = 地区码
item[3]  = [时间戳(秒)]
item[6]  = 搜索量分桶
item[8]  = 涨幅分桶 (%)
item[9]  = 相关搜索词数组（实测最多 150+ 个）
item[10] = 官方分类 ID 数组（可多个，如 [8,13]）
```

### 3. 采集窗口 = 24 小时（逐国吻合验证）

请求载荷第 6 位是时间窗口。用 24 小时抓取的结果与原站留存条数**逐国吻合**，24/48 小时则差一倍：

| 地区 | 我们 hours=24 | 原站 | 我们 hours=48 |
|---|---|---|---|
| GB | 280 | 282 | — |
| IN | 313 | 312 | — |
| DE | 389 | 381 | — |
| US | 304 | 277 | 646 |
| TW | 173 | 165 | 353 |

差异仅来自采集时点不同，**原站没有做搜索量门槛过滤**。

### 4. 其余模块（部分为合理推断）

- **history**：7 天滚动归档，按 `(词, 地区)` 去重，保留 `vol_peak` / `growth_peak` / `first` / `last` / `sightings`，按峰值降序。
- **games**：从热搜里挑游戏候选，调 `/trends/api/explore` + `/trends/api/widgetdata/multiline` 取 7 天兴趣曲线。原站曲线约 43 点 = 169 个小时点**每 4 小时抽样**（推断；原站 `games.json` 首条 `Slayers 2` 与我们实时抓到的曲线趋势一致，从 0 涨到 100）。
- **zh 字段**：机器翻译（具体服务商无法反推）。
- **noise 字段**：噪音分类标签（如 `"天气"`），规则无法反推，见下文「我们自建」。
- **score 字段**：算法无法反推（只能看到结果值）。

### 5. 原站游戏雷达为什么能攒到 390 个？（量化结论）

拉下原站 `games.json` 实测：

```
总数 390 · first 跨度 2026-09-04 → 2026-09-18（13.8 天）· 平均新增 28.2 个/天（1.17 个/小时）
series 长度 43（367 个）/ 56（23 个）· 390/390 全部有曲线 · score 范围 2 → 18
sightings 分布：1次×253、2次×60、3次×31 … 最多 19 次
```


**结论：它不是一次抓那么多，是连续累积的（平均 28.2 个/天）。** 但下面这条旧结论在 **2026-09-20 被实测推翻**：

> ~~它几乎没有游戏识别过滤，把 Games 分类的词近乎全量喂给曲线接口~~

**实测（2026-09-20 逐名核对）证明：原站的游戏不是从 Google Trends 热搜里来的。**

- 原站 `games.json` 的 404 个游戏，只有 **14 个**能在原站自己发布的 7 天热搜留档（56,861 条）里找到；
- 在同一天发布的 24h 热搜（2,173 条）里只重合 **2 个**；
- 热搜词自带的相关搜索（`item[9]`，实测全小写）里也找不到它们。

**真正的来源是「游戏目录」（多源），可以逐名核对：**

| 来源 | 逐名吻合的证据 |
|---|---|
| **Roblox Discover 榜单** | `apis.roblox.com/explore-api/v1/get-sorts` 的 5 个榜单（约 230 个体验名），就是它列表里的 `Ride A Pet` / `Build the Pyramid!` / `Rat Lab` / `Lumber Tycoon 2` / `Royale High` / `Anime Dice` / `Slayers 2` / `The Hunt: Roblox 20`；且名字正好是榜单名去掉 `[UPD]` `[ALPHA]` emoji 装饰后的结果 |
| **Steam 商店榜单** | `Angel Engine`(#4173750) / `Infant God`(#4238140) / `Aniimo`(#4126040) / `Valheim` / `No Man's Sky` / `ENDLESS Legend 2` 都能在 Steam 的新发售、即将发售、特惠榜单里逐个找到 |
| **App Store 游戏榜（手机端）** | `itunes.apple.com/us/rss/topfreeapplications/limit=100/genre=6014/json`（6014 = Games 分类）与 `newfreeapplications`（最新上架，新版 RSS 已忽略 genre，本地按 category 过滤）；纯 JSON、无需 key |

**所以热搜的角色变了**：它不负责「发现新游戏」，只负责**验证「这个游戏现在热不热」**（拉 7 天兴趣曲线）。
本仓库已按这个机制实现：

```
sources.mjs  →  Roblox 榜单 + Steam 榜单（多源候选）
queue.mjs    →  候选队列（来源每天产出几百个，曲线配额只有几十个/轮，必须排队）
interest.mjs →  7 天曲线验证（explore + multiline），通过才写进 games.json
```

旧的「搜索量门槛」结论作废：`minVol` / `strongSignal` 只作用在**热搜候选**那条腿上。

顺带一个重要发现：**原站游戏列表里大量是 Roblox 游戏**——`Poly Loot`、`Defeat Anime RNG`、`BloxNote`、`Venture AOT`、`Anime Ascendants`、`Sword Hunter`、`Grow a Chicken Fighter`、`Dungeon Quest Reborn`。这条赛道对做 Roblox 攻略站的人直接可用。

### 6. 还原度评估

| 层面 | 还原度 | 说明 |
|---|---|---|
| **数据源** | **100%** | 同一接口 `i0OFE`、同一 24h 窗口、同一 cookie 策略、同一分桶语义 |
| **数据结构** | **~100%** | 4 个 JSON 的字段级对齐（含 `cats` 官方分类、`vol_peak`/`growth_peak`/`sightings`/`chunks` 分片）。我们产出的 `trends.json` 可直接替换原站文件 |
| **采集调度** | **100%** | 每小时一轮、7 天滚动留档、峰值合并、按峰值降序 |
| **游戏雷达** | **90%（2026-09-20 反推升级）** | 候选来源已反推并复刻：Roblox Discover 榜单 + Steam 商店榜单 → 候选队列 → 7 天曲线验证（`explore` + `multiline`、43 点 = 169 小时点每 4 小时抽样）；剩下的差别是它的**保留/淘汰公式**未知（我们用自己的白盒 score 规则）|
| **noise / score** | **0%（自建）** | 只能看到结果值，反推不出公式。我们自建可解释版本，数值不与原站一致 |
| **UI** | **独立实现** | 未抄任何前端代码，界面自研（信息密度更高、多了词池与相关词展开） |

一句话：**数据管道等价，判据层是自建，表现层是独立实现。**

---

## 二、我们的实现（本仓库）

目录结构：

```
config.json              配置：国家、阈值、监控词、游戏雷达参数
src/
  collect.mjs            采集主流程（每小时跑这个）
  report.mjs             终端报表 + CSV 导出
  serve.mjs              本地看板服务
  lib/
    trends.mjs           Google Trends 实时热搜采集（i0OFE）+ 重试/限流处理
    interest.mjs         7 天兴趣曲线 + 相关查询（explore/multiline/relatedsearches）
    sources.mjs          游戏候选来源：Roblox Discover 榜单 + Steam 商店榜单（原站真正的 intake）
    queue.mjs            候选队列：来源每天产出几百个，曲线配额有限，必须排队逐轮验证
    detect.mjs           噪音分类 / 新游戏识别 / 可解释打分
    pool.mjs             关键词池聚合
    store.mjs            7 天留档、峰值合并、分片输出
    translate.mjs        可选中文翻译（默认关）
    util.mjs             通用工具
web/                     静态看板（index.html / app.js / style.css）
data/                    生成物
export/                  CSV 导出
```

### 相比原站的增强

| 能力 | 原站 | 我们 |
|---|---|---|
| 相关搜索词 `item[9]` | **完全丢弃** | 聚合成 `keywords.json` 词池，带「被哪些热搜带出」和次数 |
| 关键词池 | 无 | 6k+ 词（7 天滚动累积），可按监控词过滤，一键导 CSV |
| 业务相关度标注 | 无 | config `watch` 词表，命中打 ★（做站的人只关心自己的领域） |
| 新游戏识别 | 黑盒 | **已反推复刻**：候选来自多源游戏目录（Roblox 榜单 / Steam 商店），热搜只负责热度验证；热搜自身仍走白盒规则（Games 分类 / 平台词 / 意图词 + 剔除体育影视彩票）|
| 新游戏的可做页面词 | 只有游戏名 | 每个游戏附带 **Rising + Top 相关查询（攻略词）**，点出去是与游戏名的对比图，并汇入词池可导出 |
| 打分 | 黑盒 | 可解释：搜索量分 + 涨幅分 + 起飞分 + 发现权重 |
| 噪音 | 黑盒 | 白盒规则表，可直接改 `src/lib/detect.mjs` |
| 数据出口 | 只能看网页 | 终端报表 + 4 张 CSV |

### 快速开始

```bash
node src/collect.mjs          # 全量采集（38 国，约 20-30 秒）
node src/report.mjs           # 终端看板
node src/report.mjs --csv     # 导出 export/*.csv
node src/serve.mjs            # 看板 http://localhost:8787/

# 常用参数
node src/collect.mjs --geos US,GB,JP,KR,TW   # 只跑指定国家
node src/collect.mjs --no-games              # 跳过游戏雷达
node src/collect.mjs --only-games            # 只跑游戏雷达（沿用上一轮热搜）
node src/report.mjs --watch --top 40         # 只看命中监控词的
```

### 产物格式

```jsonc
// data/trends.json
{ "updated": "...", "geos": ["US", ...], "cats": { "6": "游戏", ... },
  "items": { "US": [ { "q": "brawl stars", "vol": 50000, "growth": 1000,
                       "cats": [6], "noise": "", "new": 1, "watch": ["roblox"] } ] } }

// data/history.json  (+ history-p2.json ...)
{ "updated": "...", "chunks": 2,
  "items": [ { "q": "...", "geo": "US", "cats": [6], "vol_peak": 50000,
               "growth_peak": 1000, "first": "...", "last": "...",
               "sightings": 3, "noise": "", "zh": "" } ] }

// data/keywords.json  ← 找词主力
{ "updated": "...", "total": 6193,
  "items": [ { "q": "brawl stars tier list", "kind": "related", "count": 4,
               "parents": ["brawl stars"], "geo": ["US"], "vol": 0, "growth": 0,
               "watch": [], "first": "...", "last": "..." } ] }

// data/games.json
{ "updated": "...", "items": [ { "name": "brawl stars", "series": [7, 11, ...],
    "chart_at": "...", "chart_geo": "BR", "first": "...", "last": "...",
    "sightings": 1, "hype": 0.83, "score": 23, "reason": "Games分类+游戏平台词",
    "rising": ["brawl stars tier list", "..."],   // 上升相关查询（已做相关性过滤）
    "words":  ["brawl stars tier list", "..."]    // rising + top 合并去重后可直接用的词
} ] }
```

### 看板怎么用 · 游戏雷达的三个关键认知

**① 每张卡片同时给「游戏名」和「可做页面的词」**

游戏雷达抓的主体是**作品本体**（`Slop Tower Defense`、`Slayers 2`、`BloxNote`……），用途是**告诉你「有个新游戏正在起量，该建站了」**。

每张卡片下方还有一行 **「可做页面的词」** —— 同一个游戏在 Google Trends 上的相关查询。以 GTA VI 为例（实测输出）：

```
🔥 grand theft auto vi ps5 gamepad    grand theft auto vi car physics
   grand theft auto vi album preorder  characters in grand theft auto vi
```

- **🔥 = 上升词**（Rising），正在起量，最值得抢
- 无 🔥 = 最热门相关查询（Top），搜索量已经稳定
- **点任意一个词 → 打开 Google Trends 的「该词 vs 基准词」对比图**。为什么不直接看单词？因为新词和长尾词单独看几乎是一条平线，配上一个基准词才有可比性。基准词由 `config.json` 的 **`trendsCompare`** 决定（当前是 `GPTs`），热搜表的「趋势」链接同样会带上它
- 这些词同时汇入 **「关键词池」**（标记为 🎮 攻略词），可统一筛选、导出 CSV

**①.5 ⛔ 已回退：「vs 基准词（GPTs）」同尺度对比（2026-09-24 试过、同日回退）**

为什么值得试：每张卡的迷你曲线是**按该词自己峰值归一化**的（峰值恒 100），所以**卡片之间不能比高低**；
要"一目了然"地比大小，就必须有一条**共同尺度**，而 Trends 只在**同一次请求**里给出共同尺度。
做法（代码仍在 `src/lib/interest.mjs`，配置项 `compareYardstick`）：候选 + 基准词放进同一次 Trends 请求
（最多 5 个词 → 4 个候选 + 1 个基准），拿到共享尺度后算「峰值比 / 周均比」。

**回退原因（实测）**：**2/3 的条目算出来是 0**（36 条里 24 条）—— 而"0"里混着两种完全不同的东西：

| 情况 | 实测证据 | 意味着什么 |
|---|---|---|
| 该词在这 7 天窗口**没有可报告数据** | `Fishing Inc` 单独请求也**没有数据**（169 点 `hasData` 全 false） | 是"**这游戏已经凉了**"，与基准词无关 |
| 有数据但被**共享尺度取整成 0** | `GPTs` 峰值恒为 100 → 分辨率下限 = GPTs 的 **1%** | 是**基准词太大的假象**（GPTs 对多数新游偏大） |

把两类都读成"没需求"会**大面积错杀**（而我们盯的恰恰是小游戏），所以整个口径停用：
`compareYardstick.enabled: false`，前端已无该显示与排序（保留在 git 历史里）。

> ⚠️ 若将来要重启：**换一个量级接近的基准词**，并且**不要拿 0 当硬否决**。
> 💡 顺带发现的真问题（比基准词更有价值）：上表第一行那个"这词现在没数据了"本身就是**"已经凉了"的信号**，
> 但它**不需要基准词也能测** —— 刷新条目自己的曲线即可（当前卡片的曲线是**发现那一刻的快照**，`chart_at` 之后从不更新）。
> **→ 已实现：见下面的 ①.6 ❄️ 曲线保鲜。**

<details><summary>当初的实现细节（已停用，仅备查）</summary>

**①.5 卡片上的「vs 基准词」那一行 = 唯一可比的口径（2026-09-24 新增）**

🛑 **卡片的迷你曲线是「按该词自己峰值归一化」的**（`sparkSvg` 用自己的 min/max）→ 峰值恒为 100
→ **卡片之间不能比高低**：一个几乎没人搜的小游戏，曲线也会被拉得和爆款一样高。
要"一目了然"地比大小，就必须有一条**共同尺度**，而 Trends 只在**同一次请求**里给出共同尺度。
（`enrichCompare` · `src/lib/interest.mjs`）

做法：把每轮最多 `compareYardstick.maxPerRun`（默认 16）个候选按 `batch`（4 个）分组，
**每组 + 1 个基准词放进同一次 Trends 请求**（Trends 上限 5 个词，所以是 4+1），
拿到共享尺度后把两个比值写进条目（`g.cmp`）：

| 字段 | 含义 | 为什么两个都要 |
|---|---|---|
| `ratioPeak` | 峰值 ÷ 基准峰值 | 一眼看量级（新词常是"一次尖峰"） |
| `ratioAvg` | 周均 ÷ 基准周均 | 尖峰之外的**持续**热度（只报峰值会高估） |

页面另有一对**对数宽度**的对比条（本词 vs 基准）：线性宽度会把小词全压成一条线，看不出差别。
排序加了 **「⚖️ 相对 <基准> 强度」**，**未测的一律沉底**（不拿 0 冒充），meta 行会写出"已测 N/共 M"。

**实测为 0 → 直接在推荐页否决**（用户口径：「和 GPTs 比是 0 的，我不需要做」）：
这一条是**硬否决**而不是扣分（`pickVerdict`），排序里也沉到最底 —— **比「未测」更靠后**
（未测是"还不知道"，0 是"已经知道没需求"）。依据是 Google 的 `hasData`：
`false` = 整个窗口都没有该词的可报告数据（实测 `Fishing Inc` 169 个点全是 `false`）；
即使 `hasData` 为 `true`，峰值在共享尺度上被取整成 0 也说明"相对基准低两个数量级以上"。

实测边界（**都是 Google 侧限制，不是 bug**）：

- **整数取整 = 分辨率下限**：加了基准词后小词的取值会被压得很粗 —— 实测 `Slime Out Fish` 全程只有
  **3 个不同取值**（0 / 1 / 73）。所以这份数据**只能算比值，不能当显示曲线**（上屏的仍是自己归一化那份）。
  比值低于 0.005× 时统一显示 **`<0.005×`**（被取整为 0，只能给下界）。
- **量级差太大时基准会整列取整为 0**：实测 `wordle` vs `GPTs` → 基准列全 0 → 比值**不可测**，页面如实写「不可测」。
- **不同词不能跨请求比绝对值**：每个请求都会重新归一化到"本请求最大 = 100"，
  所以**比值**可比（比值对归一化不变），**绝对值**不可比。基准词必须是同一个（`trendsCompare`）。
- 想要更好的分辨率，可把 `trendsCompare` 换成**量级更接近**的词（GPTs 对多数新游偏大：首轮实测 8 个里 6 个峰值被压到 `0`）
  —— 基准词只有 `trendsCompare` 这一处事实源，页面与采集都会跟着走。

</details>

**①.6 ❄️ 曲线保鲜（2026-09-24 新增）**

要解决的问题：卡片上的曲线是**发现那一刻的快照**（`chart_at`），之后**从不更新** ——
一个几天前爆过、现在已经没人搜的游戏，卡片上仍挂着那条漂亮曲线，还会顶着高分留在推荐页。

做法（`enrichCurveRefresh` · 配置 `games.curveRefresh`）：每轮把**快照最旧**的 `maxPerRun`（默认 10）条
「有曲线的」条目重取一次（只取曲线、不取相关词 → 每条 2 次请求）；
超过 `hours`（默认 48h）才算过期；按来源公平抽样（否则 Roblox 会被饿死，见下）。

| 重取结果 | 动作 |
|---|---|
| **有量** | 覆盖 `series / peak / hype / chart_at`（卡片与推荐页的动能跟着更新）；冷却计数清零；原先标了 ❄️ 就**撤掉**（复活） |
| **成功但没有量** | `coolStreak++`；连续 `coolStreak`（默认 2）次 → 标 `cooled`：卡片显示 ❄️，推荐页降到「⚠️ 观察」档 |
| **失败**（429 / 结构异常） | **什么都不改**，也不累加冷却计数 —— 限流 ≠ 这游戏凉了（负缓存禁令第三次出现在同一个地方） |

> 为什么"连续 2 次"才标：单次"没有量"有可能是 Google 侧的瞬时口径抖动，
> 而"取数失败"已经单独区分开了；再要一道计数，是为了避免像 GPTs 对比那样**一次测量就大面积改判**。

> 📌 待验证的改进（当天 Trends 配额已被打满，没法测）：在同一次请求里放**同一个词的 7 天 + 28 天两个窗口**
> （`comparisonItem` 里同 `keyword`、不同 `time`），若可行就能一次拿到"新鲜曲线 + 真实衰减"，
> 比现在只看"有没有量"灵敏得多。验证方法：看 multiline 是否返回 2 列。

| 你的动作 | 看哪里 |
|---|---|
| 发现新游戏（**选题**） | 🎮 新游戏雷达 |
| 拿该游戏的可做页面词（**起标题**） | 卡片下方的「可做页面的词」 |
| 跨游戏批量找词 / 导出 | 🔑 关键词池（筛 🎮 攻略词） |

两个已知边界（**都是 Google 侧限制，不是 bug**）：

1. **搜索量太低的词没有相关查询**：实测 17 个游戏里有 6 个（多为日语生僻新词）返回 HTTP 200 但 `rankedList` 是空的。这类游戏只保留曲线，没有词。
2. **Rising 列表会混入同期爆红的无关词**：实测 GTA VI 的 rising 里出现了 `kroger`、`helldivers`、`brain eating amoeba`。已加**相关性过滤**（相关词必须含游戏名里的一个实词，过滤后 GTA VI 的 8 个 rising 全部与游戏相关）；但 **Top 列表不过滤**，否则会误删 `gta` 这类缩写词。

**② 它不分国家（和原站一致）**

游戏雷达是全局列表，不受顶部国家筛选影响。但每条都记录了：`geos`（在哪些国家上榜过）、`chart_geo`（曲线取自哪个国家，优先取你在 `config.games.geos` 里指定的市场），卡片上会显示「曲线地区 XX」。

**③ 排序：原站按「最新信号」，我们默认「最新发现」，并给了切换**

拿 388 条原站数据实测，**只有 `last`（最新信号时间）是单调键**，score / first / sightings / 峰值 全都不是 —— 所以原站是「**最近还在被搜的排最前**」，**不是按分数**。

| 排序 | 含义 | 适合 |
|---|---|---|
| 🆕 **最新发现**（我们的默认） | 首次发现时间倒序 | **抢首发**：刚冒头的排最前 |
| 📡 最新信号 | 最后一次上榜时间倒序（= 原站行为） | 看当下谁还在热 |
| 🔥 分数 | `score` 倒序（搜索量 + 涨幅 + 起飞度 + 发现权重） | 优先做已起量的 |

**为什么默认和原站不同**：按 `last` 排会让「很久前发现、今天偶然又被搜一下」的老游戏挤到最前，把真正的新游戏压下去。你的目标是第一时间发现新游戏，所以 `first` 倒序更贴合 —— 但三个都给了，随时切。

### 配置要点（`config.json`）

| 键 | 说明 |
|---|---|
| `geos` | 国家列表，默认 38 个 |
| `hours` | 请求时间窗口，**默认 24（与原站一致）** |
| `minVol` | 热搜入库门槛，默认 0（与原站一致，不过滤） |
| `trendsCompare` | **对比基准词**，默认 `"GPTs"`。所有点出去的 Google Trends 链接都会变成「该词 vs 基准词」的对比图（热搜表、游戏卡片、攻略词都是）。设为 `""` 即关闭对比、只看单词 |
| `watch` | 业务监控词，命中打 ★。做 Roblox 站就填 `roblox` / `codes` / `tier list` 等 |
| `pool.minParentVol` | 只有搜索量 ≥ 该值的热搜，其相关词才进词池（防长尾灌爆） |
| `historyDays` / `historyChunkSize` | 留档窗口与分片大小 |
| `concurrency` / `delayMs` | 并发与间隔（采集热搜用） |
| `games.geos` | **游戏雷达扫描的市场**，默认 `["US","GB","CA","AU","NZ","IE"]`（英语六国）。只做英文站就保持这样 |
| `games.latinOnly` | 默认 `true`：只收拉丁字母的游戏名（见下方「只做英文站」） |
| `games.*` 其余 | 每轮取多少条曲线（`maxCurvesPerRun`）、曲线抽样间隔（`sampleEveryHours`）、刷新间隔（`refreshHours`）、收录门槛（`minVol`）、每个游戏留多少攻略词（`relatedWords`）、请求间隔（`delayMs`） |
| `games.sources` | 候选来源开关：`{ "roblox": true, "steam": true }` |
| `games.sourceShare` | 每轮曲线配额中分给来源候选的比例，默认 `0.7`（其余留给热搜候选） |
| `games.sourceBatch` | 每轮最多从队列取多少个来源候选，默认 `120` |
| `games.steamListCount` / `games.steamUpcomingCount` | Steam「新发售 / 未发售」各抓多少个，默认 60 / 40 |
| `games.queue` | 候选队列：`{ max: 5000, ttlDays: 21 }` |
| `games.appStoreGeos` | App Store 榜单取哪些国家，默认 `["US","GB","CA","AU"]` |

### 只做英文站（默认配置）

如果你只做英文内容站，默认就已经调好了：

| 层 | 配置 | 效果 |
|---|---|---|
| **游戏雷达** | `games.geos = ["US","GB","CA","AU","NZ","IE"]` | 只在英语区榜单里找游戏 |
| | `games.latinOnly = true` | 名字含汉字/假名/韩文/阿拉伯文等的候选**直接否决** |
| **热词雷达** | `geos = [...38 国]` | **仍是全球**（想看英文热搜就自己改，见下） |

**为什么游戏雷达要单独限语言**：实测原站 findnews.me 的 **407 个游戏里 405 个是纯拉丁字母名，只有 1 个日文名** —— 它显然也不在日韩台榜单里找游戏。我们照做。

`latinOnly` 用的是**白名单**（只放行拉丁字母 / 数字 / 标点 / 符号 / 空格），而不是列举非拉丁语种 —— 列举法一定会漏（藏文、蒙文、僧伽罗文……）。`\p{Script=Latin}` 包含带变音符号的字母，所以 `New Pokémon Snap` 这类能正常通过。

**想让热词也只看英文**，把顶层 `geos` 换成英语区即可（热搜量约从 5800 条降到 1500 条）：

```json
"geos": ["US", "GB", "CA", "AU", "NZ", "IE"]
```

### 新游戏的门槛（8 道）

| 道 | 条件 | 参数 | 实测存活 |
|---|---|---|---|
| ① | 全量热搜 | 38 国 / 24h 窗口 | 5825 |
| ② | 非噪音 | `noiseLabel()` 为空 | 2253（39%）|
| ③ | 通过游戏识别 | `gameCandidate()` | 48（占非噪音的 2.1%）|
| ④ | 搜索量 ≥ `games.minVol` | **200** | 38 |
| ⑤ | **分层门槛** | `vol < 1000` 时要求 `weight ≥ 3` | **24** |
| ⑥ | 去重 + 单轮上限 | `maxCurvesPerRun: 30` | — |
| ⑦ | **LLM 终审（只否决）** | `judge.enabled` | 实测 29 → 16 |
| ⑧ | 曲线有效 | 7 天曲线 ≥2 点 且 峰值 >0 | 再淘汰约 25% |

**为什么要"分层门槛"（这一层是实测调出来的，别随手删）**

游戏雷达的目的是**尽早**发现新游戏，而新游戏刚冒头时量必然小 —— 实测 48 个候选里 32 个（67%）落在 `vol ≤ 500` 桶。所以搜索量门槛不能设高（已从 1000 降到 200）。

但低量区噪音也大：`bill skarsgård`、`don lee`、`truls möregårdh` 这类人名会被 Google 归进 Games 分类。实测发现：

| 低量候选（vol<1000） | 权重 ≥3（分类+平台词/意图词） | 权重 =2（仅分类） |
|---|---|---|
| 内容 | **几乎全是真游戏** | 真游戏与人名噪音混杂 |
| 涨幅 | +75% ~ +500% | **+300% ~ +900%（噪音涨幅反而更高）** |

所以筛低量候选要用**识别权重**而不是涨幅：`vol<1000 && weight<3` 直接否决。效果：候选 38 → 24，精度从约 50% 提到约 83%。

**代价（诚实交代）**：极少数只靠"分类"信号识别的真游戏（如 `horizon forbidden west`，vol=500 但起飞度 8.26）会被推迟到涨过 1000 桶才被抓到 —— **不是永久漏掉，只是晚几小时**。更看重"最早"就把 `strongSignal.minWeight` 改成 `2` 放开。

**排序规则**（决定谁先占用那 30 个取曲线名额）：

```
全新游戏 > 补攻略词 > 刷曲线  →  目标市场  →  识别权重  →  涨幅  →  搜索量
```

注意**搜索量排在最后**：按量排序会让配额被"量大但已不新"的词吃光，恰好漏掉最新的那批。

### LLM 终审（第 ⑦ 道门槛）

**为什么需要它**：正则能挡住体育赛事、博彩、订阅服务，但**挡不住人名** —— 实测 `games.json` 29 条里有 7 条是人名（`leslie benzies` / `diogo morgado` / `don lee` / `bruce straley` / `bill skarsgård` / `mia ristic`），占 **24%**。

关键在于人名和真游戏**词形完全同形**：

```
人名：  Leslie Benzies   Don Lee      Mia Ristic      Bruce Straley
真游戏：Poly Loot        Blox Fruits  Rat Lab         Slayers 2
```

都是 2~3 个首字母大写的词。再加正则一定会误伤右边那一列，所以只能靠语义判断。

**五条设计原则（不要随手改）**

| # | 原则 | 原因 |
|---|---|---|
| ① | 正则先粗筛，只把**已通过正则**的词送审 | 送审量从 2253 降到 30，省 98% token |
| ② | 全部词**打成一个请求** | 不是每个词一次调用；实测 30 个词 = 1 次调用 |
| ③ | 判定结果**持久化缓存** 30 天 | 同一个热词每小时都会再出现，不缓存等于每小时烧一次钱。有缓存后大部分轮次**根本不调用** |
| ④ | 任何失败都**退回正则结果** | 超时 / 未配 key / 输出不合规 / 接口 400 —— 一律不中断采集 |
| ⑤ | 模型**只有否决权，没有录用权** | 只允许它把候选踢掉，不允许它新增。防幻觉把无关词塞进雷达（实测会丢出 1 个幻觉词） |

**额外一个重要细节**：终审必须同时送审**已追踪的游戏名**，不能只送新候选。因为候选列表是在"新鲜度过滤"之后才构建的 —— 曲线还新的存量脏词根本不会出现在候选里。**实测只送新词时，13 个存量人名一个都清不掉**；一并送审后 29 → 16。

**配置**

```jsonc
// config.json
"judge": {
  "enabled": true,
  "provider": "deepseek",   // 见下表
  "model": "",              // 留空用服务商默认
  "baseUrl": "",            // 留空用服务商默认
  "apiKeyEnv": "",          // 留空则按 JUDGE_API_KEY → 服务商默认变量 顺序找
  "maxPerRun": 80,
  "cacheDays": 30,
  "cacheMax": 5000,
  "timeoutMs": 60000,
  "jsonMode": true
}
```

**GitHub Actions 上只需加一个 Secret**（`Settings → Secrets and variables → Actions`）：

```
JUDGE_API_KEY = <你的密钥>
```

再改 `config.json` 的 `judge.provider` 选择服务商。全部走 OpenAI 兼容协议，所以一套实现通吃：

| `provider` | 默认模型 | 密钥环境变量 | 免费？ |
|---|---|---|---|
| `deepseek`（默认） | `deepseek-chat` | `DEEPSEEK_API_KEY` | 付费（很便宜） |
| `gemini` | `gemini-2.5-flash` | `GEMINI_API_KEY` | ✅ 免费、**不用绑卡** |
| `groq` | `llama-3.3-70b-versatile` | `GROQ_API_KEY` | ✅ 免费、**不用绑卡** |
| `cerebras` | `llama-3.3-70b` | `CEREBRAS_API_KEY` | ✅ 免费、**不用绑卡** |
| `openrouter` | `openai/gpt-4o-mini` | `OPENROUTER_API_KEY` | ✅ 有免费模型 |
| `zhipu` | `glm-4-flash` | `ZHIPU_API_KEY` | ✅ 有免费额度 |
| `siliconflow` | `Qwen/Qwen2.5-7B-Instruct` | `SILICONFLOW_API_KEY` | ✅ 有免费额度 |
| `openai` | `gpt-4o-mini` | `OPENAI_API_KEY` | 付费 |
| `moonshot` | `moonshot-v1-8k` | `MOONSHOT_API_KEY` | 付费 |
| `ollama` | `qwen2.5:7b` | **不需要密钥** | ✅ 完全免费（仅本地） |

> 模型名会随时间变动。若报 `model not found / 404`，去服务商控制台复制当前可用模型名填到 `judge.model`。

也支持用环境变量临时覆盖，方便本地调试：`JUDGE_BASE_URL`、`JUDGE_MODEL`、`JUDGE_API_KEY`。

**不配密钥会怎样**：不会报错，会打印一行 `LLM 终审未启用（未找到 JUDGE_API_KEY），沿用规则结果`，采集照常完成。

#### 没有 API Key 怎么办（三条路）

| 路线 | 要密钥吗 | 能跑在哪 | 实测效果 |
|---|---|---|---|
| **① 零依赖人名层**（**已内置、默认开启**） | ❌ 不要 | Actions 和本地都行 | 干掉最大的一类噪音（人名）：候选 48 → 40，**零误伤** |
| **② 本地 Ollama** | ❌ 不要 | **仅本地**（Actions 跑不了） | 完整的 LLM 终审 |
| **③ 免费云服务商**（Gemini / Groq / Cerebras / OpenRouter） | ✅ 要，但**免费且不用绑卡** | Actions 和本地都行 | 完整的 LLM 终审 |

**① 零依赖人名层（`src/lib/detect.mjs` 的 `looksLikePerson()`）**

它解决的是**没有人名规则就完全无解**的那一类：人名与真游戏**词形完全同形**，正则区分不了。

```
人名：  leslie benzies   don lee      mia ristic     bill skarsgård   diogo morgado
真游戏：poly loot        blox fruits  rat lab        sword warriors   infant god
```

做法：内置 **945 个常见教名**词典（英/西/葡/法/德/意/北欧/印度/日本/阿拉伯），配合词形规则（2~3 个纯字母词 + 无数字 + 首词是常见教名）。实测：

| 指标 | 结果 |
|---|---|
| 净收益 | 候选 **48 → 40** |
| 拦下的 8 个 | 全部是真人名（`leslie benzies` / `diogo morgado` / `don lee` / `mia ristic` / `bill skarsgård` / `bruce straley` / `mark allen` / `matthew mayich update`） |
| 真作品误伤 | **0 / 27**（`gta 6` / `slayers 2` / `poly loot` / `blox fruits` / `rat lab` / `fire emblem` / `wordle hints` …全过） |
| `games.json` 清理 | 精确清掉 6 个人名，29 → 23 |

两条**刻意的保守设计**，不要改掉：

- **只在"仅靠 Google 分类"这一条证据时才启用**（`weight ≤ 2` 且无平台词）。有平台词/意图词（`weight ≥ 3`）的候选实测几乎全是真游戏，判人名会误伤。
- **词形判断不能要求"首字母大写"**。这里踩过坑：Google 热搜词**全是小写**（`leslie benzies` 而非 `Leslie Benzies`），第一版写成要求首字母大写，结果实测命中 **0 个**。现在改为只校验"是不是纯字母拉丁词"，比较教名时统一转小写。

**诚实边界**：它覆盖不了非西方人名，也不如 LLM 灵活。实测漏掉的是 `physint hideo kojima`（首词不是教名）。它只是"没有 key 时也能用"的兜底，**不是 LLM 的等价替代** —— 剩下的 `caribeña noche` / `sinuano noche` / `once hoy`（西语节目）、`pokemon cards`（实体卡）、`companion app fc 27`（配套 App）仍需要 LLM 才能可靠判掉。

**② 本地 Ollama（不要任何密钥）**

```bash
ollama pull qwen2.5:7b
# config.json 里把 judge.provider 改成 "ollama"（keyEnv 为 null，不需要任何密钥）
node src/collect.mjs --only-games
```

代价：只能在**你自己的机器**上跑 —— GitHub Actions 的免费 runner 没有 GPU，每次拉模型也不现实。

**③ 免费云服务商（推荐，最省事）**

Gemini / Groq / Cerebras 都有免费额度且**不需要信用卡**，注册后 1 分钟就能拿到 key。按 `judge.cacheDays: 30` 的缓存策略，一轮只在新词冒头时才调用，**免费额度绰绰有余**。步骤：注册 → 拿 key → 存成仓库 Secret `JUDGE_API_KEY` → 把 `config.json` 的 `judge.provider` 改成对应值。

**⚠️ 一个已经失效的路子（网上很多教程还在写）**

曾经有个「零成本在 CI 里免 key 调 LLM」的方案：GitHub Models + Actions 自动注入的 `GITHUB_TOKEN`（配合 `permissions: models: read`）。**该服务已于 2026-07-30 全面退役** —— playground、模型目录、Inference API、BYOK 全部关停。实测：

```
410 Gone  https://models.github.ai/inference/chat/completions
000       https://models.inference.ai.azure.com/chat/completions
```

代码里已把 `github-models` / `github` 两个 provider 名列入"已退役"名单，误填会直接打印退役原因和可选列表，而不是静默按别的服务商跑。

**成本**：一轮送审约 30~40 个词（1 次调用，约 2k token）。因为有 30 天缓存，**大部分轮次一个词都不送审、完全不调用**；只有新词冒头时才打一次。按主流平价模型估算，一个月成本在**几分钱到几毛钱**量级。

**关闭方式**：`judge.enabled` 设为 `false`，或干脆不加 `JUDGE_API_KEY`。

**缓存文件**：`data/.judge-cache.json`（与 `data/` 一起随 `radar-data` 分支持久化）。它以 `.` 开头，因此**不会**被工作流的 `find ... -not -name '.*'` 打包进静态站点，不会泄漏到 `dist/`。

### 用户反馈闭环（`feedback`）

启发式规则只能靠"猜词形"，而**人看一眼就知道该不该做**。反馈是**确定性信号**，优先级高于任何规则。

```jsonc
// config.json
"feedback": {
  "block": ["leslie benzies", "once hoy"],   // 永久否决：我说了不要，就别再推给我
  "boost": ["horizon forbidden west"]        // 加分：我认为值得做，排前面
}
```

生效范围（**三处都会生效**，改完 push 即可，下一轮采集自动清理存量）：

| 位置 | block 的作用 | boost 的作用 |
|---|---|---|
| 游戏雷达候选 | 直接不进雷达 | — |
| `games.json` 存量重筛 | 下一轮从列表里清掉 | — |
| 关键词池 `keywords.json` | 从词池清掉 | — |
| 打分 | — | **score +6**（能显著提前，但压不过"全新游戏"的优先级） |

两条刻意的设计：

- **精确匹配**（忽略大小写与首尾空格），**刻意不做模糊匹配**。写 `leslie` 不会误伤含 `leslie` 的真游戏 —— 模糊匹配在这种场景下弊大于利。
- **存量也要清**。只在入队时拦是不够的：已经从上一轮读进来的条目会一直留着。`pool.mjs` 和雷达重筛都做了二次过滤（踩过两次同样的坑）。

实测（隔离目录、注入 `block: ["gta v","fifa 27"]`）：

```
按当前规则清掉 7 个不再符合条件的旧条目
games.json: 23 → 16 条
block 词是否已清掉: ✅ 已清
boost 词 aion 2 是否保留: ✅   score=7（feedbackBoost 贡献 +6）
词池里的 block 词: ✅ 已清
```

### AAA 大作黑名单（`games.excludeAAA`）

> ⚠️ **2026-09-21 已开启**（用户要求清掉推荐列表里的 AAA 噪音）。

**这是「能不能做」的维度，不是「是不是新游戏」的维度。**

`gta 6` / `fifa 27` / `roblox` / `fortnite` 确实是新游戏、也确实火 —— 但对做内容站的人是**纯噪音**：官方站权重极高、攻略站多如牛毛，**你根本排不上去**。它们出现在雷达里只会浪费取曲线的配额。

```jsonc
"games": { "excludeAAA": true }
```

**它盖不住的部分用 `feedback.block` 补**（正则只认"系列名"，`fc 27` 这种缩写、以及压根不是游戏的热搜词都得手动列）。
实测把下面这批加进 `feedback.block` 后，"缺官方数据"的条目从 **25 → 5**：

```jsonc
"feedback": { "block": [
  "fc 27", "madden 27", "companion app fc 27", "sony playstation",   // 年度体育 AAA / 厂商词
  "wordle hints",                                                     // 工具词
  "30th anniversary pokemon cards", "target 30th anniversary pokemon",
  "pokémon 30 jahre top trainer box",                                 // 实体卡
  "caribeña noche", "once hoy", "sinuano noche",                      // 西语电视剧
  "physint hideo kojima"                                              // 人名型查询
] }
```

`feedback.block` 是**确定性信号**，优先级高于任何启发式规则，且**存量也会被清掉**（下一轮采集自动重筛）。

**故意没动的 5 条**（属于"有可能值得做、但也是大 IP"的灰区，留给人判断）：
`wow forever beta` / `how to install wow forever beta` / `wow forever beta installieren` /
`horizon forbidden west` / `fire emblem` —— README 早先的回归测试把它们当作"自建 IP 续作不误伤"的样本。
要一起清，把名字加进 `feedback.block` 即可。

实测开关前后（同一份 38 国样本）：

```
候选：关 AAA 35 个 → 开 AAA 25 个（砍掉 10 个）
AAA 砍掉的词：grand theft auto vi, brawl stars, fifa 27, ea sports fc 27,
              grand theft auto online, roblox, fortnite, gta 6, gta, gta5
```

**为什么默认关**：也有人想用它看大盘热度。**回归测试确认自建 IP 续作不误伤**（`aion 2` / `fire emblem` / `wow forever beta` 全部保留）—— 名字是**锚定匹配**（`^...$`），不会把 `roblox something` 这类真游戏名一起砍掉。

名单是"起步集"，覆盖不到的（如 `fc 27` 这种缩写）用 `feedback.block` 补 —— 这正是反馈闭环存在的意义。

### 定时运行

Windows（任务计划程序，每小时）：

```powershell
schtasks /create /tn "KeywordRadar" /sc hourly /mo 1 ^
  /tr "node d:\Source\Skills\findnews\src\collect.mjs" /st 00:05
```

Linux / macOS（crontab）：

```cron
5 * * * * cd /path/to/findnews && /usr/bin/node src/collect.mjs >> logs/collect.log 2>&1
```

### 部署到 GitHub 自动运行（已内置）

`.github/workflows/radar.yml` 已写好，推上 GitHub 即可。**触发规则分三种，别搞混**：

| 事件 | 会采集吗 | 会发布吗 | 说明 |
|---|---|---|---|
| **每小时 `:23`**（schedule） | ✅ 全部国家 | ✅ | 主力路径，全自动 |
| **手动 `Run workflow`** | ✅ 按 `geos` 输入框 | ✅ | **留空 = 全部国家**；填了 `US,GB,JP` 就只跑这三个 |
| **`push` 到 `main`**（改动 `web/**`、`src/**`、`config.json` 等） | ✅ | ✅ | 改完代码立刻看到效果，数据也一起刷新 |

「采集」这一步是 **`continue-on-error` 的尽力而为**：万一 Google 限流导致采集失败，工作流会打警告，然后用**已有留档继续把界面发布出去** —— 不会因为你改了前端却卡在采集上。

> 全量跑完后 `trends.json` 会被 38 国覆盖，之前那几个国家的数据不会丢 —— 它们已经进了 7 天留档 `history.json`。
>
> 只改 `README.md` 这类文件不会触发工作流（有 `paths` 过滤）。
>
> `config.json` 会跟产物一起发布到 `dist/data/config.json`，所以改 `trendsCompare` 这类**只影响界面**的配置，push 后立刻生效，不必等下一轮采集。

> **前置条件**：仓库必须是 **public**。GitHub Free 的 Pages **不支持私有仓库**（需要 Pro/Team）。
> 不想公开源码的话只有两条路：改用 Cloudflare（见下一节），或者做成「私有源码仓 + 公开产物仓」双仓方案。

**一次性配置（3 步）**

1. 建仓并推送：

   ```bash
   git init && git add -A && git commit -m "init"
   git branch -M main
   git remote add origin https://github.com/<你>/<仓库>.git
   git push -u origin main
   ```

2. **Settings → Actions → General → Workflow permissions** 选 **Read and write permissions**（否则回写 `radar-data` 会失败）。

3. **Settings → Pages → Source** 选 **GitHub Actions**。

然后到 **Actions → Keyword Radar → Run workflow** 手动跑一次验证。成功后看板地址是
`https://<你>.github.io/<仓库>/`，之后每小时自动更新。

#### 想用 Cloudflare Pages？用「直传」，**不要连 Git**

**先说结论：别把 Cloudflare Pages 连到 GitHub 仓库（Connect to Git）。** 三个硬问题：

1. **Cloudflare Pages 免费版每月只有 500 次构建**，而每小时一次 = 720 次/月，**必然超限**。
2. Git 集成只在 `push` 时构建，而数据是 Actions 每小时产出的 —— 你得把 `data/` 提交进仓库才能触发重建，仓库会迅速膨胀。
3. 如果在 Cloudflare 的构建机里跑 `collect`，那是从 Cloudflare 的 IP 打 Google，被限流的概率更高。

**正确做法：Cloudflare Pages 只当静态托管，采集和上传都由 GitHub Actions 干**（`wrangler pages deploy` 直传不触发 Cloudflare 构建，也不占那 500 次额度）。工作流里已留好开关。

一次性配置：

1. Cloudflare Dashboard → **Workers & Pages → Create → Pages → Upload assets**，建个项目，例如 `keyword-radar`。
2. 项目 → **Settings → Builds & deployments → Production branch** 设为 `main`（否则上传会落到 Preview 而不是 Production）。
3. My Profile → **API Tokens → Create Token**，权限给 **Account → Cloudflare Pages → Edit**。
4. 在 **Workers & Pages 右侧栏**复制 **Account ID**。
5. GitHub 仓库 → **Settings → Secrets and variables → Actions**：
   - **Secrets**：`CLOUDFLARE_API_TOKEN`、`CLOUDFLARE_ACCOUNT_ID`
   - **Variables**：`DEPLOY_TARGET` = `cloudflare-pages`、`CF_PAGES_PROJECT` = `keyword-radar`
     （可选 `CF_PAGES_BRANCH`，默认 `main`）

之后每小时的产物直接覆盖上传，看板地址 `https://<项目名>.pages.dev`。
`DEPLOY_TARGET` 可选值：`github-pages`（默认）、`cloudflare-pages`、`none`（只采集不发布）。

#### 更 Cloudflare-native 的路（了解即可）

用 **Workers + Cron Triggers** 把采集也搬到 Cloudflare，完全不需要 GitHub。但**免费版 Workers 每次请求只有 50 个子请求上限**，而一轮需要 38 次热搜 + 约 40 次曲线 ≈ 78 次，得拆成多次触发才跑得完。除非有付费版，否则不划算。

**设计要点**

| 项 | 做法 | 原因 |
|---|---|---|
| 7 天留档怎么跨运行保存 | 存到专用分支 `radar-data`，每次 `git archive` 还原、单次提交 `--force` 覆盖 | 留档是 3 MB 级、每小时变一次；直接提交到 `main` 一年能让仓库膨胀到 GB 级。专用分支单提交 → **仓库体积恒定** |
| 为什么用 `git archive` 而不是 `checkout` | `git archive origin/radar-data data \| tar -x` | 不走 index，完全不受 `.gitignore` 影响（`data/` 已 gitignore） |
| 先存状态还是先发 Pages | **先存状态** | 万一 Pages 没配好，采集数据也不会丢 |
| 部署方式 | 官方 `upload-pages-artifact` + `deploy-pages` | 不产生 `gh-pages` 提交，也不需要额外 token |

#### 关于「更新延迟」：先分清两件事

这个项目**没有 build 步骤**（不需要 `npm install`、不需要编译），Pages 也不是「push 才构建」——我们是把静态产物直接上传。所以**不存在构建排队**。延迟只有一个来源：**Actions 的 `schedule` 调度排队**。

而且这个延迟**对你的使用基本无害**，因为采集本身就是这么设计的：

- 每轮拉的是**完整 24 小时窗口**，不是增量。某轮延迟 20 分钟、甚至整轮被丢弃，**下一轮照样拿到完整数据，不会漏词**。
- `(词, 地区)` 去重 + 峰值合并 → 多跑不产生重复数据，7 天留档也不会断。
- 数据本身就是小时级粒度（Google 实时榜单窗口就是 24h），晚 20 分钟看到的是同一批词。

**唯一实际代价**：看板顶部「更新于 X 分钟前」这个数字会大一点。它已经能让你一眼判断数据新旧。

#### 想让更新更勤：三个选项（按性价比排序）

| 方案 | 效果 | 代价 |
|---|---|---|
| **① cron 避开整点**（已采用） | 明显减少排队延迟 | 无。GitHub 官方说「每小时整点」是高负载时段，所以用 `:23` |
| **② 改成每 30 分钟**：`cron: "23,53 * * * *"` | 最长陈旧时间从 60 分钟降到 30 分钟 | public 仓库 Actions 免费；热搜请求量翻倍，限流风险略升。**不会**多消耗曲线配额（有 `refreshHours` 节流） |
| **③ 外部定时器触发** | 分钟级准时，完全绕开 GitHub 排队 | 最重：需一个 fine-grained PAT（仅 `Actions: write`）存到 cron-job.org / UptimeRobot 之类服务，通过 `workflow_dispatch` API 触发。多一个第三方依赖和一把钥匙 |

**建议：用 ①。** 数据是小时粒度的，与其追求准点，不如把精力花在「加更多国家」或「扩充 `watch` 监控词」上。真要更勤就直接用 ②，一行改动。

#### 四个必须知道的坑

1. **cron 用 UTC，且 `schedule` 是尽力而为**：高负载时可能延迟 5–30 分钟，极端情况下会**静默丢弃**某次运行。这正是「全量 24h 窗口」设计存在的原因 —— 丢一次不影响数据完整性。
2. **仓库 60 天无活动，定时任务会被 GitHub 自动禁用**。本工作流每小时都往 `radar-data` 提交，仓库一直在动，正常不会触发；保险起见偶尔往 `main` 提交一次，或去 Actions 页面重新启用。
3. **Actions 跑在云机房 IP 上，Google 可能更严格地限流**（本地无法验证）。工作流已内置重试与「抓 0 条就中止、不用空数据覆盖留档」的保护；若云上长期失败，改用**自建 VPS / 家里的机器 / Cloudflare Worker 定时触发**更稳。
4. **Pages 的 CDN 默认缓存 10 分钟**（`Cache-Control: max-age=600`）。前端请求已带 `no-store`，所以浏览器不缓存，但 CDN 边缘最多可能返回 10 分钟前的 JSON。对小时级更新无影响，别误判成「没更新」。

> 顺带一提：Actions 页面天然记录了每轮采集日志和产出变化，排查比本地 cron 方便得多。

### 来源层：六个来源，各管一段（2026-09-24 扩源）

上面那 8 道门槛管的是**热搜候选**这条腿；另一条腿是**来源目录**（直接从榜单捞作品本体）。
2026-09-24 把来源从 3 个扩到 6 个，重点补上**手机端**与**网页小游戏**：

| 来源 | 拿到什么 | 实测规模（单轮） | 抓取成本 |
|---|---|---|---|
| `roblox` | Discover 各榜单 | 218 个 | 1 次请求 |
| `steam` | 新发售 / 即将发售 / 特惠 / 热销 + 搜索页 | 160 个 | 3 次请求 |
| **`appstore`（iOS）** | 5 个榜 × 23 个地区：最新上架 + 免费/付费/收入榜 | 123~543 个 | 每轮 12 组（受预算控制） |
| **`googleplay`（Android）** | 14 个分类热门榜 × 8 个国家（含 6 个冷门子类：文字/棋牌桌游/卡牌/问答/音乐/教育） | 216~442 个 | 每轮 4 组，单页 1.7~2.6MB |
| **`itch`** | 最新上架的独立小游戏（**带 `createDate` 上架日**） | 108 个（3 页 × 36） | 3 次请求（XML feed，~27KB/页） |
| **`poki`** | 免费在线小游戏的新作 + 本周热门 | 152 个 | 1 次请求（~440KB） |
| **`crazygames`（2026-09-24 新增）** | 每天上新的免费在线游戏 | **70 个** | 1 次请求（~400KB） |

单轮实测：**来源候选 1023 个 → 入队新增 174 个**（按名字去重后），队列 1620 条。

#### 手机端的能力**不对称**，实现里如实处理（别指望对称）

| | iOS | Android |
|---|---|---|
| **新游入口** | ✅ `newfreeapplications` / `newpaidapplications`（最新上架；每 100 条里约 10 条是游戏，US/JP/KR 实测 10/9/16 条） | ❌ **没有**。所有 `collection/*` 入口实测返回 200 但页面里 0 个 app → 只有**分类热门榜**可抓 |
| **首发日** | ✅ `itunes.apple.com/lookup?id=a,b,c…` **支持批量**（50 个/批），给 `releaseDate`（预购游戏是未来日期 → 直接就是"未发售"信号） | ❌ 详情页实测**没有** `datePublished` / "Released on"，只有 "Updated on" → 首发日只能标「未测」，**绝不拿更新日冒充** |
| **需求代理** | 评分人数 `userRatingCount` | 评分人数 `ratingCount`（JSON-LD） |
| **口碑** | 星级 `averageUserRating` | 星级 `aggregateRating` |
| **装机量** | ❌ 不公开 | ❌ 页面未暴露 |

所以「🎯 建站推荐」里手游的**需求规模用评分人数**（第三套锚点，与 Roblox 的终身访问量、Steam 的当前在线都不通用），
**口碑用星级**（≥4.5★→100 · 3.5★→50 · ≤2.5★→0）；`ratings = 0` 是"刚上架还没人评"→ 记「未测」而不是 0 分
（否则每个新手游都会被当成"口碑 0 分"永远推不出来）。

#### 请求预算：轮转 + 缓存（`budget()`）

来源多了以后，**全量抓一遍的成本是不现实的**：App Store 全量 = 23 地区 × 5 榜 ≈ 34MB；Google Play 全量 ≈ 180MB。
所以按"组合清单 + 游标轮转 + 结果缓存"来做：

- 每轮只抓 `appStoreMaxPerRun`（12）/ `playMaxPerRun`（4）组，抓完进 `data/.source-budget.json`；
- **返回的是缓存里所有未过期条目的并集** → 覆盖面随轮次逐步铺满，而单轮成本恒定；
- 🛑 **缓存 TTL 必须 ≥ 走完一整圈的时间**，否则永远铺不满（所以 `appStoreCacheHours: 72` / `playCacheHours: 120`，
  而 games 是 6 小时一轮 → 一圈约 2.4 天 / 4 天）。改 `*MaxPerRun` 时这两个数要一起改。
- 清单顺序 = 信息量顺序：Apple 先"最新上架"、Play 先"全部游戏 × 所有国家"，游标从 0 起，所以每圈最先拿到的就是它们。
- 缓存里存的是**拼好的条目**，所以改了字段要 `BUDGET_VERSION + 1`（实测踩过：修好链接解析后旧缓存仍是空 url）。

#### 队列公平抽样（`queue.fairShare`，默认开）—— 这次扩源暴露的真问题

扩源后单轮入队从 ~377 涨到 ~1023，而每轮能验证的名额只有 `maxCurvesPerRun × sourceShare`（默认约 17 个）。
原来的 `peekQueue` 是"按优先级排序取前 n"，结果实测**一轮 7 个名额全是 Roblox**（它 218 条且优先级最高）——
手游与网页小游戏**永远排不到**，21 天后直接过期，等于新增的来源白加。

现在改成**按来源轮流各取一条**：六个来源每轮都能轮到，`games.json` 的来源构成实测变成
`roblox 73 · steam 3 · googleplay 1 · itch 1 · poki 1 · appstore 1`（旧行为可用 `queue.fairShare: false` 退回）。

#### 各来源的抓法（不是 sitemap，是"平台的自家新游页"）

| 来源 | 抓的是什么 | 备注 |
|---|---|---|
| itch.io | `itch.io/games/newest**.xml**`（RSS，`?page=2/3` 翻页） | 🆕 2026-09-24 从 HTML 换成 XML：字段更全（`plainTitle` 干净名字 / **`createDate` 上架日** / `<platforms><html>yes` 是否可浏览器直玩），而且不会像 HTML 那样因类名/属性顺序变化整页解析成 0 条（实测踩过两次）。HTML 解析保留为兜底 |
| Poki | `poki.com/en/new` 的磁贴 | 分组名实测：`popularWeekGames`（热门）/ `basic-game`（**新游网格，141 个**）。没有 API、没有 sitemap（`/sitemap.xml` 也是 404） |
| CrazyGames | `crazygames.com/new` | 锚点带 `aria-label="游戏名"` + 绝对地址 `/game/<slug>`，一页 70 个。没有 sitemap（`/sitemap.xml`、`/sitemap-games.xml` 都 404）|
| iOS | `itunes.apple.com/<cc>/rss/<榜单>/genre=6014` | 见下「手机端能力不对称」 |

**都不是 sitemap**：这些平台的 sitemap 要么 404，要么只给全量（几万个）不给"新"。它们的**自家"new"页**才是权威的"新"口径。
抓到名字之后统一入队 → 由 Google Trends 曲线验证需求（**新游免门槛**，见「无曲线也要收录的例外」）—— 所以"找到"和"验证"是两步，不混着做。

#### 🛑 为什么 Roblox 断崖式领先？（2026-09-24 实测归因，不是因为它更好）

`data/games.json` 实测 91 条里 Roblox 占 74 条。拆开看，原因有**三个**，其中两个与"游戏质量"无关：

| 原因 | 实测证据 |
|---|---|
| ① **存量抢跑**（主因） | 入库日期分布：`09-20 → roblox 15 + steam 3`、`09-21 → roblox 50`、`09-24 → roblox 9 + 其它来源合计 6`。也就是说 **65/74 是 9-20、9-21 两天攒下来的**，那时其它来源还没接进来；新来源是 **9-24 才第一次跑**，一天只分到几个验证名额 |
| ② **过门槛率最高** | Roblox 74/74 全部拿到官方数据，其中 **70/74 有 Trends 曲线（95%）** —— 而 itch/poki 完全没有官方接口、Android 拿不到首发日，它们的条目大量以「竞争未测」状态存在 |
| ③ **单请求产出比最高** | 1 次请求产出 217 个候选（所有 Discover 榜单合并），是所有来源里最高的 |

**队列积压也印证了这一点**（`.queue.json` 实测）：`appstore 743 · googleplay 439 · steam 282 · roblox 231 · poki 149 · itch 38`，合计 1882 条，
而每轮验证名额只有 `maxCurvesPerRun × sourceShare ≈ 17` 个（公平抽样后每个来源 ~3 个）。
所以**新来源的存量差距要几周才追平**，而 Roblox 每轮还在持续产出新候选。
> 这也解释了为什么必须做「平台筛选」：不筛的话，任何按时间排序的列表都会被存量大的来源刷屏。

#### 看板上的平台筛选（两页共用）

「🎮 新游戏雷达」与「🎯 建站推荐」顶部都有平台按钮，**按钮上直接写着各来源的条数**
（实测：全部 89 · Roblox 74 · Steam 3 · iOS 2 · Poki 2 · Android 1 · itch 1 · 热搜/其他 6）。
两页共用同一个筛选条件（它们本来就是同一批 `data/games.json` 的两种视图），某平台 0 条时按钮置灰。

为什么必须做：Roblox 的候选量比其它平台高一个数量级，不筛就是**Roblox 刷屏**，其余来源等于看不见。

> ⚠️ 一个**平台限制的可见后果**：Android / itch / Poki 的条目**没有官方上线日**
> （Play 不提供、itch/Poki 无接口）→ 按理「竞争」项无从推断 → 在推荐页全变成「竞争未测」、总分给不出（**看得见、判不了**）。
> **2026-09-24 补了一条出口**：自动 SERP 核查（`src/lib/serp.mjs`，数「<游戏名> codes」前十的独立域名数）
> + 卡片上可复制的 `games.competition` 片段（人工补一行立刻出分）。**iOS 有 `releaseDate`，本来就能正常算竞争与新鲜度** ——
> 这是平台能力差异，不是 bug。

#### 🗓 失效机制（保留期总表，2026-09-24 逐项核对代码）

**旧数据会自动消失，不需要人工清理** —— 但每一份产物的判据不同，别混：

| 产物 | 保留期 | 按什么算 | 代码位置 |
|---|---|---|---|
| 实时热词 `trends.json` | **24 小时窗口** | 每轮**整份重写**（只含当前窗口），所以 3 天前的热搜根本不在里面 | `collect.mjs` → `writeTrends` |
| 7 天留档 `history*.json` | **7 天**（`historyDays`） | 按 **`last`（最后一次出现）** —— 持续出现的词一直保留，**连续 7 天不再出现才清掉**；分片写回时多余分片会被删除 | `store.mjs` → `mergeHistory` / `writeHistory` |
| 关键词池 `keywords.json` | **7 天**（同 `historyDays`）+ `pool.maxItems 20000` | 同样按 `last`；另外 `feedback.block` 的词**每轮强制清掉**（存量也清） | `pool.mjs` |
| 游戏雷达 `games.json` | **30 天** + `maxItems 3000`（体积护栏） | 按 **`first`（首次发现）** —— 30 天前的发现会退出；若它还在榜上，下一轮会被当新候选重新收进来（`first` 刷新）→ 是**滚动窗口**，不是永久档案 | `collect.mjs` |
| 候选队列 `.queue.json` | **21 天 TTL**（`queue.ttlDays`）+ 上限 5000 | 按 `addedAt` | `queue.mjs` |
| 潜伏列表 `watchlist.json` | **每轮重建** | 不留历史（它本来只是"当前该盯谁"的快照） | `watchlist.mjs` |
| 各类缓存（点文件，不上站） | Steam 详情 7 天 · Steam 统计 6h · iOS 详情 24h · Android 详情 7 天 · 榜单轮转 48~120h | 各自 TTL | 各 lib |

> 两个容易看错的地方：① **热词/词池是按"最后一次出现"过期，不是按"发现时间"** —— 这才是对的：
> 一个词只要还在被人搜就会一直留着；② **游戏雷达是按"首次发现"过期** —— 这是刻意的：
> 雷达的用途是"最近 30 天发现了什么新游戏"，不是"全站游戏档案"；老游戏会被 30 天窗口自然滚出去。

#### ⚖️ 自适应曲线预算（清空队列后自动降速）

`maxCurvesPerRun` 是**上限**（只在有积压时用），`minCurvesPerRun` 是**空闲档**：

```
本轮预算 = clamp(空闲档 24 + 积压 / 3, 24, 120)
  积压 ≥ 300  → 顶到 120（冲刺排空）
  积压 60     → 44
  积压 0      → 24  ← 自动回到轻量节奏（≈ 原来的每轮 24）
```

为什么需要：排空队列时要把预算开到 120，但清空之后队列里没东西可验，静态的 120 会**每轮空烧配额**
（转去反复刷已知游戏的曲线）。实测日志会打印 `曲线预算：积压 1973 → 本轮 120`，清空后自动变 24。
⚠️ 注意：**采集频率从未变过，一直是每小时一轮**（cron `23 * * * *`）—— 变的只是"每轮干多少活"。

#### 🚰 队列清空与「完整数据」：一次标定改变了结论（2026-09-24）

**先标定，再优化**。用真实队列里的名字（各来源混合、间隔 3s）连打 24 个曲线请求：

```
有曲线 4 个  ·  无曲线数据 20 个（83%）  ·  429 只碰到 1 次瞬时（重试即成功）
```

**这推翻了"配额不够"的直觉**：队列排得慢**不是 Trends 限流**，而是**83% 的候选根本没有可验证的热度数据** ——
它们每轮被白跑一遍、出队、然后永远进不了站。所以以前无论跑多勤，你看到的都不是"完整数据"。

据此做了三处修正（都在 `config.json`）：

| 修正 | 参数 | 依据 |
|---|---|---|
| ① **曲线预算放大 5 倍** | `maxCurvesPerRun 24 → 120`、`delayMs 3500 → 2500`、`rateLimitStop 2 → 3`、`sourceBatch 120 → 400` | 标定显示 429 几乎不是问题（24 次里 1 次瞬时）；预算该给到接口允许的量级 |
| ② **目录直收通道**（新） | `games.catalogDirect: { enabled, maxPerRun: 60, perSourceCap: 25, minPrio: 2 }` | 来源型目录条目**不要求曲线**即可入库，理由如实标注 `目录直收（… · 无 Trends 曲线）`；有界（每轮 60、单来源 25、只收 prio≥2，避免榜单常客灌满） |
| ③ **削减低价值 inflow** | `playTopN 40 → 20`、`appStoreTopN 30 → 20` | prio=1 的热度榜（饱和游戏）本来就要曲线把关，收多了只堵队列 |

**实测一轮（`--max-curves 60`）**：

```
来源候选 1589 → 入队新增 46
目录直收 60 条直接入库并出队（roblox 10 · steam 10 · appstore 10 · itch 10 · poki 10 · crazygames 10）
游戏雷达：取曲线 42 个
队列：剩余 1983 · 本轮清 102（直收 60 + 曲线 42）· 新增 46 → 约 36 轮
games.json：100 → 193 条（非 Roblox 从 25 → 104）
```

**ETA 算法就写在日志里**（`队列：剩余 X · 本轮清 Y · 本轮新增 Z → 约 N 轮`），关键是**必须减掉 inflow**：
`net = 清出 - 新增`，再用 `剩余 / net` 得轮数（采集每小时一轮 → 轮数≈小时数）。若 `net ≤ 0` 就如实报"净增，不会清空"，
**不报假乐观数字**。按配置默认（`maxCurvesPerRun 120` → 清 144/轮）：`1983 / (144-46) ≈ 21 轮 ≈ 21 小时`。

想一次性更快排空：`node src/collect.mjs --only-games --max-curves 500`（单轮约 20 分钟，清 ~410 条）。

**体积护栏**（`games.maxItems`，默认 3000）：看板要整份加载 `games.json`，不设上限一个月能涨到几万条 → 页面加载不动。
超出时优先保留**有曲线的**条目，再按首次发现时间新旧淘汰，并如实计数。

> 平台版本差异：`ageDaysOf()` 现在优先用官方上线日（`stats.created`），没有官方数据的来源退回 `srcCreated`
> （itch 的 `createDate`）—— 两者都是"作品真正的上架时间"，**绝不用 `g.first`**（那只是我们数据库里的时间）。

#### 无曲线也要收录的例外（`promoted`）

第 ⑧ 道门槛是"曲线有效"，但**新上架的手游/小游戏在 Trends 上本来就没有曲线**。
所以这三类即使取不到曲线也照样收录（并标 `新游目录收录（Trends 暂无曲线）`）：
iOS 的 `new-*` 榜、itch 的 `new`、Poki 的 `new`。
每轮条数由来源配额天然封顶，不会把列表灌爆。

#### 已知边界（诚实交代）

- **只留拉丁名**（`games.sourceLatinOnly`，默认开）：JP/KR/TW 榜单里大量非拉丁名对英文站没有可用关键词，
  而队列是共享的稀缺资源 → 实测单轮过滤掉 22~34 个。要做小语种站时设 `false`。
- itch 的游戏绝大多数**没有搜索量**（候选不是结论，由下游趋势验证筛）；Poki 的"热门"行里是 Subway Surfers 这类饱和游戏。
- Google Play 抓的是**热门榜**（`playTopN: 40` 只取前 40）——它回答"现在流行什么手游"，**不回答"什么是新游"**。
  2026-09-24 实测新增 6 个**冷门子类**（文字/棋牌桌游/卡牌/问答/音乐/教育，单页各 40 条、解析全部正常）——
  因为"小游戏"主要藏在这类榜的**榜尾**，大类的头部全是重度大作。
  **但 Play 依然没有"新游"入口**：想发现"新的安卓小游戏"，目前**没有可抓的公开来源**
  （实测 10 个候选：Play 新品合集 0 个 app、Uptodown 410、APKCombo 404、APKPure/APKMirror/AppBrain 403、QooApp 202 空响应、TapTap 是 SPA 空壳）。
- itch / Poki 是偶发失败源（同一 URL 连抓三次都成功，但流水线里偶尔空）：已加**一次重试**，
  并把"解析出 0 条"当**显式失败**报出来（0 条与"这一轮没有新游戏"是两件事，不能混）。
- 解析脆点（已修，别写回去）：itch 卡片有**两种属性顺序**、Poki 的分组名是 `basic-game` 而不是带 "new" 的词、
  Play 在 JP/TW/KR 走 `aria-label="Play 游戏名"` 且同页混有 `aria-label="Rated 4.4 stars…"` 的评分串。

### 🎯 建站推荐（看板标签页 · 自动评分）

**为什么需要单独一页**：游戏雷达回答「哪个游戏在火」，但**「在火」和「我能做」经常是反的** ——
访问量越大意味着攻略站越多、域名权重越高，新站越排不上去。

实测案例（Royale High）：访问 **1045 亿**、好评 85.9%、2 天前还在更新 ——
从"游戏好不好"看是满分，从"能不能挤进去"看是零分（需求同比 **-38%**、
7 家专业站在事件后 **8 小时内**发稿、长尾被社区垄断）。
**用衡量"游戏成功"的指标去评"我能不能做"，永远得到高分。**

#### 数据从哪来：Roblox 官方接口（零密钥）

`src/lib/roblox.mjs` 用 `games.json` 里已存的 `srcUrl`（游戏页链接）反查官方数据：

```
srcUrl 的 placeId → apis.roblox.com/universes/v1/places/{id}/universe
                  → games.roblox.com/v1/games?universeIds={id}      访问量 / 收藏 / 上线 / 更新
                  → games.roblox.com/v1/games/votes?universeIds={id} 好评率
```

三条设计约束（不要随手改）：

| 约束 | 原因 |
|---|---|
| **批量刷新**（`statsRefreshHours: 1`，`statsDelayMs: 250`） | 🛑 **2026-09-21 改**：旧版逐个游戏请求（每个 3 次 + sleep 900ms），刷 40 个 = 120+ 次请求 + 36s，所以只能定 7 天 TTL。但 `games.roblox.com/v1/games?universeIds=a,b,c…` **一次支持 50 个** → 55 个游戏只要 **4 次请求**（稳态 **2 次**）→ 没有理由再限制成 7 天，现在**每小时刷新** |
| **place→universe 永久缓存**（`data/.roblox-universe-map.json`） | 这是把 TTL 压到 1 小时的前提：映射关系不会变，只有"没查过"才请求一次 |
| **失败保留旧值** | 网络抖动时沿用上次的 stats，绝不写 0 或 null 覆盖真数据 |
| **只补有 Roblox 页的** | Steam / App Store 来源没有 Roblox 页，跳过（不编数据） |

> ⚠️ 唯一有真实封禁风险的接口是 **Google Trends 曲线**（`widgetdata/multiline`），所以那一层保留
> `refreshHours: 6` 节流；Roblox / Steam 官方接口都是**小时级**刷新。实测稳态：Roblox 数据每轮 **2 次请求 / 1.8 秒**。

#### 六项评分

> 🛑 **2026-09-21 用户修正（重要）**：旧版把访问量做成「中间高、两端低」的**竞争余量**，
> 等于**用访问量反推竞争** —— 方向反了。正确的因果是：
> **「流量大」本身不是负面因素**；负面因素是「**竞争高**」和「**上线时间长**」。
> 访问量 = 需求（有人搜）→ **正向**计分；竞争要独立测；上线时长单独扣分。

| 项 | 权重 | 怎么算 | 说明 |
|---|---|---|---|
| **需求规模** | 22 | log 归一、**单调递增**，锚点按平台分开：Roblox 终身访问量（1e5→0 · 1e8→100）／Steam 当前在线（1→0 · 5000→100，为 0 时退回评价数） | 越大越好，只代表"有多少人在找" |
| **内容面** | 20 | 已挖到的攻略词数量 ≈ 可直接做的页面数 | |
| **新鲜度（上线时长）** | 16 | ≤1 月 100 · 1 年 40 · 5 年 10 · 10 年 0 | **"上线时间长"的兑现**，只认官方上线日 |
| **竞争（分高 = 竞争低）** | 16 | 人工 SERP 核查 > **自动 SERP 核查**（「<游戏名> codes」前十的独立域名数）> 上线时长推断；皆无 → **未测** | 🛑 不用访问量推断 |
| **需求动能** | 14 | 7 天曲线后半段 vs 前半段 | |
| **口碑** | 12 | 50% 好评 → 0 分；95% → 100 分 | |

**人工竞争判断**（`games.competition`）里的 `lagHours` 作为**全局乘数**（≤12h ×0.6；≥72h ×1.1）；
`open` 已经进了竞争项，**不再重复乘一次**。

#### 竞争的自动 SERP 核查（2026-09-24 新增 · 逐条实测）

为什么加：安卓条目**永远拿不到上线日**（实测 Play 详情页无 `datePublished` / "Released on"，只有 "Updated on"），
而竞争项一旦测不到，按下面的护栏**总分就是 `null`** —— 安卓在推荐页"看得见、判不了"，等于整条来源没有出口。

| 通道 | 实测结果 |
|---|---|
| **DuckDuckGo HTML**（`provider: "ddg"`，零密钥，默认） | 首次 200（40 条结果链接）；**同一 IP 连打时第 3 次起返回 202 反爬页** → 只适合"每轮少量 + 长间隔" |
| **Brave Search API**（`provider: "brave"` + `BRAVE_API_KEY`） | **推荐**：免费额度 2,000 次/月、稳定、返回 JSON。没配 key 时按失败处理（**不写缓存**） |
| Bing / Mojeek / searx 公共实例 / Brave 网页版 | 0 结果、403 或 429 —— 全部不可用（Bing 的结果链接是 base64 跳转，解出来也不是结果页） |
| APKPure / APKMirror / AppBrain（原打算拿安卓上线日） | Node fetch 与 curl **一律 403**；Uptodown 页面已 410；QooApp 202 空响应 |

判据与护栏（都写进了规则块，随产物下发）：

- 只数**独立域名**（同一站点的子域算一个），并排掉应用商店 / 视频社交 / 通用百科 —— 对齐人工核查的口径「前十有几个独立域名占位」。
  档位：**0 个=100 · 1~2 个=75 · 3~4 个=50 · 5~7 个=25 · ≥8 个=10**（与人工 `open 1~5` **共用同一张分数表**，两套口径才可比）。
- **限流 ≠ 没有竞争**：测失败**不写缓存**，条目保持「未测」（与 Roblox 429 禁令同源）；缓存里只放**测成功**的结果且带时间戳，
  前端另有一道 30 天陈旧保护（宁可标未测，也不拿一个月前的域名数当现状）。
- 只测**拿不到官方上线日**的条目（`onlyUnknownAge`，默认开），每轮 `maxPerRun` 封顶（默认 4）—— 不打扰已有人工/时长推断的平台。
- 人工核查（`games.competition`）**优先级仍高于自动**：人一眼能看出"长尾垄断"和"自动化数据站"，机器只会数域名。

人工补判断的路径（最可靠，零外部依赖）：推荐页顶部 **「🔍 竞争待核查」** → 按需求降序 → 点「查竞争（SERP）」
（**与自动通道同一个查询词**，另给一个更宽的「查长尾」）→ 把卡片上那行 `"<游戏名>": {"open": 3},` 粘进
`config.json` 的 `games.competition` → 下一轮就出分。

> 顺带修掉一个死 UI：`#pick-bar` 的三个筛选按钮（全部 / 值得做 / 缺攻略词）**此前没有绑定任何事件**（点了没反应），
> 现已接上，并新增「🔍 竞争待核查」。

#### 硬否决（只剩两条自动 + 一条人工）

| 条件 | 结论 |
|---|---|
| 好评 < 60% | ❌ 游戏本身在流失玩家 |
| 已配人工判断且长尾开放度 ≤ 2 | ❌ 竞争饱和 |
| **没有官方上线日、也没人工/自动 SERP 核查结果** | ⚠️ **竞争未测（不给分）** —— 用顶部「🔍 竞争待核查」集中看，卡片上可直接复制 `games.competition` 片段补齐 |

> ⚠️ **删掉的一条（别加回来）**：旧版有「访问 ≥ 10 亿 → 巨头级 ❌」的自动否决。
> 它和"流量大不是负面因素"直接冲突。现在这类游戏由**新鲜度 + 竞争（上线时长推断）**自然降档，
> 并且卡片上给了「查竞争（SERP）」按钮 —— 让**实测的竞争**去否决，而不是让流量本身去否决。

> 🛑 **另一个必须记住的坑**：「上线时长」**只能取官方上线日（`stats.created`）**，
> 绝不能退化成"首次发现时间"。实测踩过：拿首次发现时间当 ageDays 后，
> `sony playstation` 这种压根没有官方数据的词因为"1 天前才发现"被算成上线 1 天 →
> 竞争项直接满分 → **排到推荐榜第一**，而它连访问量都没有。

#### 人工竞争判断写法

```jsonc
"games": {
  "competition": {
    "slayers 2": { "open": 1, "lagHours": 8, "note": "3 个专用 wiki + progameguides 专属 hub" }
  }
}
```

- `open`（1~5）：长尾开放度，直接决定竞争项得分：1 → 10 分 / 3 → 50 分 / 5 → 100 分
- `lagHours`：头部攻略站对最近事件发稿的滞后小时数 → 全局乘数

实测效果（Slayers 2）：竞争项被压到 10 分、再叠 ×0.6 乘数，结论变成「竞争饱和（人工判断）」，
与手工查证一致。**没有这个入口，推荐榜的第一名就是错的。**

> 配置改完 push 即生效（`data/config.json` 会随产物发布，不必等下一轮采集）。

#### 当前真实输出（2026-09-21）

```
55 个候选 · 可评估 28 个（有 Roblox 官方数据）· 值得做 14 个
值得做    96   The Hunt: Roblox 20   167.8M 访问 · 上线 7 天 · 11 个攻略词  ⚠️限时活动
竞争未测   —   sony playstation / gta 6 / fifa 27 / …（27 个非 Roblox 来源，判断不了）
```

**两条诚实的边界**：

1. **约一半候选「竞争未测」给不出分** —— 它们不是 Roblox 来源，没有访问量与上线日参照。
   第一版曾把缺失项的权重让给其它项，结果 `gta 6` / `fifa 27` 靠"内容面 + 动能 + 新鲜度"凑出
   **99 分排在第一位**；第二版又用"首次发现时间"冒充上线时长，让 `sony playstation` 拿到满分。
   **缺失不等于满分，也不等于 0，而是"判断不了"** —— 现在统一显示「竞争未测」+ 一个 SERP 链接。
   （想让这批也能量化，需要再补 Steam 官方数据：评价数 / 在线人数 / 发售日 —— 尚未做。）
2. **评分不区分「持久需求」和「一次性活动」** —— `The Hunt: Roblox 20` 拿了 96 分，但它 9/17–9/28 只有 12 天窗口，
   活动结束需求就断崖归零，新站来不及排上去。目前只用名称启发式打一个 ⚠️ 提示，**不否决、不扣分**。

#### Steam 官方数据（`src/lib/steam.mjs`）

原先只有 Roblox 来源能评分，Steam 候选全是「竞争未测」。现在补三个官方接口（零密钥）：

| 指标 | 端点 | 用途 |
|---|---|---|
| 发售日 / 价格 / 类型 | `store.steampowered.com/api/appdetails` | 新鲜度（上线时长）、内容面 |
| 评价数 / 好评率 | `store.steampowered.com/appreviews/<id>?json=1&num_per_page=0` | 口碑；评价数≈销量代理 |
| 当前在线 | `api.steampowered.com/ISteamUserStats/GetNumberOfCurrentPlayers` | 需求规模（Steam 口径） |

**四条实测约束（踩过的坑）**：

1. **`appdetails` 不支持多 appid 批量**（`appids=a,b,c` → HTTP 400）→ 逐个请求；靠「6 小时 TTL + 每轮上限 40」把稳态请求压到 0。
2. **`query_summary.num_reviews` 在 `num_per_page=0` 时恒为 0** → 真实条数必须看 `total_reviews / total_positive / total_negative`。
3. **CCU 接口对未发售 / 无效 appid 返回 404**（不是 200+0）→ 必须当"没有数据"处理，否则每次白等两轮退避重试。
4. 🛑 **按名字关联外部数据必须先确认唯一标识** —— 实测 `Deep Fishing` 在 Roblox 与 Steam 上**同名不同游戏**，
   只按名字匹配会把 Steam 的评价数写进 Roblox 游戏身上、覆盖它真实的 visits/approval。
   所以：**只对「来源未知」或「明确是 Steam」的条目做名字解析**，且要求**归一化后严格同名**
   （`gta v` 绝不匹配 `GTA VI`）；搜不到的负结果缓存 7 天，避免每轮重搜同一批。

**需求规模的锚点按平台分开**（不能共用一条曲线，两者数量级差 4~5 个数量级）：

| 平台 | 口径 | 锚点 |
|---|---|---|
| Roblox | **终身访问量** | 1e5→0 · 1e6→33 · 1e7→66 · 1e8→100 |
| Steam | **当前在线**（为 0/缺失时退回评价数） | 1→0 · 100→54 · 5000→100 |

实测覆盖（2026-09-21，**开了 AAA 黑名单 + 补了 `feedback.block` 之后**，74 个候选）：
**Roblox 65 · Steam 4 · 仍缺 5**（那 5 条是故意留的灰区，见"AAA 大作黑名单"一节）。

> 历史：清理前是 76 条里缺 25 条 —— 那些缺口**不是数据问题，是"根本不是可做站的游戏"**
> （`gta vi` / `fifa 27` / `wordle hints` / `pokemon cards`），所以正确处理是**过滤**而不是硬补数据。

#### 潜伏 → 上线：接班机制（2026-09-21）

**问题**：潜伏清单和建站推荐原先是两条互不相通的线 —— 一个游戏在潜伏清单里盯了两个月，
上线后不会自动出现在建站推荐里，得等它自己从 Discover 榜单/热搜冒出来（可能几天到几周）。

**做法**（`linkUpcomingToRoblox()`，在潜伏清单生成时就地跑）：

1. **关联官方 universeId**：优先用 BloxInformer 自己给的 `robloxLink`（零配额，实测 11/68 有）；
   没有的才去官方搜索接口按名字解析 —— 并校验归属：BloxInformer 给了 Roblox 用户/群组链接时，
   要求解析出的 universe 的 `creator.id` 与之一致，不一致就拒绝并记录原因（防同名仿作）。
2. **判定是否已上线**：把关联到的 universeId **批量**丢给 `games.roblox.com/v1/games`
   （一次 50 个 → 1~2 次请求），`visits > 0 || playing > 0` 即判定"已经能玩"。
3. **推进雷达队列**：带上 `prio: 5`（插队）+ `via: "watchlist-live"` 标记 → 走现有链路
   （取曲线 → 补官方数据 → 进 `games.json`）→ 下一轮就带官方数据出现在建站推荐。

**四个实测坑（都修了）**：

| 坑 | 现象 | 修法 |
|---|---|---|
| 搜索接口 `sessionId` 必须是 **UUID** | 传普通字符串直接被拒 | 每次调用 `randomUUID()` |
| 搜索接口是**配额冷却**不是限速 | 一次 200 后隔 4 秒、甚至 15 秒全 429 | 每轮只搜 1 次 + 首次 429 立即熔断 + **429 绝不写进负缓存**（那是限流，不是"不存在"） |
| 队列"抬优先级"时**没同步元数据** | 条目升到 prio 5 但 `via` 没写进去，下游"免曲线门槛"规则永远看不到 | bump 时一并合并新字段 |
| 雷达的「零信号不要」会吃掉转正条目 | 新游戏在 Trends 上没有曲线 → 整条丢弃，潜伏几个月的成果蒸发 | `via === "watchlist-live"` 的条目**免曲线门槛**；曲线取不到（含 429）也照样用官方数据收录，`reason` 标「潜伏清单转正（Trends 暂无曲线）」 |

> 前端配合：转正条目的 `reason` 含「潜伏」，推荐页会给一条黄条说明
> "暂无 Trends 曲线，所以需求动能缺失" —— 缺项要说明原因，不能让人以为是 0。

实测（2026-09-21 一轮）：6 条从潜伏清单转正，6/6 进入 `games.json` 并带官方数据
（如 `Starforged` 访问 61K / 好评 68% / 上线 2025-12-23；`A Bizarre Race` 好评仅 38.2% → 被口碑门槛否决，这是该有的行为）。

#### 关于「每小时实时更新吗」

**不是"每分钟实时刷新"，是三档节奏**（页面顶部的"更新于 X"指的是**采集时间**，不是评分计算时间）：

| 层 | 节奏 | 说明 |
|---|---|---|
| **分数与排序** | **打开页面时实时重算** | `rankability()` 跑在浏览器里，每次打开就地重算 |
| **Roblox 官方数据**（访问量 / 好评 / 上线日 / 在线人数） | **每小时**（`statsRefreshHours: 1`） | 批量接口，稳态 2 次请求 |
| **Steam 官方数据**（评价 / 好评 / 在线 / 发售日） | 每 6 小时（`steamStats.refreshHours`） | 接口不支持批量（每个游戏 3 次请求），所以 TTL 定长一些 |
| 热搜 / 攻略词 | 每小时采集（CI `:23`） | 攻略词按 `refreshHours: 6` 节流 |
| **Google Trends 曲线**（需求动能） | 每 6 小时（`refreshHours: 6`） | 🛑 唯一有真实封禁风险的接口，刻意保守 |
| 新鲜度项 | 随 `Date.now()` 自然衰减 | 唯一"不看采集时间也会变"的项 |

**结论：推荐列表是「每小时」级新鲜的**（Roblox 数据 + games.json + 打开页面就地重算）。
本地看板只有在跑过 `npm run collect`（或 `--only-games`）之后才会更新；线上站点靠 CI 每小时跑。

**推荐页排序**（右上角切换）：`🎯 结论优先`（默认，档位 → 分数）/ `🆕 最近上线` / `🕰 最早上线`。

---

---

### 🚀 潜伏列表（看板标签页 · 零配额）

**为什么需要单独一页**：「新游戏雷达」是**已经起量**的游戏（要拉曲线、吃 Trends 配额、还可能被限流）；
但真正决定成败的是**上线之前**那段时间 —— 实测教训（Batomon Showdown，2026-09-21）：等游戏上线才动手，
6 天内 SERP 上已经出现 **7 个专用站**，最值钱的词前 8 位被 5 个域名瓜分。**等到看见热度，窗口已经关了。**

所以「潜伏」的判据必须是**上线前可测的**：

| 项 | 来源 | 说明 |
|---|---|---|
| **愿望单序位** | Steam `filter=popularcomingsoon` | 发售前唯一可测的需求代理（Steam 不公开愿望单数量，只能用名次近似） |
| **发售日 / 精确度** | Steam `comingsoon` + `appdetails` | `day` > `quarter` > `year` > 未定档（决定你要不要现在动手） |
| **是否有 Demo** | `appdetails` | 有 demo＝团队在预热、玩法已验证 |
| **类型 / 开发商 / 价格** | `appdetails` | 判断"能不能写出足够多的页面" |
| **Roblox 未发售** | **BloxInformer Release Hub**（第三方，**直连实时抓取**） | Roblox **官方没有任何"未发布体验"公开列表**（官方 `up-and-coming` 是"已上线刚起量"）；BloxInformer 自述数据来自官方公告 + Discord 爆料 + 开发者社媒，是行业事实标准（实测 68 条，带发行状态与倒计时） |
| **Roblox 潜伏评估** | 由上面那份清单算出来 | 发布确定性 35 + 日期精确度 25 + 内容面 20 + 社区地基 20（见下方"潜伏评分"） |

**窗口分类**（决定"现在还来不来得及"）：

| 窗口 | 含义 | 动作 |
|---|---|---|
| 🟢 `build` | 距发售 **30~180 天** | **黄金窗口**：够建站、够被收录 → 优先做 |
| 🟡 `close` | ≤30 天 | 窗口很窄 → 只做时效性长尾页 |
| ⚪ `far` | >180 天或**未定档** | 高愿望单 + 没定档恰恰是最典型的潜伏标的 |
| 🔵 `live` | 已经上线（Roblox 侧） | 按"可挤入度"判断，不走潜伏线 |
| 🔴 `too-late` | ≤7 天 | 默认**不进清单**（`includeTooLate: true` 可放开） |
| 🆕 `fresh` | **已上架 ≤60 天（手游）** | iOS 专有：刚上线就冲榜 = 竞争几乎为零 → 见下 |

#### 🆕 iOS「新上架」分组的来历（2026-09-24 实测，含一个反直觉发现）

**先说反直觉的那条**：Apple 的 `newfreeapplications` / `newpaidapplications`（"最新上架"）**不等于"刚上线"**。
实测：该 feed 自己的 `updated` 时间戳是新的（`2026-09-23`），但**里面每个游戏的上线日都停在 `2026-07-03 ~ 07-08`**
（113/114 条挤在 76~83 天）—— 它返回的是**一个冻结的旧批次**。直接拿它当"新游"会得出全错的结论。

**所以改成两条腿，并用 `lookup` 的真实 `releaseDate` 判窗口**：

| 腿 | 抓什么 | 作用 |
|---|---|---|
| ① `topfreeapplications` / `topgrossingapplications` | 各地区的免费/收入榜（4 个地区） | **真·刚上线就冲榜**的候选 —— 这才是"新上线"的主力信号 |
| ② `newfreeapplications` / `newpaidapplications` | Apple 在推的新面孔 | 上线日普遍 ~2.5 个月，但**评分人数极少（竞争低）**；排在 lookup 预算之后 |

实测一轮：**榜上抓 593 个 → 用 `lookup` 查 300 个的详情 → 进清单 11 条**（无日期丢弃 7 · 上线超 60 天 282）。
样例（都是"刚上线 + 已冲榜 + 几乎没人评"）：

```
1天  Smoq Games 27                    top-free GB #7   评分未取得（0 人评）
1天  Warhammer 40,000: Boltgun Boom   top-free US #33  评分未取得（0 人评）
3天  Aniimo                           top-free US #3 / JP #2   3.33★（850 人）
23天 波乱水世界                        top-free JP #6    4.49★（100 人）
```

**排序语义**（服务端与前端都必须一致）：iOS 用「已上架天数」当同一个主键 ——
语义上**「3 天前上架」和「3 天后发售」都是"3 天的事"**，都是现在该动手的信号，所以混排在一张表里。
`daysSince`（小数）与 `releaseInDays`（负数）一起写进条目，前端显示为「已上架 N 天」。

**⚠️ Android 进不了这份清单**：Play 没有可抓的"新游"入口、详情页也没有首发日 → 判不了「上线几天」。
它只能在「🎮 新游戏雷达 / 🎯 建站推荐」里按**评分人数（需求）+ 星级（口碑）**评估，竞争需人工点 SERP 核查。
这不是偷懒，是那个平台没有这个数据。

**三条硬约定（不要改）**：

1. **不消耗 Trends 配额**（`watchlist.trendsCheck` 默认 `false`）。列表零配额、可每小时跑；要不要看需求趋势由人点链接决定。
2. **任何失败都不删条目**。每条都带三个直链 —— `商店页 / Google Trends / SERP（查 wiki·竞品占位）`。
   Trends 429、`appdetails` 失败、某来源挂掉，条目照样在，只是对应字段标「未测」。
   **"未测"不等于没有需求**：链接永远有效，自己点过去看。
3. **占位日期必须识别**。Steam 上大量未定档游戏写着 `2099 / 9998` 这类占位年份，当成真发售日会把清单按荒谬顺序排
   （实测 `Released_DESC` 榜 40 条里 15 条是占位值）—— 脚本把「当前年 +5 年之后」一律按"未定档"处理。

命令行：

```bash
node src/collect.mjs --only-watchlist    # 只刷潜伏清单（约 30s，之后走缓存更快）
node src/collect.mjs --no-watchlist      # 全量采集但跳过潜伏清单
npm run watchlist                        # 同上，看板读 data/watchlist.json
```

**Roblox 侧开关**（`config.json`）：

```jsonc
"watchlist": {
  "roblox": { "upcoming": true, "rising": false },                 // rising = 官方 up-and-coming（已上线，默认关）
  "robloxUpcoming": {
    "directFetch": true,        // 直连（fetch → 被 CF 拦就换 curl）
    "waybackFallback": true,    // 直连全挂时才用 Wayback 存档
    "cacheHours": 1,            // 直连可用 → 每小时刷新
    "overrideMaxDays": 3,       // data/roblox-upcoming.html 的保鲜期
    "dropPast": true            // 已发售的条目剔除（计数并显示）
  }
}
```

也可以**手动喂一份刚存的页面**（无视保鲜期，直接生效）：

```bash
node src/collect.mjs --only-watchlist --roblox-html "D:\Downloads\upcoming-roblox-games.html"
```

> 抓快照的三条通道（自动依次试）：**上次成功过的直链 > `/web/2/` 最近快照入口 > CDX 列表**。
> 实测直链最稳，`/web/2/` 与 CDX 更容易被 429 —— 所以解析成功后会记住那个快照 URL 复用。

**产物**：`data/watchlist.json`（随 `data/*.json` 一起发布到站点）+

- `data/.steam-detail-cache.json`：Steam 详情缓存（7 天 TTL）—— 未发售游戏的类型/价格变化慢，别每小时重打
- `data/.roblox-upcoming.json`：Roblox 快照缓存（12 小时 TTL）+ 记住可用的快照直链
- `data/.watchlist-state.json`：Trends 检查结果缓存（仅在 `trendsCheck: true` 时产生）

> 两者都以 `.` 开头 → 不会被工作流的 `find ... -not -name '.*'` 打包进静态站点。
>
> ⚠️ 实测：Steam `appdetails` **不支持多 appid 批量**（`appids=a,b,c` 返回 HTTP 400），只能逐个请求 ——
> 所以靠"缓存 + 每轮上限（`enrichCount`）"控制请求数，而不是靠合并请求。

**已知边界（诚实交代）**：

- **Steam 没有"3~6 个月后发售的高愿望单"官方榜**（实测深翻页仍是近月发售的游戏）→ 远期候选只能靠人工渠道
  （官方公告 / 预告片 / 社区）补，本清单偏「近月高热度」。
- **Roblox 侧没有官方数据源**：官方 `up-and-coming` 是"已上线刚起量"，不是未发布。
  数据来自第三方 BloxInformer Release Hub —— **直连抓取**（见下方"为什么能直连 Cloudflare 站点"），
  每小时刷新一次；通道全挂时才会退到 Wayback 存档或旧缓存，并在页面上显式标注来源与数据时间。
- Roblox 条目的「状态」（In Development / Confirmed / Delayed / Maybe Cancelled）是 BloxInformer 的**第三方核对结果**，不是 Roblox 官方声明。

#### 为什么能直连 Cloudflare 站点（`src/lib/web-fetch.mjs`）

**这不是"绕过"，是换一个指纹正常的取页器。** 实测结论（2026-09-21）：

| 取页方式 | 结果 |
|---|---|
| Node `fetch`（undici） | ❌ **403「Attention Required」** —— 改 UA、加 header 全都无效 |
| 无头 Chrome `--headless=new --dump-dom` | ❌ 更严格的硬拦（"you have been blocked"） |
| **`curl.exe`**（Windows 10+ / Linux 自带） | ✅ **HTTP 200 + 完整 68 条** |

Cloudflare 拦的是 **TLS / HTTP-2 指纹**（Node 的握手特征明显不是浏览器），不是 UA 字符串。
所以 `web-fetch.mjs` 做成两条通道：**先 `fetch`（快，多数站点够用）→ 只看内容特征判定是否挑战页
（CF 托管挑战常常返回 200 + 一段 JS）→ 命中就换 `curl`**。

> 这个层是**通用**的：以后任何被 Cloudflare 挡住的来源（robipedia / allthings.how / 其它 wiki）
> 都走同一个 `fetchPage()`，不要再退回 Wayback。

#### 潜伏评分（Roblox 未发售条目，0~100）

四个维度**全部是上线前可测的**（页面给的字段）：

| 维度 | 权重 | 怎么算 |
|---|---|---|
| **发布确定性** | 35 | Confirmed 100 · Beta/Early Access 82 · In Development 55 · Pre-Alpha 40 · Delayed 30 · Maybe Cancelled 5 |
| **日期精确度** | 25 | 确切日期 100 · 只有月份 70 · 只有季度 55 · 只有年份 40 · 未定档 15 |
| **内容面** | 20 | 由 genres 推断：图鉴/养成类（RPG / monster catching / Turn Based / Open World）92 · 模拟经营类 70 · Action/Shooter 52 · Escape/Obby/RNG 28 |
| **社区地基** | 20 | Discord +8 · YouTube +6 · Roblox 群组 +6（封顶 20） |

档位：`≥75 值得潜伏` · `55~74 观察` · `<55 暂不`；**风险覆盖**：状态含 Delayed / Maybe Cancelled → 强制「风险」，
距发售 ≤7 天 → 「窗口已过」。

> 🛑 它是**启发式，不是实测**：内容面靠 genres 推断（页面没有"能写多少页"这种字段）。
> 所以前端把四个分项的理由一起放在 `title` 里，鼠标一悬停就能看到每一分是怎么来的、并直接反驳它。

**统计面板**（页面顶部）直接给出这份清单的规模：原始条数 / 剔除已发售 / 保留条数 / 平均分 /
按状态 / 按窗口 / 按评估档 / 类型 Top / 有确切日期·有 Roblox 页·有 Discord 的数量。

> 实测一轮（2026-09-21）：原始 **68** 条 → 剔除已发售 **36** → 保留 **29**（其中只有 5 条有确切日期，
> 24 条未定档），平均分 47 → 这正是真实情况：**Roblox 的未发售清单里绝大多数还没有日期**，
> 所以「哪个最近发售」必须靠日期列排序（默认），而不是靠评分排序。

---

## 三、已知限制与风险（务必知悉）

1. **Google Trends 没有官方 API**。本系统用的是网页内部接口，Google 可能随时改动字段或加验证。`src/lib/trends.mjs` 已把结构解析集中在 `normalizeItem()` 一处，接口变动时只改这里。
2. **限流真实存在**。热搜接口（i0OFE）在 38 国并发 3 下稳定；曲线接口（multiline）限流严格得多，已改为**串行 + 1.2s 间隔 + 4 次退避重试**，仍可能个别失败（会记为 warn 并跳过，不影响整轮）。
3. **不要提高采集频率，也不要反复手动重跑**。每小时一次是原站的做法，也是安全区间。实测连续密集调试（十几轮采集 + 五十多次曲线请求）会把当前 IP 打进 429，需要等一段时间才恢复；生产上按小时跑完全够用。频率过高会被封。
4. **搜索量/涨幅是官方分桶相对值**，不是绝对搜索量。所有决策请按「桶位」理解，不要当成精确数字。
5. **模型/规则类字段（noise、gameCandidate、score）是我们自建的**，与原站数值不一致，也不追求一致；它们是白盒规则，可直接按自己业务改 `src/lib/detect.mjs`。
6. 本项目只做**数据采集与展示**，不包含任何抓取非公开数据的行为；请自行遵守目标站点的使用条款。

---

## 四、与原站产物对照（同一时点量级）

| 指标 | 原站 | 我们（首次运行） |
|---|---|---|
| 地区数 | 38 | 38 |
| 实时热搜条数 | ~5000 | 5591 |
| trends.json | 565 KB | 459 KB |
| 留档 | 7 天 / 分 21 片 | 7 天 / 分片 |
| 新游戏 | 392（长期累积） | 4（单轮，随时间累积） |
| 关键词池 | 无 | 6193 词 |
