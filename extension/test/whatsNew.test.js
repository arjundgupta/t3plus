import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";
import { WHATS_NEW, compareVersions, createWhatsNew, renderNotes, shouldShowWhatsNew } from "../src/whatsNew.js";
import { STORAGE_KEYS } from "../src/config.js";
import { createDom, createFakeChromeStorage, settle, virtualClock } from "./helpers.js";

// The sheet's own delays (1.5 s to settle in, 1 s retries, 2 s after the last key) run
// on a virtual clock: waited out at once, and the same on any machine.

test("every released version has notes, and each note is a lead and a sentence", async () => {
  const { version } = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  assert.ok(WHATS_NEW.some((e) => e.version === version), `What's New needs notes for ${version} (src/whatsNew.js)`);
  for (const entry of WHATS_NEW) {
    assert.ok(entry.version === "Unreleased" || /^\d+\.\d+\.\d+$/.test(entry.version), entry.version);
    assert.ok(entry.notes.length > 0);
    for (const note of entry.notes) assert.ok(note.length === 2 && note[0] && note[1], JSON.stringify(note));
  }
  const released = WHATS_NEW.filter((e) => e.version !== "Unreleased").map((e) => e.version);
  assert.deepEqual([...released].sort((a, b) => compareVersions(b, a)), released, "newest first");
});

test("it opens on its own only after an update to a version with notes", () => {
  assert.equal(shouldShowWhatsNew(null, "0.21.0"), false, "a fresh install");
  assert.equal(shouldShowWhatsNew("0.21.0", "0.21.0"), false, "seen already");
  assert.equal(shouldShowWhatsNew("0.20.0", "0.21.0"), true, "updated");
  assert.equal(shouldShowWhatsNew("0.21.0", "0.20.0"), false, "went back");
  assert.equal(shouldShowWhatsNew("0.20.0", "9.9.9"), false, "no notes for it");
  assert.equal(compareVersions("0.10.0", "0.9.9"), 1);
});

function setup(seen, version = "0.21.0") {
  const dom = createDom("/env/a1", `<button id="before">x</button>`);
  const storage = createFakeChromeStorage();
  if (seen) storage.area.data.set(STORAGE_KEYS.whatsNew, seen);
  const whatsNew = createWhatsNew({ win: dom.window, doc: dom.window.document, area: storage.area, version });
  return { win: dom.window, doc: dom.window.document, storage, whatsNew };
}
const sheet = (t) => t.doc.querySelector(".t3plus-whatsnew");

