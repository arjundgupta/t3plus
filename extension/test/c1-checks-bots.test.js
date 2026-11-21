import assert from "node:assert/strict";
import { test } from "node:test";
import { classifyBots, decorateBotRows, noteBotRowChanges } from "../src/bots.js";
import { DEFAULT_BOT_MARKER, STORAGE_KEYS, T3PLUS } from "../src/config.js";
import { findSidebarInner, scanSidebar } from "../src/sidebar.js";
import { createViewStore } from "../src/statusView.js";
import { createApp, createDom, createFakeChromeStorage, settle, sidebarHtml, threadRowHtml } from "./helpers.js";

/** Every call `fn` makes to the DOM methods that read or write an element, and on which element. */
function domCalls(win, fn) {
  const names = ["querySelector", "querySelectorAll", "getAttribute", "hasAttribute", "setAttribute", "removeAttribute", "append", "prepend", "after", "remove"];
  const proto = win.Element.prototype;
  const real = Object.fromEntries(names.map((name) => [name, proto[name]]));
  const calls = [];
  for (const name of names) {
    proto[name] = function (...args) {
      calls.push({ name, el: this, args });
      return real[name].apply(this, args);
    };
  }
  try {
    fn();
  } finally {
    Object.assign(proto, real);
  }
  return calls;
}

function botsPage() {
  const dom = createDom("/", sidebarHtml());
  const doc = dom.window.document;
  /** The sidebar read as a check reads it; decorate() then does what the check does with it. */
  const read = (preview = () => "Latest") => {
    const scan = scanSidebar(findSidebarInner(doc));
    const bots = classifyBots(scan, DEFAULT_BOT_MARKER, {}, true);
    return { bots, decorate: () => decorateBotRows(doc, scan, bots, {}, preview, () => []) };
  };
  const decorate = (preview) => {
    const check = read(preview);
    check.decorate();
    return check.bots;
  };
  return { win: dom.window, doc, read, decorate, row: (key) => doc.querySelector(`[data-sidebar-row="${key}"]`) };
}

test("a check with nothing new decorates no bot row again: no row read or written", () => {
  const p = botsPage();
  const bots = p.decorate();
  assert.ok(bots.length >= 4, "every thread a bot");
  const { decorate } = p.read();
  const calls = domCalls(p.win, decorate);
  const onRows = calls.filter(({ el }) => el.closest?.("[data-sidebar-row]"));
  assert.deepEqual(onRows.map(({ name }) => name), [], "the rows as they were: nothing done in them");
});

test("a bot row is decorated again when what it shows changes, and only that row", () => {
  const p = botsPage();
  p.decorate();
  const row = p.row("env1:a2");
  row.setAttribute("aria-label", "Add metrics, Working"); // T3: it started working
  const calls = domCalls(p.win, p.read().decorate);
  const touched = new Set(calls.filter(({ name }) => name === "setAttribute").map(({ el }) => el.closest("[data-sidebar-row]")));
  assert.deepEqual([...touched], [row], "that row alone");
  assert.equal(row.getAttribute(T3PLUS.botAttr), "working");
  assert.equal(row.querySelector(".t3plus-bot-avatar").getAttribute("data-status"), "working");
  // Its latest message changed (the bot feed was read again).
  p.decorate((key) => (key === "env1:w1" ? "Deployed" : "Latest"));
  assert.match(p.row("env1:w1").getAttribute("aria-description"), /Deployed$/);
});

test("a bot row T3 changed inside is decorated again (the watcher's records), and one T3 took the face out of gets it back", async () => {
  const p = botsPage();
  p.decorate();
  const records = [];
  const observer = new p.win.MutationObserver((batch) => records.push(...batch));
  observer.observe(p.doc.documentElement, { childList: true, subtree: true });
  const row = p.row("env1:w1");
  const top = row.querySelector("[data-t3plus-bot-top]");
  const added = p.doc.createElement("span");
  added.textContent = "draft";
  top.prepend(added); // T3 renders a new mark on the row's line
  await settle();
  observer.disconnect();
  noteBotRowChanges(records);
  p.decorate();
  assert.ok(added.hasAttribute("data-t3plus-bot-hide"), "laid out like T3's other marks on a bot's line");
  // T3 dropped t3+'s avatar (a change the watcher does not count: the node is t3+'s).
  row.querySelector(".t3plus-bot-avatar").remove();
  p.decorate();
  assert.ok(row.querySelector(":scope > .t3plus-bot-avatar > .t3plus-bot-face"), "the face is back");
});

test("a bot's project color is read from its folder's badge once for all the bots in that folder", async () => {
  const rows = ["a1", "a2", "a3"].map((id) => threadRowHtml({ key: `env1:${id}`, title: `Thread ${id}`, parent: "folder:github.com/acme/api" })).join("");
  const dom = createDom("/", `<div data-slot="sidebar-inner"><ul>
    <li data-testid="sidebar-project-folder"><button type="button" data-sidebar-row="folder:github.com/acme/api"><img alt="" src="data:image/svg+xml;base64,${Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><rect fill="#22aa66"/></svg>').toString("base64")}">API</button></li>${rows}</ul></div>`);
  const storage = createFakeChromeStorage();
  storage.area.data.set(STORAGE_KEYS.settings, { sidebar: { bots: true, botsDefault: true } });
  const { app } = createApp(dom, storage);
  await app.start();
  app.watcher.flush();
  const folder = dom.window.document.querySelector('[data-sidebar-row="folder:github.com/acme/api"]');
  let reads = 0;
  const real = folder.querySelector.bind(folder);
  folder.querySelector = (...args) => ((reads += 1), real(...args));
  app.watcher.flush();
  assert.equal(reads, 1, "one badge read for its three threads");
  assert.deepEqual(app.state.bots.map((b) => b.projectColor), ["#22aa66", "#22aa66", "#22aa66"]);
  app.stop();
});

