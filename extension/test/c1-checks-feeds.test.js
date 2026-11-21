import assert from "node:assert/strict";
import { test } from "node:test";
import { createBotFeed } from "../src/botFeed.js";
import { STORAGE_KEYS } from "../src/config.js";
import { createProfiles } from "../src/profiles.js";
import { createScopesStore, emptyScopes, setScopeValues } from "../src/settingsScopes.js";
import { defaultSettings } from "../src/settings.js";
import { createApp, createDom, createFakeChromeStorage, settle, sidebarHtml, threadRowHtml } from "./helpers.js";

const botFeedText = (text) => JSON.stringify({ version: 1, generatedAt: "2026-11-16T14:00:00Z", bots: { bot1: { text, role: "assistant", at: "2026-11-16T14:00:00Z" } } });

test("the bot feed read again unchanged is the same object, not parsed again; a new text is a new feed", async () => {
  const storage = createFakeChromeStorage();
  let text = botFeedText("Deployed the fix");
  const feed = createBotFeed({ area: storage.area, fetchRemote: async () => ({ ok: true, status: 200, text }) });
  const first = await feed.load();
  assert.equal(await feed.load(), first, "same text: the same feed");
  text = botFeedText("Opened a PR");
  const next = await feed.load();
  assert.notEqual(next, first);
  assert.equal(next.entries.get("bot1").text, "Opened a PR");
});

test("an unchanged bot feed read again (a push of another feed, the poll) redraws nothing and runs no check", async () => {
  const dom = createDom("/env1/bot1", sidebarHtml());
  const storage = createFakeChromeStorage();
  storage.area.data.set(STORAGE_KEYS.settings, { sidebar: { bots: true, botsDefault: true } });
  let text = botFeedText("Deployed the fix");
  let reads = 0;
  const botFeed = createBotFeed({ area: storage.area, fetchRemote: async () => ((reads += 1), { ok: true, status: 200, text }) });
  const { app } = createApp(dom, storage, { botFeed });
  await app.start();
  await settle();
  app.watcher.flush();
  const scheduled = [];
  const schedule = app.watcher.schedule;
  app.watcher.schedule = () => (scheduled.push(1), schedule());
  for (let i = 0; i < 3; i += 1) {
    app.feedsUpdated(["bots"]);
    await settle();
  }
  assert.ok(reads >= 3, "read each time");
  assert.equal(scheduled.length, 0, "the same feed: nothing to draw");
  text = botFeedText("Opened a PR");
  app.feedsUpdated(["bots"]);
  await settle();
  assert.equal(scheduled.length, 1, "a new one: the rows drawn again");
  app.watcher.flush();
  const row = dom.window.document.querySelector('[data-sidebar-row="env1:bot1"]');
  assert.match(row.getAttribute("aria-description"), /Opened a PR$/);
  app.stop();
});

test("the loader's nudge reads only the feeds it handed over (a read asks it for a fresh copy)", async () => {
  const dom = createDom("/env1/bot1", sidebarHtml());
  const storage = createFakeChromeStorage();
  storage.area.data.set(STORAGE_KEYS.settings, { sidebar: { bots: true, botsDefault: true } });
  const reads = [];
  const feed = (kind) => ({ readCache: async () => null, load: async () => (reads.push(kind), null) });
  const { app } = createApp(dom, storage, { botFeed: feed("bots"), homeFeed: feed("home"), threadsFeed: feed("threads") });
  await app.start();
  await settle();
  app.watcher.flush();
  reads.length = 0;
  app.feedsUpdated(["threads"]);
  await settle();
  assert.deepEqual(reads, [], "the threads feed alone was new: the bot feed is not read (nor the Status view's, not shown)");
  app.feedsUpdated(["bots"]);
  await settle();
  assert.deepEqual(reads, ["bots"]);
  reads.length = 0;
  app.feedsUpdated(); // a loader that does not say: every feed in use
  await settle();
  assert.deepEqual(reads, ["bots"]);
  app.stop();
});

