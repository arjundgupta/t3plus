import assert from "node:assert/strict";
import * as cp from "node:child_process";
import * as realFs from "node:fs";
import { createRequire } from "node:module";
import * as os from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";

// The feeds worker's bots, spend and home ops (inject/feeds-worker.js), on a T3 database and
// provider session logs made here. Mostly run in this thread, with stand-ins for what the
// worker is given (its port, a home, the file system to count calls on, T3's CLI and API).
const WORKER = fileURLToPath(new URL("../../inject/feeds-worker.js", import.meta.url));
const nodeRequire = createRequire(import.meta.url);
const { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, appendFileSync, existsSync } = realFs;

function makeHome(t) {
  const home = mkdtempSync(join(os.tmpdir(), "t3plus-worker-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  mkdirSync(join(home, "t3", "userdata"), { recursive: true });
  writeFileSync(join(home, "t3", "userdata", "environment-id"), "env-test\n");
  // Claude's price for the model the logs name, as T3's rate file has it.
  writeFileSync(join(home, "t3", "userdata", "usage-model-rates.json"), JSON.stringify({ document: { "claude-test-1-0": { input_cost_per_token: 3e-6, output_cost_per_token: 15e-6, cache_read_input_token_cost: 3e-7, cache_creation_input_token_cost: 3.75e-6 } } }));
  const db = new DatabaseSync(join(home, "t3", "userdata", "statev2.sqlite"));
  db.exec(`
    CREATE TABLE orchestration_v2_projection_threads (thread_id TEXT PRIMARY KEY, project_id TEXT, title TEXT, created_at TEXT, updated_at TEXT, deleted_at TEXT, archived_at TEXT, payload_json TEXT);
    CREATE TABLE orchestration_v2_projection_messages (message_id TEXT PRIMARY KEY, thread_id TEXT, role TEXT, created_at TEXT, updated_at TEXT, payload_json TEXT);
    CREATE TABLE orchestration_v2_projection_subagents (subagent_id TEXT PRIMARY KEY, thread_id TEXT, run_id TEXT, started_at TEXT, status TEXT, payload_json TEXT);
    CREATE TABLE orchestration_v2_projection_provider_threads (provider_thread_id TEXT PRIMARY KEY, thread_id TEXT, payload_json TEXT);
    CREATE TABLE orchestration_v2_projection_runs (run_id TEXT PRIMARY KEY, thread_id TEXT, requested_at TEXT);
    CREATE TABLE projection_projects (project_id TEXT PRIMARY KEY, deleted_at TEXT);`);
  let n = 0;
  const insert = (table, row) => db.prepare(`INSERT INTO ${table} (${Object.keys(row).join(", ")}) VALUES (${Object.keys(row).map(() => "?").join(", ")})`).run(...Object.values(row).map((v) => (v && typeof v === "object" ? JSON.stringify(v) : v)));
  const fixture = {
    home,
    thread: (id, title, payload = {}) => insert("orchestration_v2_projection_threads", { thread_id: id, project_id: "p1", title, created_at: "2026-11-01T00:00:00Z", updated_at: "2026-11-01T00:00:00Z", deleted_at: null, archived_at: null, payload_json: payload }),
    message: (thread, role, minute, text) => insert("orchestration_v2_projection_messages", { message_id: `m${(n += 1)}`, thread_id: thread, role, created_at: `2026-11-01T10:${String(minute).padStart(2, "0")}:00Z`, updated_at: null, payload_json: { text } }),
    subagent: (thread, run, minute, status, title) => insert("orchestration_v2_projection_subagents", { subagent_id: `s${(n += 1)}`, thread_id: thread, run_id: run, started_at: `2026-11-01T10:${String(minute).padStart(2, "0")}:00Z`, status, payload_json: { title } }),
    session: (thread, driver, nativeId) => insert("orchestration_v2_projection_provider_threads", { provider_thread_id: `pt${(n += 1)}`, thread_id: thread, payload_json: { nativeThreadRef: { driver, nativeId } } }),
    close: () => db.close(),
  };
  return fixture;
}
/** One request in a Claude Code session log. */
const claudeLine = (id, input, output) => `${JSON.stringify({ type: "assistant", requestId: `req-${id}`, message: { id: `msg-${id}`, model: "claude-test-1-0", usage: { input_tokens: input, output_tokens: output, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } })}\n`;

/**
 * The worker's code run in this thread: `fs` may be one that counts calls, and the home it
 * sees is the test's (no real ~/.claude or ~/.codex is read). call(op, args) -> its result.
 */
function loadWorker(home, { fs = realFs, t3Cli = "t3-not-installed" } = {}) {
  let onMessage = null;
  const replies = new Map();
  const logs = [];
  const parentPort = {
    on: (event, fn) => { if (event === "message") onMessage = fn; },
    postMessage: (m) => {
      if (m.log) return void logs.push(m.log.join(" "));
      const reply = replies.get(m.id);
      replies.delete(m.id);
      m.error ? reply.reject(new Error(m.error)) : reply.resolve(m.result);
    },
  };
  const cfg = { t3Home: join(home, "t3"), home, t3Cli, timeZone: "UTC" };
  const modules = {
    worker_threads: { parentPort, workerData: cfg },
    fs,
    os: { ...os, homedir: () => home, hostname: () => "test-mac" },
    child_process: { ...cp, execFileSync: () => { throw new Error("not in tests"); } },
  };
  const require = (name) => modules[name] ?? nodeRequire(name);
  new Function("require", "module", "exports", "__dirname", "__filename", readFileSync(WORKER, "utf8"))(require, { exports: {} }, {}, dirname(WORKER), WORKER);
  let seq = 0;
  const call = (op, args = {}) => new Promise((resolve, reject) => {
    const id = (seq += 1);
    replies.set(id, { resolve, reject });
    onMessage({ id, op, args });
  });
  return { call, logs };
}
const botsFeed = (home) => JSON.parse(readFileSync(join(home, "feeds", "t3plus-bots.json"), "utf8")).bots;

test("bots: the latest message with text, plain (identifiers kept), the running subagents, model, computer and spend", async (t) => {
  const f = makeHome(t);
  f.thread("b1", "Fix parsing", { modelSelection: { model: "claude-opus-4-1", options: [{ id: "reasoningEffort", value: "high" }] } });
  f.message("b1", "user", 1, "Please rename it");
  f.message("b1", "assistant", 2, "Renamed `user_id` to **account_id** in snake_case_name and _emphasis_.");
  f.message("b1", "assistant", 3, ""); // the newest: no text yet
  f.subagent("b1", "r1", 1, "completed", "Old run");
  f.subagent("b1", "r2", 4, "running", "Check *user_id* usage");
  f.subagent("b1", "r2", 5, "completed", "Read config_file");
  f.session("b1", "claudeAgent", "native-1");
  f.close();
  mkdirSync(join(f.home, ".claude", "projects", "proj"), { recursive: true });
  writeFileSync(join(f.home, ".claude", "projects", "proj", "native-1.jsonl"), claudeLine(1, 1000, 100) + claudeLine(2, 2000, 200));
  const worker = loadWorker(f.home);
  assert.equal(await worker.call("bots", { ids: ["b1"] }), true);
  const entry = botsFeed(f.home).b1;
  assert.deepEqual(entry, {
    text: "Renamed user_id to account_id in snake_case_name and emphasis.",
    role: "assistant",
    at: "2026-11-01T10:02:00Z",
    model: "Opus 4.1",
    computer: "Test-mac",
    subagents: [{ title: "Check user_id usage", status: "running" }, { title: "Read config_file", status: "completed" }],
    spend: { usd: 0.0135, tokens: 3300 },
  });
  await worker.call("dispose");
});

test("bots: a 60 KB line of markdown marks is read in moments", async (t) => {
  const f = makeHome(t);
  f.thread("b1", "Pointers");
  f.message("b1", "assistant", 1, "int" + " *p".repeat(20_000) + " _a".repeat(10_000));
  f.close();
  const worker = loadWorker(f.home);
  const started = performance.now();
  await worker.call("bots", { ids: ["b1"] });
  assert.ok(performance.now() - started < 500, `${Math.round(performance.now() - started)} ms`);
  assert.equal([...botsFeed(f.home).b1.text].length, 280);
});

test("spend: the cache is written when it changed, at most every 30 s and on dispose, and reads back to the same spend", async (t) => {
  const f = makeHome(t);
  f.thread("b1", "Busy bot");
  f.session("b1", "claudeAgent", "native-1");
  f.close();
  const log = join(f.home, ".claude", "projects", "proj", "native-1.jsonl");
  mkdirSync(dirname(log), { recursive: true });
  writeFileSync(log, claudeLine(1, 1000, 100));
  const cache = join(f.home, "state", "spend-cache.json");
  const writes = [];
  const fs = { ...realFs, renameSync: (from, to) => { if (to === cache) writes.push(JSON.parse(readFileSync(from, "utf8"))); return realFs.renameSync(from, to); } };
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: Date.parse("2026-11-20T10:00:00Z") });
  const worker = loadWorker(f.home, { fs });
  const offset = (snapshot) => snapshot.files.b1.files[log].offset;
  await worker.call("bots", { ids: ["b1"] });
  assert.equal(writes.length, 1, "the first copy at once");
  appendFileSync(log, claudeLine(2, 2000, 200));
  await worker.call("bots", { ids: ["b1"] });
  assert.equal(botsFeed(f.home).b1.spend.tokens, 3300, "the feed has the new request at once");
  await worker.call("bots", { ids: ["b1"] }); // nothing new
  assert.equal(writes.length, 1, "the cache waits");
  t.mock.timers.tick(29_000);
  assert.equal(writes.length, 1);
  t.mock.timers.tick(1_000);
  assert.equal(writes.length, 2, "30 s after the last write");
  assert.equal(offset(writes[1]), statSync(log).size);
  await worker.call("bots", { ids: ["b1"] }); // nothing new: not written again
  t.mock.timers.tick(60_000);
  assert.equal(writes.length, 2);
  appendFileSync(log, claudeLine(3, 4000, 400));
  await worker.call("bots", { ids: ["b1"] });
  assert.equal(writes.length, 3, "a change long after the last write: at once");
  appendFileSync(log, claudeLine(4, 8000, 800));
  await worker.call("bots", { ids: ["b1"] });
  await worker.call("dispose");
  assert.equal(writes.length, 4, "the rest on dispose");
  t.mock.timers.tick(60_000);
  assert.equal(writes.length, 4, "and no write left pending");
  assert.equal(offset(writes[3]), statSync(log).size);
  assert.equal(writes[3].files.b1.seen.length, 3, "the ids counted, kept as a list (the newest still pending)");
  t.mock.timers.reset();
  const spendFrom = async () => {
    const fresh = loadWorker(f.home);
    await fresh.call("bots", { ids: ["b1"] });
    await fresh.call("dispose");
    return botsFeed(f.home).b1.spend;
  };
  const cached = await spendFrom();
  rmSync(cache);
  rmSync(join(f.home, "feeds"), { recursive: true });
  assert.deepEqual(cached, await spendFrom(), "the cache gives what the logs read afresh give");
  assert.deepEqual(cached, { usd: 0.0675, tokens: 16500 });
});

