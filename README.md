# Keyword Radar · 自建全球热词与新游戏雷达

反推 `findnews.me` 的实现机制后，从零重建的一套「找词系统」。零第三方依赖（纯 Node 内建模块），产出静态 JSON + 本地看板。

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

**结论：它不是一次抓那么多，是 13.8 天连续累积的（28.2 个/天）。** 而它每轮的口径同样很宽：

- `score` 最低到 **2**，且混有 `kevin` / `IBC` / `Boss` 这类明显误收 → **几乎没有游戏识别过滤，把 Games 分类的词近乎全量喂给曲线接口**，用曲线本身当筛子。
- 我们实测同一份快照里有 **134 个 `cats∋6` 的词**，其中 131 个能通过游戏识别。真正的差别在**搜索量门槛**：

| 我们的候选门槛 | 候选数 | 相对全量 |
|---|---|---|
| `minVol = 0` | 131 | 100% |
| `minVol = 1000` | 53 | 40% |
| `minVol = 5000` | 10 | **7.6%** |
| `minVol = 20000` | **0** | 0% |

最初的 `minVol = 5000` 直接砍掉 92% 的候选 —— **这才是我们只抓到 4 个的真正原因**（不是识别算法差）。已把默认值改为 `1000`，产出量就能对齐原站量级。

顺带一个重要发现：**原站游戏列表里大量是 Roblox 游戏**——`Poly Loot`、`Defeat Anime RNG`、`BloxNote`、`Venture AOT`、`Anime Ascendants`、`Sword Hunter`、`Grow a Chicken Fighter`、`Dungeon Quest Reborn`。这条赛道对做 Roblox 攻略站的人直接可用。

### 6. 还原度评估

| 层面 | 还原度 | 说明 |
|---|---|---|
| **数据源** | **100%** | 同一接口 `i0OFE`、同一 24h 窗口、同一 cookie 策略、同一分桶语义 |
| **数据结构** | **~100%** | 4 个 JSON 的字段级对齐（含 `cats` 官方分类、`vol_peak`/`growth_peak`/`sightings`/`chunks` 分片）。我们产出的 `trends.json` 可直接替换原站文件 |
| **采集调度** | **100%** | 每小时一轮、7 天滚动留档、峰值合并、按峰值降序 |
| **游戏雷达** | **流程 100%，判据自建** | `explore` + `multiline` 取 7 天曲线、43 点 = 169 小时点每 4 小时抽样，全部对齐；但它的候选过滤规则无法反推，我们用白盒规则替代 |
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
| 新游戏识别 | 黑盒 | 白盒规则：Games 分类 / 平台词 / 游戏意图词，显式剔除体育、影视、**彩票博彩**（Google 把彩票归到 Games 分类） |
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
| `games.*` | 游戏雷达：目标市场（`geos`）、每轮取多少条曲线（`maxCurvesPerRun`）、曲线抽样间隔（`sampleEveryHours`）、刷新间隔（`refreshHours`）、收录门槛（`minVol`）、每个游戏留多少攻略词（`relatedWords`）、请求间隔（`delayMs`） |

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
| **`push` 到 `main`**（改动了 `web/**`、`src/**`、`config.json` 等） | ❌ **不会** | ✅ 用上一轮的数据重新发布 | 目的是让你改完前端不用等一小时才看到效果，同时不白打一遍 Google 接口 |

> 所以：**提交代码不会触发重新采集**，只会用最新的留档重新发布一次页面。想要立刻刷新全部国家，去 Actions 点 `Run workflow` 并**把 geos 留空**；或者等下一个整点的自动运行。
>
> 全量跑完后 `trends.json` 会被 38 国覆盖，之前那几个国家的数据不会丢 —— 它们已经进了 7 天留档 `history.json`。

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
#   F i n d G a m e s 
 
 