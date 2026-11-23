#!/usr/bin/env node
// t3+ inside the T3 Code desktop app.
//   node ~/.t3plus/t3plus.mjs on       inject into the running app (repeat after each app launch)
//   node ~/.t3plus/t3plus.mjs off      remove it and reload the app window
//   node ~/.t3plus/t3plus.mjs status   show windows and the loader's log
// It briefly opens Node's inspector on 127.0.0.1:9229 in the app's main process and closes it again.
import { readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { mainPids, openInspector } from "./platform.mjs";

const HOME = join(homedir(), ".t3plus");
// Where T3's inspector opens when asked to: Node's default port (another one only for the tests' stand-in app).
const PORT = Number(process.env.T3PLUS_INSPECTOR_PORT) || 9229;
// How long T3 has to open its inspector once signalled (its main thread may be busy at launch:
// a dialog, a menu; a wait past the first seconds is said), until when one that opens later is
// still looked for (to close it), and when this script gives up altogether.
const OPEN_QUIET_MS = 5_000;
const OPEN_WAIT_MS = 30_000;
const LATE_OPEN_MS = 40_000;
const GIVE_UP_MS = 45_000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Closes T3's inspector from inside it, once the reply is out. `require` is the inspector's
 * command-line API, there only while an evaluation runs (T3's main module has no global one),
 * so the inspector module is taken at once, never inside a timer.
 */
export const CLOSE_INSPECTOR = "(() => { clearTimeout(globalThis.__t3plusInspectorTimer); const i = require('inspector'); setTimeout(() => i.close(), 50); return 0; })()";
/**
 * A dead man's switch inside T3: it closes its inspector itself `ms` from now, whatever happens
 * to this script (a hang, a kill -9). A previous run's timer is replaced, so it cannot cut this run short.
 */
export const deadMansSwitch = (ms) =>
  `(() => { const i = require('inspector'); clearTimeout(globalThis.__t3plusInspectorTimer); globalThis.__t3plusInspectorTimer = setTimeout(() => { try { i.close(); } catch {} }, ${Math.max(0, Math.floor(ms))}); return 0; })()`;

function mainPid() {
  const hits = mainPids();
  if (hits.length !== 1) throw new Error(`expected one running T3 Code app, found ${hits.length}`);
  return hits[0];
}
/**
 * The inspector's targets on the port: null when nothing is there, [] when what is there gives
 * no inspector's list (it never answers, or answers something else). Either way at once: a
 * listener that never answers must not hang this script, nor autostart behind it.
 */
export async function targets(port = PORT) {
  try {
    const list = await (await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(1500) })).json();
    return Array.isArray(list) ? list : [];
  } catch (error) {
    return error?.name === "TimeoutError" || error instanceof SyntaxError ? [] : null;
  }
}
/** The targets once an inspector answers, or null at `until` (a Date.now() time). */
async function targetsBy(until) {
  let list = await targets();
  while (!list && Date.now() < until) {
    await sleep(100);
    list = await targets();
  }
  return list;
}
// T3's inspector names its process: "<…>/T3 Code (Nightly)[<pid>]". Anything else
// on the port (a "node --inspect" session, another Electron app) is not ours to
// inject into, nor to close.
export const isT3 = (list, pid) => Array.isArray(list) && list.length > 0 && list.every((t) => String(t.title ?? "").endsWith(`[${pid}]`));
const owner = (list) => String(list[0]?.title ?? "not an inspector").slice(0, 120);
/** A WebSocket to `url` once it is open; an error, or no answer within `ms`, fails it. */
function openSocket(url, ms) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const timer = setTimeout(() => {
      ws.close();
      reject(new Error("inspector connection timed out"));
    }, ms);
    ws.onopen = () => {
      clearTimeout(timer);
      resolve(ws);
    };
    ws.onerror = () => {
      clearTimeout(timer);
      reject(new Error("inspector connection failed"));
    };
  });
}
// Set once T3 was asked to open it, so every way out closes the inspector it opened, and
// only that one: never another process's, never one this script did not open.
let signalled = null; // { pid, at }: T3's pid and when it was signalled
let opened = null; // the target list of the inspector that opened
/** Closes T3's inspector without a live connection (a failed connect, a signal). */
async function closeOpened() {
  if (signalled === null) return;
  // T3 may open it only after this script gave up waiting: it is looked for a little longer.
  const list = opened ?? (await targetsBy(signalled.at + LATE_OPEN_MS));
  opened = null;
  if (!isT3(list, signalled.pid) || !list[0].webSocketDebuggerUrl) return;
  try {
    const ws = await openSocket(list[0].webSocketDebuggerUrl, 2000);
    ws.send(JSON.stringify({ id: 1, method: "Runtime.evaluate", params: { expression: CLOSE_INSPECTOR, includeCommandLineAPI: true } }));
    await sleep(150);
    ws.close();
  } catch {}
}
async function connect() {
  // Checked before T3's inspector is opened: without WebSocket (Node before 22) it
  // could be opened but never used, nor closed again.
  if (typeof WebSocket !== "function" || typeof fetch !== "function") throw new Error(`t3+ needs Node 22 or newer (this is ${process.version})`);
  const pid = mainPid();
  let list = await targets();
  if (list && !isT3(list, pid)) throw new Error(`port ${PORT} belongs to another process (${owner(list)}), not T3 Code (pid ${pid})`);
  if (!list) {
    openInspector(pid);
    signalled = { pid, at: Date.now() };
    list = await targetsBy(signalled.at + OPEN_QUIET_MS);
    if (!list) {
      console.error("t3+: T3 Code has not opened its inspector yet (busy?), waiting a little longer");
      list = await targetsBy(signalled.at + OPEN_WAIT_MS);
    }
    if (list && !isT3(list, pid)) throw new Error(`port ${PORT} was taken by another process (${owner(list)})`);
    if (list?.length) opened = list;
  }
  if (!list?.length) throw new Error("the app's inspector did not open");
  const ws = await openSocket(list[0].webSocketDebuggerUrl, 5000);
  let id = 0;
  const pending = new Map();
  ws.onmessage = (ev) => {
    let m;
    try { m = JSON.parse(ev.data); } catch { return; }
    const settle = m && pending.get(m.id);
    if (!settle) return;
    pending.delete(m.id);
    settle(m);
  };
  // T3 quit, or its inspector closed: whatever still waits fails now, not at the give-up.
  ws.onclose = () => {
    for (const settle of pending.values()) settle({ error: { message: "the inspector connection closed" } });
    pending.clear();
  };
  const evaluate = (expression) => new Promise((resolve, reject) => {
    const n = (id += 1);
    pending.set(n, (m) => {
      const r = m.result;
      if (m.error || r?.exceptionDetails) reject(new Error(m.error?.message ?? r.exceptionDetails.exception?.description ?? r.exceptionDetails.text));
      else resolve(r.result.value);
    });
    ws.send(JSON.stringify({ id: n, method: "Runtime.evaluate", params: { expression, includeCommandLineAPI: true, awaitPromise: true, returnByValue: true } }));
  });
  const close = async () => { try { ws.send(JSON.stringify({ id: 9e6, method: "Runtime.evaluate", params: { expression: CLOSE_INSPECTOR, includeCommandLineAPI: true } })); await sleep(150); } catch {} ws.close(); };
  // Without T3's own safety net the inspector is not used at all: closed again at once.
  try {
    await evaluate(deadMansSwitch(GIVE_UP_MS));
  } catch (error) {
    await close();
    throw new Error(`could not arm the inspector's safety timer, so it was closed again (${error.message})`);
  }
  return { evaluate, close };
}

