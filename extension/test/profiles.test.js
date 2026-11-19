import assert from "node:assert/strict";
import { test } from "node:test";
import { createProfiles } from "../src/profiles.js";
import { STORAGE_KEYS } from "../src/config.js";
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
  assert.ok(["/env/b-deleted", "/env/b1"].includes(gone.route()));
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
