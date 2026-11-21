import assert from "node:assert/strict";
import { test } from "node:test";
import { assignBotShapes, botStill, defaultBotShape, setBotStyle } from "../src/botArt.js";
import { createBotFeed } from "../src/botFeed.js";
import { resolveBotPresentation, shownBotPrefs, subagentFace } from "../src/bots.js";
import { BOT_COLORS, BOT_SHAPES, BOT_SKINS, DEFAULT_BOT_MARKER, STORAGE_KEYS } from "../src/config.js";
import { STATUS_BOT_COLORS, createViewStore, parseThreadsFeedText } from "../src/statusView.js";
import { createApp, createDom, createFakeChromeStorage, createFakeRemote, threadRowHtml, virtualClock } from "./helpers.js";

// The sidebar's Status view as the app draws it: its faces, which threads are bots, and
// the shapes its bots are dealt.

const M = DEFAULT_BOT_MARKER;
const API = "folder:github.com/acme/api";
// Without timers: the virtual clock holds setTimeout itself.
const tick = () => new Promise((resolve) => setImmediate(resolve));

const sidebar = (rows) => `<div data-slot="sidebar-inner">
    <div data-slot="sidebar-content"><ul id="t3-list">
      <li data-testid="sidebar-project-folder"><button type="button" data-sidebar-row="${API}"><span class="truncate">API</span></button></li>
      ${rows}
    </ul></div>
    <div data-slot="sidebar-footer"></div>
  </div>`;

/** The app on a sidebar with the Status view showing. */
async function statusApp(dom, { settings = {}, bots = {}, feed = null, extra = {} } = {}) {
  const storage = createFakeChromeStorage();
  storage.area.data.set(STORAGE_KEYS.settings, { sidebar: { bots: true, botsDefault: false, ...settings } });
  storage.area.data.set(STORAGE_KEYS.bots, bots);
  storage.area.data.set(STORAGE_KEYS.sidebarView, { view: "status" });
  const { app } = createApp(dom, storage, {
    viewStore: createViewStore(storage.area, storage.onChanged),
    threadsFeed: { load: async () => (feed ? parseThreadsFeedText(JSON.stringify(feed)) : null) },
    ...extra,
  });
  await app.start();
  await tick(); // the feed, read as the view arrives
  app.watcher.flush();
  return app;
}

const viewFace = (doc, key) => doc.querySelector(`.t3plus-status-view [data-thread="${key}"] .t3plus-status-face`);
const rowFace = (doc, key) => doc.querySelector(`[data-sidebar-row="${key}"] .t3plus-bot-avatar`);

/** How many frames the avatar `el` shows over `ms` of the virtual clock (its face child is stepped). */
async function framesShown(clock, el, ms = 1000) {
  const seen = new Set();
  for (let t = 0; t < ms; t += 100) {
    await clock.advance(100);
    seen.add(el.querySelector(":scope > .t3plus-bot-face")?.style.getPropertyValue("--t3plus-bot-x"));
  }
  return seen.size;
}

test("a working face in the Status view keeps moving when the view shows again, and when T3 remounts its sidebar with the view in it", async () => {
  const rows = threadRowHtml({ key: "env1:a2", title: `${M} Metrics bot`, parent: API, status: "Working" });
  const dom = createDom("/env1/zz", sidebar(rows));
  const clock = virtualClock(dom.window);
  const doc = dom.window.document;
  const app = await statusApp(dom);
  const face = viewFace(doc, "env1:a2");
  assert.ok(face.hasAttribute("data-animated"), "a working face is a sprite");
  assert.ok((await framesShown(clock, face)) > 2, "and moves");

  const toggle = doc.querySelector(".t3plus-status-toggle");
  toggle.click(); // Projects: the view leaves the page, and the sprite clock lets its faces go
  await clock.advance(500);
  toggle.click(); // Status again
  assert.equal(viewFace(doc, "env1:a2"), face, "the view kept its row");
  assert.ok((await framesShown(clock, face)) > 2, "shown again: it moves again");

  // T3 takes its sidebar down and puts up a new one between two checks.
  doc.querySelector('[data-slot="sidebar-inner"]').remove();
  await clock.advance(500);
  doc.body.insertAdjacentHTML("beforeend", sidebar(rows));
  app.watcher.flush();
  const again = viewFace(doc, "env1:a2");
  assert.ok(again?.hasAttribute("data-animated"), "in the new sidebar");
  assert.ok((await framesShown(clock, again)) > 2, "moving there too");
});

