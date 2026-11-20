import assert from "node:assert/strict";
import { after, test } from "node:test";
import { createProfiles, normalizeProfiles } from "../src/profiles.js";
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
// T3's night art at the top of the sidebar (nightly builds), its colors from the theme.
const SKY = '<div class="sidebar-stage-backdrop" style="--stage-night-mid: oklch(22.7% .086 278)"><svg data-stage-art="nightly"></svg></div>';
const windows = [];
after(() => windows.forEach((w) => w.close()));

function setup({ rows = ROWS, stored = TWO, reduced = false, path = "/env/a1", enabled = () => true, demo = () => false } = {}) {
  const dom = createDom(
    path,
    `<div data-slot="sidebar-inner"><div data-slot="scroll-area-viewport"><div id="group"><ul id="list">${rows}</ul></div></div><div data-slot="sidebar-footer"></div></div>${SKY}<div data-workspace-area="conversation"><div data-chat-canvas><div class="messages-timeline-scroll" id="msgs"><div data-timeline-row-id="a1-m1">a1</div></div><div class="composer"></div></div></div>`,
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
  const storage = createFakeChromeStorage();
  storage.area.data.set(STORAGE_KEYS.profiles, stored);
  const profiles = createProfiles({ win, doc, area: storage.area, changedEvent: storage.onChanged, isEnabled: () => enabled(), isDemo: () => demo() });
  const live = () => anims.filter((a) => !a.cancelled);
  return {
    win, doc, list, storage, profiles, anims,
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
const live = (t) => t.anims.filter((a) => !a.cancelled && !a.el.matches(".messages-timeline-scroll")); // the list and its copy

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
  await frames(t, 4);
  assert.equal(onCanvas().length, 1, "still hidden: T3 has not drawn it yet");
  const more = t.doc.createElement("div"); // the old thread still streaming
  more.setAttribute("data-timeline-row-id", "a1-m2");
  canvas.append(more);
  await frames(t, 4);
  assert.equal(onCanvas().length, 1, "more of the old thread is not the new one");
  canvas.innerHTML = '<div data-timeline-row-id="b1-m1">b1</div>'; // T3 draws the thread
  await frames(t, 4);
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
  await frames(t, 3);
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
  assert.equal(root.style.getPropertyValue("--t3plus-sky-mix"), "0", "and T3's own sky");
  assert.equal(root.hasAttribute("data-t3plus-sky-ready"), false, "no glide in from T3's sky on load");
  t.dot("work").click();
  assert.equal(name.textContent, "Work", "named as soon as it slides in");
  assert.equal(name.style.getPropertyValue("--t3plus-profile-color"), "#3b82f6", "the name in the dot's color");
  assert.ok(root.hasAttribute("data-t3plus-sky"));
  assert.equal(root.style.getPropertyValue("--t3plus-sky-turn"), "129.6", "the sky in its own pick: from the theme's 278° to orange's 47.6°, the short way round");
  assert.equal(root.style.getPropertyValue("--t3plus-sky-mix"), "1", "the sky in the profile's color");
  // Another theme (Ember: an orange sky): the same pick turns it far less.
  t.doc.querySelector(".sidebar-stage-backdrop").style.setProperty("--stage-night-mid", "oklch(25% .08 31.1)");
  t.doc.documentElement.setAttribute("data-theme-id", "ember"); // T3 switching theme
  t.profiles.sync();
  assert.equal(root.style.getPropertyValue("--t3plus-sky-turn"), "16.5", "measured from the theme's own sky");
  t.finish();
  t.profiles.stop();
  assert.equal(root.hasAttribute("data-t3plus-sky"), false, "T3's sky as it was");
  assert.equal(root.style.getPropertyValue("--t3plus-sky-turn"), "");
});

test("the profile editor: an icon, and one row of colors for the dot, the sky or the dither glow", async () => {
  const t = setup({ stored: { ...TWO, list: [{ id: "main", name: "Main" }, { id: "work", name: "Work", color: "blue" }] } });
  await t.profiles.start();
  assert.equal(t.profiles.state.list[1].sky, "default", "T3's sky until one is picked");
  assert.equal(t.profiles.state.list[1].dither, "default", "and the glow's own color");
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
  assert.deepEqual(tabs, ["Dot", "Sky", "Dither"]);
  assert.equal(editor.querySelectorAll(".t3plus-profile-colors").length, 1, "not a row each");
  const row = () => editor.querySelector(".t3plus-profile-colors");
  row().querySelector('[aria-label="Teal"]').click();
  assert.equal(t.profiles.state.list[1].color, "teal");
  editor.querySelector('.t3plus-profile-tab[data-field="sky"]').click();
  assert.equal(row().getAttribute("aria-label"), "Sky color");
  assert.equal(row().querySelector('[aria-checked="true"]').getAttribute("aria-label"), "Default");
  row().querySelector('[aria-label="Orange"]').click();
  editor.querySelector('.t3plus-profile-tab[data-field="dither"]').click();
  row().querySelector('[aria-label="Pink"]').click();
  assert.deepEqual([t.profiles.state.list[1].color, t.profiles.state.list[1].sky, t.profiles.state.list[1].dither], ["teal", "orange", "pink"], "each its own");
  // A custom color (made in Settings) shows as one more choice, picked.
  await t.profiles.update("work", { dither: "#12AB34" });
  assert.equal(t.profiles.state.list[1].dither, "#12ab34", "kept, lowercased");
  editor.querySelector('.t3plus-profile-tab[data-field="color"]').click();
  editor.querySelector('.t3plus-profile-tab[data-field="dither"]').click();
  t.profiles.stop();
});

test("the editor has no Sky tab where T3 draws no sky; each row is one Tab stop with arrow keys", async () => {
  const t = setup({ stored: { ...TWO, list: [{ id: "main", name: "Main" }, { id: "work", name: "Work", color: "blue" }] } });
  t.doc.querySelector(".sidebar-stage-backdrop").remove(); // stable T3: no night art
  await t.profiles.start();
  t.dot("work").dispatchEvent(new t.win.MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
  const editor = t.doc.querySelector(".t3plus-profile-editor");
  assert.deepEqual([...editor.querySelectorAll(".t3plus-profile-tab")].map((b) => b.textContent), ["Dot", "Dither"]);
  const radios = [...editor.querySelectorAll(".t3plus-profile-colors [role=radio]")];
  assert.deepEqual(radios.filter((r) => r.tabIndex === 0).map((r) => r.getAttribute("aria-label")), ["Blue"], "one Tab stop: the picked one");
  radios[1].focus();
  radios[1].dispatchEvent(new t.win.KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true }));
  assert.equal(t.profiles.state.list[1].color, "purple", "arrows move and pick");
  t.profiles.stop();
});

