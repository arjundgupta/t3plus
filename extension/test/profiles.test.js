import assert from "node:assert/strict";
import { test } from "node:test";
import { clearBotDecoration } from "../src/bots.js";
import { STORAGE_KEYS } from "../src/config.js";
import { createProfiles, normalizeProfiles, PROFILE_COLORS, profileOf } from "../src/profiles.js";
import { createDom, createFakeChromeStorage, settle } from "./helpers.js";

// A project-grouped sidebar: folder rows, then each folder's thread rows (T3 renders a
// folder's threads as its next siblings, naming the folder in data-sidebar-parent).
const folder = (key, expanded = true) =>
  `<li data-testid="sidebar-project-folder"><button data-sidebar-row="folder:${key}" aria-expanded="${expanded}"><span class="truncate">${key}</span></button></li>`;
const thread = (key, parent, { status = "", age = "1d" } = {}) =>
  `<li data-thread-item="${key}"><div role="button" data-sidebar-row="${key}"${parent ? ` data-sidebar-parent="${parent}"` : ""} aria-label="${[key, status].filter(Boolean).join(", ")}"><span dir="auto">${key}</span><span>${age}</span></div></li>`;

function setup(rows, stored) {
  const dom = createDom("/env/a1", `<div data-slot="sidebar-inner"><ul id="list">${rows}</ul><div data-slot="sidebar-footer"></div></div>`);
  const win = dom.window;
  const doc = win.document;
  const opened = [];
  // T3 navigates when a row is clicked.
  doc.addEventListener("click", (e) => {
    const row = e.target.closest?.("[data-thread-item] [data-sidebar-row]");
    if (!row) return;
    const [env, id] = row.getAttribute("data-sidebar-row").split(":");
    opened.push(`${env}:${id}`);
    win.history.pushState({}, "", `/${env}/${id}`);
  });
  const storage = createFakeChromeStorage();
  storage.area.data.set(STORAGE_KEYS.profiles, stored);
  const profiles = createProfiles({ win, doc, area: storage.area, changedEvent: storage.onChanged });
  const route = () => win.location.pathname;
  const go = (path) => {
    win.history.pushState({}, "", path);
    profiles.sync();
  };
  return { dom, win, doc, storage, profiles, opened, route, go };
}

const TWO = { active: "main", list: [{ id: "main", name: "Main" }, { id: "work", name: "Work" }], projects: { "p/a": "main", "p/b": "work", "p/c": "work" }, adopted: true };

test("switching profiles opens the thread last open there, and comes back to the one you left", async () => {
  const t = setup(folder("p/a") + thread("env:a1", "folder:p/a") + thread("env:a2", "folder:p/a") + folder("p/b") + thread("env:b1", "folder:p/b") + thread("env:b2", "folder:p/b"), { ...TWO, last: { work: "env:b2" } });
  await t.profiles.start();
  assert.equal(t.route(), "/env/a1");
  t.profiles.switchTo("work");
  await settle();
  assert.equal(t.route(), "/env/b2", "Work's last thread opened");
  assert.equal(t.profiles.state.active, "work");
  t.profiles.switchTo("main");
  assert.equal(t.route(), "/env/a1", "back to the thread left open in Main");
  t.profiles.stop();
});

test("a profile never visited opens its most recent thread: one at work first, then by the age T3 shows", async () => {
  const t = setup(folder("p/a") + thread("env:a1", "folder:p/a") + folder("p/b") + thread("env:b1", "folder:p/b", { age: "3h" }) + thread("env:b2", "folder:p/b", { age: "20m" }) + folder("p/c") + thread("env:c1", "folder:p/c", { age: "2d" }), TWO);
  await t.profiles.start();
  t.profiles.switchTo("work");
  assert.equal(t.route(), "/env/b2", "20m beats 3h and 2d");
  const w = setup(folder("p/a") + thread("env:a1", "folder:p/a") + folder("p/b") + thread("env:b1", "folder:p/b", { age: "5m" }) + thread("env:b2", "folder:p/b", { status: "Working", age: "" }), TWO);
  await w.profiles.start();
  w.profiles.switchTo("work");
  assert.equal(w.route(), "/env/b2", "a working thread is the most recent");
  t.profiles.stop();
  w.profiles.stop();
});

test("opening a thread of another profile (⌘K, a link) switches to that profile and keeps the thread open", async () => {
  const t = setup(folder("p/a") + thread("env:a1", "folder:p/a") + folder("p/b") + thread("env:b1", "folder:p/b") + thread("env:b2", "folder:p/b"), TWO);
  await t.profiles.start();
  t.go("/env/b1");
  assert.equal(t.profiles.state.active, "work", "followed the thread");
  assert.equal(t.route(), "/env/b1", "and stayed on it");
  assert.equal(t.opened.length, 0, "nothing else was opened");
  assert.equal(t.doc.querySelector('[data-thread-item="env:b1"]').hasAttribute("data-t3plus-profile-off"), false, "its row is shown");
  t.profiles.switchTo("main");
  assert.equal(t.route(), "/env/a1", "Main still has its own thread");
  t.profiles.switchTo("work");
  assert.equal(t.route(), "/env/b1", "Work remembers the one opened from elsewhere");
  t.profiles.stop();
});

