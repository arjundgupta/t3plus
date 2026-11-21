import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import { test } from "node:test";
import { botStill } from "../src/botArt.js";
import { createBotFeed } from "../src/botFeed.js";
import { resolveBotPresentation, shownBotPrefs, subagentFace } from "../src/bots.js";
import { DEFAULT_BOT_MARKER, STORAGE_KEYS } from "../src/config.js";
import { WRITE_STAMP, withoutWriteStamp } from "../src/storageKeys.js";
import { createSettingsStore, normalizeSettings } from "../src/settings.js";
import { createScopesStore, normalizeScopes } from "../src/settingsScopes.js";
import { STATUS_BOT_COLORS, createViewStore, normalizeViewState } from "../src/statusView.js";
import { createApp, createDom, createFakeChromeStorage, createFakeRemote, settle, T3_COMPOSER_HTML, threadRowHtml } from "./helpers.js";

// Several T3 windows show t3+'s settings, their scopes and the sidebar's view, and each
// writes them whole: a change one makes reaches the others, whatever this one is doing.

/** A store whose first save waits until release() (a write still on its way to storage). */
function heldFirstSave(store) {
  let release;
  const held = new Promise((resolve) => (release = resolve));
  let first = true;
  return {
    release: () => release(),
    store: {
      ...store,
      async save(...args) {
        if (first) {
          first = false;
          await held;
        }
        return store.save(...args);
      },
    },
  };
}

const settled = async () => {
  for (let i = 0; i < 5; i += 1) await settle();
};

test("settings stored before writes were stamped load as they were, and gain a stamp with their next write; the stamp is never a setting", async () => {
  const storage = createFakeChromeStorage();
  const key = STORAGE_KEYS.settings;
  storage.area.data.set(key, normalizeSettings({ glass: { enabled: false } }));
  const { app } = createApp(createDom("/env1/a1", T3_COMPOSER_HTML), storage);
  await app.start();
  assert.equal(app.state.settings.glass.enabled, false);
  assert.equal(WRITE_STAMP in storage.area.data.get(key), false, "reading writes nothing");
  await app.actions.setIntensity(70);
  const stored = storage.area.data.get(key);
  assert.equal(typeof stored[WRITE_STAMP].id, "string");
  assert.deepEqual(stored[WRITE_STAMP].own, [["composerGradient", "intensity"]], "the leaf this window set");
  assert.deepEqual(normalizeSettings(stored), withoutWriteStamp(stored), "the settings without it");
  assert.equal(WRITE_STAMP in app.state.base, false);
  const stamp = { [WRITE_STAMP]: { id: "w:1", own: [] } };
  assert.equal(WRITE_STAMP in normalizeScopes({ version: 1, overrides: {}, ...stamp }), false);
  assert.equal(WRITE_STAMP in normalizeViewState({ view: "status", ...stamp }), false);
});

test("a change another window writes while this one is still reading its settings is the one shown", async () => {
  const storage = createFakeChromeStorage();
  const dom = createDom("/env1/a1", T3_COMPOSER_HTML);
  const { app } = createApp(dom, storage);
  const get = storage.area.get;
  let elsewhere = true;
  storage.area.get = async (key) => {
    const read = await get(key);
    if (elsewhere && [].concat(key).includes(STORAGE_KEYS.settings)) {
      elsewhere = false;
      // Another window turns the glow off just after this read.
      const stored = storage.area.data.get(STORAGE_KEYS.settings);
      await storage.area.set({ [STORAGE_KEYS.settings]: normalizeSettings({ ...stored, composerGradient: { enabled: false } }) });
    }
    return read;
  };
  await app.start();
  assert.equal(app.state.settings.composerGradient.enabled, false);
  assert.equal(dom.window.document.documentElement.hasAttribute("data-t3plus-mode"), false, "no glow drawn");
});

