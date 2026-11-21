import assert from "node:assert/strict";
import { test } from "node:test";
import { botBadge, botStill, defaultBotColor } from "../src/botArt.js";
import { createBotFeed } from "../src/botFeed.js";
import { createBotStore } from "../src/bots.js";
import { BOT_COLORS, BOT_SHAPES, BOT_SKINS, STORAGE_KEYS } from "../src/config.js";
import { BOT_TITLE, createApp, createDom, createFakeChromeStorage, createFakeRemote, settle, sidebarHtml, T3_APPEARANCE_HTML } from "./helpers.js";

// Bots as the app draws them everywhere they show: T3's list, the breadcrumb, the hover
// card, the Settings preview and the subagents' faces, with the settings that change them.

const edge = (el) => el.style.getPropertyValue("--t3plus-bot-edge");
const fill = (el) => el.style.getPropertyValue("--t3plus-bot-fill");

test("Status colors on a ball bot: its own colors and no ring on its row, breadcrumb, hover card and Settings preview; its row's badge in its own tones (Status colors paint the Status view only), changing with its status", async () => {
  const storage = createFakeChromeStorage();
  storage.area.data.set(STORAGE_KEYS.settings, { sidebar: { bots: true, botsDefault: false, statusColors: true, statusBadges: true } });
  storage.area.data.set(STORAGE_KEYS.bots, { "env1:bot1": { shape: "soccer" } });
  const dom = createDom("/env1/bot1", sidebarHtml({ currentKey: "env1:bot1" }));
  const doc = dom.window.document;
  // The open thread's breadcrumb (T3's header).
  doc.body.insertAdjacentHTML("afterbegin", `<nav aria-label="Thread breadcrumb"><button type="button" aria-label="Thread actions for ${BOT_TITLE}"><h2>${BOT_TITLE}</h2></button></nav>`);
  const { app } = createApp(dom, storage);
  await app.start();
  app.watcher.flush();
  // Its hover card (T3's tooltip popup), as it opens.
  doc.body.insertAdjacentHTML("beforeend", `<div data-slot="tooltip-positioner"><div data-slot="tooltip-popup"><div data-slot="tooltip-viewport">
    <div class="flex flex-col"><div class="min-w-0 truncate text-xs leading-tight font-medium text-foreground">${BOT_TITLE}</div></div></div></div></div>`);
  await settle();
  const faces = () => [
    doc.querySelector('[data-sidebar-row="env1:bot1"] .t3plus-bot-avatar'),
    doc.querySelector("[data-t3plus-bot-breadcrumb]"),
    doc.querySelector("[data-t3plus-bot-hover]"),
  ];
  /** A face as a plain one is drawn: the ball's own edge and clip, nothing of a ring. */
  const plain = (el) => edge(el) === BOT_SKINS.soccer.stops[1] && el.style.getPropertyValue("--t3plus-bot-clip") === BOT_SHAPES.soccer && !el.hasAttribute("data-t3plus-ring") && el.style.getPropertyValue("--t3plus-bot-ring") === "";
  /** Whether a face's badge is drawn in `color`'s middle stop. */
  const badgeIn = (el, color) => decodeURIComponent(el.style.getPropertyValue("--t3plus-bot-badge")).includes(`fill="${BOT_COLORS[color].stops[1]}"`);
  const badge = (el) => el.style.getPropertyValue("--t3plus-bot-badge");
  assert.ok(faces().every(plain), "row, breadcrumb and hover card: a ball keeps its colors, and no ring");
  assert.equal(badge(faces()[0]), botBadge("working", "Working").url, "its row's badge in its own tones");
  assert.ok(!badgeIn(faces()[0], "yellow"), "not tinted Working's amber");
  // It finishes: T3's row says Done.
  doc.querySelector('[data-sidebar-row="env1:bot1"]').setAttribute("aria-label", `${BOT_TITLE}, Done, Ops`);
  app.watcher.flush();
  assert.ok(faces().every(plain), "the ball as it was");
  assert.equal(badge(faces()[0]), botBadge("done", "Done").url, "Done's badge, in its own tones");

  // Settings (another window): the preview's working bot is that ball, as it is (the preview is T3's list).
  const settings = createDom("/settings/appearance", T3_APPEARANCE_HTML);
  await createApp(settings, storage).app.start();
  const preview = settings.window.document.querySelector(".t3plus-preview-avatar");
  assert.equal(preview.getAttribute("data-t3plus-shape"), "soccer");
  assert.ok(plain(preview));
  assert.equal(badge(preview), botBadge("working", "Working").url);
});

