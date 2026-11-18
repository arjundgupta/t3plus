#!/usr/bin/env node
// t3+ inside the T3 Code desktop app.
//   node ~/.t3plus/t3plus.mjs on       inject into the running app (repeat after each app launch)
//   node ~/.t3plus/t3plus.mjs off      remove it and reload the app window
//   node ~/.t3plus/t3plus.mjs status   show windows and the loader's log
// It briefly opens Node's inspector on 127.0.0.1:9229 in the app's main process and closes it again.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const HOME = join(homedir(), ".t3plus");
const PORT = 9229;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function mainPid() {
  // This user's processes only: with fast user switching another user's T3 is not ours.
  const rows = execFileSync("ps", ["-U", String(process.getuid()), "-o", "pid=,ppid=,comm="], { encoding: "utf8" }).split("\n");
  // Not this script or the autostart that ran it: both may run on the app's own binary (ELECTRON_RUN_AS_NODE).
  const self = new Set([process.pid, process.ppid]);
  const hits = rows.map((l) => l.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/)).filter((m) => m && !self.has(Number(m[1])) && /\/T3 Code[^/]*\.app\/Contents\/MacOS\/T3 Code[^/]*$/.test(m[3]) && m[2] === "1");
  if (hits.length !== 1) throw new Error(`expected one running T3 Code app, found ${hits.length}`);
  return Number(hits[0][1]);
}
async function targets() {
  try { return await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json(); } catch { return null; }
}
// T3's inspector names its process: "<…>/T3 Code (Nightly)[<pid>]". Anything else
// on the port (a "node --inspect" session, another Electron app) is not ours to
// inject into, nor to close.
const isT3 = (list, pid) => Array.isArray(list) && list.length > 0 && list.every((t) => String(t.title ?? "").endsWith(`[${pid}]`));
// Set once SIGUSR1 went to T3, so every way out closes the inspector it opened, and
// only that one: never another process's, never one this script did not open.
let signalled = null; // T3's pid, once signalled
let opened = null; // the target list of the inspector that opened
/** Closes T3's inspector without a live connection (a failed connect, a signal). */
async function closeOpened() {
  if (signalled === null) return;
  let list = opened ?? (await targets());
  // T3 may open it only after this script gave up waiting: look a little longer.
  for (let i = 0; i < 20 && !list; i += 1) {
    await sleep(100);
    list = await targets();
  }
  opened = null;
  if (!isT3(list, signalled) || !list[0].webSocketDebuggerUrl) return;
  try {
    const ws = new WebSocket(list[0].webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; setTimeout(rej, 2000); });
    ws.send(JSON.stringify({ id: 1, method: "Runtime.evaluate", params: { expression: "(() => { clearTimeout(globalThis.__t3plusInspectorTimer); const i = require('inspector'); setTimeout(() => i.close(), 50); return 0; })()", includeCommandLineAPI: true } }));
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
  if (list && !isT3(list, pid)) throw new Error(`port ${PORT} belongs to another process (${String(list[0]?.title ?? "unknown").slice(0, 120)}), not T3 Code (pid ${pid})`);
  if (!list) {
    process.kill(pid, "SIGUSR1");
    signalled = pid;
    for (let i = 0; i < 50 && !list; i += 1) {
      await sleep(100);
      list = await targets();
    }
    if (list && !isT3(list, pid)) throw new Error(`port ${PORT} was taken by another process (${String(list[0]?.title ?? "unknown").slice(0, 120)})`);
    if (list?.length) opened = list;
  }
  if (!list?.length) throw new Error("the app's inspector did not open");
  const ws = new WebSocket(list[0].webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error("inspector connection failed")); });
  let id = 0;
  const pending = new Map();
  ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
  const evaluate = (expression) => new Promise((resolve, reject) => {
    const n = (id += 1);
    pending.set(n, (m) => {
      const r = m.result;
      if (m.error || r?.exceptionDetails) reject(new Error(m.error?.message ?? r.exceptionDetails.exception?.description ?? r.exceptionDetails.text));
      else resolve(r.result.value);
    });
    ws.send(JSON.stringify({ id: n, method: "Runtime.evaluate", params: { expression, includeCommandLineAPI: true, awaitPromise: true, returnByValue: true } }));
  });
  const close = async () => { try { ws.send(JSON.stringify({ id: 9e6, method: "Runtime.evaluate", params: { expression: "(() => { clearTimeout(globalThis.__t3plusInspectorTimer); const i = require('inspector'); setTimeout(() => i.close(), 50); return 0; })()", includeCommandLineAPI: true } })); await sleep(150); } catch {} ws.close(); };
  // A dead man's switch inside T3: whatever happens to this script (a hang, a kill
  // -9), T3 closes its inspector itself after 45 s.
  // (A previous run's timer is replaced, so it cannot cut this run short.)
  await evaluate("clearTimeout(globalThis.__t3plusInspectorTimer), globalThis.__t3plusInspectorTimer = setTimeout(() => { try { require('inspector').close(); } catch {} }, 45000), 0").catch(() => {});
  return { evaluate, close };
}

// The app's inspector is closed again however this script ends: a kill (autostart's
// timeout), Ctrl+C, or a command that hangs. Left open, any local process could run
// code inside T3 Code.
let closing = null;
const shutdown = (code) => {
  closing ??= (async () => {
    try { if (c) await c.close(); else await closeOpened(); } catch {}
    process.exit(code);
  })();
};
let c = null;
for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"]) process.on(sig, () => shutdown(1));
setTimeout(() => { console.error("t3+: gave up after 45 s"); shutdown(1); }, 45_000).unref();

const LIST = `JSON.stringify(require("electron").webContents.getAllWebContents().map((w) => ({ id: w.id, type: w.getType(), url: w.getURL().slice(0, 80) })))`;
const cmd = process.argv[2] ?? "status";
try {
  c = await connect();
} catch (error) {
  await closeOpened();
  throw error;
}
try {
  if (cmd === "eval") console.log(await c.evaluate(process.argv[3]));
  else if (cmd === "page") {
    // dev: run a file's code as an async function body in the app window; optional screenshot afterwards
    const body = readFileSync(process.argv[3], "utf8");
    const shot = process.argv[4] ?? "";
    const wait = Number(process.argv[5] ?? 0);
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
    const origin = process.argv[3] ?? new URL(win.url).origin;
    const loader = readFileSync(join(HOME, "inject/main-loader.js"), "utf8").replace("__APP_ORIGIN__", JSON.stringify(origin === "null" ? win.url.split("/").slice(0, 3).join("/") : origin));
    const result = await c.evaluate(loader);
    console.log("app origin:", origin, "->", result);
    // A window that could not be loaded is a failure (autostart reads stderr for the reason).
    if (/:error\b/.test(String(result))) {
      console.error(`t3+ could not load: ${result}`);
      process.exitCode = 1;
    }
  } else throw new Error(`unknown command ${cmd}`);
} finally {
  await c.close();
}