test("a setting another window saves while this one is saving another is kept: in both windows and in storage", async () => {
  const storage = createFakeChromeStorage();
  const held = heldFirstSave(createSettingsStore(storage.area, storage.onChanged));
  const a = createApp(createDom("/env1/a1", T3_COMPOSER_HTML), storage, { settingsStore: held.store }).app;
  const b = createApp(createDom("/env1/a1", T3_COMPOSER_HTML), storage).app;
  await a.start();
  await b.start();
  const saving = a.actions.setIntensity(70); // on its way to storage
  await b.actions.setGlass(false);
  held.release();
  await saving;
  await settled();
  const stored = storage.area.data.get(STORAGE_KEYS.settings);
  assert.deepEqual([stored.composerGradient.intensity, stored.glass.enabled], [70, false], "storage has both");
  for (const app of [a, b]) assert.deepEqual([app.state.settings.composerGradient.intensity, app.state.settings.glass.enabled], [70, false], "and each window shows both");
});

test("this window's own save coming back undoes nothing changed since; another window's change keeps a slider being moved here", async () => {
  // Chrome reports a change after its write has resolved.
  const storage = createFakeChromeStorage({ eventDelayMs: 5 });
  const a = createApp(createDom("/env1/a1", T3_COMPOSER_HTML), storage).app;
  const b = createApp(createDom("/env1/a1", T3_COMPOSER_HTML), storage).app;
  await a.start();
  await b.start();
  const later = () => new Promise((resolve) => setTimeout(resolve, 20));
  await a.actions.setIntensity(60);
  await later();
  await a.actions.setIntensity(70); // written; reported back in 5 ms
  a.actions.previewIntensity(60); // the slider moves back meanwhile
  await later();
  assert.equal(a.state.settings.composerGradient.intensity, 60, "its own save's echo is no news");
  await b.actions.setGlass(false);
  await later();
  assert.deepEqual([a.state.settings.composerGradient.intensity, a.state.settings.glass.enabled], [60, false], "the other window's glass taken, the slider kept");
  await a.actions.setIntensity(60); // let go
  await later();
  const stored = storage.area.data.get(STORAGE_KEYS.settings);
  assert.deepEqual([stored.composerGradient.intensity, stored.glass.enabled], [60, false]);
  assert.deepEqual([b.state.settings.composerGradient.intensity, b.state.settings.glass.enabled], [60, false]);
});

test("profiles' own settings: one window's change to one profile and another's to another both stay", async () => {
  const storage = createFakeChromeStorage();
  const held = heldFirstSave(createScopesStore(storage.area, storage.onChanged));
  const a = createApp(createDom("/env1/a1", T3_COMPOSER_HTML), storage, { scopesStore: held.store }).app;
  const b = createApp(createDom("/env1/a1", T3_COMPOSER_HTML), storage, { scopesStore: createScopesStore(storage.area, storage.onChanged) }).app;
  await a.start();
  await b.start();
  a.setScopedValue("work", "composerGradient.accent", "#ff3366"); // on its way to storage
  await settle();
  b.setScopedValue("home", "chat.bubble", "#22c55e");
  await settle();
  held.release();
  await settled();
  const both = { "work|*": { "composerGradient.accent": "#ff3366" }, "home|*": { "chat.bubble": "#22c55e" } };
  assert.deepEqual(storage.area.data.get(STORAGE_KEYS.scopes).overrides, both, "storage has both");
  for (const app of [a, b]) assert.deepEqual(app.state.scopes.overrides, both, "and each window");
  // One cleared in one window goes everywhere; the other stays.
  b.setScopedValue("work", "composerGradient.accent", null);
  await settled();
  for (const app of [a, b]) assert.deepEqual(app.state.scopes.overrides, { "home|*": { "chat.bubble": "#22c55e" } });
});

test("the sidebar's view: a group another window folds while this one's switch is on its way stays folded", async () => {
  const storage = createFakeChromeStorage();
  const sidebar = `<div data-slot="sidebar-inner"><div data-slot="sidebar-content"><ul id="t3-list">
    <li data-testid="sidebar-project-folder"><button type="button" data-sidebar-row="folder:p/a"><span class="truncate">A</span></button></li></ul></div>
    <div data-slot="sidebar-footer"></div></div>`;
  const held = heldFirstSave(createViewStore(storage.area, storage.onChanged));
  const dom = createDom("/env1/a1", sidebar);
  const { app } = createApp(dom, storage, { viewStore: held.store });
  await app.start();
  app.watcher.flush();
  dom.window.document.querySelector(".t3plus-status-toggle").click(); // to the Status view
  await settle(); // its write on its way
  // Another window folds Done (it writes its whole view: still Projects there).
  await createViewStore(storage.area, storage.onChanged).save({ view: "projects", collapsed: { done: true } });
  held.release();
  await settled();
  const expected = { view: "status", collapsed: { needs: false, working: false, done: true, idle: true } };
  assert.deepEqual(withoutWriteStamp(storage.area.data.get(STORAGE_KEYS.sidebarView)), expected);
  assert.deepEqual(app.state.view, expected);
});

