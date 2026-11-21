import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import * as os from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

// inject/main-loader.js, evaluated in T3's main process, run here against a stand-in Electron:
// windows (web contents) whose page runs the guard each script starts with, IPC, and a stand-in
// for the feeds module. Never T3 itself.
const LOADER = fileURLToPath(new URL("../../inject/main-loader.js", import.meta.url));
const APP = "t3code://app";
const nodeRequire = createRequire(import.meta.url);
const flush = async () => { for (let i = 0; i < 20; i += 1) await new Promise((r) => setImmediate(r)); };

let cssSeq = 0;
class FakeContents extends EventEmitter {
  constructor(id, url = `${APP}/#/`) {
    super();
    Object.assign(this, { id, url, pageUrl: null, destroyed: false, injected: false, boots: 0, stops: 0, ran: [], pushes: [], removed: [], css: new Map(), menu: null, onReplace: null, onInsert: null });
    this.mainFrame = { processId: 1, routingId: id };
  }
  isDestroyed() { return this.destroyed; }
  getType() { return "window"; }
  getURL() { return this.url; }
  async insertCSS(css) {
    const key = `css-${this.id}-${(cssSeq += 1)}`;
    this.css.set(key, css);
    this.onInsert?.();
    return key;
  }
  async removeInsertedCSS(key) {
    this.removed.push(key);
    this.css.delete(key);
  }
  reload() {}
  /** The page: a script's first line, the loader's guard, runs against the page's own address. */
  async executeJavaScript(code) {
    const cut = code.startsWith("if (location.href") ? code.indexOf("\n") : -1;
    if (cut >= 0) new Function("location", code.slice(0, cut))({ href: this.pageUrl ?? this.url });
    const body = code.slice(cut + 1);
    this.ran.push(body);
    if (body.includes("if (!window.__t3plusInjected) return false;")) {
      this.onReplace?.();
      const was = this.injected;
      if (was) this.stops += 1;
      this.injected = false;
      return was;
    }
    if (body.startsWith("window.__t3plusBoot=")) {
      this.injected = true;
      this.boots += 1;
      return 0;
    }
    if (body.includes("feedsUpdated")) this.pushes.push([...body.matchAll(/"(home|bots|threads)":"/g)].map((m) => m[1]));
    if (body.includes("projectMenu?.()")) return this.menu;
    return 0;
  }
  destroy() {
    this.destroyed = true;
    this.emit("destroyed");
  }
  /** What the page stand-in tells the loader (a console line). */
  say(text) {
    this.emit("console-message", { frame: this.mainFrame, message: text }, 0, text);
  }
  tell(what, data) { this.say(`[t3plus]${JSON.stringify({ what, ...data })}`); }
}

function fakeElectron() {
  const contents = [];
  const app = new EventEmitter();
  app.getVersion = () => "0.0.0-test";
  const handlers = new Map();
  const electron = {
    app,
    webContents: { getAllWebContents: () => contents.filter((w) => !w.destroyed) },
    BrowserWindow: { fromWebContents: () => ({ isVisible: () => true, isMinimized: () => false }) },
    ipcMain: { _invokeHandlers: handlers, handle: (channel, fn) => handlers.set(channel, fn), removeHandler: (channel) => handlers.delete(channel) },
  };
  return {
    electron,
    window(id, url) {
      const wc = new FakeContents(id, url);
      contents.push(wc);
      return wc;
    },
    /** A web contents made while the loader runs (T3's previews, devtools). */
    created(id, url) {
      const wc = this.window(id, url);
      app.emit("web-contents-created", {}, wc);
      return wc;
    },
  };
}

/** A home with t3+'s files (~/.t3plus), and a stand-in for its feeds module that records each call. */
function makeHome(t) {
  const home = mkdtempSync(join(os.tmpdir(), "t3plus-loader-"));
  const root = join(home, ".t3plus");
  const files = { "inject/page-stub.js": "/* stub */", "dist/content.js": "/* t3+ */", "dist/content.css": "/* css */", "dist/sample-spectrum.svg": "<svg/>", "extension/package.json": '{"version":"9.9.9"}' };
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), text);
  }
  const calls = [];
  const feeds = {
    publish: async () => false,
    create: () => ({
      publishBots: async (ids) => { calls.push(["bots", ids]); return feeds.publish("bots"); },
      publishThreads: async () => { calls.push(["threads"]); return feeds.publish("threads"); },
      publishHome: async () => { calls.push(["home"]); return feeds.publish("home"); },
      config: { t3Home: join(home, "no-t3") },
      dispose: () => calls.push(["dispose"]),
    }),
  };
  t.after(() => {
    try { globalThis.__t3plus?.dispose(); } catch {}
    delete globalThis.__t3plus;
    delete globalThis.__t3plusCssKeys;
    rmSync(home, { recursive: true, force: true });
  });
  return { home, root, calls, feeds };
}

