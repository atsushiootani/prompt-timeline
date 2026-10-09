/* prompt-timeline - the timeline view itself
 *
 * PromptTimeline.mount(el, data, opts)
 *   el   ... element to draw into
 *   data ... JSON produced by the collector (date / summary / human_prompts / slash_commands / agents)
 *   opts ... { showSlash: true }
 *
 * Time runs down, sessions run across. A circle is a prompt you typed,
 * a diamond is a slash command. Plain DOM, no dependencies.
 */
(function (global) {
  "use strict";

  // Used when the config does not name a colour. Eight slots, validated for colour-blind
  // separation in this order; the light and dark steps live in timeline.css as --pt-s1..8.
  // The hexes here are the light steps, only so a config colour can be matched against them.
  var SLOTS = ["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4", "#008300", "#4a3aa7", "#e34948"];

  var GUTTER  = 32,   // width of the time labels
      COLW_MIN = 62,  // narrowest a session column gets
      COLW_MAX = 230, // widest, so a couple of sessions don't sprawl
      HEAD    = 52,   // height of the column headers (grows when a total is shown)
      PAD     = 14,   // breathing room at the top and bottom of the plot
      HOURPX  = 96;   // pixels per hour. Busy spans are read as length, so they need the room.

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c];
    });
  }

  function toMinutes(hhmmss) {
    var p = String(hhmmss).split(":").map(Number);
    return (p[0] || 0) * 60 + (p[1] || 0) + (p[2] || 0) / 60;
  }

  // 表示できる指標。cost は API 換算、tokens は transcript にある生の数。
  var METRICS = {
    cost:   { label: "cost",   of: function (r) { return r.cost || 0; },
              fmt: function (v) { return v >= 10 ? "$" + v.toFixed(0) : "$" + v.toFixed(2); } },
    tokens: { label: "tokens", of: function (r) { return r.tokens || 0; },
              fmt: function (v) {
                if (v >= 1e6) return (v / 1e6).toFixed(v >= 1e7 ? 0 : 1) + "M";
                if (v >= 1e3) return Math.round(v / 1e3) + "k";
                return String(Math.round(v));
              } },
  };

  function mmss(ms) {
    var s = Math.round((ms || 0) / 1000);
    if (s < 60) return s + "s";
    var m = Math.floor(s / 60);
    if (m < 60) return m + "m " + (s % 60) + "s";
    return Math.floor(m / 60) + "h " + (m % 60) + "m";
  }

  function el(tag, cls, parent) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (parent) parent.appendChild(n);
    return n;
  }

  /* セッション名 "<workspace>.<agent>" を分解する。
     agent 名自体にドットが入ることがある（例 "db.tasks.foo"）ので、
     collect.py が付けた workspace / agent があればそちらを信じる。 */
  function splitSession(row) {
    if (row && row.workspace != null && row.agent != null) {
      return { ws: row.workspace, name: row.agent };
    }
    var s = String((row && row.session) || "");
    var i = s.indexOf(".");
    return i > 0 ? { ws: s.slice(0, i), name: s.slice(i + 1) } : { ws: "", name: s };
  }

  function buildColumns(rows, agents, metric) {
    var index = {}, cols = [];
    rows.forEach(function (r) {
      var key = r.session || "?";
      if (!(key in index)) {
        var parts = splitSession(r);
        index[key] = cols.length;
        cols.push({ key: key, ws: parts.ws, name: parts.name, n: 0, slash: 0, total: 0,
                    cost: 0, tokens: 0, busy: 0,
                    color: (agents && agents[parts.name] && agents[parts.name].color) || null });
      }
      var c = cols[index[key]];
      if (r.kind === "slash") c.slash++; else c.n++;
      if (metric) c.total += metric.of(r);
      c.cost += r.cost || 0;
      c.tokens += r.tokens || 0;
      c.busy += r.busyMs || 0;
    });
    // 指標を選んでいるときは、食っている順に左から並べる。答えが一番左に来る。
    // 選んでいなければ従来どおり ワークスペース → 件数 → 名前。
    cols.sort(metric
      ? function (a, b) { return b.total - a.total || String(a.name).localeCompare(String(b.name)); }
      : function (a, b) {
          return String(a.ws).localeCompare(String(b.ws)) ||
                 (b.n + b.slash) - (a.n + a.slash) ||
                 String(a.name).localeCompare(String(b.name));
        });
    cols.forEach(function (c, i) { index[c.key] = i; });
    return { cols: cols, index: index };
  }

  /* 色はセッションに付け、並び順には付けない。cost/tokens を切り替えて列が入れ替わっても
     同じセッションは同じ色のまま。順番は「その日に初めて現れた順」で固定する。
     設定ファイルが使っている色の枠は飛ばすので、2 つのセッションが同じ色になることはない。 */
  function assignColors(cols, firstSeen) {
    var taken = {};
    cols.forEach(function (c) { if (c.color) taken[String(c.color).toLowerCase()] = true; });
    var free = [];
    SLOTS.forEach(function (hex, i) { if (!taken[hex]) free.push("var(--pt-s" + (i + 1) + ")"); });
    var order = cols.filter(function (c) { return !c.color; })
      .sort(function (a, b) { return firstSeen[a.key].localeCompare(firstSeen[b.key]) || a.key.localeCompare(b.key); });
    order.forEach(function (c, i) {
      // 9 本目以降は色を作らない。灰色に落として、見出しの名前で区別させる。
      c.color = i < free.length ? free[i] : "var(--pt-other)";
    });
  }

  function tipNode() {
    var t = document.getElementById("ptTip");
    if (!t) { t = el("div", "pt-tip"); t.id = "ptTip"; document.body.appendChild(t); }
    return t;
  }

  function mount(host, data, opts) {
    opts = opts || {};
    host.innerHTML = "";
    data = data || {};
    var agents = data.agents || {};
    var showSlash = opts.showSlash !== false;
    var metric = METRICS[opts.metric] || null;

    // 人が打った分とスラッシュコマンドを 1 本の列にまとめる
    var rows = (data.human_prompts || []).map(function (r) {
      return Object.assign({}, r, { kind: "human" });
    });
    if (showSlash) {
      rows = rows.concat((data.slash_commands || []).map(function (r) {
        return Object.assign({}, r, { kind: "slash", text: r.command });
      }));
    }
    rows.sort(function (a, b) { return String(a.time).localeCompare(String(b.time)); });

    if (!rows.length) {
      var empty = el("div", "pt-empty", host);
      // 絵は --pt-mascot から引く。data URI はページに 1 つしか載せない。
      if (getComputedStyle(document.documentElement).getPropertyValue("--pt-mascot").trim()) {
        el("div", "pt-empty-mascot", empty);
      }
      el("div", null, empty).textContent =
        "No prompts recorded for " + (data.date || "this day") + ".";
      return;
    }

    var built = buildColumns(rows, agents, metric), cols = built.cols, colOf = built.index;
    var firstSeen = {};
    rows.forEach(function (r) { var k = r.session || "?"; if (!(k in firstSeen)) firstSeen[k] = r.time; });
    assignColors(cols, firstSeen);
    var head = metric ? HEAD + 12 : HEAD;   // 合計の行が 1 本増えるぶん

    // 点の大きさは指標の平方根に比例させる。面積が値に比例して見えるのはこちら。
    var peak = 0;
    if (metric) rows.forEach(function (r) { peak = Math.max(peak, metric.of(r)); });
    function radiusOf(r) {
      if (!metric || !peak) return null;
      return 5 + Math.sqrt(metric.of(r) / peak) * 13;
    }

    // 時間の範囲は 1 時間単位に丸める（最低 1 時間幅）。
    // 最後のプロンプトの後もエージェントが動き続けることがあるので、その終わりまで含める。
    var mins = [];
    rows.forEach(function (r) {
      mins.push(toMinutes(r.time));
      (r.spans || []).forEach(function (sp) { mins.push(toMinutes(sp[1])); });
    });
    var lo = Math.floor(Math.min.apply(null, mins) / 60) * 60;
    var hi = Math.ceil(Math.max.apply(null, mins) / 60) * 60;
    if (hi - lo < 60) hi = lo + 60;

    var plotH = Math.max(240, (hi - lo) / 60 * HOURPX);

    // 左にセッションの順位表、右にタイムライン。表は凡例を兼ねる。
    var grid = el("div", "pt-grid", host);
    var side = el("aside", "pt-side", grid);
    var main = el("div", "pt-main", grid);

    // Spread the columns across whatever width we were given, within reason.
    var avail = Math.max(0, (main.clientWidth || host.clientWidth || 0) - 30);
    var COLW = Math.max(COLW_MIN, Math.min(COLW_MAX,
                 cols.length ? Math.floor((avail - GUTTER) / cols.length) : COLW_MIN));
    var width = GUTTER + cols.length * COLW;
    var yOf = function (m) { return head + PAD + (m - lo) / (hi - lo) * (plotH - 2 * PAD); };

    var panel = el("div", "pt-panel", main);
    var scroll = el("div", "pt-scroll", panel);
    var plot = el("div", "pt-plot", scroll);
    plot.style.width = width + "px";
    plot.style.height = (head + plotH) + "px";

    // 1 時間ごとの横罫線
    for (var m = lo; m <= hi; m += 60) {
      var g = el("div", "pt-gridline", plot);
      g.style.top = yOf(m) + "px";
      var lab = el("div", "pt-time", g);
      lab.innerHTML = String(Math.floor(m / 60) % 24).padStart(2, "0") + "<br>00";
    }

    var hidden = {};   // セッション名 → 非表示か（凡例・見出しクリックで切り替える）
    var dots = [];
    var bars = [];     // ビジー線。点と一緒に隠す

    // セッションの列（縦線＋見出し）
    cols.forEach(function (c, i) {
      var x = GUTTER + i * COLW;
      var lane = el("div", "pt-lane", plot);
      lane.style.left = (x + COLW / 2) + "px";
      lane.style.top = head + "px";

      // `head` は外側の見出しの高さ。ここで同名の var を切ると巻き上げで undefined に化ける。
      var hd = el("div", "pt-colhead", plot);
      hd.style.left = x + "px";
      hd.style.width = COLW + "px";
      hd.title = c.key + " - " + c.n + " prompts" + (c.slash ? ", " + c.slash + " commands" : "") +
        (metric ? " - " + metric.fmt(c.total) + " " + metric.label : "");
      el("div", "pt-ws", hd).textContent = c.ws || "";
      el("div", "pt-nm", hd).textContent = c.name;
      el("div", "pt-bar", hd).style.background = c.color;
      // 数字は文字色で書く。色は隣のバーが受け持つ。
      if (metric) el("div", "pt-total", hd).textContent = metric.fmt(c.total);
      hd.addEventListener("click", function () { toggle(c.key); });
      c.headNode = hd;
    });

    // ビジー線。エージェントが応答を抱えていた時間を、そのセッションの色で縦に引く。
    // 点より先に描いて下に敷く。線が詰まっている列ほど、その日ずっと回していたセッション。
    rows.forEach(function (r) {
      var spans = r.spans || [];
      if (!spans.length) return;
      var i = colOf[r.session || "?"];
      var c = cols[i];
      if (c == null) return;
      spans.forEach(function (sp) {
        var top = yOf(toMinutes(sp[0]));
        var bar = el("div", "pt-busy", plot);
        bar.style.left = (GUTTER + i * COLW + COLW / 2) + "px";
        bar.style.top = top + "px";
        // 数秒のスパンは 62px/時 だと消えてしまうので、最低 2px は見せる。
        bar.style.height = Math.max(2, yOf(toMinutes(sp[1])) - top) + "px";
        bar.style.background = c.color;
        bar.title = sp[0] + " - " + sp[1] + " (" + mmss(r.busyMs) + " busy)";
        bars.push({ node: bar, session: r.session || "?" });
      });
    });

    // 点（プロンプト 1 通 = 1 点）
    var tip = tipNode();
    rows.forEach(function (r) {
      var i = colOf[r.session || "?"], c = cols[i];
      if (c == null) return;
      var d = el("div", "pt-dot" + (r.kind === "slash" ? " slash" : ""), plot);
      d.style.left = (GUTTER + i * COLW + COLW / 2) + "px";
      d.style.top = yOf(toMinutes(r.time)) + "px";
      d.style.background = c.color;
      d.dataset.session = r.session || "?";
      var radius = radiusOf(r);
      if (radius != null) { d.style.width = radius + "px"; d.style.height = radius + "px"; }

      d.addEventListener("mouseenter", function () {
        tip.innerHTML = '<div class="pt-tip-head">' + esc(r.time) + " ・ " + esc(r.session || "") +
          (r.kind === "slash" ? " - command" : "") +
          (r.busyMs ? ' ・ <span class="pt-busy-tag">' + esc(mmss(r.busyMs)) + " busy</span>" : "") +
          // 金額とトークンは常に並べる。価格表が古びてもトークン数は事実として残る。
          (r.cost ? ' ・ <span class="pt-busy-tag">' + esc(METRICS.cost.fmt(r.cost)) +
                    " / " + esc(METRICS.tokens.fmt(r.tokens || 0)) + "</span>" : "") +
          "</div>" + esc(r.text || "");
        tip.classList.add("show");
        var box = d.getBoundingClientRect();
        tip.style.left = "0px"; tip.style.top = "0px";        // いったん置いて実寸を測る
        var tw = tip.offsetWidth, th = tip.offsetHeight;
        var tx = box.right + 10;
        if (tx + tw > innerWidth - 8) tx = box.left - tw - 10;
        if (tx < 8) tx = 8;
        var ty = Math.min(Math.max(8, box.top - 4), innerHeight - th - 8);
        tip.style.left = tx + "px"; tip.style.top = ty + "px";
      });
      d.addEventListener("mouseleave", function () { tip.classList.remove("show"); });
      d.addEventListener("click", function () {
        dots.forEach(function (o) { o.node.classList.remove("active"); });
        d.classList.add("active");
        showDetail(r, c);
      });
      dots.push({ node: d, session: r.session || "?" });
    });

    // 指標の切り替え。点の大きさ・列の並び・順位表がまとめて変わる。
    var boardHead = el("div", "pt-board-head", side);
    el("div", "pt-board-title", boardHead).textContent =
      metric ? "Where the " + (metric.label === "cost" ? "money" : "tokens") + " went" : "Where the prompts went";
    if (opts.onMetric) {
      var picker = el("div", "pt-metrics", boardHead);
      [["none", "prompts"], ["cost", "cost"], ["tokens", "tokens"]].forEach(function (pair) {
        var b = el("button", opts.metric === pair[0] || (!metric && pair[0] === "none") ? "on" : null, picker);
        b.type = "button";
        b.textContent = pair[1];
        b.addEventListener("click", function () { opts.onMetric(pair[0]); });
      });
    }

    // 順位表。各セッションの件数・稼働・金額・トークンを並べて比べられる（表としても読める）。
    // 押すとそのセッションを隠す / 戻す。並びはタイムラインの列と同じ。
    var valueOf = function (c) { return metric ? c.total : c.n + c.slash; };
    var fmtOf = function (v) { return metric ? metric.fmt(v) : String(v); };
    var top = Math.max.apply(null, cols.map(valueOf).concat([0]));
    var sum = cols.reduce(function (a, c) { return a + valueOf(c); }, 0);
    var board = el("ol", "pt-board", side);
    cols.forEach(function (c, rank) {
      var li = el("li", "pt-row", board);
      li.tabIndex = 0;
      li.title = "Click to hide or show " + c.key;
      var line = el("div", "pt-row-top", li);
      el("span", "pt-rank", line).textContent = String(rank + 1);
      el("span", "pt-swatch", line).style.background = c.color;
      var who = el("span", "pt-row-name", line);
      el("b", null, who).textContent = c.name;
      if (c.ws) el("small", null, who).textContent = c.ws;
      var val = el("span", "pt-row-val", line);
      val.textContent = fmtOf(valueOf(c));
      if (sum) el("small", null, val).textContent = Math.round(valueOf(c) / sum * 100) + "%";
      var track = el("div", "pt-track", li);
      var fill = el("div", "pt-fill", track);
      fill.style.width = (top ? valueOf(c) / top * 100 : 0) + "%";
      fill.style.background = c.color;
      el("div", "pt-row-sub", li).textContent =
        (c.n + c.slash) + " prompts" +
        (c.busy ? " · " + mmss(c.busy) + " busy" : "") +
        // 上の行に出している指標は繰り返さない。
        (c.cost && opts.metric !== "cost" ? " · " + METRICS.cost.fmt(c.cost) : "") +
        (c.tokens && opts.metric !== "tokens" ? " · " + METRICS.tokens.fmt(c.tokens) + " tok" : "");
      var flip = function () { toggle(c.key); };
      li.addEventListener("click", flip);
      li.addEventListener("keydown", function (e) { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); flip(); } });
      c.legendNode = li;
    });

    function toggle(key) {
      hidden[key] = !hidden[key];
      dots.forEach(function (o) { o.node.classList.toggle("hidden", !!hidden[o.session]); });
      bars.forEach(function (o) { o.node.classList.toggle("hidden", !!hidden[o.session]); });
      cols.forEach(function (c) {
        if (c.legendNode) c.legendNode.classList.toggle("muted", !!hidden[c.key]);
        if (c.headNode) c.headNode.classList.toggle("muted", !!hidden[c.key]);
      });
    }

    var detailParts = null;   // 詳細パネルの中の差し替える要素をそのまま持っておく

    function buildDetail() {
      var box = el("div", "pt-detail", main);
      var head = el("div", "pt-detail-head", box);
      var chip = el("span", "pt-chip", head);
      var swatch = el("span", "pt-swatch", chip);
      var who = el("span", null, chip);
      var when = el("span", null, head);
      var close = el("button", null, head);
      close.type = "button";
      close.textContent = "Close";
      close.addEventListener("click", function () {
        box.classList.remove("show");
        dots.forEach(function (o) { o.node.classList.remove("active"); });
      });
      var body = el("pre", null, box);
      return { box: box, swatch: swatch, who: who, when: when, body: body };
    }

    function showDetail(r, c) {
      if (!detailParts) detailParts = buildDetail();
      detailParts.swatch.style.background = c.color;
      detailParts.who.textContent = r.session || "";
      detailParts.when.textContent =
        r.time + (r.branch ? "  ·  " + r.branch : "") + (r.kind === "slash" ? "  ·  command" : "") +
        (r.busyMs ? "  ·  " + mmss(r.busyMs) + " busy"
                    + ((r.spans || []).length > 1 ? " / " + r.spans.length + " spans" : "") : "") +
        (r.cost ? "  ·  " + METRICS.cost.fmt(r.cost) + " api-equivalent"
                  + "  ·  " + METRICS.tokens.fmt(r.tokens || 0) + " tokens" : "");
      detailParts.body.textContent = r.text || "(no body)";
      detailParts.box.classList.add("show");
    }

    // 見出しの一文など、ページ側が同じ色を使えるように返す。
    var colorOf = {};
    cols.forEach(function (c) { colorOf[c.key] = c.color; });
    return { colorOf: colorOf };
  }

  global.PromptTimeline = { mount: mount, formatDuration: mmss,
    // テスト用。描画には使わない。
    _internal: { buildColumns: buildColumns, assignColors: assignColors, METRICS: METRICS, SLOTS: SLOTS } };
})(this);
