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
