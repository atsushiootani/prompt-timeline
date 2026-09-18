import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { classify, userText, localParts, collect } from "../src/collect.mjs";
import { render } from "../src/render.mjs";

const userRecord = (text, extra = {}) => ({
  type: "user",
  timestamp: "2026-09-16T03:00:00.000Z",
  cwd: "/home/dev/webapp",
  sessionId: "11111111-2222-3333-4444-555555555555",
  message: { content: [{ type: "text", text }] },
  ...extra,
});

/** Build a throwaway ~/.claude/projects tree from a list of records. */
async function fixture(records, { dir = "-home-dev-webapp", file = "session.jsonl" } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "pt-test-"));
  const projectDir = path.join(root, dir);
  await mkdir(projectDir, { recursive: true });
  await writeFile(path.join(projectDir, file), records.map((r) => JSON.stringify(r)).join("\n"), "utf8");
  return root;
}

test("classify separates human prompts from machine-injected turns", () => {
  assert.equal(classify("fix the rounding bug"), "human");
  assert.equal(classify("<task-notification>done</task-notification>"), "task_notif");
  assert.equal(classify("<bash-input>ls</bash-input>"), "bash_io");
  assert.equal(classify("This session is being continued from a previous one"), "continuation");
  assert.equal(classify("[Request interrupted by user]"), "interrupt");
  assert.equal(classify("Another Claude session sent a message: hi"), "teammate");
  assert.equal(classify("<command-name>/run</command-name>"), "slash");
});

test("userText drops tool results, meta turns and sub-agent turns", () => {
  assert.equal(userText(userRecord("hello")), "hello");
  assert.equal(userText({ ...userRecord("x"), isMeta: true }), null);
  assert.equal(userText({ ...userRecord("x"), isSidechain: true }), null);
  assert.equal(
    userText({ ...userRecord("x"), message: { content: [{ type: "tool_result", content: "out" }] } }),
    null,
  );
  assert.equal(userText({ ...userRecord("x"), message: { content: "  " } }), null);
  assert.equal(userText(userRecord("<system-reminder>note</system-reminder>")), null);
  assert.equal(userText(userRecord("Caveat: the messages below")), null);
});

test("localParts honours a fixed UTC offset", () => {
  // 23:30 UTC is already the next day at +09:00.
  const parts = localParts("2026-09-15T23:30:00.000Z", 9);
  assert.equal(parts.date, "2026-09-16");
  assert.equal(parts.time, "08:30:00");
});

