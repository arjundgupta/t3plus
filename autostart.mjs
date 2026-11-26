#!/usr/bin/env node
// Loads t3+ into T3 Code whenever the app starts. Run by the launch agent
// com.t3plus.autostart (on Windows by windows/startup.mjs), which fires when T3 rewrites
// <T3's home>/userdata/server-runtime.json (it does at every launch). Does nothing if the app is not running or already has t3+.
//   node ~/.t3plus/autostart.mjs [--force]
import { spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { identity, mainPids, notify, parentPid, WINDOWS } from "./platform.mjs";

const HOME = join(homedir(), ".t3plus");
const STATE = join(HOME, "state");
const LOG = join(STATE, "autostart.log");
const MARK = join(STATE, "injected-app");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (m) => appendFileSync(LOG, `${new Date().toISOString()} ${m}\n`);
/** Why loading failed, in plain words, from the CLI's error output. */
export function explain(stderr) {
  const text = String(stderr || "");
  if (/inspector did not open/.test(text)) return "T3 Code did not open its debugger port, which t3+ loads through. This T3 version may have turned that off.";
  if (/files missing/.test(text)) return `t3+'s built files are missing. Run ~/.t3plus/${WINDOWS ? "windows/build.mjs" : "build.sh"}.`;
  if (/expected one running T3 Code app/.test(text)) return "More than one T3 Code app is running.";
  if (/port \d+ (belongs to|was taken by) another process/.test(text)) return "Another program is using port 9229 (a Node debugger, maybe). Close it and reopen T3 Code.";
  if (/needs Node 22/.test(text)) return "The Node found for t3+ is older than 22. Install Node 22 or newer.";
  // The CLI's own "t3+: <why>" line, or an error's: an uncaught one ends with Node's version banner.
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  const last = lines.findLast((l) => /^(\w*Error|t3\+):/.test(l)) ?? lines.at(-1);
  return last ? last.slice(0, 160) : "unknown error";
}
/** T3's home as the loader finds it (inject/feeds.js): t3+'s config, else T3CODE_HOME, else ~/.t3. */
export function t3Home(home = HOME) {
  let config = {};
  for (const file of ["config.json", "server/config.local.json"]) {
    try { config = { ...JSON.parse(readFileSync(join(home, file), "utf8")), ...config }; } catch {}
  }
  return config.t3Home || (process.env.T3CODE_HOME || "").trim() || join(homedir(), ".t3");
}

/** The app's main process, when exactly one T3 Code app runs. */
function mainPid() {
  try {
    const hits = mainPids();
    return hits.length === 1 ? hits[0] : null;
  } catch {
    return null;
  }
}

/** True once the app (main process `app`) has started its backend, as `runtimeFile` (T3's
 *  server-runtime.json) names it: by then the app's main process is fully up, so the debugger
 *  signal the loader sends is handled rather than fatal. */
export async function backendReady(app, runtimeFile) {
  try {
    const rt = JSON.parse(readFileSync(runtimeFile, "utf8"));
    if (parentPid(Number(rt.pid)) !== app) return false;
    const res = await fetch(`http://127.0.0.1:${rt.port}/.well-known/t3/environment`, { signal: AbortSignal.timeout(2000) });
    return res.ok;
  } catch {
    return false;
  }
}

async function main() {
  mkdirSync(STATE, { recursive: true });
  try { if (statSync(LOG).size > 200_000) writeFileSync(LOG, ""); } catch {}
  const runtime = join(t3Home(), "userdata", "server-runtime.json");
  const force = process.argv.includes("--force");
  let app = null;
  for (let i = 0; i < 20 && !(app = mainPid()); i += 1) await sleep(1000);
  if (!app) process.exit(0); // the app is not running (it quit, or something else touched the file)
  const id = identity(app);
  let done = "";
  try { done = readFileSync(MARK, "utf8").trim(); } catch {}
  if (done === id && !force) process.exit(0); // this launch already has t3+

  let ready = false;
  for (let i = 0; i < 120 && !(ready = await backendReady(app, runtime)); i += 1) {
    await sleep(1000);
    if (mainPid() !== app) { log(`app ${id} went away while starting`); process.exit(0); }
  }
  if (!ready) {
    log(`app ${id}: backend never came up, giving up`);
    notify("t3+ did not load: T3 Code's server never came up.");
    process.exit(1);
  }

  // Tried for some minutes: an attempt takes seconds, or up to about 45 s while a busy app
  // is slow to open its debugger port.
  const tryUntil = Date.now() + 6 * 60_000;
  let lastError = "";
  let attempt = 0;
  while (Date.now() < tryUntil) {
    attempt += 1;
    const run = spawnSync(process.execPath, [join(HOME, "t3plus.mjs"), "on"], { encoding: "utf8", timeout: 60_000, env: process.env, windowsHide: true });
    lastError = run.stderr || lastError;
    if (run.status === 0 && /injected/.test(run.stdout)) {
      writeFileSync(MARK, id);
      log(`app ${id}: ${run.stdout.trim().split("\n").pop()} (attempt ${attempt})`);
      process.exit(0);
    }
    if (mainPid() !== app) { log(`app ${id} quit before t3+ loaded`); process.exit(0); }
    // Errors that trying again cannot fix: stop now (each try opens T3's debugger port).
    if (/files missing|needs Node 22|belongs to another process/.test(lastError)) break;
    await sleep(2000);
  }
  const reason = explain(lastError);
  log(`app ${id}: could not load t3+ after ${attempt} attempts: ${reason}`);
  notify(`t3+ did not load. ${reason} Details: ~/.t3plus/state/autostart.log`);
  process.exit(1);
}

// Run as a script, not imported (the tests import the parts above).
const isMain = (() => { try { return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href; } catch { return false; } })();
if (isMain) await main();
