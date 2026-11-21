import assert from "node:assert/strict";
import { test } from "node:test";
import { importAll, mirrorToSync, PAGE_BACKUP_KEY, readSynced, SYNCED_KEYS } from "../src/backup.js";
import { DESKTOP_IMAGE_LIMITS, STORAGE_KEYS } from "../src/config.js";
import { normalizeImageRecord } from "../src/imageStore.js";
import { createApp, createDom, createFakeChromeStorage, settle, sidebarHtml } from "./helpers.js";

const fakePage = () => {
  const items = new Map();
  const counts = { get: 0, set: 0 };
  return { items, counts, getItem: (k) => ((counts.get += 1), items.has(k) ? items.get(k) : null), setItem: (k, v) => ((counts.set += 1), items.set(k, String(v))) };
};
/** A Sync area that counts its writes, as Chrome counts each against the quota, changed or not. */
const countingSync = () => {
  const sync = createFakeChromeStorage();
  const calls = { set: 0, get: 0 };
  const { set, get } = sync.area;
  sync.area.set = (items) => ((calls.set += 1), set(items));
  sync.area.get = (keys) => ((calls.get += 1), get(keys));
  return { ...sync, calls };
};
const timers = () => {
  const pending = [];
  return { pending, setTimer: (fn) => (pending.push(fn), pending.length), clearTimer: () => {}, run: async () => pending.splice(0).at(-1)?.() };
};

test("start-up with every synced key stored: one read, no Sync and no page copy read", async () => {
  const local = createFakeChromeStorage();
  for (const key of SYNCED_KEYS) local.area.data.set(key, { v: key });
  let gets = 0;
  const get = local.area.get;
  local.area.get = (keys) => ((gets += 1), get(keys));
  const sync = countingSync();
  const page = fakePage();
  const { restored, values } = await readSynced(local.area, { sync: sync.area, page });
  assert.deepEqual(restored, []);
  assert.deepEqual(values[STORAGE_KEYS.profiles], { v: STORAGE_KEYS.profiles }, "handed on (the profile color migration reads them from here)");
  assert.equal(gets, 1);
  assert.equal(sync.calls.get, 0);
  assert.equal(page.counts.get, 0);
});

test("a fresh install: Sync first, then the page copy, and the restored values are handed on", async () => {
  const local = createFakeChromeStorage();
  const sync = createFakeChromeStorage();
  sync.area.data.set(STORAGE_KEYS.settings, { from: "sync" });
  const page = fakePage();
  page.items.set(PAGE_BACKUP_KEY, JSON.stringify({ app: "t3plus", data: { [STORAGE_KEYS.settings]: { from: "page" }, [STORAGE_KEYS.profiles]: { from: "page" } } }));
  const { restored, values } = await readSynced(local.area, { sync: sync.area, page });
  assert.deepEqual(restored.sort(), [STORAGE_KEYS.profiles, STORAGE_KEYS.settings].sort());
  assert.deepEqual(values[STORAGE_KEYS.settings], { from: "sync" });
  assert.deepEqual(local.area.data.get(STORAGE_KEYS.profiles), { from: "page" });
});

test("a mirror stopped before its first read lands writes nothing and leaves no listener", async () => {
  const local = createFakeChromeStorage();
  local.area.data.set(STORAGE_KEYS.settings, { a: 1 });
  const t = timers();
  const stop = mirrorToSync({ local: local.area, sync: createFakeChromeStorage().area, page: fakePage(), changedEvent: local.onChanged, setTimer: t.setTimer, clearTimer: t.clearTimer });
  stop();
  await settle();
  assert.equal(t.pending.length, 0, "no flush queued");
  assert.equal(local.onChanged.listenerCount(), 0);
});

test("Sync is not written again with what it already holds: on start, or a value another device wrote there", async () => {
  const local = createFakeChromeStorage();
  const sync = countingSync();
  local.area.data.set(STORAGE_KEYS.settings, { a: 1 });
  sync.area.data.set(STORAGE_KEYS.settings, { a: 1 });
  const heard = [];
  const changedEvent = { addListener: (fn) => (heard.push(fn), local.onChanged.addListener(fn)), removeListener: (fn) => local.onChanged.removeListener(fn) };
  const t = timers();
  const stop = mirrorToSync({ local: local.area, sync: sync.area, changedEvent, setTimer: t.setTimer, clearTimer: t.clearTimer });
  await settle();
  await t.run();
  assert.equal(sync.calls.set, 0, "start: Sync matches");
  await local.area.set({ [STORAGE_KEYS.settings]: { a: 2 } });
  await t.run();
  assert.equal(sync.calls.set, 1, "a change: one write");
  assert.deepEqual(sync.area.data.get(STORAGE_KEYS.settings), { a: 2 });
  // Another device writes Sync (Chrome reports it on the same event, area "sync"); its
  // value reaches local storage here too, and comes back to the mirror.
  heard[0]({ [STORAGE_KEYS.bots]: { newValue: { b: 1 } } }, "sync");
  await local.area.set({ [STORAGE_KEYS.bots]: { b: 1 } });
  await t.run();
  assert.equal(sync.calls.set, 1, "not written back");
  stop();
});