/** T3 renaming a thread: its row's two title copies and its label. */
function rename(doc, key, title, status) {
  const row = doc.querySelector(`[data-sidebar-row="${key}"]`);
  row.setAttribute("aria-label", `${title}, ${status}`);
  for (const span of row.querySelectorAll("span.sr-only, span.truncate")) span.textContent = title;
}

test("Status view: a thread that gets the bot marker gets its face at once, and a dot again once the marker goes", async () => {
  const dom = createDom("/env1/zz", sidebar(threadRowHtml({ key: "env1:a2", title: "Metrics bot", parent: API, status: "Working" })));
  const doc = dom.window.document;
  const app = await statusApp(dom);
  assert.ok(viewFace(doc, "env1:a2").classList.contains("t3plus-status-dot"), "no bot: a dot");
  rename(doc, "env1:a2", `${M} Metrics bot`, "Working");
  app.watcher.flush();
  assert.ok(rowFace(doc, "env1:a2"), "a bot in T3's list now");
  assert.ok(viewFace(doc, "env1:a2").classList.contains("t3plus-bot-avatar"), "and in the view: its face, not a dot");
  assert.equal(doc.querySelector('.t3plus-status-view [data-thread="env1:a2"] .t3plus-status-title').textContent, "Metrics bot", "named without its marker");
  rename(doc, "env1:a2", "Metrics bot", "Working");
  app.watcher.flush();
  const face = viewFace(doc, "env1:a2");
  assert.ok(face.classList.contains("t3plus-status-dot"), "the marker gone: a dot again");
  assert.equal(face.style.getPropertyValue("--t3plus-bot-fill"), "", "with nothing of the face left");
});

test("Status view faces wear Status colors (T3's list keeps their own), a ball in its own colors with no ring, and their own colors once it is turned off", async () => {
  const rows = [
    threadRowHtml({ key: "env1:a2", title: `${M} Metrics bot`, parent: API, status: "Working" }),
    threadRowHtml({ key: "env1:b1", title: `${M} Ball bot`, parent: API, status: "Working" }),
  ].join("");
  const dom = createDom("/env1/zz", sidebar(rows));
  const doc = dom.window.document;
  const app = await statusApp(dom, { settings: { statusColors: true }, bots: { "env1:a2": { color: "purple" }, "env1:b1": { shape: "soccer" } } });
  const fill = (el) => el.style.getPropertyValue("--t3plus-bot-fill");
  const working = (color) => resolveBotPresentation({ key: "env1:a2", titleLabel: "Metrics bot", status: "working" }, { color }).fill;
  /** The ball's face as drawn: its picture, the color behind it, its clip, and any ring. */
  const ball = () => {
    const el = viewFace(doc, "env1:b1");
    return [fill(el), el.style.getPropertyValue("--t3plus-bot-edge"), el.style.getPropertyValue("--t3plus-bot-clip"), el.hasAttribute("data-t3plus-ring")];
  };
  assert.equal(fill(viewFace(doc, "env1:a2")), working(STATUS_BOT_COLORS.working), "Working's amber, over its own purple");
  assert.equal(fill(rowFace(doc, "env1:a2")), working("purple"), "its row in T3's list: its own purple");
  const painted = ball();
  assert.deepEqual(painted.slice(1), [BOT_SKINS.soccer.stops[1], BOT_SHAPES.soccer, false], "a ball keeps its own colors, its own clip and edge, and no ring");

  app.actions.setSidebarFeature("statusColors", false); // while the view shows
  await tick();
  app.watcher.flush();
  assert.equal(fill(viewFace(doc, "env1:a2")), working("purple"), "its own purple again");
  assert.deepEqual(ball(), painted, "the ball just as it was");
});