test("a pinned or settled thread (in every profile): switching still opens the new profile's thread, and coming back reopens it", async () => {
  const t = setup(thread("env:pin", "shelf:pinned") + folder("p/a") + thread("env:a1", "folder:p/a") + folder("p/b") + thread("env:b1", "folder:p/b"), TWO);
  await t.profiles.start();
  t.go("/env/pin");
  assert.equal(t.profiles.state.active, "main", "a shared thread switches nothing");
  t.profiles.switchTo("work");
  assert.equal(t.route(), "/env/b1");
  t.profiles.switchTo("main");
  assert.equal(t.route(), "/env/pin", "Main's last thread was the pinned one");
  t.profiles.stop();
});

test("a remembered thread in a collapsed folder opens by its address; one moved away or gone falls back to the most recent", async () => {
  const t = setup(folder("p/a") + thread("env:a1", "folder:p/a") + folder("p/b", false), { ...TWO, last: { work: "env:hidden" } });
  await t.profiles.start();
  t.profiles.switchTo("work");
  assert.equal(t.route(), "/env/hidden", "no row to click: opened by address");

  const moved = setup(folder("p/a") + thread("env:a1", "folder:p/a") + thread("env:a9", "folder:p/a") + folder("p/b") + thread("env:b1", "folder:p/b"), { ...TWO, last: { work: "env:a9" } });
  await moved.profiles.start();
  moved.profiles.switchTo("work");
  assert.equal(moved.route(), "/env/b1", "a9 is in Main now: Work's own thread instead");

  const gone = setup(folder("p/a") + thread("env:a1", "folder:p/a") + folder("p/b") + thread("env:b1", "folder:p/b"), { ...TWO, last: { work: "env:b-deleted" } });
  await gone.profiles.start();
  gone.profiles.sync();
  gone.profiles.switchTo("work");
  assert.equal(gone.route(), "/env/b1", "deleted in an earlier session (Work's folders are all open, it is in none): its most recent instead");
  assert.equal(gone.profiles.state.last.work, "env:b1", "and the gone one is forgotten");
  for (const x of [t, moved, gone]) x.profiles.stop();
});

test("a profile with no threads leaves the open thread as it is; moving the open thread's project away does not flip profiles", async () => {
  const t = setup(folder("p/a") + thread("env:a1", "folder:p/a"), { ...TWO, list: [...TWO.list, { id: "empty", name: "Empty" }] });
  await t.profiles.start();
  t.profiles.switchTo("empty");
  assert.equal(t.route(), "/env/a1");
  assert.equal(t.profiles.state.active, "empty");
  t.profiles.switchTo("main");
  await t.profiles.save({ ...t.profiles.state, projects: { ...t.profiles.state.projects, "p/a": "work" } });
  t.profiles.sync();
  assert.equal(t.profiles.state.active, "main", "no route change: the profile stays");
  t.profiles.stop();
});

