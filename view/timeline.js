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

  // Used when the config does not name a colour. Even in saturation so neighbours stay distinct.
  var FALLBACK = ["#3b82f6", "#ff6f93", "#10b981", "#a855f7", "#f59e0b",
                  "#06b6d4", "#ef4444", "#14b8a6", "#ec4899", "#0ea5e9",
                  "#84cc16", "#f97316", "#8b5cf6", "#22d3ee", "#e11d48"];

  var GUTTER  = 32,   // width of the time labels
      COLW_MIN = 62,  // narrowest a session column gets
      COLW_MAX = 150, // widest, so a couple of sessions don't sprawl
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
                    color: (agents && agents[parts.name] && agents[parts.name].color) || null });
      }
      var c = cols[index[key]];
      if (r.kind === "slash") c.slash++; else c.n++;
      if (metric) c.total += metric.of(r);
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
    cols.forEach(function (c, i) {
      if (!c.color) c.color = FALLBACK[i % FALLBACK.length];
      index[c.key] = i;
    });
    return { cols: cols, index: index };
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
    // Spread the columns across whatever width we were given, within reason.
    var avail = Math.max(0, (host.clientWidth || 0) - 34);
    var COLW = Math.max(COLW_MIN, Math.min(COLW_MAX,
                 cols.length ? Math.floor((avail - GUTTER) / cols.length) : COLW_MIN));
    var width = GUTTER + cols.length * COLW;
    var yOf = function (m) { return head + PAD + (m - lo) / (hi - lo) * (plotH - 2 * PAD); };

    var panel = el("div", "pt-panel", host);
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

      var head = el("div", "pt-colhead", plot);
      head.style.left = x + "px";
      head.style.width = COLW + "px";
      head.title = c.key + " - " + c.n + " prompts" + (c.slash ? ", " + c.slash + " commands" : "") +
        (metric ? " - " + metric.fmt(c.total) + " " + metric.label : "");
      el("div", "pt-ws", head).textContent = c.ws || "";
      el("div", "pt-nm", head).textContent = c.name;
      el("div", "pt-bar", head).style.background = c.color;
      if (metric) {
        var tot = el("div", "pt-total", head);
        tot.textContent = metric.fmt(c.total);
        tot.style.color = c.color;
      }
      head.addEventListener("click", function () { toggle(c.key); });
      c.headNode = head;
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

    // 指標の切り替え。点の大きさと列の並びが変わる。
    if (opts.onMetric) {
      var picker = el("div", "pt-metrics", host);
      el("span", "pt-metrics-label", picker).textContent = "size by";
      [["none", "count"], ["cost", "cost"], ["tokens", "tokens"]].forEach(function (pair) {
        var b = el("button", opts.metric === pair[0] || (!metric && pair[0] === "none") ? "on" : null, picker);
        b.type = "button";
        b.textContent = pair[1];
        b.addEventListener("click", function () { opts.onMetric(pair[0]); });
      });
    }

    // 凡例（押すとそのセッションだけ隠す / 戻す）
    var legend = el("div", "pt-legend", host);
    cols.forEach(function (c) {
      var b = el("button", null, legend);
      b.type = "button";
      el("span", "pt-swatch", b).style.background = c.color;
      var nm = el("span", null, b);
      nm.textContent = c.name;
      var n = el("span", "pt-n", b);
      n.textContent = String(c.n + c.slash);
      b.addEventListener("click", function () { toggle(c.key); });
      c.legendNode = b;
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
      var box = el("div", "pt-detail", host);
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
  }

  global.PromptTimeline = { mount: mount, formatDuration: mmss };
})(this);
