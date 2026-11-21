import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import { STORAGE_KEYS } from "../src/config.js";
import { createImageStore } from "../src/imageStore.js";
import { createSettingsStore } from "../src/settings.js";
import { fakeImageRecord } from "./helpers.js";

// The desktop build's stand-in for chrome.storage (inject/page-stub.js), in T3's own localStorage.
function loadStub() {
  const dom = new JSDOM("<!doctype html><body></body>", { url: "https://app.t3.codes/", runScripts: "outside-only" });
  dom.window.eval(readFileSync(new URL("../../inject/page-stub.js", import.meta.url), "utf8"));
  return dom.window;
}

test("desktop storage stub: like chrome.storage, only changed keys are reported, and a write that does not fit is undone", async () => {
  const win = loadStub();
  const local = win.chrome.storage.local;
  const events = [];
  win.chrome.storage.onChanged.addListener((changes) => events.push(changes));
  await local.set({ a: 1, b: { x: 1 } });
  await local.set({ a: 1 });
  await local.set({ a: 2, b: { x: 1 } });
  await local.remove("missing");
  assert.deepEqual(events.map((c) => Object.keys(c)), [["a", "b"], ["a"]]);
  assert.equal(JSON.stringify(events[1].a), '{"oldValue":1,"newValue":2}'); // objects of the page's realm

  const setItem = win.Storage.prototype.setItem;
  win.Storage.prototype.setItem = function (key, value) {
    if (key.endsWith(":big")) throw new win.DOMException("full", "QuotaExceededError");
    return setItem.call(this, key, value);
  };
  await assert.rejects(local.set({ b: { x: 2 }, big: "x" }), /Not enough room/);
  assert.equal(JSON.stringify((await local.get("b")).b), '{"x":1}', "the part that fitted was undone");
  assert.equal(events.length, 2, "and nothing was reported");
});

/** Counts JSON.parse calls in the page (the stub's own parsing). */
function countParses(win) {
  const parse = win.JSON.parse;
  const counter = { n: 0 };
  win.JSON.parse = function (...args) {
    counter.n += 1;
    return parse.apply(this, args);
  };
  return counter;
}

test("desktop storage stub: a change's values are parsed only when a listener reads them, once", async () => {
  const win = loadStub();
  const local = win.chrome.storage.local;
  const seen = [];
  win.chrome.storage.onChanged.addListener((changes) => {
    if (changes.settings) seen.push([changes.settings.newValue, changes.settings.newValue]);
  });
  const parses = countParses(win);
  await local.set({ "t3plus.botFeed.cache.v1": { text: "x".repeat(10_000) } });
  await local.set({ "t3plus.botFeed.cache.v1": { text: "y".repeat(10_000) } });
  assert.equal(parses.n, 0, "a feed cache nobody listens to is not parsed back (old or new)");
  await local.set({ settings: { glow: true } });
  assert.equal(parses.n, 1, "the one value read, once, though read twice");
  assert.equal(seen[0][0], seen[0][1], "the same object both times");
  assert.equal(JSON.stringify(seen[0][0]), '{"glow":true}');
});

test("desktop storage stub: what a key held before a change is parsed only for the stores that compare it (the settings), not for the image", async () => {
  const win = loadStub();
  const { local, onChanged } = win.chrome.storage;
  const images = [];
  const settings = [];
  createImageStore(local, onChanged).subscribe((record) => images.push(record?.name));
  createSettingsStore(local, onChanged).subscribe((next, before) => settings.push([before.glass.enabled, next.glass.enabled]));
  await local.set({ [STORAGE_KEYS.image]: fakeImageRecord("one.png") });
  const parses = countParses(win);
  await local.set({ [STORAGE_KEYS.image]: fakeImageRecord("two.png") });
  assert.deepEqual(images, ["one.png", "two.png"]);
  assert.equal(parses.n, 1, "the new image only: the old one is never parsed back");
  await local.set({ [STORAGE_KEYS.settings]: { glass: { enabled: false } } });
  await local.set({ [STORAGE_KEYS.settings]: { glass: { enabled: true } } });
  assert.deepEqual(settings, [[true, false], [false, true]], "the settings hear what they were before, as stored (nothing stored: the defaults)");
});

test("desktop storage stub: a stored value that no longer parses can still be removed", async () => {
  const win = loadStub();
  win.localStorage.setItem("t3plus-ext:broken", "{not json");
  const events = [];
  win.chrome.storage.onChanged.addListener((changes) => events.push(changes));
  await win.chrome.storage.local.remove(["broken", "missing"]);
  assert.equal(win.localStorage.getItem("t3plus-ext:broken"), null);
  assert.deepEqual(events.map((c) => Object.keys(c)), [["broken"]]);
  assert.equal(events[0].broken.oldValue, undefined);
  assert.equal(events[0].broken.newValue, undefined);
});

test("desktop storage stub: loaded again into the same page (t3+ re-injected), it replaces the first copy", async () => {
  const dom = new JSDOM("<!doctype html><body></body>", { url: "https://app.t3.codes/", runScripts: "outside-only" });
  const win = dom.window;
  const source = readFileSync(new URL("../../inject/page-stub.js", import.meta.url), "utf8");
  win.eval(source);
  const first = win.chrome.storage;
  win.__t3plusBoot = { feeds: { threads: "{}" } };
  win.eval(source);
  assert.notEqual(win.chrome.storage, first, "the new copy's storage");
  assert.equal(win.__t3plusFeeds.threads, "{}", "and the feeds it was handed");
  const events = [];
  win.chrome.storage.onChanged.addListener((changes) => events.push(changes));
  first.onChanged.addListener((changes) => events.push(changes));
  win.dispatchEvent(new win.StorageEvent("storage", { key: "t3plus-ext:view", oldValue: null, newValue: '{"view":"status"}', storageArea: win.localStorage }));
  assert.equal(events.length, 1, "another window's save is relayed once, by the new copy only");
  assert.equal(JSON.stringify(events[0].view.newValue), '{"view":"status"}');
});
