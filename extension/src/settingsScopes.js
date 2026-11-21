// Settings per profile and per machine: "Applying t3+ for [All profiles ▾] on [All devices ▾]".
//
// The stored settings (STORAGE_KEYS.settings) are the base: All profiles on All devices.
// A scope sets single values ("group.name" paths, settings.js SETTING_PATHS) for one
// profile, one machine (a T3 environment: this Mac, a server T3 connects to), or one
// profile on one machine. What is drawn is the base with the open context's scopes over
// it, the narrower winning:
//   base < All profiles on <machine> < <profile> on All devices < <profile> on <machine>
// A value set to what the scope would show anyway is not kept, so the scope keeps
// following the wider ones for it. Turning profiles on or off, and screenshot mode, are
// the same everywhere (UNSCOPED_PATHS).
//
// Stored (STORAGE_KEYS.scopes): { version: 1, overrides: { "<profile>|<machine>": { "<path>": value } } },
// "*" meaning All. Everything here is pure, except the store and the migration at the end.

import { STORAGE_KEYS } from "./config.js";
import { createStampedStore, normalizeSettingValue, normalizeSettings, SETTING_PATHS } from "./settings.js";

export const ALL = "*";
/** Settings that are the same in every profile and on every machine. */
export const UNSCOPED_PATHS = Object.freeze(["sidebar.profiles", "demo.enabled"]);
/** Settings a profile or a machine can have its own value for. */
export const SCOPED_PATHS = Object.freeze(SETTING_PATHS.filter((path) => !UNSCOPED_PATHS.includes(path)));
const SCOPED = new Set(SCOPED_PATHS);
// Profile ids (profiles.js) and T3 environment ids (UUIDs).
const SCOPE_ID = /^[A-Za-z0-9_-]{1,64}$/;
// Far more than anyone sets (nine profiles, a few machines): a bound on a damaged value.
const MAX_SCOPES = 120;

export const BASE_SCOPE = Object.freeze({ profile: ALL, device: ALL });
export const isBaseScope = (scope) => (scope?.profile ?? ALL) === ALL && (scope?.device ?? ALL) === ALL;

/** "<profile>|<machine>" for a scope ({ profile, device }, ALL for All). */
export function scopeKey(scope) {
  return `${scope?.profile ?? ALL}|${scope?.device ?? ALL}`;
}

/** The scope a key names, or null for anything else. */
export function parseScopeKey(key) {
  if (typeof key !== "string") return null;
  const parts = key.split("|");
  if (parts.length !== 2) return null;
  const [profile, device] = parts;
  const valid = (id) => id === ALL || SCOPE_ID.test(id);
  return valid(profile) && valid(device) ? { profile, device } : null;
}

export const emptyScopes = () => ({ version: 1, overrides: {} });

/**
 * A complete, valid scopes value from anything read out of storage (or a backup):
 * unknown scopes and settings, the base itself, settings that are the same
 * everywhere, and values that are not valid are dropped; empty scopes too.
 */
export function normalizeScopes(raw) {
  const source = raw && typeof raw === "object" && raw.overrides && typeof raw.overrides === "object" && !Array.isArray(raw.overrides) ? raw.overrides : {};
  const overrides = {};
  let count = 0;
  for (const [key, values] of Object.entries(source)) {
    if (count >= MAX_SCOPES) break;
    const scope = parseScopeKey(key);
    if (!scope || isBaseScope(scope) || !values || typeof values !== "object" || Array.isArray(values)) continue;
    const kept = {};
    for (const [path, value] of Object.entries(values)) {
      if (!SCOPED.has(path)) continue;
      const normalized = normalizeSettingValue(path, value);
      if (normalized !== undefined) kept[path] = normalized;
    }
    if (Object.keys(kept).length === 0) continue;
    overrides[scopeKey(scope)] = kept;
    count += 1;
  }
  return { version: 1, overrides };
}

