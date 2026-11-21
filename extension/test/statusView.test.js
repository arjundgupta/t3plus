import assert from "node:assert/strict";
import { test } from "node:test";
import { BOT_SHAPES, BOT_SKINS, STORAGE_KEYS } from "../src/config.js";
import { createProfiles } from "../src/profiles.js";
import { scanSidebar } from "../src/sidebar.js";
import { parseRowStatus, resolveBotPresentation } from "../src/bots.js";
import { ago, BOT_STATUS, BOT_STATUS_COLORS, buildStatusModel, createStatusView, normalizeViewState, parseThreadsFeedText, rowStatus, createViewStore, STATUS_BOT_COLORS } from "../src/statusView.js";
import { createApp, createDom, createFakeChromeStorage, cssRules, settle, threadRowHtml } from "./helpers.js";

const ENV = "env1";
const MIN = 60_000;
const NOW = Date.parse("2026-11-20T12:00:00Z");
const iso = (minutesAgo) => new Date(NOW - minutesAgo * MIN).toISOString();

const FEED = {
  version: 1,
  generatedAt: iso(0),
  environmentId: ENV,
  projects: {
    papi: { title: "API", keys: ["github.com/Acme/api", `${ENV}:/src/api`] },
    pweb: { title: "Web", keys: [`${ENV}:/src/web`] },
  },
  threads: [
    { id: "a1", project: "papi", title: "Fix login", status: "approval", at: iso(3) },
    { id: "a2", project: "papi", title: "Add metrics", status: "working", at: iso(10) },
    { id: "a3", project: "papi", title: "Old idea", status: "idle", at: iso(60 * 30) },
    { id: "w1", project: "pweb", title: "Landing page", status: "done", at: iso(5) },
    { id: "w2", project: "pweb", title: "Footer", status: "failed", at: iso(1) },
    { id: "w3", project: "pweb", title: "Copy", status: "input", at: iso(8) },
  ],
};
const folder = (key, title) => `<li data-testid="sidebar-project-folder"><button type="button" data-sidebar-row="folder:${key}"><span class="truncate">${title}</span></button></li>`;

test("the feed: threads and projects, checked; anything odd is dropped", () => {
  const feed = parseThreadsFeedText(JSON.stringify(FEED));
  assert.equal(feed.threads.length, 6);
  assert.deepEqual(feed.threads[0], { key: "env1:a1", project: "papi", title: "Fix login", status: "approval", at: NOW - 3 * MIN });
  assert.deepEqual(feed.projects.get("pweb"), { title: "Web", keys: ["env1:/src/web"] });
  const odd = parseThreadsFeedText(JSON.stringify({ ...FEED, threads: [{ id: "x y", status: "working" }, { id: "b", status: "sleeping" }, { id: "c", status: "done", project: "nope", title: 5 }] }));
  assert.deepEqual(odd.threads, [{ key: "env1:c", project: null, title: "", status: "done", at: null }]);
  for (const bad of ["", "{", JSON.stringify({ version: 2 }), JSON.stringify({ ...FEED, environmentId: "a:b" }), JSON.stringify({ ...FEED, threads: {} })]) assert.equal(parseThreadsFeedText(bad), null, bad);
});

test("T3's status words on its rows, and ages as T3 writes them", () => {
  assert.equal(rowStatus("Fix login, Approval, API", "Fix login"), "approval");
  assert.equal(rowStatus("Fix login, Goal, API", "Fix login"), "goal");
  assert.equal(rowStatus("Fix login, Setting up, API", "Fix login"), "preparing");
  assert.equal(rowStatus("Fix login, API", "Fix login"), "idle");
  assert.equal(rowStatus("Other, Done", "Fix login"), "idle");
  assert.deepEqual([0.2, 5, 90, 60 * 30, 60 * 24 * 9, 60 * 24 * 60, 60 * 24 * 800].map((m) => ago(NOW - m * MIN, NOW)), ["now", "5m", "1h", "1d", "1w", "2mo", "2y"]);
  assert.equal(ago(null, NOW), "");
});

