import { STORAGE_KEYS } from "./config.js";

// Keeping t3+ settings across reinstalls and new versions.
//
// 1. The manifest pins the extension's public key, so every build has the same
//    extension ID, wherever it is unpacked. chrome.storage belongs to that ID.
// 2. The small preferences are mirrored to chrome.storage.sync (Chrome Sync)
//    and restored on a fresh install, so removing and re-adding the extension,
//    or using another computer signed in to the same Chrome profile, keeps them.
// 3. The same preferences are also copied into T3's page storage
//    (localStorage on app.t3.codes, key t3plus.backup.v1). That copy belongs to
//    the site, not the extension, so it survives removing the extension, an
//    older build with a different extension ID, and Chrome Sync being off.
// 4. Export / Import (Settings) writes and reads a JSON file with everything,
//    including an uploaded background image, as a manual fallback.
//
// On start, a key missing locally is restored from Sync, else from the page
// copy. Local values are never overwritten.

/** Preferences mirrored to Chrome Sync: small, user-made, worth keeping. Profiles too (a large one stays local, see fits). */
export const SYNCED_KEYS = Object.freeze([STORAGE_KEYS.settings, STORAGE_KEYS.bots, STORAGE_KEYS.manualBots, STORAGE_KEYS.profiles]);
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
    page.setItem(PAGE_BACKUP_KEY, JSON.stringify({ app: "t3plus", savedAt: new Date().toISOString(), data }));
  } catch {
    // Storage full or blocked: Sync and local storage still have everything.
  }
}

/**
 * Fresh install (keys missing locally): restore them from Chrome Sync, then
 * from the page copy, before t3+ reads its settings. Returns the restored keys.
 */
export async function restoreBackups(local, { sync = null, page = null } = {}) {
  const fromSync = await restoreFromSync(local, sync).catch(() => []);
  const data = readPageBackup(page);
  if (!data) return fromSync;
  const have = await local.get([...SYNCED_KEYS]);
  const restore = Object.fromEntries(SYNCED_KEYS.filter((k) => have?.[k] === undefined && data[k] !== undefined).map((k) => [k, data[k]]));
  if (Object.keys(restore).length) await local.set(restore);
  return [...fromSync, ...Object.keys(restore)];
}

/**
 * Fresh install (nothing local yet): copy what Chrome Sync kept into local
 * storage before t3+ reads its settings. Returns the restored keys.
 */
export async function restoreFromSync(local, sync) {
  if (!sync) return [];
  const have = await local.get([...SYNCED_KEYS]);
  const missing = SYNCED_KEYS.filter((k) => have?.[k] === undefined);
  if (!missing.length) return [];
  let remote;
  try {
    remote = await sync.get(missing);
  } catch {
    return [];
  }
  const restore = Object.fromEntries(missing.filter((k) => remote?.[k] !== undefined).map((k) => [k, remote[k]]));
  if (Object.keys(restore).length) await local.set(restore);
  return Object.keys(restore);
}

/**
 * Keeps Chrome Sync in step with local storage: pushes the current values once,
 * then every change to a synced key (debounced, so slider drags write once).
 * @returns {() => void} stop
 */
export function mirrorToSync({ local, sync, page = null, changedEvent, setTimer = setTimeout, clearTimer = clearTimeout, delayMs = 1500 }) {
  if ((!sync && !page) || !changedEvent) return () => {};
  const pending = new Map();
  const current = {}; // every synced key's latest value, for the page copy
  let timer = null;
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
      if (value === undefined) remove.push(key);
      else if (fits(value, key)) set[key] = value;
    }
    pending.clear();
    // One write per item: one Sync refuses (its quota) no longer takes the others with it.
    for (const [key, value] of Object.entries(set)) {
      try {
        await sync.set({ [key]: value });
      } catch {
        // Sync quota or Chrome Sync off: local storage still has everything.
      }
    }
    try {
      if (remove.length) await sync.remove(remove);
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
    if (areaName !== "local") return;
    for (const key of SYNCED_KEYS) if (key in changes) queue(key, changes[key].newValue);
  };
  changedEvent.addListener(listener);
  // First run after an update: make sure Sync has what is already local.
  local.get([...SYNCED_KEYS]).then((have) => {
    for (const key of SYNCED_KEYS) if (have?.[key] !== undefined) queue(key, have[key]);
  });
  return () => {
    changedEvent.removeListener(listener);
    if (timer !== null) clearTimer(timer);
  };
}

/** A backup file's contents: { app, version, exportedAt, data: { key: value } }. */
export async function exportAll(local, version) {
  const data = await local.get([...EXPORTED_KEYS]);
  return { app: "t3plus", version, exportedAt: new Date().toISOString(), data: Object.fromEntries(Object.entries(data ?? {}).filter(([, v]) => v !== undefined)) };
}

/**
 * Restores a backup file. Only known keys are written, each only when it holds
 * an object (every t3+ key does), and passed through `normalize[key]` when given,
 * so a hand-edited or damaged file stores the same clean values the app would
 * have saved. Returns the written keys.
 */
export async function importAll(local, backup, normalize = {}) {
  if (!backup || backup.app !== "t3plus" || !backup.data || typeof backup.data !== "object") throw new Error("Not a t3+ backup file.");
  const write = {};
  for (const [k, v] of Object.entries(backup.data)) {
    if (!EXPORTED_KEYS.includes(k) || !v || typeof v !== "object" || Array.isArray(v)) continue;
    const value = typeof normalize[k] === "function" ? normalize[k](v) : v;
    if (value === null || value === undefined) continue; // nothing usable (a broken image)
    write[k] = value;
  }
  if (!Object.keys(write).length) throw new Error("The backup has no t3+ settings in it.");
  await local.set(write);
  return Object.keys(write);
}
