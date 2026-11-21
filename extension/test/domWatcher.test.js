import assert from "node:assert/strict";
import { test } from "node:test";
import { createDomWatcher } from "../src/domWatcher.js";
import { createDom, settle } from "./helpers.js";

test("mutations only inside the message list do not schedule a check; anything else does", async () => {
  const dom = createDom("/", `<div class="messages-timeline-scroll"><div id="msg"></div></div><nav id="sidebar"></nav>`);
  const doc = dom.window.document;
  let checks = 0;
  const list = doc.querySelector(".messages-timeline-scroll");
  const watcher = createDomWatcher({
    win: dom.window,
    doc,
    check: () => (checks += 1),
    throttleMs: 0,
    isNoise: ({ target }) => list !== target && list.contains(target),
  });
  watcher.start();
  assert.equal(checks, 1, "first run");

  doc.getElementById("msg").append(doc.createTextNode("streamed token"));
  await settle();
  await settle();
  assert.equal(checks, 1, "streaming text is ignored");

  doc.getElementById("sidebar").append(doc.createElement("li"));
  await settle();
  await settle();
  assert.equal(checks, 2, "a sidebar change is checked");
  watcher.stop();
});

/**
 * A watcher on a simulated 60 Hz clock: frames every 16 ms (a cancelled frame does not
 * run, as in a browser), timers by due time, and the listeners the watcher adds, which
 * fire(type) calls (popstate, visibilitychange).
 */
function simulatedWatcher({ check, quick = null }) {
  let now = 0;
  const timers = [];
  const frames = new Map();
  let frameId = 0;
  const listeners = new Map();
  const target = {
    addEventListener: (type, fn) => listeners.set(type, fn),
    removeEventListener: (type, fn) => listeners.get(type) === fn && listeners.delete(type),
  };
  const win = {
    ...target,
    performance: { now: () => now },
    requestAnimationFrame: (f) => {
      frames.set((frameId += 1), f);
      return frameId;
    },
    cancelAnimationFrame: (id) => frames.delete(id),
    setTimeout: (f, ms) => timers.push({ f, at: now + ms }),
    clearTimeout: (id) => {
      if (timers[id - 1]) timers[id - 1].f = null;
    },
    MutationObserver: class {
      observe() {}
      disconnect() {}
      takeRecords() {
        return [];
      }
    },
  };
  const doc = { ...target, visibilityState: "visible", documentElement: {} };
  const watcher = createDomWatcher({ win, doc, throttleMs: 200, frames: true, check: () => check(now), quick: quick && (() => quick(now)) });
  return {
    watcher,
    doc,
    now: () => now,
    fire: (type) => listeners.get(type)?.(),
    /** Runs the clock `ms` on; `each(now)` runs once per frame before the frame's callbacks. */
    run(ms, each = () => {}) {
      for (const end = now + ms; now < end; now += 1) {
        for (const t of timers) {
          if (t.f && t.at <= now) {
            const f = t.f;
            t.f = null;
            f();
          }
        }
        if (now % 16 === 0) {
          each(now);
          // The frames asked for before this one, less those cancelled meanwhile.
          for (const id of [...frames.keys()]) {
            const f = frames.get(id);
            if (!frames.delete(id)) continue;
            f(now);
          }
        }
      }
    },
  };
}

test("a sustained storm stays at one check per throttle until it pauses; screenshot mode's quick step still runs every frame", () => {
  const perSecond = new Map();
  const quickPerSecond = new Map();
  const bump = (map, t) => map.set(Math.floor(t / 1000), (map.get(Math.floor(t / 1000)) ?? 0) + 1);
  const checks = [];
  const sim = simulatedWatcher({
    check: (t) => {
      bump(perSecond, t);
      checks.push(t);
    },
    quick: (t) => bump(quickPerSecond, t),
  });
  sim.watcher.start();
  const asks = [];
  sim.run(7000, (t) => {
    if (t < 3000) sim.watcher.schedule(); // a change every frame for 3 s
    if (t >= 4500 && t % 512 === 0) {
      asks.push(t);
      sim.watcher.schedule(); // single changes after a quiet spell
    }
  });
  // Once storming, about 5 checks a second (it used to be ~41 every second).
  assert.ok(perSecond.get(1) <= 6 && perSecond.get(2) <= 6, `checks per second: ${[...perSecond.values()]}`);
  assert.ok(quickPerSecond.get(1) >= 55, "the quick step follows every frame during the storm");
  assert.equal(sim.watcher.storming(), false, "the storm ends once the changes pause");
  for (const a of asks) assert.equal(checks.find((t) => t >= a), a, "after the storm, a single change is checked in its own frame");
  sim.watcher.stop();
});

test("a check that always causes another one is held to one per throttle", () => {
  const perSecond = new Map();
  let watcher;
  const sim = simulatedWatcher({
    check: (t) => {
      perSecond.set(Math.floor(t / 1000), (perSecond.get(Math.floor(t / 1000)) ?? 0) + 1);
      watcher.schedule();
    },
  });
  watcher = sim.watcher;
  watcher.start();
  sim.run(5000);
  for (const s of [1, 2, 3, 4]) assert.ok(perSecond.get(s) <= 6, `second ${s}: ${perSecond.get(s)} checks`);
  watcher.stop();
});