test("the model: every thread by what it needs, T3's own rows over the feed, the open profile's only", () => {
  const dom = createDom("/", `<ul id="list">${folder("github.com/acme/api", "API")}${folder("env1:/src/web", "Web")}
    ${threadRowHtml({ key: "env1:a2", title: "Add metrics", parent: "folder:github.com/acme/api", status: "Done", current: true })}
    ${threadRowHtml({ key: "env1:new", title: "Brand new", parent: "folder:github.com/acme/api", status: "Working" })}
    ${threadRowHtml({ key: "env1:s1", title: "Settled one", parent: "shelf:settled" })}
    ${threadRowHtml({ key: "env1:a3", title: "Old idea", parent: "shelf:settled" })}
    ${threadRowHtml({ key: "env1:sub", title: "A subagent", parent: "env1:a2" })}</ul>`);
  const scan = scanSidebar(dom.window.document.body);
  const feed = parseThreadsFeedText(JSON.stringify(FEED));
  const folderTitles = new Map([["github.com/acme/api", "API"], ["env1:/src/web", "Web"]]);
  const groups = buildStatusModel({ scan, feed, folderTitles });
  const shape = groups.map((g) => [g.id, g.rows.map((r) => `${r.key.slice(5)}:${r.status}`)]);
  assert.deepEqual(shape, [
    ["needs", ["a1:approval", "w3:input", "w2:failed"]],
    ["working", ["new:working"]],
    ["done", ["w1:done", "a2:done"]],
  ], "most urgent kind first; T3's word for a row it shows wins; settled, subagent and empty groups left out");
  const a1 = groups[0].rows[0];
  assert.equal(a1.folderKey, "github.com/acme/api", "a repository key in another case still finds its folder");
  assert.equal(a1.project, "API");
  assert.equal(groups[2].rows[1].current, true);
  // Only the open profile's folders.
  const webOnly = buildStatusModel({ scan, feed, folderTitles, include: (key) => key === "env1:/src/web" });
  assert.deepEqual(webOnly.map((g) => [g.id, g.rows.map((r) => r.key.slice(5))]), [["needs", ["w3", "w2"]], ["done", ["w1"]]]);
  // With profiles: a feed thread whose project has no folder here is no profile's.
  const lost = parseThreadsFeedText(JSON.stringify({ ...FEED, projects: { ...FEED.projects, gone: { title: "Gone", keys: ["github.com/x/gone"] } }, threads: [...FEED.threads, { id: "g1", project: "gone", title: "Lost", status: "approval", at: iso(1) }] }));
  const keysOf = (gs) => gs.flatMap((g) => g.rows.map((r) => r.key.slice(5)));
  assert.equal(keysOf(buildStatusModel({ scan, feed: lost, folderTitles, include: (key, fromList) => (key === null ? fromList : true) })).includes("g1"), false);
  // Without the feed (the Chrome extension): what T3's list shows.
  assert.deepEqual(buildStatusModel({ scan, folderTitles }).map((g) => g.id), ["working", "done"]);
});

