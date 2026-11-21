import assert from "node:assert/strict";
import { after, test } from "node:test";
import { STORAGE_KEYS, T3PLUS } from "../src/config.js";
import { createProfiles } from "../src/profiles.js";
import { LOOK, lookValue } from "../src/composer.js";
import { createScopesStore } from "../src/settingsScopes.js";
import { createApp, createDom, createFakeChromeStorage, settle, T3_APPEARANCE_HTML } from "./helpers.js";

// "Applying t3+ for [All profiles ▾] on [All devices ▾]" in Settings → t3+, and what is
// drawn where: the open profile's and machine's settings.
const windows = [];
after(() => windows.forEach((w) => w.close()));

const SETTINGS_HTML = `
  <div role="tree"><ul data-slot="sidebar-menu" id="nav">
    <li><button type="button" class="nav" data-settings-section="/settings/appearance" data-active="true" role="treeitem"><span>Appearance</span></button></li>
  </ul></div>
  ${T3_APPEARANCE_HTML}
  <div data-slot="sidebar-inner"><ul id="list"><li data-testid="sidebar-project-folder"><button type="button" data-sidebar-row="folder:p/a"><span class="truncate">A</span></button></li></ul><div data-slot="sidebar-footer"></div></div>`;

async function setup() {
  const dom = createDom("/settings/appearance", SETTINGS_HTML);
  windows.push(dom.window);
  dom.window.__t3plusBoot = { environment: { id: "env1", label: "Test Mac", machine: "laptop" } };
  const doc = dom.window.document;
  const storage = createFakeChromeStorage();
  storage.area.data.set(STORAGE_KEYS.profiles, { active: "main", list: [{ id: "main", name: "Main" }, { id: "work", name: "Work", color: "blue" }], projects: { "p/a": "main" }, adopted: true });
  let appRef = null;
  const profiles = createProfiles({
    win: dom.window,
    doc,
    area: storage.area,
    changedEvent: storage.onChanged,
    onShown: (id) => appRef?.profileShown(id),
    onDelete: (id) => appRef?.profileDeleted(id),
  });
  const { app } = createApp(dom, storage, { profiles, scopesStore: createScopesStore(storage.area, storage.onChanged) });
  appRef = app;
  await app.start();
  await settle();
  app.watcher.flush();
  doc.querySelector("[data-t3plus-settings-nav]").click();
  app.watcher.flush();
  const panel = doc.getElementById(T3PLUS.panelId);
  const key = (el, k) => el.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true }));
  return {
    dom, doc, app, storage, profiles, panel, key,
    pick: (label) => panel.querySelector(`.t3plus-scope-pick[aria-label^="${label}"]`),
    row: (title) => [...panel.querySelectorAll(".t3plus-row")].find((r) => r.querySelector(".t3plus-row-title")?.textContent === title),
    scopes: () => storage.area.data.get(STORAGE_KEYS.scopes)?.overrides ?? {},
    base: () => storage.area.data.get(STORAGE_KEYS.settings),
    // On the bubbles (composer.js setLook), not on <html>.
    bubble: () => lookValue(doc, LOOK.bubble, "--t3plus-bubble"),
  };
}