// The app's inspector is closed again however this script ends: a kill (autostart's
// timeout), Ctrl+C, or a command that hangs. Left open, any local process could run
// code inside T3 Code.
let c = null;
let closing = null;
function shutdown(code) {
  // Out within a few seconds, even when closing stalls.
  setTimeout(() => process.exit(code), 3000).unref();
  closing ??= (async () => {
    try { if (c) await c.close(); else await closeOpened(); } catch {}
    process.exit(code);
  })();
}

const LIST = `JSON.stringify(require("electron").webContents.getAllWebContents().map((w) => ({ id: w.id, type: w.getType(), url: w.getURL().slice(0, 80) })))`;
const COMMANDS = new Set(["on", "off", "status", "eval", "page"]);
async function run(cmd, args) {
  if (cmd === "eval") console.log(await c.evaluate(args[0]));
  else if (cmd === "page") {
    // dev: run a file's code as an async function body in the app window; optional screenshot afterwards
    const body = readFileSync(args[0], "utf8");
    const shot = args[1] ?? "";
    const wait = Number(args[2] ?? 0);
    console.log(await c.evaluate(`(async () => { const e = require("electron"); const fs = require("fs");
      const wc = e.webContents.getAllWebContents().find((w) => w.getType() === "window" && w.getURL().startsWith("t3code://app"));
      const r = await wc.executeJavaScript(${JSON.stringify(`(async () => { ${body}
 })()`)});
      if (${JSON.stringify(wait)}) await new Promise((res) => setTimeout(res, ${JSON.stringify(wait)}));
      if (${JSON.stringify(shot)}) fs.writeFileSync(${JSON.stringify(shot)}, (await wc.capturePage()).toPNG());
      return typeof r === "string" ? r : JSON.stringify(r); })()`));
  }
  else if (cmd === "status") {
    console.log("windows:", await c.evaluate(LIST));
    console.log("loader:", await c.evaluate(`globalThis.__t3plus ? JSON.stringify({ injected: [...globalThis.__t3plus.injected], log: globalThis.__t3plus.log.slice(-12) }) : "not loaded"`));
  } else if (cmd === "off") console.log(await c.evaluate(`globalThis.__t3plus ? globalThis.__t3plus.dispose(true) : "not loaded"`));
  else if (cmd === "on") {
    const list = JSON.parse(await c.evaluate(LIST));
    // T3's own window first (t3code://): a sign-in popup is a window with an http(s)
    // page, and taking it would put t3+ and its data into that page.
    const app = (w) => w.type === "window" && /^(t3code|t3):/.test(w.url);
    const win = list.find(app) ?? list.find((w) => w.type === "window" && /^https?:/.test(w.url));
    if (!win) throw new Error(`no app window found: ${JSON.stringify(list)}`);
    const origin = args[0] ?? new URL(win.url).origin;
    const loader = readFileSync(join(HOME, "inject/main-loader.js"), "utf8").replace("__APP_ORIGIN__", JSON.stringify(origin === "null" ? win.url.split("/").slice(0, 3).join("/") : origin));
    const result = await c.evaluate(loader);
    console.log("app origin:", origin, "->", result);
    // A window that could not be loaded is a failure (autostart reads stderr for the reason).
    if (/:error\b/.test(String(result))) throw new Error(`could not load: ${result}`);
  }
}
async function main([cmd = "status", ...args]) {
  // Before anything opens T3's inspector: a mistyped command does not open it for nothing.
  if (!COMMANDS.has(cmd)) throw new Error(`unknown command ${cmd} (on, off or status)`);
  for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"]) process.on(sig, () => shutdown(1));
  setTimeout(() => { console.error("t3+: gave up after 45 s"); shutdown(1); }, GIVE_UP_MS).unref();
  try {
    c = await connect();
  } catch (error) {
    await closeOpened();
    throw error;
  }
  try {
    await run(cmd, args);
  } finally {
    await c.close();
  }
}

// Run as a script, not imported (the tests import the parts above).
const isMain = (() => { try { return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href; } catch { return false; } })();
if (isMain) {
  main(process.argv.slice(2)).catch((error) => {
    // One line with the reason, which autostart reports: an uncaught error ended with Node's version banner.
    console.error(`t3+: ${String((error && error.message) || error)}`);
    process.exitCode = 1;
  });
}
