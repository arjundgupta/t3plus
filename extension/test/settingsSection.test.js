import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { STORAGE_KEYS, T3PLUS } from "../src/config.js";
import { createSettingsNavItem } from "../src/settingsSection.js";
import { createApp, createDom, createFakeChromeStorage, settle, T3_APPEARANCE_HTML } from "./helpers.js";

// T3's Settings sidebar, as on app.t3.codes (ui/sidebar.tsx menu items).
const navItem = (path, label, active = false) => `
  <li data-slot="sidebar-menu-item" class="group/menu-item relative">
    <button type="button" class="peer/menu-button flex h-8 data-[active=true]:font-medium" data-slot="sidebar-menu-button"
      data-settings-section="${path}" data-active="${active}" role="treeitem"><svg></svg><span>${label}</span></button>
  </li>`;
const SETTINGS_HTML = `
  <div role="tree" aria-label="Settings sections"><ul data-slot="sidebar-menu" id="nav">
    ${navItem("/settings/general", "General")}
    ${navItem("/settings/appearance", "Appearance", true)}
    ${navItem("/settings/chat", "Chat")}
  </ul></div>
  ${T3_APPEARANCE_HTML}`;

const click = (dom, el) => el.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
const navButton = (doc) => doc.querySelector("[data-t3plus-settings-nav]");

test("t3+ has its own Settings entry after Appearance and opens as its own section", async () => {
  const dom = createDom("/settings/appearance", SETTINGS_HTML);
  const doc = dom.window.document;
  const { app } = createApp(dom);
  await app.start();

  const button = navButton(doc);
  assert.ok(button, "nav entry inserted");
  assert.equal(button.textContent, "t3+");
  const items = [...doc.querySelectorAll("#nav > li")];
  assert.equal(items.indexOf(button.closest("li")), 2, "right after Appearance");
  assert.equal(button.className, doc.querySelector('[data-settings-section="/settings/appearance"]').className, "copies T3's classes");
  assert.equal(doc.getElementById(T3PLUS.panelId), null, "panel waits for the entry");

  click(dom, button);
  const panel = doc.getElementById(T3PLUS.panelId);
  assert.ok(panel, "panel shown");
  assert.equal(panel.parentElement.id, "page-container");
  assert.ok(doc.documentElement.hasAttribute(T3PLUS.settingsAttr));
  assert.equal(button.getAttribute("data-active"), "true");

  // A T3 settings link closes t3+ (T3 then navigates as usual).
  click(dom, doc.querySelector('[data-settings-section="/settings/chat"]'));
  assert.equal(doc.getElementById(T3PLUS.panelId), null);
  assert.ok(!doc.documentElement.hasAttribute(T3PLUS.settingsAttr));
  assert.equal(button.getAttribute("data-active"), "false");

  // Opening, then navigating elsewhere, closes it too.
  click(dom, button);
  assert.ok(doc.getElementById(T3PLUS.panelId));
  dom.window.history.pushState({}, "", "/settings/general");
  app.watcher.flush();
  assert.equal(doc.getElementById(T3PLUS.panelId), null);

  // Leaving Settings removes the entry; stop() cleans up.
  dom.window.history.pushState({}, "", "/");
  app.watcher.flush();
  assert.equal(navButton(doc), null);
  app.stop();
  assert.ok(!doc.documentElement.hasAttribute(T3PLUS.settingsAttr));
});