test("a hidden page runs no check; the one it owes runs once the page is shown", () => {
  let checks = 0;
  const sim = simulatedWatcher({ check: () => (checks += 1) });
  sim.watcher.start();
  sim.doc.visibilityState = "hidden";
  sim.watcher.schedule();
  sim.run(1000);
  assert.equal(checks, 1, "only the first one, at start");
  sim.doc.visibilityState = "visible";
  sim.fire("visibilitychange");
  sim.run(20);
  assert.equal(checks, 2, "the owed check, in the next frame");
  sim.fire("visibilitychange");
  sim.run(20);
  assert.equal(checks, 2, "nothing more is owed");
  sim.watcher.stop();
});

test("stop() drops a pending frame, a throttled check and its quick step; a schedule() after it runs nothing", () => {
  let checks = 0;
  let quicks = 0;
  const sim = simulatedWatcher({ check: () => (checks += 1), quick: () => (quicks += 1) });
  sim.watcher.start();
  sim.watcher.schedule(); // the next frame
  sim.watcher.stop();
  sim.run(1000);
  assert.equal(checks, 1, "only the first one, at start");
  sim.watcher.start();
  for (let i = 0; i < 60; i += 1) sim.watcher.flush(); // a storm
  assert.equal(sim.watcher.storming(), true);
  const before = checks;
  sim.watcher.schedule(); // a throttled check, and a quick step in the next frame
  sim.watcher.stop();
  sim.watcher.schedule();
  sim.run(2000);
  assert.deepEqual({ checks: checks - before, quicks }, { checks: 0, quicks: 0 });
});

test("a check run early (flush) takes the pending frame, and the quick step it covers, with it", () => {
  let checks = 0;
  let quicks = 0;
  const sim = simulatedWatcher({ check: () => (checks += 1), quick: () => (quicks += 1) });
  sim.watcher.start();
  sim.watcher.schedule(); // the next frame
  sim.watcher.flush();
  sim.run(50);
  assert.equal(checks, 2, "one check for the change, not two");
  for (let i = 0; i < 60; i += 1) sim.watcher.flush(); // a storm
  const before = checks;
  sim.watcher.schedule(); // a throttled check, and a quick step in the next frame
  sim.watcher.flush();
  sim.run(1000);
  assert.deepEqual({ checks: checks - before, quicks }, { checks: 1, quicks: 0 });
  sim.watcher.stop();
});

test("a navigation lifts a storm's throttle for its 600 ms burst only", () => {
  const checks = [];
  const sim = simulatedWatcher({ check: (t) => checks.push(t) });
  const change = () => sim.watcher.schedule(); // a change every frame
  sim.watcher.start();
  sim.run(2000, change);
  assert.equal(sim.watcher.storming(), true);
  const at = sim.now();
  sim.fire("popstate");
  sim.run(1600, change);
  const during = checks.filter((t) => t >= at && t < at + 600).length;
  const after = checks.filter((t) => t >= at + 600).length;
  assert.ok(during >= 30, `every frame during the burst: ${during} checks`);
  assert.ok(after <= 6, `throttled again once it is over: ${after} checks in the next second`);
  sim.watcher.stop();
});

test("right after a navigation the watcher skips its throttle", async () => {
  const dom = createDom("/", "<div></div>");
  let runs = 0;
  const watcher = createDomWatcher({ win: dom.window, doc: dom.window.document, check: () => (runs += 1), throttleMs: 10_000 });
  watcher.start();
  assert.equal(runs, 1);
  watcher.schedule(); // throttled: waits ~10 s
  dom.window.dispatchEvent(new dom.window.PopStateEvent("popstate")); // a navigation
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(runs, 2, "ran right away after the navigation");
  dom.window.document.body.append(dom.window.document.createElement("p")); // the new route renders
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(runs, 3, "still unthrottled during the burst");
  watcher.stop();
});

test("with frames, a change is checked in the next animation frame; a storm of changes falls back to the throttle", async () => {
  const dom = createDom("/", "<div></div>");
  const doc = dom.window.document;
  let runs = 0;
  const watcher = createDomWatcher({ win: dom.window, doc, check: () => (runs += 1), throttleMs: 10_000, frames: true });
  watcher.start();
  assert.equal(runs, 1);
  doc.body.append(doc.createElement("p"));
  await new Promise((r) => dom.window.requestAnimationFrame(() => setTimeout(r, 0)));
  assert.equal(runs, 2, "next frame, not 10 s later");
  for (let i = 0; i < 60; i += 1) watcher.flush(); // a storm
  assert.equal(watcher.storming(), true);
  const before = runs;
  doc.body.append(doc.createElement("p"));
  await new Promise((r) => dom.window.requestAnimationFrame(() => setTimeout(r, 0)));
  assert.equal(runs, before, "throttled while storming");
  watcher.stop();
});
