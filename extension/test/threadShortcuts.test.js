import assert from "node:assert/strict";
import { test } from "node:test";
import { STORAGE_KEYS } from "../src/config.js";
import { createProfiles } from "../src/profiles.js";
import { commandFor, DEFAULT_THREAD_RULES, formatShortcut, labelFor, parseLenientJson, parseShortcut, parseWhen, resolveRules, threadTarget } from "../src/threadShortcuts.js";
import { createDom, createFakeChromeStorage, settle } from "./helpers.js";

const key = (code, key, mods = {}) => ({ code, key, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, ...mods });
const DESKTOP = { isDesktop: true, isWeb: false, modelPickerOpen: false };

test("T3's thread keys: Cmd+1-9 and Cmd+Shift+[ / ] on a Mac, Ctrl elsewhere, by key code whatever Shift makes of the key", () => {
  const r = resolveRules(null);
  assert.equal(r.length, DEFAULT_THREAD_RULES.length);
  assert.equal(commandFor(key("Digit1", "1", { metaKey: true }), r, true, DESKTOP), "thread.jump.1");
  assert.equal(commandFor(key("Digit9", "9", { metaKey: true }), r, true, DESKTOP), "thread.jump.9");
  assert.equal(commandFor(key("Digit1", "1", { ctrlKey: true }), r, false, DESKTOP), "thread.jump.1");
  assert.equal(commandFor(key("Digit1", "1", { ctrlKey: true }), r, true, DESKTOP), null, "Ctrl is not Cmd on a Mac");
  assert.equal(commandFor(key("Digit1", "!", { metaKey: true, shiftKey: true }), r, true, DESKTOP), null);
  assert.equal(commandFor(key("Digit1", "1"), r, true, DESKTOP), null, "plain 1 is typing");
  assert.equal(commandFor(key("BracketLeft", "{", { metaKey: true, shiftKey: true }), r, true, DESKTOP), "thread.previous");
  assert.equal(commandFor(key("BracketRight", "}", { metaKey: true, shiftKey: true }), r, true, DESKTOP), "thread.next");
  assert.equal(commandFor(key("Digit1", "&", { metaKey: true }), r, true, DESKTOP), "thread.jump.1", "AZERTY Cmd+&");
  assert.equal(commandFor(key("Numpad1", "1", { ctrlKey: true }), r, false, DESKTOP), "thread.jump.1", "the typed 1, as T3 reads it");
  assert.equal(commandFor(key("Numpad1", "End", { ctrlKey: true }), r, false, DESKTOP), null, "Ctrl+End from the numpad is not a jump");
  assert.equal(commandFor(key("Digit1", "1", { metaKey: true }), r, true, { ...DESKTOP, modelPickerOpen: true }), null, "the model picker's own");
});

