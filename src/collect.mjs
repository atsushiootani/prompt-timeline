/**
 * Collect the prompts *you* typed into Claude Code on a given day.
 *
 * Reads only the transcripts Claude Code keeps on your own machine
 * (`~/.claude/projects/<project>/<session>.jsonl`). Nothing is uploaded and no
 * network call is made.
 *
 * What counts as "a prompt you typed":
 *   `type === "user"` records, minus everything the machine injected — tool results,
 *   `isMeta`, pure `<system-reminder>` lines, `<local-command-stdout>`, agent-to-agent
 *   messages, task notifications, bash I/O, continuation summaries, interrupts and
 *   sub-agent turns. Slash commands are counted separately.
 *
 * Session naming falls back in this order, so it works on any machine:
 *   1. `agentName` / `customTitle` recorded in the transcript
 *   2. a `sessionLabel` rule from the config file
 *   3. the first 8 characters of the session UUID
 */
import { createReadStream } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import path from "node:path";
import os from "node:os";

export const DEFAULT_PROJECTS_DIR = path.join(os.homedir(), ".claude", "projects");

const pad = (n) => String(n).padStart(2, "0");

/** Split an ISO timestamp into local (or fixed-offset) date and time parts. */
export function localParts(iso, tzOffsetHours) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  if (tzOffsetHours == null) {
    return {
      date: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`,
      time: `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`,
    };
  }
  const shifted = new Date(d.getTime() + tzOffsetHours * 3600 * 1000);
  return {
    date: `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())}`,
    time: `${pad(shifted.getUTCHours())}:${pad(shifted.getUTCMinutes())}:${pad(shifted.getUTCSeconds())}`,
  };
}

/** Today's date in the target timezone. */
export function todayIn(tzOffsetHours) {
  return localParts(new Date().toISOString(), tzOffsetHours).date;
}

/**
 * UTC dates that can hold records belonging to one local day. A local day never
 * reaches further than the day before or after in UTC, so these three prefixes
 * are enough to pre-filter lines cheaply before parsing them.
 */
function candidateDates(day) {
  const base = new Date(`${day}T12:00:00Z`).getTime();
  return [-1, 0, 1].map((offset) => new Date(base + offset * 86400000).toISOString().slice(0, 10));
}

export function classify(text) {
  if (text.includes("Another Claude session sent a message") || text.includes("<teammate-message")) return "teammate";
  if (text.startsWith("<task-notification>")) return "task_notif";
  if (text.startsWith("<bash-input>") || text.startsWith("<bash-stdout>") || text.startsWith("<bash-stderr>")) return "bash_io";
  if (text.startsWith("This session is being continued")) return "continuation";
  if (text.startsWith("[Request interrupted")) return "interrupt";
  if (text.includes("<command-name>") || text.includes("<command-message>")) return "slash";
  return "human";
}

/** Pull the human-typed body out of a user record, or null if it is not one. */
export function userText(obj) {
  if (obj.type !== "user" || obj.isMeta || obj.isSidechain) return null;
  const content = obj.message?.content;
  let text;
  if (typeof content === "string") {
    text = content;
  } else if (Array.isArray(content)) {
    // A tool_result anywhere means this is a tool's return value, not something a person typed.
    for (const item of content) if (item?.type === "tool_result") return null;
    text = content.filter((i) => i?.type === "text").map((i) => i.text ?? "").join("\n");
  } else {
    return null;
  }
  text = text.trim();
  if (!text || text.includes("<local-command-stdout>") || text.startsWith("Caveat:")) return null;
  if (text.startsWith("<system-reminder>") && text.endsWith("</system-reminder>")) return null;
  return text;
}

export async function loadConfig(configPath) {
  if (!configPath) return {};
  try {
    return JSON.parse(await readFile(configPath, "utf8")) ?? {};
  } catch (err) {
    if (err.code === "ENOENT") return {};
    throw new Error(`config could not be read (${configPath}): ${err.message}`);
  }
}

async function listTranscripts(root) {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (err) {
    if (err.code === "ENOENT") return [];
    throw err;
  }
  const files = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === "subagents") continue;
    const dir = path.join(root, entry.name);
    for (const name of await readdir(dir)) {
      if (name.endsWith(".jsonl")) files.push(path.join(dir, name));
    }
  }
  return files.sort();
}

/** Read one transcript, returning the day's records plus whatever names it carries. */
async function scanFile(file, day, prefixes, tz, labelPattern) {
  const rows = [];
  const meta = { cwd: null, agentName: null, sessionId: null, ruleHits: new Map(), file };
  const cheapKeys = prefixes.map((p) => `"${p}`);

  const rl = createInterface({
    input: createReadStream(file, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });
  try {
    for await (const line of rl) {
      if (!line) continue;
      const mayHaveDate = cheapKeys.some((key) => line.includes(key));
      const mayHaveName = line.includes('"agent-name"') || line.includes('"custom-title"');
      if (!mayHaveDate && !mayHaveName) continue;

      let obj;
      try {
        obj = JSON.parse(line);
      } catch {
        continue;
      }
      meta.sessionId ??= obj.sessionId ?? null;
      if (obj.type === "agent-name" && obj.agentName) { meta.agentName ??= obj.agentName; continue; }
      if (obj.type === "custom-title" && obj.customTitle) { meta.agentName ??= obj.customTitle; continue; }
      if (!mayHaveDate || !obj.timestamp) continue;

      // Filter on the *local* date, not the raw UTC prefix, so "a day" is the day you lived.
      const parts = localParts(obj.timestamp, tz);
      if (!parts || parts.date !== day) continue;
      meta.cwd ??= obj.cwd ?? null;

      if (labelPattern) {
        for (const match of line.matchAll(labelPattern)) {
          const captured = match[1] ?? match[0];
          meta.ruleHits.set(captured, (meta.ruleHits.get(captured) ?? 0) + 1);
        }
      }
      const text = userText(obj);
      if (text === null) continue;
      rows.push({
        time: parts.time,
        text,
        promptSource: obj.promptSource ?? null,
        branch: obj.gitBranch ?? null,
      });
    }
  } finally {
    rl.close();
  }
  return { rows, meta };
}

