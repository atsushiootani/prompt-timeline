import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

// timeline.js is a browser script. Run it in a bare context and reach the pure helpers.
const code = await readFile(new URL("../view/timeline.js", import.meta.url), "utf8");
const sandbox = {};
vm.runInNewContext(code, sandbox);
const { buildColumns, assignColors, METRICS } = sandbox.PromptTimeline._internal;

const row = (session, time, cost = 0, tokens = 0) => ({ session, workspace: "w", agent: session, time, cost, tokens });
const rows = [row("a", "09:00:00", 1, 900), row("b", "10:00:00", 5, 100), row("c", "11:00:00", 3, 500)];
const firstSeen = { "a": "09:00:00", "b": "10:00:00", "c": "11:00:00" };

function colorsFor(metric, agents = {}) {
  const { cols } = buildColumns(rows, agents, metric && METRICS[metric]);
  assignColors(cols, firstSeen);
  return Object.fromEntries(cols.map((c) => [c.key, c.color]));
}

test("a session keeps its colour when the columns are re-sorted", () => {
  // cost puts b first, tokens puts a first: the order changes, the colours must not.
  assert.deepEqual(colorsFor("cost"), colorsFor("tokens"));
  assert.deepEqual(colorsFor("cost"), colorsFor(null));
});

test("no two sessions share a colour, even when the config names one", () => {
  // The config pins `b` to slot 1's hex; the palette must skip that slot for the rest.
  const colors = Object.values(colorsFor("cost", { b: { color: "#2a78D6" } }));
  assert.equal(new Set(colors.map((c) => c.toLowerCase())).size, colors.length);
  assert.ok(!colors.includes("var(--pt-s1)"), "the slot the config took must not be handed out again");
});

test("past eight sessions, the rest fold to grey rather than inventing a hue", () => {
  const many = Array.from({ length: 10 }, (_, i) => row("s" + i, `0${i}:00:00`.slice(-8)));
  const seen = Object.fromEntries(many.map((r) => [r.session, r.time]));
  const { cols } = buildColumns(many, {}, null);
  assignColors(cols, seen);
  assert.equal(cols.filter((c) => c.color === "var(--pt-other)").length, 2);
});

const { hourly, peakConcurrency } = sandbox.PromptTimeline._internal;

test("cost is spread over the hours the agent was actually busy", () => {
  // $6 for a run from 14:50 to 15:20: 10 minutes in 14:00, 20 in 15:00.
  const r = { session: "s", time: "14:50:00", cost: 6, spans: [["14:50:00", "15:20:00"]] };
  const by = hourly([r], METRICS.cost, 14, 16);
  assert.deepEqual(Array.from(by.s, (v) => Math.round(v * 100) / 100), [2, 4]);
});

test("prompts are counted in the hour they were typed", () => {
  const by = hourly([{ session: "s", time: "09:59:00" }, { session: "s", time: "10:00:00" }], null, 9, 11);
  assert.deepEqual(Array.from(by.s), [1, 1]);
});

test("peak concurrency counts overlapping runs, not hand-offs", () => {
  const rows = [
    { spans: [["10:00:00", "11:00:00"]] },
    { spans: [["10:30:00", "10:45:00"]] },
    { spans: [["10:40:00", "10:50:00"]] },
    // starts exactly as the first ends: a hand-off, not a fourth agent
    { spans: [["11:00:00", "11:30:00"]] },
  ];
  const peak = peakConcurrency(rows);
  assert.equal(peak.n, 3);
  assert.equal(peak.at, 10 * 60 + 40);
});

const { foldAxis } = sandbox.PromptTimeline._internal;

test("two or more idle hours fold; a single idle hour stays", () => {
  const rows = [
    { time: "06:50:00" },
    { time: "09:10:00" },              // 07, 08 idle -> fold
    { time: "11:30:00" },              // 10 idle alone -> kept
    { time: "22:05:00", spans: [["22:05:00", "22:40:00"]] },  // 12..21 idle -> fold
  ];
  const segs = foldAxis(rows, 6, 23, 2).map((s) => [s.fold, s.from, s.to]);
  assert.deepEqual(JSON.parse(JSON.stringify(segs)), [
    [false, 6, 7], [true, 7, 9], [false, 9, 12], [true, 12, 22], [false, 22, 23],
  ]);
});

test("an hour the agent was busy in is never folded away", () => {
  // Typed at 10:50, ran until 13:10: 11 and 12 have no prompt but were busy.
  const segs = foldAxis([{ time: "10:50:00", spans: [["10:50:00", "13:10:00"]] }], 10, 14, 2);
  assert.ok(segs.every((s) => !s.fold));
});

const { tightestLoop } = sandbox.PromptTimeline._internal;

test("the tightest loop is the longest quick run within one session", () => {
  const p = (session, time, text) => ({ session, time, text, chars: text.length });
  const rows = [
    // a 3-run in `a`, spaced 5 min
    p("a", "10:00:00", "add tests"), p("a", "10:05:00", "no, the other file"), p("a", "10:10:00", "still red"),
    // a 4-run in `b`, but the 7-minute gap breaks it into 2 + 2
    p("b", "11:00:00", "x"), p("b", "11:01:00", "y"), p("b", "11:08:00", "z"), p("b", "11:09:00", "w"),
    // the same prompts across two sessions are not one loop
    p("c", "12:00:00", "one"), p("d", "12:01:00", "two"), p("c", "12:02:00", "three"),
  ];
  const loop = tightestLoop(rows, 6, 3);
  assert.equal(loop.session, "a");
  assert.equal(loop.rows.length, 3);
  assert.equal(loop.minutes, 10);
  assert.equal(loop.avgChars, Math.round(("add tests".length + "no, the other file".length + "still red".length) / 3));
});

test("no loop is reported when nothing repeats quickly enough", () => {
  const rows = [{ session: "a", time: "10:00:00" }, { session: "a", time: "10:30:00" }, { session: "a", time: "11:00:00" }];
  assert.equal(tightestLoop(rows, 6, 3), null);
});

test("past eight, grey goes to the least active sessions, not the latest to appear", () => {
  // Three one-prompt sessions show up first thing; two busy ones only arrive in the evening.
  const rows = [
    ...["a", "b", "c"].map((k, i) => ({ session: k, agent: k, workspace: "w", time: `06:0${i}:00` })),
    ...["d", "e", "f", "g", "h"].flatMap((k, i) => [0, 1].map((j) => ({ session: k, agent: k, workspace: "w", time: `1${i}:0${j}:00` }))),
    ...["late1", "late2"].flatMap((k, i) => [0, 1, 2, 3].map((j) => ({ session: k, agent: k, workspace: "w", time: `2${i}:0${j}:00` }))),
  ];
  const seen = {};
  rows.forEach((r) => { if (!(r.session in seen)) seen[r.session] = r.time; });
  const { cols } = buildColumns(rows, {}, null);
  assignColors(cols, seen);
  const grey = cols.filter((c) => c.color === "var(--pt-other)").map((c) => c.key).sort();
  assert.equal(grey.length, 2);
  assert.ok(grey.every((k) => ["a", "b", "c"].includes(k)), `greyed ${grey}`);
});