// ---------- On the desktop ----------
// T3's desktop windows share one localStorage, each with the desktop stub
// (inject/page-stub.js) over it: a window's own write is reported in it at once, inside
// the write; another window's reaches it later, as a "storage" event. Here those wait in
// each window's inbox until the test hands them over (deliver), in the order it likes.
// Where the windows run decides what a window reads meanwhile, so both are tried:
// - "one copy": they share one copy of localStorage, and read another window's write at
//   once (its report still to come);
// - "a copy each": each has its own copy (a process each), which takes another window's
//   write when its report comes, unless it wrote the key since (as Chromium's does).

const STUB = readFileSync(new URL("../../inject/page-stub.js", import.meta.url), "utf8");
const PREFIX = "t3plus-ext:";
const SIDEBAR = `<div data-slot="sidebar-inner"><div data-slot="sidebar-content"><ul id="t3-list">
    <li data-testid="sidebar-project-folder"><button type="button" data-sidebar-row="folder:p/a"><span class="truncate">A</span></button></li></ul></div>
    <div data-slot="sidebar-footer"></div></div>`;
const COPIES = ["one copy", "a copy each"];

/** `body`: the page each window shows (its sidebar); `extra()`: more app deps, made for each window. */
function desktop(copies, { body = SIDEBAR, extra = () => ({}) } = {}) {
  const items = new Map(); // what storage holds
  const windows = [];
  let writes = 0; // every write, in order
  return {
    /** What storage holds for `key` (its write's stamp left out). */
    stored: (key) => withoutWriteStamp(JSON.parse(items.get(PREFIX + key) ?? "null")),
    /** One more T3 window, t3+ started in it on the desktop stub. */
    async open() {
      const dom = createDom("/env1/a1", T3_COMPOSER_HTML + body);
      const win = dom.window;
      const copy = copies === "one copy" ? items : new Map(items);
      const ownWrite = new Map(); // key -> the number of this window's last write of it
      const inbox = []; // other windows' writes not reported here yet
      const wrote = [];
      /** Writes `value` (null: removes it), reported to the other windows later. */
      const write = (key, value) => {
        const old = items.get(key) ?? null; // what the other windows' reports say it was
        for (const map of new Set([items, copy])) {
          if (value === null) map.delete(key);
          else map.set(key, value);
        }
        writes += 1;
        ownWrite.set(key, writes);
        wrote.push(key.slice(PREFIX.length));
        for (const other of windows) if (other.win !== win) other.inbox.push({ key, oldValue: old, newValue: value, at: writes });
      };
      // What the stub uses of a Storage.
      const localStorage = {
        getItem: (key) => copy.get(key) ?? null,
        setItem: (key, value) => write(key, String(value)),
        removeItem: (key) => copy.has(key) && write(key, null),
      };
      new Function("window", "localStorage", "console", STUB)(win, localStorage, { debug() {}, warn: console.warn });
      const { local, onChanged } = win.chrome.storage;
      const page = {
        win,
        inbox,
        /** How many times this window wrote `key`. */
        wrote: (key) => wrote.filter((k) => k === key).length,
        /** Hands this window the other windows' writes so far, as storage events, and lets what they start run. */
        async deliver() {
          for (const { key, oldValue, newValue, at } of inbox.splice(0)) {
            if (copy !== items && (ownWrite.get(key) ?? 0) < at) {
              if (newValue === null) copy.delete(key);
              else copy.set(key, newValue);
            }
            const event = new win.Event("storage");
            Object.defineProperties(event, { key: { value: key }, oldValue: { value: oldValue }, newValue: { value: newValue }, storageArea: { value: localStorage } });
            win.dispatchEvent(event);
          }
          await settled();
        },
      };
      windows.push(page); // listening from before it reads, as t3+ does
      page.app = createApp(dom, { area: local, onChanged }, { scopesStore: createScopesStore(local, onChanged), viewStore: createViewStore(local, onChanged), ...extra() }).app;
      await page.app.start();
      page.app.watcher.flush();
      return page;
    },
  };
}

