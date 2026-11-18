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
    isNoise: (node) => list !== node && list.contains(node),
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

/** A watcher on a simulated 60 Hz clock: frames every 16 ms, timers by due time. */
function simulatedWatcher({ check, quick = null }) {
  let now = 0;
  const timers = [];
  let frames = [];
  const win = {
    performance: { now: () => now },
    requestAnimationFrame: (f) => frames.push(f),
    cancelAnimationFrame: () => {},
    setTimeout: (f, ms) => timers.push({ f, at: now + ms }),
    clearTimeout: (id) => {
      if (timers[id - 1]) timers[id - 1].f = null;
    },
    MutationObserver: class {
      observe() {}
      disconnect() {}
    },
    addEventListener() {},
    removeEventListener() {},
  };
  const doc = { visibilityState: "visible", documentElement: {}, addEventListener() {}, removeEventListener() {} };
  const watcher = createDomWatcher({ win, doc, throttleMs: 200, frames: true, check: () => check(now), quick: quick && (() => quick(now)) });
  return {
    watcher,
    /** Runs the clock to `until` ms; `each(now)` runs once per frame before the frame's callbacks. */
    run(until, each = () => {}) {
      for (; now < until; now += 1) {
        for (const t of timers) {
          if (t.f && t.at <= now) {
            const f = t.f;
            t.f = null;
            f();
          }
        }
        if (now % 16 === 0) {
          each(now);
          const due = frames;
          frames = [];
          for (const f of due) f(now);
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