test("the view: rows kept by thread, only what changed rewritten; folded groups; keys and clicks", () => {
  const dom = createDom("/", "<div id=host></div>");
  const doc = dom.window.document;
  const opened = [];
  const folds = [];
  const faces = [];
  const view = createStatusView(doc, { onOpen: (key) => opened.push(key), onCollapse: (id, c) => folds.push([id, c]), avatar: (el, row) => faces.push(row.key) });
  doc.getElementById("host").append(view.element);
  const row = (key, status, extra = {}) => ({ key, title: key, status, at: NOW - MIN, folderKey: null, project: "API", current: false, ...extra });
  view.update({ groups: [{ id: "needs", label: "Needs you", rows: [row("t1", "approval"), row("t2", "failed")] }, { id: "idle", label: "Idle", rows: [row("t3", "idle")] }], collapsed: { idle: true }, now: NOW });
  const buttons = () => [...doc.querySelectorAll(".t3plus-status-row")];
  assert.deepEqual(buttons().map((b) => b.dataset.thread), ["t1", "t2"], "Idle is folded: its rows are not drawn");
  assert.equal(doc.querySelector('[data-group="idle"] .t3plus-status-count').textContent, "1");
  assert.equal(doc.querySelector('[data-group="idle"] .t3plus-status-head').getAttribute("aria-expanded"), "false");
  assert.equal(buttons()[0].querySelector(".t3plus-status-meta").textContent, "Approval");
  const first = buttons()[0];
  // Again with t2 first and t1 now done: the same elements, moved.
  view.update({ groups: [{ id: "needs", label: "Needs you", rows: [row("t2", "failed")] }, { id: "done", label: "Done", rows: [row("t1", "done", { current: true })] }], collapsed: {}, now: NOW, word: (r) => (r.status === "done" ? "" : "Failed") });
  assert.equal(buttons()[1], first, "t1's row is kept, not rebuilt");
  assert.equal(first.getAttribute("aria-current"), "page");
  assert.equal(first.querySelector(".t3plus-status-meta").textContent, "1m", "no word: its age");
  assert.equal(doc.querySelector('[data-group="idle"]'), null, "a group with no rows goes");
  assert.equal(first.tabIndex, 0, "one Tab stop: the open thread");
  // Keys and clicks.
  first.focus();
  first.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true }));
  assert.equal(doc.activeElement.classList.contains("t3plus-status-head"), true, "up to the Done heading");
  doc.activeElement.click();
  assert.deepEqual(folds, [["done", true]]);
  buttons()[0].click();
  assert.deepEqual(opened, ["t2"]);
  // The focused row moving (its status changed) keeps the focus.
  view.update({ groups: [{ id: "needs", label: "Needs you", rows: [row("t2", "failed"), row("t1", "approval")] }], collapsed: {}, now: NOW });
  const t1 = doc.querySelector('[data-thread="t1"]');
  t1.focus();
  view.update({ groups: [{ id: "needs", label: "Needs you", rows: [row("t1", "approval"), row("t2", "failed")] }], collapsed: {}, now: NOW });
  assert.equal(doc.activeElement, t1, "still focused after moving up");
  assert.equal(t1.tabIndex, 0, "and the Tab stop");
  view.update({ groups: [], collapsed: {}, now: NOW });
  assert.equal(doc.querySelector(".t3plus-status-empty").hidden, false);
  view.destroy();
  assert.equal(view.element.isConnected, false);
});

test("which view, and what is folded: Projects and a folded Idle to start; stored and heard", async () => {
  assert.deepEqual(normalizeViewState({ view: "status", collapsed: { done: true, idle: "x" } }), { view: "status", collapsed: { needs: false, working: false, done: true, idle: true } });
  assert.equal(normalizeViewState({ view: "grid" }).view, "projects");
  const storage = createFakeChromeStorage();
  const store = createViewStore(storage.area, storage.onChanged);
  const heard = [];
  store.subscribe((v) => heard.push(v.view));
  await store.save({ view: "status" });
  assert.equal((await store.load()).view, "status");
  assert.deepEqual(heard, ["status"]);
});

// ---------- In the app ----------

function sidebar() {
  return `<div data-slot="sidebar-inner">
    <div data-slot="sidebar-content"><ul id="t3-list">
      ${folder("github.com/acme/api", "API")}
      ${threadRowHtml({ key: "env1:a2", title: "[[t3plus:bot:v1]] Metrics bot", parent: "folder:github.com/acme/api", status: "Working" })}
      ${folder("env1:/src/web", "Web")}
    </ul></div>
    <div data-slot="sidebar-footer" id="footer"></div>
  </div>`;
}