/** Two windows, started and in step. */
async function twoWindows(copies, options) {
  const d = desktop(copies, options);
  const a = await d.open();
  const b = await d.open();
  await deliverAll(a, b);
  return { d, a, b };
}

/** Hands each window what the others wrote until none has anything left (windows writing back and forth for ever fail). */
async function deliverAll(...pages) {
  for (let round = 0; pages.some((p) => p.inbox.length); round += 1) {
    assert.ok(round < 20, "the windows keep answering each other's writes");
    for (const page of pages) await page.deliver();
  }
}

const shown = (app) => [app.state.settings.composerGradient.intensity, app.state.settings.glass.enabled];
const storedShown = (d) => {
  const stored = d.stored(STORAGE_KEYS.settings);
  return [stored.composerGradient.intensity, stored.glass.enabled];
};

for (const copies of COPIES) {
  test(`desktop, ${copies}: another window's change still on its way when this one writes is kept, in both windows and in storage, whichever hears first`, async () => {
    for (const first of ["a", "b"]) {
      const { d, a, b } = await twoWindows(copies);
      await b.app.actions.setGlass(false); // reported in b at once; a hears of it later
      await a.app.actions.setIntensity(70); // made without it
      await settled();
      await (first === "a" ? a : b).deliver();
      await deliverAll(a, b);
      assert.deepEqual(storedShown(d), [70, false], `storage has both (${first} hears first)`);
      assert.deepEqual(shown(a.app), [70, false], "and the window that wrote last shows both");
      assert.deepEqual(shown(b.app), [70, false], "and so does the other");
    }
  });

  test(`desktop, ${copies}: the window whose write undid another's writes once more, with it, and then no window writes again`, async () => {
    const { a, b } = await twoWindows(copies);
    const key = STORAGE_KEYS.settings;
    const before = [a.wrote(key), b.wrote(key)];
    await b.app.actions.setGlass(false);
    await a.app.actions.setIntensity(70);
    await settled();
    await deliverAll(a, b);
    assert.deepEqual([a.wrote(key) - before[0], b.wrote(key) - before[1]], [2, 1], "its own change, then once more with b's; b only its own");
    assert.equal(a.inbox.length + b.inbox.length, 0, "nothing more on its way: no window answers the other's write");
  });

  test(`desktop, ${copies}: the same setting changed in two windows at once is the last write's everywhere, and nothing is written back`, async () => {
    const { d, a, b } = await twoWindows(copies);
    const key = STORAGE_KEYS.settings;
    const before = [a.wrote(key), b.wrote(key)];
    await b.app.actions.setIntensity(40);
    await a.app.actions.setIntensity(70); // the last write
    await settled();
    await deliverAll(a, b);
    assert.equal(d.stored(key).composerGradient.intensity, 70);
    assert.deepEqual([a.app.state.settings.composerGradient.intensity, b.app.state.settings.composerGradient.intensity], [70, 70]);
    assert.deepEqual([a.wrote(key) - before[0], b.wrote(key) - before[1]], [1, 1]);
  });

  test(`desktop, ${copies}: writes in both windows, each made before hearing the other's, all stay`, async () => {
    const { d, a, b } = await twoWindows(copies);
    const pair = (settings) => [settings.composerGradient.intensity, settings.glass.strength];
    await b.app.actions.setGlassStrength(30);
    await a.app.actions.setIntensity(70);
    await b.app.actions.setIntensity(30); // b again, still not having heard a
    await a.app.actions.setGlassStrength(60); // and a, still not having heard b
    await settled();
    await a.deliver();
    await b.app.actions.setIntensity(20); // b once more, before hearing anything
    await settled();
    await deliverAll(a, b);
    assert.deepEqual(pair(d.stored(STORAGE_KEYS.settings)), [20, 60], "each setting as its last write has it");
    assert.deepEqual(pair(a.app.state.settings), [20, 60]);
    assert.deepEqual(pair(b.app.state.settings), [20, 60]);
  });

  test(`desktop, ${copies}: each window writing again before hearing the other, every change stays`, async () => {
    // Each write lands on the other window's last, not heard yet. A change taken in from
    // the other window was once counted as this window's own: it undid that window's later
    // ones. (No value comes back: storage values are told apart by what they hold.)
    const steps = { a: (app, v) => app.actions.setIntensity(v), b: (app, v) => app.actions.setGlassStrength(v) };
    const pair = (settings) => [settings.composerGradient.intensity, settings.glass.strength];
    for (const writes of [[["a", 26], ["b", 30], ["a", 74]], [["a", 26], ["b", 30], ["b", 60]], [["a", 26], ["b", 30], ["a", 74], ["b", 60]], [["b", 30], ["a", 26], ["b", 60], ["a", 74]]]) {
      const { d, a, b } = await twoWindows(copies);
      for (const [name, value] of writes) await steps[name]((name === "a" ? a : b).app, value);
      await settled();
      await deliverAll(a, b);
      const want = ["a", "b"].map((name) => writes.findLast(([n]) => n === name)[1]);
      const label = writes.map(([n, v]) => `${n}:${v}`).join(" ");
      assert.deepEqual(pair(d.stored(STORAGE_KEYS.settings)), want, `storage (${label})`);
      for (const page of [a, b]) assert.deepEqual(pair(page.app.state.settings), want, `each window (${label})`);
    }
  });

  test(`desktop, ${copies}: another window's changes reach this one in order, each taken in`, async () => {
    const { d, a, b } = await twoWindows(copies);
    await b.app.actions.setIntensity(40);
    await b.app.actions.setGlass(false);
    await b.app.actions.setIntensity(50);
    await a.deliver();
    assert.deepEqual(shown(a.app), [50, false]);
    assert.deepEqual(storedShown(d), [50, false]);
    assert.equal(b.inbox.length, 0, "a wrote nothing");
  });

  test(`desktop, ${copies}: profiles' own settings and the sidebar's view are kept the same way`, async () => {
    const { d, a, b } = await twoWindows(copies);
    b.app.setScopedValue("home", "chat.bubble", "#22c55e");
    await settled();
    a.app.setScopedValue("work", "composerGradient.accent", "#ff3366"); // made without b's
    await settled();
    await deliverAll(a, b);
    const both = { "work|*": { "composerGradient.accent": "#ff3366" }, "home|*": { "chat.bubble": "#22c55e" } };
    assert.deepEqual(d.stored(STORAGE_KEYS.scopes).overrides, both, "storage has both");
    for (const page of [a, b]) assert.deepEqual(page.app.state.scopes.overrides, both, "and each window");

    // b folds Done (writing its whole view: still Projects); a switches to the Status view, made without it.
    await createViewStore(b.win.chrome.storage.local, b.win.chrome.storage.onChanged).save({ view: "projects", collapsed: { done: true } });
    a.win.document.querySelector(".t3plus-status-toggle").click();
    await settled();
    await deliverAll(a, b);
    const expected = { view: "status", collapsed: { needs: false, working: false, done: true, idle: true } };
    assert.deepEqual(d.stored(STORAGE_KEYS.sidebarView), expected);
    for (const page of [a, b]) assert.deepEqual(page.app.state.view, expected);
  });
}