test("the page copy is written once for the same values, however many tabs flush them", async () => {
  const local = createFakeChromeStorage();
  local.area.data.set(STORAGE_KEYS.settings, { a: 1 });
  const page = fakePage();
  const tabs = [timers(), timers(), timers()];
  const stops = tabs.map((t) => mirrorToSync({ local: local.area, sync: null, page, changedEvent: local.onChanged, setTimer: t.setTimer, clearTimer: t.clearTimer }));
  await settle();
  for (const t of tabs) await t.run();
  assert.equal(page.counts.set, 1, "three tabs loading: one write");
  await local.area.set({ [STORAGE_KEYS.bots]: { b: 1 } });
  for (const t of tabs) await t.run();
  assert.equal(page.counts.set, 2, "one change: one more write");
  const saved = JSON.parse(page.items.get(PAGE_BACKUP_KEY));
  assert.equal(saved.app, "t3plus");
  assert.deepEqual(saved.data, { [STORAGE_KEYS.settings]: { a: 1 }, [STORAGE_KEYS.bots]: { b: 1 } });
  for (const stop of stops) stop();
});

/** A storage area like the desktop stub's: all of a write or none, refused past its room. */
const roomFor = (chars) => {
  const storage = createFakeChromeStorage();
  const set = storage.area.set;
  storage.area.set = (items) => {
    const size = [...storage.area.data.values(), ...Object.values(items)].reduce((n, v) => n + JSON.stringify(v).length, 0);
    return size > chars ? Promise.reject(new Error("Not enough room left in T3's storage to save this. Try a smaller image.")) : set(items);
  };
  return storage;
};
const image = (chars) => ({ dataUrl: `data:image/webp;base64,${"A".repeat(chars)}`, name: "bg.webp", width: 10, height: 10, savedAt: 1 });

test("an import whose image does not fit still restores the settings, and says the image was left out", async () => {
  const storage = roomFor(100_000);
  const backup = { app: "t3plus", data: { [STORAGE_KEYS.settings]: { glass: { enabled: true } }, [STORAGE_KEYS.image]: image(200_000) } };
  const { keys, skipped } = await importAll(storage.area, backup);
  assert.deepEqual(keys, [STORAGE_KEYS.settings]);
  assert.deepEqual(skipped, [STORAGE_KEYS.image]);
  assert.ok(storage.area.data.has(STORAGE_KEYS.settings));
  const roomy = createFakeChromeStorage();
  assert.deepEqual((await importAll(roomy.area, backup)).keys, [STORAGE_KEYS.settings, STORAGE_KEYS.image], "with room, the image too");
  await assert.rejects(importAll(storage.area, { app: "t3plus", data: { [STORAGE_KEYS.image]: image(200_000) } }), /Not enough room/, "nothing restored at all: the reason");
});

test("an image record over the desktop's cap is not one the desktop stores; the extension's cap still takes it", () => {
  const big = image(1.5 * 1024 * 1024);
  assert.equal(normalizeImageRecord(big, DESKTOP_IMAGE_LIMITS), null);
  assert.equal(normalizeImageRecord(big).name, "bg.webp");
});

test("the desktop app shrinks a backup's larger image as an upload would, keeping its name; one that cannot be is left out", async () => {
  const run = async (prepareImage) => {
    const storage = createFakeChromeStorage();
    const dom = createDom("/", sidebarHtml());
    const backup = { import: (data) => importAll(storage.area, data) };
    const { app } = createApp(dom, storage, { backup, imageLimits: DESKTOP_IMAGE_LIMITS, prepareImage });
    await app.start();
    const file = { name: "b.json", text: async () => JSON.stringify({ app: "t3plus", data: { [STORAGE_KEYS.settings]: { glass: { enabled: false } }, [STORAGE_KEYS.image]: image(1.5 * 1024 * 1024) } }) };
    await app.actions.importSettings(file);
    await settle();
    app.stop();
    return { storage, message: app.state.message };
  };
  const asked = [];
  const shrunk = await run(async (blob, limits) => (asked.push(limits), { ...image(1000), name: "blob" }));
  assert.deepEqual(asked, [DESKTOP_IMAGE_LIMITS]);
  assert.equal(shrunk.storage.area.data.get(STORAGE_KEYS.image).dataUrl.length, image(1000).dataUrl.length);
  assert.equal(shrunk.storage.area.data.get(STORAGE_KEYS.image).name, "bg.webp", "its own name, not the blob's");
  const failed = await run(async () => {
    throw new Error("Image is too large");
  });
  assert.equal(failed.storage.area.data.has(STORAGE_KEYS.image), false);
  assert.equal(failed.storage.area.data.get(STORAGE_KEYS.settings).glass.enabled, false, "the settings are restored");
  assert.match(failed.message, /background image did not fit/);
});

test("the backup mirror is the app's: started with it, stopped with it, never started by a copy stopped first", async () => {
  const storage = createFakeChromeStorage();
  const page = fakePage();
  const mirror = () => mirrorToSync({ local: storage.area, sync: null, page, changedEvent: storage.onChanged, delayMs: 0 });
  const before = storage.onChanged.listenerCount();
  const early = createApp(createDom("/", sidebarHtml()), storage, { mirror }).app;
  early.stop();
  await early.start();
  assert.equal(storage.onChanged.listenerCount(), before, "stopped before it started: no mirror");

  const { app } = createApp(createDom("/", sidebarHtml()), storage, { mirror });
  await app.start();
  await new Promise((r) => setTimeout(r, 5));
  assert.ok(page.items.has(PAGE_BACKUP_KEY), "the page copy written");
  app.stop();
  assert.equal(storage.onChanged.listenerCount(), before, "every listener released, the mirror's too");
  const writes = page.counts.set;
  await storage.area.set({ [STORAGE_KEYS.bots]: { b: 1 } });
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(page.counts.set, writes, "a stopped copy mirrors nothing");
});