function sessionLabel(meta, cfg) {
  if (meta.agentName) return meta.agentName;
  const names = cfg.sessionLabel?.names ?? {};
  if (meta.ruleHits.size) {
    const [captured] = [...meta.ruleHits.entries()].sort((a, b) => b[1] - a[1])[0];
    if (captured in names) return names[captured];
    if (captured) return String(captured);
  }
  const id = meta.sessionId ?? path.basename(meta.file, ".jsonl");
  return id ? id.slice(0, 8) : "unknown";
}

function workspaceLabel(meta, cfg) {
  if (!meta.cwd) return "";
  const base = path.basename(meta.cwd.replace(/\/+$/, ""));
  return cfg.workspaceAlias?.[base] ?? base;
}

export async function collect(options = {}) {
  const {
    date,
    projectsDir = DEFAULT_PROJECTS_DIR,
    config = {},
    tz = null,
    includeText = true,
    dropSdk = false,
  } = options;

  const day = date ?? todayIn(tz);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new Error(`date must look like YYYY-MM-DD, got: ${day}`);

  const root = projectsDir.startsWith("~")
    ? path.join(os.homedir(), projectsDir.slice(1))
    : projectsDir;
  const files = await listTranscripts(root);
  if (!files.length) throw new Error(`no transcripts found under ${root}`);

  const labelPattern = config.sessionLabel?.pattern ? new RegExp(config.sessionLabel.pattern, "g") : null;
  const prefixes = candidateDates(day);

  const seen = new Set();
  const counts = new Map();
  const human = [];
  const slash = [];
  const bump = (key) => counts.set(key, (counts.get(key) ?? 0) + 1);

  for (const file of files) {
    const { rows, meta } = await scanFile(file, day, prefixes, tz, labelPattern);
    if (!rows.length) continue;
    const agent = sessionLabel(meta, config);
    const workspace = workspaceLabel(meta, config);
    const session = workspace ? `${workspace}.${agent}` : agent;

    for (const row of rows) {
      // The same conversation can show up in several files (resume / mirrored sessions).
      const key = `${row.time}\n${row.text.slice(0, 80)}`;
      if (seen.has(key)) continue;
      seen.add(key);

      const kind = classify(row.text);
      bump(kind);
      if (dropSdk && (row.promptSource === "sdk" || row.promptSource === "system")) {
        bump("sdk_filtered");
        continue;
      }
      if (kind === "human") {
        const record = { time: row.time, session, workspace, agent };
        if (includeText) record.text = row.text;
        record.chars = row.text.length;
        if (row.branch) record.branch = row.branch;
        human.push(record);
      } else if (kind === "slash") {
        const m = row.text.match(/<command-name>\s*([^<]+)/) ?? row.text.match(/<command-message>\s*([^<]+)/);
        slash.push({ time: row.time, session, workspace, agent, command: m ? m[1].trim() : "?" });
      }
    }
  }

  human.sort((a, b) => a.time.localeCompare(b.time));
  slash.sort((a, b) => a.time.localeCompare(b.time));

  const bySession = {};
  for (const row of human) bySession[row.session] = (bySession[row.session] ?? 0) + 1;

  return {
    date: day,
    generatedAt: new Date().toISOString(),
    note: "Prompts typed by a human. Mirrored sessions de-duplicated; machine-injected turns excluded. session = <workspace>.<agent>.",
    summary: {
      human_prompts: human.length,
      slash_commands: slash.length,
      by_session: Object.fromEntries(Object.entries(bySession).sort((a, b) => b[1] - a[1])),
      excluded: Object.fromEntries(
        ["teammate", "task_notif", "bash_io", "continuation", "interrupt", "sdk_filtered"]
          .map((key) => [key, counts.get(key) ?? 0]),
      ),
    },
    agents: config.agents ?? {},
    human_prompts: human,
    slash_commands: slash,
  };
}
