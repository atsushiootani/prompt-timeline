import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { collect } from "../src/collect.mjs";
import { priceTurn } from "../src/pricing.mjs";

const SESSION = "11111111-2222-3333-4444-555555555555";
const at = (hh, mm, ss = 0) =>
  `2026-09-16T${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}:${String(ss).padStart(2, "0")}.000Z`;

const prompt = (text, timestamp) => ({
  type: "user", timestamp, cwd: "/home/dev/webapp", sessionId: SESSION,
  message: { content: [{ type: "text", text }] },
});

const assistant = (timestamp, usage, { model = "claude-opus-5", stop = "end_turn", ...rest } = {}) => ({
  type: "assistant", timestamp, cwd: "/home/dev/webapp", sessionId: SESSION,
  message: { role: "assistant", model, stop_reason: stop, content: [], usage },
  ...rest,
});

async function run(records) {
  const root = await mkdtemp(path.join(tmpdir(), "pt-cost-"));
  const dir = path.join(root, "-home-dev-webapp");
  await mkdir(dir, { recursive: true });
  await writeFile(dir + "/session.jsonl", records.map((r) => JSON.stringify(r)).join("\n"), "utf8");
  try {
    return await collect({ date: "2026-09-16", projectsDir: root, tz: 0 });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("output is priced far above cached input", () => {
  // The whole reason a raw token count cannot stand in for cost.
  const output = priceTurn("claude-opus-5", { output_tokens: 1e6 });
  const cached = priceTurn("claude-opus-5", { cache_read_input_tokens: 1e6 });
  assert.equal(output.cost, 25);
  assert.equal(cached.cost, 0.5);
  assert.equal(output.tokens, cached.tokens, "same tokens, fifty times the cost");
});

test("each model is priced on its own rates", () => {
  const usage = { input_tokens: 1e6 };
  assert.equal(priceTurn("claude-opus-5", usage).cost, 5);
  assert.equal(priceTurn("claude-sonnet-5", usage).cost, 2);
  assert.equal(priceTurn("claude-haiku-4-5", usage).cost, 1);
});

test("an unpriced model is counted, not valued at zero", () => {
  const { cost, tokens } = priceTurn("<synthetic>", { output_tokens: 1000 });
  assert.equal(cost, null, "guessing a price would be worse than admitting we have none");
  assert.equal(tokens, 1000, "the tokens are still real");
});

test("cost and tokens land on the prompt that caused them", async () => {
  const doc = await run([
    prompt("first", at(10, 0)),
    assistant(at(10, 1), { output_tokens: 1e6 }),
    prompt("second", at(11, 0)),
    assistant(at(11, 1), { output_tokens: 2e6 }),
  ]);
  const [first, second] = doc.human_prompts;
  assert.equal(first.cost, 25);
  assert.equal(second.cost, 50);
  assert.equal(first.tokens, 1e6);
  assert.equal(doc.summary.cost_usd, 75);
  assert.equal(doc.summary.cost_by_session["webapp.11111111"], 75);
});

test("a sub-agent's spend is charged to the prompt that started it", async () => {
  const doc = await run([
    prompt("go and research this", at(10, 0)),
    assistant(at(10, 1), { output_tokens: 1e6 }, { isSidechain: true, stop: "tool_use" }),
    assistant(at(10, 2), { output_tokens: 1e6 }),
  ]);
  assert.equal(doc.human_prompts[0].cost, 50, "work you set off is work you paid for");
});

test("unpriced models are surfaced rather than hidden", async () => {
  const doc = await run([
    prompt("hello", at(10, 0)),
    assistant(at(10, 1), { output_tokens: 1000 }, { model: "<synthetic>" }),
  ]);
  assert.deepEqual(doc.summary.unpriced_models, ["<synthetic>"]);
  assert.equal(doc.human_prompts[0].tokens, 1000, "tokens still counted");
});

test("cache reads on Fable 5.1 and Mythos 5.1 cost a quarter of the usual rate", () => {
  // Published: 0.025x the input price on these two models, 0.1x on every other.
  const read = { cache_read_input_tokens: 1e6 };
  assert.equal(priceTurn("claude-fable-5-1", read).cost, 0.25);
  assert.equal(priceTurn("claude-mythos-5-1", read).cost, 0.25);
  assert.equal(priceTurn("claude-fable-5", read).cost, 1, "Fable 5 keeps the standard 0.1x");
  assert.equal(priceTurn("claude-opus-5", read).cost, 0.5);
});

test("the 1-hour cache write is twice the input rate, the 5-minute one 1.25x", () => {
  const write = (kind) => ({ cache_creation: { [kind]: 1e6 } });
  assert.equal(priceTurn("claude-opus-5", write("ephemeral_1h_input_tokens")).cost, 10);
  assert.equal(priceTurn("claude-opus-5", write("ephemeral_5m_input_tokens")).cost, 6.25);
});