test("rules are read as T3 reads them: trimmed tokens, space/esc, invalid rules dropped (T3's default stays), when clauses, other commands win a shared key", () => {
  assert.deepEqual(parseShortcut("mod + shift + ["), { key: "[", metaKey: false, ctrlKey: false, shiftKey: true, altKey: false, modKey: true });
  assert.equal(parseShortcut("mod+1+2"), null);
  assert.equal(parseShortcut("mod+").key, "+", "T3 reads it as Cmd and +");
  assert.equal(parseShortcut("mod++").key, "+");
  assert.equal(parseShortcut("mod+space").key, " ");
  assert.equal(parseWhen("a &&"), null);
  assert.ok(parseWhen("!terminalFocus && (isDesktop || isWeb)"));
  // A rule T3 rejects does not replace its default.
  let r = resolveRules([{ key: "mod+1+2", command: "thread.jump.1" }, { key: "mod+k", command: "commandPalette.toggle" }]);
  assert.equal(commandFor(key("Digit1", "1", { metaKey: true }), r, true, DESKTOP), "thread.jump.1");
  r = resolveRules([{ key: "mod+1", command: "thread.jump.1", when: "a &&" }]);
  assert.equal(commandFor(key("Digit1", "1", { metaKey: true }), r, true, DESKTOP), "thread.jump.1", "a broken when: the rule is dropped");
  // A valid user rule replaces the default for its command only.
  r = resolveRules([{ key: "alt + 1", command: "thread.jump.1" }]);
  assert.equal(commandFor(key("Digit1", "1", { altKey: true }), r, true, DESKTOP), "thread.jump.1");
  assert.equal(commandFor(key("Digit1", "1", { metaKey: true }), r, true, DESKTOP), null);
  assert.equal(commandFor(key("Digit2", "2", { metaKey: true }), r, true, DESKTOP), "thread.jump.2");
  // Another command on the same key, later: it wins, as in T3.
  r = resolveRules([{ key: "mod+1", command: "thread.jump.1" }, { key: "mod+1", command: "workspace.focusNext" }]);
  assert.equal(commandFor(key("Digit1", "1", { metaKey: true }), r, true, DESKTOP), "workspace.focusNext");
  // A rule for a command T3 does not know is dropped by T3: it shadows nothing.
  r = resolveRules([{ key: "mod+1", command: "nope.typo" }, { key: "mod+2", command: "thread.jump.10" }]);
  assert.equal(commandFor(key("Digit1", "1", { metaKey: true }), r, true, DESKTOP), "thread.jump.1");
  assert.equal(commandFor(key("Digit2", "2", { metaKey: true }), r, true, DESKTOP), "thread.jump.2");
  // Longer than T3 allows (a key over 64, a when over 256): dropped, T3's default stays.
  r = resolveRules([{ key: `mod+${"x".repeat(70)}`, command: "thread.jump.1" }, { key: "mod+2", command: "thread.jump.2", when: `isDesktop${" && isDesktop".repeat(30)}` }]);
  assert.equal(commandFor(key("Digit1", "1", { metaKey: true }), r, true, DESKTOP), "thread.jump.1");
  assert.equal(commandFor(key("Digit2", "2", { metaKey: true }), r, true, DESKTOP), "thread.jump.2");
  // when: false on desktop, or only in the terminal.
  r = resolveRules([{ key: "mod+1", command: "thread.jump.1", when: "isWeb" }]);
  assert.equal(commandFor(key("Digit1", "1", { metaKey: true }), r, true, DESKTOP), null);
  r = resolveRules([{ key: "mod+1", command: "thread.jump.1", when: "terminalFocus" }]);
  assert.equal(commandFor(key("Digit1", "1", { metaKey: true }), r, true, DESKTOP), null);
  assert.equal(commandFor(key("Digit1", "1", { metaKey: true }), r, true, { ...DESKTOP, terminalFocus: true }), "thread.jump.1");
  assert.deepEqual(parseLenientJson('[\n // mine\n {"key": "mod+1", "command": "thread.jump.1"}, /* x */\n]'), [{ key: "mod+1", command: "thread.jump.1" }]);
});

test("labels as T3 writes them, from each command's effective key", () => {
  const r = resolveRules(null);
  assert.equal(labelFor("thread.jump.3", r, true, DESKTOP), "⌘3");
  assert.equal(labelFor("thread.jump.3", r, false, DESKTOP), "Ctrl+3");
  assert.equal(formatShortcut(parseShortcut("mod+shift+]"), true), "⇧⌘]");
  const own = resolveRules([{ key: "alt+j", command: "thread.jump.1" }]);
  assert.equal(labelFor("thread.jump.1", own, true, DESKTOP), "⌥J");
  const shadowed = resolveRules([{ key: "mod+2", command: "thread.jump.2" }, { key: "mod+2", command: "chat.new" }]);
  assert.equal(labelFor("thread.jump.2", shadowed, true, DESKTOP), null, "its key belongs to another command");
});

test("where a key goes among the profile's threads: T3's rules, no wrapping, nothing past the end", () => {
  const rows = ["e:a", "e:b", "e:c"];
  assert.equal(threadTarget("thread.jump.1", rows, null), "e:a");
  assert.equal(threadTarget("thread.jump.3", rows, "e:a"), "e:c");
  assert.equal(threadTarget("thread.jump.4", rows, "e:a"), null);
  assert.equal(threadTarget("thread.next", rows, "e:a"), "e:b");
  assert.equal(threadTarget("thread.previous", rows, "e:a"), null);
  assert.equal(threadTarget("thread.next", rows, "e:c"), null);
  assert.equal(threadTarget("thread.next", rows, null), "e:a");
  assert.equal(threadTarget("thread.previous", rows, null), "e:c");
  assert.equal(threadTarget("thread.next", rows, "e:zz"), null);
});