test("spend: a worker stopped by dispose has written its cache (a real worker thread)", async (t) => {
  const f = makeHome(t);
  f.thread("b1", "Busy bot");
  f.session("b1", "claudeAgent", "native-1");
  f.close();
  const claude = join(f.home, "claude");
  const log = join(claude, "projects", "proj", "native-1.jsonl");
  mkdirSync(dirname(log), { recursive: true });
  writeFileSync(log, claudeLine(1, 1000, 100));
  const worker = new Worker(WORKER, { workerData: { t3Home: join(f.home, "t3"), home: f.home, t3Cli: "t3-not-installed", timeZone: "UTC" }, env: { ...process.env, CLAUDE_CONFIG_DIR: claude } });
  t.after(() => worker.terminate());
  const call = (id, op, args = {}) => new Promise((resolve, reject) => {
    const onMessage = (m) => {
      if (m.id !== id) return;
      worker.off("message", onMessage);
      m.error ? reject(new Error(m.error)) : resolve(m.result);
    };
    worker.on("message", onMessage);
    worker.postMessage({ id, op, args });
  });
  await call(1, "bots", { ids: ["b1"] });
  appendFileSync(log, claudeLine(2, 2000, 200));
  await call(2, "bots", { ids: ["b1"] });
  const cache = join(f.home, "state", "spend-cache.json");
  assert.equal(JSON.parse(readFileSync(cache, "utf8")).files.b1.files[log].offset, claudeLine(1, 1000, 100).length, "the second read waits to be written");
  await call(0, "dispose");
  assert.equal(JSON.parse(readFileSync(cache, "utf8")).files.b1.files[log].offset, statSync(log).size);
});

