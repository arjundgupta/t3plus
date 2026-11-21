import assert from "node:assert/strict";
import { test } from "node:test";
import { createHealth, GRACE_MS, healthRoute, MIN_GAP_MS } from "../src/health.js";
import { createDom } from "./helpers.js";

// Breakage reporting's own timers (health.js): a part that just went missing is looked at
// again once its grace period is over, so it is reported without waiting for T3 to change
// something; and the checks that ask in every frame are answered from its last look.

/** A window whose timers the test runs by hand. */
function fakeWindow() {
  let now = 0;
  const timers = [];
  const win = {
    performance: { now: () => now },
    setTimeout: (fn, ms) => timers.push({ fn, ms, cleared: false }),
    clearTimeout: (id) => (timers[id - 1].cleared = true),
  };
  return {
    win,
    timers,
    pass: (ms) => (now += ms),
    /** Runs the timers still waiting, as their time comes. */
    run: () => timers.filter((t) => !t.cleared && !t.ran).forEach((t) => ((t.ran = true), t.fn())),
  };
}

test("health: a missing part is looked at again once, when its grace period is over, and reported then by itself; stop() calls that off", () => {
  const doc = createDom("/env1/thread1", "").window.document; // a thread page with none of T3's parts
  const w = fakeWindow();
  const changes = [];
  const health = createHealth({ win: w.win, doc, routePath: () => "/env1/thread1", onChange: (p) => changes.push(p) });
  health.check();
  w.pass(1000);
  health.check();
  assert.deepEqual(w.timers.map((t) => t.ms), [GRACE_MS + 50], "one look again, however many checks meanwhile");
  w.pass(GRACE_MS);
  w.timers[0].fn();
  assert.equal(changes.length, 1, "it looks by itself, and reports what is still missing");
  assert.ok(changes[0].length > 0);
  assert.equal(w.timers.length, 1, "nothing left to wait for: no new timer");

  const fresh = createHealth({ win: w.win, doc, routePath: () => "/env1/thread1" });
  fresh.check();
  assert.equal(w.timers.length, 2);
  fresh.stop();
  assert.equal(w.timers[1].cleared, true, "stopped: its timer is cleared");
});

test("health: checks in every frame look once a second, the last of them followed by one more look; a new page is looked at at once", () => {
  const dom = createDom("/env1/thread1", `<div data-workspace-area="conversation"></div>`);
  const doc = dom.window.document;
  const w = fakeWindow();
  let path = "/env1/thread1";
  const health = createHealth({ win: w.win, doc, routePath: () => path });
  let looks = 0;
  const real = doc.querySelector.bind(doc);
  doc.querySelector = (...args) => ((looks += 1), real(...args));
  health.check();
  const perLook = looks;
  assert.ok(perLook > 0);
  for (let i = 0; i < 30; i += 1) {
    w.pass(16);
    health.check(); // about a frame each, for half a second
  }
  assert.equal(looks, perLook, "no second look within the second");
  const trailing = w.timers.filter((t) => !t.cleared && t.ms < GRACE_MS);
  assert.equal(trailing.length, 1, "one more look is due");
  // T3 takes a part away in the last change before the page goes quiet: that look sees it.
  doc.body.innerHTML = "";
  w.pass(trailing[0].ms);
  trailing[0].fn();
  assert.equal(looks, perLook * 2, "the look after them");
  w.pass(GRACE_MS + 50);
  w.run();
  assert.ok(health.problems.some((p) => p.feature === "Glow, glass composer and centering"), "reported within its grace period and a second");
  // Another page: looked at at once, its problems its own.
  path = "/settings/appearance";
  health.check();
  assert.ok(!health.problems.some((p) => p.feature === "Glow, glass composer and centering"), "the thread's problem gone with the thread");
  health.stop();
  assert.ok(w.timers.every((t) => t.cleared || t.ran), "stopped: no timer left");
});

test("health: a thread page is /<env>/<thread>, as the rest of t3+ reads a route; T3's own two-part pages are not", () => {
  assert.equal(healthRoute("/env/t").thread, true);
  for (const path of ["/settings/appearance", "/draft/x", "/usage", "/pull-requests/42", "/new/x", "/env", "/"]) {
    assert.equal(healthRoute(path).thread, false, path);
  }
  assert.deepEqual(healthRoute("/usage"), { thread: false, draft: false, settings: false, usage: true });
  assert.equal(healthRoute("/draft/x").draft, true);
  assert.equal(healthRoute("/settings/appearance").settings, true);
});

test("health: a part missing past the grace period is reported with its feature; found again, it clears", () => {
  const dom = createDom("/env1/thread1", `<div data-workspace-area="conversation"></div>`);
  let t = 0;
  const win = { performance: { now: () => t }, setTimeout: () => 1, clearTimeout: () => {} };
  const changes = [];
  const health = createHealth({ win, doc: dom.window.document, routePath: () => "/env1/thread1", onChange: (p) => changes.push(p) });
  assert.deepEqual(health.check(), [], "missing, but within the grace period");
  t = GRACE_MS + 1;
  const problems = health.check();
  assert.equal(problems.length, 1);
  assert.equal(problems[0].feature, "Glow, glass composer and centering");
  assert.deepEqual(problems[0].missing, ["composer card", "composer lane", "message list"]);
  dom.window.document.body.innerHTML = `<div data-workspace-area="conversation"></div><div data-chat-composer-surface="true"></div><div class="chat-composer-lane"></div><div class="messages-timeline-scroll"></div>`;
  t += MIN_GAP_MS; // looked at no more often than this
  assert.deepEqual(health.check(), []);
  assert.equal(changes.length, 2, "told once when it broke, once when it recovered");
});