// A sidebar with Main's project (p/a) and Work's (p/b), Work's first in T3's list.
const folder = (k) => `<li data-testid="sidebar-project-folder"><button data-sidebar-row="folder:${k}" aria-expanded="true"><span class="truncate">${k}</span></button></li>`;
const thread = (k, parent, hint = "") =>
  `<li data-thread-item="${k}"><div role="button" data-sidebar-row="${k}" data-sidebar-parent="${parent}" aria-label="${k}"><span dir="auto">${k}</span><span class="relative ml-auto min-w-8 shrink-0"><span>1d</span>${hint ? `<kbd class="kbd" data-jump-hint aria-hidden="true">${hint}</kbd>` : ""}</span></div></li>`;
const PROFILES = { active: "main", list: [{ id: "main", name: "Main" }, { id: "work", name: "Work" }], projects: { "p/a": "main", "p/b": "work" }, adopted: true };

async function setup(hints = false, keybindings = null, stored = PROFILES) {
  const h = (n) => (hints ? `⌘${n}` : "");
  const rows = folder("p/b") + thread("env:b1", "folder:p/b", h(1)) + thread("env:b2", "folder:p/b", h(2)) + folder("p/a") + thread("env:a1", "folder:p/a", h(3)) + thread("env:a2", "folder:p/a", h(4)) + thread("env:a3", "folder:p/a", h(5));
  const dom = createDom("/env/a1", `<div data-slot="sidebar-inner"><ul id="list">${rows}</ul><div data-slot="sidebar-footer"></div></div>`);
  const win = dom.window;
  const doc = win.document;
  const opened = [];
  const t3Ran = [];
  doc.addEventListener("click", (e) => {
    const row = e.target.closest?.("[data-thread-item] [data-sidebar-row]");
    if (!row) return;
    const k = row.getAttribute("data-sidebar-row");
    opened.push(k);
    win.history.pushState({}, "", `/${k.replace(":", "/")}`);
  });
  // T3's own handler: on the window, skipping a key already handled.
  win.addEventListener("keydown", (e) => {
    if (!e.defaultPrevented && (e.ctrlKey || e.metaKey)) t3Ran.push(e.code);
  });
  const storage = createFakeChromeStorage();
  storage.area.data.set(STORAGE_KEYS.profiles, stored);
  const profiles = createProfiles({ win, doc, area: storage.area, changedEvent: storage.onChanged, threadKeybindings: () => keybindings });
  await profiles.start();
  await settle();
  const press = (code, k, mods = {}) => {
    const ev = new win.KeyboardEvent("keydown", { code, key: k, ctrlKey: true, bubbles: true, cancelable: true, ...mods });
    doc.body.dispatchEvent(ev);
    return ev;
  };
  return { win, doc, profiles, opened, t3Ran, press };
}

test("with profiles on, Ctrl/Cmd+1-9 opens the Nth thread of the open profile, never another profile's, and T3 skips the key", async () => {
  const t = await setup();
  assert.ok(t.doc.querySelector('[data-thread-item="env:b1"]').closest("[data-t3plus-profile-off]"), "Work's rows are hidden in Main");
  const ev = t.press("Digit1", "1");
  assert.equal(ev.defaultPrevented, true);
  assert.deepEqual(t.opened, ["env:a1"], "Main's first thread, not Work's");
  assert.deepEqual(t.t3Ran, [], "T3's handler did nothing");
  t.press("Digit3", "3");
  assert.deepEqual(t.opened, ["env:a1", "env:a3"]);
  t.press("Digit4", "4");
  assert.deepEqual(t.opened, ["env:a1", "env:a3"], "past Main's last thread: nowhere");
  assert.deepEqual(t.t3Ran, [], "and not into Work's either");
  t.profiles.stop();
});

test("next and previous step through the open profile's threads only", async () => {
  const t = await setup();
  t.win.history.pushState({}, "", "/env/a2");
  t.press("BracketRight", "}", { shiftKey: true });
  assert.deepEqual(t.opened, ["env:a3"]);
  t.press("BracketLeft", "{", { shiftKey: true });
  assert.deepEqual(t.opened, ["env:a3", "env:a2"]);
  t.press("BracketLeft", "{", { shiftKey: true });
  t.press("BracketLeft", "{", { shiftKey: true });
  assert.deepEqual(t.opened, ["env:a3", "env:a2", "env:a1"], "stops at Main's first, does not step into Work's");
  t.profiles.stop();
});

