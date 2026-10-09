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
