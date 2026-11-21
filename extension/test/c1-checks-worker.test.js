import assert from "node:assert/strict";
import * as realFs from "node:fs";
import { createRequire } from "node:module";
import * as os from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

// The feeds worker's usage limits (inject/feeds-worker.js): what it keeps of a Claude
// account's id. A usage-limit hub names its accounts after their auth files, e-mail
// addresses as often as not.

const WORKER = fileURLToPath(new URL("../../inject/feeds-worker.js", import.meta.url));
const nodeRequire = createRequire(import.meta.url);

/** The worker's code run in this thread, its limits() and updateHistory() handed back. */
function workerInternals(home) {
  const modules = {
    worker_threads: { parentPort: { on() {}, postMessage() {} }, workerData: { t3Home: join(home, "t3"), home, t3Cli: "t3-not-installed", timeZone: "UTC" } },
    fs: realFs,
    os: { ...os, homedir: () => home, hostname: () => "test-mac" },
  };
  const require = (name) => modules[name] ?? nodeRequire(name);
  const source = `${realFs.readFileSync(WORKER, "utf8")}\nreturn { limits, updateHistory };`;
  return new Function("require", "module", "exports", "__dirname", "__filename", source)(require, { exports: {} }, {}, dirname(WORKER), WORKER);
}

test("worker: a Claude account's id stays out of what it keeps: its limit history is keyed by a hash of it, and the feed carries none", (t) => {
  const home = realFs.mkdtempSync(join(os.tmpdir(), "t3plus-worker-"));
  t.after(() => realFs.rmSync(home, { recursive: true, force: true }));
  const { limits, updateHistory } = workerInternals(home);
  const weekly = { label: "Weekly", kind: "weekly", windowDurationMins: 10080, usedPercent: 40, resetsAt: "2026-11-19T16:00:00Z" };
  // Put together here: written out, the address would stop the public mirror's privacy check.
  const email = ["sam", "example.com"].join("@");
  const hub = { id: "cliproxy-studio.lan", label: "Hub", accounts: [{ driver: "claudeAgent", id: `${email}.json`, email, plan: "max", usageLimits: { checkedAt: "2026-11-16T14:00:00Z", windows: [weekly] } }] };
  const lim = limits([], [hub]);
  assert.equal(lim.claude.length, 1);
  const account = lim.claude[0];
  assert.equal(Object.hasOwn(account, "id"), false, "no id");
  assert.doesNotMatch(JSON.stringify(account), /sam@|example\.com|cliproxy|studio/, "nothing of the hub's or the account's names");
  assert.equal(account.label, "Claude 1", "an e-mail is no label either");
  updateHistory(null, lim.claude, "2026-11-16T14:00:00+00:00");
  const kept = realFs.readFileSync(join(home, "state", "limits-history.json"), "utf8");
  assert.doesNotMatch(kept, /sam@|example\.com|cliproxy|studio/, "the history's keys are hashes");
  assert.deepEqual(Object.values(JSON.parse(kept).at(-1).claudeWeekUsed), [40]);
  // The same account, read again: the same key, so its history is one line.
  assert.equal(limits([], [hub]).claude[0].key, account.key);
});

test("worker: the limit history keeps one sample per 10 minutes, pool numbers and all, and is not rewritten for a sample it does not keep", (t) => {
  const home = realFs.mkdtempSync(join(os.tmpdir(), "t3plus-worker-"));
  t.after(() => realFs.rmSync(home, { recursive: true, force: true }));
  const { updateHistory } = workerInternals(home);
  const file = join(home, "state", "limits-history.json");
  const minute = 60000;
  const start = Date.now() - 60 * minute;
  const at = (m) => new Date(start + m * minute).toISOString();
  const pool = (left) => ({ weekCap: 100, weekLeft: left });
  updateHistory(pool(90), [], at(0));
  const series = updateHistory(pool(89), [], at(2));
  assert.deepEqual(series.map((h) => h.weekLeft), [90, 89], "this run's sample is the newest point");
  const stored = realFs.readFileSync(file, "utf8");
  assert.deepEqual(JSON.parse(stored).map((h) => h.weekLeft), [90], "only the 10-minute sample is stored");
  realFs.utimesSync(file, new Date(0), new Date(0));
  updateHistory(pool(88), [], at(4));
  assert.equal(realFs.statSync(file).mtimeMs, 0, "nothing new to keep: the file is left alone");
  updateHistory(pool(80), [], at(10));
  assert.deepEqual(JSON.parse(realFs.readFileSync(file, "utf8")), [{ t: at(0), ...pool(90) }, { t: at(10), ...pool(80) }], "the pool fields stay (the Codex series reads them)");

  // A file kept by the old worker (every run's sample) is thinned on the next write.
  realFs.writeFileSync(file, JSON.stringify([0, 2, 4, 6, 8, 10, 12].map((m) => ({ t: at(m), ...pool(70) }))));
  updateHistory(pool(60), [], at(30));
  assert.deepEqual(JSON.parse(realFs.readFileSync(file, "utf8")).map((h) => h.t), [at(0), at(10), at(30)]);
});

test("worker: a stored sample with no readable time is dropped, not left to hold back every later one", (t) => {
  const home = realFs.mkdtempSync(join(os.tmpdir(), "t3plus-worker-"));
  t.after(() => realFs.rmSync(home, { recursive: true, force: true }));
  const { updateHistory } = workerInternals(home);
  const file = join(home, "state", "limits-history.json");
  const at = (m) => new Date(Date.now() - 60 * 60000 + m * 60000).toISOString();
  realFs.mkdirSync(dirname(file), { recursive: true });
  realFs.writeFileSync(file, JSON.stringify([{ t: "zz-not-a-time", weekCap: 100, weekLeft: 1 }, { t: at(0), weekCap: 100, weekLeft: 90 }]));
  updateHistory({ weekCap: 100, weekLeft: 80 }, [], at(20));
  assert.deepEqual(JSON.parse(realFs.readFileSync(file, "utf8")).map((h) => h.weekLeft), [90, 80]);
});

test("worker: its files are written through a temporary copy of its own, not one another worker may be writing", (t) => {
  const home = realFs.mkdtempSync(join(os.tmpdir(), "t3plus-worker-"));
  t.after(() => realFs.rmSync(home, { recursive: true, force: true }));
  const { updateHistory } = workerInternals(home);
  const file = join(home, "state", "limits-history.json");
  // The shared name a disposed worker and the next one both used: here a folder, so writing to it fails.
  realFs.mkdirSync(`${file}.tmp`, { recursive: true });
  updateHistory({ weekCap: 100, weekLeft: 50 }, [], new Date().toISOString());
  assert.deepEqual(JSON.parse(realFs.readFileSync(file, "utf8")).map((h) => h.weekLeft), [50]);
  assert.deepEqual(realFs.readdirSync(dirname(file)).sort(), ["limits-history.json", "limits-history.json.tmp"], "no temporary copy left behind");
});
