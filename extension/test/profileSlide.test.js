import assert from "node:assert/strict";
import { after, test } from "node:test";
import { createProfiles } from "../src/profiles.js";
import { clearBotDecoration } from "../src/bots.js";
import { STORAGE_KEYS } from "../src/config.js";
import { createDom, createFakeChromeStorage, settle } from "./helpers.js";

// The slide between profiles: the open list moves out sideways and a copy of the next
// profile's list moves in beside it (by a click, the keys, or a swipe that follows the
// fingers). jsdom has no animations, so a small stand-in records them: `start()` is the
// compositor taking one over, `finish()` its end.

const folder = (key) =>
  `<li data-testid="sidebar-project-folder"><button data-sidebar-row="folder:${key}" aria-expanded="true" id="h-${key.replace("/", "-")}"><span class="truncate">${key}</span></button></li>`;
const thread = (key, parent, current = false) =>
  `<li data-thread-item="${key}"><div role="button" tabindex="0" data-sidebar-row="${key}" data-sidebar-parent="${parent}"${current ? ' aria-current="page"' : ""} aria-label="${key}"><span dir="auto">${key}</span><span>1d</span></div></li>`;
const ROWS = folder("p/a") + thread("env:a1", "folder:p/a", true) + folder("p/b") + thread("env:b1", "folder:p/b");
const TWO = { active: "main", list: [{ id: "main", name: "Main" }, { id: "work", name: "Work" }], projects: { "p/a": "main", "p/b": "work" }, adopted: true };
const windows = [];
after(() => windows.forEach((w) => w.close()));