test("the Status view in the sidebar: a button switches T3's list for threads by status (a collapsed folder's too), and back", async () => {
  const dom = createDom("/env1/a2", sidebar());
  const doc = dom.window.document;
  const storage = createFakeChromeStorage();
  storage.area.data.set(STORAGE_KEYS.settings, { sidebar: { bots: true, botsDefault: false, statusColors: true } });
  storage.area.data.set(STORAGE_KEYS.bots, { "env1:a2": { color: "purple" } });
  // The open thread's breadcrumb (T3's header).
  const marked = "[[t3plus:bot:v1]] Metrics bot";
  doc.body.insertAdjacentHTML("afterbegin", `<nav aria-label="Thread breadcrumb"><button type="button" aria-label="Thread actions for ${marked}"><h2>${marked}</h2></button></nav>`);
  const { app } = createApp(dom, storage, {
    viewStore: createViewStore(storage.area, storage.onChanged),
    threadsFeed: { load: async () => parseThreadsFeedText(JSON.stringify(FEED)) },
  });
  await app.start();
  app.watcher.flush();
  // Status colors paint the Status view only: in T3's list the bot wears its own color.
  const paintOf = (status, color) => resolveBotPresentation({ key: "env1:a2", titleLabel: "Metrics bot", status }, { color }).fill;
  const rowFace = () => doc.querySelector('[data-sidebar-row="env1:a2"] .t3plus-bot-avatar').style.getPropertyValue("--t3plus-bot-fill");
  // Its hover card (T3's tooltip popup) and the breadcrumb: the same.
  doc.body.insertAdjacentHTML("beforeend", `<div data-slot="tooltip-positioner"><div data-slot="tooltip-popup"><div data-slot="tooltip-viewport">
    <div class="flex flex-col"><div class="min-w-0 truncate text-xs leading-tight font-medium text-foreground">${marked}</div></div></div></div></div>`);
  await new Promise((r) => setTimeout(r, 0));
  const crumbFace = () => doc.querySelector("[data-t3plus-bot-breadcrumb]").style.getPropertyValue("--t3plus-bot-fill");
  const cardFace = () => doc.querySelector("[data-t3plus-bot-hover]").style.getPropertyValue("--t3plus-bot-fill");
  const faces = () => [rowFace(), crumbFace(), cardFace()];
  const own = Array(3).fill(paintOf("working", "purple"));
  assert.deepEqual(faces(), own, "the sidebar row, breadcrumb and hover card: its own purple, Status colors on");
  app.actions.setSidebarFeature("statusColors", false);
  app.watcher.flush();
  assert.deepEqual(faces(), own, "and off");
  app.actions.setSidebarFeature("statusColors", true);
  app.watcher.flush();
  assert.deepEqual(faces(), own);
  const toggle = doc.querySelector(".t3plus-status-toggle");
  assert.ok(toggle, "a button in the footer");
  assert.equal(toggle.getAttribute("aria-pressed"), "false");
  toggle.click();
  await settle();
  app.watcher.flush();
  await settle(); // the feed, read on arrival
  app.watcher.flush();
  const list = doc.getElementById("t3-list");
  assert.equal(list.hasAttribute("data-t3plus-status-hidden"), true, "T3's list hidden, still in the page");
  assert.equal(list.hasAttribute("inert"), true, "and inert: T3's arrow keys skip it");
  const view = doc.querySelector(".t3plus-status-view");
  assert.equal(view.nextElementSibling, list, "the view where the list is");
  assert.equal(toggle.getAttribute("aria-pressed"), "true");
  assert.equal(storage.area.data.get(STORAGE_KEYS.sidebarView).view, "status", "remembered");
  const keys = [...doc.querySelectorAll(".t3plus-status-row")].map((b) => b.dataset.thread);
  assert.deepEqual(keys, ["env1:a1", "env1:w3", "env1:w2", "env1:a2", "env1:w1"], "the feed's threads (Web is collapsed in T3's list), Idle folded");
  // T3's own row wins: a2 is working there (the feed said so too) and is a bot: its face, in Working's color.
  const bot = doc.querySelector('[data-thread="env1:a2"]');
  assert.equal(bot.querySelector(".t3plus-status-title").textContent, "Metrics bot", "the bot's name, without its marker");
  const face = bot.querySelector(".t3plus-status-face");
  assert.ok(face.classList.contains("t3plus-bot-avatar"));
  assert.equal(face.style.getPropertyValue("--t3plus-bot-fill"), paintOf("working", "yellow"), "here Status colors paint it: Working's amber");
  assert.deepEqual(faces(), own, "its row (hidden), the breadcrumb and the hover card keep its own purple");
  assert.ok(doc.querySelector('[data-thread="env1:a1"] .t3plus-status-face').classList.contains("t3plus-status-dot"), "not a bot: a dot");
  // A thread T3's list shows (hidden and inert): T3's own row is clicked, inert lifted for it.
  const clicked = [];
  doc.querySelector('[data-sidebar-row="env1:a2"]').addEventListener("click", (e) => clicked.push(e.currentTarget.closest("[inert]") === null));
  doc.querySelector('[data-thread="env1:a2"]').click();
  assert.deepEqual(clicked, [true], "T3's navigation, as if its row was clicked");
  assert.equal(list.hasAttribute("inert"), true, "inert again after");
  // Opening a thread T3's list does not show: by its address.
  doc.querySelector('[data-thread="env1:w1"]').click();
  assert.equal(dom.window.location.pathname, "/env1/w1");
  // Back to T3's list.
  toggle.click();
  app.watcher.flush();
  assert.equal(list.hasAttribute("data-t3plus-status-hidden"), false);
  assert.equal(list.hasAttribute("inert"), false);
  assert.equal(doc.querySelector(".t3plus-status-view"), null);
  // Stopping leaves nothing.
  toggle.click();
  app.watcher.flush();
  app.stop();
  assert.equal(doc.querySelector(".t3plus-status-view, .t3plus-status-toggle"), null);
  assert.equal(list.hasAttribute("data-t3plus-status-hidden"), false);
});

