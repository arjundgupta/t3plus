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
  const rows = execFileSync("ps", ["-axo", "pid=,ppid=,comm="], { encoding: "utf8" }).split("\n");
  // Not this script or the autostart that ran it: both may run on the app's own binary (ELECTRON_RUN_AS_NODE).
  const self = new Set([process.pid, process.ppid]);
  const hits = rows.map((l) => l.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/)).filter((m) => m && !self.has(Number(m[1])) && /\/T3 Code[^/]*\.app\/Contents\/MacOS\/T3 Code[^/]*$/.test(m[3]) && m[2] === "1");
  if (hits.length !== 1) throw new Error(`expected one running T3 Code app, found ${hits.length}`);
  return Number(hits[0][1]);
}
async function targets() {
  try { return await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json(); } catch { return null; }
}
async function connect() {
  let list = await targets();
  if (!list) {
    process.kill(mainPid(), "SIGUSR1");
    for (let i = 0; i < 50 && !list; i += 1) { await sleep(100); list = await targets(); }
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
  const close = async () => { try { ws.send(JSON.stringify({ id: 9e6, method: "Runtime.evaluate", params: { expression: "(() => { const i = require('inspector'); setTimeout(() => i.close(), 50); return 0; })()", includeCommandLineAPI: true } })); await sleep(150); } catch {} ws.close(); };
  return { evaluate, close };
}

const LIST = `JSON.stringify(require("electron").webContents.getAllWebContents().map((w) => ({ id: w.id, type: w.getType(), url: w.getURL().slice(0, 80) })))`;
const cmd = process.argv[2] ?? "status";
const c = await connect();
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
    const win = list.find((w) => w.type === "window" && /^(https?|t3code|t3):/.test(w.url) && !w.url.startsWith("data:"));
    if (!win) throw new Error(`no app window found: ${JSON.stringify(list)}`);
    const origin = process.argv[3] ?? new URL(win.url).origin;
    const loader = readFileSync(join(HOME, "inject/main-loader.js"), "utf8").replace("__APP_ORIGIN__", JSON.stringify(origin === "null" ? win.url.split("/").slice(0, 3).join("/") : origin));
    console.log("app origin:", origin, "->", await c.evaluate(loader));
  } else throw new Error(`unknown command ${cmd}`);
} finally {
  await c.close();
}
