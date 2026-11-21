import assert from "node:assert/strict";
import { test } from "node:test";
import { EXPORTED_KEYS, exportAll, importAll, mirrorToSync, restoreFromSync, SYNCED_KEYS } from "../src/backup.js";
import { STORAGE_KEYS } from "../src/config.js";
import { createSettingsStore, defaultSettings } from "../src/settings.js";
import { WRITE_STAMP } from "../src/storageKeys.js";
import { createFakeChromeStorage } from "./helpers.js";

test("a fresh install restores preferences from Chrome Sync; existing local values win", async () => {
  const local = createFakeChromeStorage();
  const sync = createFakeChromeStorage();
  sync.area.data.set(STORAGE_KEYS.settings, { version: 2, glass: { enabled: true, strength: 70 } });
  sync.area.data.set(STORAGE_KEYS.bots, { "env1:bot1": { shape: "football", color: "orange" } });
  local.area.data.set(STORAGE_KEYS.manualBots, { "env1:a": true });
  sync.area.data.set(STORAGE_KEYS.manualBots, { "env1:b": true });
  const restored = await restoreFromSync(local.area, sync.area);
  assert.deepEqual(restored.sort(), [STORAGE_KEYS.bots, STORAGE_KEYS.settings].sort());
  assert.equal(local.area.data.get(STORAGE_KEYS.settings).glass.strength, 70);
  assert.deepEqual(local.area.data.get(STORAGE_KEYS.manualBots), { "env1:a": true }, "local is never overwritten");
  assert.deepEqual(await restoreFromSync(local.area, null), []);
});

test("changes are mirrored to Chrome Sync, debounced; images never are", async () => {
  const local = createFakeChromeStorage();
  const sync = createFakeChromeStorage();
  local.area.data.set(STORAGE_KEYS.settings, { version: 2, a: 1 });
  const timers = [];
  const stop = mirrorToSync({ local: local.area, sync: sync.area, changedEvent: local.onChanged, setTimer: (f) => timers.push(f) && timers.length, clearTimer: () => {} });
  await new Promise((r) => setTimeout(r, 0));
  await local.area.set({ [STORAGE_KEYS.bots]: { "env1:b": { shape: "star", color: "green" } } });
  await local.area.set({ [STORAGE_KEYS.image]: { dataUrl: "data:image/webp;base64,AAAA" } });
  assert.equal(sync.area.data.size, 0, "nothing written until the debounce fires");
  await timers.at(-1)();
  assert.deepEqual(sync.area.data.get(STORAGE_KEYS.settings), { version: 2, a: 1 }, "existing values pushed once");
  assert.equal(sync.area.data.get(STORAGE_KEYS.bots)["env1:b"].shape, "star");
  assert.equal(sync.area.data.has(STORAGE_KEYS.image), false, "images are never synced");
  stop();
  assert.ok(!SYNCED_KEYS.includes(STORAGE_KEYS.image));
});

// Chrome Sync takes 8 KB per item; backup.js keeps a value over 7600 bytes (its key and
// its JSON, in UTF-8) local only.
const SYNC_LIMIT = 7600;
const utf8Size = (key, value) => new TextEncoder().encode(key + JSON.stringify(value)).length;
const manyBots = Object.fromEntries(Array.from({ length: 400 }, (_, i) => [`env1:thread-${i}`, true])); // ~9 KB
const mirrorOnce = async (local, sync) => {
  const timers = [];
  const stop = mirrorToSync({ local: local.area, sync: sync.area, changedEvent: local.onChanged, setTimer: (f) => timers.push(f), clearTimer: () => {} });
  await new Promise((r) => setTimeout(r, 0));
  return async () => {
    await timers.at(-1)();
    stop();
  };
};

