import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { CLOSE_INSPECTOR, deadMansSwitch, isT3, targets } from "../../t3plus.mjs";

// t3plus.mjs, the CLI that opens T3's inspector, loads t3+ through it and closes it again,
// run against stand-ins only: a Node process in T3's place, and a fake `ps` (the only thing on
// the CLI's PATH) that names that process as the app, so the real T3 is never found or signalled.
const CLI = fileURLToPath(new URL("../../t3plus.mjs", import.meta.url));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function scratch(t, prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
const freePort = () => new Promise((resolve) => {
  const server = createServer().listen(0, "127.0.0.1", () => {
    const { port } = server.address();
    server.close(() => resolve(port));
  });
});
async function until(check, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return true;
    await sleep(50);
  }
  return false;
}

/** An app in T3's place: Node with its inspector closed until SIGUSR1 opens it on `port`. Its
 *  inspector is named as T3's is ("<binary>[<pid>]"); `code` runs once it has said it is up. */
async function standInApp(t, code = "") {
  const port = await freePort();
  const child = spawn(process.execPath, [`--inspect-port=127.0.0.1:${port}`, "-e", `require("fs").writeSync(1, "up\\n"); ${code}; setInterval(() => {}, 1000);`], { stdio: ["ignore", "pipe", "ignore"] });
  t.after(() => child.kill("SIGKILL"));
  await new Promise((resolve, reject) => {
    child.stdout.once("data", resolve);
    child.once("exit", () => reject(new Error("the stand-in app did not start")));
  });
  return { port, pid: child.pid };
}
/** A fake `ps` that lists `pid` (if any) as the T3 Code app, and notes each call. */
function fakePs(t, pid = null) {
  const dir = scratch(t, "t3plus-ps-");
  const calls = join(dir, "calls");
  const row = pid === null ? "" : `printf '%s 1 /Applications/T3 Code.app/Contents/MacOS/T3 Code\\n' ${pid}\n`;
  writeFileSync(join(dir, "ps"), `#!/bin/sh\necho "$*" >> '${calls}'\n${row}`);
  chmodSync(join(dir, "ps"), 0o755);
  return { dir, calls };
}
/** Runs the CLI with only the fake `ps` on its PATH and the stand-in's port as T3's. */
function cli(t, args, { ps, port }) {
  const child = spawn(process.execPath, [CLI, ...args], { env: { PATH: ps.dir, HOME: scratch(t, "t3plus-home-"), T3PLUS_INSPECTOR_PORT: String(port) }, stdio: ["ignore", "pipe", "pipe"] });
  t.after(() => child.kill("SIGKILL"));
  let out = "";
  let err = "";
  child.stdout.on("data", (d) => (out += d));
  child.stderr.on("data", (d) => (err += d));
  const done = new Promise((resolve) => child.on("exit", (code) => resolve({ code, out, err })));
  return { child, done };
}

test("the dead man's switch closes the inspector after the CLI is gone, in a main module without a global require", async (t) => {
  // T3's main process is a CommonJS file: `require` there is the inspector's command-line API, gone once an evaluation ends.
  const dir = scratch(t, "t3plus-switch-");
  writeFileSync(join(dir, "main.cjs"), "setInterval(() => {}, 1000);\n");
  const child = spawn(process.execPath, ["--inspect=127.0.0.1:0", join(dir, "main.cjs")], { stdio: ["ignore", "ignore", "pipe"] });
  t.after(() => child.kill("SIGKILL"));
  let stderr = "";
  const port = await new Promise((resolve) => child.stderr.on("data", (d) => {
    const m = /ws:\/\/127\.0\.0\.1:(\d+)\//.exec((stderr += d));
    if (m) resolve(Number(m[1]));
  }));
  const [target] = await targets(port);
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  const reply = new Promise((resolve) => { ws.onmessage = (ev) => resolve(JSON.parse(ev.data)); });
  ws.send(JSON.stringify({ id: 1, method: "Runtime.evaluate", params: { expression: deadMansSwitch(300), includeCommandLineAPI: true, returnByValue: true } }));
  assert.equal((await reply).result.result.value, 0, "armed");
  ws.close(); // the CLI dies without closing it
  assert.ok(await until(async () => (await targets(port)) === null, 5000), "the inspector closed itself");
});

