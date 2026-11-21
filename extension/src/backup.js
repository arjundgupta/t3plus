import { STORAGE_KEYS, withoutWriteStamp } from "./storageKeys.js";

// Keeping t3+ settings across reinstalls and new versions.
//
// 1. The manifest pins the extension's public key, so every build has the same
//    extension ID, wherever it is unpacked. chrome.storage belongs to that ID.
// 2. The small preferences are mirrored to chrome.storage.sync (Chrome Sync)
//    and restored on a fresh install, so removing and re-adding the extension,
//    or using another computer signed in to the same Chrome profile, keeps them.
// 3. In the Chrome extension, the same preferences are also copied into T3's page
//    storage (localStorage on app.t3.codes, key t3plus.backup.v1). That copy belongs
//    to the site, not the extension, so it survives removing the extension, an
//    older build with a different extension ID, and Chrome Sync being off. The
//    desktop build keeps none (content/index.js): its storage already is T3's
//    localStorage, so a copy there would be lost with what it backs up.
// 4. Export / Import (Settings) writes and reads a JSON file with everything,
//    including an uploaded background image, as a manual fallback.
//
// On start, a key missing locally is restored from Sync, else from the page
// copy. Local values are never overwritten.
//
// In the desktop app there is no Sync (the page stub has none); each T3 window keeps
// its origin's page copy.

/** Preferences mirrored to Chrome Sync: small, user-made, worth keeping. Profiles too (a large one stays local, see fits). */
export const SYNCED_KEYS = Object.freeze([STORAGE_KEYS.settings, STORAGE_KEYS.scopes, STORAGE_KEYS.bots, STORAGE_KEYS.manualBots, STORAGE_KEYS.profiles]);
/** Everything in an export. Caches are left out (they refill from the server). */
export const EXPORTED_KEYS = Object.freeze([...SYNCED_KEYS, STORAGE_KEYS.image, STORAGE_KEYS.knownBots]);
/** chrome.storage.sync allows 8 KB per item (its key and its JSON, in UTF-8 bytes); larger values stay local only. */
const SYNC_ITEM_LIMIT = 7600;
const encoder = typeof TextEncoder === "function" ? new TextEncoder() : null;

const fits = (value, key = "") => {
  try {
    // Bytes, not characters: a profile name in another script is two or three
    // bytes a character, and an item over the limit failed the whole write.
    const text = key + JSON.stringify(value);
    return (encoder ? encoder.encode(text).length : text.length * 3) <= SYNC_ITEM_LIMIT;
  } catch {
    return false;
  }
};

/** The page-storage copy (see 3. above). */
export const PAGE_BACKUP_KEY = "t3plus.backup.v1";

export function readPageBackup(page) {
  try {
    const parsed = JSON.parse(page?.getItem(PAGE_BACKUP_KEY) ?? "null");
    return parsed && parsed.app === "t3plus" && parsed.data && typeof parsed.data === "object" ? parsed.data : null;
  } catch {
    return null;
  }
}

function writePageBackup(page, data) {
  if (!page) return;
  try {
    // Every T3 tab of the origin hears the same change: the copy is written once. Its keys
    // in one order, with the data last, so the same values give the same ending.
    const json = JSON.stringify(Object.fromEntries(SYNCED_KEYS.filter((k) => k in data).map((k) => [k, data[k]])));
    if (page.getItem(PAGE_BACKUP_KEY)?.endsWith(`,"data":${json}}`)) return;
    page.setItem(PAGE_BACKUP_KEY, `{"app":"t3plus","savedAt":${JSON.stringify(new Date().toISOString())},"data":${json}}`);
  } catch {
    // Storage full or blocked: Sync and local storage still have everything.
  }
}

/**
 * The synced keys as stored, read once before t3+ starts. A key missing (a fresh install)
 * is restored from Chrome Sync, else from the page copy; when nothing is missing, neither
 * is read. Local values are never overwritten.
 * @returns {Promise<{ restored: string[], values: object }>} the restored keys, and every
 *   synced key's value (restored ones included)
 */
export async function readSynced(local, { sync = null, page = null } = {}) {
  const values = { ...(await local.get([...SYNCED_KEYS])) };
  const restored = [];
  const missing = () => SYNCED_KEYS.filter((k) => values[k] === undefined);
  const restoreFrom = async (source) => {
    const restore = Object.fromEntries(missing().filter((k) => source?.[k] !== undefined).map((k) => [k, source[k]]));
    if (!Object.keys(restore).length) return;
    await local.set(restore);
    Object.assign(values, restore);
    restored.push(...Object.keys(restore));
  };
  if (!missing().length) return { restored, values };
  if (sync) {
    try {
      await restoreFrom(await sync.get(missing()));
    } catch {
      // Chrome Sync off or unreachable: the page copy may still have them.
    }
  }
  if (missing().length) await restoreFrom(readPageBackup(page));
  return { restored, values };
}

/** Fresh install: restores the missing keys from Chrome Sync, then from the page copy. Returns the restored keys. */
export const restoreBackups = async (local, sources = {}) => (await readSynced(local, sources)).restored;

/** Fresh install (nothing local yet): restores what Chrome Sync kept. Returns the restored keys. */
export const restoreFromSync = (local, sync) => (sync ? restoreBackups(local, { sync }) : Promise.resolve([]));

/**
 * Keeps Chrome Sync and the page copy in step with local storage: pushes the current
 * values once, then every change to a synced key (debounced, so slider drags write once).
 * A value Sync already holds is not written again: every write counts against the
 * extension's Sync quota (120 a minute), changed or not, and a refused one is lost.
 * @returns {() => void} stop
 */