test("a swatch picked again, or a value the profile shows anyway, saves and draws nothing", async () => {
  const base = defaultSettings();
  const work = { profile: "work", device: "*" };
  let scopes = setScopeValues(base, emptyScopes(), work, { "composerGradient.accent": "#ff0000" });
  assert.equal(setScopeValues(base, scopes, work, { "composerGradient.accent": "#ff0000" }), scopes, "its own value again: the same scopes");
  assert.equal(setScopeValues(base, scopes, work, { "chat.bubble": base.chat.bubble }), scopes, "the value it inherits, while it has none: the same scopes");
  scopes = setScopeValues(base, scopes, work, { "composerGradient.accent": base.composerGradient.accent });
  assert.deepEqual(scopes.overrides, {}, "back to the inherited one: its own value goes");

  // In the app: the profile dot's glow swatch picked twice.
  const dom = createDom("/", `<div data-slot="sidebar-inner"><ul><li data-testid="sidebar-project-folder"><button type="button" data-sidebar-row="folder:p/a"><span class="truncate">A</span></button></li></ul><div data-slot="sidebar-footer"></div></div>`);
  const storage = createFakeChromeStorage();
  storage.area.data.set(STORAGE_KEYS.profiles, { active: "main", list: [{ id: "main", name: "Main" }, { id: "work", name: "Work" }], projects: {}, adopted: true });
  const profiles = createProfiles({ win: dom.window, doc: dom.window.document, area: storage.area, changedEvent: storage.onChanged });
  const { app } = createApp(dom, storage, { profiles, scopesStore: createScopesStore(storage.area, storage.onChanged) });
  await app.start();
  await settle();
  const writes = [];
  const set = storage.area.set;
  storage.area.set = (items) => (writes.push(...Object.keys(items)), set(items));
  app.setScopedValue("work", "composerGradient.accent", "#ec4899");
  await settle();
  app.setScopedValue("work", "composerGradient.accent", "#ec4899");
  await settle();
  assert.deepEqual(writes.filter((key) => key === STORAGE_KEYS.scopes), [STORAGE_KEYS.scopes], "one write");
  app.stop();
});

test("the loader hears the open profile's bots first: past its cap, the other profiles' do without", async () => {
  const folder = (key) => `<li data-testid="sidebar-project-folder"><button type="button" data-sidebar-row="folder:${key}"><span class="truncate">${key}</span></button></li>`;
  const rows = [];
  for (const project of ["p/other", "p/mine"]) {
    rows.push(folder(project));
    for (let i = 0; i < 3; i += 1) rows.push(threadRowHtml({ key: `env1:${project.slice(2)}${i}`, title: `Thread ${i}`, parent: `folder:${project}` }));
  }
  const dom = createDom("/", `<div data-slot="sidebar-inner"><ul>${rows.join("")}</ul><div data-slot="sidebar-footer"></div></div>`);
  dom.window.matchMedia = (q) => ({ matches: q.includes("reduce"), addEventListener() {}, removeEventListener() {} }); // a switch lands at once
  const told = [];
  dom.window.__t3plusTell = (what, data) => what === "bots" && told.push(data.keys);
  const storage = createFakeChromeStorage();
  storage.area.data.set(STORAGE_KEYS.settings, { sidebar: { bots: true, botsDefault: true } });
  storage.area.data.set(STORAGE_KEYS.profiles, { active: "work", list: [{ id: "main", name: "Main" }, { id: "work", name: "Work" }], projects: { "p/other": "main", "p/mine": "work" }, adopted: true });
  let appRef = null;
  const profiles = createProfiles({ win: dom.window, doc: dom.window.document, area: storage.area, changedEvent: storage.onChanged, onShown: (id) => appRef?.profileShown(id) });
  const { app } = createApp(dom, storage, { profiles, scopesStore: createScopesStore(storage.area, storage.onChanged) });
  appRef = app;
  await app.start();
  await settle();
  app.watcher.flush();
  assert.deepEqual(told.at(-1), ["env1:mine0", "env1:mine1", "env1:mine2", "env1:other0", "env1:other1", "env1:other2"], "Work's bots first, though Main's folder comes first in T3's list");
  told.length = 0;
  dom.window.document.querySelector('.t3plus-profile-dot[data-profile="main"]').click();
  await settle();
  app.watcher.flush();
  assert.deepEqual(told.at(-1)?.slice(0, 3), ["env1:other0", "env1:other1", "env1:other2"], "switched: Main's first");
  app.stop();
});

test("while T3's sidebar is gone, the bots kept hold none of its rows (the old sidebar is not kept in memory)", async () => {
  const dom = createDom("/env1/bot1", sidebarHtml());
  const doc = dom.window.document;
  const storage = createFakeChromeStorage();
  storage.area.data.set(STORAGE_KEYS.settings, { sidebar: { bots: true, botsDefault: true } });
  const { app } = createApp(dom, storage);
  await app.start();
  app.watcher.flush();
  assert.ok(app.state.bots.every((b) => b.thread.row));
  doc.querySelector('[data-slot="sidebar-container"]').remove();
  app.watcher.flush();
  const holdsElement = (value, depth = 0) => value instanceof dom.window.Node || (depth < 3 && value && typeof value === "object" && Object.values(value).some((v) => holdsElement(v, depth + 1)));
  assert.equal(app.state.bots.some((b) => holdsElement(b)), false, "no element kept");
  assert.ok(app.state.bots.length > 0, "the bots themselves are kept (the breadcrumb, the hover cards)");
  app.stop();
});
