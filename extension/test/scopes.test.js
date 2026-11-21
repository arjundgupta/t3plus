import assert from "node:assert/strict";
import { test } from "node:test";
import { STORAGE_KEYS } from "../src/config.js";
import { profileHex } from "../src/profiles.js";
import { defaultSettings } from "../src/settings.js";
import {
  ALL,
  applyEdit,
  clearScopeValues,
  createScopesStore,
  emptyScopes,
  inheritedSettings,
  layersOf,
  liftProfileColors,
  migrateProfileColors,
  normalizeScopes,
  parseScopeKey,
  resolveSettings,
  scopeKey,
  scopesSetting,
  scopeValues,
  setScopeValues,
  SCOPED_PATHS,
} from "../src/settingsScopes.js";
import { createFakeChromeStorage } from "./helpers.js";

// Settings per profile and per machine: "Applying t3+ for [profile] on [machine]".
const ENV = "00000000-1111-4222-8333-444444444444";
const scoped = (overrides) => normalizeScopes({ version: 1, overrides });

test("the narrower scope wins: base < All profiles on a machine < a profile < a profile on a machine", () => {
  const base = defaultSettings();
  const scopes = scoped({
    [`*|${ENV}`]: { "composerGradient.accent": "#111111", "glass.strength": 40 },
    "work|*": { "composerGradient.accent": "#222222", "sidebar.bots": false },
    [`work|${ENV}`]: { "composerGradient.accent": "#333333" },
  });
  assert.deepEqual(layersOf({ profile: "work", device: ENV }), [`*|${ENV}`, "work|*", `work|${ENV}`]);
  assert.equal(resolveSettings(base, scopes, { profile: ALL, device: ALL }), base, "the base itself when nothing applies (no copy)");
  assert.equal(resolveSettings(base, scopes, { profile: "main", device: "other-machine" }), base, "nor for others");
  const onMachine = resolveSettings(base, scopes, { profile: ALL, device: ENV });
  assert.equal(onMachine.composerGradient.accent, "#111111");
  assert.equal(onMachine.glass.strength, 40);
  const work = resolveSettings(base, scopes, { profile: "work", device: ALL });
  assert.equal(work.composerGradient.accent, "#222222");
  assert.equal(work.sidebar.bots, false);
  assert.equal(work.glass, base.glass, "groups nobody changed are shared, not copied");
  const both = resolveSettings(base, scopes, { profile: "work", device: ENV });
  assert.deepEqual([both.composerGradient.accent, both.glass.strength, both.sidebar.bots], ["#333333", 40, false], "each value from the narrowest scope that sets it");
  assert.equal(base.composerGradient.accent, "theme", "the base is never changed");
});

test("stored scopes are checked like settings: bad scopes, settings, values and the base itself are dropped", () => {
  const n = normalizeScopes({
    version: 1,
    overrides: {
      "*|*": { "composerGradient.accent": "#123456" }, // the base is the settings themselves
      "work|*": { "composerGradient.accent": "#ABCDEF", "composerGradient.intensity": "loud", "sidebar.profiles": false, "demo.enabled": true, "nope.x": 1, __proto__: { x: 1 } },
      "bad key": { "chat.bubble": "#000000" },
      "a|b|c": { "chat.bubble": "#000000" },
      "empty|*": { "chat.bubble": "red" },
      [`*|${ENV}`]: { "glass.strength": "70" },
      "x|*": [],
    },
  });
  assert.deepEqual(n, { version: 1, overrides: { "work|*": { "composerGradient.accent": "#abcdef" }, [`*|${ENV}`]: { "glass.strength": 70 } } });
  assert.equal(SCOPED_PATHS.includes("sidebar.profiles"), false, "profiles on or off: the same everywhere");
  assert.equal(SCOPED_PATHS.includes("demo.enabled"), false, "screenshot mode too (a profile switch must not show real names)");
  for (const bad of [null, 3, "x", { overrides: [] }]) assert.deepEqual(normalizeScopes(bad), emptyScopes());
  assert.deepEqual(parseScopeKey("work|*"), { profile: "work", device: "*" });
  assert.equal(parseScopeKey("work"), null);
  assert.equal(scopeKey({ profile: "work" }), "work|*");
  // A bound on a damaged value.
  const many = normalizeScopes({ overrides: Object.fromEntries(Array.from({ length: 500 }, (_, i) => [`p${i}|*`, { "chat.bubble": "#000000" }])) });
  assert.ok(Object.keys(many.overrides).length <= 120);
});

test("a value set to what the scope would show anyway is not kept (it keeps following the wider one)", () => {
  const base = { ...defaultSettings(), composerGradient: { ...defaultSettings().composerGradient, accent: "#00ff00" } };
  let scopes = emptyScopes();
  const work = { profile: "work", device: ALL };
  scopes = setScopeValues(base, scopes, work, { "composerGradient.accent": "#ff0000", "chat.bubble": "#3B82F6" });
  assert.deepEqual(scopeValues(scopes, work), { "composerGradient.accent": "#ff0000", "chat.bubble": "#3b82f6" });
  scopes = setScopeValues(base, scopes, work, { "composerGradient.accent": "#00ff00" });
  assert.deepEqual(scopeValues(scopes, work), { "chat.bubble": "#3b82f6" }, "the base's value: dropped");
  scopes = setScopeValues(base, scopes, work, { "chat.bubble": "nope", "sidebar.profiles": false });
  assert.deepEqual(scopeValues(scopes, work), { "chat.bubble": "#3b82f6" }, "a bad value and a shared setting change nothing");
  scopes = setScopeValues(base, scopes, work, { "chat.bubble": "theme" });
  assert.deepEqual(scopes.overrides, {}, "an empty scope is not kept");
  assert.throws(() => setScopeValues(base, scopes, { profile: ALL, device: ALL }, { "chat.bubble": "#000000" }));
  // Inherited from a wider scope, not only the base.
  scopes = setScopeValues(base, emptyScopes(), { profile: ALL, device: ENV }, { "glass.strength": 30 });
  const both = { profile: "work", device: ENV };
  assert.equal(inheritedSettings(base, scopes, both).glass.strength, 30);
  assert.deepEqual(scopeValues(setScopeValues(base, scopes, both, { "glass.strength": 30 }), both), {}, "the machine's value already");
});