test("settings saved by v0.14 load unchanged; options this build dropped are ignored", async () => {
  const storage = createFakeChromeStorage();
  const v14 = {
    version: 2,
    composerGradient: { enabled: true, mode: "half-circle", accent: "#112233", intensity: 60, imageSource: "sample", dither: true, ditherSize: "large", ditherStyle: "grain" },
    glass: { enabled: true, strength: 70 },
    sidebar: { profiles: false, bots: true, compactHeader: false },
    home: { widgets: false },
  };
  await storage.area.set({ [STORAGE_KEYS.settings]: v14 });
  const dom = createDom("/settings/appearance", SETTINGS_HTML);
  const doc = dom.window.document;
  const { app } = createApp(dom, storage);
  await app.start();
  click(dom, navButton(doc));
  const panel = doc.getElementById(T3PLUS.panelId);

  assert.equal(panel.querySelector('input[value="grain"]').checked, true, "look shows the saved dither style");
  assert.equal(panel.querySelector('input[value="large"]').checked, true, "pixel size kept");
  const switchFor = (label) => panel.querySelector(`[role="switch"][aria-label="${label}"]`);
  assert.equal(switchFor("Usage widgets").getAttribute("aria-checked"), "false");
  assert.equal(switchFor("Bot rows").getAttribute("aria-checked"), "true");
  for (const gone of ["Sidebar profile tabs", "Compact sidebar header", "Title first"]) assert.equal(switchFor(gone), null, `${gone} is not offered`);

  // Smooth is the old "Pixel dither" off; the style underneath is kept.
  const smooth = panel.querySelector('input[value="smooth"]');
  smooth.checked = true;
  smooth.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
  await settle();
  const saved = storage.area.data.get(STORAGE_KEYS.settings);
  assert.equal(saved.composerGradient.dither, false);
  assert.equal(saved.composerGradient.ditherStyle, "grain");
  assert.equal(saved.composerGradient.accent, "#112233");

  assert.deepEqual(Object.keys(saved.sidebar).sort(), ["botStyle", "bots", "botsDefault", "profiles", "statusBadges", "statusColors", "subagentColor", "subagentShape"], "saving keeps only the options that still exist");
  assert.equal(saved.sidebar.bots, true);
  app.stop();
});

test("the toolbar icon's #t3plus link opens the t3+ section once", async () => {
  const dom = createDom("/settings/appearance#t3plus", SETTINGS_HTML);
  const doc = dom.window.document;
  const { app } = createApp(dom);
  await app.start();
  app.watcher.flush();
  assert.ok(doc.getElementById(T3PLUS.panelId), "opened from the hash");
  click(dom, doc.querySelector('[data-settings-section="/settings/appearance"]'));
  app.watcher.flush();
  assert.equal(doc.getElementById(T3PLUS.panelId), null, "a T3 link still closes it");
  app.stop();
});

