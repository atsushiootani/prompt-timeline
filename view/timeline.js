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

  /* 色はセッションに付け、表示の並び順には付けない。cost/tokens を切り替えて列が入れ替わっても
     同じセッションは同じ色のまま。色を配る順は「その日どれだけ動いたか」（件数 → 稼働時間 →
     初めて現れた時刻）で、size by とは無関係に 1 日の中で固定。8 色を超えたら、灰色になるのは
     その日いちばん動かなかったセッションになる。
     設定ファイルが使っている色の枠は飛ばすので、2 つのセッションが同じ色になることはない。 */
  function assignColors(cols, firstSeen) {
    var taken = {};
    cols.forEach(function (c) { if (c.color) taken[String(c.color).toLowerCase()] = true; });
    var free = [];
    SLOTS.forEach(function (hex, i) { if (!taken[hex]) free.push("var(--pt-s" + (i + 1) + ")"); });
    var order = cols.filter(function (c) { return !c.color; })
      .sort(function (a, b) {
        return (b.n + b.slash) - (a.n + a.slash) || (b.busy || 0) - (a.busy || 0) ||
               firstSeen[a.key].localeCompare(firstSeen[b.key]) || a.key.localeCompare(b.key);
      });
    order.forEach(function (c, i) {
      // 9 本目以降は色を作らない。灰色に落として、見出しの名前で区別させる。
      c.color = i < free.length ? free[i] : "var(--pt-other)";
    });
  }

  /* 時間帯ごとの値をセッション別に数える。
     件数はプロンプトを打った時刻の枠へ。金額とトークンは、エージェントが動いていた区間の
     分数に比例して各時間帯へ配る（14:50 に投げて 15:30 まで回ったら両方の枠に乗る）。 */
  function hourly(rows, metric, fromHour, toHour) {
    var n = toHour - fromHour, by = {};
    function add(key, h, v) {
      if (h < fromHour || h >= toHour) return;
      (by[key] = by[key] || new Array(n).fill(0))[h - fromHour] += v;
    }
    rows.forEach(function (r) {
      var key = r.session || "?";
      if (!metric) { add(key, Math.floor(toMinutes(r.time) / 60), 1); return; }
      var v = metric.of(r);
      if (!v) return;
      var spans = (r.spans || []).map(function (sp) { return [toMinutes(sp[0]), toMinutes(sp[1])]; })
        .filter(function (sp) { return sp[1] > sp[0]; });
      var len = spans.reduce(function (a, sp) { return a + sp[1] - sp[0]; }, 0);
      if (!len) { add(key, Math.floor(toMinutes(r.time) / 60), v); return; }
      spans.forEach(function (sp) {
        for (var h = Math.floor(sp[0] / 60); h * 60 < sp[1]; h++) {
          var part = Math.min(sp[1], (h + 1) * 60) - Math.max(sp[0], h * 60);
          if (part > 0) add(key, h, v * part / len);
        }
      });
    });
    return by;
  }

  /* 同時に動いていたエージェントの最大数と、その時刻。全スパンの開始と終了を時刻順に掃く。
     同じ時刻なら終了を先に数える（バトンを渡しただけの瞬間を「2 本同時」と数えない）。 */
  function peakConcurrency(rows) {
    var ev = [];
    rows.forEach(function (r) {
      (r.spans || []).forEach(function (sp) {
        var a = toMinutes(sp[0]), b = toMinutes(sp[1]);
        if (b > a) { ev.push([a, 1]); ev.push([b, -1]); }
      });
    });
    ev.sort(function (x, y) { return x[0] - y[0] || x[1] - y[1]; });
    var now = 0, best = 0, at = null;
    ev.forEach(function (e) { now += e[1]; if (now > best) { best = now; at = e[0]; } });
    return { n: best, at: at };
  }

  /* 時間軸を「稼働した時間帯」と「畳む空白」に分ける。
     プロンプトもビジー区間も無い時間が 2 時間以上続いたら 1 本の細い帯に畳む。
     1 時間だけの空白は残す（昼休みはその日のリズムの一部で、捨てる空白ではない）。
     ビジー区間が掛かった時間も稼働扱いなので、区間が帯をまたぐことはない。 */
  function foldAxis(rows, fromHour, toHour, minRun) {
    var active = {};
    rows.forEach(function (r) {
      active[Math.floor(toMinutes(r.time) / 60)] = true;
      (r.spans || []).forEach(function (sp) {
        var a = toMinutes(sp[0]), b = toMinutes(sp[1]);
        for (var h = Math.floor(a / 60); h * 60 < Math.max(b, a + 1e-9); h++) active[h] = true;
      });
    });
    var segs = [], h = fromHour;
    while (h < toHour) {
      var start = h, on = !!active[h];
      while (h < toHour && !!active[h] === on) h++;
      var len = h - start;
      if (!on && len >= minRun) segs.push({ fold: true, from: start, to: h });
      else if (segs.length && !segs[segs.length - 1].fold) segs[segs.length - 1].to = h;
      else segs.push({ fold: false, from: start, to: h });
    }
    return segs;
  }

  /* 同じセッションで、間隔 gapMin 分以内のプロンプトが minLen 本以上続いた所のうち、一番濃い所。
     本数が多い方、同数なら短い時間に詰まっている方を選ぶ。苦戦かどうかは判定しない ——
     平均文字数を添えて、短い打ち直しの連打か、長い仕様の流し込みかは読む人に見分けてもらう。 */
  function tightestLoop(rows, gapMin, minLen) {
    var bySession = {};
    rows.forEach(function (r) { (bySession[r.session || "?"] = bySession[r.session || "?"] || []).push(r); });
    var best = null;
    Object.keys(bySession).forEach(function (key) {
      var list = bySession[key].slice().sort(function (a, b) { return toMinutes(a.time) - toMinutes(b.time); });
      var run = [list[0]];
      function close() {
        if (run.length < minLen) return;
        var dur = toMinutes(run[run.length - 1].time) - toMinutes(run[0].time);
        if (!best || run.length > best.rows.length || (run.length === best.rows.length && dur < best.minutes)) {
          var chars = run.reduce(function (a, r) { return a + (r.chars || (r.text || "").length); }, 0);
          best = { session: key, rows: run.slice(), minutes: dur, avgChars: Math.round(chars / run.length) };
        }
      }
      for (var i = 1; i < list.length; i++) {
        if (toMinutes(list[i].time) - toMinutes(list[i - 1].time) <= gapMin) run.push(list[i]);
        else { close(); run = [list[i]]; }
      }
      close();
    });
    return best;
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

    var FOLDPX = 30;
    var segs = foldAxis(rows, lo / 60, hi / 60, 2);
    var acc = 0;
    segs.forEach(function (sg) { sg.y = acc; acc += sg.fold ? FOLDPX : (sg.to - sg.from) * HOURPX; });
    var plotH = Math.max(240, acc + 2 * PAD);

    // 左にセッションの順位表、右にタイムライン。表は凡例を兼ねる。
    var grid = el("div", "pt-grid", host);
    var side = el("aside", "pt-side", grid);
    var main = el("div", "pt-main", grid);

    // Spread the columns across whatever width we were given, within reason.
    var avail = Math.max(0, (main.clientWidth || host.clientWidth || 0) - 30);
    var COLW = Math.max(COLW_MIN, Math.min(COLW_MAX,
                 cols.length ? Math.floor((avail - GUTTER) / cols.length) : COLW_MIN));
    var width = GUTTER + cols.length * COLW;
    // 区分線形: 稼働した時間帯は 1 時間 = HOURPX、畳んだ空白は FOLDPX の固定幅。
    var yOf = function (m) {
      for (var i = 0; i < segs.length; i++) {
        var sg = segs[i];
        if (m <= sg.to * 60 || i === segs.length - 1) {
          var dm = Math.max(0, Math.min(m, sg.to * 60) - sg.from * 60);
          return head + PAD + sg.y + (sg.fold ? FOLDPX / 2 : dm / 60 * HOURPX);
        }
      }
      return head + PAD;
    };

    var panel = el("div", "pt-panel", main);
    var scroll = el("div", "pt-scroll", panel);
    var plot = el("div", "pt-plot", scroll);
    plot.style.width = width + "px";
    plot.style.height = (head + plotH) + "px";

    // 1 時間ごとの横罫線。畳んだ空白は罫線の代わりに「何時間なにも無かったか」の帯。
    var hh = function (h) { return String(h % 24).padStart(2, "0"); };
    segs.forEach(function (sg) {
      if (sg.fold) {
        var band = el("div", "pt-fold", plot);
        band.style.top = (head + PAD + sg.y) + "px";
        band.style.height = FOLDPX + "px";
        band.style.left = GUTTER + "px";
        band.textContent = "≈ " + (sg.to - sg.from) + "h with nothing running  ·  " + hh(sg.from) + ":00 – " + hh(sg.to) + ":00";
        return;
      }
      for (var h = sg.from; h <= sg.to; h++) {
        var g = el("div", "pt-gridline", plot);
        g.style.top = (head + PAD + sg.y + (h - sg.from) * HOURPX) + "px";
        var lab = el("div", "pt-time", g);
        lab.innerHTML = hh(h) + "<br>00";
      }
    });

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
      r._dot = d;
      r._col = c;
    });

    // 指標の切り替え。点の大きさ・列の並び・順位表がまとめて変わる。
    var boardCard = el("div", "pt-sidecard", side);
    var boardHead = el("div", "pt-board-head", boardCard);
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
    var board = el("ol", "pt-board", boardCard);
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
        (c.n + c.slash) + (c.n + c.slash === 1 ? " prompt" : " prompts") +
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
      // 画面下に固定したシートなので Esc でも閉じられるようにする。
      document.addEventListener("keydown", function (e) { if (e.key === "Escape") close.click(); });
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

    // その日の「瞬間」。押すとその点まで飛んで開く。
    drawMoments();

    function focusRow(r, also) {
      if (!r._dot) return;
      if (hidden[r.session || "?"]) toggle(r.session || "?");
      r._dot.scrollIntoView({ block: "center", behavior: "smooth" });
      dots.forEach(function (o) { o.node.classList.remove("active"); });
      r._dot.classList.add("active");
      (also || []).forEach(function (x) {
        if (!x._dot) return;
        x._dot.classList.remove("pulse"); void x._dot.offsetWidth; x._dot.classList.add("pulse");
      });
      showDetail(r, r._col);
    }

    function drawMoments() {
      var human = rows.filter(function (r) { return r.kind === "human"; });
      if (!human.length) return;
      var maxBy = function (f) {
        return human.reduce(function (a, r) { return f(r) > (a ? f(a) : 0) ? r : a; }, null);
      };
      var snip = function (r) {
        if (!r.text) return (r.chars || 0) + " characters (text not included)";
        // 先頭の <tag>…</tag> の塊（ダッシュボードやフックが差し込む文脈）は抜粋では飛ばす。
        // 全文のシートでは一切いじらない。
        var body = r.text.replace(/^(\s*<([A-Za-z][\w-]*)[^>]*>[\s\S]*?<\/\2>\s*)+/, "");
        var t = (body.trim() || r.text).replace(/\s+/g, " ").trim();
        return "“" + (t.length > 84 ? t.slice(0, 84) + "…" : t) + "”";
      };
      var cards = [];
      // 同じプロンプトが複数の「瞬間」に当たったら、カードは 1 枚にまとめて肩書きを足す。
      function put(card) {
        var same = cards.filter(function (c) { return c.row === card.row && !c.group && !card.group; })[0];
        if (!same) { cards.push(card); return; }
        same.label += " — and the " + card.label.charAt(0).toLowerCase() + card.label.slice(1);
        same.note = [same.note, card.value + (card.note ? " · " + card.note : "")].filter(Boolean).join(" · ");
      }
      var longest = maxBy(function (r) { return r.busyMs || 0; });
      if (longest) put({ label: "Longest run", value: mmss(longest.busyMs), row: longest });
      var pricey = maxBy(function (r) { return r.cost || 0; });
      if (pricey) put({ label: "Priciest prompt", value: METRICS.cost.fmt(pricey.cost), row: pricey,
                        note: METRICS.tokens.fmt(pricey.tokens || 0) + " tokens" });
      else {
        var heavy = maxBy(function (r) { return r.tokens || 0; });
        if (heavy) put({ label: "Most tokens", value: METRICS.tokens.fmt(heavy.tokens), row: heavy });
      }
      var loop = tightestLoop(human, 6, 3);
      if (loop) put({ label: "Tightest loop", value: loop.rows.length + " prompts in " + Math.max(1, Math.round(loop.minutes)) + "m",
                             row: loop.rows[0], group: loop.rows,
                             note: "avg " + loop.avgChars + " characters" + (loop.avgChars < 60 ? " — quick corrections?" : " — feeding in detail") });
      var essay = maxBy(function (r) { return r.chars || 0; });
      if (essay) put({ label: "Longest prompt you wrote", value: (essay.chars || 0).toLocaleString() + " chars", row: essay });
      if (!cards.length) return;

      var box = el("div", "pt-moments", side);
      el("div", "pt-board-title", box).textContent = "Moments of the day";
      cards.forEach(function (m) {
        var b = el("button", "pt-moment", box);
        b.type = "button";
        el("span", "pt-m-label", b).textContent = m.label;
        el("b", "pt-m-val", b).textContent = m.value;
        var who = el("span", "pt-m-who", b);
        el("i", null, who).style.background = m.row._col ? m.row._col.color : "var(--sub)";
        who.appendChild(document.createTextNode((m.row._col ? m.row._col.name : m.row.session) + " · " + m.row.time.slice(0, 5) +
          (m.note ? " · " + m.note : "")));
        el("span", "pt-m-text", b).textContent = snip(m.row);
        b.addEventListener("click", function () { focusRow(m.row, m.group); });
      });
    }

    // 時間帯グラフ（ページが置き場所を渡してきたときだけ）。列はセッション別の積み上げで、
    // 順位表と同じ並び・同じ色。cost / tokens / prompts は size by に従う。
    if (opts.hourlyHost) drawHours(opts.hourlyHost);

    function drawHours(box) {
      box.innerHTML = "";
      var h0 = Math.floor(lo / 60), h1 = Math.ceil(hi / 60);
      var by = hourly(rows, metric, h0, h1);
      var totals = [];
      for (var k = 0; k < h1 - h0; k++) {
        totals.push(cols.reduce(function (a, c) { return a + ((by[c.key] || [])[k] || 0); }, 0));
      }
      var maxV = Math.max.apply(null, totals.concat([0]));
      var fmt = metric ? metric.fmt : function (v) { return String(Math.round(v)); };
      var unit = metric ? "" : " prompts";
      var peakH = totals.indexOf(maxV);
      var conc = peakConcurrency(rows);
      var hhmm = function (m) { return String(Math.floor(m / 60) % 24).padStart(2, "0") + ":" + String(Math.round(m % 60)).padStart(2, "0"); };

      var cap = el("div", "pt-hours-cap", box);
      if (maxV) {
        var a = el("span", null, cap);
        a.appendChild(document.createTextNode("Busiest hour "));
        el("b", null, a).textContent = String(h0 + peakH).padStart(2, "0") + ":00";
        a.appendChild(document.createTextNode(" · " + fmt(maxV) + unit));
      }
      if (conc.n > 1) {
        var b2 = el("span", null, cap);
        el("b", null, b2).textContent = conc.n + " agents";
        b2.appendChild(document.createTextNode(" running at once at " + hhmm(conc.at)));
      }

      var plotBox = el("div", "pt-hours-plot", box);
      el("div", "pt-hours-max", plotBox).textContent = maxV ? fmt(maxV) + unit : "";
      var colsRow = el("div", "pt-hours-cols", plotBox);
      var PH = 112;
      for (var i = 0; i < h1 - h0; i++) (function (i) {
        var col = el("div", "pt-hcol", colsRow);
        var stack = el("div", "pt-hstack", col);
        stack.style.height = (maxV ? totals[i] / maxV * PH : 0) + "px";
        cols.forEach(function (c) {
          var v = (by[c.key] || [])[i] || 0;
          if (!v || hidden[c.key]) return;
          var seg = el("div", "pt-hseg", stack);
          seg.style.flexGrow = String(v);
          seg.style.background = c.color;
        });
        var lab = el("span", "pt-hlab", col);
        lab.textContent = String((h0 + i) % 24).padStart(2, "0");
        col.addEventListener("mouseenter", function () {
          var lines = cols.filter(function (c) { return (by[c.key] || [])[i]; }).map(function (c) {
            return '<div class="pt-tip-row"><i style="background:' + esc(c.color) + '"></i>' + esc(c.name) +
              "<b>" + esc(fmt(by[c.key][i])) + unit + "</b></div>";
          }).join("");
          tip.innerHTML = '<div class="pt-tip-head">' + String(h0 + i).padStart(2, "0") + ":00 – " +
            String(h0 + i + 1).padStart(2, "0") + ":00 · " + esc(fmt(totals[i])) + unit + "</div>" + (lines || "nothing");
          tip.classList.add("show");
          var r = col.getBoundingClientRect();
          tip.style.left = "0px"; tip.style.top = "0px";
          var tx = Math.min(r.right + 8, innerWidth - tip.offsetWidth - 8);
          tip.style.left = Math.max(8, tx) + "px";
          tip.style.top = Math.max(8, r.top - 10) + "px";
        });
        col.addEventListener("mouseleave", function () { tip.classList.remove("show"); });
      })(i);
    }

    // 見出しの一文など、ページ側が同じ色を使えるように返す。
    var colorOf = {};
    cols.forEach(function (c) { colorOf[c.key] = c.color; });
    return { colorOf: colorOf };
  }

  global.PromptTimeline = { mount: mount, formatDuration: mmss,
    // テスト用。描画には使わない。
    _internal: { buildColumns: buildColumns, assignColors: assignColors, METRICS: METRICS, SLOTS: SLOTS,
                 hourly: hourly, peakConcurrency: peakConcurrency, foldAxis: foldAxis,
                 tightestLoop: tightestLoop } };
})(this);