test("Status badges: off by default; turned on and off, a bot's row gets its badge and loses all of it; the breadcrumb and hover card never get one", async () => {
  const storage = createFakeChromeStorage();
  const dom = createDom("/env1/bot1", sidebarHtml({ currentKey: "env1:bot1" }));
  const doc = dom.window.document;
  doc.body.insertAdjacentHTML("afterbegin", `<nav aria-label="Thread breadcrumb"><button type="button" aria-label="Thread actions for ${BOT_TITLE}"><h2>${BOT_TITLE}</h2></button></nav>`);
  doc.body.insertAdjacentHTML("beforeend", `<div data-slot="tooltip-popup"><div class="min-w-0 truncate text-xs leading-tight font-medium text-foreground">${BOT_TITLE}</div></div>`);
  const { app } = createApp(dom, storage);
  await app.start();
  app.watcher.flush();
  const faces = () => [
    doc.querySelector('[data-sidebar-row="env1:bot1"] .t3plus-bot-avatar'),
    doc.querySelector("[data-t3plus-bot-breadcrumb]"),
    doc.querySelector("[data-t3plus-bot-hover]"),
  ];
  /** Every trace of a badge on a face: its child (t3+'s avatar), its mark and its variables. */
  const badged = (el) => [el.querySelector(":scope > .t3plus-bot-badge") !== null, el.hasAttribute("data-badge"), el.style.getPropertyValue("--t3plus-bot-badge") !== "", el.style.getPropertyValue("--t3plus-badge-frames") !== ""];
  const turn = async (on) => {
    app.actions.setSidebarFeature("statusBadges", on);
    await settle();
    app.watcher.flush();
  };
  assert.ok(faces().every(Boolean), "the row, breadcrumb and hover card wear the bot's face");
  assert.deepEqual(faces().map(badged), Array(3).fill([false, false, false, false]), "no badge by default");
  await turn(true);
  // Working: an animated tile on the row. T3's elements: no badge (no CSS draws one there).
  assert.deepEqual(faces().map(badged), [[true, true, true, true], [false, false, false, false], [false, false, false, false]]);
  await turn(false);
  assert.deepEqual(faces().map(badged), Array(3).fill([false, false, false, false]), "turned off: all of it gone");
  assert.ok(faces().every((el) => el.style.getPropertyValue("--t3plus-bot-fill") !== ""), "the faces stay");
});

test("Settings' subagent shape and color reach the faces under a bot in the sidebar, and Same as bot follows the bot again", async () => {
  const storage = createFakeChromeStorage();
  storage.area.data.set(STORAGE_KEYS.settings, { sidebar: { bots: true, botsDefault: false, statusColors: true } });
  const feedText = JSON.stringify({ version: 1, bots: { bot1: { text: "Looking around.", role: "assistant", subagents: [{ title: "Search", status: "running" }] } } });
  const botFeed = createBotFeed({ area: storage.area, fetchRemote: createFakeRemote({ ok: true, status: 200, text: feedText }) });
  const dom = createDom("/env1/a1", sidebarHtml());
  const doc = dom.window.document;
  const { app } = createApp(dom, storage, { botFeed });
  await app.start();
  await settle(); // the feed
  app.watcher.flush();
  const mini = () => doc.querySelector('[data-sidebar-row="env1:bot1"] .t3plus-bot-sub');
  const botShape = doc.querySelector('[data-sidebar-row="env1:bot1"] .t3plus-bot-avatar').getAttribute("data-t3plus-shape");
  // Status colors on: under a row in T3's list a bot wears its own color, and so do its subagents.
  const own = defaultBotColor("env1:bot1");
  assert.notEqual(own, "yellow");
  assert.equal(fill(mini()), botStill(own, botShape, "awake").url, "Same as bot: its bot's shape and own color, not Working's amber");
  await app.actions.setSidebarFeature("subagentShape", "robot");
  await app.actions.setSidebarFeature("subagentColor", "purple");
  app.watcher.flush();
  assert.equal(fill(mini()), botStill("purple", "robot", "awake").url, "robots in purple, as Settings says");
  await app.actions.setSidebarFeature("subagentShape", "same");
  app.watcher.flush();
  assert.equal(fill(mini()), botStill("purple", botShape, "awake").url, "its bot's shape, still in purple");
  await app.actions.setSidebarFeature("subagentColor", "same");
  app.watcher.flush();
  assert.equal(fill(mini()), botStill(own, botShape, "awake").url, "and its bot's color again");
});

test("Forget that cannot be saved says so in the Bots card, and forgets nothing", async () => {
  const storage = createFakeChromeStorage();
  storage.area.data.set(STORAGE_KEYS.bots, { "env1:bot1": { shape: "diamond", color: "blue" } });
  const store = createBotStore(storage.area, storage.onChanged);
  const full = {
    ...store,
    forget: async () => {
      throw new Error("Not enough room left in T3's storage to save this.");
    },
  };
  const dom = createDom("/settings/appearance", T3_APPEARANCE_HTML);
  const { app } = createApp(dom, storage, { botStore: full });
  await app.start();
  await app.actions.forgetBot("env1:bot1"); // settles: a click handler's rejection would go unheard
  assert.equal(dom.window.document.querySelector(".t3plus-bots-body [role=status]").textContent, "Not enough room left in T3's storage to save this.");
  assert.deepEqual(app.state.botPrefs, { "env1:bot1": { shape: "diamond", color: "blue" } }, "its settings kept");
});