/** Something on a port that takes connections and never answers. */
async function silentListener(t) {
  const sockets = [];
  const server = createServer((s) => sockets.push(s)).listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  t.after(() => { for (const s of sockets) s.destroy(); server.close(); });
  return server.address().port;
}

test("a listener on the port that never answers holds the port, and does not hang the CLI", async (t) => {
  const port = await silentListener(t);
  let started = Date.now();
  assert.deepEqual(await targets(port), [], "something is there, no inspector's list");
  assert.ok(Date.now() - started < 4000, `gave up in ${Date.now() - started} ms`);
  assert.equal(await targets(await freePort()), null, "nothing there");
  // The CLI says so at once (autostart does not try again), and signals nothing.
  const app = await standInApp(t);
  started = Date.now();
  const { code, err } = await cli(t, ["status"], { ps: fakePs(t, app.pid), port }).done;
  assert.equal(code, 1);
  assert.equal(err, `t3+: port ${port} belongs to another process (not an inspector), not T3 Code (pid ${app.pid})\n`);
  assert.ok(Date.now() - started < 6000, `took ${Date.now() - started} ms`);
});

test("only an inspector that names T3's process is T3's", () => {
  assert.equal(isT3([{ title: "/Applications/T3 Code (Nightly).app/Contents/MacOS/T3 Code (Nightly)[42]" }], 42), true);
  assert.equal(isT3([{ title: "/usr/local/bin/node[42]" }, { title: "other.js" }], 42), false);
  assert.equal(isT3([], 42), false);
  assert.equal(isT3(null, 42), false);
  assert.match(CLOSE_INSPECTOR, /const i = require\('inspector'\); setTimeout\(\(\) => i\.close\(\)/, "the module taken while require is there");
});

test("a mistyped command fails at once, in one line, without looking for T3 or opening anything", async (t) => {
  const ps = fakePs(t);
  const { code, out, err } = await cli(t, ["stauts"], { ps, port: await freePort() }).done;
  assert.equal(code, 1);
  assert.equal(out, "");
  assert.equal(err, "t3+: unknown command stauts (on, off or status)\n");
  assert.equal(existsSync(ps.calls), false, "ps was never run");
});

test("a command runs in the app through its inspector, which is closed again afterwards", async (t) => {
  const app = await standInApp(t);
  const ps = fakePs(t, app.pid);
  const { code, out, err } = await cli(t, ["eval", "6 * 7"], { ps, port: app.port }).done;
  assert.equal(err, "");
  assert.equal(code, 0);
  assert.equal(out, "42\n");
  assert.equal(await targets(app.port), null, "the inspector it opened is closed");
});

test("an app busy when signalled, whose inspector opens seconds later, is still loaded, then closed", async (t) => {
  // Busy in native code (a dialog at launch): Node opens the inspector once the main thread is free.
  const app = await standInApp(t, `require("child_process").execSync("sleep 8")`);
  const ps = fakePs(t, app.pid);
  const { code, out, err } = await cli(t, ["eval", "1 + 1"], { ps, port: app.port }).done;
  assert.equal(err, "t3+: T3 Code has not opened its inspector yet (busy?), waiting a little longer\n", "said once");
  assert.equal(code, 0);
  assert.equal(out, "2\n");
  assert.equal(await targets(app.port), null);
});

test("stopped mid-command (autostart's timeout), the CLI closes the app's inspector and exits", async (t) => {
  const app = await standInApp(t);
  const ps = fakePs(t, app.pid);
  const run = cli(t, ["eval", "new Promise(() => {})"], { ps, port: app.port });
  assert.ok(await until(async () => existsSync(ps.calls) && (await targets(app.port)) !== null, 10_000), "connected");
  await sleep(300); // the command is under way
  run.child.kill("SIGTERM");
  const started = Date.now();
  const { code } = await run.done;
  assert.equal(code, 1);
  assert.ok(Date.now() - started < 4000);
  assert.equal(await targets(app.port), null, "closed on the way out");
});