test("spend: Codex sessions not on this machine are all looked for in one walk of the day folders", async (t) => {
  const f = makeHome(t);
  f.thread("b1", "Codex bot");
  f.session("b1", "codex", "0199aaaa-0000-7000-8000-000000000001");
  for (let i = 0; i < 10; i += 1) f.session("b1", "codex", `0199bbbb-0000-7000-8000-00000000000${i}`); // a remote machine's
  f.close();
  const sessions = join(f.home, ".codex", "sessions");
  for (let day = 1; day <= 30; day += 1) mkdirSync(join(sessions, "2026", "10", String(day).padStart(2, "0")), { recursive: true });
  const file = join(sessions, "2026", "10", "05", "rollout-2026-10-05T10-00-00-0199aaaa-0000-7000-8000-000000000001.jsonl");
  writeFileSync(file, [
    { type: "turn_context", payload: { model: "gpt-test" } },
    { type: "event_msg", timestamp: "2026-10-05T10:00:01Z", payload: { type: "token_count", info: { last_token_usage: { input_tokens: 500, cached_input_tokens: 100, output_tokens: 50 }, total_token_usage: { input_tokens: 500, cached_input_tokens: 100, output_tokens: 50, total_tokens: 550 } } } },
  ].map((l) => JSON.stringify(l)).join("\n") + "\n");
  const listed = [];
  const fs = { ...realFs, readdirSync: (dir, ...rest) => { if (String(dir).startsWith(sessions)) listed.push(String(dir)); return realFs.readdirSync(dir, ...rest); } };
  const worker = loadWorker(f.home, { fs });
  await worker.call("bots", { ids: ["b1"] });
  assert.equal(botsFeed(f.home).b1.spend.tokens, 550, "the one found is read");
  assert.equal(listed.length, 1 + 1 + 1 + 30, "one walk: the root, its year, its month, its days");
  listed.length = 0;
  await worker.call("bots", { ids: ["b1"] });
  assert.equal(listed.length, 0, "and none again until the missing ones are due");
  await worker.call("dispose");
});