test("a value too big for a Sync item stays local; the limit counts UTF-8 bytes, not characters", async () => {
  const local = createFakeChromeStorage();
  const sync = createFakeChromeStorage();
  const flush = await mirrorOnce(local, sync);
  const profiles = { active: "main", list: [{ id: "main", name: "é".repeat(4000), color: "default" }], projects: {} };
  assert.ok(utf8Size(STORAGE_KEYS.manualBots, manyBots) > SYNC_LIMIT);
  assert.ok((STORAGE_KEYS.profiles + JSON.stringify(profiles)).length < SYNC_LIMIT && utf8Size(STORAGE_KEYS.profiles, profiles) > SYNC_LIMIT, "fits in characters, not in bytes");
  await local.area.set({ [STORAGE_KEYS.manualBots]: manyBots, [STORAGE_KEYS.profiles]: profiles, [STORAGE_KEYS.bots]: { "env1:b": { shape: "star", color: "green" } } });
  await flush();
  assert.ok(sync.area.data.has(STORAGE_KEYS.bots), "the small one, in the same write, is synced");
  assert.equal(sync.area.data.has(STORAGE_KEYS.manualBots), false, "too big for a Sync item");
  assert.equal(sync.area.data.has(STORAGE_KEYS.profiles), false, "bytes, not characters");
  assert.equal(Object.keys(local.area.data.get(STORAGE_KEYS.manualBots)).length, 400, "local keeps it");
});

test("a value that outgrows its Sync item takes its last copy out of Sync", async () => {
  const local = createFakeChromeStorage();
  const sync = createFakeChromeStorage();
  sync.area.data.set(STORAGE_KEYS.manualBots, { "env1:a": true }); // an earlier copy, when it still fit
  const flush = await mirrorOnce(local, sync);
  await local.area.set({ [STORAGE_KEYS.manualBots]: manyBots });
  await flush();
  // Else a new install restores that one bot from Sync instead of the page copy's 400.
  assert.equal(sync.area.data.has(STORAGE_KEYS.manualBots), false);
});

test("export and import round-trip every preference, and reject other files", async () => {
  const a = createFakeChromeStorage();
  a.area.data.set(STORAGE_KEYS.settings, { version: 2, home: { widgets: false } });
  a.area.data.set(STORAGE_KEYS.image, { dataUrl: "data:image/webp;base64,AAAA", name: "bg.webp" });
  a.area.data.set(STORAGE_KEYS.homeFeedCache, { text: "{}" });
  const file = await exportAll(a.area, "0.14.0");
  assert.equal(file.app, "t3plus");
  assert.deepEqual(Object.keys(file.data).sort(), [STORAGE_KEYS.image, STORAGE_KEYS.settings].sort(), "caches are not exported");
  const b = createFakeChromeStorage();
  const { keys } = await importAll(b.area, JSON.parse(JSON.stringify(file)));
  assert.equal(keys.length, 2);
  assert.equal(b.area.data.get(STORAGE_KEYS.image).name, "bg.webp");
  await assert.rejects(importAll(b.area, { app: "other" }), /Not a t3\+ backup/);
  await assert.rejects(importAll(b.area, { app: "t3plus", data: { evil: 1 } }), /no t3\+ settings/);
  assert.ok(EXPORTED_KEYS.includes(STORAGE_KEYS.knownBots));
});

test("profiles are part of every backup, and imports store normalised values", async () => {
  assert.ok(EXPORTED_KEYS.includes(STORAGE_KEYS.profiles), "Export keeps your profiles");
  assert.ok(SYNCED_KEYS.includes(STORAGE_KEYS.profiles), "and so do Sync and the page copy");
  const a = createFakeChromeStorage();
  const profiles = { active: "p1", list: [{ id: "main", name: "Main", color: "default" }, { id: "p1", name: "Work", color: "blue" }], projects: { "env:/code/app": "p1" } };
  a.area.data.set(STORAGE_KEYS.profiles, profiles);
  const file = JSON.parse(JSON.stringify(await exportAll(a.area, "0.18.2")));
  assert.deepEqual(file.data[STORAGE_KEYS.profiles], profiles);
  const b = createFakeChromeStorage();
  const seen = [];
  const { keys } = await importAll(
    b.area,
    { app: "t3plus", data: { ...file.data, [STORAGE_KEYS.settings]: { composerGradient: { intensity: "lots" } }, [STORAGE_KEYS.bots]: [1, 2] } },
    { [STORAGE_KEYS.settings]: (v) => (seen.push(v), { normalised: true }) },
  );
  assert.deepEqual(b.area.data.get(STORAGE_KEYS.profiles), profiles);
  assert.deepEqual(b.area.data.get(STORAGE_KEYS.settings), { normalised: true }, "settings went through the normaliser");
  assert.equal(seen.length, 1);
  assert.ok(!keys.includes(STORAGE_KEYS.bots), "a value of the wrong type is skipped, not stored");
});

