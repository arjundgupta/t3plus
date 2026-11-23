import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { backendReady, explain, t3Home } from "../../autostart.mjs";

// autostart.mjs, run by the launch agent at every T3 launch: its pieces, never its main part
// (which would load t3+ into a running T3).
function scratch(t) {
  const dir = mkdtempSync(join(tmpdir(), "t3plus-autostart-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("why t3+ did not load: the CLI's own line, not Node's version banner after an uncaught error", (t) => {
  // The real CLI, a mistyped command, with a `ps` that finds nothing (it is not even run).
  const ps = scratch(t);
  writeFileSync(join(ps, "ps"), "#!/bin/sh\n");
  chmodSync(join(ps, "ps"), 0o755);
  const cli = fileURLToPath(new URL("../../t3plus.mjs", import.meta.url));
  const run = spawnSync(process.execPath, [cli, "bogus"], { encoding: "utf8", env: { PATH: ps, HOME: ps, USERPROFILE: ps, T3PLUS_INSPECTOR_PORT: "1" } });
  assert.equal(run.status, 1);
  assert.match(explain(run.stderr), /^t3\+: unknown command bogus/);
  const uncaught = "file:///x/t3plus.mjs:142\n    if (!win) throw new Error(`no app window found`);\n              ^\n\nError: no app window found: []\n    at file:///x/t3plus.mjs:142:21\n\nNode.js v22.23.2\n";
  assert.equal(explain(uncaught), "Error: no app window found: []");
  assert.match(explain("t3+: the app's inspector did not open\n"), /did not open its debugger port/);
  assert.equal(explain(""), "unknown error");
});

test("T3's home as the loader finds it: t3+'s config, else T3CODE_HOME, else ~/.t3", (t) => {
  const home = scratch(t);
  const before = process.env.T3CODE_HOME;
  t.after(() => { if (before === undefined) delete process.env.T3CODE_HOME; else process.env.T3CODE_HOME = before; });
  delete process.env.T3CODE_HOME;
  assert.equal(t3Home(home), join(homedir(), ".t3"));
  process.env.T3CODE_HOME = " /elsewhere/t3 ";
  assert.equal(t3Home(home), "/elsewhere/t3");
  mkdirSync(join(home, "server"));
  writeFileSync(join(home, "server", "config.local.json"), JSON.stringify({ t3Home: "/local/t3" }));
  assert.equal(t3Home(home), "/local/t3");
  writeFileSync(join(home, "config.json"), JSON.stringify({ t3Home: "/configured/t3" }));
  assert.equal(t3Home(home), "/configured/t3", "config.json first, as in inject/feeds.js");
});

test("the app's backend is up once the server its runtime file names answers, and is the app's", async (t) => {
  const server = createServer((req, res) => {
    res.statusCode = req.url === "/.well-known/t3/environment" ? 200 : 404;
    res.end("{}");
  }).listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  t.after(() => server.close());
  const dir = scratch(t);
  const runtime = join(dir, "server-runtime.json");
  // This test process stands in for T3's server; its parent for the app's main process.
  writeFileSync(runtime, JSON.stringify({ pid: process.pid, port: server.address().port }));
  assert.equal(await backendReady(process.ppid, runtime), true);
  assert.equal(await backendReady(process.pid, runtime), false, "a server that is another app's");
  assert.equal(await backendReady(process.ppid, join(dir, "missing.json")), false);
});
