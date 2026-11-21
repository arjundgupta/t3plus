import { BOT_SHAPES, BOT_STYLES, DEFAULT_SETTINGS, GRADIENT_MODES, IMAGE_SOURCES, PICKABLE_BOT_COLORS, SAME_AS_BOT, STORAGE_KEYS } from "./config.js";
import { WRITE_STAMP } from "./storageKeys.js";

const HEX_COLOR = /^#[0-9a-f]{6}$/i;

const isObject = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);

// Each setting's rule: the value as stored (normalized), or undefined when it is not
// one. normalizeSettings fills in the default for those; a scope (settingsScopes.js)
// drops them, so the value it would have replaced shows instead.
const asBool = (value) => (typeof value === "boolean" ? value : undefined);
const asPercent = (value) => {
  // A number or a numeric string: null, "" and booleans would pass Number() as 0 or 1.
  if (typeof value !== "number" && !(typeof value === "string" && value.trim() !== "")) return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? Math.min(100, Math.max(0, Math.round(n))) : undefined;
};
const oneOf = (values) => (value) => (values.includes(value) ? value : undefined);
/** "theme" or a lowercase #rrggbb. */
const asColor = (value) => (value === "theme" ? "theme" : typeof value === "string" && HEX_COLOR.test(value) ? value.toLowerCase() : undefined);
const RULES = Object.freeze({
  composerGradient: {
    enabled: asBool,
    mode: oneOf(GRADIENT_MODES),
    accent: asColor,
    intensity: asPercent,
    imageSource: oneOf(IMAGE_SOURCES),
    dither: asBool,
    ditherSize: oneOf(["fine", "medium", "large"]),
    ditherStyle: oneOf(["bayer", "grain", "spectrum"]),
  },
  glass: { enabled: asBool, strength: asPercent },
  sidebar: {
    bots: asBool,
    botsDefault: asBool,
    botStyle: (value) => (typeof value === "string" && Object.hasOwn(BOT_STYLES, value) ? value : undefined),
    profiles: asBool,
    statusColors: asBool,
    statusBadges: asBool,
    subagentShape: (value) => (value === SAME_AS_BOT || (typeof value === "string" && Object.hasOwn(BOT_SHAPES, value)) ? value : undefined),
    subagentColor: (value) => (value === SAME_AS_BOT || PICKABLE_BOT_COLORS.includes(value) ? value : undefined),
  },
  chat: { bubble: asColor },
  home: { widgets: asBool },
  demo: { enabled: asBool },
});

/** Every setting as "group.name" (composerGradient.accent, chat.bubble, ...). */
export const SETTING_PATHS = Object.freeze(Object.entries(RULES).flatMap(([group, leaves]) => Object.keys(leaves).map((leaf) => `${group}.${leaf}`)));

/** One setting's value as stored ("group.name"), or undefined when it is not a valid one. */
export function normalizeSettingValue(path, value) {
  const [group, leaf] = String(path).split(".");
  const rule = Object.hasOwn(RULES, group) && Object.hasOwn(RULES[group], leaf) ? RULES[group][leaf] : null;
  return rule ? rule(value) : undefined;
}

/**
 * Returns a complete, valid settings object from anything read out of storage.
 * Unknown or invalid fields fall back to defaults, so a corrupt or older value
 * (including v1, which had only composerGradient) can never break the page.
 */
export function normalizeSettings(raw) {
  const source = isObject(raw) ? raw : {};
  const settings = { version: 2 };
  for (const [group, leaves] of Object.entries(RULES)) {
    const given = isObject(source[group]) ? source[group] : {};
    settings[group] = {};
    for (const [leaf, rule] of Object.entries(leaves)) settings[group][leaf] = rule(given[leaf]) ?? DEFAULT_SETTINGS[group][leaf];
  }
  return settings;
}

export function defaultSettings() {
  return normalizeSettings(DEFAULT_SETTINGS);
}

/**
 * Local visual preferences, persisted in an extension storage area
 * (chrome.storage.local in the extension; a fake in tests). Nothing here is
 * sent to T3's server.
 *
 * @param {chrome.storage.StorageArea} area
 * @param {chrome.storage.StorageChangedEvent | undefined} changedEvent
 */
export function createSettingsStore(area, changedEvent) {
  return createStampedStore(area, changedEvent, STORAGE_KEYS.settings, normalizeSettings);
}

// Every window has its own: two windows' write ids never collide (a module count alone would).
const WINDOW_ID = Math.random().toString(36).slice(2, 10);
let writeCount = 0;
/** An id for one more write from this window. */
export const newWriteId = () => `${WINDOW_ID}:${(writeCount += 1)}`;
const isPath = (path) => Array.isArray(path) && path.length > 0 && path.every((key) => typeof key === "string");
/** The stamp `raw` was stored with ({ id, own }: own null when not given), or null (none: saved before stamps, or written raw, as by an import). */
function stampOf(raw) {
  const stamp = raw?.[WRITE_STAMP];
  return typeof stamp?.id === "string" ? { id: stamp.id, own: Array.isArray(stamp.own) ? stamp.own.filter(isPath) : null } : null;
}
/** What a write without a stamp is reported as. */
const NO_STAMP = Object.freeze({ id: null, own: null });

/**
 * One value every window shows and writes whole (the settings, their scopes, the sidebar's
 * view), stored as `normalize` makes it, with its write's stamp (WRITE_STAMP): app.js
 * storeSync tells the writes apart by it, whatever they hold.
 */
export function createStampedStore(area, changedEvent, key, normalize) {
  return {
    async load() {
      return normalize((await area.get(key))?.[key]);
    },
    /**
     * Stores `value` as the write `id` (a new one when not given), whose window set the leaves
     * at `own` itself (paths: ["glass", "enabled"]; not given: not known, all it changes).
     * Resolves to the value as stored.
     */
    async save(value, { id = newWriteId(), own } = {}) {
      const normalized = normalize(value);
      await area.set({ [key]: { ...normalized, [WRITE_STAMP]: own ? { id, own } : { id } } });
      return normalized;
    },
    /**
     * Calls `listener(value, before, write)` when another window or this one saves (`before`:
     * the value it saved over). `write` is the write's stamp, { id, own, after }: `after` the
     * id of the write it landed on; ids null without a stamp, `own` null when not known.
     * Returns an unsubscribe.
     */
    subscribe(listener) {
      return subscribeKey(changedEvent, key, (value, oldValue) => {
        const old = oldValue();
        listener(normalize(value), normalize(old), { ...(stampOf(value) ?? NO_STAMP), after: stampOf(old)?.id ?? null });
      });
    },
  };
}

/**
 * Shared chrome.storage.onChanged filter for one key in the "local" area: calls
 * `listener(newValue, oldValue)`, `oldValue()` giving what the key held before. That is read
 * only when asked for: the desktop stub parses it then, and the background image is large.
 */
export function subscribeKey(changedEvent, key, listener) {
  if (!changedEvent) return () => {};
  const handler = (changes, areaName) => {
    if (areaName !== "local" || !(key in changes)) return;
    const change = changes[key];
    listener(change.newValue, () => change.oldValue);
  };
  changedEvent.addListener(handler);
  return () => changedEvent.removeListener(handler);
}