test("the t3+ entry takes T3's role and tab stop from Appearance (keyboard reachable in current T3), and T3's page actions hide while it is open", async () => {
  // Current T3: plain buttons in plain <li>s (no tree roles, no tabindex). The header: its breadcrumb, then the page's actions.
  const header = '<header><nav aria-label="Settings breadcrumb"><ol><li aria-current="page">Appearance</li></ol></nav><div><button>Restore device defaults</button><button aria-label="Close"></button></div></header>';
  const plain = header + SETTINGS_HTML.replaceAll(' role="treeitem"', "");
  const dom = createDom("/settings/appearance", plain);
  const doc = dom.window.document;
  const { app } = createApp(dom);
  await app.start();
  const button = navButton(doc);
  assert.equal(button.hasAttribute("tabindex"), false, "reachable with Tab like T3's entries");
  assert.equal(button.hasAttribute("role"), false);
  assert.equal(button.closest("li").hasAttribute("role"), false);
  click(dom, button);
  assert.equal(button.getAttribute("aria-current"), "page");
  assert.equal(button.hasAttribute("aria-selected"), false, "no aria-selected without a role that has it");
  // T3's sections and page actions (they act on the page underneath) are marked to hide: opening
  // and closing restyle what is in them, not the whole page (a rule keyed on <html> alone).
  assert.equal(doc.querySelector("header nav ~ div").getAttribute("data-t3plus-settings-hide"), "actions");
  assert.equal(doc.getElementById("page-container").getAttribute("data-t3plus-settings-hide"), "sections");
  app.stop();
  assert.equal(doc.querySelector("[data-t3plus-settings-hide]"), null, "unmarked once t3+ stops");

  // Older T3 (tree roles): the entry follows those instead.
  const dom2 = createDom("/settings/appearance", SETTINGS_HTML);
  const { app: app2 } = createApp(dom2);
  await app2.start();
  assert.equal(navButton(dom2.window.document).getAttribute("role"), "treeitem");
  app2.stop();

  const css = readFileSync(new URL("../src/styles/content.css", import.meta.url), "utf8");
  assert.match(css, /\[data-t3plus-settings-hide="actions"\] > :not\(\[aria-label="Close"\]\)\s*\{\s*display: none !important;/, "Restore device defaults & co. hide; Close stays");
  assert.match(css, /\[data-t3plus-settings-hide="sections"\] > :not\(#t3plus-appearance\)\s*\{\s*display: none !important;/, "T3's sections hide; the panel stays");
});

test("settings nav: t3+'s entry is one of T3's arrow-key stops, and only one entry is the current page", () => {
  const dom = createDom("/settings/appearance", `<ul><li><button data-settings-section="/settings/appearance" data-active="true" aria-current="page">Appearance</button></li></ul>`);
  const doc = dom.window.document;
  const appearance = doc.querySelector("button");
  const nav = createSettingsNavItem(doc, () => {});
  nav.mount(appearance);
  assert.ok(nav.button.matches("[data-settings-section]"), "T3's arrow keys include it");
  nav.setActive(true);
  assert.equal(nav.button.getAttribute("aria-current"), "page");
  assert.equal(appearance.hasAttribute("aria-current"), false, "Appearance is not current while t3+ is open");
  nav.setActive(false);
  assert.equal(appearance.getAttribute("aria-current"), "page", "and is again after");
  assert.equal(nav.button.hasAttribute("aria-current"), false);
});

test("opened over any settings page, in any of T3's nav groups, t3+'s entry is the one current page until it closes", async () => {
  // T3's nav as it ships: each group its own list, the page's entry marked aria-current="page".
  const entry = (page, current) => `<li data-slot="sidebar-menu-item"><button type="button" data-slot="sidebar-menu-button"
    data-settings-section="/settings/${page}" data-active="${current}"${current ? ' aria-current="page"' : ""}><span>${page}</span></button></li>`;
  const group = (pages, current) => `<div role="group"><ul data-slot="sidebar-menu">${pages.map((p) => entry(p, p === current)).join("")}</ul></div>`;
  const nav = (current) => `<div>${group(["general", "appearance", "chat"], current)}${group(["providers", "about"], current)}</div>${T3_APPEARANCE_HTML}`;
  for (const page of ["general", "providers"]) {
    const dom = createDom(`/settings/${page}`, nav(page));
    const doc = dom.window.document;
    const { app } = createApp(dom);
    await app.start();
    const own = doc.querySelector(`[data-settings-section="/settings/${page}"]`);
    const current = () => [...doc.querySelectorAll('[aria-current="page"]')];
    click(dom, navButton(doc));
    assert.deepEqual(current(), [navButton(doc)], `over ${page}: t3+'s entry only`);
    app.watcher.flush();
    assert.deepEqual(current(), [navButton(doc)], "and so it stays");
    click(dom, doc.querySelector('[data-settings-section="/settings/chat"]')); // a T3 link closes t3+
    assert.deepEqual(current(), [own], `${page}'s entry is the current page again`);
    click(dom, navButton(doc));
    app.stop();
    assert.deepEqual(current(), [own], "and once t3+ stops");
    assert.equal(doc.querySelector("[data-t3plus-current-moved]"), null);
  }
});

test("settings nav: closed after T3 took Settings down, the entry holds on to nothing of it", () => {
  const dom = createDom("/settings/general", `<ul id="nav"><li><button data-settings-section="/settings/general" data-active="true" aria-current="page">General</button></li></ul>`);
  const doc = dom.window.document;
  const list = doc.getElementById("nav");
  const general = list.querySelector("button");
  const nav = createSettingsNavItem(doc, () => {});
  nav.mount(general);
  nav.setActive(true);
  list.remove(); // T3 leaves Settings: the whole nav goes
  nav.setActive(false);
  assert.equal(general.hasAttribute("data-t3plus-current-moved"), false, "unmarked");
  doc.body.append(list); // were it ever back, it is T3's own: t3+ does not touch it
  nav.setActive(false);
  assert.equal(general.hasAttribute("aria-current"), false);
});

test("settings nav: when T3 unmounts Settings, t3+'s entry and panel leave its detached tree", async () => {
  // React takes down only the route's top node: what t3+ put inside stays a child of
  // the detached tree (not connected, but still holding on to it) unless t3+ removes it.
  const dom = createDom("/settings/appearance", `<div id="route">${SETTINGS_HTML}</div>`);
  const doc = dom.window.document;
  const { app } = createApp(dom);
  await app.start();
  click(dom, navButton(doc));
  const route = doc.getElementById("route");
  const entry = navButton(doc).closest("li");
  const panel = doc.getElementById(T3PLUS.panelId);
  assert.ok(route.contains(entry) && route.contains(panel), "both are in T3's Settings route");

  route.remove();
  dom.window.history.pushState({}, "", "/");
  app.watcher.flush();
  assert.equal(entry.parentNode, null, "the entry is out of T3's old nav");
  assert.equal(panel.parentNode, null, "the panel is out of T3's old page");
  assert.equal(route.querySelector("[data-t3plus-settings-nav], #" + T3PLUS.panelId), null);
});