test("with profiles: only the open profile's threads, and its folders' names", async () => {
  const dom = createDom("/env1/a2", sidebar());
  const doc = dom.window.document;
  const storage = createFakeChromeStorage();
  storage.area.data.set(STORAGE_KEYS.profiles, { active: "main", list: [{ id: "main", name: "Main" }, { id: "web", name: "Web" }], projects: { "github.com/acme/api": "main", "env1:/src/web": "web" }, adopted: true });
  storage.area.data.set(STORAGE_KEYS.sidebarView, { view: "status" });
  let appRef = null;
  const profiles = createProfiles({ win: dom.window, doc, area: storage.area, changedEvent: storage.onChanged, onShown: (id) => appRef?.profileShown(id) });
  const { app } = createApp(dom, storage, {
    profiles,
    viewStore: createViewStore(storage.area, storage.onChanged),
    threadsFeed: { load: async () => parseThreadsFeedText(JSON.stringify(FEED)) },
  });
  appRef = app;
  await app.start();
  await settle();
  app.watcher.flush();
  await settle();
  app.watcher.flush();
  const keys = () => [...doc.querySelectorAll(".t3plus-status-row")].map((b) => b.dataset.thread);
  assert.deepEqual(keys(), ["env1:a1", "env1:a2"], "Main: API's threads only");
  assert.equal(doc.querySelector('[data-thread="env1:a1"] .t3plus-status-project').textContent, "API");
  assert.ok(doc.querySelector(".t3plus-profiles > .t3plus-status-toggle"), "the button beside the dots");
  profiles.switchTo("web");
  app.watcher.flush();
  assert.deepEqual(keys(), ["env1:w3", "env1:w2", "env1:w1"], "Web's");
  app.stop();
});

