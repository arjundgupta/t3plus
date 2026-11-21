import assert from "node:assert/strict";
import { test } from "node:test";
import { STORAGE_KEYS } from "../src/config.js";
import { createProfiles } from "../src/profiles.js";
import { defaultSettings } from "../src/settings.js";
import { ALL, createScopesStore } from "../src/settingsScopes.js";
import { createApp, createDom, createFakeChromeStorage, settle } from "./helpers.js";

// Settings -> Advanced -> Reset, through the app (the one Reset there is).
const SIDEBAR = `<div data-slot="sidebar-inner"><ul><li data-testid="sidebar-project-folder"><button type="button" data-sidebar-row="folder:p/a"><span class="truncate">A</span></button></li></ul><div data-slot="sidebar-footer"></div></div>`;

async function setup({ base, overrides = {} }) {
  const dom = createDom("/", SIDEBAR);
  const storage = createFakeChromeStorage();
  storage.area.data.set(STORAGE_KEYS.settings, base);
  storage.area.data.set(STORAGE_KEYS.scopes, { version: 1, overrides });
  storage.area.data.set(STORAGE_KEYS.profiles, { active: "main", list: [{ id: "main", name: "Main" }, { id: "work", name: "Work" }], projects: { "p/a": "main" }, adopted: true });
  const profiles = createProfiles({ win: dom.window, doc: dom.window.document, area: storage.area, changedEvent: storage.onChanged });
  const { app } = createApp(dom, storage, { profiles, scopesStore: createScopesStore(storage.area, storage.onChanged) });
  await app.start();
  await settle();
  return { app, storage, stored: () => storage.area.data.get(STORAGE_KEYS.settings), scopes: () => storage.area.data.get(STORAGE_KEYS.scopes).overrides };
}

const d = defaultSettings();
const custom = {
  ...d,
  composerGradient: { ...d.composerGradient, mode: "image", intensity: 90, accent: "#112233", dither: false },
  glass: { enabled: false, strength: 10 },
  sidebar: { ...d.sidebar, bots: false, botStyle: "space", profiles: true, statusColors: true, statusBadges: true, subagentShape: "star", subagentColor: "red" },
  chat: { ...d.chat, bubble: "#334455" },
  home: { widgets: false },
  demo: { enabled: true },
};

test("Reset on All profiles puts the appearance back and keeps every feature, screenshot mode too", async () => {
  const { app, stored } = await setup({ base: custom });
  await app.actions.reset();
  await settle();
  for (const settings of [stored(), app.state.base]) {
    assert.deepEqual(settings.composerGradient, d.composerGradient);
    assert.deepEqual(settings.glass, d.glass);
    for (const group of ["sidebar", "chat", "home", "demo"]) assert.deepEqual(settings[group], custom[group], group);
  }
  assert.equal(app.state.message, "t3+ appearance reset.");
  app.stop();
});

test("Reset on a profile clears only its appearance; the base and the other profiles keep theirs", async () => {
  const overrides = {
    "work|*": { "composerGradient.accent": "#ff0000", "glass.strength": 20, "chat.bubble": "#00ff00", "sidebar.bots": false },
    "main|*": { "composerGradient.mode": "image" },
  };
  const { app, stored, scopes } = await setup({ base: custom, overrides });
  app.actions.setEditScope({ profile: "work", device: ALL });
  await app.actions.reset();
  await settle();
  assert.deepEqual(scopes()["work|*"], { "chat.bubble": "#00ff00", "sidebar.bots": false });
  assert.deepEqual(scopes()["main|*"], overrides["main|*"]);
  assert.deepEqual(stored().composerGradient, custom.composerGradient, "the base untouched");
  assert.equal(app.state.message, "Profile 2 has no appearance of its own now.", "its name covered: screenshot mode is on");

  app.actions.setEditScope({ profile: ALL, device: ALL });
  await app.actions.reset();
  await settle();
  assert.match(app.state.message, /Profiles or machines with an appearance of their own keep it/);
  assert.deepEqual(scopes()["main|*"], overrides["main|*"]);
  app.stop();
});