/** Evaluates the loader as the inspector does: `require` is there while it is evaluated, gone after. */
function runLoader({ home, feeds }, { electron }) {
  const source = readFileSync(LOADER, "utf8").replace("__APP_ORIGIN__", JSON.stringify(APP));
  const require = (name) => (name === "electron" ? electron : name === "os" ? { ...os, homedir: () => home } : name.endsWith(join("inject", "feeds.js")) ? feeds.create : nodeRequire(name));
  require.resolve = (name) => name;
  require.cache = {};
  globalThis.require = require;
  try {
    return new Function(`return (${source}\n);`)();
  } finally {
    delete globalThis.require;
  }
}

test("loader: injects the app window (only the app's), and re-running it replaces the copy without a reload", async (t) => {
  const env = makeHome(t);
  const T3 = fakeElectron();
  const win = T3.window(1);
  const popup = T3.window(2, "https://accounts.example.com/sign-in");
  assert.equal(await runLoader(env, T3), "1:injected, 2:skip");
  assert.equal(win.boots, 1);
  assert.equal(popup.ran.length, 0, "a sign-in popup gets nothing");
  const first = [...win.css.keys()];
  assert.equal(await runLoader(env, T3), "1:re-injected, 2:skip");
  assert.equal(win.stops, 1, "the running copy was stopped");
  assert.deepEqual(win.removed, first, "and its styles removed, then");
  assert.equal(win.css.size, 1);
});

test("loader: with its files missing, `on` changes nothing: the copy running keeps its styles, feeds and listeners", async (t) => {
  const env = makeHome(t);
  const T3 = fakeElectron();
  const win = T3.window(1);
  await runLoader(env, T3);
  const running = globalThis.__t3plus;
  unlinkSync(join(env.root, "dist/content.js"));
  const result = await runLoader(env, T3);
  assert.match(result, /:error\b/);
  assert.match(result, /files missing/);
  assert.equal(globalThis.__t3plus, running, "the first loader is still the one");
  assert.deepEqual(win.removed, [], "no styles taken away");
  assert.equal(win.listenerCount("console-message"), 1);
  assert.ok(!env.calls.some(([op]) => op === "dispose"), "nor its feeds worker");
  win.tell("ask", { kind: "threads" });
  await flush();
  assert.deepEqual(env.calls, [["threads"]], "it still answers the page");
});

test("loader: the page asking for the Status feed every 2 s gets a fresh copy each time, not every other time", async (t) => {
  const env = makeHome(t);
  const T3 = fakeElectron();
  const win = T3.window(1);
  let now = 1_700_000_000_000;
  t.mock.method(Date, "now", () => now);
  const file = join(env.root, "feeds", "t3plus-threads.json");
  mkdirSync(dirname(file), { recursive: true });
  // Each publish finds a change and writes the file 300 ms after it began.
  env.feeds.publish = async (kind) => {
    writeFileSync(file, JSON.stringify({ at: now }));
    utimesSync(file, (now + 300) / 1000, (now + 300) / 1000);
    return true;
  };
  await runLoader(env, T3);
  for (let i = 0; i < 6; i += 1) {
    now += i % 2 ? 1980 : 2020;
    win.tell("ask", { kind: "threads" });
    await flush();
    now += 10;
    win.tell("ask", { kind: "threads" }); // the page reads the copy just pushed
    await flush();
  }
  assert.equal(env.calls.filter(([op]) => op === "threads").length, 6);
  assert.equal(win.pushes.length, 6);
});

