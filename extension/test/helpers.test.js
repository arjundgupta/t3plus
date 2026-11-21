// The test helpers themselves (helpers.js): what the other tests stand on.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createApp, createDom, createFakeChromeStorage, sidebarHtml, virtualClock } from "./helpers.js";

// ---------- Clean-up ----------
// What a test opens is closed when the test ends, also when an assertion failed before
// the test's own clean-up. Without it one failing assertion in a test with a working bot
// or a feed left their timers running, and `npm test` (with it build.sh and CI) never ended.

test("a test that fails with its app running and its window open still lets the run end", async () => {
  const dir = await mkdtemp(join(tmpdir(), "t3plus-cleanup-test-"));
  try {
    const file = join(dir, "fails.test.mjs");
    await writeFile(
      file,
      `import assert from "node:assert/strict";
import { test } from "node:test";
import { createApp, createDom, sidebarHtml } from ${JSON.stringify(new URL("./helpers.js", import.meta.url).href)};
test("fails with a working bot (the sprite clock) and feed polls going", async () => {
  const feed = { readCache: async () => null, load: async () => null };
  const { app } = createApp(createDom("/env1/a1", sidebarHtml()), undefined, { botFeed: feed, homeFeed: feed });
  await app.start();
  assert.fail("on purpose, before app.stop()");
});
`,
    );
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT; // a run of its own, not a part of this one
    // No --test-force-exit: the process ends only once nothing is left running.
    const run = spawnSync(process.execPath, ["--test-reporter=tap", file], { encoding: "utf8", env, timeout: 30_000 });
    assert.equal(run.signal, null, "it ended by itself, not by the timeout");
    assert.equal(run.status, 1);
    assert.match(run.stdout, /^# fail 1$/m);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

const left = {};
test("(a test that ends with its window open and its app running)", async () => {
  left.dom = createDom("/env1/a1", sidebarHtml());
  ({ app: left.app, storage: left.storage } = createApp(left.dom));
  await left.app.start();
  assert.ok(left.storage.onChanged.listenerCount() > 0);
});

test("once a test ends, its app is stopped and its window closed", () => {
  assert.equal(left.storage.onChanged.listenerCount(), 0, "stopped: its storage listeners are gone");
  assert.equal(left.dom.window.document, undefined, "closed");
});

const shared = createDom("/env1/a1", ""); // opened outside any test: open until the file ends
test("(a test that ends with an app running on a window it did not open)", async () => {
  ({ app: left.app, storage: left.storage } = createApp(shared));
  await left.app.start();
});

test("an app is stopped when its own test ends, also when its window stays open", () => {
  assert.equal(left.storage.onChanged.listenerCount(), 0, "stopped");
  assert.ok(shared.window.document, "the window is still open");
});

// ---------- The storage fake ----------
// Code that waits for the echo of a write Chrome never reports would pass against a fake
// that reports every write, and wait forever in Chrome (pageStub.test.js: the desktop's).

test("the storage fake reports what chrome.storage does: only keys whose value changed, whatever its key order", async () => {
  const { area, onChanged } = createFakeChromeStorage();
  const events = [];
  onChanged.addListener((changes, areaName) => events.push([areaName, changes]));
  await area.set({ a: 1, b: { x: 1, y: [1, 2] } });
  await area.set({ a: 1, b: { y: [1, 2], x: 1 } }); // the same values
  await area.set({ a: 2, b: { x: 1, y: [1, 2] } });
  await area.remove(["missing"]);
  await area.remove("a");
  assert.deepEqual(events.map(([areaName, changes]) => [areaName, Object.keys(changes)]), [["local", ["a", "b"]], ["local", ["a"]], ["local", ["a"]]]);
  assert.deepEqual(events[1][1].a, { oldValue: 1, newValue: 2 });
  assert.deepEqual(events[2][1].a, { oldValue: 2, newValue: undefined });
  assert.deepEqual(await area.get(["a", "b"]), { b: { x: 1, y: [1, 2] } });
});

test("a listener that throws fails neither the write nor the other listeners, and is still reported", async () => {
  const { area, onChanged } = createFakeChromeStorage();
  const heard = [];
  onChanged.addListener(() => {
    throw new Error("a listener's bug");
  });
  onChanged.addListener((changes) => heard.push(Object.keys(changes)));
  const reported = [];
  const queue = globalThis.queueMicrotask;
  globalThis.queueMicrotask = (task) => queue(() => {
    try {
      task();
    } catch (error) {
      reported.push(error.message);
    }
  });
  try {
    await area.set({ a: 1 });
    await new Promise((resolve) => setImmediate(resolve));
  } finally {
    globalThis.queueMicrotask = queue;
  }
  assert.deepEqual(heard, [["a"]]);
  assert.deepEqual(reported, ["a listener's bug"]);
});

test("with delays, a change arrives after its write (as Chrome's do), or the write resolves after its change", async () => {
  const late = createFakeChromeStorage({ eventDelayMs: 5 });
  const order = [];
  late.onChanged.addListener(() => order.push("event"));
  await late.area.set({ a: 1 });
  order.push("written");
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(order, ["written", "event"]);

  const slow = createFakeChromeStorage({ eventDelayMs: 5, writeDelayMs: 10 });
  order.length = 0;
  slow.onChanged.addListener(() => order.push("event"));
  await slow.area.set({ a: 1 });
  order.push("written");
  assert.deepEqual(order, ["event", "written"]);
});

// ---------- The virtual clock ----------

const realTimers = { setTimeout, setInterval, Date }; // taken before any test mocks them

test("on the virtual clock, timers, frames, Date and performance.now() move only when advanced", async () => {
  const dom = createDom("/", "");
  const clock = virtualClock(dom.window);
  const seen = [];
  const date = Date.now();
  dom.window.setTimeout(() => seen.push(`timer at ${dom.window.performance.now()}`), 1500);
  dom.window.requestAnimationFrame((stamp) => seen.push(`frame at ${stamp}`));
  await new Promise((resolve) => realTimers.setTimeout(resolve, 20));
  assert.deepEqual(seen, [], "real time moved on, the clock did not");
  assert.equal(Date.now(), date);
  await clock.advance(20);
  assert.deepEqual(seen, ["frame at 16"], "a frame every 16 ms, stamped with the clock's time");
  await clock.advance(1480);
  assert.deepEqual(seen, ["frame at 16", "timer at 1500"]);
  assert.equal(Date.now() - date, 1500, "Date moved with it");
});

test("on the virtual clock, frames come one per 16 ms (one asked for in a frame: the next), and can be cancelled", async () => {
  const dom = createDom("/", "");
  const clock = virtualClock(dom.window);
  const win = dom.window;
  const stamps = [];
  const chain = (n) => win.requestAnimationFrame((stamp) => (stamps.push(stamp), n > 1 && chain(n - 1)));
  await clock.advance(5);
  chain(3);
  win.cancelAnimationFrame(win.requestAnimationFrame(() => stamps.push("cancelled")));
  await clock.frames(2);
  assert.deepEqual(stamps, [16, 32], "two frames' time: two frames");
  await clock.frames(1);
  assert.deepEqual(stamps, [16, 32, 48]);
});

test("a stall on the virtual clock moves time with nothing run; what came due runs on the next advance, late", async () => {
  const dom = createDom("/", "");
  const clock = virtualClock(dom.window);
  const win = dom.window;
  const seen = [];
  win.setTimeout(() => seen.push(`timer at ${win.performance.now()}`), 100);
  win.requestAnimationFrame(() => seen.push(`frame at ${win.performance.now()}`));
  clock.stall(350);
  assert.equal(win.performance.now(), 350);
  assert.deepEqual(seen, [], "the main thread was held");
  await clock.advance(0);
  assert.deepEqual(seen, ["frame at 350", "timer at 350"]);
});

test("a second virtual clock in the same test is the same clock, with the new window on it", async () => {
  const one = createDom("/", "").window;
  const two = createDom("/", "").window;
  const clock = virtualClock(one);
  await clock.advance(40);
  assert.equal(virtualClock(two), clock);
  assert.equal(two.performance.now(), 40);
});

test("after a test on the virtual clock, real time is back", () => {
  assert.equal(globalThis.setTimeout, realTimers.setTimeout);
  assert.equal(globalThis.setInterval, realTimers.setInterval);
  assert.equal(globalThis.Date, realTimers.Date);
});

test("a test whose clean-up fails before the clock's own leaves the next on real time all the same", async () => {
  const dir = await mkdtemp(join(tmpdir(), "t3plus-clock-test-"));
  try {
    const file = join(dir, "clock.test.mjs");
    await writeFile(
      file,
      `import { after, test } from "node:test";
import { virtualClock } from ${JSON.stringify(new URL("./helpers.js", import.meta.url).href)};
const RealDate = Date;
test("a clean-up that throws (it skips the after() hooks after it)", () => {
  after(() => {
    throw new Error("on purpose");
  });
  virtualClock();
});
test("the next test", () => {
  if (Date !== RealDate) throw new Error("still on the last test's clock");
});
`,
    );
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT; // a run of its own, not a part of this one
    const run = spawnSync(process.execPath, ["--test-reporter=tap", file], { encoding: "utf8", env, timeout: 30_000 });
    assert.match(run.stdout, /^not ok 1 - a clean-up that throws/m);
    assert.match(run.stdout, /^ok 2 - the next test$/m);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
