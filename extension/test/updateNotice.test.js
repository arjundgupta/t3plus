import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { createAppearancePanel } from "../src/appearancePanel.js";
import { DEFAULT_SETTINGS, STORAGE_KEYS } from "../src/config.js";
import { createSettingsNavItem } from "../src/settingsSection.js";
import { createUpdateNotice, createUpdateToast, isNewer, normalizeRelease, UPDATE_COMMAND } from "../src/updateNotice.js";
import { createDom } from "./helpers.js";

test("isNewer compares x.y.z by number, and nothing unparsable is newer", () => {
  assert.equal(isNewer("0.23.3", "0.23.2"), true);
  assert.equal(isNewer("0.24.0", "0.23.10"), true);
  assert.equal(isNewer("1.0.0", "0.99.99"), true);
  assert.equal(isNewer("v0.23.10", "0.23.9"), true);
  assert.equal(isNewer("0.23.2", "0.23.2"), false);
  assert.equal(isNewer("0.23.1", "0.23.2"), false);
  assert.equal(isNewer("latest", "0.23.2"), false);
  assert.equal(isNewer("0.23.3", null), false);
});

test("the loader's release is kept only with a version and a github.com page", () => {
  assert.deepEqual(normalizeRelease({ latest: "v0.23.3", url: "https://github.com/x/y/releases/tag/v0.23.3" }), { latest: "0.23.3", url: "https://github.com/x/y/releases/tag/v0.23.3" });
  assert.deepEqual(normalizeRelease({ latest: "0.23.3", url: "javascript:alert(1)" }), { latest: "0.23.3", url: null });
  assert.equal(normalizeRelease({ latest: "soon" }), null);
  assert.equal(normalizeRelease(null), null);
});

function memoryArea(initial = {}) {
  const data = { ...initial };
  const listeners = new Set();
  return {
    data,
    changed: { addListener: (fn) => listeners.add(fn), removeListener: (fn) => listeners.delete(fn) },
    async get(keys) { return Object.fromEntries([keys].flat().map((k) => [k, data[k]])); },
    async set(values) {
      const changes = {};
      for (const [k, v] of Object.entries(values)) { changes[k] = { oldValue: data[k], newValue: v }; data[k] = v; }
      for (const fn of listeners) fn(changes, "local");
    },
  };
}

test("pending while a newer release is out; hidden until the next release once dismissed", async () => {
  const area = memoryArea();
  let changes = 0;
  const notice = createUpdateNotice({ area, changedEvent: area.changed, version: "0.23.2", release: { latest: "0.23.2", url: null }, onChange: () => (changes += 1) });
  await notice.start();
  assert.equal(notice.pending, null, "the same version: nothing");
  notice.set({ latest: "0.23.3", url: "https://github.com/x/y/releases/tag/v0.23.3" });
  assert.deepEqual(notice.pending, { latest: "0.23.3", url: "https://github.com/x/y/releases/tag/v0.23.3", current: "0.23.2" });
  assert.ok(changes >= 1);
  notice.dismiss("0.23.3");
  assert.equal(notice.pending, null);
  await Promise.resolve();
  assert.equal(area.data[STORAGE_KEYS.updateDismissed], "0.23.3");
  notice.set({ latest: "0.23.4", url: null });
  assert.equal(notice.pending?.latest, "0.23.4", "the next release shows again");
  notice.stop();
});

test("a card hidden earlier, or in another window, stays hidden", async () => {
  const area = memoryArea({ [STORAGE_KEYS.updateDismissed]: "0.23.3" });
  const notice = createUpdateNotice({ area, changedEvent: area.changed, version: "0.23.2", release: { latest: "0.23.3" } });
  await notice.start();
  assert.equal(notice.pending, null);
  await area.set({ [STORAGE_KEYS.updateDismissed]: "0.23.0" });
  assert.equal(notice.pending?.latest, "0.23.3", "follows the stored value");
  await area.set({ [STORAGE_KEYS.updateDismissed]: "0.23.3" });
  assert.equal(notice.pending, null);
  notice.stop();
});

function panelWith(update) {
  const dom = createDom("/settings/appearance", "");
  const doc = dom.window.document;
  const calls = [];
  const actions = new Proxy({}, { get: (_, name) => (...args) => calls.push([name, ...args]) });
  const panel = createAppearancePanel(doc, actions);
  doc.body.append(panel.element);
  const show = (u) => panel.update({ settings: structuredClone(DEFAULT_SETTINGS), image: null, imageUrl: "", message: "", bots: [], botMarker: "🤖", health: [], update: u });
  show(update);
  return { doc, calls, show, card: () => doc.querySelector(".t3plus-update") };
}