test("bad colors and icons are dropped; a custom color or a preset is kept", () => {
  const n = normalizeProfiles({ list: [{ id: "a", name: "A", color: "#GGGGGG", sky: "#0A0B0C", dither: "nope", icon: "<svg>" }, { id: "b", name: "B", color: "teal", icon: "rocket" }] });
  assert.deepEqual(n.list[0], { id: "a", name: "A", color: "default", sky: "#0a0b0c", dither: "default" });
  assert.deepEqual(n.list[1], { id: "b", name: "B", color: "teal", sky: "default", dither: "default", icon: "rocket" });
});

test("the open profile's dither color is the glow's (and the app is told when it changes)", async () => {
  const looks = [];
  const dom = createDom("/env/a1", `<div data-slot="sidebar-inner"><ul id="list">${ROWS}</ul><div data-slot="sidebar-footer"></div></div>`);
  windows.push(dom.window);
  const storage = createFakeChromeStorage();
  storage.area.data.set(STORAGE_KEYS.profiles, { ...TWO, list: [{ id: "main", name: "Main" }, { id: "work", name: "Work", dither: "#112233" }] });
  const profiles = createProfiles({ win: dom.window, doc: dom.window.document, area: storage.area, changedEvent: storage.onChanged, onLook: (hex) => looks.push(hex) });
  await profiles.start();
  assert.equal(profiles.ditherAccent(), null, "Main: the glow's own color");
  profiles.switchTo("work");
  assert.equal(profiles.ditherAccent(), "#112233");
  profiles.switchTo("main");
  profiles.stop();
  assert.deepEqual(looks, ["#112233", null]);
  assert.equal(profiles.ditherAccent(), null);
});