test("the scope bar: pick a profile (keys work), change a setting: it is that profile's; its row says so and resets", async () => {
  const t = await setup();
  const profile = t.pick("Profile");
  const device = t.pick("Device");
  assert.equal(profile.textContent, "All profiles");
  assert.equal(device.textContent, "All devices");
  // Arrow down opens the list on the picked one; down twice is Work; Enter picks it.
  t.key(profile, "ArrowDown");
  const menu = profile.parentElement.querySelector("[role=listbox]");
  assert.equal(menu.hidden, false);
  assert.deepEqual([...menu.querySelectorAll("[role=option]")].map((o) => o.querySelector(".t3plus-scope-option-text").textContent), ["All profiles", "Main", "Work"]);
  assert.equal(menu.querySelector('[data-value="main"] .t3plus-scope-hint').textContent, "Open", "the profile open now is marked");
  t.key(menu, "ArrowDown");
  t.key(menu, "ArrowDown");
  t.key(menu, "Enter");
  assert.equal(menu.hidden, true);
  assert.equal(t.doc.activeElement, profile, "focus back on the picker");
  assert.equal(profile.textContent, "Work");
  assert.match(t.panel.querySelector(".t3plus-scope-own").textContent, /no settings of its own/i);

  // Blue bubbles for Work: Work's own, the base untouched.
  t.panel.querySelector('[aria-label="Chat bubble color"] [aria-label="Blue"]').click();
  await settle();
  assert.deepEqual(t.scopes(), { "work|*": { "chat.bubble": "#3b82f6" } });
  assert.equal(t.app.state.base.chat.bubble, "theme");
  assert.equal(t.base().chat, undefined, "the base was not even written");
  assert.equal(t.bubble(), "#3b82f6", "Settings draws the scope it edits");
  const bubbles = t.row("Chat bubbles");
  assert.equal(bubbles.hasAttribute("data-scope-own"), true);
  assert.equal(bubbles.querySelector(".t3plus-row-scope-text").textContent, "Set for Work.");
  assert.equal(t.panel.querySelector(".t3plus-scope-own").textContent, "1 setting of its own");
  // A shared setting in Work's scope still changes it for everyone.
  assert.match(t.row("Profiles").querySelector(".t3plus-row-scope-text").textContent, /same for all profiles and devices/i);

  // Back to All profiles: the base again, and the row says Work differs.
  t.app.actions.setEditScope({ profile: "*", device: "*" });
  assert.equal(t.bubble(), "", "T3's bubbles for all profiles");
  assert.equal(bubbles.querySelector(".t3plus-row-scope-text").textContent, "Work has its own value.");
  assert.equal(bubbles.hasAttribute("data-scope-own"), false);
  // "Use for all": Work follows All profiles for it again.
  const useAll = bubbles.querySelector(".t3plus-row-use-all");
  assert.equal(useAll.hidden, false);
  useAll.click();
  await settle();
  assert.deepEqual(t.scopes(), {});
  assert.equal(useAll.hidden, true);
  t.app.actions.setEditScope({ profile: "work", device: "*" });
  t.panel.querySelector('[aria-label="Chat bubble color"] [aria-label="Blue"]').click();
  await settle();
  t.app.actions.setEditScope({ profile: "*", device: "*" });

  // Its reset clears Work's own.
  t.app.actions.setEditScope({ profile: "work", device: "*" });
  const reset = bubbles.querySelector(".t3plus-row-reset");
  assert.equal(reset.hidden, false);
  assert.equal(reset.getAttribute("aria-label"), "Clear Work's own chat bubbles");
  reset.click();
  await settle();
  assert.deepEqual(t.scopes(), {});
  assert.equal(reset.hidden, true);
  t.app.stop();
  t.profiles.stop();
});

test("what is drawn outside Settings: the open profile's settings over the base, the open machine's too", async () => {
  const t = await setup();
  t.app.actions.setEditScope({ profile: "work", device: "*" });
  t.panel.querySelector('[aria-label="Chat bubble color"] [aria-label="Red"]').click();
  // A machine's own: glass for every profile on Test Mac.
  t.app.actions.setEditScope({ profile: "*", device: "env1" });
  assert.equal(t.pick("Device").textContent, "Test Mac");
  t.app.actions.setGlass(false);
  await settle();
  assert.deepEqual(t.scopes(), { "work|*": { "chat.bubble": "#ef4444" }, "*|env1": { "glass.enabled": false } });
  // Leave Settings for a thread on Test Mac, Main open.
  t.dom.window.history.pushState({}, "", "/env1/a1");
  t.app.watcher.flush();
  assert.equal(t.bubble(), "", "Main: the base's bubbles");
  assert.equal(t.app.state.settings.glass.enabled, false, "Test Mac's glass");
  t.profiles.switchTo("work", 0, { open: false });
  t.app.watcher.flush();
  assert.equal(t.bubble(), "#ef4444", "Work's");
  // A thread on another machine: Test Mac's own no longer applies.
  t.dom.window.history.pushState({}, "", "/env9/b1");
  t.app.watcher.flush();
  assert.equal(t.app.state.settings.glass.enabled, true);
  assert.equal(t.bubble(), "#ef4444", "the profile's still does");
  t.app.stop();
  t.profiles.stop();
});