test("Settings → t3+ shows the update card at the top: the release, the command with Copy, its notes, and hide", () => {
  const p = panelWith(null);
  assert.equal(p.card().hidden, true, "no card without a newer release");
  p.show({ latest: "0.23.3", url: "https://github.com/x/y/releases/tag/v0.23.3", current: "0.23.2" });
  const card = p.card();
  assert.equal(card.hidden, false);
  assert.equal(card.previousElementSibling.className, "t3plus-section-header", "right under the header");
  assert.match(card.textContent, /t3\+ 0\.23\.3 is out/);
  assert.match(card.textContent, /You have 0\.23\.2\./);
  assert.equal(card.querySelector("code").textContent, UPDATE_COMMAND);
  const notes = card.querySelector("a");
  assert.equal(notes.getAttribute("href"), "https://github.com/x/y/releases/tag/v0.23.3");
  assert.equal(notes.getAttribute("rel"), "noopener noreferrer");
  card.querySelector(".t3plus-update-hide").click();
  assert.deepEqual(p.calls.at(-1), ["dismissUpdate", "0.23.3"]);
  p.show({ latest: "0.23.3", url: null, current: "0.23.2" });
  assert.equal(card.querySelector("a").hidden, true, "no notes link without a page");
  p.show(null);
  assert.equal(card.hidden, true);
});

test("the update command is the README's", () => {
  const readme = readFileSync(new URL("../../README.md", import.meta.url), "utf8");
  assert.ok(readme.includes(UPDATE_COMMAND));
});

test("t3+'s Settings entry carries a dot while an update is out", () => {
  const dom = createDom("/settings/appearance", "");
  const nav = createSettingsNavItem(dom.window.document, () => {});
  nav.setUpdate(true);
  assert.ok(nav.button.hasAttribute("data-t3plus-update"));
  nav.setUpdate(false);
  assert.ok(!nav.button.hasAttribute("data-t3plus-update"));
});

test("the loader checks GitHub at most once a day, keeps only the version and page, and hands them to the page", () => {
  const loader = readFileSync(new URL("../../inject/main-loader.js", import.meta.url), "utf8");
  assert.match(loader, /api\.github\.com\/repos\/[\w-]+\/t3plus\/releases\/latest/);
  assert.match(loader, /UPDATE_EVERY = 24 \* 60 \* 60 \* 1000/);
  assert.match(loader, /update: releaseForPage\(\)/);
  assert.match(loader, /__t3plusApp\?\.updateInfo\?\./);
  assert.match(loader, /state\/t3plus-update\.json/);
});

test("the main-screen popup shows once per release: not before storage is read, not after it is closed or followed, not once the card is hidden", async () => {
  const area = memoryArea();
  const notice = createUpdateNotice({ area, changedEvent: area.changed, version: "0.23.2", release: { latest: "0.23.3" } });
  assert.equal(notice.toastDue, null, "waits for what was hidden");
  await notice.start();
  assert.equal(notice.toastDue?.latest, "0.23.3");
  notice.toastDone("0.23.3");
  assert.equal(notice.toastDue, null);
  assert.ok(notice.pending, "the card stays");
  await Promise.resolve();
  assert.equal(area.data[STORAGE_KEYS.updateToastSeen], "0.23.3");
  notice.set({ latest: "0.23.4" });
  assert.equal(notice.toastDue?.latest, "0.23.4", "a new release pops up again");
  notice.dismiss("0.23.4");
  assert.equal(notice.toastDue, null, "hiding the card hides the popup");
  notice.stop();

  const again = createUpdateNotice({ area: memoryArea({ [STORAGE_KEYS.updateToastSeen]: "0.23.3" }), version: "0.23.2", release: { latest: "0.23.3" } });
  await again.start();
  assert.equal(again.toastDue, null, "seen before a restart: not again");
});

test("the popup: the release and the version you have, Update and close call back with the release", () => {
  const dom = createDom("/", "");
  const doc = dom.window.document;
  const calls = [];
  const toast = createUpdateToast(doc, { onOpen: (v) => calls.push(["open", v]), onClose: (v) => calls.push(["close", v]) });
  assert.equal(toast.element.isConnected, false);
  toast.show({ latest: "0.23.3", current: "0.23.2", url: null });
  const el = doc.querySelector(".t3plus-update-toast");
  assert.ok(el && !el.hidden);
  assert.equal(el.getAttribute("role"), "status");
  assert.match(el.textContent, /t3\+ 0\.23\.3 is out/);
  assert.match(el.textContent, /You have 0\.23\.2\./);
  el.querySelector(".t3plus-update-toast-open").click();
  el.querySelector(".t3plus-update-toast-close").click();
  assert.deepEqual(calls, [["open", "0.23.3"], ["close", "0.23.3"]]);
  toast.show(null);
  assert.equal(doc.querySelector(".t3plus-update-toast"), null);
});
