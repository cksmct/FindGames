/* Keyword Radar 看板：纯静态，读 data/*.json 渲染 */
(function () {
  "use strict";
  var $ = function (id) { return document.getElementById(id); };
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function fmtVol(v) {
    if (!v) return "—";
    if (v >= 1e6) return v / 1e6 + "M";
    if (v >= 1e3) return v / 1e3 + "K";
    return String(v);
  }
  function rel(iso) {
    if (!iso) return "";
    var m = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
    if (m < 1) return "刚刚";
    if (m < 60) return m + " 分钟前";
    if (m < 1440) return Math.round(m / 60) + " 小时前";
    return Math.round(m / 1440) + " 天前";
  }
  function fetchJson(u) {
    return fetch(u, { cache: "no-store" }).then(function (r) {
      if (!r.ok) throw new Error(r.status);
      return r.json();
    });
  }

  // ── 平滑曲线 ──
  function smoothPath(pts) {
    if (pts.length < 3) return "M" + pts.map(function (p) { return p[0] + "," + p[1]; }).join("L");
    var d = "M" + pts[0][0] + "," + pts[0][1];
    for (var i = 0; i < pts.length - 1; i++) {
      var p0 = pts[Math.max(0, i - 1)], p1 = pts[i],
          p2 = pts[i + 1], p3 = pts[Math.min(pts.length - 1, i + 2)];
      d += "C" + (p1[0] + (p2[0] - p0[0]) / 6) + "," + (p1[1] + (p2[1] - p0[1]) / 6) +
           " " + (p2[0] - (p3[0] - p1[0]) / 6) + "," + (p2[1] - (p3[1] - p1[1]) / 6) +
           " " + p2[0] + "," + p2[1];
    }
    return d;
  }
  var _n = 0;
  function sparkSvg(series, color) {
    var W = 260, H = 64, n = series.length;
    if (n < 2) return "";
    var gid = "gr" + _n++;
    var mx = Math.max.apply(null, series), mn = Math.min.apply(null, series);
    var span = mx - mn || 1;
    var pts = series.map(function (v, i) {
      return [(i / (n - 1)) * W, H - 6 - ((v - mn) / span) * (H - 14)];
    });
    var line = smoothPath(pts);
    var area = line + "L" + W + "," + H + "L0," + H + "Z";
    var c = color || "#4f9cf9";
    return (
      '<svg class="spark" viewBox="0 0 ' + W + " " + H + '" preserveAspectRatio="none">' +
      '<defs><linearGradient id="' + gid + '" x1="0" y1="0" x2="0" y2="1">' +
      '<stop offset="0" stop-color="' + c + '" stop-opacity="0.35"/>' +
      '<stop offset="1" stop-color="' + c + '" stop-opacity="0.02"/></linearGradient></defs>' +
      '<path fill="url(#' + gid + ')" d="' + area + '"/>' +
      '<path fill="none" stroke="' + c + '" stroke-width="2" d="' + line + '"/></svg>'
    );
  }

  // ── 状态 ──
  var state = {
    tab: "hot", geo: "ALL", cat: "all", vol: 0, growth: 0,
    noise: false, watch: false, q: "", rowsShown: 200, poolQ: "", gameSort: "first", pick: "all", pickSort: "verdict",
    watchSort: "date", watchSrc: "all", watchQ: "", watchTba: false,
  };
  var trends = null, history = null, games = null, pool = null, poolIndex = null, watch = null;
  var CATS = {}, GEOS = [];
  // 对比基准词：来自 config.json 的 trendsCompare，由 trends.json 透出
  // 所有点出去的 Google Trends 链接都会带上它，形成"该词 vs 基准词"的对比图
  var COMPARE = "";
  // 链接里 geo 的缺省值（config.json 的 trendsDefaultGeo），用于"全部地区"视图
  var DEFAULT_GEO = "US";
  // 竞争强度的人工判断（config.json 的 games.competition）。
  // 为什么要它：长尾是否被专用 wiki / 专业站占据，**自动抓不到** —— 只能人去查。
  // 但它恰恰是最能翻转结论的那一项：Slayers 2 自动分 96（体量在可做区间、好评 98.7%、12 个攻略词），
  // 而实测它有 3 个专用 wiki + progameguides 专属 hub，是饱和的。
  // 自动分排它第一、人工判断说别做 —— 所以必须留一个覆盖入口，否则第一个推荐就是错的。
  var MANUAL_COMP = {};

  /**
   * 构造 Google Trends 链接。
   *
   * ⚠️ 必须用新路径 `/explore`，不能用旧的 `/trends/explore`：
   *    实测（同一时刻交替请求、连测两轮结果一致）旧路径对非浏览器客户端稳定返回 429，
   *    新路径稳定返回 200。且新 UI 的相关词面板能看到的词更多。
   *
   * 参数顺序与 Google 自己的链接完全一致：date → geo → q。
   * geo 恒有值 —— 缺 geo 会退回全球口径，与"从某个地区榜单点进来"的上下文不符。
   * q 整体 encodeURIComponent，逗号会编码成 %2C —— 与 Google 自己生成的链接格式一致。
   */
  function exploreUrl(term, geo) {
    var t = String(term == null ? "" : term).trim();
    if (!t) return "https://trends.google.com/explore";
    var g = geo && geo !== "ALL" ? geo : DEFAULT_GEO;
    // 带上对比基准词；同时避免自比（term 本身就是基准词时）出现 "GPTs,GPTs"
    var q = COMPARE && COMPARE.toLowerCase() !== t.toLowerCase() ? t + "," + COMPARE : t;
    return "https://trends.google.com/explore?date=now%207-d&geo=" + encodeURIComponent(g) +
      "&q=" + encodeURIComponent(q);
  }

  /** config.json 会一起发布，所以改 trendsCompare 不必等下一轮采集 */
  function applyCompare(v) {
    if (v === undefined || v === null) return;
    var next = String(v || "");
    if (next === COMPARE) return;
    COMPARE = next;
    if (state.tab === "hot") renderHot();
    else if (state.tab === "games") renderGames();
  }

  /** 一次性应用 config.json 里与 Trends 链接相关的配置 */
  function applyTrendsConfig(cfg) {
    if (!cfg) return;
    var g = String(cfg.trendsDefaultGeo || "").trim().toUpperCase();
    if (g && g !== DEFAULT_GEO) DEFAULT_GEO = g;
    if (cfg.competition && typeof cfg.competition === "object") {
      MANUAL_COMP = {};
      for (var k in cfg.competition) MANUAL_COMP[String(k).toLowerCase().trim()] = cfg.competition[k];
      if (state.tab === "pick") renderPick();
    }
    applyCompare(cfg.trendsCompare);
  }

  /** 取某个游戏的人工竞争判断（大小写/首尾空格无关）。没有则返回 null。 */
  function manualComp(name) {
    return MANUAL_COMP[String(name || "").toLowerCase().trim()] || null;
  }

  function catNames(ids) {
    return (ids || []).map(function (c) { return CATS[c]; }).filter(Boolean).slice(0, 2).join(" · ");
  }
  function trendsLink(q, g) {
    return exploreUrl(q, g);
  }
  function pass(r, v, g) {
    if (state.noise && r.noise) return false;
    if (state.watch && !(r.watch && r.watch.length)) return false;
    if (state.cat !== "all" && (r.cats || []).indexOf(Number(state.cat)) < 0) return false;
    if (state.vol && (v || 0) < state.vol) return false;
    if (state.growth && (g || 0) < state.growth) return false;
    if (state.q && r.q.toLowerCase().indexOf(state.q) < 0) return false;
    return true;
  }
  function relatedOf(q) {
    if (!poolIndex) return [];
    return poolIndex[(q || "").toLowerCase()] || [];
  }

  // ── 筛选条 ──
  function buildBars() {
    var geos = ["ALL"].concat(GEOS);
    $("geo-bar").innerHTML = geos.map(function (g) {
      return '<button data-geo="' + g + '"' + (g === state.geo ? ' class="on"' : "") + ">" +
        (g === "ALL" ? "🌐 全球" : esc(g)) + "</button>";
    }).join("");
    $("cat-bar").innerHTML =
      '<button data-cat="all"' + (state.cat === "all" ? ' class="on"' : "") + ">全部分类</button>" +
      Object.keys(CATS).map(function (c) {
        return '<button data-cat="' + c + '"' + (String(state.cat) === c ? ' class="on"' : "") + ">" + esc(CATS[c]) + "</button>";
      }).join("");
    $("vol-bar").innerHTML = [[0, "全部量"], [20000, "≥2万"], [100000, "≥10万"], [500000, "≥50万"]]
      .map(function (p) {
        return '<button data-vol="' + p[0] + '"' + (p[0] === state.vol ? ' class="on"' : "") + ">" + p[1] + "</button>";
      }).join("");
    $("growth-bar").innerHTML = [[0, "全部涨幅"], [200, "≥200%"], [500, "≥500%"], [1000, "≥1000%"]]
      .map(function (p) {
        return '<button data-growth="' + p[0] + '"' + (p[0] === state.growth ? ' class="on"' : "") + ">" + p[1] + "</button>";
      }).join("");
  }

  // ── 实时热词 ──
  function renderHot() {
    var el = $("hot-table");
    if (!trends) { el.innerHTML = '<p class="empty">加载中…</p>'; return; }
    var isAll = state.geo === "ALL";
    var rows = [];
    if (isAll) {
      var byQ = {};
      Object.keys(trends.items).forEach(function (g) {
        trends.items[g].forEach(function (r) {
          var c = byQ[r.q];
          if (!c) { c = byQ[r.q] = Object.assign({}, r, { _geo: g, _geos: [] }); }
          else if ((r.vol || 0) > (c.vol || 0)) { var gs = c._geos; c = byQ[r.q] = Object.assign({}, r, { _geo: g, _geos: gs }); }
          if (byQ[r.q]._geos.indexOf(g) < 0) byQ[r.q]._geos.push(g);
          if (r.new) byQ[r.q].new = 1;
        });
      });
      rows = Object.keys(byQ).map(function (q) { return byQ[q]; });
      rows.sort(function (a, b) { return (b.vol || 0) - (a.vol || 0); });
    } else {
      rows = (trends.items[state.geo] || []).map(function (r) { return Object.assign({}, r, { _geo: state.geo }); });
    }
    rows = rows.filter(function (r) { return pass(r, r.vol, r.growth); });
    if (!rows.length) { el.innerHTML = '<p class="empty">该筛选下暂无数据</p>'; return; }

    var body = rows.slice(0, state.rowsShown).map(function (r, i) {
      var rels = relatedOf(r.q);
      return '<tr class="row" data-q="' + esc(r.q) + '" data-geo="' + esc(r._geo) + '">' +
        '<td class="num dim">' + (i + 1) + "</td>" +
        "<td>" + (r.new ? "🆕 " : "") + esc(r.q) +
          (r.zh ? '<div class="sub">' + esc(r.zh) + "</div>" : "") + "</td>" +
        (isAll ? '<td class="dim">' + esc((r._geos || [r._geo]).slice(0, 5).join(" ")) + "</td>" : "") +
        '<td class="dim hide-sm">' + (catNames(r.cats) || "—") +
          (r.noise ? ' <span class="tag">🔇' + esc(r.noise) + "</span>" : "") +
          (r.watch && r.watch.length ? ' <span class="tag star">★</span>' : "") + "</td>" +
        '<td class="num">' + fmtVol(r.vol) + "</td>" +
        '<td class="num ' + ((r.growth || 0) >= 1000 ? "hot" : "up") + '">' + (r.growth ? "+" + r.growth + "%" : "—") + "</td>" +
        '<td class="num dim">' + (rels.length ? rels.length : "—") + "</td>" +
        '<td><a href="' + trendsLink(r.q, r._geo) + '" target="_blank" rel="noopener">趋势</a></td>' +
        "</tr>";
    }).join("");

    el.innerHTML = '<div class="table-wrap"><table><thead><tr>' +
      '<th class="num">#</th><th>热搜词</th>' + (isAll ? "<th>地区</th>" : "") +
      '<th class="hide-sm">分类</th><th class="num">搜索量</th><th class="num">涨幅</th><th class="num">相关词</th><th></th>' +
      "</tr></thead><tbody>" + body + "</tbody></table></div>" +
      (rows.length > state.rowsShown ? '<button class="more" id="hot-more">显示更多（共 ' + rows.length + " 条）</button>" : "");
  }

  function toggleDetail(tr) {
    var next = tr.nextElementSibling;
    if (next && next.classList.contains("detail")) { next.remove(); return; }
    var rels = relatedOf(tr.getAttribute("data-q"));
    var cols = tr.children.length;
    var dtr = document.createElement("tr");
    dtr.className = "detail";
    var html = rels.length
      ? rels.map(function (x) {
          return '<span class="chip">' + esc(x.q) + " <b>×" + x.count + "</b></span>";
        }).join("")
      : '<span class="dim">该词暂无相关词记录（可能父词搜索量低于词池收录阈值）</span>';
    dtr.innerHTML = '<td colspan="' + cols + '"><div class="relbox"><span class="reltitle">相关搜索词：</span>' + html + "</div></td>";
    tr.parentNode.insertBefore(dtr, tr.nextSibling);
  }

  // ── 7 天留档 ──
  function renderHist() {
    var el = $("hist-table");
    if (!history) {
      el.innerHTML = '<p class="empty">加载中…</p>';
      fetchJson("data/history.json").then(function (d) {
        history = d;
        renderHist();
        for (var i = 2; i <= (d.chunks || 1); i++) {
          (function (n) {
            fetchJson("data/history-p" + n + ".json").then(function (p) {
              history.items = history.items.concat(p.items || []);
              history.items.sort(function (a, b) { return (b.vol_peak || 0) - (a.vol_peak || 0); });
              if (state.tab === "hist") renderHist();
            }).catch(function () {});
          })(i);
        }
      }).catch(function () { el.innerHTML = '<p class="empty">暂无留档，先跑一次采集</p>'; });
      return;
    }
    var items = history.items || [];
    var isAll = state.geo === "ALL";
    var rows;
    if (isAll) {
      var byQ = {};
      items.forEach(function (r) {
        var c = byQ[r.q];
        if (!c) { c = byQ[r.q] = Object.assign({}, r, { _geo: r.geo, _geos: [] }); }
        else if ((r.vol_peak || 0) > (c.vol_peak || 0)) { var gs = c._geos; c = byQ[r.q] = Object.assign({}, r, { _geo: r.geo, _geos: gs }); }
        if (byQ[r.q]._geos.indexOf(r.geo) < 0) byQ[r.q]._geos.push(r.geo);
      });
      rows = Object.keys(byQ).map(function (q) { return byQ[q]; });
      rows.sort(function (a, b) { return (b.vol_peak || 0) - (a.vol_peak || 0); });
    } else {
      rows = items.filter(function (r) { return r.geo === state.geo; })
        .map(function (r) { return Object.assign({}, r, { _geo: r.geo }); });
    }
    rows = rows.filter(function (r) {
      return pass({ q: r.q, cats: r.cats, noise: r.noise, watch: r.watch }, r.vol_peak, r.growth_peak);
    });
    if (!rows.length) { el.innerHTML = '<p class="empty">该筛选下暂无留档</p>'; return; }
    el.innerHTML = '<div class="table-wrap"><table><thead><tr>' +
      '<th class="num">#</th><th>热搜词</th>' + (isAll ? "<th>地区</th>" : "") +
      '<th class="hide-sm">分类</th><th class="num">峰值量</th><th class="num">峰值涨幅</th><th class="num">上榜</th><th>最后在榜</th>' +
      "</tr></thead><tbody>" +
      rows.slice(0, state.rowsShown).map(function (r, i) {
        return "<tr><td class=\"num dim\">" + (i + 1) + "</td><td>" + esc(r.q) + "</td>" +
          (isAll ? '<td class="dim">' + esc((r._geos || [r._geo]).slice(0, 5).join(" ")) + "</td>" : "") +
          '<td class="dim hide-sm">' + (catNames(r.cats) || "—") +
            (r.noise ? ' <span class="tag">🔇' + esc(r.noise) + "</span>" : "") + "</td>" +
          '<td class="num">' + fmtVol(r.vol_peak) + "</td>" +
          '<td class="num ' + ((r.growth_peak || 0) >= 1000 ? "hot" : "up") + '">' + (r.growth_peak ? "+" + r.growth_peak + "%" : "—") + "</td>" +
          '<td class="num dim">×' + (r.sightings || 1) + "</td>" +
          '<td class="dim">' + rel(r.last) + "</td></tr>";
      }).join("") + "</tbody></table></div>" +
      (rows.length > state.rowsShown ? '<button class="more" id="hist-more">显示更多（共 ' + rows.length + " 条）</button>" : "");
  }

  // ── 新游戏雷达 ──
  // 原站是按「最新信号」倒序（实测 388 条里只有 last 是单调键）；
  // 我们默认按「最新发现」，因为目的是一时间发现新游戏；两种都放开给用户切。
  var GAME_SORTS = {
    first: function (a, b) { return new Date(b.first) - new Date(a.first); },
    last: function (a, b) { return new Date(b.last || b.first) - new Date(a.last || a.first); },
    score: function (a, b) { return (b.score || 0) - (a.score || 0) || new Date(b.first) - new Date(a.first); },
  };
  var GAME_SORT_LABEL = { first: "最新发现", last: "最新信号", score: "分数" };
  // 来源徽标：Roblox 榜单 / Steam 商店 —— 点出去看原始作品页（原站没有这一步）
  var SRC_LABEL = { roblox: "Roblox", steam: "Steam" };
  function srcLink(g) {
    var label = SRC_LABEL[g.src] || g.src;
    if (g.srcList) label += " · " + g.srcList;
    if (!g.srcUrl) return esc(label);
    return '<a class="srclink" target="_blank" rel="noopener" href="' + g.srcUrl + '">' + esc(label) + "</a>";
  }

  function renderGames() {
    var el = $("game-cards");
    if (!games) { el.innerHTML = '<p class="empty">加载中…</p>'; return; }
    var sorted = (games.items || []).slice().sort(GAME_SORTS[state.gameSort] || GAME_SORTS.first);
    var items = sorted.slice(0, state.rowsShown);
    var meta = $("game-meta");
    if (meta) meta.textContent = "共 " + sorted.length + " 个 · 排序：" + (GAME_SORT_LABEL[state.gameSort] || "最新发现");
    el.innerHTML = items.map(function (g) {
      var age = (Date.now() - new Date(g.first).getTime()) / 864e5;
      var chart = (g.series || []).length > 1
        ? sparkSvg(g.series, "#7a5cf0") +
          '<div class="gmeta">📷 快照于 ' + String(g.chart_at || g.first).slice(0, 10) + " · 之后的走势见「查看趋势」</div>"
        : '<div class="nochart">' + (age < 7 ? "曲线采集中…" : "暂无曲线") + "</div>";
      var times = "首次发现 " + rel(g.first) + (g.last !== g.first ? " · 最新信号 " + rel(g.last) : "") +
        ((g.sightings || 1) > 1 ? " · 上榜 ×" + g.sightings : "");
      // 攻略词：每个词点出去都是「该词 vs 基准词」的对比图
      // （单个新词/长尾词单独看几乎是一条平线，配上基准词才有可比性）
      var hot = {};
      (g.rising || []).forEach(function (w) { hot[w] = 1; });
      var words = (g.words || g.rising || []).slice(0, 10);
      var tipBase = COMPARE ? "在 Google Trends 上与「" + esc(COMPARE) + "」对比" : "在 Google Trends 查看趋势";
      var kwHtml = words.length
        ? '<div class="kwrow"><span class="kwlabel">可做页面的词</span>' +
          words.map(function (w) {
            return '<a class="kwchip' + (hot[w] ? " up" : "") + '" target="_blank" rel="noopener" title="' +
              tipBase + (hot[w] ? "（上升词）" : "") + '" href="' + exploreUrl(w, g.chart_geo) + '">' +
              (hot[w] ? "🔥 " : "") + esc(w) + "</a>";
          }).join("") + "</div>"
        : "";
      return '<div class="gcard"><div class="ghead"><h3>' + esc(g.name) + "</h3>" +
        '<span class="score">score ' + (g.score || 0) + "</span></div>" +
        '<div class="gmeta">' + times + (g.reason ? " · " + esc(g.reason) : "") +
        (g.chart_geo ? " · 曲线地区 " + esc(g.chart_geo) : "") +
        (g.src ? " · " + srcLink(g) : "") + "</div>" +
        chart + kwHtml +
        '<div class="gmeta"><a href="' + exploreUrl(g.name, g.chart_geo) + '" target="_blank" rel="noopener">查看趋势' +
        (COMPARE ? "（vs " + esc(COMPARE) + "）" : "") + " →</a></div></div>";
    }).join("") || '<p class="empty">还没发现新游戏，多跑几轮采集</p>';
    if (sorted.length > state.rowsShown) {
      el.innerHTML += '<button class="more" id="games-more">显示更多（共 ' + sorted.length + " 个）</button>";
      $("games-more").onclick = function () { state.rowsShown += 60; renderGames(); };
    }
  }

  // ══════════════════════════════════════════════════════════════════════
  // 建站可做性（🎯 建站推荐）
  //
  // 🛑 2026-09-21 用户修正（重要，别改回去）：
  //    **「访问量/流量大」不是负面因素** —— 负面因素是「**竞争高**」和「**上线时间长**」。
  //    旧实现把访问量做成"中间高、两端低"的竞争余量，等于**用访问量反推竞争**，方向反了：
  //      访问量 = 需求（有人搜）→ 应该**正向**计分；
  //      竞争   = 要独立测（人工 SERP 核查优先，其次用上线时长推断）；测不到就标「竞争未测」。
  //
  // 六项（合计 100）：
  //   需求规模 22  访问量 / 在线人数，log 归一，**单调递增**
  //   内容面   20  已挖到的攻略词数量 ≈ 能做的页面数
  //   需求动能 14  7 天曲线后半段 vs 前半段
  //   口碑     12  好评率
  //   新鲜度   16  **距上线多久**，越老越难挤（"上线时间长"的兑现）
  //   竞争     16  分高 = 竞争低。人工 SERP 核查 > 上线时长推断 > 未测
  // 另：人工 lagHours（对手发稿滞后）作为**全局乘数** —— 是否决性信息，不参与加权平均。
  //
  // 反面案例（Royale High）：访问 1045 亿（需求拉满）、但上线 9 年 + 需求同比 -38% +
  // 7 家专业站 8 小时内发稿 + 长尾被社区垄断 → 这是**竞争与时长**否掉的，
  // 不是"因为它访问量太大"否掉的。
  // ══════════════════════════════════════════════════════════════════════
  var PICK_W = { demand: 22, surface: 20, fresh: 16, comp: 16, momentum: 14, quality: 12 };
  var PICK_LABEL = {
    demand: "需求规模", surface: "内容面", fresh: "新鲜度(上线时长)",
    comp: "竞争(分高=竞争低)", momentum: "需求动能", quality: "口碑",
  };

  function clamp01(v) { return Math.max(0, Math.min(100, v)); }
  var avgOf = function (a) { return a.length ? a.reduce(function (x, y) { return x + y; }, 0) / a.length : 0; };

  /** 需求规模：访问量单调递增（log 归一）。1e5→0 · 1e6→33 · 1e7→66 · 1e8→100 */
  function demandScore(visits) {
    if (visits == null || visits <= 0) return null;
    return clamp01((Math.log10(visits) - 5) * 33);
  }
  /** 内容面：已挖到的攻略词数量 ≈ 可直接做的页面数 */
  function surfaceScore(words) {
    var n = (words || []).length;
    if (n >= 8) return 100;
    if (n >= 5) return 80;
    if (n >= 3) return 55;
    if (n >= 1) return 30;
    return 0;
  }
  /** 需求动能：7 天曲线后半段 vs 前半段 */
  function momentumScore(series) {
    var v = (series || []).map(Number).filter(function (x) { return isFinite(x); });
    if (v.length < 8) return null;
    var q = Math.max(1, Math.floor(v.length / 4));
    var f = avgOf(v.slice(0, q)), l = avgOf(v.slice(-q));
    if (f <= 0.5) return l > 0 ? 100 : null; // 从零起飞
    return clamp01(50 + ((l - f) / f) * 50);
  }
  /** 口碑：50% 好评 → 0 分，95% → 100 分 */
  function qualityScore(approval) {
    if (approval == null) return null;
    return clamp01(((approval - 50) / 45) * 100);
  }
  /**
   * 上线时长（天）：**只认官方上线日 stats.created**（Roblox 接口给的）。
   *
   * 🛑 绝不能退化成「首次发现时间 g.first」：那是我们数据库里的时间，不是游戏的上线时间。
   *    实测踩过：拿 g.first 当 ageDays 后，没有官方数据的词（sony playstation / gta 6 …）
   *    因为"1 天前才发现"被算成上线 1 天 → 竞争项直接 100 分 → 排到推荐榜第一。
   *    拿不到就返回 null，让竞争项标「未测」，而不是编一个"新鲜=竞争低"。
   */
  function ageDaysOf(g) {
    var c = g.stats && g.stats.created;
    if (!c) return null;
    var d = (Date.now() - new Date(c).getTime()) / 86400000;
    return isFinite(d) ? d : null;
  }
  /** 新鲜度（越新越高）：≤1 月 100 · 1 年 40 · 5 年 10 · 10 年 0 */
  function freshAgeScore(ageDays) {
    if (ageDays == null) return null;
    if (ageDays <= 30) return 100;
    if (ageDays <= 365) return clamp01(100 - ((ageDays - 30) / 335) * 60);
    if (ageDays <= 1825) return clamp01(40 - ((ageDays - 365) / 1460) * 30);
    return clamp01(10 - ((ageDays - 1825) / 1825) * 10);
  }
  /**
   * 竞争（分高 = 竞争低 = 好挤进去）。
   * 优先级：人工 SERP 核查（最准）> 上线时长推断 > 未测(null)。
   * 🛑 绝不拿访问量推断竞争 —— 那是需求，不是竞争。
   */
  function compRoom(g, ageDays) {
    var mc = manualComp(g.name);
    if (mc && mc.open != null) {
      return { score: [10, 25, 50, 75, 100][Math.max(1, Math.min(5, Math.round(mc.open))) - 1], source: "manual" };
    }
    if (ageDays == null) return { score: null, source: "unknown" };
    var s = ageDays <= 180 ? 100
      : ageDays <= 365 ? 80
        : ageDays <= 730 ? 60
          : ageDays <= 1460 ? 40
            : ageDays <= 2920 ? 20 : 5;
    return { score: s, source: "age" };
  }

  function rankability(g) {
    var st = g.stats || {};
    var ageDays = ageDaysOf(g);
    var comp = compRoom(g, ageDays);
    var parts = {
      demand: demandScore(st.visits),
      surface: surfaceScore(g.words),
      fresh: freshAgeScore(ageDays),
      comp: comp.score,
      momentum: momentumScore(g.series),
      quality: qualityScore(st.approval),
    };
    // 🛑 竞争测不到就不给总分，**绝不做权重归一化**。
    //    踩过的坑：把缺失项的权重让给其它项后，sony playstation / fc 27 / gta 6 / fifa 27
    //    靠 内容面100 + 动能 + 新鲜度 凑出 99 分排到第一 —— 而它们恰恰是最做不了的那批。
    //    缺失不等于满分，也不等于 0，而是"判断不了"，必须如实显示为 —。
    var sum = 0, wsum = 0, missing = [];
    for (var k in PICK_W) {
      if (parts[k] == null) { missing.push(k); continue; }
      sum += parts[k] * PICK_W[k];
      wsum += PICK_W[k];
    }
    var mc = manualComp(g.name);
    // 只把「对手发稿滞后」当全局乘数（open 已经进了竞争项，不能重复计一次）
    var mult = 1;
    if (mc && mc.lagHours != null) {
      mult *= mc.lagHours <= 12 ? 0.6 : mc.lagHours <= 24 ? 0.8 : mc.lagHours >= 72 ? 1.1 : 1;
    }
    if (comp.score == null) {
      return { score: null, parts: parts, missing: missing, comp: comp, ageDays: ageDays, mult: mult, reason: "no-competition-data" };
    }
    if (!wsum) return { score: null, parts: parts, missing: missing, comp: comp, ageDays: ageDays, mult: mult };
    return {
      score: Math.round(clamp01((sum / wsum) * mult)),
      parts: parts, missing: missing, comp: comp, ageDays: ageDays, mult: mult,
      manual: mc ? { mult: Number(mult.toFixed(2)), note: mc.note || "" } : null,
    };
  }

  // 排序用：先按结论档位，再按分数。
  // 为什么不能只按分数：实测会出现"巨头级 67 分"排在"可小试 63 分"前面 ——
  // 分数高只是因为它内容面和口碑都不错，但它压根做不了，排前面会误导。
  var VERDICT_RANK = { yes: 0, warn: 1, unknown: 2, no: 3 };

  /**
   * 限时活动提示（只是提醒，不参与打分）。
   *
   * 为什么需要：评分不区分「持久需求」和「一次性活动」。
   * 实测案例 The Hunt: Roblox 20 —— 评分 80（值得做），但它 9/17–9/28 只有 12 天窗口，
   * 活动一结束需求就断崖归零，新站在 8 天内不可能有排名。光看分数会得出相反结论。
   * 这是启发式，会有误报 —— 所以只做黄色提示，不否决、不扣分。
   */
  var EVENT_HINT = /\b(the hunt|event|festival|anniversary|carnival|season \d|update \d)\b/i;
  function eventFlag(g) {
    if (!EVENT_HINT.test(String(g.name || ""))) return "";
    return "⚠️ 像是限时活动：先确认结束时间 —— 窗口太短的话新站来不及排上去（本评分不区分持久需求与一次性活动）";
  }

  /** 查竞争用的一次点击：SERP 里看这个游戏现在有几个独立域名占位 */
  function serpSearchUrl(name) {
    return "https://www.google.com/search?q=" + encodeURIComponent("\"" + name + "\" wiki tier list comps guide");
  }

  /** 结论档位。与 roblox-game-breakout-scanner 技能同一套口径，但**不再拿访问量当否决项**。 */
  function pickVerdict(g, r) {
    var st = g.stats || {};
    // 人工判断优先级最高：它是最具体的信息，且自动分看不到长尾垄断这件事
    var mc = manualComp(g.name);
    if (mc && mc.open != null && mc.open <= 2) {
      return { k: "no", t: "竞争饱和（人工判断）", why: mc.note || "长尾已被专用 wiki / 专业站占据" };
    }
    // 🛑 竞争测不到就不下结论 —— 但要给"怎么补"的动作（点「查竞争」看 SERP），
    //    而不是像旧版那样用访问量硬推断一个"巨头级"。
    if (r.comp.score == null) {
      return { k: "unknown", t: "竞争未测", why: "没有官方上线数据，也没填人工竞争判断 —— 点「查竞争」看 SERP 再决定" };
    }
    if (st.approval != null && st.approval < 60) return { k: "no", t: "口碑偏低", why: "好评 " + st.approval + "%，游戏本身在流失玩家" };
    if (!(g.words || []).length) return { k: "warn", t: "没挖到攻略词", why: "没有可做页面的词 —— 可能需求弱，也可能只是本轮还没挖到" };
    // 上线很久 → 长尾多半已固化：不否决，但降档（"上线时间长是负面因素"的兑现）
    if (r.ageDays != null && r.ageDays > 1460 && r.score >= 65) {
      return { k: "warn", t: "上线超 4 年", why: "长尾大概率已固化（新鲜度与竞争项已扣分），建议先做 1~2 页试水" };
    }
    if (r.score >= 65) return { k: "yes", t: "值得做", why: "需求够 + 竞争未饱和（竞争来源：" + (r.comp.source === "manual" ? "人工核查" : "上线时长推断") + "）" };
    if (r.score >= 45) return { k: "warn", t: "可小试", why: "有条件但不够硬，建议先做 1~2 页试水" };
    return { k: "no", t: "不建议", why: "" };
  }

  function pickRow(g) {
    var r = rankability(g);
    var v = pickVerdict(g, r);
    var evt = eventFlag(g);
    var st = g.stats || {};
    if (r.score > 100) r.score = 100;
    var bars = "";
    for (var k in PICK_W) {
      var val = r.parts[k];
      bars += '<div class="pk-bar" title="' + PICK_LABEL[k] + " · 权重 " + PICK_W[k] + '">' +
        '<span class="pk-name">' + PICK_LABEL[k] + "</span>" +
        '<span class="pk-track"><i style="width:' + (val == null ? 0 : Math.round(val)) + '%"></i></span>' +
        '<span class="pk-val">' + (val == null ? "—" : Math.round(val)) + "</span></div>";
    }
    var words = (g.words || []).map(function (w) {
      return '<a class="kwchip" target="_blank" rel="noopener" href="' + exploreUrl(w, g.chart_geo) + '">' + esc(w) + "</a>";
    }).join("");
    var age = r.ageDays == null ? "未取得" : (r.ageDays < 30 ? Math.round(r.ageDays) + " 天" : (r.ageDays / 365).toFixed(1) + " 年");
    var compSrc = { manual: "人工核查", age: "上线时长推断", unknown: "未测" }[r.comp.source] || "未测";
    return '<div class="gcard pk-card">' +
      '<div class="ghead"><h3>' + esc(g.name) + '</h3><span class="score pk-' + v.k + '">' +
      (r.score == null ? "—" : r.score) + "</span></div>" +
      '<div class="pk-verdict pk-' + v.k + '">' + v.t + (v.why ? " · " + esc(v.why) : "") + "</div>" +
      (evt ? '<div class="pk-verdict pk-flag">' + esc(evt) + "</div>" : "") +
      (r.manual ? '<div class="pk-verdict pk-flag">人工竞争：发稿滞后乘数 ×' + r.manual.mult +
        (r.manual.note ? " · " + esc(r.manual.note) : "") + "</div>" : "") +
      bars +
      '<div class="gmeta">需求 访问 ' + fmtVol(st.visits) + " · 好评 " +
      (st.approval == null ? "未取得" : st.approval + "%") + " · 上线 " +
      (st.created ? esc(String(st.created).slice(0, 10)) : "未取得") + "（" + age + "）</div>" +
      '<div class="gmeta">竞争来源 ' + esc(compSrc) + " · 攻略词 " + (g.words || []).length + " 个</div>" +
      '<div class="kwrow">' +
      (g.srcUrl ? '<a class="kwchip" target="_blank" rel="noopener" href="' + esc(g.srcUrl) + '">Roblox 页</a>' : "") +
      '<a class="kwchip up" target="_blank" rel="noopener" title="数一下前十有几个独立域名占位，就是竞争强度的实测" href="' + serpSearchUrl(g.name) + '">查竞争（SERP）</a>' +
      '<a class="kwchip" target="_blank" rel="noopener" href="' + exploreUrl(g.name, g.chart_geo) + '">Google Trends</a>' +
      "</div>" +
      (words ? '<div class="kwrow"><span class="kwlabel">可做的词</span>' + words + "</div>" : "") +
      (r.missing.length
        ? '<div class="gmeta pk-dim">缺项（未计入，不是 0）：' + r.missing.map(function (k) { return PICK_LABEL[k]; }).join(" · ") + "</div>"
        : "") +
      "</div>";
  }

  function renderPick() {
    var el = $("pick-cards");
    if (!games) { el.innerHTML = '<p class="empty">加载中…</p>'; return; }
    var all = (games.items || []).map(function (g) {
      var r = rankability(g);
      return { g: g, r: r, v: pickVerdict(g, r) };
    });
    var rows = all;
    if (state.pick === "todo") rows = all.filter(function (x) { return x.v.k === "yes"; });
    else if (state.pick === "nowords") rows = all.filter(function (x) { return !(x.g.words || []).length; });
    // 排序：
    //   verdict（默认）先按结论档位、同档按分数 —— 避免"可小试 63 分"被"不建议 67 分"压下去
    //   newest / oldest 按**上线日**（正是"新鲜度"项的输入）—— 想抢新游戏就用这个
    rows = rows.slice().sort(function (a, b) {
      if (state.pickSort === "newest" || state.pickSort === "oldest") {
        var va = a.r.ageDays, vb = b.r.ageDays;
        // 无上线数据的一律沉底（两个都是 null 也是一样）。
        // 🛑 不能拿 Infinity 当哨兵：Infinity - Infinity = NaN，比较函数返回 NaN 会让整个排序乱掉
        //    （实测踩过：选「最早上线」时，没有上线数据的 gta vi 反而排在第一）。
        if (va == null && vb == null) return 0;
        if (va == null) return 1;
        if (vb == null) return -1;
        return state.pickSort === "newest" ? va - vb : vb - va;
      }
      var ra = VERDICT_RANK[a.v.k], rb = VERDICT_RANK[b.v.k];
      if (ra !== rb) return ra - rb;
      return (b.r.score == null ? -1 : b.r.score) - (a.r.score == null ? -1 : a.r.score);
    });
    var shown = rows.slice(0, state.rowsShown);
    var yes = all.filter(function (x) { return x.v.k === "yes"; }).length;
    var judgeable = all.filter(function (x) { return x.r.score != null; }).length;
    $("pick-meta").textContent = "共 " + all.length + " 个 · 可评估 " + judgeable +
      " 个 · 值得做 " + yes + " 个 · 显示 " + shown.length;
    el.innerHTML = shown.map(function (x) { return pickRow(x.g); }).join("") ||
      '<p class="empty">没有符合条件的游戏</p>';
    if (rows.length > shown.length) {
      el.innerHTML += '<button class="more" id="pick-more">显示更多（共 ' + rows.length + " 个）</button>";
      $("pick-more").onclick = function () { state.rowsShown += 60; renderPick(); };
    }
  }

  // ══════════════════════════════════════════════════════════════════════
  // 🚀 潜伏列表（data/watchlist.json）
  //
  // 与「🎮 新游戏雷达」的分工：
  //   雷达      = 哪个游戏**在火**（要 Trends 曲线，吃配额、可能被限流）
  //   潜伏列表  = **还没火的时候该盯谁**（愿望单序位 / 发售日 / 未发售清单，零配额）
  //
  // 🛑 2026-09-21 用户反馈后改版（重要）：
  //    旧版是卡片流，按"窗口"分组 → 结果顶部全是「未定档 / TBA」的 Roblox 条目，
  //    **看不出哪个游戏最近发售**，等于没有信息量。
  //    现在改成**表格 + 默认按发售日从近到远排序**，「距今」单独成列（带颜色），
  //    未定档的默认折叠（无法按日期排序的东西不该占据版面）。
  //
  // 🛑 另一条约定不变：**每条必须给出可点链接**（商店页 / 来源页 / Trends / SERP / Discord）。
  //    trends.status 可能是 not-queried（省配额）或 429（被限流）——不显示曲线，但链接照给。
  //    绝不允许因为"没测到"就把条目藏起来。
  // ══════════════════════════════════════════════════════════════════════
  var WINDOW_LABEL = {
    build: "🟢 黄金窗口",
    close: "🟡 临门 ≤30 天",
    far: "⚪ 远期 / 未定档",
    "too-late": "🔴 已来不及 ≤7 天",
    live: "🔵 已上线",
  };
  var W_ORDER = { build: 0, close: 1, far: 2, "too-late": 3, live: 4 };
  var TRENDS_LABEL = {
    "not-queried": "未测",
    "429": "限流",
    empty: "无数据",
    error: "失败",
    ok: "已测",
  };
  var PRECISION_LABEL = { quarter: "季度", year: "仅年份", month: "仅月份", unknown: "未定档", day: "" };

  /** 距今文案（正数=还有几天，0/负=已到发售日） */
  function daysText(it) {
    if (it.releaseInDays == null) return "未定档";
    var d = it.releaseInDays;
    if (d < 0) return "已发售 " + Math.abs(d) + " 天";
    if (d === 0) return "就是今天";
    return d + " 天后";
  }

  /** 表格里的链接列：永远给全，测不到也不影响点击 */
  function watchLinks(it) {
    var L = it.links || {};
    var out = [];
    if (L.page) {
      var isRbx = String(L.page).indexOf("roblox.com") > 0;
      out.push('<a target="_blank" rel="noopener" href="' + esc(L.page) + '">' +
        (it.source === "roblox" ? (isRbx ? "Roblox 页" : "来源页") : "商店页") + "</a>");
    }
    if (L.source && L.source !== L.page) out.push('<a target="_blank" rel="noopener" href="' + esc(L.source) + '">BloxInformer</a>');
    if (L.trends) out.push('<a target="_blank" rel="noopener" href="' + esc(L.trends) + '">Trends</a>');
    if (L.serp) out.push('<a target="_blank" rel="noopener" href="' + esc(L.serp) + '">SERP</a>');
    if (L.discord) out.push('<a target="_blank" rel="noopener" href="' + esc(L.discord) + '">Discord</a>');
    return out.join(" · ");
  }

  var WATCH_SORTS = {
    // ⏱ 最近发售：有确切日期的按天数升序，未定档沉底（默认）
    date: function (a, b) {
      var da = a.releaseInDays == null ? 1e9 : a.releaseInDays;
      var db = b.releaseInDays == null ? 1e9 : b.releaseInDays;
      return da - db || (a.rank || 1e9) - (b.rank || 1e9);
    },
    // 🪟 窗口优先：黄金窗口最前
    window: function (a, b) {
      var wa = W_ORDER[a.window] == null ? 9 : W_ORDER[a.window];
      var wb = W_ORDER[b.window] == null ? 9 : W_ORDER[b.window];
      return wa - wb || WATCH_SORTS.date(a, b);
    },
    // 🔥 热度：Steam 愿望单序位（越小越热）；Roblox 无热度指标 → 按已有在线人数
    heat: function (a, b) {
      var ha = a.source === "steam" && a.rank ? a.rank : 1e6 - (a.players || 0);
      var hb = b.source === "steam" && b.rank ? b.rank : 1e6 - (b.players || 0);
      return ha - hb;
    },
    name: function (a, b) { return String(a.name).localeCompare(String(b.name)); },
  };

  function watchMatch(it) {
    if (state.watchSrc !== "all" && it.source !== state.watchSrc) return false;
    if (state.watchQ && String(it.name).toLowerCase().indexOf(state.watchQ) < 0) return false;
    // 未定档默认折叠：它们无法按日期排序，堆在最前面只会淹掉有日期的条目
    if (!state.watchTba && it.releaseInDays == null) return false;
    return true;
  }

  function watchRowHtml(it, i) {
    var bits = [];
    if ((it.genres || []).length) bits.push(esc(it.genres.slice(0, 3).join(" / ")));
    if (it.developer) bits.push(esc(it.developer));
    if (it.price) bits.push(esc(it.price));
    if (it.source === "steam") bits.push(it.demo ? "有 Demo" : "无 Demo");
    if (it.status) bits.push(esc(it.status));
    var src = it.source === "roblox"
      ? "Roblox · " + esc(it.list || "BloxInformer") + (it.snapshotAt ? "（快照 " + String(it.snapshotAt).slice(0, 10) + "）" : "")
      : "Steam" + (it.list ? " · " + esc(it.list) : "") + (it.rank ? " 愿望单#" + it.rank : "");
    var pr = PRECISION_LABEL[it.releasePrecision] || "";
    return "<tr>" +
      '<td class="num dim">' + (i + 1) + "</td>" +
      "<td><b>" + esc(it.name) + "</b>" + (bits.length ? '<div class="sub">' + bits.join(" · ") + "</div>" : "") + "</td>" +
      '<td class="dim hide-sm">' + src + "</td>" +
      "<td>" + esc(it.released || "—") + (pr ? ' <span class="tag">' + pr + "</span>" : "") + "</td>" +
      '<td class="num ' + (it.window === "build" ? "up" : it.window === "close" ? "hot" : "dim") + '">' + daysText(it) + "</td>" +
      '<td><span class="tag">' + (WINDOW_LABEL[it.window] || esc(it.window || "—")) + "</span></td>" +
      '<td class="dim hide-sm">' + (TRENDS_LABEL[(it.trends || {}).status] || "未测") + "</td>" +
      '<td class="dim">' + watchLinks(it) + "</td>" +
      "</tr>";
  }

  function renderWatch() {
    var el = $("watch-table");
    if (!el) return;
    if (!watch) { el.innerHTML = '<p class="empty">加载中…（若长期为空：先跑一次 <code>npm run watchlist</code>）</p>'; return; }
    var all = watch.items || [];
    var dated = all.filter(function (x) { return x.releaseInDays != null; });
    var rows = all.filter(watchMatch).slice().sort(WATCH_SORTS[state.watchSort] || WATCH_SORTS.date);
    var st = watch.stats || {};
    var meta = $("watch-meta");
    if (meta) {
      meta.textContent = "共 " + all.length + " 条（Steam " + (st.steam || 0) + " / Roblox " + (st.roblox || 0) +
        "）· 有发售日 " + dated.length + " · 未定档 " + (all.length - dated.length) +
        (state.watchTba ? "（已展开）" : "（已折叠）") + " · 显示 " + rows.length;
    }
    var notes = $("watch-notes");
    if (notes) {
      notes.innerHTML = (watch.notes || []).map(function (n) {
        return '<div class="wk-note">' + esc(n) + "</div>";
      }).join("");
    }
    if (!rows.length) { el.innerHTML = '<p class="empty">该筛选下暂无候选（换来源，或点「显示未定档」）</p>'; return; }
    el.innerHTML = '<div class="table-wrap"><table><thead><tr>' +
      '<th class="num">#</th><th>游戏</th><th class="hide-sm">来源</th><th>发售日</th>' +
      '<th class="num">距今</th><th>窗口</th><th class="hide-sm">需求</th><th>链接</th>' +
      "</tr></thead><tbody>" + rows.map(watchRowHtml).join("") + "</tbody></table></div>";
  }

  // ── 关键词池 ──
  function renderPool() {
    var el = $("pool-table");
    if (!pool) { el.innerHTML = '<p class="empty">加载中…</p>'; return; }
    var q = state.poolQ;
    var items = (pool.items || []).filter(function (x) {
      if (state.noise && x.noise) return false;
      if (state.watch && !(x.watch && x.watch.length)) return false;
      if (q && x.q.toLowerCase().indexOf(q) < 0) return false;
      return true;
    });
    $("pool-meta").textContent = "共 " + items.length + " 个词（词池总量 " + (pool.total || 0) + "）";
    el.innerHTML = '<div class="table-wrap"><table><thead><tr>' +
      '<th class="num">#</th><th>词</th><th>类型</th><th class="num">被带出次数</th><th class="hide-sm">来自哪些热搜</th><th class="num">搜索量</th><th>地区</th>' +
      "</tr></thead><tbody>" +
      items.slice(0, state.rowsShown).map(function (x, i) {
        return "<tr><td class=\"num dim\">" + (i + 1) + "</td>" +
          "<td>" + (x.watch && x.watch.length ? "★ " : "") + esc(x.q) + "</td>" +
          '<td class="dim">' +
            (x.kind === "trending" ? "热搜词" : x.kind === "game" ? "🎮 攻略词" : "相关词") + "</td>" +
          '<td class="num">' + (x.count || 0) + "</td>" +
          '<td class="dim hide-sm">' + esc((x.parents || []).slice(0, 3).join(", ") || "—") + "</td>" +
          '<td class="num">' + fmtVol(x.vol) + "</td>" +
          '<td class="dim">' + esc((x.geo || []).slice(0, 4).join(" ")) + "</td></tr>";
      }).join("") + "</tbody></table></div>" +
      (items.length > state.rowsShown ? '<button class="more" id="pool-more">显示更多（共 ' + items.length + " 条）</button>" : "");
  }

  // ── CSV ──
  function downloadCsv(name, rows, cols) {
    var e = function (v) {
      var s = v == null ? "" : String(v);
      return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    };
    var body = [cols.join(",")].concat(rows.map(function (r) { return cols.map(function (c) { return e(r[c]); }).join(","); })).join("\n");
    var blob = new Blob(["\uFEFF" + body], { type: "text/csv;charset=utf-8" });
    var a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = name;
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 3000);
  }

  function currentHotRows() {
    if (!trends) return [];
    var out = [];
    Object.keys(trends.items).forEach(function (g) {
      if (state.geo !== "ALL" && g !== state.geo) return;
      trends.items[g].forEach(function (r) {
        if (pass(r, r.vol, r.growth)) {
          out.push({ q: r.q, geo: g, vol: r.vol, growth: r.growth, cats: (r.cats || []).join("|"), noise: r.noise || "", watch: (r.watch || []).join("|"), is_new: r.new ? 1 : 0 });
        }
      });
    });
    return out;
  }

  // ── 切换 ──
  function switchTab(tab) {
    state.tab = tab;
    state.rowsShown = 200;
    $("panel-hot").hidden = tab !== "hot";
    $("panel-hist").hidden = tab !== "hist";
    $("panel-pick").hidden = tab !== "pick";
    $("panel-watch").hidden = tab !== "watch";
    $("panel-games").hidden = tab !== "games";
    $("panel-pool").hidden = tab !== "pool";
    // 顶部那排筛选（地区/分类/搜索）只服务"实时热词 / 7天留档"
    $("filters").hidden = tab === "games" || tab === "pool" || tab === "pick" || tab === "watch";
    if (tab === "hot") renderHot();
    if (tab === "hist") renderHist();
    if (tab === "pick") renderPick();
    if (tab === "watch") renderWatch();
    if (tab === "games") renderGames();
    if (tab === "pool") renderPool();
  }

  // ── 事件 ──
  $("tabs").addEventListener("click", function (ev) {
    var b = ev.target.closest("button[data-tab]");
    if (!b) return;
    Array.prototype.forEach.call(document.querySelectorAll("#tabs button"), function (x) { x.classList.toggle("on", x === b); });
    switchTab(b.dataset.tab);
  });

  function bindBar(id, attr, setter) {
    $(id).addEventListener("click", function (ev) {
      var b = ev.target.closest("button[data-" + attr + "]");
      if (!b) return;
      setter(b.dataset[attr]);
      Array.prototype.forEach.call($(id).querySelectorAll("button"), function (x) { x.classList.toggle("on", x === b); });
      if (state.tab === "hot") renderHot();
      else if (state.tab === "hist") renderHist();
      else if (state.tab === "pick") renderPick();
      else if (state.tab === "games") renderGames();
      else if (state.tab === "pool") renderPool();
    });
  }
  bindBar("geo-bar", "geo", function (v) { state.geo = v; });
  bindBar("cat-bar", "cat", function (v) { state.cat = v; });
  bindBar("vol-bar", "vol", function (v) { state.vol = Number(v); });
  bindBar("growth-bar", "growth", function (v) { state.growth = Number(v); });
  bindBar("pick-sort", "psort", function (v) { state.pickSort = v; });

  $("noise-btn").addEventListener("click", function () {
    state.noise = !state.noise;
    this.classList.toggle("on", state.noise);
    if (state.tab === "pool") renderPool(); else if (state.tab === "hot") renderHot(); else renderHist();
  });
  $("watch-btn").addEventListener("click", function () {
    state.watch = !state.watch;
    this.classList.toggle("on", state.watch);
    if (state.tab === "pool") renderPool(); else if (state.tab === "hot") renderHot(); else renderHist();
  });
  var debounce = function (fn, ms) {
    var t;
    return function () { clearTimeout(t); t = setTimeout(fn, ms); };
  };
  $("search").addEventListener("input", debounce(function (e) {
    state.q = e.target.value.trim().toLowerCase();
    renderHot();
  }, 180));
  $("pool-search").addEventListener("input", debounce(function (e) {
    state.poolQ = e.target.value.trim().toLowerCase();
    renderPool();
  }, 180));
  $("csv-btn").addEventListener("click", function () {
    downloadCsv("hot-keywords.csv", currentHotRows(), ["q", "geo", "vol", "growth", "cats", "noise", "watch", "is_new"]);
  });
  $("game-sort").addEventListener("click", function (ev) {
    var b = ev.target.closest("button[data-sort]");
    if (!b) return;
    state.gameSort = b.dataset.sort;
    state.rowsShown = 200;
    Array.prototype.forEach.call(this.querySelectorAll("button"), function (x) { x.classList.toggle("on", x === b); });
    renderGames();
  });
  // 🚀 潜伏列表：排序 / 来源两个单选组 + 未定档开关
  function bindWatchGroup(id, attr, key) {
    $(id).addEventListener("click", function (ev) {
      var b = ev.target.closest("button[data-" + attr + "]");
      if (!b) return;
      state[key] = b.dataset[attr];
      Array.prototype.forEach.call(this.querySelectorAll("button"), function (x) { x.classList.toggle("on", x === b); });
      renderWatch();
    });
  }
  bindWatchGroup("watch-sort", "wsort", "watchSort");
  bindWatchGroup("watch-src", "src", "watchSrc");
  $("watch-search").addEventListener("input", debounce(function (e) {
    state.watchQ = e.target.value.trim().toLowerCase();
    renderWatch();
  }, 180));
  $("watch-tba").addEventListener("click", function () {
    state.watchTba = !state.watchTba;
    this.classList.toggle("on", state.watchTba);
    renderWatch();
  });
  $("watch-csv").addEventListener("click", function () {
    if (!watch) return;
    // CSV 导出**不受"未定档折叠"影响**：导出要全（折叠只是看板上的降噪）
    var csvRows = (watch.items || []).filter(function (it) {
      if (state.watchSrc !== "all" && it.source !== state.watchSrc) return false;
      if (state.watchQ && String(it.name).toLowerCase().indexOf(state.watchQ) < 0) return false;
      return true;
    }).sort(WATCH_SORTS[state.watchSort] || WATCH_SORTS.date);
    downloadCsv("watchlist.csv", csvRows.map(function (it) {
      var L = it.links || {};
      return {
        name: it.name, source: it.source, list: it.list || "", rank: it.rank || "",
        window: it.window || "", released: it.released || "", releaseInDays: it.releaseInDays == null ? "" : it.releaseInDays,
        releasePrecision: it.releasePrecision || "", players: it.players || "",
        genres: (it.genres || []).join("|"), developer: it.developer || "", price: it.price || "", demo: it.demo ? 1 : 0,
        trendsStatus: (it.trends && it.trends.status) || "",
        store: L.page || "", trends: L.trends || "", serp: L.serp || "",
      };
    }), ["name", "source", "list", "rank", "window", "released", "releaseInDays", "releasePrecision",
        "players", "genres", "developer", "price", "demo", "trendsStatus", "store", "trends", "serp"]);
  });
  $("pool-csv").addEventListener("click", function () {
    if (!pool) return;
    downloadCsv("keyword-pool.csv", (pool.items || []).map(function (x) {
      return { q: x.q, kind: x.kind, count: x.count, vol: x.vol, growth: x.growth, geo: (x.geo || []).join("|"), parents: (x.parents || []).join("|"), watch: (x.watch || []).join("|") };
    }), ["q", "kind", "count", "vol", "growth", "geo", "parents", "watch"]);
  });

  document.addEventListener("click", function (ev) {
    var t = ev.target;
    if (t && t.id === "hot-more") { state.rowsShown += 500; renderHot(); return; }
    if (t && t.id === "hist-more") { state.rowsShown += 500; renderHist(); return; }
    if (t && t.id === "pool-more") { state.rowsShown += 500; renderPool(); return; }
    var tr = t && t.closest && t.closest("tr.row");
    if (tr && !t.closest("a")) toggleDetail(tr);
  });

  // ── 启动 ──
  fetchJson("data/trends.json").then(function (d) {
    trends = d;
    CATS = d.cats || {};
    GEOS = d.geos || Object.keys(d.items || {});
    COMPARE = d.compareWith || "";
    if (d.defaultGeo) DEFAULT_GEO = String(d.defaultGeo).toUpperCase();
    // config.json 会跟产物一起发布，优先用它（改配置 push 即生效，不必等下一轮采集）
    fetchJson("data/config.json").then(applyTrendsConfig).catch(function () {});
    $("updated").textContent = "更新于 " + rel(d.updated);
    buildBars();
    renderHot();
  }).catch(function () {
    $("hot-table").innerHTML = '<p class="empty">还没有数据，先在终端跑一次：<code>npm run collect</code></p>';
  });
  fetchJson("data/games.json").then(function (d) {
    games = d;
    if (state.tab === "games") renderGames();
    if (state.tab === "pick") renderPick();
  }).catch(function () {});
  // 潜伏列表：独立文件（data/watchlist.json），零 Trends 配额，随每小时采集一起刷新
  fetchJson("data/watchlist.json").then(function (d) {
    watch = d;
    if (state.tab === "watch") renderWatch();
  }).catch(function () {});
  // 词池用于行内"相关词"展开，后台静默加载
  fetchJson("data/keywords.json").then(function (d) {
    pool = d;
    poolIndex = {};
    (d.items || []).forEach(function (x) {
      if (x.kind !== "related") return;
      (x.parents || []).forEach(function (p) {
        var k = String(p).toLowerCase();
        (poolIndex[k] = poolIndex[k] || []).push({ q: x.q, count: x.count || 0 });
      });
    });
    Object.keys(poolIndex).forEach(function (k) {
      poolIndex[k].sort(function (a, b) { return b.count - a.count; });
      poolIndex[k] = poolIndex[k].slice(0, 30);
    });
    renderHot();
  }).catch(function () {});
})();
