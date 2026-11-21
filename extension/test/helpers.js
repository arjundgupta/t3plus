import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, beforeEach, mock } from "node:test";
import { STORAGE_KEYS } from "../src/config.js";
import { JSDOM } from "jsdom";
import { createT3Plus } from "../src/app.js";
import { createBotStore } from "../src/bots.js";
import { createImageStore } from "../src/imageStore.js";
import { createSettingsStore } from "../src/settings.js";
import { stopSprites } from "../src/spriteClock.js";

// Whatever a test opens is closed when that test ends (opened outside a test: when its
// file ends), also after an assertion failed before the test's own clean-up. A jsdom
// window's timers (the sprite clock, feed polls, health rechecks) would otherwise keep
// the process, and with it `npm test`, build.sh and CI, waiting forever.
const liveApps = new WeakMap(); // a window closeWhenDone closes -> its apps no clean-up has stopped yet

/** Closes `win` when the current test ends, stopping the apps made on it first. createDom does this for its windows. */
export function closeWhenDone(win) {
  const apps = new Set();
  liveApps.set(win, apps);
  after(() => {
    for (const app of apps) app.stop(); // t3+ stops while its page is still there
    apps.clear();
    // The sprite clock waits on one window's timer: closed under it, it would never wake again.
    stopSprites();
    win.close();
  });
  return win;
}

/** JSON with every object's keys in order: Chrome compares stored values whatever their key order. */
const canonical = (value) =>
  JSON.stringify(value, (_, v) => (v && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) : v));

/**
 * In-memory stand-in for chrome.storage.local + chrome.storage.onChanged, with Chrome's
 * contract: values are JSON-cloned; only keys whose value changed are reported, and a
 * write that changes nothing reports nothing; every listener hears a change (several T3
 * tabs sharing one extension), and one that throws fails neither the others nor the
 * write. Changes are reported inside the write, as the desktop stub (inject/page-stub.js)
 * does. `eventDelayMs` delivers them that much later instead, as Chrome's messages do,
 * and `writeDelayMs` resolves each write that much later (after its event, if longer).
 */
export function createFakeChromeStorage({ eventDelayMs = 0, writeDelayMs = 0 } = {}) {
  const data = new Map();
  const listeners = new Set();
  const clone = (value) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));
  const deliver = (changes) => {
    for (const listener of [...listeners]) {
      try {
        listener(changes, "local");
      } catch (error) {
        queueMicrotask(() => {
          throw error; // reported, as Chrome reports it in the listener's page
        });
      }
    }
  };
  const emit = (changes) => {
    if (!Object.keys(changes).length) return;
    if (eventDelayMs > 0) setTimeout(deliver, eventDelayMs, changes);
    else deliver(changes);
  };
  const written = () => (writeDelayMs > 0 ? new Promise((resolve) => setTimeout(resolve, writeDelayMs)) : undefined);
  const area = {
    data,
    // Like chrome.storage: one key or a list of keys.
    async get(key) {
      const out = {};
      for (const k of [].concat(key)) if (data.has(k)) out[k] = clone(data.get(k));
      return out;
    },
    async set(items) {
      const changes = {};
      for (const [key, value] of Object.entries(items)) {
        if (value === undefined || (data.has(key) && canonical(data.get(key)) === canonical(value))) continue;
        changes[key] = { oldValue: clone(data.get(key)), newValue: clone(value) };
        data.set(key, clone(value));
      }
      emit(changes);
      await written();
    },
    async remove(key) {
      const changes = {};
      for (const k of [].concat(key)) {
        if (!data.has(k)) continue;
        changes[k] = { oldValue: clone(data.get(k)), newValue: undefined };
        data.delete(k);
      }
      emit(changes);
      await written();
    },
  };
  const onChanged = {
    addListener: (fn) => listeners.add(fn),
    removeListener: (fn) => listeners.delete(fn),
    listenerCount: () => listeners.size,
  };
  return { area, onChanged };
}

