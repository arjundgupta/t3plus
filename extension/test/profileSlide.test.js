import assert from "node:assert/strict";
import { test } from "node:test";
import { createProfiles, normalizeProfiles, profileOf } from "../src/profiles.js";
import { clearBotDecoration } from "../src/bots.js";
import { LOOK, lookValue } from "../src/composer.js";
import { STORAGE_KEYS } from "../src/config.js";
import { createDom, createFakeChromeStorage, virtualClock } from "./helpers.js";

// The slide between profiles: the open list moves out sideways and a copy of the next
// profile's list moves in beside it (by a click, the keys, or a swipe that follows the
// fingers). jsdom has no animations, so a small stand-in records them: `start()` is the
// compositor taking one over, `finish()` its end, `progress` how far it has eased (as
// effect.getComputedTiming() reports it; unset: it cannot say).

const folder = (key) =>
  `<li data-testid="sidebar-project-folder"><button data-sidebar-row="folder:${key}" aria-expanded="true" id="h-${key.replace("/", "-")}"><span class="truncate">${key}</span></button></li>`;
const thread = (key, parent, current = false) =>
  `<li data-thread-item="${key}"><div role="button" tabindex="0" data-sidebar-row="${key}" data-sidebar-parent="${parent}"${current ? ' aria-current="page"' : ""} aria-label="${key}"><span dir="auto">${key}</span><span>1d</span></div></li>`;
const ROWS = folder("p/a") + thread("env:a1", "folder:p/a", true) + folder("p/b") + thread("env:b1", "folder:p/b");
const TWO = { active: "main", list: [{ id: "main", name: "Main" }, { id: "work", name: "Work" }], projects: { "p/a": "main", "p/b": "work" }, adopted: true };
// T3's night art at the top of the sidebar (nightly builds), its colors from the theme.
const SKY = '<div class="sidebar-stage-backdrop" style="--stage-night-mid: oklch(22.7% .086 278)"><svg data-stage-art="nightly"></svg></div>';

function setup({ rows = ROWS, stored = TWO, reduced = false, path = "/env/a1", enabled = () => true, demo = () => false, trackpad = null, scoped = null, storage: storageOptions } = {}) {
  const dom = createDom(
    path,
    `<div data-slot="sidebar-inner"><div data-slot="scroll-area-viewport"><div id="group"><ul id="list">${rows}</ul></div></div><div data-slot="sidebar-footer"></div></div>${SKY}<div data-workspace-area="conversation"><div data-chat-canvas><div class="messages-timeline-scroll" id="msgs"><div data-timeline-row-id="a1-m1">a1</div></div><div class="composer"></div></div></div>`,
  );
  const win = dom.window;
  const doc = win.document;
  // Time moves only when a test moves it: a busy machine never reads a finger's pace as
  // a flick, nor sleeps past a spring-back's end.
  const clock = virtualClock(win);
  const anims = [];
  win.Element.prototype.animate = function (keyframes, options) {
    let start;
    const a = {
      el: this, keyframes, options, onfinish: null, cancelled: false, progress: undefined,
      effect: { getComputedTiming: () => ({ progress: a.progress }) },
      ready: new Promise((resolve) => (start = resolve)),
      start: () => start(),
      cancel() { this.cancelled = true; },
      finish() { if (!this.cancelled) this.onfinish?.(); },
    };
    anims.push(a);
    return a;
  };
  win.matchMedia = (q) => ({ matches: reduced && q.includes("reduce") });
  // Chromium's relative colors (the sky), and the computed color of a var() (jsdom
  // resolves neither): the probe t3+ reads the theme's sky through gets the backdrop's.
  win.CSS = { supports: () => true };
  const computed = win.getComputedStyle.bind(win);
  win.getComputedStyle = (el, ...rest) => {
    const style = computed(el, ...rest);
    if (!/var\(--stage-night-mid\)/.test(el.style?.cssText ?? "")) return style;
    const host = el.parentElement?.querySelector(".sidebar-stage-backdrop");
    return { ...style, color: host?.style.getPropertyValue("--stage-night-mid") ?? "", getPropertyValue: (n) => style.getPropertyValue(n) };
  };
  const list = doc.getElementById("list");
  list.getBoundingClientRect = () => ({ left: 8, top: 0, width: 200, height: 600, right: 208, bottom: 600 });
  doc.addEventListener("click", (e) => {
    const row = e.target.closest?.("[data-thread-item] [data-sidebar-row]");
    if (!row) return;
    const [env, id] = row.getAttribute("data-sidebar-row").split(":");
    win.history.pushState({}, "", `/${env}/${id}`);
  });
  const storage = createFakeChromeStorage(storageOptions);
  storage.area.data.set(STORAGE_KEYS.profiles, stored);
  const profiles = createProfiles({ win, doc, area: storage.area, changedEvent: storage.onChanged, isEnabled: () => enabled(), isDemo: () => demo(), trackpad, scoped });
  const live = () => anims.filter((a) => !a.cancelled);
  return {
    win, doc, list, storage, profiles, anims, clock,
    route: () => win.location.pathname,
    go: (path) => {
      win.history.pushState({}, "", path);
      profiles.sync();
    },
    copy: () => doc.querySelector("[data-t3plus-profile-next]"),
    dot: (id) => doc.querySelector(`.t3plus-profile-dot[data-profile="${id}"]`),
    off: (root, sel) => root.querySelector(sel).closest("li").hasAttribute("data-t3plus-profile-off"),
    /** The compositor has the slide: the thread may be asked for now. */
    async started() {
      for (const a of live()) a.start();
      await clock.advance(0); // their ready promises settle
      await clock.frames(1); // the frame after
      await clock.advance(0);
    },
    finish: () => live().find((a) => a.el === list)?.finish(),
    key: (digit, repeat = false) => doc.body.dispatchEvent(new win.KeyboardEvent("keydown", { code: `Digit${digit}`, key: String(digit), ctrlKey: true, shiftKey: true, repeat, bubbles: true, cancelable: true })),
    wheel: (deltaX, deltaY = 0, target = doc.querySelector('[data-sidebar-row="env:a1"]') ?? list) => {
      const event = new win.WheelEvent("wheel", { deltaX, deltaY, bubbles: true, cancelable: true });
      target.dispatchEvent(event);
      return event.defaultPrevented;
    },
  };
}

test("a switch slides: a copy of the next profile's list comes in beside the open one, and the real list takes over when it is in place", async () => {
  const t = setup();
  await t.profiles.start();
  t.dot("work").click();
  const copy = t.copy();
  assert.ok(copy, "the next profile's list slides in");
  assert.equal(copy.getAttribute("aria-hidden"), "true");
  assert.ok(copy.hasAttribute("inert"));
  assert.equal(t.off(copy, '[data-sidebar-parent="folder:p/b"]'), false, "the copy shows Work's folders");
  assert.equal(copy.querySelector('[data-sidebar-parent="folder:p/a"]'), null, "Main's rows are not copied at all");
  assert.equal(copy.querySelectorAll("[data-thread-item], [data-sidebar-row], [data-testid], [id], [tabindex]").length, 0, "nothing in the copy is found as a row, by id, or by Tab");
  assert.equal(t.off(t.list, '[data-sidebar-parent="folder:p/a"]'), false, "the real list is unchanged while it slides");
  assert.equal(t.profiles.state.active, "main");
  assert.equal(t.dot("work").getAttribute("aria-pressed"), "true", "its dot is the open one already");
  assert.ok(t.doc.getElementById("group").hasAttribute("data-t3plus-profile-sliding"));
  const [out, inn] = t.anims;
  assert.deepEqual(out.keyframes.map((k) => k.transform), ["translate3d(0px, 0px, 0)", "translate3d(-212px, 0px, 0)"], "out to the left, a list's width and a gap");
  assert.deepEqual(inn.keyframes.map((k) => k.transform), ["translate3d(212px, 0px, 0)", "translate3d(0px, 0px, 0)"], "in from the right");
  assert.equal(t.route(), "/env/a1", "T3 is not asked for the thread before the slide has started");
  await t.started();
  assert.equal(t.route(), "/env/b1", "then it is, while the lists move");
  t.profiles.sync(); // the app's checks after T3 draws it
  assert.equal(t.off(t.copy(), '[data-sidebar-parent="folder:p/b"]'), false, "the checks leave the copy alone");
  assert.equal(t.profiles.state.active, "main", "the route does not switch anything mid-slide");
  t.finish();
  assert.equal(t.copy(), null);
  assert.equal(t.list.style.transform, "");
  assert.equal(t.doc.querySelector("[data-t3plus-profile-sliding]"), null);
  assert.equal(t.profiles.state.active, "work");
  assert.equal(t.off(t.list, '[data-sidebar-parent="folder:p/b"]'), false, "the real list shows Work now");
  assert.equal(t.off(t.list, '[data-sidebar-parent="folder:p/a"]'), true);
  assert.equal(t.route(), "/env/b1");
  t.profiles.stop();
});

