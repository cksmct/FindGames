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
    noise: false, watch: false, q: "", rowsShown: 200, poolQ: "",
  };
  var trends = null, history = null, games = null, pool = null, poolIndex = null;
  var CATS = {}, GEOS = [];

  function catNames(ids) {
    return (ids || []).map(function (c) { return CATS[c]; }).filter(Boolean).slice(0, 2).join(" · ");
  }
  function trendsLink(q, g) {
    return "https://trends.google.com/trends/explore?date=now%207-d&q=" +
      encodeURIComponent(q) + (g && g !== "ALL" ? "&geo=" + g : "");
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
  function renderGames() {
    var el = $("game-cards");
    if (!games) { el.innerHTML = '<p class="empty">加载中…</p>'; return; }
    var items = (games.items || []).slice(0, state.rowsShown);
    el.innerHTML = items.map(function (g) {
      var age = (Date.now() - new Date(g.first).getTime()) / 864e5;
      var chart = (g.series || []).length > 1
        ? sparkSvg(g.series, "#7a5cf0") +
          '<div class="gmeta">📷 快照于 ' + String(g.chart_at || g.first).slice(0, 10) + " · 之后的走势见「查看趋势」</div>"
        : '<div class="nochart">' + (age < 7 ? "曲线采集中…" : "暂无曲线") + "</div>";
      var times = "首次发现 " + rel(g.first) + (g.last !== g.first ? " · 最新信号 " + rel(g.last) : "") +
        ((g.sightings || 1) > 1 ? " · 上榜 ×" + g.sightings : "");
      return '<div class="gcard"><div class="ghead"><h3>' + esc(g.name) + "</h3>" +
        '<span class="score">score ' + (g.score || 0) + "</span></div>" +
        '<div class="gmeta">' + times + (g.reason ? " · " + esc(g.reason) : "") +
        (g.chart_geo ? " · 曲线地区 " + esc(g.chart_geo) : "") + "</div>" +
        chart +
        '<div class="gmeta"><a href="https://trends.google.com/trends/explore?date=now%207-d&q=' +
        encodeURIComponent(g.name) + '" target="_blank" rel="noopener">查看趋势 →</a></div></div>';
    }).join("") || '<p class="empty">还没发现新游戏，多跑几轮采集</p>';
    if ((games.items || []).length > state.rowsShown) {
      el.innerHTML += '<button class="more" id="games-more">显示更多</button>';
      $("games-more").onclick = function () { state.rowsShown += 60; renderGames(); };
    }
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
          '<td class="dim">' + (x.kind === "trending" ? "热搜词" : "相关词") + "</td>" +
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
    $("panel-games").hidden = tab !== "games";
    $("panel-pool").hidden = tab !== "pool";
    $("filters").hidden = tab === "games" || tab === "pool";
    if (tab === "hot") renderHot();
    if (tab === "hist") renderHist();
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
      if (state.tab === "hot") renderHot(); else renderHist();
    });
  }
  bindBar("geo-bar", "geo", function (v) { state.geo = v; });
  bindBar("cat-bar", "cat", function (v) { state.cat = v; });
  bindBar("vol-bar", "vol", function (v) { state.vol = Number(v); });
  bindBar("growth-bar", "growth", function (v) { state.growth = Number(v); });

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
    $("updated").textContent = "更新于 " + rel(d.updated);
    buildBars();
    renderHot();
  }).catch(function () {
    $("hot-table").innerHTML = '<p class="empty">还没有数据，先在终端跑一次：<code>npm run collect</code></p>';
  });
  fetchJson("data/games.json").then(function (d) { games = d; if (state.tab === "games") renderGames(); }).catch(function () {});
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