/** The scopes that apply in `scope`, widest first (the base is under all of them). */
export function layersOf(scope) {
  const profile = scope?.profile ?? ALL;
  const device = scope?.device ?? ALL;
  const keys = [];
  if (device !== ALL) keys.push(scopeKey({ profile: ALL, device }));
  if (profile !== ALL) keys.push(scopeKey({ profile, device: ALL }));
  if (profile !== ALL && device !== ALL) keys.push(scopeKey({ profile, device }));
  return keys;
}

const valueAt = (settings, path) => {
  const [group, leaf] = path.split(".");
  return settings[group]?.[leaf];
};

/** `settings` with `values` ({ path: value }) set, copying only the groups that change. */
function withValues(settings, values) {
  let result = settings;
  for (const [path, value] of Object.entries(values)) {
    const [group, leaf] = path.split(".");
    if (Object.is(result[group]?.[leaf], value)) continue;
    if (result === settings) result = { ...settings };
    if (result[group] === settings[group]) result[group] = { ...settings[group] };
    result[group][leaf] = value;
  }
  return result;
}

function resolveLayers(base, scopes, keys) {
  let result = base;
  for (const key of keys) {
    const values = scopes?.overrides?.[key];
    if (values) result = withValues(result, values);
  }
  return result;
}

/**
 * The settings in `scope` (a profile and a machine, ALL for any): the base with the
 * scopes that apply over it. The base itself (the same object) when none changes it.
 */
export function resolveSettings(base, scopes, scope) {
  return resolveLayers(base, scopes, layersOf(scope));
}

/** What `scope` would show without its own values: the base and the wider scopes. */
export function inheritedSettings(base, scopes, scope) {
  const own = scopeKey(scope);
  return resolveLayers(base, scopes, layersOf(scope).filter((key) => key !== own));
}

/** The values `scope` sets itself: { path: value } (empty for the base, which is the settings). */
export function scopeValues(scopes, scope) {
  return scopes?.overrides?.[scopeKey(scope)] ?? {};
}

/** The scopes (their keys) that set `path` themselves. */
export function scopesSetting(scopes, path) {
  return Object.entries(scopes?.overrides ?? {})
    .filter(([, values]) => Object.hasOwn(values, path))
    .map(([key]) => key);
}

function withScope(scopes, key, values) {
  const overrides = { ...scopes.overrides };
  if (Object.keys(values).length) overrides[key] = values;
  else delete overrides[key];
  return { version: 1, overrides };
}

/** Whether two scopes' own values are the same ({ path: value }). */
function sameValues(a, b) {
  const paths = Object.keys(a);
  return paths.length === Object.keys(b).length && paths.every((path) => Object.hasOwn(b, path) && Object.is(a[path], b[path]));
}

/**
 * `scopes` with `changes` ({ path: value }) set in `scope` (not the base). A value
 * equal to what the scope would show anyway is removed instead of kept. Settings that
 * are the same everywhere, and values that are not valid, are left out. Nothing new
 * (a swatch picked again): `scopes` itself, so nothing is drawn or saved again.
 */
export function setScopeValues(base, scopes, scope, changes) {
  if (isBaseScope(scope)) throw new Error("the base scope's values are the settings themselves");
  const key = scopeKey(scope);
  const inherited = inheritedSettings(base, scopes, scope);
  const own = scopeValues(scopes, scope);
  const values = { ...own };
  for (const [path, raw] of Object.entries(changes)) {
    if (!SCOPED.has(path)) continue;
    const value = normalizeSettingValue(path, raw);
    if (value === undefined) continue;
    if (Object.is(value, valueAt(inherited, path))) delete values[path];
    else values[path] = value;
  }
  return sameValues(values, own) ? scopes : withScope(scopes, key, values);
}

/** `scopes` without `paths` in `scope` (all of its values when `paths` is omitted). */
export function clearScopeValues(scopes, scope, paths = null) {
  const key = scopeKey(scope);
  const own = scopes?.overrides?.[key];
  if (!own) return scopes;
  const values = paths ? Object.fromEntries(Object.entries(own).filter(([path]) => !paths.includes(path))) : {};
  return Object.keys(values).length === Object.keys(own).length ? scopes : withScope(scopes, key, values);
}

