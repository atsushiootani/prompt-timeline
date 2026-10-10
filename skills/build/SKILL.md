---
name: build
description: Build a one-page view of a day of your own Claude Code work from the transcripts on this machine — API-equivalent spend, agent busy time, an hour-by-hour chart, sessions ranked by cost or tokens, and the day's moments (longest run, priciest prompt, tightest retry loop). Use for "build my prompt timeline", "how much did I spend today", "which session ate my day", "show me last week", 「プロンプトのタイムラインを作って」「今日どれだけ使ったか見たい」「先週を振り返りたい」.
---

# Build a prompt timeline

Reads `~/.claude/projects/*/*.jsonl` — the transcripts Claude Code already keeps on this machine —
and writes one self-contained HTML page per day. Nothing leaves the machine: no network call is
made, and the page fetches nothing when opened.

Needs **Node 18 or newer**. There is nothing to install.

Every command below uses the same output folder, `${CLAUDE_PLUGIN_DATA}/out`. Keep it that way:
days built into one folder link to each other (‹ prev / next ›) and each day's headline figures
are compared with the previous day found there. The folder survives plugin updates.

## 1. Work out the day

Use the date the user asked for. With none, the default is today in this machine's timezone.
Turn "yesterday", "last Friday" and the like into `YYYY-MM-DD` with `date` first:

```bash
date -v-1d +%F          # macOS, yesterday
date -d yesterday +%F   # Linux, yesterday
```

For "this week" / "last N days", use `--last N` instead of a date.

## 2. Build

**First check whether this is the first run** — the day links and day-over-day comparisons
need other days in the folder:

```bash
ls "${CLAUDE_PLUGIN_DATA}/out" 2>/dev/null | grep -c '\.json$'
```

If that prints `0` (or nothing), **keep `--date` and add `--last 7`**. That builds the week
ending on the requested day, so the day the user asked for is still built — plus the six before
it. Do this even when the user asked for a single day; tell them you built the week so the
comparisons work. Each day takes a few seconds.

Then build:

```bash
node "${CLAUDE_PLUGIN_ROOT}/bin/prompt-timeline.mjs" build \
  --out-dir "${CLAUDE_PLUGIN_DATA}/out" \
  --config "${CLAUDE_PLUGIN_DATA}/agents.json" \
  --date 2026-09-16
```

The last lines report what was found:

```
saved: …/out/2026-09-16.html
open:  file:///…/out/2026-09-16.html
human=42 slash=6 sessions=5 busy=315m
```

Tell the user those counts. `human=0` means no prompts were recorded that day — check the date
before anything else, then `--projects-dir` if their transcripts live somewhere unusual.

## 3. Open it

```bash
open "<the html path>"      # macOS; xdg-open on Linux
```

Reply with the `file://` path and the counts. What the page shows, top to bottom:

- **Spend, busy time, prompts** — each with the change against the previous day in the folder
- **Hour by hour** — stacked by session, with the busiest hour and the most agents running at once
- **Sessions ranked** by cost, tokens or prompts (*size by* switches all three views)
- **The timeline** — a dot per prompt sized by its cost, a line for how long the agent stayed on
  it; hours where nothing ran fold into a thin band
- **Moments** — longest run, priciest prompt, longest prompt written, tightest retry loop.
  Clicking one (or any dot) opens the full prompt at the bottom of the screen

## Options

| To | Add |
|---|---|
| Drop prompt bodies (session and branch names remain) | `--no-text` |
| Also drop SDK / system-injected turns | `--drop-sdk` |
| Read transcripts from somewhere else | `--projects-dir <path>` |
| Pin the timezone | `--tz 9` |
| Change how long a silence ends a busy span | `--busy-gap-cap <minutes>` (default 30) |
| Name sessions or pick colours | write `${CLAUDE_PLUGIN_DATA}/agents.json` — see `${CLAUDE_PLUGIN_ROOT}/config/agents.example.json` |

`node "${CLAUDE_PLUGIN_ROOT}/bin/prompt-timeline.mjs" --help` lists everything, including
separate `collect` and `render` steps.

## Before the page goes anywhere

- **It contains the prompts verbatim.** Before the user shares it, say so, and offer to rebuild
  with `--no-text`. Even then, session, workspace and branch names remain.
- Dollar figures are **API-equivalent**, not a bill — a Claude Code subscription is not charged
  per token. Say "API-equivalent" when you quote them.
- A day is cut on local time: a record at 23:30 UTC belongs to the next day at +09:00.