test("Status colors paint the Status view only: switched to it and back, T3's rows, the breadcrumb, the hover card and the subagents keep the bot's own colors (and its badge its own tones)", async () => {
  const marked = `${M} Metrics bot`;
  const dom = createDom("/env1/a2", sidebar(threadRowHtml({ key: "env1:a2", title: marked, parent: API, status: "Working", current: true })));
  const doc = dom.window.document;
  doc.body.insertAdjacentHTML("afterbegin", `<nav aria-label="Thread breadcrumb"><button type="button" aria-label="Thread actions for ${marked}"><h2>${marked}</h2></button></nav>`);
  const feedText = JSON.stringify({ version: 1, bots: { a2: { text: "Looking around.", role: "assistant", subagents: [{ title: "Search", status: "running" }] } } });
  const botFeed = createBotFeed({ area: null, fetchRemote: createFakeRemote({ ok: true, status: 200, text: feedText }) });
  const app = await statusApp(dom, { settings: { statusColors: true, statusBadges: true }, bots: { "env1:a2": { color: "purple" } }, extra: { botFeed } });
  doc.body.insertAdjacentHTML("beforeend", `<div data-slot="tooltip-popup"><div class="min-w-0 truncate text-xs leading-tight font-medium text-foreground">${marked}</div></div>`);
  await tick();
  app.watcher.flush();
  const bot = { key: "env1:a2", titleLabel: "Metrics bot", status: "working", statusLabel: "Working" };
  /** A face as drawn: its picture and its badge's. */
  const drawn = (el) => [el.style.getPropertyValue("--t3plus-bot-fill"), el.style.getPropertyValue("--t3plus-bot-badge")];
  const own = resolveBotPresentation(bot, shownBotPrefs({ color: "purple" }, { badges: true }));
  const status = resolveBotPresentation(bot, shownBotPrefs({ color: "purple" }, { statusColor: STATUS_BOT_COLORS.working, badges: true }));
  const crumb = () => doc.querySelector("[data-t3plus-bot-breadcrumb]");
  const card = () => doc.querySelector("[data-t3plus-bot-hover]");
  const mini = () => doc.querySelector('[data-sidebar-row="env1:a2"] .t3plus-bot-sub');
  const miniOwn = (() => {
    const face = subagentFace(own);
    return botStill(face.color, face.shape, "awake").url;
  })();
  /** Everywhere a bot shows outside the Status view: its own colors, its badge in its own tones (T3's elements get none). */
  const ownEverywhere = (when) => {
    assert.deepEqual(drawn(rowFace(doc, "env1:a2")), [own.fill, own.badge.url], `${when}: its row in T3's list`);
    assert.equal(crumb().style.getPropertyValue("--t3plus-bot-fill"), own.fill, `${when}: the breadcrumb`);
    assert.equal(card().style.getPropertyValue("--t3plus-bot-fill"), own.fill, `${when}: the hover card`);
    assert.equal(mini().style.getPropertyValue("--t3plus-bot-fill"), miniOwn, `${when}: its subagent`);
  };
  assert.notEqual(own.fill, status.fill, "the two differ");
  assert.notEqual(own.badge.url, status.badge.url, "and so do their badges");
  assert.deepEqual(drawn(viewFace(doc, "env1:a2")), [status.fill, status.badge.url], "the Status view: Working's amber, its badge in it too");
  ownEverywhere("in the Status view");

  const toggle = doc.querySelector(".t3plus-status-toggle");
  for (const round of [1, 2]) {
    toggle.click(); // Projects
    assert.equal(viewFace(doc, "env1:a2"), null, `round ${round}: the view is gone`);
    ownEverywhere(`round ${round}, back in T3's list`);
    toggle.click(); // Status again: drawn in the click (saveView flushes)
    assert.deepEqual(drawn(viewFace(doc, "env1:a2")), [status.fill, status.badge.url], `round ${round}: the Status view in Working's amber again`);
    ownEverywhere(`round ${round}, in the Status view`);
  }
});

test("Status view faces: a badge only with Status badges on, added and taken off while the view shows", async () => {
  const rows = threadRowHtml({ key: "env1:a2", title: `${M} Metrics bot`, parent: API, status: "Working" });
  const dom = createDom("/env1/zz", sidebar(rows));
  const doc = dom.window.document;
  const app = await statusApp(dom);
  /** The face's badge as drawn: its child, its mark and its picture. */
  const badge = (el) => [el.querySelector(":scope > .t3plus-bot-badge") !== null, el.getAttribute("data-badge"), el.style.getPropertyValue("--t3plus-bot-badge") !== ""];
  const none = [false, null, false];
  assert.deepEqual(badge(viewFace(doc, "env1:a2")), none, "off by default");
  assert.deepEqual(badge(rowFace(doc, "env1:a2")), none, "on its row neither");

  const turn = async (on) => {
    app.actions.setSidebarFeature("statusBadges", on);
    await tick();
    app.watcher.flush();
  };
  await turn(true);
  assert.deepEqual(badge(viewFace(doc, "env1:a2")), [true, "animated", true], "Working's ticking tile");
  assert.deepEqual(badge(rowFace(doc, "env1:a2")), [true, "animated", true], "and its row's");
  await turn(false);
  assert.deepEqual(badge(viewFace(doc, "env1:a2")), none, "taken off again");
  assert.deepEqual(badge(rowFace(doc, "env1:a2")), none);
  assert.equal(viewFace(doc, "env1:a2").style.getPropertyValue("--t3plus-badge-frames"), "", "with its frame count");
});

