#!/usr/bin/env node
// Loads t3+ into T3 Code whenever the app starts. Run by the launch agent
// com.t3plus.autostart, which fires when T3 rewrites ~/.t3/userdata/server-runtime.json
// (it does at every launch). Does nothing if the app is not running or already has t3+.
//   node ~/.t3plus/autostart.mjs [--force]
import { execFileSync, spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const HOME = join(homedir(), ".t3plus");
const STATE = join(HOME, "state");
const LOG = join(STATE, "autostart.log");
const MARK = join(STATE, "injected-app");
const RUNTIME = join(homedir(), ".t3", "userdata", "server-runtime.json");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
mkdirSync(STATE, { recursive: true });
try { if (statSync(LOG).size > 200_000) writeFileSync(LOG, ""); } catch {}
const log = (m) => appendFileSync(LOG, `${new Date().toISOString()} ${m}\n`);
const ps = (...args) => { try { return execFileSync("ps", args, { encoding: "utf8" }); } catch { return ""; } };
/** A macOS notification, so a launch where t3+ could not load does not just look like plain T3. */
function notify(message) {
  const quote = (s) => JSON.stringify(String(s)); // AppleScript strings use the same \" and \\ escapes
  try { execFileSync("osascript", ["-e", `display notification ${quote(message)} with title "t3+"`], { timeout: 10_000 }); } catch {}
}
/** Why loading failed, in plain words, from the CLI's error output. */
function explain(stderr) {
  const text = String(stderr || "");
  if (/inspector did not open/.test(text)) return "T3 Code did not open its debugger port, which t3+ loads through. This T3 version may have turned that off.";
  if (/files missing/.test(text)) return "t3+'s built files are missing. Run ~/.t3plus/build.sh.";
  if (/expected one running T3 Code app/.test(text)) return "More than one T3 Code app is running.";
  const last = text.trim().split("\n").filter(Boolean).pop();
  return last ? last.slice(0, 160) : "unknown error";
}

/** The app's main process: launched by launchd (ppid 1), the app's own binary. Not this
 *  script, which runs on that same binary (ELECTRON_RUN_AS_NODE) when no Node is installed. */
function mainPid() {
  const hits = ps("-axo", "pid=,ppid=,comm=").split("\n").map((l) => l.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/))
    .filter((m) => m && m[2] === "1" && Number(m[1]) !== process.pid && /\/T3 Code[^/]*\.app\/Contents\/MacOS\/T3 Code[^/]*$/.test(m[3]));
  return hits.length === 1 ? Number(hits[0][1]) : null;
}
const identity = (pid) => `${pid}@${ps("-o", "lstart=", "-p", String(pid)).trim()}`;

/** True once the app has started its backend: by then its main process is fully up,
 *  so the debugger signal the loader sends is handled rather than fatal. */
async function backendReady(main) {
  try {
    const rt = JSON.parse(readFileSync(RUNTIME, "utf8"));
    if (Number(ps("-o", "ppid=", "-p", String(rt.pid)).trim()) !== main) return false;
    const res = await fetch(`http://127.0.0.1:${rt.port}/.well-known/t3/environment`, { signal: AbortSignal.timeout(2000) });
    return res.ok;
  } catch {
    return false;
  }
}

const force = process.argv.includes("--force");
let main = null;
for (let i = 0; i < 20 && !(main = mainPid()); i += 1) await sleep(1000);
if (!main) process.exit(0); // the app is not running (it quit, or something else touched the file)
const id = identity(main);
let done = "";
try { done = readFileSync(MARK, "utf8").trim(); } catch {}
if (done === id && !force) process.exit(0); // this launch already has t3+

let ready = false;
for (let i = 0; i < 120 && !(ready = await backendReady(main)); i += 1) {
  await sleep(1000);
  if (mainPid() !== main) { log(`app ${id} went away while starting`); process.exit(0); }
}
if (!ready) {
  log(`app ${id}: backend never came up, giving up`);
  notify("t3+ did not load: T3 Code's server never came up.");
  process.exit(1);
}

let lastError = "";
for (let attempt = 1; attempt <= 40; attempt += 1) {
  const run = spawnSync(process.execPath, [join(HOME, "t3plus.mjs"), "on"], { encoding: "utf8", timeout: 60_000, env: process.env });
  lastError = run.stderr || lastError;
  if (run.status === 0 && /injected/.test(run.stdout)) {
    writeFileSync(MARK, id);
    log(`app ${id}: ${run.stdout.trim().split("\n").pop()} (attempt ${attempt})`);
    process.exit(0);
  }
  if (mainPid() !== main) { log(`app ${id} quit before t3+ loaded`); process.exit(0); }
  await sleep(2000);
}
const reason = explain(lastError);
log(`app ${id}: could not load t3+ after 40 attempts: ${reason}`);
notify(`t3+ did not load. ${reason} Details: ~/.t3plus/state/autostart.log`);
process.exit(1);