const fakePage = () => {
  const items = new Map();
  return { items, getItem: (k) => (items.has(k) ? items.get(k) : null), setItem: (k, v) => items.set(k, String(v)) };
};

test("preferences are also copied to T3's page storage, and a reinstall without Sync restores from it", async () => {
  const { PAGE_BACKUP_KEY, restoreBackups } = await import("../src/backup.js");
  const page = fakePage();
  const local = createFakeChromeStorage();
  local.area.data.set(STORAGE_KEYS.settings, { version: 2, sidebar: { bots: false } });
  const timers = [];
  const stop = mirrorToSync({ local: local.area, sync: null, page, changedEvent: local.onChanged, setTimer: (f) => timers.push(f) && timers.length, clearTimer: () => {} });
  await new Promise((r) => setTimeout(r, 0));
  await local.area.set({ [STORAGE_KEYS.bots]: { "env1:b": { shape: "star", color: "green" } } });
  await timers.at(-1)();
  stop();
  const saved = JSON.parse(page.items.get(PAGE_BACKUP_KEY));
  assert.equal(saved.data[STORAGE_KEYS.settings].sidebar.bots, false);
  assert.equal(saved.data[STORAGE_KEYS.bots]["env1:b"].shape, "star");

  // The extension is removed and loaded again: its storage is empty, Sync has nothing.
  const fresh = createFakeChromeStorage();
  const restored = await restoreBackups(fresh.area, { sync: createFakeChromeStorage().area, page });
  assert.deepEqual(restored.sort(), [STORAGE_KEYS.bots, STORAGE_KEYS.settings].sort());
  assert.equal(fresh.area.data.get(STORAGE_KEYS.settings).sidebar.bots, false);

  // Sync wins for a key it has; local values are never overwritten; a broken page copy is ignored.
  const sync = createFakeChromeStorage();
  sync.area.data.set(STORAGE_KEYS.settings, { version: 2, sidebar: { bots: true } });
  const other = createFakeChromeStorage();
  other.area.data.set(STORAGE_KEYS.bots, { mine: { shape: "circle", color: "blue" } });
  await restoreBackups(other.area, { sync: sync.area, page });
  assert.equal(other.area.data.get(STORAGE_KEYS.settings).sidebar.bots, true);
  assert.deepEqual(Object.keys(other.area.data.get(STORAGE_KEYS.bots)), ["mine"]);
  page.setItem(PAGE_BACKUP_KEY, "{not json");
  assert.deepEqual(await restoreBackups(createFakeChromeStorage().area, { page }), []);
});

test("a write's stamp stays in local storage: Sync, the page copy and exports leave it out, and an import of one does not keep it", async () => {
  const local = createFakeChromeStorage();
  const sync = createFakeChromeStorage();
  const items = new Map();
  const page = { getItem: (k) => items.get(k) ?? null, setItem: (k, v) => items.set(k, String(v)) };
  const timers = [];
  const stop = mirrorToSync({ local: local.area, sync: sync.area, page, changedEvent: local.onChanged, setTimer: (f) => timers.push(f), clearTimer: () => {} });
  await new Promise((r) => setTimeout(r, 0));
  const key = STORAGE_KEYS.settings;
  const settings = { ...defaultSettings(), glass: { enabled: true, strength: 70 } };
  await createSettingsStore(local.area, local.onChanged).save(settings);
  assert.ok(WRITE_STAMP in local.area.data.get(key), "stored with its stamp");
  await timers.at(-1)();
  stop();
  assert.deepEqual(sync.area.data.get(key), settings, "Sync has the settings alone");
  assert.deepEqual(JSON.parse(items.get("t3plus.backup.v1")).data[key], settings, "and so does the page copy");
  const backup = await exportAll(local.area, "1.0.0");
  assert.deepEqual(backup.data[key], settings, "and the export");
  const other = createFakeChromeStorage();
  await importAll(other.area, { app: "t3plus", data: { [key]: { ...settings, [WRITE_STAMP]: { id: "w:1", own: [] } } } });
  assert.deepEqual(other.area.data.get(key), settings, "an imported stamp is not kept");
});