test("a Status view update with nothing new on a face writes nothing on it (no class, style or attribute)", async () => {
  const rows = [
    threadRowHtml({ key: "env1:a2", title: `${M} Metrics bot`, parent: API, status: "Working" }),
    threadRowHtml({ key: "env1:a3", title: "Fix login", parent: API, status: "Done" }),
  ].join("");
  const dom = createDom("/env1/zz", sidebar(rows));
  const doc = dom.window.document;
  const app = await statusApp(dom);
  const faces = [viewFace(doc, "env1:a2"), viewFace(doc, "env1:a3")];
  assert.deepEqual(faces.map((f) => f.className), ["t3plus-status-face t3plus-bot-avatar", "t3plus-status-face t3plus-status-dot"]);
  const written = [];
  const observer = new dom.window.MutationObserver((records) => written.push(...records.map((r) => r.attributeName)));
  for (const face of faces) observer.observe(face, { attributes: true });
  // T3 renames the project: every row is drawn again (its project line), no face changes.
  doc.querySelector(`[data-sidebar-row="${API}"] span.truncate`).textContent = "API v2";
  app.watcher.flush();
  await tick();
  assert.equal(doc.querySelector('.t3plus-status-view [data-thread="env1:a2"] .t3plus-status-project').textContent, "API v2", "the rows were drawn again");
  assert.deepEqual(written, []);
  observer.disconnect();
});

test("a bot the Status view shows before T3's list does (a collapsed folder's) keeps its shape once its row appears", async () => {
  // Four bots in T3's list, in Space's six shapes; a fifth in the feed only, whose own
  // (hashed) shape one of the four has: dealt on its own later, it would get another.
  const listed = ["env1:s0", "env1:s1", "env1:s2", "env1:s3"];
  setBotStyle("space");
  assignBotShapes(listed); // as the app deals them
  const taken = new Set(listed.map(defaultBotShape));
  const lone = Array.from({ length: 200 }, (_, i) => `env1:lone${i}`).find((key) => taken.has(defaultBotShape(key)));
  assert.ok(lone, "a bot whose own shape is taken");
  const threadRow = (key, title) => threadRowHtml({ key, title: `${M} ${title}`, parent: API, status: "Working" });
  const feed = {
    version: 1,
    environmentId: "env1",
    projects: { papi: { title: "API", keys: ["github.com/acme/api"] } },
    threads: [{ id: lone.slice(5), project: "papi", title: `${M} Lone`, status: "working", at: new Date().toISOString() }],
  };
  const dom = createDom("/env1/zz", sidebar(listed.map((key, i) => threadRow(key, `Bot ${i}`)).join("")));
  const doc = dom.window.document;
  try {
    const app = await statusApp(dom, { settings: { botStyle: "space" }, feed });
    const shown = viewFace(doc, lone)?.getAttribute("data-t3plus-shape");
    assert.ok(shown, "drawn in the view from the feed");
    assert.equal(listed.some((key) => rowFace(doc, key).getAttribute("data-t3plus-shape") === shown), false, "in a shape no bot on screen has");
    // T3 opens the folder: its row in T3's list.
    doc.getElementById("t3-list").insertAdjacentHTML("beforeend", threadRow(lone, "Lone"));
    app.watcher.flush();
    assert.equal(rowFace(doc, lone).getAttribute("data-t3plus-shape"), shown, "its row: the same face");
  } finally {
    setBotStyle("classic");
  }
});

test("a thread feed that fails to load leaves the Status view drawing T3's rows, with nothing unhandled", async () => {
  const unhandled = [];
  const onUnhandled = (reason) => unhandled.push(reason);
  process.on("unhandledRejection", onUnhandled);
  try {
    const dom = createDom("/env1/zz", sidebar(threadRowHtml({ key: "env1:a2", title: "Fix login", parent: API, status: "Done" })));
    const doc = dom.window.document;
    const storage = createFakeChromeStorage();
    storage.area.data.set(STORAGE_KEYS.sidebarView, { view: "status" });
    const { app } = createApp(dom, storage, {
      viewStore: createViewStore(storage.area, storage.onChanged),
      threadsFeed: {
        load: async () => {
          throw new Error("the loader is gone");
        },
      },
    });
    await app.start();
    await new Promise((resolve) => setTimeout(resolve, 10));
    app.watcher.flush();
    app.feedsUpdated(); // the loader's nudge reads it again
    await new Promise((resolve) => setTimeout(resolve, 10));
    app.watcher.flush();
    assert.deepEqual([...doc.querySelectorAll(".t3plus-status-row")].map((b) => b.dataset.thread), ["env1:a2"], "T3's own row");
    assert.deepEqual(unhandled, []);
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
});