// ---------- Values that come back ----------
// Two writes can hold the same: a setting switched off and back on, or set back to what
// storage held. Each write's stamp tells them apart, and names the leaves its window set
// itself: a value a write holds only as its window had it is no change of that window's.

/** Each window and storage show `expected` (intensity, glass on). */
function allShow(d, pages, expected, label) {
  assert.deepEqual(storedShown(d), expected, `storage (${label})`);
  for (const page of pages) assert.deepEqual(shown(page.app), expected, `each window (${label})`);
}

for (const copies of COPIES) {
  test(`desktop, ${copies}: a setting switched off and back on while another window changes another: both stay`, async () => {
    const { d, a, b } = await twoWindows(copies);
    await a.app.actions.setIntensity(10);
    await b.deliver();
    await b.app.actions.setGlass(false);
    await a.app.actions.setIntensity(30); // made without b's change
    await b.app.actions.setGlass(true); // back on, made without a's: on as a's last write has it
    await settled();
    await deliverAll(a, b);
    allShow(d, [a, b], [30, true], "b's on, a's 30");
  });

  test(`desktop, ${copies}: a setting set back to a value it held, before another window's change is heard: both stay`, async () => {
    const { d, a, b } = await twoWindows(copies);
    for (const value of [20, 10, 20]) await a.app.actions.setIntensity(value);
    await b.deliver();
    await a.app.actions.setIntensity(10);
    await b.app.actions.setGlass(false); // made without a's 10: 20, as a's write before it
    await a.app.actions.setIntensity(20); // made without b's change
    await settled();
    await deliverAll(a, b);
    allShow(d, [a, b], [20, false], "a's 20 again, b's off");
  });

  test(`desktop, ${copies}: a setting switched back to what storage holds only as another window's write left it is written, and stays`, async () => {
    const { d, a, b } = await twoWindows(copies);
    await a.app.actions.setIntensity(40);
    await b.deliver();
    await b.app.actions.setGlass(false);
    await a.app.actions.setIntensity(10); // made without b's off: storage has glass on
    await b.deliver();
    assert.deepEqual(shown(b.app), [10, false], "b keeps its off (a writes it back)");
    await b.app.actions.setGlass(true); // on again: storage holds that, but only until a writes b's off back
    await settled();
    await deliverAll(a, b);
    allShow(d, [a, b], [10, true], "b's on");
  });

  test(`desktop, ${copies}: a setting a window holds only as it was before another window changed it undoes nothing`, async () => {
    const { d, a, b } = await twoWindows(copies);
    await b.app.actions.setGlass(false);
    await a.app.actions.setIntensity(70); // made without b's off: glass on, as it was
    await b.app.actions.setIntensity(30); // made without a's 70: glass off, b's own
    await a.app.actions.setGlass(true); // a shows it on already: no change, nothing written
    await settled();
    await a.deliver();
    await b.app.actions.setIntensity(20);
    await settled();
    await deliverAll(a, b);
    allShow(d, [a, b], [20, false], "b's off, as no window turned it on");
  });

  test(`desktop, ${copies}: one setting switched back and forth in both windows, each before hearing the other: the last write's everywhere`, async () => {
    const { d, a, b } = await twoWindows(copies);
    await b.app.actions.setGlass(false);
    await a.app.actions.setIntensity(40);
    await b.app.actions.setIntensity(20); // the last intensity, made without a's 40
    await b.app.actions.setGlass(true);
    await b.deliver();
    await a.app.actions.setGlass(false); // made without b's writes
    await b.app.actions.setGlass(false);
    await b.deliver();
    await a.app.actions.setGlass(true);
    await b.app.actions.setGlass(true); // the last glass write
    await settled();
    await deliverAll(a, b);
    allShow(d, [a, b], [20, true], "b's 20 and on");
  });
}


