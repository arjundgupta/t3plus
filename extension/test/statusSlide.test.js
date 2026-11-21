import assert from "node:assert/strict";
import { test } from "node:test";
import { assignBotShapes, defaultBotShape, setBotStyle } from "../src/botArt.js";
import { BOT_STYLES, STORAGE_KEYS, T3PLUS } from "../src/config.js";
import { createProfiles } from "../src/profiles.js";
import { createScopesStore } from "../src/settingsScopes.js";
import { createViewStore, parseThreadsFeedText } from "../src/statusView.js";
import { createApp, createDom, createFakeChromeStorage, T3_APPEARANCE_HTML, threadRowHtml, virtualClock } from "./helpers.js";

// A profile switch while the sidebar's Status view shows: the view slides as T3's list
// does (profileSlide.test.js), by a dot, the keys or a swipe. The view on screen goes out
// as it is, a copy of the next profile's view (its threads, its own settings) comes in, and
// once in place the view itself shows that profile, just as its copy did. jsdom has no
// animations: the same stand-in as profileSlide.test.js records them.

const M = "[[t3plus:bot:v1]]";
const folder = (key) => `<li data-testid="sidebar-project-folder"><button type="button" data-sidebar-row="folder:${key}" aria-expanded="true"><span class="truncate">${key}</span></button></li>`;
const thread = (key, title, project, status = null, current = false) => threadRowHtml({ key, title, parent: `folder:${project}`, status, current });
// Main: a question and a finished thread; Work: one at work and one waiting on an approval.
const ROWS =
  folder("p/a") + thread("env:a1", "Fix login", "p/a", "Input", true) + thread("env:a2", "Old idea", "p/a") +
  folder("p/b") + thread("env:b1", "Ship it", "p/b", "Working") + thread("env:b2", "Deploy", "p/b", "Approval");
const TWO = { active: "main", list: [{ id: "main", name: "Main" }, { id: "work", name: "Work" }], projects: { "p/a": "main", "p/b": "work" }, adopted: true };
const ROWS4 = ["a", "b", "c", "d"].map((x) => folder(`p/${x}`) + thread(`env:${x}1`, `Thread ${x.toUpperCase()}`, `p/${x}`, "Working", x === "a")).join("");
const FOUR = {
  active: "main",
  list: [{ id: "main", name: "Main" }, { id: "work", name: "Work" }, { id: "c", name: "C" }, { id: "d", name: "D" }],
  projects: { "p/a": "main", "p/b": "work", "p/c": "c", "p/d": "d" },
  adopted: true,
};
const BOX = { left: 8, top: 0, width: 200, height: 600, right: 208, bottom: 600 };
// What a copy leaves out (profiles.js COPY_DROP): the rest of it must match the view.
const FINDABLE = ["id", "tabindex", "aria-controls", "data-thread"];