test("a profile's glow and bubbles from its dot's editor are its settings; deleting it drops them", async () => {
  const t = await setup();
  t.app.setScopedValue("work", "composerGradient.accent", "#ec4899");
  await settle();
  assert.equal(t.app.scopedValue("work", "composerGradient.accent"), "#ec4899");
  assert.deepEqual(t.scopes(), { "work|*": { "composerGradient.accent": "#ec4899" } });
  t.app.setScopedValue("work", "composerGradient.accent", null);
  await settle();
  assert.deepEqual(t.scopes(), {});
  t.app.setScopedValue("work", "chat.bubble", "#3b82f6");
  t.app.actions.setEditScope({ profile: "work", device: "*" });
  t.app.profileDeleted("work");
  await settle();
  assert.deepEqual(t.scopes(), {}, "its settings went with it");
  assert.equal(t.pick("Profile").textContent, "All profiles", "Settings no longer edits it");
  // Profiles off while Settings edits one: All, as the bar shows.
  t.app.actions.setEditScope({ profile: "main", device: "*" });
  t.app.actions.setSidebarFeature("profiles", false);
  assert.deepEqual(t.app.state.editScope, { profile: "*", device: "*" });
  t.app.actions.setSidebarFeature("profiles", true);
  // Settings asks for one that is not there: All.
  t.app.actions.setEditScope({ profile: "nope", device: "nowhere" });
  assert.deepEqual(t.app.state.editScope, { profile: "*", device: "*" });
  t.app.stop();
  t.profiles.stop();
});

test("Use for all: who keeps their own (the one deciding what is open marked), in the right words; only for All profiles", async () => {
  const t = await setup();
  t.dom.window.history.pushState({}, "", "/settings/appearance");
  // Glass set by Work, by Test Mac (machine of the open thread), and by Work on Test Mac.
  for (const [scope, on] of [[{ profile: "work", device: "*" }, false], [{ profile: "*", device: "env1" }, false], [{ profile: "main", device: "env1" }, true]]) {
    t.app.actions.setEditScope(scope);
    t.app.actions.setGlass(on);
  }
  await settle();
  t.app.actions.setEditScope({ profile: "*", device: "*" });
  const glass = t.row("Glass");
  assert.equal(glass.querySelector(".t3plus-row-scope-text").textContent, "Main on Test Mac (open), All profiles on Test Mac and Work have their own values.", "the deciding scope first and marked, the other one that applies next");
  const useAll = glass.querySelector(".t3plus-row-use-all");
  assert.equal(useAll.getAttribute("aria-label"), "Use for all: Glass, for every profile and device", "its words first, whatever the title's number");
  assert.equal(t.row("Profiles").querySelector(".t3plus-row-use-all"), null, "a shared row has none");
  t.app.actions.setEditScope({ profile: "work", device: "*" });
  assert.equal(useAll.hidden, true, "not in a profile's scope");
  // Profiles off: a profile's scope applies nowhere and is not named.
  t.app.actions.setEditScope({ profile: "*", device: "*" });
  t.app.actions.setSidebarFeature("profiles", false);
  await settle();
  assert.equal(glass.querySelector(".t3plus-row-scope-text").textContent, "All profiles on Test Mac (open) has its own value.");
  t.app.actions.setSidebarFeature("profiles", true);
  useAll.click();
  await settle();
  assert.deepEqual(t.scopes(), {}, "every scope's own glass gone");
  t.app.stop();
  t.profiles.stop();
});

test("Settings → Subagents: the bot's own to start; a shape and a color of their own (no Status colors' own), per profile too", async () => {
  const t = await setup();
  const shape = t.pick("Subagent shape");
  const color = t.pick("Subagent color");
  // Each in words of its own: two "Same as bot" buttons side by side read the same.
  assert.equal(shape.textContent, "Bot's shape");
  assert.equal(color.textContent, "Bot's color");
  shape.click();
  const shapes = [...shape.parentElement.querySelectorAll("[role=option]")];
  assert.equal(shapes[0].dataset.value, "same");
  assert.equal(shapes.length, 1 + Object.keys((await import("../src/config.js")).BOT_SHAPES).length, "every shape, once");
  assert.equal(shape.parentElement.querySelector('[data-value="drop"] .t3plus-scope-hint').textContent, "Blobs", "its set as the hint");
  assert.ok(shape.parentElement.querySelector('[data-value="drop"] .t3plus-face-icon').style.getPropertyValue("--t3plus-bot-fill").startsWith('url("data:'), "the face itself");
  shape.parentElement.querySelector('[data-value="robot"]').click();
  await settle();
  assert.equal(t.base().sidebar.subagentShape, "robot");
  assert.equal(shape.textContent, "Robot");
  color.click();
  const colors = [...color.parentElement.querySelectorAll("[role=option]")].map((o) => o.dataset.value);
  assert.equal(colors[0], "same");
  color.parentElement.querySelector('[data-value="purple"]').click();
  await settle();
  assert.equal(t.base().sidebar.subagentColor, "purple");
  // Work's own: same as its bots.
  t.app.actions.setEditScope({ profile: "work", device: "*" });
  t.pick("Subagent shape").click();
  t.pick("Subagent shape").parentElement.querySelector('[data-value="same"]').click();
  await settle();
  assert.deepEqual(t.scopes(), { "work|*": { "sidebar.subagentShape": "same" } });
  assert.equal(t.row("Subagents").querySelector(".t3plus-row-scope-text").textContent, "Set for Work.");
  // The live preview is T3's list: its bots keep their own colors with Status colors on
  // (they paint the Status view only): the idle one its purple, not the Status view's blue.
  const { resolveBotPresentation } = await import("../src/bots.js");
  const previewFaces = () => [...t.panel.querySelectorAll(".t3plus-preview-avatar")].map((a) => a.style.getPropertyValue("--t3plus-bot-fill"));
  const before = previewFaces();
  t.app.actions.setSidebarFeature("statusColors", true);
  const after = previewFaces();
  assert.deepEqual(after, before);
  assert.equal(after[1], resolveBotPresentation({ key: "sample:inbox", titleLabel: "Inbox triage", status: "idle" }, { shape: "hexagon", color: "purple" }).fill);
  t.app.stop();
  t.profiles.stop();
});

