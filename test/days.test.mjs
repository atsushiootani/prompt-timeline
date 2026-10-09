import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { listDays, neighbours, dayContext } from "../src/days.mjs";

test("neighbours skip gaps instead of assuming ±1 day", () => {
  const days = ["2026-09-11", "2026-09-14", "2026-09-15", "2026-09-18"];
  assert.deepEqual(neighbours(days, "2026-09-14"), { prev: "2026-09-11", next: "2026-09-15" });
  assert.deepEqual(neighbours(days, "2026-09-11"), { prev: null, next: "2026-09-14" });
  assert.deepEqual(neighbours(days, "2026-09-18"), { prev: "2026-09-15", next: null });
  // A day being built for the first time is not in the list yet.
  assert.deepEqual(neighbours(days, "2026-09-16"), { prev: "2026-09-15", next: "2026-09-18" });
});

test("only YYYY-MM-DD.json files count as days", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "pt-days-"));
  try {
    for (const n of ["2026-09-15.json", "2026-09-15.html", "demo.json", "2026-09-14.json", "notes.txt"]) {
      await writeFile(path.join(dir, n), "{}");
    }
    assert.deepEqual(await listDays(dir), ["2026-09-14", "2026-09-15"]);
    assert.deepEqual(await listDays(path.join(dir, "missing")), []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("the previous day's headline numbers come along for comparison", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "pt-days-"));
  try {
    const summary = { cost_usd: 12.5, busy_ms: 60000, human_prompts: 7, tokens: 900, by_session: { x: 7 } };
    await writeFile(path.join(dir, "2026-09-14.json"), JSON.stringify({ summary }));
    const ctx = await dayContext(dir, "2026-09-15");
    assert.equal(ctx.prev, "2026-09-14");
    assert.equal(ctx.next, null);
    assert.deepEqual(ctx.previous, {
      date: "2026-09-14",
      summary: { cost_usd: 12.5, busy_ms: 60000, human_prompts: 7, tokens: 900 },
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