test("after an update the sheet opens once, marks the installed version, and Escape or × closes it with the focus back", async () => {
  const t = setup("0.20.0");
  const clock = virtualClock(t.win);
  t.doc.getElementById("before").focus();
  await t.whatsNew.start();
  assert.equal(t.storage.area.data.get(STORAGE_KEYS.whatsNew), "0.21.0", "seen right away (a crash does not show it again)");
  await clock.advance(1400);
  assert.equal(sheet(t), null, "not before T3 has settled in");
  await clock.advance(200);
  const s = sheet(t);
  assert.ok(s);
  assert.equal(s.getAttribute("role"), "alertdialog", "T3's shortcuts skip keys from inside one");
  assert.equal(s.querySelector("h2").textContent, "What's New");
  const installed = [...s.querySelectorAll(".t3plus-notes-title")].find((h) => h.textContent.includes("Installed"));
  assert.match(installed.textContent, /^0\.21\.0/);
  assert.equal(t.doc.activeElement, s.querySelector(".t3plus-whatsnew-close"));
  t.doc.dispatchEvent(new t.win.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
  assert.equal(sheet(t), null);
  assert.equal(t.doc.activeElement.id, "before", "focus back where it was");
  t.whatsNew.open();
  sheet(t).querySelector(".t3plus-whatsnew-close").click();
  assert.equal(sheet(t), null);
  t.whatsNew.stop();

  const again = setup("0.21.0");
  clock.attach(again.win);
  await again.whatsNew.start();
  await clock.advance(1600);
  assert.equal(sheet(again), null, "once per version");
  again.whatsNew.stop();
});

test("a fresh install opens nothing, only remembers the version; stop closes the sheet", async () => {
  const t = setup(null);
  await t.whatsNew.start();
  await settle();
  assert.equal(t.storage.area.data.get(STORAGE_KEYS.whatsNew), "0.21.0");
  t.whatsNew.open();
  assert.ok(sheet(t));
  t.whatsNew.stop();
  assert.equal(sheet(t), null);
});

test("notes render as 'Lead: text' items", () => {
  const { doc } = setup(null);
  const el = renderNotes(doc, { version: "0.20.0", entries: [{ version: "0.20.0", notes: [["Bots", "a row of chips."]] }] });
  assert.equal(el.querySelector("li").textContent, "Bots: a row of chips.");
  assert.equal(el.querySelector("strong").textContent, "Bots:");
  assert.match(el.querySelector(".t3plus-notes-title").textContent, /Installed/);
  assert.equal(renderNotes(doc, { entries: [{ version: "1.0.0", notes: [["A", "b"]] }], titles: false }).querySelector(".t3plus-notes-title"), null);
});

test("the first update with What's New shows it to someone who had t3+ before; a failed read marks nothing", async () => {
  const t = setup(null);
  const clock = virtualClock(t.win);
  t.storage.area.data.set(STORAGE_KEYS.settings, { any: 1 }); // t3+ was here, before What's New
  await t.whatsNew.start();
  await clock.advance(1600);
  assert.ok(sheet(t), "shown");
  t.whatsNew.stop();

  const f = setup("0.20.0");
  f.storage.area.get = async () => {
    throw new Error("storage");
  };
  await f.whatsNew.start();
  assert.equal(f.storage.area.data.get(STORAGE_KEYS.whatsNew), "0.20.0", "not marked seen");
  f.whatsNew.stop();
});

test("it waits while you type, opens in one window of several, and keeps keys and Tab inside", async () => {
  const t = setup("0.20.0");
  const clock = virtualClock(t.win);
  const input = t.doc.createElement("textarea");
  t.doc.body.append(input);
  input.focus();
  await t.whatsNew.start();
  const typing = t.win.setInterval(() => input.dispatchEvent(new t.win.KeyboardEvent("keydown", { key: "a", bubbles: true })), 300);
  await clock.advance(4000);
  assert.equal(sheet(t), null, "not while typing");
  t.win.clearInterval(typing); // the last key at 3.9 s
  await clock.advance(1800);
  assert.equal(sheet(t), null, "nor right after");
  await clock.advance(1200);
  assert.ok(sheet(t), "after a pause");
  assert.ok(t.doc.getElementById("before").hasAttribute("inert"), "the page behind is out of reach");
  // A handler added after t3+'s (the extension loads first) never sees a key.
  let later = false;
  t.win.addEventListener("keydown", () => (later = true), true);
  const close = sheet(t).querySelector(".t3plus-whatsnew-close");
  close.dispatchEvent(new t.win.KeyboardEvent("keydown", { key: "k", metaKey: true, bubbles: true, cancelable: true }));
  assert.equal(later, false, "T3's shortcuts do not act behind it");
  // Keys for the sheet itself are not taken from it: the notes scroll, text copies.
  const down = new t.win.KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true });
  close.dispatchEvent(down);
  assert.equal(down.defaultPrevented, false, "arrow keys scroll the notes");
  // The focus stays in the sheet (T3 skips keys from inside it).
  t.doc.body.focus();
  t.doc.getElementById("before").dispatchEvent(new t.win.FocusEvent("focusin", { bubbles: true }));
  assert.ok(sheet(t).contains(t.doc.activeElement), "focus that leaves comes back");
  // What T3 adds to the page meanwhile is out of reach too.
  const toast = t.doc.createElement("div");
  t.doc.body.append(toast);
  await clock.advance(0);
  assert.ok(toast.hasAttribute("inert"));
  t.doc.body.focus();
  const tab = new t.win.KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true });
  t.doc.body.dispatchEvent(tab);
  assert.ok(sheet(t).contains(t.doc.activeElement), "Tab from outside lands in the sheet");
  t.whatsNew.close();
  assert.equal(t.doc.getElementById("before").hasAttribute("inert"), false);
  t.whatsNew.stop();

  // Two windows sharing storage, starting together: one sheet.
  const dom2 = createDom("/env/a1", "");
  const a = setup("0.20.0");
  clock.attach(a.win);
  clock.attach(dom2.window);
  const b = createWhatsNew({ win: dom2.window, doc: dom2.window.document, area: a.storage.area, version: "0.21.0" });
  await Promise.all([a.whatsNew.start(), b.start()]);
  await clock.advance(1600);
  const shown = [a.doc, dom2.window.document].filter((d) => d.querySelector(".t3plus-whatsnew")).length;
  assert.equal(shown, 1);
  a.whatsNew.stop();
  b.stop();
});