// ---------- What is drawn follows ----------
// Every setting change is drawn at once in every window: in the one that made it, and in
// each one that hears of it, without anything else on the page changing.

const BOT_KEY = "env1:a2";
const BOT_SIDEBAR = `<div data-slot="sidebar-inner"><div data-slot="sidebar-content"><ul id="t3-list">
    <li data-testid="sidebar-project-folder"><button type="button" data-sidebar-row="folder:p/a"><span class="truncate">A</span></button></li>
    ${threadRowHtml({ key: BOT_KEY, title: `${DEFAULT_BOT_MARKER} Metrics bot`, parent: "folder:p/a", status: "Working" })}</ul></div>
    <div data-slot="sidebar-footer"></div></div>`;
const BOT_FEED = JSON.stringify({ version: 1, bots: { a2: { text: "Looking around.", role: "assistant", subagents: [{ title: "Search", status: "running" }] } } });
/** Each window checks on its animation frames, as in T3 (no flush here), and reads its bot feed (one subagent). */
const drawnWindows = (copies) =>
  twoWindows(copies, { body: BOT_SIDEBAR, extra: () => ({ frameChecks: true, botFeed: createBotFeed({ area: null, fetchRemote: createFakeRemote({ ok: true, status: 200, text: BOT_FEED }) }) }) });
/** A few of jsdom's animation frames: the checks a change asked for have run. */
const frames = () => new Promise((resolve) => setTimeout(resolve, 50));
/** `page`'s faces once its next checks have run (on its own frames, however busy the machine), or as they are after a second. */
async function facesSoon(page, want) {
  for (let i = 0; i < 20 && !isDeepStrictEqual(botFaces(page), want); i += 1) await frames();
  return botFaces(page);
}