// ---------- Bots off ----------

const FOOTER_SIDEBAR = `<div data-slot="sidebar-inner">
    <div data-slot="sidebar-content"><ul id="t3-list">
      <li data-testid="sidebar-project-folder"><button type="button" data-sidebar-row="folder:github.com/acme/api"><span class="truncate">API</span></button></li>
      ${threadRowHtml({ key: "env1:a1", title: "Fix login", parent: "folder:github.com/acme/api", status: "Working" })}
      ${threadRowHtml({ key: "env1:a2", title: "Add metrics", parent: "folder:github.com/acme/api" })}
    </ul></div>
    <div data-slot="sidebar-footer"></div>
  </div>`;

for (const view of ["status", "projects"]) {
  test(`bots off (${view === "status" ? "the Status view showing" : "T3's list, the view's button on a row of its own"}): a check with nothing new changes nothing, keeps the focus and sets off no other`, async () => {
    const dom = createDom("/env1/a1", FOOTER_SIDEBAR);
    const doc = dom.window.document;
    const storage = createFakeChromeStorage();
    storage.area.data.set(STORAGE_KEYS.settings, { sidebar: { bots: false } });
    storage.area.data.set(STORAGE_KEYS.sidebarView, { view });
    const { app } = createApp(dom, storage, { throttleMs: 20, viewStore: createViewStore(storage.area, storage.onChanged), threadsFeed: { load: async () => null } });
    await app.start();
    await settle();
    app.watcher.flush();
    app.watcher.flush();
    const focusable = doc.querySelector(view === "status" ? ".t3plus-status-row" : ".t3plus-status-toggle");
    assert.ok(focusable, "the view's row, or its button");
    focusable.focus();
    const records = [];
    const observer = new dom.window.MutationObserver((batch) => records.push(...batch));
    observer.observe(doc.documentElement, { childList: true, subtree: true });
    app.watcher.flush();
    await settle();
    observer.disconnect();
    assert.deepEqual(records.map((r) => r.type), [], "nothing taken out or put back");
    assert.equal(doc.activeElement, focusable, "the focus stays");
    const checks = app.perf.checks;
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(app.perf.checks, checks, "and no check after it, with nothing changing");
    app.stop();
  });
}

test("bots turned off clear their rows once; turned on again they are drawn again", async () => {
  const dom = createDom("/", sidebarHtml());
  const doc = dom.window.document;
  const storage = createFakeChromeStorage();
  storage.area.data.set(STORAGE_KEYS.settings, { sidebar: { bots: true, botsDefault: true } });
  const { app } = createApp(dom, storage);
  await app.start();
  app.watcher.flush();
  assert.ok(doc.querySelectorAll(".t3plus-bot-avatar").length > 0);
  await app.actions.setSidebarFeature("bots", false);
  app.watcher.flush();
  assert.equal(doc.querySelectorAll(`.t3plus-bot-avatar, [${T3PLUS.botAttr}]`).length, 0, "every face and mark gone");
  const sweeps = [`[${T3PLUS.botAttr}]`, `[${T3PLUS.ownedAttr}]`];
  const calls = domCalls(dom.window, () => app.watcher.flush());
  assert.deepEqual(calls.filter(({ name, args }) => name === "querySelectorAll" && sweeps.includes(args[0])), [], "not looked for again in the next check");
  await app.actions.setSidebarFeature("bots", true);
  app.watcher.flush();
  assert.ok(doc.querySelectorAll(".t3plus-bot-avatar").length > 0, "drawn again");
  app.stop();
});

test("Settings' bot chips and the picked bot's face (Blobs: every face moves) move again once Settings is left and opened again", async () => {
  const { spriteCount } = await import("../src/spriteClock.js");
  const { T3_APPEARANCE_HTML } = await import("./helpers.js");
  const dom = createDom("/settings/appearance", T3_APPEARANCE_HTML);
  const storage = createFakeChromeStorage();
  storage.area.data.set(STORAGE_KEYS.settings, { sidebar: { botStyle: "blobs" } });
  storage.area.data.set(STORAGE_KEYS.knownBots, { "env1:a": { title: `${DEFAULT_BOT_MARKER} Ops`, seenAt: 1 } });
  const { app } = createApp(dom, storage);
  await app.start();
  await settle();
  app.watcher.flush();
  const doc = dom.window.document;
  assert.ok(doc.querySelector(".t3plus-bot-swatch > .t3plus-bot-face"), "a chip's face");
  const stepped = spriteCount();
  assert.ok(stepped >= 3, `the chip's face, the picked bot's and the preview's (${stepped})`);
  const until = async (ok) => {
    for (let i = 0; i < 100 && !ok(); i += 1) await new Promise((resolve) => setTimeout(resolve, 10));
    return ok();
  };
  dom.window.history.pushState({}, "", "/"); // a page that draws nothing anew (another machine's thread would)
  app.watcher.flush();
  assert.ok(await until(() => spriteCount() === 0), "off the page: let go");
  dom.window.history.pushState({}, "", "/settings/appearance");
  app.watcher.flush();
  assert.equal(spriteCount(), stepped, "every face back on the clock");
  app.stop();
});