test("loader: re-run many times, and with windows coming and going, it keeps one set of listeners and nothing of a closed window", async (t) => {
  const env = makeHome(t);
  const T3 = fakeElectron();
  const win = T3.window(1);
  const warnings = [];
  const onWarning = (w) => warnings.push(w.name);
  process.on("warning", onWarning);
  t.after(() => process.off("warning", onWarning));
  for (let i = 0; i < 12; i += 1) {
    await runLoader(env, T3);
    win.tell("bots", { keys: [`env:t${i}`] });
  }
  for (const event of ["destroyed", "console-message", "did-finish-load"]) assert.equal(win.listenerCount(event), 1, event);
  const state = globalThis.__t3plus;
  const undo = state.undo.length;
  for (let id = 100; id < 200; id += 1) {
    const extra = T3.created(id);
    extra.emit("did-finish-load");
    await flush();
    extra.destroy();
    assert.equal(extra.listenerCount("destroyed") + extra.listenerCount("console-message") + extra.listenerCount("did-finish-load"), 0);
  }
  assert.equal(state.undo.length, undo);
  assert.deepEqual([...state.injected], [1]);
  assert.deepEqual([...state.cssKeys.keys()], [1]);
  assert.deepEqual([...globalThis.__t3plusCssKeys.keys()], [1]);
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(warnings, []);
  state.dispose();
  assert.equal(win.listenerCount("destroyed") + win.listenerCount("console-message") + win.listenerCount("did-finish-load"), 0, "dispose takes them all off");
});

test("loader: the bot feed follows the page's order for the worker's cap, and republishes only when the threads covered change", async (t) => {
  const env = makeHome(t);
  const T3 = fakeElectron();
  const win = T3.window(1);
  await runLoader(env, T3);
  const keys = Array.from({ length: 80 }, (_, i) => `env:t${i}`);
  win.tell("bots", { keys });
  await flush();
  const bots = () => env.calls.filter(([op]) => op === "bots").map(([, ids]) => ids);
  assert.deepEqual(bots().at(-1), keys.slice(0, 64).map((k) => k.slice(4)), "the first 64, most wanted first");
  // The 70th row's thread opened: it comes first, and is covered now.
  win.tell("bots", { keys: [keys[69], ...keys.filter((k) => k !== keys[69])] });
  await flush();
  assert.equal(bots().length, 2);
  assert.equal(bots().at(-1)[0], "t69");
  // Rows that only move among those covered: no new publish, but the next one has their order.
  const moved = [keys[69], keys[1], keys[0], ...keys.slice(2).filter((k) => k !== keys[69])];
  win.tell("bots", { keys: moved });
  await flush();
  assert.equal(bots().length, 2);
  await globalThis.__t3plus.publish("bots");
  await flush();
  assert.deepEqual(bots().at(-1).slice(0, 3), ["t69", "t1", "t0"]);
});