// `path` and `page`: a page other than a thread (t3+'s Settings). `feed`: the thread feed (a collapsed folder's threads).
async function setup({ rows = ROWS, stored = TWO, settings = {}, scopes = null, trackpad = null, path = "/env/a1", page = "", feed = null } = {}) {
  const dom = createDom(
    path,
    `${page}<div data-slot="sidebar-inner"><div data-slot="scroll-area-viewport"><div id="group"><ul id="list">${rows}</ul></div></div><div data-slot="sidebar-footer"></div></div><div data-workspace-area="conversation"><div data-chat-canvas><div class="messages-timeline-scroll"><div data-timeline-row-id="a1-m1">a1</div></div><div class="composer"></div></div></div>`,
  );
  const win = dom.window;
  const doc = win.document;
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
  win.matchMedia = () => ({ matches: false });
  // T3's list and the Status view in its place are a sidebar's width (jsdom lays nothing out).
  const rect = win.Element.prototype.getBoundingClientRect;
  win.Element.prototype.getBoundingClientRect = function () {
    return this.matches("#list, .t3plus-status-view") ? BOX : rect.call(this);
  };
  // T3's navigation: a click on a thread's row opens it.
  doc.addEventListener("click", (e) => {
    const row = e.target.closest?.("[data-thread-item] [data-sidebar-row]");
    if (!row) return;
    const [env, id] = row.getAttribute("data-sidebar-row").split(":");
    win.history.pushState({}, "", `/${env}/${id}`);
  });
  const storage = createFakeChromeStorage();
  storage.area.data.set(STORAGE_KEYS.profiles, stored);
  storage.area.data.set(STORAGE_KEYS.sidebarView, { view: "status" });
  storage.area.data.set(STORAGE_KEYS.settings, { sidebar: { bots: true, botsDefault: false, ...settings } });
  if (scopes) storage.area.data.set(STORAGE_KEYS.scopes, { version: 1, overrides: scopes });
  let appRef = null;
  const profiles = createProfiles({ win, doc, area: storage.area, changedEvent: storage.onChanged, onShown: (id) => appRef?.profileShown(id), trackpad });
  const { app } = createApp(dom, storage, {
    profiles,
    viewStore: createViewStore(storage.area, storage.onChanged),
    scopesStore: createScopesStore(storage.area, storage.onChanged),
    ...(feed ? { threadsFeed: { load: async () => parseThreadsFeedText(JSON.stringify(feed)) } } : {}),
  });
  appRef = app;
  await app.start();
  await clock.advance(0); // the profiles load
  app.watcher.flush();
  const live = () => anims.filter((a) => !a.cancelled);
  /** The real view (the copy is one too). */
  const view = () => doc.querySelector(".t3plus-status-view:not([data-t3plus-profile-next])");
  const copy = () => doc.querySelector("[data-t3plus-profile-next]");
  return {
    win, doc, app, profiles, anims, clock, view, copy,
    list: doc.getElementById("list"),
    route: () => win.location.pathname,
    dot: (id) => doc.querySelector(`.t3plus-profile-dot[data-profile="${id}"]`),
    /** The compositor has the slide: the thread may be asked for now. */
    async started() {
      for (const a of live()) a.start();
      await clock.advance(0);
      await clock.frames(1);
      await clock.advance(0);
    },
    /** The view's slide out ends (the copy's own runs beside it). */
    finish: () => live().find((a) => a.el === view())?.finish(),
    wheel: (deltaX) => view().dispatchEvent(new win.WheelEvent("wheel", { deltaX, bubbles: true, cancelable: true })),
  };
}

/** A view's groups and their rows' titles, as drawn. */
const shown = (view) => [...view.querySelectorAll(".t3plus-status-group")].map((g) => [g.dataset.group, ...[...g.querySelectorAll(".t3plus-status-title")].map((t) => t.textContent)]);
/** A view's markup without what only the real one has (ids, Tab stops, thread keys): the copy's should be the same. */
function looks(view) {
  const clone = view.cloneNode(true);
  for (const el of clone.querySelectorAll("*")) for (const name of FINDABLE) el.removeAttribute(name);
  return clone.innerHTML;
}