/** T3's API as the home feed reads it: its environment over HTTP, its usage and config over a
 *  WebSocket. Resolves once both were asked for (the read's deadline is set by then). */
function fakeT3Api(t, f, { sources }) {
  writeFileSync(join(f.home, "t3", "userdata", "server-runtime.json"), JSON.stringify({ port: 4999 }));
  t.mock.method(globalThis, "fetch", async () => ({ json: async () => ({ orchestrationProtocolVersion: 2 }) }));
  let asked;
  const configAsked = new Promise((r) => { asked = r; });
  class FakeSocket {
    constructor() { queueMicrotask(() => this.onopen?.()); }
    send(text) {
      const frame = JSON.parse(text);
      const reply = (m) => queueMicrotask(() => this.onmessage?.({ data: JSON.stringify(m) }));
      if (frame.id === "summary") reply({ _tag: "Exit", requestId: "summary", exit: { _tag: "Success", value: { buckets: [{ day: "2026-11-19", provider: "claudeAgent", costUsd: 1.5, totals: { outputTokens: 10 } }], sources: [] } } });
      if (frame.id === "config") {
        const values = [{ type: "snapshot", payload: { config: { providers: [] } } }];
        if (sources) values.push({ type: "usageLimitSourcesUpdated", payload: { sources } });
        reply({ _tag: "Chunk", requestId: "config", values });
        asked();
      }
    }
    close() {}
  }
  const before = globalThis.WebSocket;
  globalThis.WebSocket = FakeSocket;
  t.after(() => { globalThis.WebSocket = before; });
  return configAsked;
}
/** T3's CLI: issues a session (and notes each call). */
function fakeCli(f) {
  const calls = join(f.home, "cli-calls");
  if (process.platform === "win32") {
    // A batch file, as T3's own launcher is there, in a folder with a space and an "&" in its name.
    mkdirSync(join(f.home, "a & b"), { recursive: true });
    const cmd = join(f.home, "a & b", "t3.cmd");
    writeFileSync(cmd, `@echo off\r\n>>"${calls}" echo %~1 %~2 %~3\r\nif "%~3"=="issue" echo {"token":"tok","sessionId":"s-1"}\r\nexit /b 0\r\n`);
    return { path: cmd, calls: () => (existsSync(calls) ? readFileSync(calls, "utf8").trim().split(/\r?\n/) : []) };
  }
  writeFileSync(join(f.home, "t3cli"), `#!/bin/sh\necho "$1 $2 $3" >> '${calls}'\n[ "$3" = issue ] && echo '{"token":"tok","sessionId":"s-1"}'\nexit 0\n`, { mode: 0o755 });
  return { path: join(f.home, "t3cli"), calls: () => (existsSync(calls) ? readFileSync(calls, "utf8").trim().split("\n") : []) };
}