test("an edit in the scope Settings edits: its values go to the scope, shared ones to the base", () => {
  const base = defaultSettings();
  const scopes = emptyScopes();
  const work = { profile: "work", device: ALL };
  // At All profiles on All devices: the base itself.
  const atBase = applyEdit({ base, scopes }, { profile: ALL, device: ALL }, (s) => ({ ...s, chat: { bubble: "#3b82f6" } }));
  assert.equal(atBase.base.chat.bubble, "#3b82f6");
  assert.equal(atBase.scopes, scopes);
  // In Work: Work's own; profiles off is the same everywhere, so the base's.
  const inWork = applyEdit({ base, scopes }, work, (s) => ({ ...s, chat: { bubble: "#ef4444" }, sidebar: { ...s.sidebar, profiles: false } }));
  assert.equal(inWork.base.chat.bubble, "theme", "the base keeps its bubbles");
  assert.equal(inWork.base.sidebar.profiles, false, "but profiles are off for all");
  assert.deepEqual(scopeValues(inWork.scopes, work), { "chat.bubble": "#ef4444" });
  // Nothing changed: the same objects (nothing to save).
  const same = applyEdit(inWork, work, (s) => s);
  assert.equal(same.base, inWork.base);
  assert.equal(same.scopes, inWork.scopes);
});

test("clearing: some values of a scope, or all of it; where a value is set", () => {
  const scopes = scoped({ "work|*": { "chat.bubble": "#000000", "glass.strength": 10 }, "home|*": { "chat.bubble": "#ffffff" } });
  const work = { profile: "work", device: ALL };
  assert.deepEqual(scopeValues(clearScopeValues(scopes, work, ["chat.bubble"]), work), { "glass.strength": 10 });
  assert.equal(clearScopeValues(scopes, work).overrides["work|*"], undefined);
  assert.equal(clearScopeValues(scopes, { profile: "gone", device: ALL }), scopes, "nothing to clear: the same object");
  assert.equal(clearScopeValues(scopes, work, ["home.widgets"]), scopes);
  assert.deepEqual(scopesSetting(scopes, "chat.bubble"), ["work|*", "home|*"]);
});

test("profiles' old glow and bubble colors become their settings, once, in storage and in a backup", async () => {
  const profiles = { active: "main", list: [{ id: "main", name: "Main", dither: "default", bubble: "default" }, { id: "work", name: "Work", color: "blue", dither: "pink", bubble: "#123456" }], projects: {} };
  const lifted = liftProfileColors(profiles, null, profileHex);
  assert.deepEqual(lifted.profiles.list, [{ id: "main", name: "Main" }, { id: "work", name: "Work", color: "blue" }]);
  assert.deepEqual(lifted.scopes.overrides, { "work|*": { "composerGradient.accent": "#ec4899", "chat.bubble": "#123456" } }, "presets as colors; defaults are no value");
  assert.equal(liftProfileColors(lifted.profiles, lifted.scopes, profileHex), null, "nothing left to move");
  // A value the scope sets already stays.
  const kept = liftProfileColors(profiles, { overrides: { "work|*": { "chat.bubble": "#ffffff" } } }, profileHex);
  assert.equal(kept.scopes.overrides["work|*"]["chat.bubble"], "#ffffff");

  const storage = createFakeChromeStorage();
  storage.area.data.set(STORAGE_KEYS.profiles, profiles);
  assert.equal(await migrateProfileColors(storage.area, profileHex), true);
  assert.deepEqual(storage.area.data.get(STORAGE_KEYS.scopes).overrides["work|*"], { "composerGradient.accent": "#ec4899", "chat.bubble": "#123456" });
  assert.equal("dither" in storage.area.data.get(STORAGE_KEYS.profiles).list[1], false);
  assert.equal(await migrateProfileColors(storage.area, profileHex), false, "once");
});

test("the store: loads normalized, saves normalized, hears other windows", async () => {
  const storage = createFakeChromeStorage();
  const store = createScopesStore(storage.area, storage.onChanged);
  assert.deepEqual(await store.load(), emptyScopes());
  const heard = [];
  const stop = store.subscribe((next) => heard.push(next));
  await store.save({ overrides: { "work|*": { "chat.bubble": "#ABCDEF", "bad": 1 } } });
  assert.deepEqual(await store.load(), { version: 1, overrides: { "work|*": { "chat.bubble": "#abcdef" } } });
  assert.deepEqual(heard.at(-1), { version: 1, overrides: { "work|*": { "chat.bubble": "#abcdef" } } });
  stop();
});