/** The bot's faces in `page` as drawn: the Status view's, its row's in T3's list, its subagent's. */
function botFaces(page) {
  const doc = page.win.document;
  const face = (el) => (el ? [el.style.getPropertyValue("--t3plus-bot-fill"), el.style.getPropertyValue("--t3plus-bot-badge")] : null);
  return {
    view: face(doc.querySelector(`.t3plus-status-view [data-thread="${BOT_KEY}"] .t3plus-status-face`)),
    row: face(doc.querySelector(`[data-sidebar-row="${BOT_KEY}"] .t3plus-bot-avatar`)),
    sub: doc.querySelector(`[data-sidebar-row="${BOT_KEY}"] .t3plus-bot-sub`)?.style.getPropertyValue("--t3plus-bot-fill") ?? null,
  };
}
/** What they should be under the settings `sidebar`: Status colors in the Status view only. */
function expectedFaces(sidebar) {
  const bot = { key: BOT_KEY, titleLabel: "Metrics bot", status: "working", statusLabel: "Working", projectColor: null };
  const face = (view) => [view.fill, view.badge?.url ?? ""];
  const own = resolveBotPresentation(bot, shownBotPrefs(undefined, { badges: sidebar.statusBadges }));
  const inView = resolveBotPresentation(bot, shownBotPrefs(undefined, { statusColor: sidebar.statusColors ? STATUS_BOT_COLORS.working : null, badges: sidebar.statusBadges }));
  const sub = subagentFace(own, { shape: sidebar.subagentShape, color: sidebar.subagentColor });
  return { view: face(inView), row: face(own), sub: botStill(sub.color, sub.shape, "awake").url };
}

for (const copies of COPIES) {
  test(`desktop, ${copies}: each change to how bots look is drawn at once in both windows, whichever made it, and is written once`, async () => {
    const { a, b } = await drawnWindows(copies);
    a.win.document.querySelector(".t3plus-status-toggle").click(); // the Status view, Status colors off
    await settled();
    await deliverAll(a, b);
    await frames();
    const key = STORAGE_KEYS.settings;
    const steps = [
      ["a", "statusColors", true],
      ["a", "statusColors", false],
      ["a", "statusColors", true],
      ["b", "statusColors", false],
      ["b", "statusColors", true],
      ["b", "statusBadges", true],
      ["a", "botStyle", "blobs"],
      ["b", "subagentShape", "robot"],
      ["a", "subagentColor", "purple"],
      ["a", "statusColors", false],
      ["b", "botStyle", "classic"],
      ["a", "statusBadges", false],
      ["b", "subagentShape", "same"],
      ["a", "subagentColor", "same"],
    ];
    const pages = { a, b };
    let writes = a.wrote(key) + b.wrote(key);
    for (const [name, setting, value] of steps) {
      const label = `${name} sets ${setting} to ${value}`;
      await pages[name].app.actions.setSidebarFeature(setting, value);
      await settled();
      await deliverAll(a, b); // and nothing is written back
      writes += 1;
      assert.equal(a.wrote(key) + b.wrote(key), writes, `${label}: written once`);
      for (const [n, page] of Object.entries(pages)) {
        const { sidebar } = page.app.state.settings;
        assert.equal(sidebar[setting], value, `${label}: ${n} has it`);
        const want = expectedFaces(sidebar);
        assert.deepEqual(await facesSoon(page, want), want, `${label}: ${n} draws it`);
      }
    }
    // Status colors on, the view switched back and forth: T3's list keeps the bot's own
    // colors, and the Status view wears the status's again, in both windows.
    await a.app.actions.setSidebarFeature("statusColors", true);
    for (const [name, view] of [["b", "projects"], ["a", "status"], ["a", "projects"], ["b", "status"]]) {
      pages[name].win.document.querySelector(".t3plus-status-toggle").click();
      await settled();
      await deliverAll(a, b);
      for (const [n, page] of Object.entries(pages)) {
        assert.equal(page.app.state.view.view, view, `${name} switches to ${view}: ${n} too`);
        const all = expectedFaces(page.app.state.settings.sidebar);
        const want = { ...all, view: view === "status" ? all.view : null };
        assert.deepEqual(await facesSoon(page, want), want, `${name} switches to ${view}: ${n} draws it`);
      }
    }
  });
}