test("a day is cut on local time, not on the UTC prefix", async () => {
  const root = await fixture([
    userRecord("belongs to the 16th locally", { timestamp: "2026-09-15T23:30:00.000Z" }),
    userRecord("belongs to the 15th locally", { timestamp: "2026-09-15T04:00:00.000Z" }),
  ]);
  try {
    const day16 = await collect({ date: "2026-09-16", projectsDir: root, tz: 9 });
    assert.deepEqual(day16.human_prompts.map((r) => r.text), ["belongs to the 16th locally"]);

    const day15 = await collect({ date: "2026-09-15", projectsDir: root, tz: 9 });
    assert.deepEqual(day15.human_prompts.map((r) => r.text), ["belongs to the 15th locally"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("mirrored sessions are de-duplicated and slash commands split out", async () => {
  const records = [
    { type: "agent-name", agentName: "main", sessionId: "s1" },
    userRecord("same prompt in two files"),
    userRecord("<command-name>/run</command-name>", { timestamp: "2026-09-16T03:05:00.000Z" }),
  ];
  const root = await fixture(records);
  // The same conversation, mirrored into a second transcript.
  await writeFile(
    path.join(root, "-home-dev-webapp", "mirror.jsonl"),
    records.map((r) => JSON.stringify(r)).join("\n"),
    "utf8",
  );
  try {
    const doc = await collect({ date: "2026-09-16", projectsDir: root, tz: 9 });
    assert.equal(doc.summary.human_prompts, 1, "the mirrored copy should be dropped");
    assert.equal(doc.summary.slash_commands, 1);
    assert.equal(doc.slash_commands[0].command, "/run");
    assert.equal(doc.human_prompts[0].session, "webapp.main", "agentName should win over the UUID");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("session falls back to the UUID when the transcript carries no name", async () => {
  const root = await fixture([userRecord("no name anywhere")]);
  try {
    const doc = await collect({ date: "2026-09-16", projectsDir: root, tz: 9 });
    assert.equal(doc.human_prompts[0].session, "webapp.11111111");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("--no-text drops bodies but keeps the shape", async () => {
  const root = await fixture([userRecord("secret working notes")]);
  try {
    const doc = await collect({ date: "2026-09-16", projectsDir: root, tz: 9, includeText: false });
    assert.equal(doc.human_prompts.length, 1);
    assert.ok(!("text" in doc.human_prompts[0]), "body must not be present");
    assert.equal(doc.human_prompts[0].chars, "secret working notes".length);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("dropSdk removes SDK and system turns", async () => {
  const root = await fixture([
    userRecord("typed by a person", { promptSource: "typed" }),
    userRecord("injected by the sdk", { promptSource: "sdk", timestamp: "2026-09-16T03:01:00.000Z" }),
  ]);
  try {
    const kept = await collect({ date: "2026-09-16", projectsDir: root, tz: 9, dropSdk: true });
    assert.deepEqual(kept.human_prompts.map((r) => r.text), ["typed by a person"]);
    assert.equal(kept.summary.excluded.sdk_filtered, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("render inlines everything and survives token-like prompt text", async () => {
  const data = {
    date: "2026-09-16",
    summary: { human_prompts: 1, slash_commands: 0, by_session: { "webapp.main": 1 }, excluded: {} },
    agents: {},
    // A prompt that literally contains a template token must not corrupt the output.
    human_prompts: [{ time: "10:00:00", session: "webapp.main", workspace: "webapp", agent: "main", text: "__JS__ and </script>", chars: 20 }],
    slash_commands: [],
  };
  const html = await render(data);

  assert.ok(html.includes(".pt-dot"), "the stylesheet should be inlined");
  assert.ok(html.includes("PromptTimeline"), "the view script should be inlined");
  assert.ok(!html.includes("<title>__TITLE__</title>"), "the title slot should be filled");

  // A prompt containing "</script>" must not be able to close the script block.
  assert.ok(!html.includes("__JS__ and </script>"), "the closing tag must be escaped");

  // The data round-trips: the token-like text survives as data, not as a slot to fill.
  const payload = html.match(/window\.PROMPT_TIMELINE_DATA = (.+);<\/script>/);
  assert.ok(payload, "the data should be inlined");
  const parsed = JSON.parse(payload[1]);
  assert.equal(parsed.human_prompts[0].text, "__JS__ and </script>");
});

test("the mascot is inlined, and a missing one does not break the page", async () => {
  const data = {
    date: "2026-09-16",
    summary: { human_prompts: 0, slash_commands: 0, by_session: {}, excluded: {} },
    agents: {}, human_prompts: [], slash_commands: [],
  };

  const html = await render(data);
  assert.ok(!html.includes("__ICON__"), "every icon slot should be filled");

  // The art is tens of kilobytes. Carrying it once and reusing it is the whole point:
  // a copy per use site tripled the size of the page.
  const copies = html.match(/data:image\/png;base64,/g) ?? [];
  assert.equal(copies.length, 1, "the icon must be inlined exactly once");

  // Art is decoration: a checkout without it must still render.
  const bare = await render(data, { iconFile: "/nonexistent/icon.png" });
  assert.ok(!bare.includes("__ICON__"), "the slot should still be filled when the art is missing");
  assert.ok(bare.includes("PromptTimeline"), "the page should render regardless");
});

test("an unreadable date is rejected", async () => {
  const root = await fixture([userRecord("x")]);
  try {
    await assert.rejects(() => collect({ date: "16-09-2026", projectsDir: root }), /YYYY-MM-DD/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
