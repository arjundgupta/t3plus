import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { identity, parentPid } from "../../platform.mjs";
import { ask, onRewrite, PIPE } from "../../windows/startup.mjs";

// windows/startup.mjs, which runs autostart.mjs at every T3 launch on Windows: its pieces, never
// its main part (which would change what starts at sign-in). Its watching works anywhere.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(check, ms = 5000) {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(20)) if (check()) return true;
  return check();
}
function scratch(t) {
  const dir = mkdtempSync(join(tmpdir(), "t3plus-startup-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
const quick = { settle: 60, retry: 60 };

test("startup: runs for a file that is there, and at each rewrite, not for other files or its removal", async (t) => {
  const dir = scratch(t);
  const file = join(dir, "server-runtime.json");
  writeFileSync(file, "1");
  let runs = 0;
  t.after(onRewrite(dir, "server-runtime.json", async () => { runs += 1; }, quick));
  assert.ok(await until(() => runs === 1), "there at the start");
  writeFileSync(join(dir, "other.json"), "x");
  await sleep(300);
  assert.equal(runs, 1, "another file");
  writeFileSync(file, "2");
  assert.ok(await until(() => runs === 2), "T3 started again");
  rmSync(file);
  await sleep(300);
  assert.equal(runs, 2, "T3 quit");
});

test("startup: one run at a time, and one more for a launch during it", async (t) => {
  const dir = scratch(t);
  const file = join(dir, "server-runtime.json");
  writeFileSync(file, "1");
  let running = 0;
  let most = 0;
  let runs = 0;
  let release;
  t.after(onRewrite(dir, "server-runtime.json", async () => {
    runs += 1;
    most = Math.max(most, (running += 1));
    await new Promise((r) => { release = r; });
    running -= 1;
  }, quick));
  assert.ok(await until(() => runs === 1));
  for (const text of ["2", "3"]) {
    writeFileSync(file, text);
    await sleep(200);
  }
  assert.equal(runs, 1);
  release();
  assert.ok(await until(() => runs === 2), "the launch meanwhile");
  release();
  await sleep(300);
  assert.deepEqual([runs, most], [2, 1]);
});

test("startup: a run that fails does not end the watch, and a folder T3 has yet to make is waited for", async (t) => {
  const dir = join(scratch(t), "userdata");
  let runs = 0;
  t.after(onRewrite(dir, "server-runtime.json", async () => {
    runs += 1;
    throw new Error("no");
  }, quick));
  await sleep(150);
  mkdirSync(dir);
  writeFileSync(join(dir, "server-runtime.json"), "1");
  assert.ok(await until(() => runs === 1));
  writeFileSync(join(dir, "server-runtime.json"), "22");
  assert.ok(await until(() => runs === 2));
});

test("Windows: a running watcher answers on its pipe; with none there the answer is no", { skip: process.platform !== "win32" }, async (t) => {
  const pipe = `${PIPE}-test-${process.pid}`;
  assert.equal(await ask("", pipe), false);
  const heard = [];
  const server = createServer((s) => s.once("data", (d) => { heard.push(String(d).trim()); s.end("ok\n"); })).listen(pipe);
  await new Promise((r) => server.once("listening", r));
  t.after(() => server.close());
  assert.equal(await ask("stop", pipe), true);
  assert.deepEqual(heard, ["stop"]);
});

test("Windows: a process's parent, and a launch told apart by when it started", { skip: process.platform !== "win32" }, (t) => {
  assert.equal(parentPid(process.pid), process.ppid);
  assert.equal(parentPid(0), null);
  assert.equal(parentPid("1 or 1=1"), null, "numbers only");
  const list = join(scratch(t), "list");
  writeFileSync(list, "7|1|0|638|C:\\x\\T3 Code.exe\r\n");
  process.env.T3PLUS_PROCESS_LIST = list;
  t.after(() => { delete process.env.T3PLUS_PROCESS_LIST; });
  assert.equal(identity(7), "7@638");
  assert.equal(identity(8), "8@");
});