test("a fork T3 nests under its thread keeps its own row (with T3's word); a subagent or side chat does not", () => {
  const dom = createDom("/", `<ul>${threadRowHtml({ key: "env1:parent", title: "Parent", parent: "folder:github.com/acme/api" })}
    ${threadRowHtml({ key: "env1:fork", title: "Fork", parent: "env1:parent", status: "Input" })}
    ${threadRowHtml({ key: "env1:sub", title: "Sub", parent: "env1:parent", status: "Working" })}</ul>`);
  const feed = parseThreadsFeedText(JSON.stringify({ ...FEED, threads: [{ id: "fork", project: "papi", title: "Fork", status: "working", at: iso(2) }, { id: "parent", project: "papi", title: "Parent", status: "idle", at: iso(9) }] }));
  const groups = buildStatusModel({ scan: scanSidebar(dom.window.document.body), feed, folderTitles: new Map([["github.com/acme/api", "API"]]) });
  const rows = groups.flatMap((g) => g.rows);
  assert.deepEqual(rows.map((r) => `${r.key.slice(5)}:${r.status}`), ["fork:input", "parent:idle"], "the fork's live word over the feed's; the subagent is its parent's");
  assert.equal(rows[0].folderKey, "github.com/acme/api", "the fork's folder from the feed (its row names its thread)");
});

test("Goal: T3's Working while the thread pursues an active goal, worded Goal, in Working and drawn as it", async () => {
  // The feed: a flag beside "working" (a reader that does not know it shows Working); not on another status.
  const feed = parseThreadsFeedText(JSON.stringify({ ...FEED, threads: [
    { id: "g1", project: "pweb", title: "Goal one", status: "working", goal: true, at: iso(4) },
    { id: "g2", project: "pweb", title: "Waits", status: "waiting", goal: true, at: iso(3) },
    { id: "g3", project: "pweb", title: "Odd flag", status: "working", goal: "yes", at: iso(2) },
  ] }));
  assert.deepEqual(feed.threads.map((t) => t.status), ["goal", "waiting", "working"]);
  // T3's own row says "Goal" too: the same status; both in Working, after the plain working ones.
  const dom = createDom("/", `<ul>${folder("env1:/src/web", "Web")}${threadRowHtml({ key: "env1:live", title: "Live goal", parent: "folder:env1:/src/web", status: "Goal" })}</ul>`);
  const groups = buildStatusModel({ scan: scanSidebar(dom.window.document.body), feed, folderTitles: new Map([["env1:/src/web", "Web"]]) });
  assert.deepEqual(groups.map((g) => [g.id, g.rows.map((r) => `${r.key.slice(5)}:${r.status}`)]), [["working", ["g3:working", "live:goal", "g1:goal", "g2:waiting"]]]);
  assert.equal(BOT_STATUS.goal, "working", "a bot's face works on");
  // In the sidebar (app.js's own words: Working's rows show their age, a goal's its word).
  const page = createDom("/env1/a2", sidebar());
  const doc = page.window.document;
  const storage = createFakeChromeStorage();
  storage.area.data.set(STORAGE_KEYS.sidebarView, { view: "status" });
  const { app } = createApp(page, storage, {
    viewStore: createViewStore(storage.area, storage.onChanged),
    threadsFeed: { load: async () => parseThreadsFeedText(JSON.stringify({ ...FEED, threads: [...FEED.threads, { id: "g1", project: "pweb", title: "Goal one", status: "working", goal: true, at: iso(4) }] })) },
  });
  await app.start();
  await settle();
  app.watcher.flush();
  await settle();
  app.watcher.flush();
  const goal = doc.querySelector('[data-thread="env1:g1"]');
  assert.ok(goal.closest('[data-group="working"]'), "in Working");
  assert.equal(goal.querySelector(".t3plus-status-meta").textContent, "Goal");
  assert.equal(goal.getAttribute("aria-label"), "Goal one, Goal, Web");
  assert.deepEqual([goal.dataset.status, goal.querySelector(".t3plus-status-meta").dataset.status], ["goal", "goal"]);
  const rule = cssRules().find((r) => r.sel.includes('[data-status="goal"]'));
  assert.ok(rule?.sel.includes('[data-status="working"]'), "colored as Working is (T3 draws both alike)");
  const plain = doc.querySelector('[data-thread="env1:a2"] .t3plus-status-meta');
  assert.deepEqual([plain.dataset.status, /^(now|\d+(m|h|d|w|mo|y))$/.test(plain.textContent)], ["", true], "a plain working row: its age, no word");
  app.stop();
});