test("deleting the open profile opens the first profile's thread; switching from the keyboard keeps focus on the dot", async () => {
  const t = setup(folder("p/a") + thread("env:a1", "folder:p/a") + thread("env:a2", "folder:p/a") + folder("p/b") + thread("env:b1", "folder:p/b"), { ...TWO, last: { main: "env:a2" } });
  await t.profiles.start();
  const dot = (id) => t.doc.querySelector(`.t3plus-profile-dot[data-profile="${id}"]`);
  const workDot = dot("work");
  workDot.focus();
  workDot.click();
  t.profiles.sync(); // the app's check after the navigation
  assert.equal(t.profiles.state.active, "work");
  assert.equal(t.doc.activeElement, workDot, "the dot was updated in place, not rebuilt");
  assert.equal(dot("work").getAttribute("aria-pressed"), "true");
  assert.equal(dot("main").getAttribute("aria-pressed"), "false");
  workDot.dispatchEvent(new t.win.MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
  t.doc.querySelector(".t3plus-profile-editor .t3plus-profile-delete").click();
  assert.equal(t.profiles.state.active, "main");
  assert.equal(t.route(), "/env/a1", "Main's thread: the one open when you left it (it replaced a2)");
  t.profiles.stop();
});

test("the open thread is written down once, shortly after, and saved on stop", async () => {
  const t = setup(folder("p/a") + thread("env:a1", "folder:p/a") + thread("env:a2", "folder:p/a"), TWO);
  let writes = 0;
  const set = t.storage.area.set;
  t.storage.area.set = async (items) => ((writes += 1), set(items));
  await t.profiles.start();
  t.go("/env/a2");
  t.go("/env/a1");
  t.go("/env/a2");
  assert.equal(writes, 0, "not on every navigation");
  await new Promise((r) => setTimeout(r, 450));
  assert.equal(writes, 1);
  assert.equal(t.storage.area.data.get(STORAGE_KEYS.profiles).last.main, "env:a2");
  t.go("/env/a1");
  t.profiles.stop();
  assert.equal(t.storage.area.data.get(STORAGE_KEYS.profiles).last.main, "env:a1", "flushed on stop");
});

test("switching again right away ends on the last profile and its thread, without flipping back", async () => {
  const t = setup(folder("p/a") + thread("env:a1", "folder:p/a") + folder("p/b") + thread("env:b1", "folder:p/b"), TWO);
  await t.profiles.start();
  t.profiles.switchTo("work"); // opens b1 (its row is still hidden: by address)
  t.profiles.switchTo("main"); // and straight back
  for (let i = 0; i < 3; i += 1) t.profiles.sync(); // the checks that follow
  assert.equal(t.profiles.state.active, "main");
  assert.equal(t.route(), "/env/a1");
  assert.equal(t.profiles.state.last.work, "env:b1", "Work remembers b1");
  t.profiles.stop();
});

test("switching profiles from Settings or a draft leaves that page open", async () => {
  const t = setup(folder("p/a") + thread("env:a1", "folder:p/a") + folder("p/b") + thread("env:b1", "folder:p/b"), TWO);
  await t.profiles.start();
  t.win.history.pushState({}, "", "/settings/appearance");
  t.profiles.switchTo("work");
  assert.equal(t.route(), "/settings/appearance");
  assert.equal(t.profiles.state.active, "work");
  t.profiles.stop();
});

test("rows T3 nests under a thread (a fork, a subagent) go with that thread's profile: hidden with it, and opened, followed and remembered there", async () => {
  // A fork of b1, and a subagent of that fork.
  const t = setup(folder("p/a") + thread("env:a1", "folder:p/a") + folder("p/b") + thread("env:b1", "folder:p/b") + thread("env:b1fork", "env:b1") + thread("env:b1sub", "env:b1fork"), TWO);
  await t.profiles.start();
  const off = () => ["env:a1", "env:b1", "env:b1fork", "env:b1sub"].filter((key) => t.doc.querySelector(`[data-thread-item="${key}"]`).hasAttribute("data-t3plus-profile-off"));
  assert.deepEqual(off(), ["env:b1", "env:b1fork", "env:b1sub"], "in Main, Work's thread and all that T3 nests under it are hidden");
  t.go("/env/b1sub"); // opened from elsewhere (⌘K, a link)
  assert.equal(t.profiles.state.active, "work", "its thread's profile opens");
  assert.equal(t.profiles.state.last?.work, "env:b1sub", "remembered there");
  assert.deepEqual(off(), ["env:a1"]);
  t.profiles.stop();
});

test("with no list of T3's to look in (a window too narrow for the sidebar, Settings), a profile's thread is not taken for gone", async () => {
  const stored = { ...TWO, last: { work: "env:b9" } };
  const narrow = setup("", stored);
  narrow.doc.querySelector('[data-slot="sidebar-inner"]').remove(); // the sheet closed
  await narrow.profiles.start();
  narrow.doc.body.dispatchEvent(new narrow.win.KeyboardEvent("keydown", { code: "Digit2", key: "2", ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true }));
  await settle();
  assert.equal(narrow.profiles.state.active, "work");
  assert.equal(narrow.route(), "/env/b9", "Work's thread, opened by its address");
  assert.equal(narrow.storage.area.data.get(STORAGE_KEYS.profiles).last?.work, "env:b9", "and still remembered");

  // Settings shows its own sidebar: no thread rows, no folders.
  const t = setup("", stored);
  await t.profiles.start();
  t.go("/settings/appearance");
  t.profiles.switchTo("work");
  await new Promise((r) => setTimeout(r, 450)); // past the moment a forgotten thread is written down
  assert.equal(t.storage.area.data.get(STORAGE_KEYS.profiles).last?.work, "env:b9");
  // Back in the chat (T3 reopens Main's thread): Work's own thread opens.
  t.doc.getElementById("list").innerHTML = folder("p/a") + thread("env:a1", "folder:p/a") + folder("p/b") + thread("env:b1", "folder:p/b") + thread("env:b9", "folder:p/b");
  t.go("/env/a1");
  assert.equal(t.route(), "/env/b9");
  for (const x of [narrow, t]) x.profiles.stop();
});

test("a thread seen in a folder, then settled: its row in the shelf (in every profile) decides, and opening it switches no profile", async () => {
  const t = setup(folder("p/a") + thread("env:a1", "folder:p/a") + folder("p/b") + thread("env:b1", "folder:p/b") + thread("env:b2", "folder:p/b"), TWO);
  await t.profiles.start(); // b2 seen in Work's folder
  // T3 settles it: its row moves to the Settled shelf.
  const settled = thread("env:b2", "shelf:settled");
  t.doc.querySelector('[data-thread-item="env:b2"]').remove();
  t.doc.getElementById("list").insertAdjacentHTML("beforeend", `<li><button data-sidebar-row="shelf:settled" aria-expanded="true">Settled</button></li>${settled}`);
  t.profiles.sync();
  t.go("/env/b2");
  assert.equal(t.profiles.state.active, "main", "no switch to Work");
  // The shelf collapsed (its row gone): the folder it was seen in no longer says either.
  t.go("/env/a1");
  t.doc.querySelector('[data-thread-item="env:b2"]').remove();
  t.go("/env/b2");
  assert.equal(t.profiles.state.active, "main");
  // Shown again: it is the thread to come back to in the profile left.
  t.doc.getElementById("list").insertAdjacentHTML("beforeend", settled);
  t.profiles.sync();
  t.profiles.switchTo("work");
  assert.equal(t.profiles.state.last?.main, "env:b2", "the thread to come back to in Main");
  t.profiles.switchTo("main");
  assert.equal(t.route(), "/env/b2");
  t.profiles.stop();
});

test("past the cap of placed folders, a new one still joins the open profile and moves where it is sent; a folder T3 shows never makes room", async () => {
  // A full map: Work's p/b placed first, then Main's p/a, then 998 folders gone since
  // (deleted projects, another machine's).
  const projects = { "p/b": "work", "p/a": "main" };
  for (let i = 0; i < 998; i += 1) projects[`gone/${i}`] = "main";
  assert.equal(normalizeProfiles({ ...TWO, projects: { ...projects, "p/last": "work" } }).projects["p/last"], "work", "over the cap, the oldest go, not the newest");
  const t = setup(folder("p/a") + thread("env:a1", "folder:p/a") + folder("p/b") + thread("env:b1", "folder:p/b") + folder("p/new"), { ...TWO, projects });
  await t.profiles.start();
  const stored = () => t.storage.area.data.get(STORAGE_KEYS.profiles).projects;
  await settle();
  assert.equal(stored()["p/new"], "main", "the new folder joins the open profile");
  assert.equal(Object.hasOwn(stored(), "gone/0"), false, "the least recently placed of the unseen made room");
  assert.equal(stored()["p/b"], "work", "not Work's, older but shown");
  assert.equal(Object.keys(stored()).length, 1000);
  // Right-click it, Move to profile, Work.
  t.doc.querySelector('[data-sidebar-row="folder:p/new"]').dispatchEvent(new t.win.MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
  assert.equal(t.profiles.projectMenuPick("t3plus:move:work"), true);
  await settle();
  t.profiles.stop();
  const reloaded = createProfiles({ win: t.win, doc: t.doc, area: t.storage.area, changedEvent: t.storage.onChanged });
  await reloaded.start();
  assert.equal(profileOf(reloaded.state, "p/new"), "work", "moved, and still there after a reload");
  reloaded.stop();
});

test("a profile whose id is one of an object's built-in keys (\"constructor\", from a backup) switches like any other", async () => {
  // (With a thread remembered, `last` is an object: its built-ins were taken for C's thread.)
  const t = setup("", { ...TWO, list: [...TWO.list, { id: "constructor", name: "C" }], last: { main: "env:a1" } });
  t.doc.querySelector('[data-slot="sidebar-inner"]').remove();
  await t.profiles.start();
  t.profiles.switchTo("constructor");
  assert.equal(t.profiles.state.active, "constructor");
  assert.equal(t.route(), "/env/a1", "no thread of its own yet: none opened");
  t.profiles.stop();
});

test("a profile save storage turns down is no unhandled rejection for the callers that do not wait for it, and a later save writes it", async (t) => {
  const s = setup(folder("p/a") + thread("env:a1", "folder:p/a") + folder("p/b") + thread("env:b1", "folder:p/b"), TWO);
  await s.profiles.start();
  const unhandled = [];
  const onUnhandled = (reason) => unhandled.push(reason);
  process.on("unhandledRejection", onUnhandled);
  t.after(() => process.off("unhandledRejection", onUnhandled));
  const set = s.storage.area.set.bind(s.storage.area);
  s.storage.area.set = async () => {
    throw new Error("QUOTA_BYTES quota exceeded");
  };
  s.profiles.switchTo("work"); // saves, and does not wait for it
  await settle();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(unhandled, []);
  s.storage.area.set = set;
  s.profiles.switchTo("main");
  s.profiles.switchTo("work");
  await settle();
  assert.equal(s.storage.area.data.get(STORAGE_KEYS.profiles).active, "work", "written by the next save");
  s.profiles.stop();
});

test("profiles: dots in the sidebar footer, folders of other profiles hidden, a moved folder follows its profile", async () => {
  const folder = (key, title) => `<li data-testid="sidebar-project-folder"><button data-sidebar-row="folder:${key}"><span class="truncate">${title}</span></button></li>`;
  // T3 puts a folder's threads after it, as siblings that name their folder.
  const thread = (key, parent) => `<li data-thread-item="env1:${key}"><div data-sidebar-row="env1:${key}" data-sidebar-parent="${parent}">${key}</div></li>`;
  const dom = createDom("/", `<div data-slot="sidebar-inner"><ul>${folder("p/a", "Alpha")}${thread("t1", "folder:p/a")}${folder("p/b", "Beta")}${thread("t2", "folder:p/b")}${thread("t3", "shelf:settled")}</ul><div data-slot="sidebar-footer"><ul></ul></div></div>`);
  const doc = dom.window.document;
  const storage = createFakeChromeStorage();
  const profiles = createProfiles({ win: dom.window, doc, area: storage.area, changedEvent: storage.onChanged });
  await profiles.start();
  const footer = doc.querySelector('[data-slot="sidebar-footer"]');
  assert.ok(footer.firstElementChild.classList.contains("t3plus-profiles"), "at the top of the footer");
  assert.equal(doc.querySelectorAll(".t3plus-profile-dot:not(.t3plus-profile-add)").length, 1, "one profile to start with");
  assert.equal(doc.querySelectorAll("[data-t3plus-profile-off]").length, 0, "it shows every project");

  await profiles.save({ ...profiles.state, list: [...profiles.state.list, { id: "work", name: "Work" }], projects: { "p/b": "work" } });
  assert.equal(doc.querySelector('[data-sidebar-row="folder:p/b"]').closest("li").hasAttribute("data-t3plus-profile-off"), true, "Beta lives in Work");
  assert.equal(doc.querySelector('[data-thread-item="env1:t2"]').hasAttribute("data-t3plus-profile-off"), true, "and so does its thread");
  assert.equal(doc.querySelector('[data-thread-item="env1:t3"]').hasAttribute("data-t3plus-profile-off"), false, "settled threads stay");
  profiles.switchTo("work");
  assert.equal(doc.querySelector('[data-sidebar-row="folder:p/a"]').closest("li").hasAttribute("data-t3plus-profile-off"), true);
  assert.equal(doc.querySelector('[data-sidebar-row="folder:p/b"]').closest("li").hasAttribute("data-t3plus-profile-off"), false);
  assert.equal(doc.querySelector('.t3plus-profile-dot[data-profile="work"]').getAttribute("aria-pressed"), "true");
  assert.deepEqual(normalizeProfiles({ list: [], projects: { x: "nope" } }), { active: "main", list: [{ id: "main", name: "Main", color: "default", sky: "default" }], projects: {} }, "bad data falls back to one profile");
  profiles.stop();
  assert.equal(doc.querySelector(".t3plus-profiles"), null);
  assert.equal(doc.querySelectorAll("[data-t3plus-profile-off]").length, 0, "stopping shows every folder again");
});

test("profiles: turning bots off leaves the profile dots alone", async () => {
  const dom = createDom("/", `<div data-slot="sidebar-inner"><ul><li data-testid="sidebar-project-folder"><button data-sidebar-row="folder:p/a">Alpha</button></li></ul><div data-slot="sidebar-footer"><ul></ul></div></div>`);
  const doc = dom.window.document;
  const storage = createFakeChromeStorage();
  const profiles = createProfiles({ win: dom.window, doc, area: storage.area, changedEvent: storage.onChanged });
  await profiles.start();
  const stray = doc.createElement("span");
  stray.setAttribute("data-t3plus-owned", "");
  doc.querySelector("ul").append(stray);
  clearBotDecoration(doc.querySelector('[data-slot="sidebar-inner"]'));
  assert.equal(stray.isConnected, false, "bot leftovers still go");
  assert.ok(doc.querySelector(".t3plus-profiles-name"), "the profile name stays");
  assert.equal(doc.querySelectorAll(".t3plus-profile-dot").length, 2, "the dot and the add button stay");
  profiles.stop();
});

test("profiles: Ctrl+Shift+1..9 opens that profile, and each dot wears its profile's color", async () => {
  const dom = createDom("/", `<div data-slot="sidebar-inner"><ul></ul><div data-slot="sidebar-footer"><ul></ul></div></div>`);
  const doc = dom.window.document;
  const storage = createFakeChromeStorage();
  const profiles = createProfiles({ win: dom.window, doc, area: storage.area, changedEvent: storage.onChanged });
  await profiles.start();
  await profiles.save({ ...profiles.state, list: [...profiles.state.list, { id: "work", name: "Work", color: "green" }] });
  const dot = doc.querySelector('.t3plus-profile-dot[data-profile="work"]');
  assert.equal(dot.style.getPropertyValue("--t3plus-profile-color"), PROFILE_COLORS.green);
  assert.equal(doc.querySelector('.t3plus-profile-dot[data-profile="main"]').style.getPropertyValue("--t3plus-profile-color"), "", "default: T3's own dot color");
  doc.dispatchEvent(new dom.window.KeyboardEvent("keydown", { code: "Digit2", ctrlKey: true, bubbles: true }));
  assert.equal(profiles.state.active, "main", "Ctrl alone does nothing");
  doc.dispatchEvent(new dom.window.KeyboardEvent("keydown", { code: "Digit2", ctrlKey: true, shiftKey: true, bubbles: true }));
  assert.equal(profiles.state.active, "work");
  doc.dispatchEvent(new dom.window.KeyboardEvent("keydown", { code: "Digit2", metaKey: true, bubbles: true }));
  doc.dispatchEvent(new dom.window.KeyboardEvent("keydown", { code: "Digit1", metaKey: true, bubbles: true }));
  assert.equal(profiles.state.active, "work", "Cmd+digit is left to T3");
  doc.dispatchEvent(new dom.window.KeyboardEvent("keydown", { code: "Digit1", ctrlKey: true, shiftKey: true, bubbles: true }));
  assert.equal(profiles.state.active, "main");
  profiles.stop();
});

test("profiles: the first profile has no delete button; another one's projects return to it when deleted", async () => {
  const dom = createDom("/", `<div data-slot="sidebar-inner"><ul></ul><div data-slot="sidebar-footer"><ul></ul></div></div>`);
  const doc = dom.window.document;
  const storage = createFakeChromeStorage();
  const profiles = createProfiles({ win: dom.window, doc, area: storage.area, changedEvent: storage.onChanged });
  await profiles.start();
  await profiles.save({ ...profiles.state, list: [...profiles.state.list, { id: "work", name: "2", color: "blue" }], projects: { "p/b": "work" } });
  const menu = (id) => doc.querySelector(`.t3plus-profile-dot[data-profile="${id}"]`).dispatchEvent(new dom.window.MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
  menu("main");
  assert.equal(doc.querySelector(".t3plus-profile-editor .t3plus-profile-delete"), null, "Main cannot be deleted");
  menu("work");
  doc.querySelector(".t3plus-profile-editor .t3plus-profile-delete").click();
  assert.deepEqual(profiles.state.list.map((p) => p.id), ["main"]);
  assert.deepEqual(profiles.state.projects, { "p/b": "main" }, "its project is back in Main (and still placed, not new)");
  profiles.stop();
});

test("profiles: a drop counts where the chips were, a lost release or a cancel moves nothing, and new names stay unique", async () => {
  const folder = (key, title) => `<li data-testid="sidebar-project-folder"><button data-sidebar-row="folder:${key}"><span class="truncate">${title}</span></button></li>`;
  const dom = createDom("/", `<div data-slot="sidebar-inner"><ul>${folder("p/a", "Alpha")}</ul><div data-slot="sidebar-footer"><ul></ul></div></div>`);
  const doc = dom.window.document;
  const win = dom.window;
  const storage = createFakeChromeStorage();
  const profiles = createProfiles({ win, doc, area: storage.area, changedEvent: storage.onChanged });
  await profiles.start();
  await profiles.save({ ...profiles.state, list: [...profiles.state.list, { id: "work", name: "2", color: "blue" }], projects: { "p/a": "work" }, active: "work" });
  // Layout stand-in: the "Main" chip is under the pointer only while the chips are open,
  // under the shield that holds the grabbing cursor over the page.
  const html = doc.documentElement;
  doc.elementsFromPoint = () => (html.hasAttribute("data-t3plus-profile-drag") ? [doc.querySelector(".t3plus-profile-shield"), doc.querySelector('.t3plus-profile-dot[data-profile="main"]')] : []);
  const header = doc.querySelector('[data-sidebar-row="folder:p/a"]');
  const pe = (target, type, buttons, x = 50, y = 50) => target.dispatchEvent(new win.MouseEvent(type, { bubbles: true, cancelable: true, button: 0, buttons, clientX: x, clientY: y }));
  const startDrag = () => {
    pe(header, "pointerdown", 1, 10, 10);
    pe(doc.body, "pointermove", 1, 40, 40);
    pe(doc.body, "pointermove", 1, 50, 50);
    assert.ok(html.hasAttribute("data-t3plus-profile-drag"), "dragging");
  };
  startDrag();
  assert.ok(doc.querySelector(".t3plus-profile-shield"), "the page under a shield while dragging");
  const selection = new win.Event("selectstart", { bubbles: true, cancelable: true });
  doc.body.dispatchEvent(selection);
  assert.equal(selection.defaultPrevented, true, "no text is selected on the way");
  pe(doc.body, "pointerup", 0);
  assert.equal(profiles.state.projects["p/a"], "main", "dropped on Main's chip: back in Main");
  assert.equal(doc.querySelector(".t3plus-profile-shield"), null, "the shield goes with the drop");

  await profiles.save({ ...profiles.state, projects: { "p/a": "work" } });
  startDrag();
  pe(doc.body, "pointercancel", 0);
  assert.equal(profiles.state.projects["p/a"], "work", "a cancelled pointer is not a drop");
  assert.equal(html.hasAttribute("data-t3plus-profile-drag"), false);
  assert.equal(doc.querySelector(".t3plus-profile-shield"), null);

  startDrag();
  pe(doc.body, "pointermove", 0, 60, 60); // the button came up where no pointerup was delivered
  assert.equal(html.hasAttribute("data-t3plus-profile-drag"), false, "the drag ends");
  assert.equal(doc.querySelector(".t3plus-profile-ghost"), null, "no ghost left following the pointer");
  assert.equal(profiles.state.projects["p/a"], "work");

  // Names: "2" exists; after deleting "2" and keeping "3", a new profile is "4", not a second "3".
  await profiles.save({ ...profiles.state, list: [{ id: "main", name: "Main" }, { id: "c", name: "3" }], projects: {}, active: "main" });
  await new Promise((r) => setTimeout(r, 0)); // a drag's end swallows only the click that ends it
  doc.querySelector('.t3plus-profile-dot[data-profile="+new"]').click();
  await new Promise((r) => setTimeout(r, 200));
  assert.deepEqual(profiles.state.list.map((p) => p.name), ["Main", "3", "4"]);
  // Ctrl+Shift+1 typed in the open rename field does not switch profiles.
  const input = doc.querySelector(".t3plus-profile-editor input");
  assert.ok(input, "the new profile opens its rename field");
  const active = profiles.state.active;
  input.dispatchEvent(new win.KeyboardEvent("keydown", { code: "Digit1", ctrlKey: true, shiftKey: true, bubbles: true }));
  assert.equal(profiles.state.active, active);
  profiles.stop();
});

test("profiles: projects there at first go to the first profile; one added later joins the open profile instead of vanishing", async () => {
  const folder = (key) => `<li data-testid="sidebar-project-folder"><button data-sidebar-row="folder:${key}"><span class="truncate">${key}</span></button></li>`;
  const dom = createDom("/", `<div data-slot="sidebar-inner"><ul id="list">${folder("p/a")}${folder("p/b")}</ul><div data-slot="sidebar-footer"><ul></ul></div></div>`);
  const doc = dom.window.document;
  const storage = createFakeChromeStorage();
  // An existing setup: Work open, p/b moved there, p/a never moved.
  await storage.area.set({ "t3plus.profiles.v2": { active: "work", list: [{ id: "main", name: "Main" }, { id: "work", name: "Work" }], projects: { "p/b": "work" } } });
  const realNow = Date.now;
  let now = realNow();
  Date.now = () => now;
  try {
    const profiles = createProfiles({ win: dom.window, doc, area: storage.area, changedEvent: storage.onChanged });
    await profiles.start();
    assert.equal(profiles.state.projects["p/a"], "main", "a project that was already there stays in the first profile");
    assert.ok(doc.querySelector('[data-sidebar-row="folder:p/a"]').closest("li").hasAttribute("data-t3plus-profile-off"));
    now += 11_000; // later, in Work: a new project
    doc.getElementById("list").insertAdjacentHTML("beforeend", folder("p/new"));
    profiles.sync();
    assert.equal(profiles.state.projects["p/new"], "work", "the new project joins the open profile");
    assert.equal(doc.querySelector('[data-sidebar-row="folder:p/new"]').closest("li").hasAttribute("data-t3plus-profile-off"), false, "and stays in view");
    assert.equal(profiles.state.adopted, true);
    // Saved once per new project: syncing again writes nothing.
    let writes = 0;
    const set = storage.area.set;
    storage.area.set = async (items) => ((writes += 1), set(items));
    profiles.sync();
    profiles.sync();
    assert.equal(writes, 0);
    storage.area.set = set;
    // An older backup imported later (no adoption mark, Work open): its unplaced
    // projects are existing ones and go to the first profile, not the open one.
    // (Once this window's save has landed: storage reports no change for a value it holds.)
    await new Promise((r) => setTimeout(r, 0));
    now += 60_000;
    await storage.area.set({ "t3plus.profiles.v2": { active: "work", list: [{ id: "main", name: "Main" }, { id: "work", name: "Work" }], projects: { "p/b": "work" } } });
    profiles.sync();
    assert.equal(profiles.state.projects["p/new"], "main");
    assert.equal(profiles.state.projects["p/a"], "main");
    assert.equal(profiles.state.projects["p/b"], "work");
    profiles.stop();
  } finally {
    Date.now = realNow;
  }
});

test("profiles from the keyboard: arrows move between dots, F2 renames, tabbing out keeps the typed name, Escape cancels back to the dot", async () => {
  const dom = createDom("/", `<div data-slot="sidebar-inner"><ul></ul><div data-slot="sidebar-footer"><button id="out">Settings</button></div></div>`);
  const win = dom.window;
  const doc = win.document;
  const storage = createFakeChromeStorage();
  await storage.area.set({ "t3plus.profiles.v2": { active: "main", list: [{ id: "main", name: "Main" }, { id: "work", name: "Work" }], projects: {} } });
  const profiles = createProfiles({ win, doc, area: storage.area, changedEvent: storage.onChanged });
  await profiles.start();
  const dot = (id) => doc.querySelector(`.t3plus-profile-dot[data-profile="${id}"]`);
  const key = (el, k) => el.dispatchEvent(new win.KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true }));
  assert.equal(doc.querySelector(".t3plus-profiles-dots").getAttribute("role"), "toolbar");
  assert.equal(dot("main").tabIndex, 0, "the open profile is the one Tab stop");
  assert.equal(dot("work").tabIndex, -1);
  dot("main").focus();
  key(dot("main"), "ArrowRight");
  assert.equal(doc.activeElement, dot("work"));
  key(dot("work"), "F2");
  const input = doc.querySelector(".t3plus-profile-editor input");
  assert.equal(doc.activeElement, input, "F2 opens the rename field");
  input.value = "Clients";
  doc.querySelector(".t3plus-profile-editor .t3plus-profile-swatch").focus(); // Tab on through the editor...
  await new Promise((r) => setTimeout(r, 5));
  assert.ok(doc.querySelector(".t3plus-profile-editor"), "still open while focus is inside it");
  doc.getElementById("out").focus(); // ...and out of it
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(doc.querySelector(".t3plus-profile-editor"), null, "closed once focus left it");
  assert.equal(profiles.state.list[1].name, "Clients", "and the typed name was kept");
  key(dot("work"), "F2");
  doc.querySelector(".t3plus-profile-editor input").value = "Nope";
  key(doc.querySelector(".t3plus-profile-editor .t3plus-profile-swatch"), "Escape");
  assert.equal(doc.querySelector(".t3plus-profile-editor"), null, "Escape from a swatch closes it too");
  assert.equal(profiles.state.list[1].name, "Clients", "without renaming");
  assert.equal(doc.activeElement, dot("work"), "focus goes back to the dot");
  profiles.stop();
});

test("profiles: hidden rows are inert (T3's arrow keys skip them), the swipe listener lives on the sidebar, and the terminal keeps Ctrl+Shift+digits", async () => {
  const folder = (key, title) => `<li data-testid="sidebar-project-folder"><button data-sidebar-row="folder:${key}"><span class="truncate">${title}</span></button></li>`;
  const dom = createDom("/", `<div data-slot="sidebar-inner"><ul>${folder("p/a", "Alpha")}${folder("p/b", "Beta")}</ul><div data-slot="sidebar-footer"><ul></ul></div></div><div data-thread-terminal-drawer><textarea class="xterm-helper-textarea"></textarea></div>`);
  const doc = dom.window.document;
  const win = dom.window;
  const added = [];
  const docAdd = doc.addEventListener.bind(doc);
  doc.addEventListener = (type, fn, opts) => (added.push(type), docAdd(type, fn, opts));
  const storage = createFakeChromeStorage();
  const profiles = createProfiles({ win, doc, area: storage.area, changedEvent: storage.onChanged });
  await profiles.start();
  assert.ok(!added.includes("wheel"), "no wheel listener on the document");
  await profiles.save({ ...profiles.state, list: [...profiles.state.list, { id: "work", name: "Work" }], projects: { "p/b": "work" } });
  const beta = doc.querySelector('[data-sidebar-row="folder:p/b"]').closest("li");
  assert.ok(beta.hasAttribute("data-t3plus-profile-off") && beta.hasAttribute("inert"), "hidden and inert");
  // A sideways swipe on the sidebar still switches.
  const inner = doc.querySelector('[data-slot="sidebar-inner"]');
  for (let i = 0; i < 4; i += 1) inner.dispatchEvent(new win.WheelEvent("wheel", { bubbles: true, cancelable: true, deltaX: 30, deltaY: 0 }));
  assert.equal(profiles.state.active, "work");
  assert.ok(!beta.hasAttribute("inert"), "shown again: not inert");
  // In the terminal, Ctrl+Shift+1 is the program's.
  doc.querySelector(".xterm-helper-textarea").dispatchEvent(new win.KeyboardEvent("keydown", { code: "Digit1", ctrlKey: true, shiftKey: true, bubbles: true }));
  assert.equal(profiles.state.active, "work");
  profiles.stop();
  assert.equal(doc.querySelectorAll("[inert]").length, 0, "stop() leaves nothing inert");
});

test("profiles: screenshot mode shows Profile 1, Profile 2 instead of the names", async () => {
  const dom = createDom("/", `<div data-slot="sidebar-inner"><ul></ul><div data-slot="sidebar-footer"><ul></ul></div></div>`);
  const doc = dom.window.document;
  let demo = false;
  const storage = createFakeChromeStorage();
  const profiles = createProfiles({ win: dom.window, doc, area: storage.area, changedEvent: storage.onChanged, isDemo: () => demo });
  await profiles.start();
  await profiles.save({ ...profiles.state, list: [...profiles.state.list, { id: "w", name: "Acme payroll", color: "blue" }] });
  const dot = () => doc.querySelector('.t3plus-profile-dot[data-profile="w"]');
  assert.match(dot().title, /Acme payroll/);
  demo = true;
  profiles.sync();
  assert.ok(!dot().title.includes("Acme") && dot().textContent === "Profile 2", dot().title);
  demo = false;
  profiles.sync();
  assert.equal(dot().textContent, "Acme payroll");
  profiles.stop();
});

test("profiles: right-click a folder → Move to profile (T3's native menu gets the submenu; a pick moves it)", async () => {
  const folder = (key, title) => `<li data-testid="sidebar-project-folder"><button data-sidebar-row="folder:${key}"><span class="truncate">${title}</span></button></li>`;
  const dom = createDom("/", `<div data-slot="sidebar-inner"><ul>${folder("p/a", "Alpha")}${folder("p/b", "Beta")}<li><div data-sidebar-row="env1:t1">t1</div></li></ul><div data-slot="sidebar-footer"><ul></ul></div></div>`);
  const doc = dom.window.document;
  const storage = createFakeChromeStorage();
  let on = true;
  const profiles = createProfiles({ win: dom.window, doc, area: storage.area, changedEvent: storage.onChanged, isEnabled: () => on });
  await profiles.start();
  await profiles.save({ ...profiles.state, list: [...profiles.state.list, { id: "work", name: "Work" }] });
  const rightClick = (el) => el.dispatchEvent(new dom.window.MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
  assert.equal(profiles.projectMenu(), null, "nothing right-clicked yet");
  rightClick(doc.querySelector('[data-sidebar-row="env1:t1"]'));
  assert.equal(profiles.projectMenu(), null, "a thread is not a folder");
  rightClick(doc.querySelector('[data-sidebar-row="folder:p/b"] .truncate'));
  const menu = profiles.projectMenu();
  assert.equal(menu.label, "Move to profile");
  assert.equal(menu.separatorBefore, true);
  assert.deepEqual(menu.children.map((c) => [c.label, c.checked === true, c.disabled === true]), [["Main", true, true], ["Work", false, false], ["New profile", false, false]], "its own profile checked and not pickable");
  assert.ok(menu.children.every((c) => c.id.startsWith("t3plus:move:")), "ids T3 does not know");
  assert.equal(profiles.projectMenuPick("t3plus:move:work"), true);
  assert.equal(profiles.state.projects["p/b"], "work", "moved, as a drag onto the dot does");
  assert.equal(doc.querySelector('[data-sidebar-row="folder:p/b"]').closest("li").hasAttribute("data-t3plus-profile-off"), true, "and hidden here");
  assert.equal(profiles.projectMenuPick("t3plus:move:main"), false, "one pick per right-click");
  // A menu closed without a pick (the loader says so with null): the folder is forgotten.
  rightClick(doc.querySelector('[data-sidebar-row="folder:p/b"]'));
  assert.equal(profiles.projectMenuPick(null), false);
  assert.equal(profiles.projectMenu(), null, "a menu opened later is not about it");
  assert.equal(profiles.state.projects["p/b"], "work");
  // A new profile: made, and the folder in it.
  rightClick(doc.querySelector('[data-sidebar-row="folder:p/a"]'));
  assert.equal(profiles.projectMenuPick("t3plus:move:+new"), true);
  assert.equal(profiles.state.list.length, 3);
  assert.equal(profiles.state.projects["p/a"], profiles.state.list[2].id);
  doc.querySelector(".t3plus-profile-editor")?.remove();
  // An unknown profile, T3's own ids, or profiles off: nothing moves.
  rightClick(doc.querySelector('[data-sidebar-row="folder:p/a"]'));
  assert.equal(profiles.projectMenuPick("t3plus:move:nope"), false);
  rightClick(doc.querySelector('[data-sidebar-row="folder:p/a"]'));
  assert.equal(profiles.projectMenuPick("copy-path"), false);
  on = false;
  rightClick(doc.querySelector('[data-sidebar-row="folder:p/a"]'));
  assert.equal(profiles.projectMenu(), null, "profiles off: no submenu");
  profiles.stop();
});

test("the open thread's note, written a moment later, is no unhandled rejection when storage turns it down", async (t) => {
  const s = setup(folder("p/a") + thread("env:a1", "folder:p/a") + thread("env:a2", "folder:p/a"), TWO);
  await s.profiles.start();
  const unhandled = [];
  const onUnhandled = (reason) => unhandled.push(reason);
  process.on("unhandledRejection", onUnhandled);
  t.after(() => process.off("unhandledRejection", onUnhandled));
  s.storage.area.set = async () => {
    throw new Error("QUOTA_BYTES quota exceeded");
  };
  s.go("/env/a2"); // a thread opened in Main: noted for it, written 400 ms later
  assert.equal(s.profiles.state.last.main, "env:a2");
  await new Promise((resolve) => setTimeout(resolve, 450));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(unhandled, []);
  s.profiles.stop();
});