test("a switch made while one is still sliding: the first lands at once and its thread is not drawn; the same dot again opens it", async () => {
  const t = setup();
  const visited = [];
  const push = t.win.history.pushState.bind(t.win.history);
  t.win.history.pushState = (st, title, url) => (visited.push(String(url)), push(st, title, url));
  await t.profiles.start();
  t.dot("work").click();
  t.dot("main").click(); // straight back, before the first has started
  assert.equal(t.profiles.state.active, "work", "the first one landed");
  await t.started();
  t.finish();
  assert.equal(t.profiles.state.active, "main");
  assert.equal(t.route(), "/env/a1", "Work's thread was never asked for");
  assert.deepEqual(visited.filter((u) => u.includes("b1")), [], "not even on the way");
  assert.equal(t.doc.querySelectorAll("[data-t3plus-profile-next]").length, 0);

  t.dot("work").click();
  t.dot("work").click(); // its dot again (a double-click)
  assert.equal(t.profiles.state.active, "work");
  assert.equal(t.route(), "/env/b1", "landed, and its thread opened right away");
  assert.equal(t.copy(), null);
  t.profiles.stop();
});

test("the copy follows the open-thread highlight T3 moves while it slides", async () => {
  const t = setup();
  await t.profiles.start();
  t.dot("work").click();
  await t.started();
  // T3 draws the opened thread: the highlight moves from a1 to b1 in the real list.
  t.list.querySelector('[data-sidebar-row="env:a1"]').removeAttribute("aria-current");
  t.list.querySelector('[data-sidebar-row="env:b1"]').setAttribute("aria-current", "page");
  t.profiles.sync();
  const marked = [...t.copy().querySelectorAll("[aria-current]")].map((el) => el.getAttribute("aria-label"));
  assert.deepEqual(marked, ["env:b1"]);
  assert.equal(t.off(t.copy(), '[aria-label="env:b1"]'), false);
  t.finish();
  t.profiles.stop();
});

test("a swipe moves the lists with the fingers: a short one springs back, past a third it switches, up and down never does", async () => {
  const t = setup();
  await t.profiles.start();
  // Short: 30 px of a 212 px slide, at a finger's pace (not a flick).
  for (let i = 0; i < 5; i += 1) {
    assert.equal(t.wheel(6), false, "never canceled: Chromium then starts its scroll gesture, which T3 reports as a touch");
    if (i < 4) await t.clock.advance(16);
  }
  assert.equal(t.list.style.transform, "translate3d(-30px, 0px, 0)", "the list follows the fingers");
  assert.equal(t.copy().style.transform, "translate3d(182px, 0px, 0)", "and Work's comes in beside it");
  await t.clock.advance(170); // the fingers stop
  t.finish();
  assert.equal(t.profiles.state.active, "main", "sprang back");
  assert.equal(t.copy(), null);
  assert.equal(t.list.style.transform, "");

  // Past a third.
  for (let i = 0; i < 15; i += 1) t.wheel(6);
  await t.clock.advance(300);
  await t.started();
  t.finish();
  assert.equal(t.profiles.state.active, "work");
  assert.equal(t.route(), "/env/b1", "and Work's thread opened");

  // Up and down (and mostly so): the list scrolls, nothing slides.
  for (let i = 0; i < 6; i += 1) assert.equal(t.wheel(0, 8), false, "scrolling is left alone");
  await t.clock.advance(300);
  for (let i = 0; i < 6; i += 1) t.wheel(3, 8);
  assert.equal(t.copy(), null);
  assert.equal(t.list.style.transform, "");
  await t.clock.advance(300);
  assert.equal(t.profiles.state.active, "work");
  t.profiles.stop();
});

