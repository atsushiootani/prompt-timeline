/**
 * Connect a day to the days around it, using whatever else is in the same output folder.
 *
 * This is render-time context, not collected data: it is injected into the page and never
 * written back into the day's JSON, so a day's file stays the same no matter what is
 * built next to it.
 */
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

const DAY_FILE = /^(\d{4}-\d{2}-\d{2})\.json$/;

/** Dates that have a JSON in `dir`, oldest first. */
export async function listDays(dir) {
  let names;
  try {
    names = await readdir(dir);
  } catch (err) {
    if (err.code === "ENOENT") return [];
    throw err;
  }
  return names.map((n) => n.match(DAY_FILE)?.[1]).filter(Boolean).sort();
}

/** The nearest earlier and later day that exist — not ±1, because weekends happen. */
export function neighbours(days, day) {
  let prev = null;
  let next = null;
  for (const d of days) {
    if (d < day) prev = d;
    else if (d > day && next === null) next = d;
  }
  return { prev, next };
}

/** What the page needs to link to its neighbours and compare against the previous day. */
export async function dayContext(dir, day) {
  const { prev, next } = neighbours(await listDays(dir), day);
  let previous = null;
  if (prev) {
    try {
      const s = JSON.parse(await readFile(path.join(dir, `${prev}.json`), "utf8")).summary ?? {};
      previous = {
        date: prev,
        summary: {
          cost_usd: s.cost_usd ?? 0,
          busy_ms: s.busy_ms ?? 0,
          human_prompts: s.human_prompts ?? 0,
          tokens: s.tokens ?? 0,
        },
      };
    } catch {
      // A neighbour that cannot be read still gets a link; it just isn't compared against.
    }
  }
  return { prev, next, previous };
}