test("Settings → Status badges: off to start, a switch of its own per profile; drawn where that profile is open", async () => {
  const t = await setup();
  const toggle = () => t.panel.querySelector('[role="switch"][aria-label="Status badges"]');
  const row = t.row("Status badges");
  assert.ok(row.contains(toggle()), "its switch, in its own row");
  assert.match(row.querySelector(".t3plus-row-desc").textContent, /tile.*status/, "a tile that shows the status");
  const previewBadges = () => [...t.panel.querySelectorAll(".t3plus-preview-avatar")].map((a) => a.querySelector(".t3plus-bot-badge") !== null);
  assert.equal(toggle().getAttribute("aria-checked"), "false");
  assert.deepEqual(previewBadges(), [false, false], "the preview's faces have none");

  // On for Work only.
  t.app.actions.setEditScope({ profile: "work", device: "*" });
  toggle().click();
  await settle();
  assert.deepEqual(t.scopes(), { "work|*": { "sidebar.statusBadges": true } });
  assert.equal(t.base().sidebar?.statusBadges, undefined, "the base untouched");
  assert.equal(toggle().getAttribute("aria-checked"), "true");
  assert.equal(row.querySelector(".t3plus-row-scope-text").textContent, "Set for Work.");
  assert.deepEqual(previewBadges(), [true, true], "the preview draws the scope it edits");
  t.app.actions.setEditScope({ profile: "*", device: "*" });
  assert.equal(toggle().getAttribute("aria-checked"), "false", "All profiles: still off");
  assert.deepEqual(previewBadges(), [false, false]);

  // Outside Settings: Main open, then Work.
  t.dom.window.history.pushState({}, "", "/env1/a1");
  t.app.watcher.flush();
  assert.equal(t.app.state.settings.sidebar.statusBadges, false, "Main: the base's");
  t.profiles.switchTo("work", 0, { open: false });
  t.app.watcher.flush();
  assert.equal(t.app.state.settings.sidebar.statusBadges, true, "Work's own");
  t.app.stop();
  t.profiles.stop();
});

test("Settings' previews show the scope edited: Work's own Status colors and Look in Work, the base's in All profiles", async () => {
  const t = await setup();
  const statusFaces = () => [...t.row("Status colors").querySelectorAll(".t3plus-status-sample .t3plus-bot-swatch")].map((f) => f.style.getPropertyValue("--t3plus-bot-fill"));
  const bayerMask = () => t.row("Look").querySelector('.t3plus-glow-swatch[data-look="bayer"]').style.getPropertyValue("--t3plus-swatch-mask");
  const { ditherSwatchMask } = await import("../src/settingsPreviews.js");
  const off = statusFaces();
  const baseMask = bayerMask();
  t.app.actions.setEditScope({ profile: "work", device: "*" });
  t.app.actions.setSidebarFeature("statusColors", true);
  t.app.actions.setDitherSize("large");
  await settle();
  assert.notDeepEqual(statusFaces(), off, "Work's bots wear their status");
  assert.equal(bayerMask(), ditherSwatchMask("bayer", "large"), "at Work's pixel size");
  t.app.actions.setEditScope({ profile: "*", device: "*" });
  assert.deepEqual(statusFaces(), off, "All profiles: still off");
  assert.equal(bayerMask(), baseMask);
  t.app.stop();
  t.profiles.stop();
});