test("on desktop (t3+ injected after T3 set up its keys), T3's shortcuts skip keys from inside the sheet", async () => {
  const dom = createDom("/env/a1", "");
  const { window: win } = dom;
  // T3's dispatcher, registered first, skipping keys whose target is in an alertdialog.
  let acted = 0;
  win.addEventListener("keydown", (e) => {
    if (e.target instanceof win.Element && e.target.closest('[role="alertdialog"]')) return;
    acted += 1;
  }, true);
  const storage = createFakeChromeStorage();
  const w = createWhatsNew({ win, doc: win.document, area: storage.area, version: "0.21.0" });
  w.open();
  win.document.activeElement.dispatchEvent(new win.KeyboardEvent("keydown", { key: "b", metaKey: true, bubbles: true, cancelable: true }));
  assert.equal(acted, 0);
  w.stop();
});

test("opened by hand before it opened on its own: it does not open again once closed, and stops listening for typing", async () => {
  /** The window's keydown listeners t3+ adds from here on (onKey again at start, the typing watch). */
  const keydownListeners = (win) => {
    const live = new Set();
    const { addEventListener: add, removeEventListener: remove } = win;
    win.addEventListener = function (type, fn, options) {
      if (type === "keydown") live.add(fn);
      return add.call(this, type, fn, options);
    };
    win.removeEventListener = function (type, fn, options) {
      if (type === "keydown") live.delete(fn);
      return remove.call(this, type, fn, options);
    };
    return live;
  };

  // In a hidden window: the open waits for it to be seen.
  const t = setup("0.20.0");
  const clock = virtualClock(t.win);
  const listening = keydownListeners(t.win);
  let visibility = "hidden";
  Object.defineProperty(t.doc, "visibilityState", { configurable: true, get: () => visibility });
  await t.whatsNew.start();
  assert.equal(listening.size, 2, "its keys, and the typing it waits out");
  await clock.advance(1600);
  t.whatsNew.open(); // Settings → t3+ → What's New
  t.whatsNew.close();
  assert.equal(listening.size, 1, "the typing watch is gone");
  visibility = "visible";
  t.doc.dispatchEvent(new t.win.Event("visibilitychange"));
  await clock.advance(100);
  assert.equal(sheet(t), null, "seen once: not opened again when the window is");
  t.whatsNew.stop();
  assert.equal(listening.size, 0);

  // Before its first try.
  const early = setup("0.20.0");
  clock.attach(early.win);
  const earlyListening = keydownListeners(early.win);
  await early.whatsNew.start();
  await clock.advance(500);
  early.whatsNew.open();
  early.whatsNew.close();
  await clock.advance(3000);
  assert.equal(sheet(early), null, "the timed open was called off");
  assert.equal(earlyListening.size, 1);
  early.whatsNew.stop();
});