test("T3 keeps the keys when no project is in another profile, while its palette or model picker is open, and for other keys", async () => {
  const t = await setup();
  t.doc.body.insertAdjacentHTML("beforeend", "<div data-command-palette></div>");
  t.press("Digit1", "1");
  assert.deepEqual(t.opened, []);
  assert.deepEqual(t.t3Ran, ["Digit1"], "the palette's own");
  t.doc.querySelector("[data-command-palette]").remove();
  t.press("KeyK", "k");
  assert.deepEqual(t.t3Ran, ["Digit1", "KeyK"]);
  t.profiles.stop();
  const u = await setup(false, null, { ...PROFILES, projects: { "p/a": "main", "p/b": "main" } });
  u.press("Digit1", "1");
  assert.deepEqual(u.t3Ran, ["Digit1"], "every project in the open profile: T3's own jump");
  u.profiles.stop();
});

test("the user's own jump key is kept to the profile too", async () => {
  const t = await setup(false, [{ key: "alt+1", command: "thread.jump.1" }]);
  t.press("Digit1", "1", { ctrlKey: false, altKey: true });
  assert.deepEqual(t.opened, ["env:a1"]);
  t.profiles.stop();
});

test("T3's ⌘ hints number the open profile's rows while they show, and go back to T3's when the key is let go", async () => {
  const t = await setup(true);
  t.press("ControlLeft", "Control", { ctrlKey: true });
  await new Promise((r) => setTimeout(r, 180));
  const ours = (k) => t.doc.querySelector(`[data-thread-item="${k}"] .t3plus-jump-hint`)?.textContent ?? null;
  assert.equal(ours("env:a1"), "Ctrl+1", "T3 said ⌘3");
  assert.equal(ours("env:a3"), "Ctrl+3", "T3 said ⌘5");
  assert.equal(ours("env:b1"), null, "none on Work's hidden rows");
  assert.ok(t.doc.documentElement.hasAttribute("data-t3plus-jump-hints"));
  const hint = t.doc.querySelector('[data-thread-item="env:a1"] .t3plus-jump-hint');
  assert.ok(hint.classList.contains("kbd") && hint.hasAttribute("data-jump-hint"), "styled as T3's, kept visible by T3's slot rule");
  // T3 takes its hints away on release.
  for (const el of t.doc.querySelectorAll("[data-jump-hint]:not(.t3plus-jump-hint)")) el.remove();
  t.doc.body.dispatchEvent(new t.win.KeyboardEvent("keyup", { code: "ControlLeft", key: "Control", bubbles: true }));
  await new Promise((r) => setTimeout(r, 120));
  assert.equal(t.doc.querySelector(".t3plus-jump-hint"), null);
  assert.equal(t.doc.querySelector("[data-t3plus-jump-slot]"), null);
  assert.ok(!t.doc.documentElement.hasAttribute("data-t3plus-jump-hints"));
  t.profiles.stop();
});

test("with T3's sidebar collapsed (inert), the keys still open the profile's thread, by its address", async () => {
  const t = await setup();
  t.doc.querySelector('[data-slot="sidebar-inner"]').setAttribute("inert", "");
  t.press("Digit2", "2");
  assert.deepEqual(t.opened, [], "no click on an inert row");
  assert.equal(t.win.location.pathname, "/env/a2", "Main's second thread, opened by address");
  assert.deepEqual(t.t3Ran, []);
  t.profiles.stop();
});

test("on a page with no thread list (Settings), the keys are T3's, which does nothing with them there", async () => {
  const t = await setup();
  t.doc.querySelector("#list").innerHTML = "";
  const ev = t.press("Digit1", "1");
  assert.equal(ev.defaultPrevented, false);
  assert.deepEqual(t.opened, []);
  t.profiles.stop();
});

test("while T3 shows search results in place of the list, the keys still open the open profile's threads as last listed", async () => {
  const t = await setup();
  t.profiles.sync();
  t.doc.querySelector("#list").outerHTML = '<div id="sidebar-thread-search-results"><div role="option">env:b1</div></div>';
  t.press("Digit2", "2");
  assert.equal(t.win.location.pathname, "/env/a2", "Main's second, by its address; never Work's");
  t.profiles.stop();
});

test("a thread nested under another profile's new thread (drawn before any sync) is that profile's", async () => {
  const t = await setup();
  t.doc.querySelector("#list").insertAdjacentHTML("afterbegin", `<li data-thread-item="env:bnew"><div role="button" data-sidebar-row="env:bnew" data-sidebar-parent="folder:p/b">bnew</div></li><li data-thread-item="env:bchild"><div role="button" data-sidebar-row="env:bchild" data-sidebar-parent="env:bnew">child</div></li>`);
  t.press("Digit1", "1");
  assert.deepEqual(t.opened, ["env:a1"]);
  t.profiles.stop();
});