const FRAME_MS = 16; // a 60 Hz display's frame, rounded as tests count it
const STEP_MS = 4; // the virtual clock's steps: FRAME_MS is a whole number of them

/**
 * Paints `win`'s animation frames on the virtual clock: one every FRAME_MS of its time,
 * stamped with its performance.now(). jsdom's own frames are stamped with real time,
 * and wait on an interval that is real if the first frame was asked for before the
 * clock started.
 */
function virtualFrames(win) {
  const callbacks = new Map(); // id -> callback, for the next frame
  let lastId = 0;
  let painting = null; // the timer of the next frame, while one is asked for
  const paint = () => {
    painting = null;
    const due = [...callbacks.values()];
    callbacks.clear(); // one asked for during this frame is for the next, as in a browser
    const stamp = win.performance.now();
    for (const callback of due) callback(stamp);
  };
  win.requestAnimationFrame = (callback) => {
    callbacks.set((lastId += 1), callback);
    painting ??= setTimeout(paint, FRAME_MS - (win.performance.now() % FRAME_MS));
    return lastId;
  };
  win.cancelAnimationFrame = (id) => callbacks.delete(id);
}

let clock = null; // the current test's, while one is on it
function stopClock() {
  mock.timers.reset();
  clock = null;
}
// An after() hook that throws skips the test's later ones, the clock's among them (a
// window's clean-up failing, say): the next test would have started on the old clock,
// its Date frozen. Each starts on real time.
beforeEach(() => clock && stopClock());

/**
 * Puts the current test on a virtual clock: Node's timers (under jsdom's timers) and
 * Date, and the given windows' performance.now() and animation frames, move only when
 * advance() moves them, so a test waits out T3's or t3+'s delays at once, and the same
 * way on a slow machine. A second call in the same test adds its windows to the same
 * clock. Real time is back when the test ends.
 */
export function virtualClock(...windows) {
  if (!clock) {
    // Date starts at the real time, so stored timestamps still look like today's.
    const origin = Date.now();
    mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"], now: origin });
    after(stopClock);
    const now = () => Date.now() - origin;
    /**
     * Moves time on by `ms` (0: runs what is due), a few ms at a time, so each timer sees
     * about its own time and the promises it starts settle before the next. (A timer sees
     * its step's end: steps end on whole STEP_MS, so frames see exactly theirs.)
     */
    async function advance(ms) {
      const end = now() + ms;
      do {
        mock.timers.tick(Math.min(STEP_MS - (now() % STEP_MS), end - now()));
        await new Promise((resolve) => setImmediate(resolve));
      } while (now() < end);
    }
    clock = {
      now,
      advance,
      attach(win) {
        win.performance.now = now;
        virtualFrames(win);
      },
      /** Moves time on by `n` animation frames. */
      frames: (n = 1) => advance(n * FRAME_MS),
      /**
       * Moves time on by `ms` with nothing run: the main thread held (T3 drawing a thread).
       * What came due meanwhile runs on the next advance(), late, as after a long task.
       */
      stall(ms) {
        mock.timers.setTime(Date.now() + ms);
      },
    };
  }
  windows.forEach(clock.attach);
  return clock;
}

