#!/usr/bin/env node
// Loads t3+ every time T3 Code starts, on Windows (launchd's part on macOS).
//   node ~/.t3plus/windows/startup.mjs on       start now, and at every sign-in
//   node ~/.t3plus/windows/startup.mjs off      stop, and no longer start
//   node ~/.t3plus/windows/startup.mjs status
// A shortcut in the user's Startup folder (Task Manager lists it under Startup apps; no
// administrator rights) starts the watcher below, which runs autostart.mjs each time T3
// rewrites <T3's home>/userdata/server-runtime.json, as it does at every launch.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, realpathSync, rmSync, statSync, watch as watchDir } from "node:fs";
import { connect, createServer } from "node:net";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { t3Home } from "../autostart.mjs";
import { powershell, WINDOWS } from "../platform.mjs";

const SELF = fileURLToPath(import.meta.url);
const HOME = join(homedir(), ".t3plus");
const RUNTIME = "server-runtime.json";
// One watcher per user: the pipe is the lock, gone with its process however that ends. It is
// also how `off` reaches it. Named after the home folder, so users do not share one.
export const PIPE = `\\\\.\\pipe\\t3plus-startup-${createHash("sha256").update(homedir().toLowerCase()).digest("hex").slice(0, 16)}`;

const startupFolder = () => join(process.env.APPDATA || join(homedir(), "AppData", "Roaming"), "Microsoft", "Windows", "Start Menu", "Programs", "Startup");
export const shortcutPath = () => join(startupFolder(), "t3plus.lnk");
// A console program without its console window.
const conhost = () => join(process.env.SystemRoot || "C:\\Windows", "System32", "conhost.exe");
// The Node itself, not a version manager's per-shell link to it, which goes with the shell.
const node = () => realpathSync(process.execPath);

/** Asks the watcher to stop (`say` "stop") or just whether it is there: true when one answered. */
export function ask(say = "", pipe = PIPE) {
  return new Promise((resolve) => {
    const socket = connect(pipe);
    const done = (answer) => {
      clearTimeout(timer);
      socket.destroy();
      resolve(answer);
    };
    const timer = setTimeout(() => done(false), 2000);
    socket.once("connect", () => socket.write(`${say || "hello"}\n`));
    socket.once("data", () => done(true));
    socket.once("error", () => done(false));
    socket.once("close", () => done(false));
  });
}

/**
 * Calls `run` (which resolves when its work is done) each time `file` in `dir` is rewritten, and
 * once at the start if it is there: one at a time, and once more when it was rewritten meanwhile.
 * A folder that is not there yet (T3 never ran) is waited for. Returns a function that stops it.
 */
export function onRewrite(dir, file, run, { settle = 500, retry = 30_000 } = {}) {
  let stopped = false;
  let watcher = null;
  let timer = null;
  let retryTimer = null;
  let running = false;
  let again = false;
  let seen = null; // when the file was last written, as of the last run
  const written = () => { try { return statSync(join(dir, file)).mtimeMs; } catch { return null; } };
  async function go() {
    if (stopped) return;
    if (running) {
      again = true;
      return;
    }
    const at = written();
    if (at === null || at === seen) return; // removed (T3 quit), or an event about nothing new
    seen = at;
    running = true;
    try { await run(); } catch {}
    running = false;
    if (again) {
      again = false;
      go();
    }
  }
  const soon = () => {
    clearTimeout(timer);
    timer = setTimeout(go, settle);
  };
  const lost = () => {
    try { watcher?.close(); } catch {}
    watcher = null;
    clearTimeout(retryTimer);
    if (!stopped) retryTimer = setTimeout(start, retry);
  };
  function start() {
    if (stopped) return;
    try {
      watcher = watchDir(dir, (_event, name) => { if (name === null || name === file) soon(); });
      watcher.on("error", lost); // the folder is gone, or became unreadable
      soon();
    } catch {
      lost();
    }
  }
  start();
  return () => {
    stopped = true;
    clearTimeout(timer);
    clearTimeout(retryTimer);
    try { watcher?.close(); } catch {}
  };
}

function watcher() {
  mkdirSync(join(HOME, "state"), { recursive: true });
  const server = createServer((socket) => {
    socket.on("error", () => {});
    socket.once("data", (data) => {
      socket.end("ok\n");
      if (String(data).trim() === "stop") setTimeout(() => process.exit(0), 100);
    });
  });
  server.on("error", () => process.exit(0)); // one is running already
  server.listen(PIPE, () => {
    // Its own process each time: what it loads is then always the current version's.
    onRewrite(join(t3Home(), "userdata"), RUNTIME, () => new Promise((resolve) => {
      const child = spawn(process.execPath, [join(dirname(SELF), "..", "autostart.mjs")], { stdio: "ignore", windowsHide: true });
      child.once("error", resolve);
      child.once("exit", resolve);
    }));
  });
}

async function on() {
  // Through the environment: no path is ever part of the script.
  powershell(`$s = (New-Object -ComObject WScript.Shell).CreateShortcut($env:T3PLUS_LNK)
$s.TargetPath = $env:T3PLUS_CONHOST; $s.Arguments = $env:T3PLUS_ARGS; $s.WorkingDirectory = $env:T3PLUS_DIR
$s.Description = 'Loads t3+ when T3 Code starts'; $s.WindowStyle = 7; $s.Save()`, {
    env: { T3PLUS_LNK: shortcutPath(), T3PLUS_CONHOST: conhost(), T3PLUS_ARGS: `--headless "${node()}" "${SELF}" watch`, T3PLUS_DIR: dirname(SELF) },
  });
  if (!existsSync(shortcutPath())) throw new Error("the Startup shortcut could not be made");
  await ask("stop"); // an older version's
  for (let i = 0; i < 20 && (await ask()); i += 1) await new Promise((r) => setTimeout(r, 100));
  // Started the way sign-in starts it (conhost spawned detached from here does not come up).
  powershell("Start-Process -FilePath $env:T3PLUS_LNK", { env: { T3PLUS_LNK: shortcutPath() } });
  let up = false;
  for (let i = 0; i < 50 && !(up = await ask()); i += 1) await new Promise((r) => setTimeout(r, 100));
  if (!up) throw new Error("the watcher did not start");
  console.log("t3+ loads whenever T3 Code starts, from now on and after every sign-in");
}
async function off() {
  rmSync(shortcutPath(), { force: true });
  const was = await ask("stop");
  console.log(was ? "stopped, and no longer started at sign-in" : "no longer started at sign-in (it was not running)");
}

async function main([cmd = "status"]) {
  if (!WINDOWS) throw new Error("this is for Windows (on macOS: launchd, see the README)");
  if (cmd === "on") await on();
  else if (cmd === "off") await off();
  else if (cmd === "watch") watcher();
  else if (cmd === "status") console.log(`watcher: ${(await ask()) ? "running" : "not running"}\nat sign-in: ${existsSync(shortcutPath()) ? "yes" : "no"}`);
  else throw new Error(`unknown command ${cmd} (on, off or status)`);
}
// Run as a script, not imported (the tests import the parts above).
const isMain = (() => { try { return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href; } catch { return false; } })();
if (isMain) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(`t3+: ${String((error && error.message) || error)}`);
    process.exitCode = 1;
  });
}