test("home: T3 that sends no usage-limit sources still gets its home feed, with what came by the deadline", async (t) => {
  const f = makeHome(t);
  f.close();
  const configAsked = fakeT3Api(t, f, { sources: null });
  const cli = fakeCli(f);
  // The clock pinned to the day after the fixture's spend: the feed keeps the days counted
  // back from today, and on the real clock that day would age out of them in time.
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: Date.parse("2026-11-20T12:00:00Z") });
  const worker = loadWorker(f.home, { t3Cli: cli.path });
  const publishing = worker.call("home");
  await configAsked;
  t.mock.timers.tick(45_000);
  assert.equal(await publishing, true);
  const feed = JSON.parse(readFileSync(join(f.home, "feeds", "t3plus-home.json"), "utf8"));
  assert.deepEqual(feed.limits, { claude: [], codex: null, pool: null });
  assert.deepEqual(feed.spend, { "2026-11-19": { claudeAgent: [1.5, 10] } });
  t.mock.timers.reset();
  await worker.call("dispose");
  // The session's revoke runs on its own: waited for, or it may still write into the home being removed.
  const revoked = () => cli.calls().some((c) => c.startsWith("auth session revoke"));
  for (let waited = 0; !revoked() && waited < 5000; waited += 20) await new Promise((r) => setTimeout(r, 20));
  assert.ok(revoked(), "the session was revoked");
});

test("home: a failed read that is not the session's keeps the session for the next publish", async (t) => {
  const f = makeHome(t);
  f.close();
  writeFileSync(join(f.home, "t3", "userdata", "server-runtime.json"), JSON.stringify({ port: 4999 }));
  t.mock.method(globalThis, "fetch", async () => { throw new Error("connect ECONNREFUSED"); }); // T3's server restarting
  const cli = fakeCli(f);
  const worker = loadWorker(f.home, { t3Cli: cli.path });
  await assert.rejects(worker.call("home"), /ECONNREFUSED/);
  await assert.rejects(worker.call("home"), /ECONNREFUSED/);
  assert.deepEqual(cli.calls().map((c) => c.split(" ").slice(0, 3).join(" ")), ["auth session issue"], "one session, reused");
});

test("bots: only the threads asked for or marked go into the feed, at most 64 (the ones asked for first), in a file only you can read", async (t) => {
  const f = makeHome(t);
  f.thread("asked", "A plain title");
  f.thread("other", "Not a bot");
  f.thread("inside", "a [[t3plus:bot:v1]] marker mid-title");
  for (let i = 0; i < 70; i += 1) f.thread(`bot${i}`, `Bot ${i} [[t3plus:bot:v1]]`);
  f.close();
  const worker = loadWorker(f.home);
  await worker.call("bots", { ids: ["asked"] });
  const feed = botsFeed(f.home);
  assert.ok("asked" in feed, "asked for: kept first");
  assert.ok(!("other" in feed) && !("inside" in feed), "neither asked for nor marked (first or last word)");
  assert.equal(Object.keys(feed).length, 64, "a marker mid-title takes no place under the cap");
  // (On Windows a file has no such mode: it is its user's through the profile folder it is in.)
  if (process.platform !== "win32") assert.equal(statSync(join(f.home, "feeds", "t3plus-bots.json")).mode & 0o777, 0o600, "your threads' text: readable by you alone");
  await worker.call("dispose");
});

test("Windows: T3's launcher is never given a word cmd.exe would read on its own", { skip: process.platform !== "win32" }, async (t) => {
  const f = makeHome(t);
  f.close();
  t.mock.method(globalThis, "fetch", async () => { throw new Error("connect ECONNREFUSED"); });
  const cli = fakeCli(f);
  for (const name of ["%PATH%", "a!b"]) {
    const worker = loadWorker(f.home, { t3Cli: join(f.home, name, "t3.cmd") });
    await assert.rejects(worker.call("home"), /cannot be given these words/);
  }
  assert.deepEqual(cli.calls(), [], "nothing was run");
});

test("dispose: the T3 session the home feed held is revoked, once", async (t) => {
  const f = makeHome(t);
  f.close();
  writeFileSync(join(f.home, "t3", "userdata", "server-runtime.json"), JSON.stringify({ port: 4999 }));
  t.mock.method(globalThis, "fetch", async () => { throw new Error("connect ECONNREFUSED"); }); // the session is issued, the read fails, the session kept
  const cli = fakeCli(f);
  const worker = loadWorker(f.home, { t3Cli: cli.path });
  await assert.rejects(worker.call("home"), /ECONNREFUSED/);
  await worker.call("dispose");
  await worker.call("dispose"); // t3+ replaced twice over: nothing left to revoke
  const ops = () => cli.calls().map((c) => c.split(" ").slice(0, 3).join(" "));
  for (let waited = 0; ops().length < 2 && waited < 5000; waited += 20) await new Promise((r) => setTimeout(r, 20)); // the CLI runs on its own
  await new Promise((r) => setTimeout(r, 200)); // and a second revoke would have come by now
  assert.deepEqual(ops(), ["auth session issue", "auth session revoke"]);
});