let rules = null;
/** content.css's rules as { sel, body }, without comments (rules inside @media and the like included). */
export function cssRules() {
  if (!rules) {
    const css = readFileSync(new URL("../src/styles/content.css", import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(([, sel, body]) => ({ sel: sel.trim(), body }));
  }
  return rules;
}
/** The rules whose selector list mentions `needle`. */
export const blocksFor = (needle) => cssRules().filter(({ sel }) => sel.includes(needle));
/** The body of the first rule whose selector list is exactly `selector`. */
export function ruleBody(selector) {
  const rule = cssRules().find(({ sel }) => sel === selector);
  assert.ok(rule, `no rule for ${selector}`);
  return rule.body;
}

/** Minimal copy of the T3 DOM t3+ depends on (see src/config.js for sources). */
export const T3_APPEARANCE_HTML = `
  <div data-settings-page-scroll>
    <div id="page-container">
      <section id="appearance"><h2>Colors &amp; themes</h2></section>
      <section id="appearance-interface"><h2>Interface</h2></section>
    </div>
  </div>`;

export const T3_COMPOSER_HTML = `
  <div data-chat-composer-overlay="true">
    <div class="composer-main">
      <div data-chat-composer-surface="true" class="rounded-[20px]">
        <div data-chat-composer-body="true">
          <div data-testid="composer-editor" contenteditable="true"><p>hello</p></div>
        </div>
        <div data-chat-composer-footer="true"><button type="button">Send</button></div>
      </div>
    </div>
  </div>`;

/** A jsdom window at app.t3.codes`path`, closed when the current test ends (closeWhenDone). */
export function createDom(path, bodyHtml) {
  const dom = new JSDOM(`<!doctype html><html><head></head><body>${bodyHtml}</body></html>`, {
    url: `https://app.t3.codes${path}`,
    pretendToBeVisual: true,
  });
  let counter = 0;
  dom.window.URL.createObjectURL = () => `blob:https://app.t3.codes/fake-${(counter += 1)}`;
  dom.window.URL.revokeObjectURL = () => {};
  closeWhenDone(dom.window);
  return dom;
}

/** Lets MutationObserver callbacks and pending promise chains run. */
export const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

/**
 * A fetchRemote stand-in. `fetchRemote.response` is what the background worker
 * would send: { ok, status, text } or { ok: false, status, error }. A plain
 * config object is served as JSON. Records the URLs asked for.
 */
export function createFakeRemote(response = { ok: false, status: 404 }) {
  const calls = [];
  const fetchRemote = async (url) => {
    calls.push(url);
    const current = fetchRemote.response;
    if (current && !("ok" in current)) return { ok: true, status: 200, text: JSON.stringify(current) };
    return current;
  };
  fetchRemote.response = response;
  fetchRemote.calls = calls;
  return fetchRemote;
}

export function createApp(dom, storage = createFakeChromeStorage(), extra = {}) {
  // Most tests were written for "only marked or Option-clicked threads are bots";
  // the shipped default (every thread a bot) is tested on its own.
  // (Seeded in the fake's own map: another area, the desktop stub's, is left as it is.)
  const saved = storage.area.data?.get(STORAGE_KEYS.settings) ?? {};
  if (storage.area.data && saved.sidebar?.botsDefault === undefined) {
    storage.area.data.set(STORAGE_KEYS.settings, { ...saved, sidebar: { ...saved.sidebar, botsDefault: false } });
  }
  const app = createT3Plus({
    win: dom.window,
    doc: dom.window.document,
    settingsStore: createSettingsStore(storage.area, storage.onChanged),
    imageStore: createImageStore(storage.area, storage.onChanged),
    botStore: createBotStore(storage.area, storage.onChanged),
    assetUrl: (path) => `chrome-extension://t3plus-test/${path}`,
    throttleMs: 10_000, // tests drive checks with watcher.flush()
    frameChecks: false,
    ...extra,
  });
  // Stopped when its test ends, also after a failed assertion. On a window closeWhenDone
  // closes at the same time, that clean-up stops it first (and delete() says so).
  const apps = liveApps.get(dom.window);
  apps?.add(app);
  after(() => {
    if (!apps || apps.delete(app)) app.stop();
  });
  return { app, storage };
}

const attr = (v) => String(v).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");

/** One T3 thread row, shaped like SidebarThreadRow.tsx (folder/slim variant). */
export function threadRowHtml({ key, title, parent, status = null, project = null, current = false }) {
  const label = [title, status, project].filter(Boolean).join(", ");
  return `
      <li data-thread-item="${attr(key)}" class="list-none">
        <div role="button" tabindex="0" data-sidebar-row="${attr(key)}"${parent ? ` data-sidebar-parent="${attr(parent)}"` : ""}
             aria-label="${attr(label)}"${current ? ' aria-current="page"' : ""} data-testid="sidebar-row-folder">
          <div class="contents">
            <span class="sr-only">${attr(title)}</span>
            <span aria-hidden="true" dir="auto" class="truncate">${attr(title)}</span>
            <span class="flex shrink-0"><span role="status" class="sr-only">${attr(status ?? "")}</span></span>
          </div>
        </div>
      </li>`;
}

export const BOT_TITLE = "[[t3plus:bot:v1]] Orchestrator";

/**
 * A T3 sidebar (ui/sidebar.tsx + Sidebar.tsx): fixed header, then a scroll
 * area holding the row list. `folders: true` renders the project-grouped
 * ("Boring") layout with folder:<logicalProjectKey> headers; false is flat.
 */
export function sidebarHtml({ folders = true, currentKey = null } = {}) {
  const rows = [];
  const cur = (key) => key === currentKey;
  rows.push(threadRowHtml({ key: "env1:bot1", title: BOT_TITLE, status: "Working", project: "Ops", current: cur("env1:bot1") }));
  if (folders) {
    rows.push(`<li data-testid="sidebar-project-folder"><button type="button" data-sidebar-row="folder:github.com/acme/api">API</button></li>`);
    rows.push(threadRowHtml({ key: "env1:a1", title: "Fix login", parent: "folder:github.com/acme/api", status: "Done", current: cur("env1:a1") }));
    rows.push(threadRowHtml({ key: "env1:a2", title: "Add metrics", parent: "folder:github.com/acme/api", current: cur("env1:a2") }));
    rows.push(`<li data-testid="sidebar-project-folder"><button type="button" data-sidebar-row="folder:github.com/acme/web">Web</button></li>`);
    rows.push(threadRowHtml({ key: "env1:w1", title: "Landing page", parent: "folder:github.com/acme/web", current: cur("env1:w1") }));
    rows.push(`<li data-testid="sidebar-project-folder"><button type="button" data-sidebar-row="folder:/home/me/notes">notes</button></li>`);
    rows.push(threadRowHtml({ key: "env2:n1", title: "Weekly notes", parent: "folder:/home/me/notes", current: cur("env2:n1") }));
  } else {
    rows.push(threadRowHtml({ key: "env1:a1", title: "Fix login", status: "Done", project: "API", current: cur("env1:a1") }));
    rows.push(threadRowHtml({ key: "env1:w1", title: "Landing page", project: "Web", current: cur("env1:w1") }));
    rows.push(`<li><div data-sidebar-row="shelf:settled">Settled</div></li>`);
    rows.push(threadRowHtml({ key: "env2:n1", title: "Weekly notes", parent: "shelf:settled", project: "notes", current: cur("env2:n1") }));
  }
  return `
  <div data-slot="sidebar-container">
    <div data-sidebar="sidebar" data-slot="sidebar-inner">
      <div class="w-full shrink-0"><div data-slot="sidebar-group"><input type="search" aria-label="Search threads"></div></div>
      <div data-slot="scroll-area">
        <div data-slot="scroll-area-viewport">
          <div data-sidebar="content" data-slot="sidebar-content">
            <div data-slot="sidebar-group"><ul role="presentation" id="thread-list">${rows.join("")}
            </ul></div>
          </div>
        </div>
      </div>
    </div>
  </div>`;
}

/** A tiny valid WebP-labelled data URL record, as prepareImageFile would return. */
export function fakeImageRecord(name = "photo.png") {
  return {
    dataUrl: `data:image/webp;base64,${Buffer.from("fake-webp-bytes").toString("base64")}`,
    name,
    width: 1600,
    height: 900,
    savedAt: 1,
  };
}