function setup({ rows = ROWS, stored = TWO, reduced = false, path = "/env/a1", enabled = () => true, demo = () => false } = {}) {
  const dom = createDom(
    path,
    `<div data-slot="sidebar-inner"><div data-slot="scroll-area-viewport"><div id="group"><ul id="list">${rows}</ul></div></div><div data-slot="sidebar-footer"></div></div>`,
  );
  const win = dom.window;
  windows.push(win);
  const doc = win.document;
  const anims = [];
  win.Element.prototype.animate = function (keyframes, options) {
    let start;
    const a = {
      el: this, keyframes, options, onfinish: null, cancelled: false,
      ready: new Promise((resolve) => (start = resolve)),
      start: () => start(),
      cancel() { this.cancelled = true; },
      finish() { if (!this.cancelled) this.onfinish?.(); },
    };
    anims.push(a);
    return a;
  };
  win.matchMedia = (q) => ({ matches: reduced && q.includes("reduce") });
  const list = doc.getElementById("list");
  list.getBoundingClientRect = () => ({ left: 8, top: 0, width: 200, height: 600, right: 208, bottom: 600 });
  doc.addEventListener("click", (e) => {
    const row = e.target.closest?.("[data-thread-item] [data-sidebar-row]");
    if (!row) return;
    const [env, id] = row.getAttribute("data-sidebar-row").split(":");
    win.history.pushState({}, "", `/${env}/${id}`);
  });
  const storage = createFakeChromeStorage();
  storage.area.data.set(STORAGE_KEYS.profiles, stored);
  const profiles = createProfiles({ win, doc, area: storage.area, changedEvent: storage.onChanged, isEnabled: () => enabled(), isDemo: () => demo() });
  const live = () => anims.filter((a) => !a.cancelled);
  return {
    win, doc, list, storage, profiles, anims,
    route: () => win.location.pathname,
    copy: () => doc.querySelector("[data-t3plus-profile-next]"),
    dot: (id) => doc.querySelector(`.t3plus-profile-dot[data-profile="${id}"]`),
    off: (root, sel) => root.querySelector(sel).closest("li").hasAttribute("data-t3plus-profile-off"),
    /** The compositor has the slide: the thread may be asked for now. */
    async started() {
      for (const a of live()) a.start();
      await settle();
      await new Promise((r) => win.requestAnimationFrame(r));
      await settle();
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
  await t.profiles.start();
  t.dot("work").click();
  t.dot("main").click(); // straight back, before the first has started
  assert.equal(t.profiles.state.active, "work", "the first one landed");
  await t.started();
  t.finish();
  assert.equal(t.profiles.state.active, "main");
  assert.equal(t.route(), "/env/a1", "Work's thread was never asked for");
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
    assert.equal(t.wheel(6), true, "a sideways swipe is not a scroll");
    if (i < 4) await sleep(16);
  }
  assert.equal(t.list.style.transform, "translate3d(-30px, 0px, 0)", "the list follows the fingers");
  assert.equal(t.copy().style.transform, "translate3d(182px, 0px, 0)", "and Work's comes in beside it");
  await sleep(170); // the fingers stop
  t.finish();
  assert.equal(t.profiles.state.active, "main", "sprang back");
  assert.equal(t.copy(), null);
  assert.equal(t.list.style.transform, "");

  // Past a third.
  for (let i = 0; i < 15; i += 1) t.wheel(6);
  await sleep(300);
  await t.started();
  t.finish();
  assert.equal(t.profiles.state.active, "work");
  assert.equal(t.route(), "/env/b1", "and Work's thread opened");

  // Up and down (and mostly so): the list scrolls, nothing slides.
  for (let i = 0; i < 6; i += 1) assert.equal(t.wheel(0, 8), false, "scrolling is left alone");
  await sleep(300);
  for (let i = 0; i < 6; i += 1) t.wheel(3, 8);
  assert.equal(t.copy(), null);
  assert.equal(t.list.style.transform, "");
  await sleep(300);
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
  await sleep(300);
  t.finish();
  assert.equal(t.profiles.state.active, "work");
  assert.equal(t.list.style.transform, "");

  for (let i = 0; i < 4; i += 1) t.wheel(8); // a little toward nothing...
  for (let i = 0; i < 16; i += 1) t.wheel(-8); // ...then back the other way, toward Main
  assert.ok(t.copy(), "Main comes in from the left");
  assert.match(t.copy().style.transform, /^translate3d\(-/);
  await sleep(300);
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
const live = (t) => t.anims.filter((a) => !a.cancelled);

test("one swipe is one switch: its momentum (even arriving in bursts after T3 draws the thread) moves nothing more; a pause or the other way starts a new one", async () => {
  const t = setup({ rows: ROWS4, stored: FOUR });
  await t.profiles.start();
  for (let i = 0; i < 40; i += 1) t.wheel(8); // all the way over: switches at once
  await t.started();
  t.finish();
  assert.equal(t.profiles.state.active, "work");
  for (const dx of [7, 15, 30, 6, 4, 3, 2, 1]) t.wheel(dx); // momentum, merged into bigger events by a stall
  await sleep(100);
  for (const dx of [12, 9, 5]) t.wheel(dx);
  assert.equal(t.copy(), null, "nothing moves");
  await sleep(300);
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
  await sleep(100);
  for (let i = 0; i < 12; i += 1) r.wheel(8);
  assert.equal(r.profiles.state.active, "work");
  r.profiles.stop();
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
  await sleep(300);
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
  await t.profiles.start();
  for (let i = 0; i < 5; i += 1) t.wheel(6);
  await sleep(170); // let go: springing back
  assert.equal(live(t).length > 0, true);
  // Partway back, as Chromium reports it (the animation's current value, as a matrix).
  const computed = t.win.getComputedStyle;
  t.win.getComputedStyle = (el, ...rest) => (el === t.list ? { transform: "matrix(1, 0, 0, 1, -12, 0)", position: "relative" } : computed.call(t.win, el, ...rest));
  t.wheel(6);
  t.win.getComputedStyle = computed;
  assert.equal(t.list.style.transform, "translate3d(-18px, 0px, 0)", "from where it was on screen, not from the start or the last drag");
  assert.equal(live(t).length, 0, "the spring-back stopped");
  await sleep(170);
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
  await new Promise((r) => t.win.requestAnimationFrame(() => t.win.requestAnimationFrame(r)));
  assert.equal(t.doc.activeElement, work, "back on the dot");
  t.finish();
  composer.dispatchEvent(new t.win.MouseEvent("pointerdown", { bubbles: true }));
  composer.focus(); // then a click in the composer, on purpose
  await new Promise((r) => t.win.requestAnimationFrame(() => t.win.requestAnimationFrame(r)));
  assert.equal(t.doc.activeElement, composer);

  const main = t.dot("main");
  main.dispatchEvent(new t.win.MouseEvent("click", { bubbles: true, cancelable: true, detail: 1 }));
  await t.started();
  composer.focus();
  await new Promise((r) => t.win.requestAnimationFrame(() => t.win.requestAnimationFrame(r)));
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
    await sleep(5);
    t.profiles.sync();
  }
  assert.equal(t.profiles.state.active, "e", "no switch back to Work for the thread it opened");
  assert.equal(t.doc.querySelectorAll("[data-t3plus-profile-next]").length, 0);
  assert.equal(live(t).length, 0);
  assert.equal(t.list.style.transform, "");
  t.profiles.stop();
});

const busy = (ms) => {
  const end = Date.now() + ms;
  while (Date.now() < end); // the main thread held (T3 drawing a thread): no frames
};
const frames = (t, n = 2) => new Promise((r) => {
  const step = (k) => (k ? t.win.requestAnimationFrame(() => step(k - 1)) : r());
  step(n);
});

test("momentum T3 held back for longer than the pause (no frames painted) still moves nothing", async () => {
  const t = setup({ rows: ROWS4, stored: FOUR });
  await t.profiles.start();
  for (let i = 0; i < 40; i += 1) t.wheel(8);
  await t.started();
  t.finish();
  busy(350);
  for (const dx of [40, 12, 6]) t.wheel(dx); // all at once, after the stall
  assert.equal(t.copy(), null);
  await sleep(400);
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
    await sleep(300);
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
    await sleep(16);
  }
  for (let i = 0; i < 20; i += 1) {
    t.wheel(-6); // and back
    await sleep(16);
  }
  await sleep(170);
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
  await frames(t, 4);
  assert.equal(t.doc.activeElement, ok);
  t.finish();
  t.profiles.stop();
});
