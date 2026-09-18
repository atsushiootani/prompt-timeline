#!/usr/bin/env node
/**
 * prompt-timeline — turn your own Claude Code transcripts into a timeline.
 *
 *   prompt-timeline build   [--date YYYY-MM-DD] [--out-dir out]
 *   prompt-timeline collect [--date YYYY-MM-DD] --out day.json
 *   prompt-timeline render  --in day.json [--out day.html]
 *
 * `build` is collect + render in one go, and is what you normally want.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { pathToFileURL } from "node:url";
import { collect, loadConfig, todayIn, DEFAULT_PROJECTS_DIR } from "../src/collect.mjs";
import { render } from "../src/render.mjs";

const HELP = `prompt-timeline — a timeline of the prompts you typed into Claude Code

Usage
  prompt-timeline build   [options]            collect + render (what you usually want)
  prompt-timeline collect [options] --out FILE  transcripts -> JSON
  prompt-timeline render  --in FILE [--out FILE] JSON -> single-file HTML

Options
  --date YYYY-MM-DD    day to look at (default: today, in your timezone)
  --out FILE           output path
  --out-dir DIR        where build writes (default: out)
  --in FILE            input JSON for render
  --title TEXT         page title
  --config FILE        session names and colours (default: config/agents.json if present)
  --projects-dir DIR   where transcripts live (default: ~/.claude/projects)
  --tz HOURS           fixed UTC offset for display (default: this machine's setting)
  --busy-gap-cap MIN   silence that ends a busy span, in minutes (default: 30)
  --no-text            drop prompt bodies (session and branch names still remain)
  --drop-sdk           also drop SDK / system-injected turns
  -h, --help           show this

Examples
  prompt-timeline build
  prompt-timeline build --date 2026-09-16 --out-dir ~/timelines
  prompt-timeline collect --date 2026-09-16 --no-text --out safe.json
`;

function parseArgs(argv) {
  const opts = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const takesValue = (name) => {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("--")) throw new Error(`${name} needs a value`);
      i += 1;
      return value;
    };
    switch (arg) {
      case "-h": case "--help": opts.help = true; break;
      case "--date": opts.date = takesValue(arg); break;
      case "--out": opts.out = takesValue(arg); break;
      case "--out-dir": opts.outDir = takesValue(arg); break;
      case "--in": opts.in = takesValue(arg); break;
      case "--title": opts.title = takesValue(arg); break;
      case "--config": opts.config = takesValue(arg); break;
      case "--projects-dir": opts.projectsDir = takesValue(arg); break;
      case "--tz": opts.tz = Number(takesValue(arg)); break;
      case "--busy-gap-cap": opts.busyGapCap = Number(takesValue(arg)); break;
      case "--no-text": opts.noText = true; break;
      case "--drop-sdk": opts.dropSdk = true; break;
      default:
        if (arg.startsWith("-")) throw new Error(`unknown option: ${arg}`);
        opts._.push(arg);
    }
  }
  return opts;
}

const expandHome = (p) => (p?.startsWith("~") ? path.join(os.homedir(), p.slice(1)) : p);

async function writeOut(file, contents) {
  await mkdir(path.dirname(path.resolve(file)), { recursive: true });
  await writeFile(file, contents, "utf8");
}

/** Find the config file: the one asked for, else config/agents.json if it exists. */
async function resolveConfig(given) {
  if (given) return loadConfig(expandHome(given));
  const fallback = path.join(path.dirname(new URL(import.meta.url).pathname), "..", "config", "agents.json");
  return loadConfig(fallback);
}

async function runCollect(opts) {
  const config = await resolveConfig(opts.config);
  if (opts.tz !== undefined && Number.isNaN(opts.tz)) throw new Error("--tz must be a number, e.g. --tz 9");
  if (opts.busyGapCap !== undefined && !(opts.busyGapCap >= 0)) {
    throw new Error("--busy-gap-cap must be a number of minutes, e.g. --busy-gap-cap 30");
  }
  const data = await collect({
    date: opts.date,
    projectsDir: expandHome(opts.projectsDir) ?? DEFAULT_PROJECTS_DIR,
    config,
    tz: opts.tz ?? null,
    includeText: !opts.noText,
    dropSdk: Boolean(opts.dropSdk),
    ...(opts.busyGapCap !== undefined ? { busyGapCapMinutes: opts.busyGapCap } : {}),
  });
  return data;
}

function report(data) {
  const sessions = Object.keys(data.summary.by_session).length;
  const busy = Math.round((data.summary.busy_ms ?? 0) / 60000);
  console.log(
    `human=${data.summary.human_prompts} slash=${data.summary.slash_commands} sessions=${sessions} busy=${busy}m`,
  );
  if (data.summary.human_prompts === 0) {
    console.log("nothing found for that day — check --date, or --projects-dir if your transcripts live elsewhere");
  }
}

async function cmdCollect(opts) {
  if (!opts.out) throw new Error("collect needs --out FILE");
  const data = await runCollect(opts);
  await writeOut(opts.out, `${JSON.stringify(data, null, 2)}\n`);
  console.log(`saved: ${opts.out}`);
  report(data);
}

async function cmdRender(opts) {
  if (!opts.in) throw new Error("render needs --in FILE");
  const data = JSON.parse(await readFile(opts.in, "utf8"));
  const out = opts.out ?? `${opts.in.replace(/\.json$/, "")}.html`;
  await writeOut(out, await render(data, { title: opts.title }));
  console.log(`saved: ${out}`);
  console.log(`open:  ${pathToFileURL(path.resolve(out)).href}`);
}

async function cmdBuild(opts) {
  const data = await runCollect(opts);
  const dir = expandHome(opts.outDir) ?? "out";
  const day = data.date ?? todayIn(opts.tz ?? null);
  const jsonPath = opts.out ?? path.join(dir, `${day}.json`);
  const htmlPath = jsonPath.replace(/\.json$/, "") + ".html";

  await writeOut(jsonPath, `${JSON.stringify(data, null, 2)}\n`);
  await writeOut(htmlPath, await render(data, { title: opts.title }));

  console.log(`saved: ${jsonPath}`);
  console.log(`saved: ${htmlPath}`);
  console.log(`open:  ${pathToFileURL(path.resolve(htmlPath)).href}`);
  report(data);
}

async function main(argv) {
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (err) {
    console.error(err.message);
    process.exit(2);
  }
  const command = opts._[0] ?? "build";
  if (opts.help || command === "help") {
    console.log(HELP);
    return;
  }
  const commands = { build: cmdBuild, collect: cmdCollect, render: cmdRender };
  const run = commands[command];
  if (!run) {
    console.error(`unknown command: ${command}\n`);
    console.error(HELP);
    process.exit(2);
  }
  try {
    await run(opts);
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}

main(process.argv.slice(2));
