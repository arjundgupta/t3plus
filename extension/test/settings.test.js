import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_SETTINGS, STORAGE_KEYS } from "../src/config.js";
import { createSettingsStore, defaultSettings, normalizeSettingValue, normalizeSettings, SETTING_PATHS } from "../src/settings.js";
import { createFakeChromeStorage } from "./helpers.js";

test("normalizeSettings fills defaults for missing or corrupt values", () => {
  assert.deepEqual(normalizeSettings(undefined), defaultSettings());
  assert.deepEqual(normalizeSettings("garbage"), defaultSettings());
  const result = normalizeSettings({
    composerGradient: { enabled: "yes", mode: "spiral", accent: "red", intensity: "loud", imageSource: "web" },
  });
  assert.deepEqual(result.composerGradient, { ...DEFAULT_SETTINGS.composerGradient });
});

test("normalizeSettings keeps valid values and clamps intensity", () => {
  const result = normalizeSettings({
    composerGradient: { enabled: false, mode: "image", accent: "#AABBCC", intensity: 140.4, imageSource: "upload" },
  });
  assert.deepEqual(result.composerGradient, {
    enabled: false,
    mode: "image",
    accent: "#aabbcc",
    intensity: 100,
    imageSource: "upload",
    dither: true,
    ditherSize: "medium",
    ditherStyle: "bayer",
  });
  assert.equal(normalizeSettings({ composerGradient: { dither: false } }).composerGradient.dither, false);
  assert.equal(normalizeSettings({ composerGradient: { dither: "no" } }).composerGradient.dither, true);
  assert.equal(normalizeSettings({ composerGradient: { intensity: -3 } }).composerGradient.intensity, 0);
});

test("settings persist across store instances (a page reload)", async () => {
  const storage = createFakeChromeStorage();
  const first = createSettingsStore(storage.area, storage.onChanged);
  const d = defaultSettings();
  await first.save({ ...d, composerGradient: { ...d.composerGradient, mode: "image", intensity: 80 } });

  const second = createSettingsStore(storage.area, storage.onChanged);
  const loaded = await second.load();
  assert.equal(loaded.composerGradient.mode, "image");
  assert.equal(loaded.composerGradient.intensity, 80);
  assert.equal(loaded.composerGradient.enabled, true, "untouched fields keep their defaults");
  assert.ok(storage.area.data.has(STORAGE_KEYS.settings));
});

test("subscribe reports saves from another tab, until unsubscribed", async () => {
  const storage = createFakeChromeStorage();
  const tabA = createSettingsStore(storage.area, storage.onChanged);
  const tabB = createSettingsStore(storage.area, storage.onChanged);
  const seen = [];
  const unsubscribe = tabB.subscribe((settings) => seen.push(settings.composerGradient.mode));
  const d = defaultSettings();
  const image = { ...d, composerGradient: { ...d.composerGradient, mode: "image" } };

  await tabA.save(image);
  await tabA.save(d);
  unsubscribe();
  await tabA.save(image);

  assert.deepEqual(seen, ["image", "half-circle"]);
  assert.deepEqual(await tabB.load(), image);
});

test("v1 settings (composerGradient only) upgrade with glass and sidebar defaults", () => {
  const v1 = { version: 1, composerGradient: { enabled: true, mode: "image", accent: "#112233", intensity: 40, imageSource: "upload" } };
  const result = normalizeSettings(v1);
  assert.equal(result.version, 2);
  assert.deepEqual(result.composerGradient, { ...v1.composerGradient, dither: true, ditherSize: "medium", ditherStyle: "bayer" });
  assert.deepEqual(result.glass, { enabled: true, strength: 85 });
  assert.deepEqual(result.sidebar, { bots: true, botsDefault: true, botStyle: "classic", profiles: true, statusColors: false, statusBadges: false, subagentShape: "same", subagentColor: "same" });
  assert.deepEqual(normalizeSettings({ glass: { enabled: "no", strength: 400 } }).glass, { enabled: true, strength: 100 });
});

test("chat bubbles: T3's by default; a #rrggbb kept, lowercased; anything else is T3's", () => {
  assert.equal(normalizeSettings({}).chat.bubble, "theme");
  assert.equal(normalizeSettings({ chat: { bubble: "#3B82F6" } }).chat.bubble, "#3b82f6");
  assert.equal(normalizeSettings({ chat: { bubble: "blue" } }).chat.bubble, "theme");
  assert.equal(normalizeSettings({ chat: "x" }).chat.bubble, "theme");
});

test("one rule per setting: the same check for a whole settings object and for a single value", () => {
  const d = defaultSettings();
  // Every setting has a rule, and only settings have one.
  assert.deepEqual(SETTING_PATHS, Object.entries(d).filter(([, v]) => v && typeof v === "object").flatMap(([g, leaves]) => Object.keys(leaves).map((l) => `${g}.${l}`)));
  assert.equal(normalizeSettingValue("composerGradient.accent", "#ABCDEF"), "#abcdef", "normalized");
  assert.equal(normalizeSettingValue("composerGradient.accent", "red"), undefined, "not a value: undefined, not the default");
  assert.equal(normalizeSettingValue("composerGradient.intensity", "70"), 70);
  for (const bad of [null, "", true, "loud", Number.NaN]) assert.equal(normalizeSettingValue("composerGradient.intensity", bad), undefined, String(bad));
  assert.equal(normalizeSettingValue("sidebar.botStyle", "toString"), undefined, "not a style, though an object has it");
  assert.equal(normalizeSettingValue("sidebar.nope", true), undefined);
  assert.equal(normalizeSettingValue("__proto__.x", true), undefined);
  assert.equal(normalizeSettings({ composerGradient: { intensity: null } }).composerGradient.intensity, d.composerGradient.intensity, "null is no intensity");
});

test("Status badges: off by default; only a boolean is one", () => {
  assert.equal(defaultSettings().sidebar.statusBadges, false);
  assert.equal(normalizeSettings({ sidebar: { statusBadges: true } }).sidebar.statusBadges, true);
  for (const bad of ["true", 1, null, {}]) {
    assert.equal(normalizeSettings({ sidebar: { statusBadges: bad } }).sidebar.statusBadges, false, `${JSON.stringify(bad)}: the default`);
    assert.equal(normalizeSettingValue("sidebar.statusBadges", bad), undefined, `${JSON.stringify(bad)}: not a value`);
  }
  assert.equal(normalizeSettingValue("sidebar.statusBadges", false), false);
});

const pick = ({ subagentShape, subagentColor }) => ({ subagentShape, subagentColor });
test("subagents' shape and color: the bot's (same), a shape, or a color a bot can be given", () => {
  assert.deepEqual(pick(normalizeSettings({ sidebar: { subagentShape: "robot", subagentColor: "purple" } }).sidebar), { subagentShape: "robot", subagentColor: "purple" });
  assert.deepEqual(pick(normalizeSettings({ sidebar: { subagentShape: "nope", subagentColor: "nope" } }).sidebar), { subagentShape: "same", subagentColor: "same" });
  assert.equal(normalizeSettingValue("sidebar.subagentColor", "nope"), undefined);
  assert.equal(normalizeSettingValue("sidebar.subagentShape", "drop"), "drop");
  assert.equal(normalizeSettingValue("sidebar.subagentShape", "__proto__"), undefined);
});