test("profiles turned off mid-switch leave the chat visible", async () => {
  let on = true;
  const t = setup({ enabled: () => on });
  await t.profiles.start();
  const list = t.doc.querySelector(".messages-timeline-scroll");
  t.dot("work").click();
  on = false;
  t.profiles.sync();
  await frames(t, 3);
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
          { id: "main", name: "Main", color: "#3B82F6", sky: "url(x)", dither: "#123456; background: red", icon: '<img src=x onerror="alert(1)">' },
          { id: "w", name: "<b>Work</b>", color: "pink", sky: "teal", dither: "#a1b2c3", icon: "rocket" },
        ],
        projects: {},
      },
    },
  };
  await importAll(storage.area, backup, { [STORAGE_KEYS.profiles]: normalizeProfiles });
  const saved = storage.area.data.get(STORAGE_KEYS.profiles);
  assert.deepEqual(saved.list[0], { id: "main", name: "Main", color: "#3b82f6", sky: "default", dither: "default" }, "a custom hex kept; css and markup dropped");
  assert.deepEqual(saved.list[1], { id: "w", name: "<b>Work</b>", color: "pink", sky: "teal", dither: "#a1b2c3", icon: "rocket" });
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
  const t = setup();
  // Chrome-style: the change event arrives a moment after the write, not inside it.
  const listeners = new Set();
  const data = t.storage.area.data;
  const area = {
    data,
    get: async (k) => ({ [k]: structuredClone(data.get(k)) }),
    set: async (items) => {
      for (const [k, v] of Object.entries(items)) data.set(k, structuredClone(v));
      const change = Object.fromEntries(Object.entries(items).map(([k, v]) => [k, { newValue: structuredClone(v) }]));
      setTimeout(() => listeners.forEach((fn) => fn(change, "local")), 5);
      await sleep(10); // and the write resolves after its event has arrived
    },
  };
  const profiles = createProfiles({ win: t.win, doc: t.doc, area, changedEvent: { addListener: (fn) => listeners.add(fn), removeListener: (fn) => listeners.delete(fn) } });
  await profiles.start();
  profiles.update("work", { icon: "rocket" });
  await sleep(1);
  profiles.update("work", { icon: "star" });
  await sleep(60);
  assert.equal(profiles.state.list[1].icon, "star", "in memory");
  assert.equal(data.get(STORAGE_KEYS.profiles).list[1].icon, "star", "and stored");
  profiles.stop();
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
  assert.equal(t.doc.documentElement.style.getPropertyValue("--t3plus-sky-turn"), "103.6", "from 304° to orange's 47.6°");
  t.finish();
  t.profiles.stop();
});

test("the editor shows the colors as stored now, after a change from Settings", async () => {
  const t = setup({ stored: { ...TWO, list: [{ id: "main", name: "Main" }, { id: "work", name: "Work", color: "blue" }] } });
  await t.profiles.start();
  t.dot("work").dispatchEvent(new t.win.MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
  const editor = t.doc.querySelector(".t3plus-profile-editor");
  await t.profiles.update("work", { dither: "#12ab34" });
  editor.querySelector('.t3plus-profile-tab[data-field="dither"]').click();
  const picked = editor.querySelector('.t3plus-profile-colors [aria-checked="true"]');
  assert.equal(picked.getAttribute("aria-label"), "Custom", "the custom color, picked");
  assert.equal(picked.style.getPropertyValue("--t3plus-profile-color"), "#12ab34");
  t.profiles.stop();
});

// Storage as Chrome's: events after the write (not inside it), none for a value that did not change.
function chromeLikeArea(data) {
  const listeners = new Set();
  return {
    data,
    listeners,
    get: async (k) => ({ [k]: structuredClone(data.get(k)) }),
    set: async (items) => {
      const changed = {};
      for (const [k, v] of Object.entries(items)) {
        if (JSON.stringify(data.get(k)) === JSON.stringify(v)) continue;
        data.set(k, structuredClone(v));
        changed[k] = { newValue: structuredClone(v) };
      }
      if (Object.keys(changed).length) setTimeout(() => listeners.forEach((fn) => fn(changed, "local")), 3);
    },
    changedEvent: { addListener: (fn) => listeners.add(fn), removeListener: (fn) => listeners.delete(fn) },
  };
}

test("a save that changes nothing leaves no echo behind to swallow another window's same write; saved data matches its echo whatever the key order", async () => {
  const t = setup();
  const area = chromeLikeArea(t.storage.area.data);
  const profiles = createProfiles({ win: t.win, doc: t.doc, area, changedEvent: area.changedEvent });
  await profiles.start();
  await profiles.update("work", { icon: "rocket" });
  await sleep(10);
  await profiles.update("work", { icon: "rocket" }); // the same again: nothing written
  await sleep(10);
  // Another window: switches to Work and back to Main (Main is the value this one holds).
  const other = structuredClone(area.data.get(STORAGE_KEYS.profiles));
  await area.set({ [STORAGE_KEYS.profiles]: { ...other, active: "work" } });
  await sleep(10);
  assert.equal(profiles.state.active, "work");
  await area.set({ [STORAGE_KEYS.profiles]: { ...other, active: "main" } });
  await sleep(10);
  assert.equal(profiles.state.active, "main", "the other window's write is taken, not mistaken for an echo");
  profiles.stop();
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