export function mirrorToSync({ local, sync, page = null, changedEvent, setTimer = setTimeout, clearTimer = clearTimeout, delayMs = 1500 }) {
  if ((!sync && !page) || !changedEvent) return () => {};
  let running = true;
  const pending = new Map();
  const current = {}; // every synced key's latest value, for the page copy
  const inSync = new Map(); // key -> the JSON Sync holds (its last write here, or as read or heard)
  let timer = null;
  const heardInSync = (key, value) => (value === undefined ? inSync.delete(key) : inSync.set(key, JSON.stringify(value)));
  const flush = async () => {
    timer = null;
    writePageBackup(page, current);
    if (!sync) {
      pending.clear();
      return;
    }
    const set = {};
    const remove = [];
    for (const [key, value] of pending) {
      if (value === undefined ? !inSync.has(key) : inSync.get(key) === JSON.stringify(value)) continue;
      if (value !== undefined && fits(value, key)) set[key] = value;
      // Gone, or grown too big for a Sync item: its last copy that fit leaves Sync, or a
      // fresh install would restore that older value instead of the page copy's.
      else if (inSync.has(key)) remove.push(key);
    }
    pending.clear();
    // One write per item: one Sync refuses (its quota) no longer takes the others with it.
    for (const [key, value] of Object.entries(set)) {
      try {
        await sync.set({ [key]: value });
        heardInSync(key, value);
      } catch {
        // Sync quota or Chrome Sync off: local storage still has everything.
      }
    }
    try {
      if (remove.length) {
        await sync.remove(remove);
        for (const key of remove) inSync.delete(key);
      }
    } catch {
      // as above
    }
  };
  const queue = (key, value) => {
    pending.set(key, value);
    if (value === undefined) delete current[key];
    else current[key] = value;
    if (timer !== null) clearTimer(timer);
    timer = setTimer(flush, delayMs);
  };
  const listener = (changes, areaName) => {
    // Written to Sync (here, or by another device): what it holds now.
    if (areaName === "sync") {
      for (const key of SYNCED_KEYS) if (key in changes) heardInSync(key, changes[key].newValue);
      return;
    }
    if (areaName !== "local") return;
    // Without the write's stamp: a backup holds the value, and the same value saved again is no change to Sync.
    for (const key of SYNCED_KEYS) if (key in changes) queue(key, withoutWriteStamp(changes[key].newValue));
  };
  changedEvent.addListener(listener);
  // On start: make sure Sync and the page copy have what is already local. Stopped before
  // these reads land (a newer copy took over), it writes nothing.
  Promise.all([local.get([...SYNCED_KEYS]), sync ? sync.get([...SYNCED_KEYS]).catch(() => null) : null])
    .then(([have, remote]) => {
      if (!running) return;
      for (const key of SYNCED_KEYS) if (remote?.[key] !== undefined && !inSync.has(key)) heardInSync(key, remote[key]);
      for (const key of SYNCED_KEYS) if (have?.[key] !== undefined) queue(key, withoutWriteStamp(have[key]));
    })
    .catch(() => {});
  return () => {
    running = false;
    changedEvent.removeListener(listener);
    if (timer !== null) clearTimer(timer);
    timer = null;
  };
}

/** A backup file's contents: { app, version, exportedAt, data: { key: value } }. */
export async function exportAll(local, version) {
  const data = await local.get([...EXPORTED_KEYS]);
  const values = Object.entries(data ?? {}).filter(([, v]) => v !== undefined);
  return { app: "t3plus", version, exportedAt: new Date().toISOString(), data: Object.fromEntries(values.map(([k, v]) => [k, withoutWriteStamp(v)])) };
}

/**
 * Restores a backup file. Only known keys are written, each only when it holds
 * an object (every t3+ key does), and passed through `normalize[key]` when given,
 * so a hand-edited or damaged file stores the same clean values the app would
 * have saved. The background image is written on its own, after the rest: one that
 * does not fit (the desktop's storage is T3's own, nearly full) is left out, and the
 * settings are still restored.
 * @returns {Promise<{ keys: string[], skipped: string[] }>} the written keys, and those left out
 */
export async function importAll(local, backup, normalize = {}) {
  if (!backup || backup.app !== "t3plus" || !backup.data || typeof backup.data !== "object") throw new Error("Not a t3+ backup file.");
  const write = {};
  for (const [k, v] of Object.entries(backup.data)) {
    if (!EXPORTED_KEYS.includes(k) || !v || typeof v !== "object" || Array.isArray(v)) continue;
    // A stamp in the file (one hand-copied from storage) is not the backup's: the writes here get their own.
    const clean = withoutWriteStamp(v);
    const value = typeof normalize[k] === "function" ? normalize[k](clean) : clean;
    if (value === null || value === undefined) continue; // nothing usable (a broken image)
    write[k] = value;
  }
  if (!Object.keys(write).length) throw new Error("The backup has no t3+ settings in it.");
  const { [STORAGE_KEYS.image]: image, ...rest } = write;
  const keys = Object.keys(rest);
  const skipped = [];
  if (keys.length) await local.set(rest);
  if (image) {
    try {
      await local.set({ [STORAGE_KEYS.image]: image });
      keys.push(STORAGE_KEYS.image);
    } catch (error) {
      if (!keys.length) throw error; // nothing restored at all: say why
      skipped.push(STORAGE_KEYS.image);
    }
  }
  return { keys, skipped };
}