test("swiping past the last profile only gives a little and springs back; turning back past the start brings the other side's profile", async () => {
  const t = setup({ stored: { ...TWO, active: "work" }, path: "/env/b1" });
  await t.profiles.start();
  t.profiles.sync();
  for (let i = 0; i < 20; i += 1) t.wheel(8); // toward a profile after Work: none
  assert.equal(t.copy(), null, "nothing to bring in");
  const x = Number(/translate3d\((-?[\d.]+)px/.exec(t.list.style.transform)[1]);
  assert.ok(x < 0 && x > -80, `gives a little (${x}px for 160px of fingers)`);
  await t.clock.advance(300);
  t.finish();
  assert.equal(t.profiles.state.active, "work");
  assert.equal(t.list.style.transform, "");

  for (let i = 0; i < 4; i += 1) t.wheel(8); // a little toward nothing...
  for (let i = 0; i < 16; i += 1) t.wheel(-8); // ...then back the other way, toward Main
  assert.ok(t.copy(), "Main comes in from the left");
  assert.match(t.copy().style.transform, /^translate3d\(-/);
  await t.clock.advance(300);
  await t.started();
  t.finish();
  assert.equal(t.profiles.state.active, "main");
  t.profiles.stop();
});

test("stopping mid-slide leaves T3's list as it was and saves nothing; with reduced motion a switch is instant", async () => {
  for (const midway of [(t) => t.dot("work").click(), (t) => [1, 2, 3, 4].forEach(() => t.wheel(6))]) {
    const t = setup();
    await t.profiles.start();
    midway(t); // a click's slide, or fingers still on the pad
    assert.ok(t.copy());
    t.profiles.stop();
    assert.equal(t.copy(), null);
    assert.equal(t.list.style.transform, "");
    assert.equal(t.doc.querySelector("[data-t3plus-profile-sliding]"), null);
    assert.equal(t.storage.area.data.get(STORAGE_KEYS.profiles).active, "main");
    assert.equal(t.route(), "/env/a1");
  }

  const r = setup({ reduced: true });
  await r.profiles.start();
  r.dot("work").click();
  assert.equal(r.copy(), null, "no slide");
  assert.equal(r.anims.length, 0);
  assert.equal(r.profiles.state.active, "work");
  assert.equal(r.route(), "/env/b1");
  for (let i = 0; i < 14; i += 1) r.wheel(-6); // and a swipe still switches, once
  assert.equal(r.profiles.state.active, "main");
  r.profiles.stop();
});

// Four profiles, a folder and a thread each.
const ROWS4 = ["a", "b", "c", "d"].map((x) => folder(`p/${x}`) + thread(`env:${x}1`, `folder:p/${x}`, x === "a")).join("");
const FOUR = {
  active: "main",
  list: [{ id: "main", name: "Main" }, { id: "work", name: "Work" }, { id: "c", name: "C" }, { id: "d", name: "D" }],
  projects: { "p/a": "main", "p/b": "work", "p/c": "c", "p/d": "d" },
  adopted: true,
};
const live = (t) => t.anims.filter((a) => !a.cancelled && !a.el.matches(".messages-timeline-scroll")); // the list and its copy

test("one swipe is one switch: its momentum (even arriving in bursts after T3 draws the thread) moves nothing more; a pause or the other way starts a new one", async () => {
  const t = setup({ rows: ROWS4, stored: FOUR });
  await t.profiles.start();
  for (let i = 0; i < 40; i += 1) t.wheel(8); // all the way over: switches at once
  await t.started();
  t.finish();
  assert.equal(t.profiles.state.active, "work");
  for (const dx of [7, 15, 30, 6, 4, 3, 2, 1]) t.wheel(dx); // momentum, merged into bigger events by a stall
  await t.clock.advance(100);
  for (const dx of [12, 9, 5]) t.wheel(dx);
  assert.equal(t.copy(), null, "nothing moves");
  await t.clock.advance(300);
  assert.equal(t.profiles.state.active, "work", "still one switch");
  for (let i = 0; i < 40; i += 1) t.wheel(8); // after a pause: a new swipe
  await t.started();
  t.finish();
  assert.equal(t.profiles.state.active, "c");
  for (let i = 0; i < 40; i += 1) t.wheel(-8); // right away, the other way: a new swipe too
  await t.started();
  t.finish();
  assert.equal(t.profiles.state.active, "work");
  t.profiles.stop();

  const r = setup({ rows: ROWS4, stored: FOUR, reduced: true }); // the instant switch, the same
  await r.profiles.start();
  for (let i = 0; i < 12; i += 1) r.wheel(8);
  await r.clock.advance(100);
  for (let i = 0; i < 12; i += 1) r.wheel(8);
  assert.equal(r.profiles.state.active, "work");
  for (let i = 0; i < 12; i += 1) r.wheel(-8); // right away, the other way: a new swipe too
  assert.equal(r.profiles.state.active, "main");
  r.profiles.stop();
});

test("fingers back on the pad (T3 reports each touch): the next swipe switches right away, even while the last one's momentum still arrives", async () => {
  let touch = null;
  let unsubscribed = false;
  const trackpad = { onBegin: (fn) => ((touch = fn), () => (unsubscribed = true)) };
  const t = setup({ rows: ROWS4, stored: FOUR, trackpad });
  await t.profiles.start();
  const swipe = async (dx) => {
    for (let i = 0; i < 40; i += 1) t.wheel(dx);
    await t.started();
    t.finish();
  };
  touch(); // reported before the swipe's first event
  await swipe(8);
  assert.equal(t.profiles.state.active, "work");
  for (const dx of [7, 5, 3, 2]) t.wheel(dx); // its momentum
  assert.equal(t.copy(), null, "the momentum moves nothing");
  touch(); // fingers down again, no pause at all
  await swipe(8);
  assert.equal(t.profiles.state.active, "c", "a second swipe, straight after the first");
  // A swipe whose touch is reported only after its first events (T3 busy drawing a
  // thread): that report is its own, and does not let its momentum switch again.
  await t.clock.advance(300); // a pause: the next events start a gesture before any report
  await swipe(8);
  assert.equal(t.profiles.state.active, "d");
  touch(); // late: this swipe's own touch
  for (const dx of [9, 6, 4]) t.wheel(dx);
  assert.equal(t.copy(), null, "its momentum still moves nothing");
  assert.equal(t.profiles.state.active, "d");
  touch();
  await swipe(-8);
  assert.equal(t.profiles.state.active, "c", "the next touch is a new swipe");
  t.profiles.stop();
  assert.equal(unsubscribed, true, "stops listening to touches");
});

test("T3's own trackpad back/forward step is not taken during a swipe over the sidebar (nor its arrow shown); after it, and elsewhere, it is", async () => {
  const t = setup({ rows: ROWS4, stored: FOUR });
  const steps = [];
  // T3 calls window.history.back(): stood in for by History's own method.
  t.win.History.prototype.back = function () { steps.push("back"); };
  t.win.History.prototype.forward = function () { steps.push("forward"); };
  await t.profiles.start();
  for (let i = 0; i < 6; i += 1) t.wheel(8);
  t.win.history.back(); // T3 finishing the same gesture as a history swipe
  assert.deepEqual(steps, [], "not taken mid-swipe");
  assert.equal(t.doc.documentElement.hasAttribute("data-t3plus-profile-swipe"), true, "T3's arrow is hidden (content.css)");
  await t.clock.advance(450);
  assert.equal(t.doc.documentElement.hasAttribute("data-t3plus-profile-swipe"), false);
  t.win.history.back();
  assert.deepEqual(steps, ["back"], "a back step of its own, later, is taken");
  for (let i = 0; i < 6; i += 1) t.wheel(0, 8); // scrolling the list up and down guards nothing
  t.win.history.forward();
  assert.deepEqual(steps, ["back", "forward"]);
  t.finish();
  t.profiles.stop();
  assert.equal(Object.hasOwn(t.win.history, "back"), false, "History's own methods back on stop");
});

test("with T3's report of a gesture's end, the guard holds until it: fingers resting long before lifting still keep T3's step from being taken", async () => {
  let begin = null;
  let end = null;
  const trackpad = { onBegin: (fn) => ((begin = fn), () => {}), onEnd: (fn) => ((end = fn), () => (end = null)) };
  const t = setup({ rows: ROWS4, stored: FOUR, trackpad });
  const steps = [];
  t.win.History.prototype.back = function () { steps.push("back"); };
  await t.profiles.start();
  begin(); // fingers on the pad: T3 reports the touch
  for (let i = 0; i < 6; i += 1) t.wheel(8);
  await t.clock.advance(700); // fingers resting on the pad, no events
  t.win.history.back();
  assert.deepEqual(steps, [], "still held");
  end(); // fingers lifted: T3 steps now, if at all
  t.win.history.back();
  assert.deepEqual(steps, [], "T3's step right at the end is not taken");
  for (let i = 0; i < 3; i += 1) t.wheel(4); // events held back, arriving after the end report
  await t.clock.advance(450);
  t.win.history.back();
  assert.deepEqual(steps, ["back"], "a moment later, back steps are taken again (late events hold it only briefly)");
  t.finish();
  t.profiles.stop();
  assert.equal(end, null, "stops listening for the end too");
});

test("a sideways swipe's own touch, reported late, holds the guard to its end; a touch after that end (another gesture) does not", async () => {
  let begin = null;
  let end = null;
  const trackpad = { onBegin: (fn) => ((begin = fn), () => {}), onEnd: (fn) => ((end = fn), () => {}) };
  const t = setup({ rows: ROWS4, stored: FOUR, trackpad });
  const steps = [];
  t.win.History.prototype.back = function () { steps.push("back"); };
  await t.profiles.start();
  for (let i = 0; i < 6; i += 1) t.wheel(8); // a swipe, its touch not reported yet
  begin(); // its own touch, reported late (after its first events): holds the guard until its end
  await t.clock.advance(450); // fingers resting: past the guard's own time
  t.win.history.back();
  assert.deepEqual(steps, [], "held by the late report");
  for (let i = 0; i < 34; i += 1) t.wheel(8); // on to the switch
  await t.started();
  t.finish();
  end(); // its end
  await t.clock.advance(250);
  begin(); // the next touch: a back swipe over the chat, say (no sidebar events)
  t.win.history.back();
  assert.deepEqual(steps, ["back"], "T3's own back swipe elsewhere is taken");
  assert.equal(t.doc.documentElement.hasAttribute("data-t3plus-profile-swipe"), false, "and its arrow shown");
  t.profiles.stop();
});

test("a sideways wheel with no touch reported (a mouse's thumb wheel, Shift+wheel) holds T3's back and forward only briefly, also where T3 reports touches", async () => {
  let begin = null;
  const trackpad = { onBegin: (fn) => ((begin = fn), () => {}), onEnd: () => () => {} };
  const t = setup({ rows: ROWS4, stored: FOUR, trackpad });
  const steps = [];
  t.win.History.prototype.back = function () { steps.push("back"); };
  await t.profiles.start();
  for (let i = 0; i < 6; i += 1) t.wheel(8); // no touch, so no end report to wait for
  await t.clock.advance(450);
  t.win.history.back();
  assert.deepEqual(steps, ["back"], "taken: not held 15 s for an end that never comes");
  assert.equal(t.doc.documentElement.hasAttribute("data-t3plus-profile-swipe"), false, "and T3's arrow shown again");
  t.finish();
  // Stopped mid-touch, its end no longer reported: started again, no touch is in progress.
  begin();
  t.profiles.stop();
  await t.profiles.start();
  for (let i = 0; i < 6; i += 1) t.wheel(8);
  await t.clock.advance(450);
  t.win.history.back();
  assert.deepEqual(steps, ["back", "back"], "nor after a restart in the middle of a touch");
  t.finish();
  t.profiles.stop();
});

test("a key switch during a swipe's momentum is not overridden by it; held keys switch once", async () => {
  const t = setup({ rows: ROWS4, stored: FOUR });
  await t.profiles.start();
  for (let i = 0; i < 40; i += 1) t.wheel(8);
  t.key(3); // Ctrl+Shift+3 while the momentum still comes in
  for (const dx of [8, 6, 5, 4]) t.wheel(dx);
  await t.started();
  t.finish();
  assert.equal(t.profiles.state.active, "c");
  await t.clock.advance(300);
  t.key(4);
  t.key(4, true);
  t.key(4, true); // held down
  assert.ok(t.copy(), "the first press slides; the repeats do not land it at once");
  await t.started();
  t.finish();
  assert.equal(t.profiles.state.active, "d");
  t.profiles.stop();
});

test("the copy survives bots being off (their clean-up), a route followed while a switch lands starts no second slide, and nothing is left behind", async () => {
  const t = setup({ rows: ROWS4, stored: FOUR });
  await t.profiles.start();
  t.dot("work").click();
  clearBotDecoration(t.doc.querySelector('[data-slot="sidebar-inner"]'));
  assert.ok(t.copy(), "bots off removes its own marks, not the copy");
  // A thread of C opens (⌘K, T3 itself) before Work's thread was asked for; then a click on D.
  t.win.history.pushState({}, "", "/env/c1");
  t.profiles.sync();
  t.dot("d").click();
  await t.started();
  for (const a of live(t)) a.finish();
  await t.started();
  for (const a of live(t)) a.finish();
  assert.equal(t.doc.querySelectorAll("[data-t3plus-profile-next]").length, 0, "no copy left");
  assert.equal(live(t).length, 0, "every animation ended (none holds the list aside)");
  assert.equal(t.list.style.transform, "");
  assert.equal(t.doc.querySelector("[data-t3plus-profile-sliding]"), null);
  assert.equal(t.profiles.state.active, "d");
  t.profiles.stop();
});

test("turning profiles off mid-switch drops it; a double-click on New makes one profile", async () => {
  let on = true;
  const t = setup({ enabled: () => on });
  await t.profiles.start();
  t.dot("work").click();
  on = false;
  t.profiles.sync();
  assert.equal(t.copy(), null);
  assert.equal(t.list.style.transform, "");
  await t.started();
  assert.equal(t.profiles.state.active, "main", "nothing saved");
  assert.equal(t.route(), "/env/a1", "and no thread opened");
  t.profiles.stop();

  const n = setup();
  await n.profiles.start();
  const add = n.doc.querySelector(".t3plus-profile-add");
  add.click();
  add.click();
  await n.started();
  n.finish();
  assert.deepEqual(n.profiles.state.list.map((p) => p.name), ["Main", "Work", "3"]);
  n.profiles.stop();
});

test("fingers back on the pad while the list springs back: it carries on from where it is", async () => {
  const t = setup();
  const { clock } = t;
  await t.profiles.start();
  for (let i = 0; i < 5; i += 1) {
    t.wheel(6);
    await clock.advance(16); // 30 px at a finger's pace, not a flick
  }
  await clock.advance(140); // let go: springing back
  assert.equal(live(t).length > 0, true);
  // Partway back, as Chromium reports it: 60% of the way from -30 px to 0, -12 px.
  live(t).find((a) => a.el === t.list).progress = 0.6;
  const computed = t.win.getComputedStyle;
  t.win.getComputedStyle = (el, ...rest) => {
    assert.notEqual(el, t.list, "where the list is comes from its animation, not a style read");
    return computed.call(t.win, el, ...rest);
  };
  t.wheel(6);
  t.win.getComputedStyle = computed;
  assert.equal(t.list.style.transform, "translate3d(-18px, 0px, 0)", "from where it was on screen, not from the start or the last drag");
  assert.equal(live(t).length, 0, "the spring-back stopped");
  await clock.advance(170);
  t.finish();
  assert.equal(t.profiles.state.active, "main");
  t.profiles.stop();
});

test("a switch made from the keyboard on the dots keeps the focus there when T3 moves it to the composer; a mouse click does not", async () => {
  const t = setup();
  const composer = t.doc.createElement("textarea");
  t.doc.body.append(composer);
  await t.profiles.start();
  const work = t.dot("work");
  work.focus();
  work.click(); // Enter or Space on a focused button: a click with detail 0
  await t.started();
  composer.focus(); // T3 opening the thread
  await t.clock.frames(2);
  assert.equal(t.doc.activeElement, work, "back on the dot");
  t.finish();
  composer.dispatchEvent(new t.win.MouseEvent("pointerdown", { bubbles: true }));
  composer.focus(); // then a click in the composer, on purpose
  await t.clock.frames(2);
  assert.equal(t.doc.activeElement, composer);

  const main = t.dot("main");
  main.dispatchEvent(new t.win.MouseEvent("click", { bubbles: true, cancelable: true, detail: 1 }));
  await t.started();
  composer.focus();
  await t.clock.frames(2);
  assert.equal(t.doc.activeElement, composer, "a mouse click leaves the focus to T3");
  t.finish();
  t.profiles.stop();
});

test("quick switches one after another (Work, Main, an empty one) end on the last, with no flip back to a profile whose thread opened on the way", async () => {
  const t = setup({ rows: ROWS4, stored: { ...FOUR, list: [...FOUR.list, { id: "e", name: "Empty" }] } });
  await t.profiles.start();
  t.dot("work").click();
  await t.started(); // Work's thread opens
  assert.equal(t.route(), "/env/b1");
  t.dot("main").click(); // lands Work; Main slides, its thread not asked for yet
  t.dot("e").click(); // lands Main without it; Empty has no thread to open
  for (let i = 0; i < 3; i += 1) {
    await t.started();
    for (const a of live(t)) a.finish();
    await t.clock.advance(5);
    t.profiles.sync();
  }
  assert.equal(t.profiles.state.active, "e", "no switch back to Work for the thread it opened");
  assert.equal(t.doc.querySelectorAll("[data-t3plus-profile-next]").length, 0);
  assert.equal(live(t).length, 0);
  assert.equal(t.list.style.transform, "");
  t.profiles.stop();
});


test("momentum T3 held back for longer than the pause (no frames painted) still moves nothing", async () => {
  const t = setup({ rows: ROWS4, stored: FOUR });
  await t.profiles.start();
  for (let i = 0; i < 40; i += 1) t.wheel(8);
  await t.started();
  t.finish();
  t.clock.stall(350); // the main thread held (T3 drawing a thread): no frames
  for (const dx of [40, 12, 6]) t.wheel(dx); // all at once, after the stall
  assert.equal(t.copy(), null);
  await t.clock.advance(400);
  assert.equal(t.profiles.state.active, "work");
  t.profiles.stop();
});

test("a switch made before a swipe's direction is known uses the swipe up: no slide is left half way", async () => {
  for (const act of [(t) => t.key(2), (t) => t.doc.querySelector(".t3plus-profile-add").click()]) {
    const t = setup();
    await t.profiles.start();
    t.wheel(2); // too little to tell sideways from up and down
    act(t);
    for (let i = 0; i < 8; i += 1) t.wheel(6);
    await t.clock.advance(300);
    await t.started();
    for (const a of live(t)) a.finish();
    assert.equal(t.copy(), null);
    assert.equal(t.list.style.transform, "");
    assert.equal(t.doc.querySelector("[data-t3plus-profile-sliding]"), null);
    assert.notEqual(t.profiles.state.active, "main");
    t.profiles.stop();
  }
});

test("a finger slowing down past half way is still on the pad: going back cancels", async () => {
  const t = setup();
  const visited = [];
  const push = t.win.history.pushState.bind(t.win.history);
  t.win.history.pushState = (st, title, url) => (visited.push(String(url)), push(st, title, url));
  await t.profiles.start();
  for (const dx of [14, 13, 12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2]) {
    t.wheel(dx); // 104 px of 212, slowing down
    await t.clock.advance(16);
  }
  for (let i = 0; i < 20; i += 1) {
    t.wheel(-6); // and back
    await t.clock.advance(16);
  }
  await t.clock.advance(170);
  for (const a of live(t)) a.finish();
  assert.equal(t.profiles.state.active, "main");
  assert.deepEqual(visited, [], "no switch on the way: Work's thread was never opened");
  t.profiles.stop();
});

test("a key switch while another slides goes the right way; quick switches from a pinned thread remember no wrong thread", async () => {
  const t = setup({ rows: ROWS4, stored: FOUR });
  await t.profiles.start();
  t.dot("c").click();
  t.key(2); // Work, left of C: it comes in from the left
  const last = t.anims.filter((a) => a.el === t.list).at(-1);
  assert.equal(last.keyframes.at(-1).transform, "translate3d(212px, 0px, 0)");
  t.profiles.stop();

  const p = setup({ rows: thread("env:pin", "shelf:pinned") + ROWS4, stored: FOUR, path: "/env/pin" });
  await p.profiles.start();
  p.dot("work").click();
  p.dot("c").click(); // Work landed before its thread opened
  await p.started();
  for (const a of live(p)) a.finish();
  assert.equal(p.profiles.state.last?.work, undefined, "the pinned thread is not Work's");
  p.dot("work").click();
  await p.started();
  assert.equal(p.route(), "/env/b1", "Work opens its own thread");
  p.profiles.stop();
});

test("each profile keeps its place in the list with reduced motion too", async () => {
  const t = setup({ reduced: true });
  const scroller = t.doc.querySelector('[data-slot="scroll-area-viewport"]');
  let top = 300;
  Object.defineProperty(scroller, "scrollTop", { get: () => top, set: (v) => (top = v), configurable: true });
  await t.profiles.start();
  t.dot("work").click();
  assert.equal(top, 0, "Work from the top");
  top = 40;
  t.dot("main").click();
  assert.equal(top, 300, "Main where it was left");
  t.dot("work").click();
  assert.equal(top, 40);
  t.profiles.stop();
});

test("the copy has the real list's shape (hidden rows as empty stand-ins), screenshot mode's text in it is never refreshed from T3's, and a save arriving mid-switch keeps the thread just noted", async () => {
  const t = setup({ rows: folder("p/b") + thread("env:b1", "folder:p/b") + ROWS.replace(folder("p/b") + thread("env:b1", "folder:p/b"), "") });
  await t.profiles.start();
  t.dot("work").click();
  const copy = t.copy();
  assert.equal(copy.children.length, t.list.children.length, "same rows, so :first-child and sibling styles match");
  const stubs = [...copy.children].filter((li) => li.hasAttribute("data-t3plus-profile-off"));
  assert.ok(stubs.length && stubs.every((li) => li.childElementCount === 0), "hidden ones are empty");
  // Another window (or this one's earlier save coming back) writes without Main's last thread.
  await t.storage.area.set({ [STORAGE_KEYS.profiles]: { ...TWO } });
  await t.started();
  t.finish();
  assert.equal(t.profiles.state.active, "work");
  assert.equal(t.profiles.state.last?.main, "env:a1", "Main remembers a1");
  t.profiles.stop();

  let demo = true;
  const d = setup({ demo: () => demo });
  await d.profiles.start();
  d.dot("work").click();
  await d.started();
  const real = d.list.querySelector('[data-sidebar-row="env:b1"]');
  real.setAttribute("aria-current", "page");
  real.querySelector("span").textContent = "Real title";
  d.profiles.sync();
  assert.equal(d.copy().textContent.includes("Real title"), false, "screenshot mode: not copied before it is covered");
  d.finish();
  d.profiles.stop();
});

test("the focus kept on the dots after a keyboard switch gives way to a dialog T3 opens", async () => {
  const t = setup();
  await t.profiles.start();
  const work = t.dot("work");
  work.focus();
  work.click();
  await t.started();
  const dialog = t.doc.createElement("div");
  dialog.setAttribute("role", "dialog");
  const ok = t.doc.createElement("button");
  dialog.append(ok);
  t.doc.body.append(dialog);
  ok.focus();
  await t.clock.frames(4);
  assert.equal(t.doc.activeElement, ok);
  t.finish();
  t.profiles.stop();
});

test("the thread swaps smoothly too: the chat fades out, stays hidden until T3 has drawn the new thread, then fades in", async () => {
  const t = setup();
  await t.profiles.start();
  const canvas = t.doc.querySelector(".messages-timeline-scroll");
  const onCanvas = () => t.anims.filter((a) => a.el === canvas);
  t.dot("work").click();
  const [out] = onCanvas();
  assert.deepEqual(out?.keyframes.map((k) => k.opacity), [1, 0], "out, with the slide");
  assert.equal(out.options.fill, "forwards", "and held hidden");
  assert.equal(t.route(), "/env/a1", "T3 is asked for the thread only once the fade runs too");
  await t.started();
  assert.equal(t.route(), "/env/b1");
  await t.clock.frames(4);
  assert.equal(onCanvas().length, 1, "still hidden: T3 has not drawn it yet");
  const more = t.doc.createElement("div"); // the old thread still streaming
  more.setAttribute("data-timeline-row-id", "a1-m2");
  canvas.append(more);
  await t.clock.frames(4);
  assert.equal(onCanvas().length, 1, "more of the old thread is not the new one");
  canvas.innerHTML = '<div data-timeline-row-id="b1-m1">b1</div>'; // T3 draws the thread
  await t.clock.frames(4);
  const [, inn] = onCanvas();
  assert.deepEqual(inn?.keyframes.map((k) => k.opacity), [0, 1], "then in");
  assert.ok(out.cancelled, "the hold is let go");
  assert.equal(t.anims.some((a) => a.el.matches?.(".composer, [data-chat-canvas]")), false, "the composer is not faded (its glass)");
  t.finish();
  t.profiles.stop();

  const r = setup({ reduced: true });
  await r.profiles.start();
  r.dot("work").click();
  assert.equal(r.anims.length, 0, "reduced motion: no fade");
  r.profiles.stop();
});

test("a switch with no other thread to open does not fade the chat; one overtaken shows it again", async () => {
  const t = setup({ rows: ROWS4, stored: { ...FOUR, list: [...FOUR.list, { id: "e", name: "Empty" }] } });
  await t.profiles.start();
  const canvas = t.doc.querySelector(".messages-timeline-scroll");
  t.dot("e").click(); // no threads there
  assert.equal(t.anims.filter((a) => a.el === canvas).length, 0);
  await t.started();
  for (const a of live(t)) a.finish();
  t.dot("work").click(); // fades out...
  t.dot("e").click(); // ...and is overtaken by a switch with nothing to open
  await t.clock.frames(3);
  const last = t.anims.filter((a) => a.el === canvas).at(-1);
  assert.equal(last.keyframes.at(-1).opacity, 1, "faded back in");
  t.profiles.stop();
});

test("the open profile's name sits beside the dots in its color, and T3's sky takes the profile's own sky color", async () => {
  const t = setup({ stored: { ...TWO, list: [{ id: "main", name: "Main", color: "default" }, { id: "work", name: "Work", color: "blue", sky: "orange" }] } });
  t.win.CSS = { supports: () => true }; // Chromium's relative colors
  // (created again: support is checked when profiles start)
  const storage = createFakeChromeStorage();
  storage.area.data.set(STORAGE_KEYS.profiles, { ...TWO, list: [{ id: "main", name: "Main", color: "default" }, { id: "work", name: "Work", color: "blue", sky: "orange" }] });
  t.profiles = createProfiles({ win: t.win, doc: t.doc, area: storage.area, changedEvent: storage.onChanged });
  await t.profiles.start();
  const name = t.doc.querySelector(".t3plus-profiles-name");
  const root = t.doc.documentElement;
  assert.equal(name.textContent, "Main");
  assert.equal(name.style.getPropertyValue("--t3plus-profile-color"), "", "the default color: T3's text color");
  const sky = (name) => lookValue(t.doc, LOOK.sky, `--t3plus-sky-${name}`);
  assert.equal(sky("mix"), "0", "and T3's own sky");
  assert.equal(root.hasAttribute("data-t3plus-sky-ready"), false, "no glide in from T3's sky on load");
  t.dot("work").click();
  assert.equal(name.textContent, "Work", "named as soon as it slides in");
  assert.equal(name.style.getPropertyValue("--t3plus-profile-color"), "#3b82f6", "the name in the dot's color");
  assert.ok(root.hasAttribute("data-t3plus-sky"));
  assert.equal(sky("turn"), "129.6", "the sky in its own pick: from the theme's 278° to orange's 47.6°, the short way round");
  assert.equal(sky("mix"), "1", "the sky in the profile's color");
  assert.equal(root.getAttribute("style"), null, "on the sky, not on <html> (inherited by the whole page)");
  // Another theme (Ember: an orange sky): the same pick turns it far less.
  t.doc.querySelector(".sidebar-stage-backdrop").style.setProperty("--stage-night-mid", "oklch(25% .08 31.1)");
  t.doc.documentElement.setAttribute("data-theme-id", "ember"); // T3 switching theme
  t.profiles.sync();
  assert.equal(sky("turn"), "16.5", "measured from the theme's own sky");
  t.finish();
  t.profiles.stop();
  assert.equal(root.hasAttribute("data-t3plus-sky"), false, "T3's sky as it was");
  assert.equal(sky("turn"), "");
});

// A profile's glow and bubble colors are its settings (settingsScopes.js): the editor
// reads and writes them through the app, here a plain map.
function fakeScoped() {
  const values = new Map();
  return { values, get: (id, path) => values.get(`${id} ${path}`), set: (id, path, value) => (value === null ? values.delete(`${id} ${path}`) : values.set(`${id} ${path}`, value)) };
}

test("the profile editor: an icon, and one row of colors for the dot, the sky, the glow or the bubbles", async () => {
  const scoped = fakeScoped();
  const t = setup({ stored: { ...TWO, list: [{ id: "main", name: "Main" }, { id: "work", name: "Work", color: "blue" }] }, scoped });
  await t.profiles.start();
  assert.equal(t.profiles.state.list[1].sky, "default", "T3's sky until one is picked");
  t.dot("work").dispatchEvent(new t.win.MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
  const editor = t.doc.querySelector(".t3plus-profile-editor");
  // The icon.
  const icons = editor.querySelector('[role=radiogroup][aria-label="Icon"]');
  icons.querySelector('[aria-label="Rocket"]').click();
  assert.equal(t.profiles.state.list[1].icon, "rocket");
  assert.equal(t.doc.querySelector(".t3plus-profiles-name svg"), null, "Main is open: no icon");
  t.profiles.switchTo("work");
  assert.ok(t.doc.querySelector(".t3plus-profiles-name svg"), "Work's icon, beside its name");
  t.finish();
  // One row of colors; the tabs say what it colors.
  const tabs = [...editor.querySelectorAll(".t3plus-profile-tab")].map((b) => b.textContent);
  assert.deepEqual(tabs, ["Dot", "Sky", "Glow", "Bubble"]);
  assert.equal(editor.querySelectorAll(".t3plus-profile-colors").length, 1, "not a row each");
  const row = () => editor.querySelector(".t3plus-profile-colors");
  row().querySelector('[aria-label="Teal"]').click();
  assert.equal(t.profiles.state.list[1].color, "teal");
  editor.querySelector('.t3plus-profile-tab[data-field="sky"]').click();
  assert.equal(row().getAttribute("aria-label"), "Sky color");
  assert.equal(row().querySelector('[aria-checked="true"]').getAttribute("aria-label"), "Default");
  row().querySelector('[aria-label="Orange"]').click();
  editor.querySelector('.t3plus-profile-tab[data-field="glow"]').click();
  assert.equal(row().querySelector('[aria-checked="true"]').getAttribute("aria-label"), "Default", "no glow of its own: the one for all profiles");
  row().querySelector('[aria-label="Pink"]').click();
  editor.querySelector('.t3plus-profile-tab[data-field="bubble"]').click();
  row().querySelector('[aria-label="Blue"]').click();
  assert.deepEqual([t.profiles.state.list[1].color, t.profiles.state.list[1].sky], ["teal", "orange"], "the dot and sky are the profile's own");
  assert.equal(scoped.get("work", "composerGradient.accent"), "#ec4899", "the glow is its setting, as a color");
  assert.equal(scoped.get("work", "chat.bubble"), "#3b82f6");
  assert.equal("dither" in t.profiles.state.list[1], false, "nothing of it kept on the profile");
  // A color set in Settings shows as one more choice, picked; Default lets it follow all profiles.
  scoped.set("work", "composerGradient.accent", "#12ab34");
  editor.querySelector('.t3plus-profile-tab[data-field="glow"]').click();
  assert.equal(row().querySelector('[aria-checked="true"]').getAttribute("aria-label"), "Custom");
  row().querySelector('[aria-label="Default"]').click();
  assert.equal(scoped.get("work", "composerGradient.accent"), undefined, "cleared");
  t.profiles.stop();
});

test("the editor has no Sky tab where T3 draws no sky; each row is one Tab stop with arrow keys", async () => {
  const t = setup({ stored: { ...TWO, list: [{ id: "main", name: "Main" }, { id: "work", name: "Work", color: "blue" }] } });
  t.doc.querySelector(".sidebar-stage-backdrop").remove(); // stable T3: no night art
  await t.profiles.start();
  t.dot("work").dispatchEvent(new t.win.MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
  const editor = t.doc.querySelector(".t3plus-profile-editor");
  assert.deepEqual([...editor.querySelectorAll(".t3plus-profile-tab")].map((b) => b.textContent), ["Dot"], "no sky, and without the app's settings no glow or bubbles");
  const radios = [...editor.querySelectorAll(".t3plus-profile-colors [role=radio]")];
  assert.deepEqual(radios.filter((r) => r.tabIndex === 0).map((r) => r.getAttribute("aria-label")), ["Blue"], "one Tab stop: the picked one");
  radios[1].focus();
  radios[1].dispatchEvent(new t.win.KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true }));
  assert.equal(t.profiles.state.list[1].color, "purple", "arrows move and pick");
  t.profiles.stop();
});

test("bad colors and icons are dropped; a custom color or a preset is kept", () => {
  const n = normalizeProfiles({ list: [{ id: "a", name: "A", color: "#GGGGGG", sky: "#0A0B0C", dither: "nope", icon: "<svg>" }, { id: "b", name: "B", color: "teal", icon: "rocket" }] });
  assert.deepEqual(n.list[0], { id: "a", name: "A", color: "default", sky: "#0a0b0c" }, "an old glow color is not a profile's (settingsScopes.js moves it)");
  assert.deepEqual(n.list[1], { id: "b", name: "B", color: "teal", sky: "default", icon: "rocket" });
  // A backup that repeats an id: one profile (one dot), the first entry of it.
  const twice = normalizeProfiles({ list: [{ id: "a", name: "A" }, { id: "a", name: "Again" }, { id: "b", name: "B" }], projects: { "p/x": "b" } });
  assert.deepEqual(twice.list.map((p) => p.name), ["A", "B"]);
  // A folder key named like one of an object's own built-ins is no inherited value.
  assert.equal(profileOf(twice, "constructor"), "a", "an unplaced folder: the first profile's");
  assert.equal(profileOf(twice, "p/x"), "b");
});

test("the app is told which profile is on screen (one sliding in counts), and that none is once profiles stop", async () => {
  const shown = [];
  const deleted = [];
  const dom = createDom("/env/a1", `<div data-slot="sidebar-inner"><ul id="list">${ROWS}</ul><div data-slot="sidebar-footer"></div></div>`);
  const storage = createFakeChromeStorage();
  storage.area.data.set(STORAGE_KEYS.profiles, TWO);
  const profiles = createProfiles({ win: dom.window, doc: dom.window.document, area: storage.area, changedEvent: storage.onChanged, onShown: (id) => shown.push(id), onDelete: (id) => deleted.push(id) });
  await profiles.start();
  assert.equal(shown.at(-1), "main");
  profiles.switchTo("work");
  assert.equal(shown.at(-1), "work");
  // Deleting Work (from its dot's editor) tells the app, so its settings go too.
  dom.window.document.querySelector('.t3plus-profile-dot[data-profile="work"]').dispatchEvent(new dom.window.MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
  dom.window.document.querySelector(".t3plus-profile-editor .t3plus-profile-delete").click();
  assert.deepEqual(deleted, ["work"]);
  profiles.stop();
  assert.deepEqual(shown, ["main", "work", "main", null]);
});

test("profiles turned off mid-switch leave the chat visible", async () => {
  let on = true;
  const t = setup({ enabled: () => on });
  await t.profiles.start();
  const list = t.doc.querySelector(".messages-timeline-scroll");
  t.dot("work").click();
  on = false;
  t.profiles.sync();
  await t.clock.frames(3);
  const last = t.anims.filter((a) => a.el === list).at(-1);
  assert.equal(last.keyframes.at(-1).opacity, 1, "faded back in");
  t.profiles.stop();
});

test("a backup import keeps profiles' icons and colors, and drops anything that is not one", async () => {
  const { importAll, exportAll } = await import("../src/backup.js");
  const storage = createFakeChromeStorage();
  const backup = {
    app: "t3plus",
    data: {
      [STORAGE_KEYS.profiles]: {
        active: "main",
        list: [
          { id: "main", name: "Main", color: "#3B82F6", sky: "url(x)", icon: '<img src=x onerror="alert(1)">' },
          { id: "w", name: "<b>Work</b>", color: "pink", sky: "teal", icon: "rocket" },
        ],
        projects: {},
      },
    },
  };
  await importAll(storage.area, backup, { [STORAGE_KEYS.profiles]: normalizeProfiles });
  const saved = storage.area.data.get(STORAGE_KEYS.profiles);
  assert.deepEqual(saved.list[0], { id: "main", name: "Main", color: "#3b82f6", sky: "default" }, "a custom hex kept; css and markup dropped");
  assert.deepEqual(saved.list[1], { id: "w", name: "<b>Work</b>", color: "pink", sky: "teal", icon: "rocket" });
  const out = await exportAll(storage.area, "0.21.0");
  assert.deepEqual(out.data[STORAGE_KEYS.profiles].list[1].icon, "rocket", "and exported again");

  // Shown with the name as text, never as markup.
  const t = setup({ stored: saved, path: "/env/b1" });
  await t.profiles.start();
  t.profiles.switchTo("w");
  assert.equal(t.doc.querySelector(".t3plus-profiles-name b"), null);
  assert.equal(t.doc.querySelector(".t3plus-profiles-name").textContent, "<b>Work</b>");
  t.finish();
  t.profiles.stop();
});

test("this window's own saves coming back late (as Chrome's storage does) never undo a newer one", async () => {
  // Chrome-style: the change event arrives a moment after the write, and the write resolves after its event.
  const t = setup({ storage: { eventDelayMs: 5, writeDelayMs: 10 } });
  await t.profiles.start();
  t.profiles.update("work", { icon: "rocket" });
  await t.clock.advance(1);
  t.profiles.update("work", { icon: "star" });
  await t.clock.advance(60);
  assert.equal(t.profiles.state.list[1].icon, "star", "in memory");
  assert.equal(t.storage.area.data.get(STORAGE_KEYS.profiles).list[1].icon, "star", "and stored");
  t.profiles.stop();
});

test("Settings cannot change profiles before the stored ones have loaded", async () => {
  const t = setup({ stored: { ...TWO, list: [...TWO.list, { id: "c", name: "C" }] } });
  const get = t.storage.area.get;
  let release;
  t.storage.area.get = (k) => new Promise((r) => (release = () => r(get(k))));
  const started = t.profiles.start();
  assert.equal(t.profiles.isLoaded(), false);
  await t.profiles.update("main", { icon: "star" });
  assert.equal(t.storage.area.data.get(STORAGE_KEYS.profiles).list.length, 3, "nothing written over them");
  release();
  await started;
  assert.equal(t.profiles.isLoaded(), true);
  assert.equal(t.profiles.state.list.length, 3);
  t.profiles.stop();
});

test("the sky's own hue is read as resolved, also where a theme mixes it", async () => {
  const t = setup({ stored: { ...TWO, list: [{ id: "main", name: "Main" }, { id: "work", name: "Work", sky: "orange" }] } });
  // t3-chat: --stage-night-mid is a color-mix; computed, it is one oklch color (about 304°).
  t.doc.querySelector(".sidebar-stage-backdrop").style.setProperty("--stage-night-mid", "oklch(0.25 0.09 304)");
  await t.profiles.start();
  t.profiles.switchTo("work");
  assert.equal(lookValue(t.doc, LOOK.sky, "--t3plus-sky-turn"), "103.6", "from 304° to orange's 47.6°");
  t.finish();
  t.profiles.stop();
});

test("the editor shows the colors as stored now, after a change from Settings", async () => {
  const t = setup({ stored: { ...TWO, list: [{ id: "main", name: "Main" }, { id: "work", name: "Work", color: "blue" }] } });
  await t.profiles.start();
  t.dot("work").dispatchEvent(new t.win.MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
  const editor = t.doc.querySelector(".t3plus-profile-editor");
  await t.profiles.update("work", { sky: "#12ab34" });
  editor.querySelector('.t3plus-profile-tab[data-field="sky"]').click();
  const picked = editor.querySelector('.t3plus-profile-colors [aria-checked="true"]');
  assert.equal(picked.getAttribute("aria-label"), "Custom", "the custom color, picked");
  assert.equal(picked.style.getPropertyValue("--t3plus-profile-color"), "#12ab34");
  t.profiles.stop();
});

test("a save that changes nothing leaves no echo behind to swallow another window's same write; saved data matches its echo whatever the key order", async () => {
  // Chrome-style: events a moment after the write, none for a value that did not change.
  const t = setup({ storage: { eventDelayMs: 3 } });
  const { area } = t.storage;
  await t.profiles.start();
  await t.profiles.update("work", { icon: "rocket" });
  await t.clock.advance(10);
  await t.profiles.update("work", { icon: "rocket" }); // the same again: nothing written
  await t.clock.advance(10);
  // Another window: switches to Work and back to Main (Main is the value this one holds).
  const other = structuredClone(area.data.get(STORAGE_KEYS.profiles));
  await area.set({ [STORAGE_KEYS.profiles]: { ...other, active: "work" } });
  await t.clock.advance(10);
  assert.equal(t.profiles.state.active, "work");
  await area.set({ [STORAGE_KEYS.profiles]: { ...other, active: "main" } });
  await t.clock.advance(10);
  assert.equal(t.profiles.state.active, "main", "the other window's write is taken, not mistaken for an echo");
  t.profiles.stop();
});

test("a save storage turns down (T3's storage full) is written by the next save of the same, and leaves no echo to swallow another window's write of it", async () => {
  const t = setup();
  const { area } = t.storage;
  const set = area.set;
  await t.profiles.start();
  area.set = () => Promise.reject(new Error("Not enough room left in T3's storage to save this."));
  await assert.rejects(t.profiles.update("work", { icon: "rocket" }));
  area.set = set;
  await t.profiles.update("work", { icon: "rocket" }); // the same again, with room now
  assert.equal(area.data.get(STORAGE_KEYS.profiles).list[1].icon, "rocket", "written, not taken as stored already");

  area.set = () => {
    throw new Error("Extension context invalidated."); // thrown, not rejected: the same
  };
  await assert.rejects(t.profiles.update("work", { icon: "star" }));
  area.set = set;
  const unsaved = structuredClone(t.profiles.state);
  // Another window switches to Work, then writes just what this one could not.
  await area.set({ [STORAGE_KEYS.profiles]: { ...unsaved, active: "work" } });
  assert.equal(t.profiles.state.active, "work");
  await area.set({ [STORAGE_KEYS.profiles]: unsaved });
  assert.equal(t.profiles.state.active, "main", "taken, not mistaken for the echo of the write that failed");
  t.profiles.stop();
});

test("the editor keeps a name being typed when another dot is right-clicked; deleting from the keyboard leaves the focus on the open profile's dot", async () => {
  const t = setup({ stored: { ...TWO, list: [...TWO.list, { id: "c", name: "C" }] } });
  await t.profiles.start();
  const menu = (id) => t.dot(id).dispatchEvent(new t.win.MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
  menu("work");
  t.doc.querySelector(".t3plus-profile-editor input").value = "Work 2";
  menu("c");
  assert.equal(t.profiles.state.list[1].name, "Work 2", "kept, not dropped");
  assert.equal(t.doc.querySelector(".t3plus-profile-editor").dataset.profile, "c");
  t.doc.querySelector(".t3plus-profile-editor .t3plus-profile-delete").focus();
  t.doc.querySelector(".t3plus-profile-editor .t3plus-profile-delete").click();
  assert.equal(t.profiles.state.list.length, 2);
  assert.equal(t.doc.activeElement?.dataset.profile, "main", "on the open profile's dot, not <body>");
  t.profiles.stop();
});

test("the arrow keys' Tab stop is not reset by a check while on the dots; New is never a second stop; a switch moves it", async () => {
  const t = setup();
  await t.profiles.start();
  const main = t.dot("main");
  main.focus();
  main.dispatchEvent(new t.win.KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true }));
  t.profiles.sync(); // a check
  const stops = () => [...t.doc.querySelectorAll(".t3plus-profile-dot")].filter((d) => d.tabIndex === 0).map((d) => d.dataset.profile);
  assert.deepEqual(stops(), ["work"], "still where the arrows put it");
  t.doc.activeElement.dispatchEvent(new t.win.KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true }));
  assert.deepEqual(stops(), ["+new"]);
  t.doc.activeElement.blur(); // Tab away
  t.profiles.sync();
  assert.deepEqual(stops(), ["main"], "back to the open profile, New not a second stop");
  t.profiles.stop();
});

test("stopped while a thread note is waiting and storage throws (an orphaned copy): everything is still put back", async () => {
  const t = setup();
  await t.profiles.start();
  t.go("/env/b1"); // a route: a note waits to be written
  t.go("/env/a1");
  t.storage.area.set = () => {
    throw new Error("Extension context invalidated.");
  };
  t.profiles.stop();
  assert.equal(t.doc.querySelectorAll("[data-t3plus-profile-off]").length, 0, "rows shown again");
  assert.equal(t.doc.querySelector(".t3plus-profiles"), null, "dots gone");
});

test("a switch made on Settings: back to the chat (T3 reopens its old thread), the profile's own thread opens instead of switching back", async () => {
  const t = setup({ reduced: true });
  await t.profiles.start();
  t.go("/settings/appearance");
  t.profiles.switchTo("work");
  assert.equal(t.profiles.state.active, "work");
  t.go("/env/a1"); // T3 goes back to the thread it had (Main's)
  assert.equal(t.profiles.state.active, "work", "not switched back");
  assert.equal(t.route(), "/env/b1", "Work's thread opened");
  t.profiles.sync(); // the check after it shows
  t.go("/env/a1"); // and opening Main's thread from here on, on purpose, does follow
  assert.equal(t.profiles.state.active, "main");
  t.profiles.stop();
});

test("Settings is told when profiles load and change (its card follows)", async () => {
  const t = setup();
  let told = 0;
  const profiles = createProfiles({ win: t.win, doc: t.doc, area: t.storage.area, changedEvent: t.storage.onChanged, onChange: () => (told += 1) });
  await profiles.start();
  assert.ok(told >= 1, "on load");
  const before = told;
  await profiles.update("work", { icon: "star" });
  assert.ok(told > before, "on a change here");
  const mid = told;
  await t.storage.area.set({ [STORAGE_KEYS.profiles]: { ...profiles.state, list: profiles.state.list.map((p) => (p.id === "work" ? { ...p, name: "Elsewhere" } : p)) } });
  assert.ok(told > mid, "and on one from another window");
  profiles.stop();
});

// ---------- A switch costs no forced style or layout read ----------

/** Counts the theme's sky probes (getComputedStyle on the probe t3+ puts beside the sky). */
function countProbes(t) {
  let probes = 0;
  const computed = t.win.getComputedStyle;
  t.win.getComputedStyle = (el, ...rest) => {
    if (/var\(--stage-night-mid\)/.test(el.style?.cssText ?? "")) probes += 1;
    return computed(el, ...rest);
  };
  return () => probes;
}

test("the theme's sky is probed once per theme: t3+'s own values on <html> are no theme change", async () => {
  const t = setup({ reduced: true, stored: { ...TWO, list: [{ id: "main", name: "Main", sky: "teal" }, { id: "work", name: "Work", sky: "orange" }] } });
  t.profiles = createProfiles({ win: t.win, doc: t.doc, area: t.storage.area, changedEvent: t.storage.onChanged });
  const probes = countProbes(t);
  await t.profiles.start();
  assert.equal(probes(), 1, "measured once");
  const root = t.doc.documentElement;
  for (let i = 0; i < 4; i += 1) {
    t.profiles.switchTo(i % 2 ? "main" : "work");
    root.style.setProperty("--t3plus-something", String(i)); // t3+ writing its own values there
    t.profiles.sync();
  }
  assert.equal(probes(), 1, "not again on a switch, nor for a value of t3+'s on <html>");
  assert.equal(root.getAttribute("style"), "--t3plus-something: 3;", "the switches wrote nothing on <html>");
  root.style.setProperty("--app-theme-primary", "red"); // T3's own inline theme values
  t.profiles.switchTo("work");
  assert.equal(probes(), 2, "T3's own inline theme values are a new theme");
  root.setAttribute("data-theme-id", "ember");
  t.profiles.switchTo("main");
  assert.equal(probes(), 3, "and so is another palette");
  t.profiles.stop();
});

test("the sky's values sit on T3's sky (one T3 mounts anew has them from its first frame); with no sky nothing is written on <html>", async () => {
  const t = setup({ stored: { ...TWO, list: [{ id: "main", name: "Main" }, { id: "work", name: "Work", sky: "orange" }] } });
  await t.profiles.start();
  t.dot("work").click();
  assert.equal(lookValue(t.doc, LOOK.sky, "--t3plus-sky-turn"), "129.6");
  const old = t.doc.querySelector(".sidebar-stage-backdrop");
  const fresh = old.cloneNode(true);
  old.replaceWith(fresh); // T3 re-renders its sky
  assert.ok(fresh.matches(LOOK.sky), "the rule names the new one too");
  assert.equal(t.doc.documentElement.getAttribute("style"), null);
  t.finish();
  t.profiles.stop();

  const bare = setup({ stored: { ...TWO, list: [{ id: "main", name: "Main" }, { id: "work", name: "Work", sky: "orange" }] } });
  bare.doc.querySelector(".sidebar-stage-backdrop").remove();
  await bare.profiles.start();
  bare.dot("work").click();
  assert.equal(bare.doc.documentElement.getAttribute("style"), null, "nothing on <html> (inherited by every element)");
  bare.finish();
  bare.profiles.stop();
});

test("a dot switch reads the list's place once, before its first write, and neither the chat's nor the list's style", async () => {
  const t = setup();
  const scroller = t.doc.querySelector('[data-slot="scroll-area-viewport"]');
  let top = 0;
  const reads = [];
  const writes = [];
  Object.defineProperty(scroller, "scrollTop", { get: () => (reads.push(top), top), set: (v) => (writes.push(v), (top = v)), configurable: true });
  const canvas = t.doc.querySelector(".messages-timeline-scroll");
  const styled = [];
  const computed = t.win.getComputedStyle;
  t.win.getComputedStyle = (el, ...rest) => (styled.push(el), computed(el, ...rest));
  await t.profiles.start();
  reads.length = 0;
  styled.length = 0;
  t.dot("work").click();
  assert.equal(reads.length, 1, "the list's place read once, before anything was written");
  assert.equal(styled.filter((el) => el === canvas || el === t.list).length, 0, "the fade and the slide take where they are from their animations");
  await t.started();
  t.finish();
  assert.deepEqual(writes, [], "both lists at the top: no scrollTop written (even unchanged, a forced layout)");
  top = 40; // Work scrolled down; Main was left at the top
  t.dot("main").click();
  await t.started();
  t.finish();
  assert.deepEqual(writes, [0], "Main back at the top");
  t.profiles.stop();
});

test("a switch made mid-fade starts from where the running fade is, as its animation reports it", async () => {
  const t = setup({ rows: ROWS4, stored: FOUR });
  await t.profiles.start();
  const canvas = t.doc.querySelector(".messages-timeline-scroll");
  const onCanvas = () => t.anims.filter((a) => a.el === canvas);
  t.dot("work").click();
  const [out] = onCanvas();
  out.progress = 0.6; // eased 60% of the way out: the chat at 0.4
  t.dot("c").click();
  const next = onCanvas().at(-1);
  assert.notEqual(next, out);
  assert.equal(next.keyframes[0].opacity, 0.4, "from 0.4, not snapped back to full");
  assert.equal(next.options.duration, 36, "and only the rest of the way (90 ms for all of it)");
  await t.started();
  next.progress = 1;
  t.doc.querySelector(".messages-timeline-scroll").innerHTML = '<div data-timeline-row-id="c1-m1">c1</div>'; // T3 draws C's thread
  await t.clock.frames(4);
  assert.deepEqual(onCanvas().at(-1).keyframes.map((k) => k.opacity), [0, 1], "back in from where the fade-out is");
  t.profiles.stop();
});

test("no slide while T3's list is not shown and nothing of the app's is in its place: the switch is made at once", async () => {
  const t = setup();
  t.list.checkVisibility = () => false;
  await t.profiles.start();
  t.dot("work").click();
  assert.equal(t.copy(), null);
  assert.equal(t.anims.filter((a) => a.el === t.list).length, 0);
  assert.equal(t.profiles.state.active, "work");
  assert.equal(t.route(), "/env/b1", "Work's thread opened");
  t.profiles.stop();
});

test("swiping back and forth across the start reuses the copy made the first time, never two at once", async () => {
  const t = setup({ rows: ROWS4, stored: { ...FOUR, active: "work" }, path: "/env/b1" });
  const { clock } = t;
  await t.profiles.start();
  const copies = () => t.doc.querySelectorAll("[data-t3plus-profile-next]").length;
  const seen = [];
  const swipe = async (dx, n) => {
    for (let i = 0; i < n; i += 1) {
      t.wheel(dx);
      assert.ok(copies() <= 1, "one copy at a time");
      seen.push(t.copy());
      await clock.advance(16); // a finger's pace, not a flick
    }
  };
  await swipe(8, 3); // toward C
  const first = t.copy();
  await swipe(-8, 6); // back past the start: Main's comes in
  assert.notEqual(t.copy(), first);
  await swipe(8, 6); // and C's again
  assert.equal(t.copy(), first, "the copy made the first time");
  await clock.advance(170); // let go short of a third: springs back
  t.finish();
  assert.equal(copies(), 0, "none left");
  assert.equal(t.profiles.state.active, "work");
  t.profiles.stop();
});

test("the copy drops ids and references deep inside a row too", async () => {
  const deep = `<li data-thread-item="env:b2"><div role="button" tabindex="0" data-sidebar-row="env:b2" data-sidebar-parent="folder:p/b" aria-label="env:b2"><span><span id="deep" aria-controls="menu-1" aria-describedby="tip">b2</span></span></div></li>`;
  const t = setup({ rows: ROWS + deep });
  await t.profiles.start();
  t.dot("work").click();
  const copy = t.copy();
  assert.equal(copy.querySelectorAll("[id], [aria-controls], [aria-describedby], [tabindex], [data-sidebar-row], [data-thread-item]").length, 0);
  assert.equal(copy.querySelector('[data-sidebar-parent="folder:p/b"] span span').textContent, "b2", "the row itself copied as is");
  t.finish();
  t.profiles.stop();
});

test("a row T3 nests under another thread (a fork) slides in with that thread's profile, and is an empty stand-in in the others", async () => {
  const t = setup({ rows: ROWS + thread("env:b1fork", "env:b1") });
  await t.profiles.start();
  const fork = () => t.copy().children[t.list.children.length - 1]; // its place in the copy
  t.dot("work").click();
  assert.equal(fork().hasAttribute("data-t3plus-profile-off"), false, "Work's copy shows it");
  assert.equal(fork().textContent.includes("env:b1fork"), true);
  await t.started();
  t.finish();
  t.dot("main").click();
  assert.equal(fork().hasAttribute("data-t3plus-profile-off"), true, "Main's has a stand-in for it");
  assert.equal(fork().childElementCount, 0);
  t.finish();
  t.profiles.stop();
});

test("a row shown in the copy that T3 or the app changes while it slides (its bot face for the profile's own look) is copied again", async () => {
  const t = setup();
  await t.profiles.start();
  t.dot("work").click();
  // The first check after the click draws Work's own bot look on its rows (the app's decoration).
  const row = t.list.querySelector('[data-sidebar-row="env:b1"]');
  const face = t.doc.createElement("span");
  face.className = "t3plus-bot-avatar";
  face.setAttribute("data-t3plus-shape", "earth");
  row.append(face);
  t.profiles.sync();
  assert.equal(t.copy().querySelector('[aria-label="env:b1"] .t3plus-bot-avatar')?.getAttribute("data-t3plus-shape"), "earth", "the real list takes over with nothing on it changing");
  face.setAttribute("data-t3plus-shape", "moon");
  t.profiles.sync();
  assert.equal(t.copy().querySelector('[aria-label="env:b1"] .t3plus-bot-avatar').getAttribute("data-t3plus-shape"), "moon");
  t.finish();
  t.profiles.stop();
});

test("a switch opens the profile's thread through T3's own row click, its row's inert lifted for it", async () => {
  for (const reduced of [false, true]) {
    const t = setup({ reduced });
    await t.profiles.start();
    const row = t.list.querySelector('[data-sidebar-row="env:b1"]');
    let clicks = 0;
    row.addEventListener("click", () => {
      clicks += 1;
      assert.equal(row.closest("[inert]"), null, "not inert while clicked");
    });
    let popstates = 0;
    t.win.addEventListener("popstate", () => (popstates += 1));
    t.dot("work").click();
    if (!reduced) await t.started();
    assert.equal(clicks, 1, `T3's navigation (${reduced ? "at once" : "sliding"})`);
    assert.equal(popstates, 0, "not an address pushed past T3's router");
    assert.equal(t.route(), "/env/b1");
    if (!reduced) {
      assert.ok(row.closest("li").hasAttribute("inert"), "inert again until the switch lands");
      t.finish();
    }
    t.profiles.stop();
  }
});

test("with profiles off, checks do not search the page for rows to show again (once, for rows an earlier copy hid)", async () => {
  let on = true;
  const t = setup({ enabled: () => on });
  await t.profiles.start();
  assert.equal(t.off(t.list, '[data-sidebar-parent="folder:p/b"]'), true);
  let scans = 0;
  const all = t.doc.querySelectorAll.bind(t.doc);
  t.doc.querySelectorAll = (selector) => {
    if (selector.includes("data-t3plus-profile-off")) scans += 1;
    return all(selector);
  };
  on = false;
  for (let i = 0; i < 100; i += 1) t.profiles.sync();
  assert.equal(scans, 1);
  assert.equal(t.off(t.list, '[data-sidebar-parent="folder:p/b"]'), false, "Work's rows shown again");
  t.profiles.stop();
});

test("a switch looks the sidebar up once a task, not a dozen times", async () => {
  const t = setup();
  await t.profiles.start();
  await t.clock.advance(0);
  let lookups = 0;
  const one = t.doc.querySelector.bind(t.doc);
  const all = t.doc.querySelectorAll.bind(t.doc);
  const counted = (fn) => (selector) => {
    if (selector.includes("sidebar-inner") || selector.includes('[data-slot="sidebar"]')) lookups += 1;
    return fn(selector);
  };
  t.doc.querySelector = counted(one);
  t.doc.querySelectorAll = counted(all);
  t.dot("work").click();
  assert.ok(lookups <= 2, `the click: ${lookups}`);
  await t.clock.advance(0);
  lookups = 0;
  await t.started();
  assert.ok(lookups <= 2, `opening the thread: ${lookups}`);
  lookups = 0;
  t.finish();
  assert.ok(lookups <= 2, `landing: ${lookups}`);
  t.profiles.stop();
});

test("a copy kept from earlier in a swipe shows what changed in its rows while the other side's was shown", async () => {
  const t = setup({ rows: ROWS4, stored: { ...FOUR, active: "work" }, path: "/env/b1" });
  const { clock } = t;
  await t.profiles.start();
  const swipe = async (dx, n) => {
    for (let i = 0; i < n; i += 1) {
      t.wheel(dx);
      await clock.advance(16);
    }
  };
  await swipe(8, 3); // toward C: its copy
  const first = t.copy();
  await swipe(-8, 6); // back past the start: Main's
  assert.notEqual(t.copy(), first);
  // T3 marks C's thread open (or the app draws its face) while Main's copy is the one shown.
  t.list.querySelector('[data-sidebar-row="env:c1"]').setAttribute("aria-current", "page");
  t.profiles.sync();
  await swipe(8, 6); // C's again: the copy made the first time, brought up to date
  assert.equal(t.copy(), first);
  assert.equal(t.copy().querySelector('[aria-label="env:c1"]')?.getAttribute("aria-current"), "page");
  await clock.advance(170);
  t.finish();
  t.profiles.stop();
});

test("busy() while a switch slides, so other main-thread work (the glow warming) waits", async () => {
  const t = setup();
  await t.profiles.start();
  assert.equal(t.profiles.busy(), false);
  t.dot("work").click();
  assert.ok(t.copy(), "the switch slides");
  assert.equal(t.profiles.busy(), true);
  t.finish();
  assert.equal(t.profiles.busy(), false, "landed");
  t.profiles.stop();
});