test("a dot click in the Status view slides it: Work's view comes in beside Main's, and once in place the view itself shows Work, just as its copy did", async () => {
  const t = await setup();
  const view = t.view();
  assert.deepEqual(shown(view), [["needs", "Fix login"], ["idle"]], "Main's threads (Idle folded)");
  t.dot("work").click();
  const copy = t.copy();
  assert.ok(copy?.classList.contains("t3plus-status-view"), "a Status view slides in");
  assert.deepEqual(shown(copy), [["needs", "Deploy"], ["working", "Ship it"]], "Work's threads, in its groups");
  const [out, inn] = t.anims.filter((a) => a.el === view || a.el === copy);
  assert.equal(out.el, view);
  assert.deepEqual(out.keyframes.map((k) => k.transform), ["translate3d(0px, 0px, 0)", "translate3d(-212px, 0px, 0)"], "out to the left, as T3's list goes");
  assert.deepEqual(inn.keyframes.map((k) => k.transform), ["translate3d(212px, 0px, 0)", "translate3d(0px, 0px, 0)"], "in from the right");
  assert.deepEqual([out.options.duration, out.options.easing], [240, "cubic-bezier(0.25, 1, 0.5, 1)"], "the same timing and easing");
  assert.equal(t.anims.filter((a) => a.el === t.list).length, 0, "T3's hidden list stays put");
  assert.equal(t.dot("work").getAttribute("aria-pressed"), "true", "its dot is the open one already");
  assert.equal(t.doc.querySelector(".t3plus-profiles-name").textContent, "Work", "and its name shows");
  t.app.watcher.flush(); // a check mid-slide (Work's settings are drawn now)
  assert.deepEqual(shown(view), [["needs", "Fix login"], ["idle"]], "the view going out stays as it is");
  assert.equal(t.route(), "/env/a1", "T3 is not asked for the thread before the slide has started");
  await t.started();
  assert.equal(t.route(), "/env/b1", "then Work's thread opens, while the views move");
  const canvas = t.doc.querySelector(".messages-timeline-scroll");
  assert.deepEqual(t.anims.find((a) => a.el === canvas)?.keyframes.map((k) => k.opacity), [1, 0], "and the chat fades out with the slide");
  t.finish();
  assert.equal(t.copy(), null, "the copy is gone");
  assert.equal(t.view(), view, "the view itself, not its copy, is on screen");
  assert.equal(t.profiles.state.active, "work");
  assert.deepEqual(shown(view), [["needs", "Deploy"], ["working", "Ship it"]], "showing Work's groups");
  assert.equal(looks(view), looks(copy), "exactly as its copy did: no jump as it takes over");
  assert.equal(view.style.transform, "");
  assert.equal(t.doc.querySelector("[data-t3plus-profile-sliding]"), null);
  t.profiles.stop();
});

test("the copy of the Status view is inert, hidden from assistive tech, found by no lookup, and follows what T3 changes while it slides", async () => {
  const t = await setup();
  t.dot("work").click();
  const copy = t.copy();
  assert.equal(copy.getAttribute("aria-hidden"), "true");
  assert.ok(copy.hasAttribute("inert"));
  assert.equal(copy.querySelectorAll(FINDABLE.map((name) => `[${name}]`).join(", ")).length, 0, "no id, Tab stop, list reference or thread key in it");
  const rows = [...t.doc.querySelectorAll("[data-thread]")];
  assert.ok(rows.length && rows.every((b) => t.view().contains(b)), "a thread's row is the real view's only");
  await t.started();
  // T3 draws Work's thread: its row in T3's (hidden) list is the open one now.
  t.list.querySelector('[data-sidebar-row="env:a1"]').removeAttribute("aria-current");
  t.list.querySelector('[data-sidebar-row="env:b1"]').setAttribute("aria-current", "page");
  t.app.watcher.flush();
  assert.equal(t.copy().querySelector('[aria-current="page"] .t3plus-status-title')?.textContent, "Ship it", "the copy shows it open");
  assert.equal(t.copy().querySelectorAll(FINDABLE.map((name) => `[${name}]`).join(", ")).length, 0, "drawn again, still found by nothing");
  t.finish();
  assert.equal(t.doc.querySelectorAll("[data-t3plus-profile-next]").length, 0, "none left after landing");
  assert.equal(t.view().querySelector('[aria-current="page"] .t3plus-status-title').textContent, "Ship it");
  t.profiles.stop();
});