test("the feed is parsed again only when its text changes", async () => {
  const { createThreadsFeed } = await import("../src/statusView.js");
  let text = JSON.stringify(FEED);
  const feed = createThreadsFeed({ fetchRemote: async () => ({ ok: true, text }), endpoint: "x" });
  const a = await feed.load();
  assert.equal(await feed.load(), a, "the same object");
  text = JSON.stringify({ ...FEED, threads: FEED.threads.slice(1) });
  assert.notEqual(await feed.load(), a);
  const failing = createThreadsFeed({ fetchRemote: async () => { throw new Error("x"); }, endpoint: "x" });
  assert.equal(await failing.load(), null);
});

test("Status colors: a traffic light, the same for a status word and its face's status; idle a color no picker offers", () => {
  assert.deepEqual(BOT_STATUS_COLORS, { attention: "orange", failed: "red", working: "yellow", waiting: "yellow", done: "green", idle: "blue" });
  // Written out: built from the two tables above, it would only be checked against itself.
  assert.deepEqual(STATUS_BOT_COLORS, {
    ...Object.fromEntries(["approval", "input", "request", "woke"].map((s) => [s, "orange"])), // everything that needs you
    limited: "orange", // a usage limit wants you, as in T3 (its warning color)
    failed: "red",
    ...Object.fromEntries(["preparing", "working", "goal", "waiting"].map((s) => [s, "yellow"])),
    done: "green",
    idle: "blue",
  });
  // The sidebar's faces (bots.js) read each of T3's words as the Status view does.
  for (const word of ["Approval", "Input", "Request", "Limited", "Failed", "Woke", "Setting up", "Goal", "Working", "Waiting", "Done"]) {
    assert.equal(BOT_STATUS[rowStatus(`t, ${word}`, "t")], parseRowStatus(`t, ${word}`, "t"), word);
  }
  assert.equal(resolveBotPresentation({ key: "env1:x", titleLabel: "X", status: "idle" }, { color: "blue" }).paint, "blue");
  // A ball keeps its own colors under Status colors: drawn just as without them, with no ring.
  const ball = (color, statusColors) => resolveBotPresentation({ key: "env1:x", titleLabel: "X", status: "working" }, { shape: "soccer", color, statusColors });
  const face = ({ fill, clip, edge }) => ({ fill, clip, edge });
  assert.deepEqual(face(ball("yellow", true)), face(ball("orange", false)), "the ball as it is, whatever the status's color");
  assert.equal(ball("yellow", true).edge, BOT_SKINS.soccer.stops[1], "its own edge");
  assert.equal("ring" in ball("yellow", true), false, "and nothing of a ring");
  const saturn = resolveBotPresentation({ key: "env1:x", status: "failed" }, { shape: "saturn", color: "red", statusColors: true });
  assert.deepEqual([saturn.clip, saturn.edge], [BOT_SHAPES.saturn, "transparent"], "a planet with sky in its own clip, its sky see-through");
});

test("a feed project keeps its own folder when another folder's key differs from it only in case", () => {
  const feed = parseThreadsFeedText(JSON.stringify({
    ...FEED,
    projects: { upper: { title: "Upper", keys: ["github.com/Acme/api"] }, lower: { title: "Lower", keys: ["github.com/acme/api"] } },
    threads: [
      { id: "u1", project: "upper", title: "Upper's", status: "working", at: iso(1) },
      { id: "l1", project: "lower", title: "Lower's", status: "working", at: iso(2) },
    ],
  }));
  const folderTitles = new Map([["github.com/Acme/api", "Acme API"], ["github.com/acme/api", "acme api"]]);
  const rows = buildStatusModel({ scan: null, feed, folderTitles }).flatMap((g) => g.rows);
  const row = (id) => rows.find((r) => r.key === `${ENV}:${id}`);
  assert.deepEqual([row("u1").folderKey, row("u1").project], ["github.com/Acme/api", "Acme API"], "its exact key, not the other case's");
  assert.deepEqual([row("l1").folderKey, row("l1").project], ["github.com/acme/api", "acme api"]);
});
