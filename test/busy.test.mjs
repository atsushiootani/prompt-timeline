import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { collect } from "../src/collect.mjs";

const SESSION = "11111111-2222-3333-4444-555555555555";
const at = (hh, mm, ss = 0) =>
  `2026-09-16T${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}:${String(ss).padStart(2, "0")}.000Z`;

const prompt = (text, timestamp) => ({
  type: "user",
  timestamp,
  cwd: "/home/dev/webapp",
  sessionId: SESSION,
  message: { content: [{ type: "text", text }] },
});

/** An assistant turn. `stop` of "end_turn" is the moment control comes back to you. */
const assistant = (timestamp, stop = "tool_use", extra = {}) => ({
  type: "assistant",
  timestamp,
  cwd: "/home/dev/webapp",
  sessionId: SESSION,
  message: { role: "assistant", model: "claude-opus-5", stop_reason: stop, content: [], usage: {} },
  ...extra,
});

/** A tool result coming back — this is what a long poll looks like in a transcript. */
const toolResult = (timestamp) => ({
  type: "user",
  timestamp,
  cwd: "/home/dev/webapp",
  sessionId: SESSION,
  message: { content: [{ type: "tool_result", content: "ok", tool_use_id: "t1" }] },
});

async function fixture(records) {
  const root = await mkdtemp(path.join(tmpdir(), "pt-busy-"));
  const dir = path.join(root, "-home-dev-webapp");
  await mkdir(dir, { recursive: true });
  await writeFile(dir + "/session.jsonl", records.map((r) => JSON.stringify(r)).join("\n"), "utf8");
  return root;
}

const run = async (records, opts = {}) => {
  const root = await fixture(records);
  try {
    return await collect({ date: "2026-09-16", projectsDir: root, tz: 0, ...opts });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
};

test("a busy span runs from the prompt until control comes back", async () => {
  const doc = await run([
    prompt("do the thing", at(10, 0)),
    assistant(at(10, 0, 30)),
    toolResult(at(10, 1)),
    assistant(at(10, 2), "end_turn"),
  ]);
  const row = doc.human_prompts[0];
  assert.deepEqual(row.spans, [["10:00:00", "10:02:00"]]);
  assert.equal(row.busyMs, 120000);
});

test("a long poll inside a turn stays busy", async () => {
  // One tool call that took 20 minutes. Nothing is recorded while it runs,
  // but the agent was occupied the whole time, so the span must not be split.
  const doc = await run([
    prompt("watch the deploy", at(10, 0)),
    assistant(at(10, 0, 10)),
    toolResult(at(10, 20)),
    assistant(at(10, 21), "end_turn"),
  ]);
  const row = doc.human_prompts[0];
  assert.equal(row.spans.length, 1, "a long-running tool must not break the span");
  assert.equal(row.busyMs, 21 * 60 * 1000);
});

test("silence longer than the cap truncates the span", async () => {
  // The session was abandoned mid-tool and picked up the next morning.
  // Without a cap this would draw a bar many hours long.
  const doc = await run(
    [
      prompt("start something", at(10, 0)),
      assistant(at(10, 1)),
      assistant(at(14, 0), "end_turn"),
    ],
    { busyGapCapMinutes: 30 },
  );
  const row = doc.human_prompts[0];
  assert.equal(row.busyMs, 60000, "only the first minute counts as busy");
  assert.ok(
    row.spans.every(([, end], i) => i > 0 || end === "10:01:00"),
    "the span should stop where the transcript goes quiet",
  );
});

test("work resuming after end_turn becomes a separate span", async () => {
  // A background task reports back later: two bursts of work, real idle between them.
  const doc = await run([
    prompt("kick off the job", at(10, 0)),
    assistant(at(10, 1), "end_turn"),
    assistant(at(11, 0)),
    assistant(at(11, 2), "end_turn"),
  ]);
  const row = doc.human_prompts[0];
  assert.equal(row.spans.length, 2);
  assert.deepEqual(row.spans[0], ["10:00:00", "10:01:00"]);
  assert.deepEqual(row.spans[1], ["11:00:00", "11:02:00"]);
  assert.equal(row.busyMs, 60000 + 120000, "idle between bursts must not be counted");
});

test("a sub-agent finishing does not hand control back", async () => {
  // Sub-agent turns carry their own end_turn. The parent is still working.
  const doc = await run([
    prompt("research this", at(10, 0)),
    assistant(at(10, 1), "end_turn", { isSidechain: true }),
    assistant(at(10, 5), "end_turn"),
  ]);
  const row = doc.human_prompts[0];
  assert.equal(row.spans.length, 1, "the sub-agent's end_turn must not close the parent span");
  assert.equal(row.busyMs, 5 * 60 * 1000);
});

test("busy time is summarised per day and per session", async () => {
  const doc = await run([
    prompt("one", at(10, 0)),
    assistant(at(10, 2), "end_turn"),
    prompt("two", at(11, 0)),
    assistant(at(11, 3), "end_turn"),
  ]);
  assert.equal(doc.summary.busy_ms, 5 * 60 * 1000);
  assert.equal(doc.summary.busy_ms_by_session["webapp.11111111"], 5 * 60 * 1000);
});

test("the bundled sample carries spans the view can draw", async () => {
  const here = path.dirname(new URL(import.meta.url).pathname);
  const sample = JSON.parse(await readFile(path.join(here, "..", "sample", "sample-day.json"), "utf8"));

  assert.ok(sample.summary.busy_ms > 0, "the sample should have busy time to show");
  assert.equal(
    sample.human_prompts.reduce((sum, row) => sum + row.busyMs, 0),
    sample.summary.busy_ms,
    "the per-prompt totals and the day total must agree",
  );

  for (const row of sample.human_prompts) {
    assert.ok(Array.isArray(row.spans), `${row.time} should carry spans`);
    assert.equal(row.spans[0][0], row.time, "a span starts when you hit enter");
    let previousEnd = null;
    for (const [from, to] of row.spans) {
      assert.ok(to > from, `${row.time} has a span that does not move forward`);
      if (previousEnd) assert.ok(from >= previousEnd, `${row.time} has overlapping spans`);
      previousEnd = to;
    }
  }
});

test("a prompt with no answer has no spans", async () => {
  const doc = await run([prompt("typed just before closing the laptop", at(23, 59))]);
  const row = doc.human_prompts[0];
  assert.deepEqual(row.spans, []);
  assert.equal(row.busyMs, 0);
});