test("a swipe over the Status view follows the fingers and springs back when short; past the last profile it only gives", async () => {
  const t = await setup();
  const view = t.view();
  for (let i = 0; i < 5; i += 1) {
    t.wheel(6);
    await t.clock.advance(16); // 30 px at a finger's pace (not a flick)
  }
  assert.equal(view.style.transform, "translate3d(-30px, 0px, 0)", "the view follows the fingers");
  assert.equal(t.copy().style.transform, "translate3d(182px, 0px, 0)", "and Work's comes in beside it");
  assert.deepEqual(shown(t.copy()), [["needs", "Deploy"], ["working", "Ship it"]]);
  await t.clock.advance(170); // the fingers stop
  const back = t.anims.find((a) => a.el === view && !a.cancelled);
  assert.deepEqual(back.keyframes.map((k) => k.transform), ["translate3d(-30px, 0px, 0)", "translate3d(0px, 0px, 0)"], "springs back");
  t.finish();
  assert.equal(t.profiles.state.active, "main");
  assert.equal(t.copy(), null);
  assert.equal(view.style.transform, "");
  assert.deepEqual(shown(view), [["needs", "Fix login"], ["idle"]], "Main's, as it was");

  await t.clock.advance(300);
  for (let i = 0; i < 20; i += 1) t.wheel(-8); // toward a profile before Main: none
  assert.equal(t.copy(), null, "nothing to bring in");
  const x = Number(/translate3d\((-?[\d.]+)px/.exec(view.style.transform)[1]);
  assert.ok(x > 0 && x < 80, `gives a little (${x}px for 160px of fingers)`);
  await t.clock.advance(300);
  t.finish();
  assert.equal(view.style.transform, "");
  assert.equal(t.profiles.state.active, "main");
  t.profiles.stop();
});

test("swipes over the Status view one after another each switch, no click between them, each landing on that profile's view", async () => {
  let touch = null;
  const t = await setup({ rows: ROWS4, stored: FOUR, trackpad: { onBegin: (fn) => ((touch = fn), () => {}) } });
  const view = t.view();
  const swipe = async (dx) => {
    touch(); // fingers on the pad: T3 reports the touch
    for (let i = 0; i < 40; i += 1) t.wheel(dx);
    await t.started();
    t.finish();
    for (const dxm of [7, 5, 3, 2]) t.wheel(dxm * Math.sign(dx)); // its momentum
  };
  await swipe(8);
  assert.equal(t.profiles.state.active, "work");
  assert.deepEqual(shown(view), [["working", "Thread B"]]);
  await swipe(8);
  assert.equal(t.profiles.state.active, "c", "straight after the first");
  assert.deepEqual(shown(view), [["working", "Thread C"]]);
  await swipe(-8);
  assert.equal(t.profiles.state.active, "work", "and back the other way");
  assert.deepEqual(shown(view), [["working", "Thread B"]]);
  assert.equal(t.doc.querySelectorAll("[data-t3plus-profile-next]").length, 0);
  assert.equal(view.style.transform, "");
  t.profiles.stop();
});

test("the copy wears the next profile's own Status badges and bot style, and the view keeps them once it takes over", async () => {
  const rows =
    folder("p/a") + thread("env:a1", `${M} Keeper`, "p/a", "Working", true) +
    folder("p/b") + thread("env:b1", `${M} Builder`, "p/b", "Working");
  const t = await setup({ rows, scopes: { "work|*": { "sidebar.statusBadges": true, "sidebar.botStyle": "space" } } });
  const face = (view, title) => [...view.querySelectorAll(".t3plus-status-row")].find((b) => b.querySelector(".t3plus-status-title").textContent === title)?.querySelector(".t3plus-status-face");
  const space = BOT_STYLES.space.shapes;
  const keeper = face(t.view(), "Keeper");
  assert.equal(keeper.hasAttribute("data-badge"), false, "Main: no Status badges");
  assert.equal(space.includes(keeper.getAttribute("data-t3plus-shape")), false, "Main: the classic bots");
  t.dot("work").click();
  const builder = face(t.copy(), "Builder");
  assert.ok(builder.hasAttribute("data-badge"), "Work's copy: with its Status badges");
  assert.ok(space.includes(builder.getAttribute("data-t3plus-shape")), "and its Space bots");
  t.app.watcher.flush();
  assert.equal(face(t.view(), "Keeper"), keeper);
  assert.equal(keeper.hasAttribute("data-badge"), false, "the view going out keeps Main's look");
  await t.started();
  t.finish();
  const landed = face(t.view(), "Builder");
  assert.ok(landed.hasAttribute("data-badge"), "the view in Work's settings");
  assert.equal(landed.getAttribute("data-t3plus-shape"), builder.getAttribute("data-t3plus-shape"), "the same face as in its copy");
  t.profiles.stop();
});

test("Ctrl+Shift+digit slides the Status view too; with no Status view T3's list slides as before", async () => {
  const t = await setup();
  t.doc.body.dispatchEvent(new t.win.KeyboardEvent("keydown", { code: "Digit2", key: "2", ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true }));
  assert.ok(t.copy()?.classList.contains("t3plus-status-view"));
  await t.started();
  t.finish();
  assert.equal(t.profiles.state.active, "work");
  // Back to T3's list: the list slides, its copy a copy of T3's list.
  t.doc.querySelector(".t3plus-status-toggle").click();
  t.app.watcher.flush();
  assert.equal(t.view(), null);
  t.dot("main").click();
  assert.equal(t.copy()?.tagName, "UL", "a copy of T3's list");
  assert.ok(t.anims.some((a) => a.el === t.list && !a.cancelled), "and T3's list slides");
  t.anims.find((a) => a.el === t.list && !a.cancelled).finish();
  assert.equal(t.profiles.state.active, "main");
  t.profiles.stop();
});

test("a switch over the Status view measures it once and reads no style of it or of its copy (each read after a write is a forced layout)", async () => {
  const t = await setup();
  const view = t.view();
  const measured = [];
  const rect = t.win.Element.prototype.getBoundingClientRect;
  t.win.Element.prototype.getBoundingClientRect = function () {
    measured.push(this);
    return rect.call(this);
  };
  const styled = [];
  const computed = t.win.getComputedStyle;
  t.win.getComputedStyle = (el, ...rest) => (styled.push(el), computed(el, ...rest));
  t.dot("work").click();
  assert.equal(measured.filter((el) => el === view).length, 1, "measured once, before anything moved");
  assert.equal(styled.filter((el) => el.closest?.(".t3plus-status-view")).length, 0, "no style read of either view");
  await t.started();
  t.finish();
  assert.equal(measured.filter((el) => el === view).length, 1, "nor measured again to land");
  t.profiles.stop();
});

test("the view turned off or on mid-slide: the slide lands at once, no copy left sliding over the other surface", async () => {
  const t = await setup();
  const toggle = () => t.doc.querySelector(".t3plus-status-toggle").click();
  // Off while a dot's switch slides: it lands on Work, T3's list shows with nothing over it.
  t.dot("work").click();
  toggle();
  assert.equal(t.copy(), null, "no Status view copy over T3's list");
  assert.equal(t.doc.querySelector("[data-t3plus-profile-sliding]"), null);
  assert.equal(t.profiles.state.active, "work", "the switch made");
  assert.equal(t.list.hasAttribute("data-t3plus-status-hidden"), false, "T3's list shows");
  // On while T3's list slides: it lands, and the view shows Main's threads alone.
  t.dot("main").click();
  assert.ok(t.anims.some((a) => a.el === t.list && !a.cancelled), "T3's list slides");
  toggle();
  assert.equal(t.copy(), null, "no copy of T3's list over the view");
  assert.equal(t.list.style.transform, "");
  assert.equal(t.profiles.state.active, "main");
  assert.deepEqual(shown(t.view()), [["needs", "Fix login"], ["idle"]]);
  // Off under the fingers: the swipe goes back, the view as it was when shown again.
  for (let i = 0; i < 5; i += 1) {
    t.wheel(6);
    await t.clock.advance(16);
  }
  const view = t.view();
  assert.ok(t.copy());
  toggle();
  assert.equal(t.copy(), null);
  assert.equal(view.style.transform, "", "not left moved");
  assert.equal(t.profiles.state.active, "main", "not switched");
  toggle();
  t.app.watcher.flush();
  assert.equal(t.view(), view);
  assert.deepEqual(shown(view), [["needs", "Fix login"], ["idle"]], "drawn again (held no more)");
  t.profiles.stop();
});

test("on t3+'s Settings page the copy is drawn in the settings the view lands in: the scope edited there", async () => {
  const NAV = `<div role="tree"><ul data-slot="sidebar-menu"><li><button type="button" data-settings-section="/settings/appearance" data-active="true" role="treeitem"><span>Appearance</span></button></li></ul></div>`;
  const rows =
    folder("p/a") + thread("env:a1", `${M} Keeper`, "p/a", "Working") +
    folder("p/b") + thread("env:b1", `${M} Builder`, "p/b", "Working");
  const t = await setup({ rows, path: "/settings/appearance", page: NAV + T3_APPEARANCE_HTML, scopes: { "work|*": { "sidebar.statusBadges": true } } });
  t.doc.querySelector("[data-t3plus-settings-nav]").click();
  t.app.watcher.flush();
  assert.ok(t.doc.documentElement.hasAttribute(T3PLUS.settingsAttr), "Settings → t3+ open, editing All profiles");
  t.dot("work").click();
  const face = (view) => view.querySelector(".t3plus-status-face");
  assert.equal(face(t.copy()).hasAttribute("data-badge"), false, "the copy: All profiles' look, not Work's own badges");
  const copy = t.copy();
  await t.started();
  t.finish();
  assert.equal(t.profiles.state.active, "work");
  assert.equal(face(t.view()).hasAttribute("data-badge"), false, "the view landed: the same");
  assert.equal(looks(t.view()), looks(copy), "no jump as it takes over");
  t.profiles.stop();
});

test("a peek at another profile over the Status view changes no face on screen, though one of its bots comes back to a shape another has now", async () => {
  // Work's folder is collapsed: its bot is in the feed only. It had a shape once, which a
  // bot of Main's (dealt while it was away) has now.
  setBotStyle("classic");
  const keys = Array.from({ length: 200 }, (_, i) => i);
  const pair = keys.map((i) => [`env:w${i}`, keys.map((j) => `env:x${j}`).find((x) => defaultBotShape(x) === defaultBotShape(`env:w${i}`))]).find(([, x]) => x);
  assert.ok(pair, "two keys of the same hashed shape (the one coming back sorts first)");
  const [away, here] = pair;
  assignBotShapes([away]);
  assignBotShapes([]); // it went (its profile left)
  const rows =
    folder("p/a") + thread(here, `${M} Here`, "p/a", "Working", true) +
    `<li data-testid="sidebar-project-folder"><button type="button" data-sidebar-row="folder:p/b" aria-expanded="false"><span class="truncate">p/b</span></button></li>`;
  const feed = {
    version: 1,
    environmentId: "env",
    projects: { pb: { title: "B", keys: ["p/b"] } },
    threads: [{ id: away.slice(4), project: "pb", title: `${M} Away`, status: "working", at: new Date().toISOString() }],
  };
  const t = await setup({ rows, path: `/${here.replace(":", "/")}`, feed });
  await t.clock.advance(0); // the feed
  t.app.watcher.flush();
  const rowFace = () => t.list.querySelector(`[data-sidebar-row="${here}"] .t3plus-bot-avatar`).getAttribute("data-t3plus-shape");
  const shape = rowFace();
  assert.equal(shape, defaultBotShape(away), "Main's bot has the shape the other had");
  for (let i = 0; i < 5; i += 1) {
    t.wheel(6);
    await t.clock.advance(16);
  }
  const awayRow = [...t.copy().querySelectorAll(".t3plus-status-row")].find((b) => b.querySelector(".t3plus-status-title").textContent === "Away");
  assert.ok(awayRow, "Work's copy shows its bot from the feed");
  assert.notEqual(awayRow.querySelector(".t3plus-status-face").getAttribute("data-t3plus-shape"), shape, "in another shape: Main's bot keeps its own");
  t.app.watcher.flush();
  assert.equal(rowFace(), shape, "mid-peek, Main's bot's face as it was");
  await t.clock.advance(170); // the fingers stop: it springs back
  t.finish();
  t.app.watcher.flush();
  assert.equal(t.profiles.state.active, "main");
  assert.equal(rowFace(), shape, "and after it");
  t.profiles.stop();
});