/** The settings whose values differ between two settings objects: { path: value in `after` }. */
export function changedValues(before, after) {
  const changes = {};
  for (const path of SETTING_PATHS) {
    const value = valueAt(after, path);
    if (!Object.is(valueAt(before, path), value)) changes[path] = value;
  }
  return changes;
}

/**
 * An edit made while `scope` is the one being edited (the Settings scope bar):
 * `update` turns the settings as they show there into new ones. Values that can
 * differ go to the scope (the base itself for All profiles on All devices), the
 * others to the base. Returns { base, scopes }, the same objects when nothing changed.
 */
export function applyEdit({ base, scopes }, scope, update) {
  const before = resolveSettings(base, scopes, scope);
  const changes = changedValues(before, normalizeSettings(update(before)));
  if (Object.keys(changes).length === 0) return { base, scopes };
  if (isBaseScope(scope)) return { base: withValues(base, changes), scopes };
  const scoped = {};
  const shared = {};
  for (const [path, value] of Object.entries(changes)) (SCOPED.has(path) ? scoped : shared)[path] = value;
  const nextBase = withValues(base, shared);
  return { base: nextBase, scopes: Object.keys(scoped).length ? setScopeValues(nextBase, scopes, scope, scoped) : scopes };
}

export function createScopesStore(area, changedEvent) {
  return createStampedStore(area, changedEvent, STORAGE_KEYS.scopes, normalizeScopes);
}

// ---------- From profiles' own colors ----------
// Profiles once kept a glow ("dither") and a chat bubble color of their own. Those are
// now the profile's scope on All devices (its glow color and chat bubbles), set in
// Settings with the scope bar like any other value.

/**
 * Moves the old colors out of a raw profiles value into a raw scopes value (stored
 * ones, or a backup's). `toHex` turns a stored color (a preset name or "#rrggbb") into
 * "#rrggbb", or null for the default. A value the scope already sets stays. Returns
 * null when there is nothing to move.
 */
export function liftProfileColors(rawProfiles, rawScopes, toHex) {
  const list = Array.isArray(rawProfiles?.list) ? rawProfiles.list : [];
  const hasOld = (p) => p && typeof p === "object" && (Object.hasOwn(p, "dither") || Object.hasOwn(p, "bubble"));
  if (!list.some(hasOld)) return null;
  let scopes = normalizeScopes(rawScopes);
  const nextList = list.map((p) => {
    if (!hasOld(p)) return p;
    const { dither, bubble, ...rest } = p;
    const scope = typeof p.id === "string" ? parseScopeKey(`${p.id}|${ALL}`) : null;
    if (scope) {
      const own = scopeValues(scopes, scope);
      const values = {};
      const glow = toHex(dither);
      const chat = toHex(bubble);
      if (glow && !Object.hasOwn(own, "composerGradient.accent")) values["composerGradient.accent"] = glow;
      if (chat && !Object.hasOwn(own, "chat.bubble")) values["chat.bubble"] = chat;
      if (Object.keys(values).length) scopes = withScope(scopes, scopeKey(scope), { ...own, ...values });
    }
    return rest;
  });
  return { profiles: { ...rawProfiles, list: nextList }, scopes: normalizeScopes(scopes) };
}

/**
 * The stored profiles' old colors moved into the stored scopes, once (both written together).
 * `stored`: the profiles and scopes already read (backup.js readSynced), so start-up reads
 * them once; read here when not given.
 */
export async function migrateProfileColors(area, toHex, stored = null) {
  stored ??= await area.get([STORAGE_KEYS.profiles, STORAGE_KEYS.scopes]);
  const lifted = liftProfileColors(stored?.[STORAGE_KEYS.profiles], stored?.[STORAGE_KEYS.scopes], toHex);
  if (!lifted) return false;
  await area.set({ [STORAGE_KEYS.profiles]: lifted.profiles, [STORAGE_KEYS.scopes]: lifted.scopes });
  return true;
}