test("loader: odd notes from the page are ignored, never an error in T3's main process", async (t) => {
  const env = makeHome(t);
  const T3 = fakeElectron();
  const win = T3.window(1);
  await runLoader(env, T3);
  for (const text of ["[t3plus]null", "[t3plus]0", '[t3plus]"ask"', "[t3plus][]", "[t3plus]{", "[t3plus]" + JSON.stringify({ what: "ask", kind: "constructor" }), "[t3plus]" + JSON.stringify({ what: "ask", kind: "__proto__" }), "[t3plus]" + JSON.stringify({ what: "ask", kind: "toString" })]) {
    assert.doesNotThrow(() => win.say(text), text);
  }
  await flush();
  assert.deepEqual(env.calls, [], "nothing published for them");
  const many = Array.from({ length: 100_000 }, (_, i) => `env:t${i}`);
  win.tell("bots", { keys: ["env:" + "x".repeat(400), ...many] });
  await flush();
  const [[op, ids]] = env.calls;
  assert.equal(op, "bots");
  assert.equal(ids.length, 64);
  assert.equal(ids[0], "t0", "a key far too long is no thread's");
});

test("loader: a window that goes to another page while it is injected gets nothing of t3+'s", async (t) => {
  const env = makeHome(t);
  const T3 = fakeElectron();
  const away = T3.window(1);
  away.onReplace = () => { away.url = "https://example.com/"; };
  const late = T3.window(2);
  late.onInsert = () => { late.url = "https://example.com/"; };
  assert.equal(await runLoader(env, T3), "1:skip, 2:skip");
  assert.equal(away.boots + late.boots, 0, "no boot data, no bundle");
  assert.equal(away.css.size + late.css.size, 0, "and no styles left behind");
  // The main process still sees the app's address while the page has already gone: the page's own guard stops it.
  const win = T3.created(3);
  win.emit("did-finish-load");
  await flush();
  assert.equal(win.boots, 1);
  const file = join(env.root, "feeds", "t3plus-threads.json");
  mkdirSync(dirname(file), { recursive: true });
  env.feeds.publish = async () => { writeFileSync(file, '{"secret":"titles"}'); return true; };
  win.pageUrl = "https://example.com/";
  win.tell("ask", { kind: "threads" });
  await flush();
  assert.equal(env.calls.length, 1);
  assert.deepEqual(win.pushes, [], "the feed was not handed to that page");
});

test("loader: a newer `on` arriving while a window is being injected leaves that window to the newer loader", async (t) => {
  const env = makeHome(t);
  const T3 = fakeElectron();
  const win = T3.window(1);
  let second = null;
  win.onReplace = () => {
    win.onReplace = null;
    second = runLoader(env, T3); // disposes the first loader mid-injection
  };
  assert.equal(await runLoader(env, T3), "1:skip");
  assert.equal(await second, "1:injected");
  assert.equal(win.boots, 1, "one copy in the page");
  assert.equal(win.css.size, 1, "with one stylesheet, the newer loader's");
  assert.equal(globalThis.__t3plusCssKeys.get(1), [...win.css.keys()][0]);
});

test("loader: a load while the window is still being injected waits for it, then replaces that copy: one copy, one stylesheet", async (t) => {
  const env = makeHome(t);
  const T3 = fakeElectron();
  const win = T3.window(1);
  win.onInsert = () => {
    win.onInsert = null;
    win.emit("did-finish-load"); // the page reloaded mid-injection
  };
  assert.equal(await runLoader(env, T3), "1:injected");
  await flush();
  assert.equal(win.boots, 2, "injected again after the load");
  assert.equal(win.stops, 1, "the first copy was found and stopped first");
  assert.equal(win.css.size, 1, "one stylesheet left");
  assert.deepEqual([...win.css.keys()], [globalThis.__t3plus.cssKeys.get(1)]);
});

test("loader: `off` removes t3+'s styles and listeners and reloads the window", async (t) => {
  const env = makeHome(t);
  const T3 = fakeElectron();
  const win = T3.window(1);
  let reloads = 0;
  win.reload = () => { reloads += 1; };
  await runLoader(env, T3);
  assert.equal(globalThis.__t3plus.dispose(true), "disposed");
  assert.equal(win.css.size, 0);
  assert.equal(reloads, 1);
  assert.equal(globalThis.__t3plus, undefined);
  assert.equal(win.listenerCount("console-message"), 0);
  assert.equal(globalThis.__t3plusCssKeys.size, 0);
});
