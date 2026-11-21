import assert from "node:assert/strict";
import { test } from "node:test";
import { botBadge, botClipPath, botStill } from "../src/botArt.js";
import { applyAvatarVars, classifyBots, decorateBotBreadcrumb, decorateBotHoverCards, decorateBotRows, resolveBotPresentation, shownBotPrefs, subagentFace } from "../src/bots.js";
import { BOT_COLORS, BOT_SHAPES, BOT_SKINS, DEFAULT_BOT_MARKER, DEFAULT_SETTINGS } from "../src/config.js";
import { findSidebarInner, scanSidebar } from "../src/sidebar.js";
import { createAppearancePanel } from "../src/appearancePanel.js";
import { createDom, sidebarHtml } from "./helpers.js";

const MARKED = "[[t3plus:bot:v1]] Ops";
/** Everything a ring drew on a face: its mark and its cover. */
const ringed = (el) => el.hasAttribute("data-t3plus-ring") || el.style.getPropertyValue("--t3plus-bot-ring") !== "";
const hoverCardHtml = (title) => `<div data-slot="tooltip-popup"><div class="min-w-0 truncate text-xs leading-tight font-medium text-foreground">${title}</div></div>`;

/** The bot row of helpers.js sidebarHtml (env1:bot1, Working), and a strip of its subagents. */
function botRow() {
  const dom = createDom("/", sidebarHtml());
  const doc = dom.window.document;
  const scan = scanSidebar(findSidebarInner(doc));
  const bots = classifyBots(scan, DEFAULT_BOT_MARKER);
  const decorate = (prefs, subagents, look) => decorateBotRows(doc, scan, bots, { "env1:bot1": prefs }, () => "", () => subagents, look);
  const strip = () => doc.querySelector('[data-sidebar-row="env1:bot1"] .t3plus-bot-subs');
  const minis = () => [...strip().querySelectorAll(".t3plus-bot-sub")];
  return { bot: bots[0], decorate, strip, minis };
}

test("breadcrumb: the marker taken off the title in T3 while the thread is open leaves T3's new label, not the stale marked one", () => {
  const dom = createDom("/", `<nav aria-label="Thread breadcrumb"><button type="button" aria-label="Thread actions for ${MARKED}"><h2>${MARKED}</h2></button></nav>`);
  const doc = dom.window.document;
  const button = doc.querySelector("button");
  const h2 = doc.querySelector("h2");
  const bot = { key: "env1:a", titleLabel: "Ops", status: "idle", thread: { title: MARKED }, prefs: {} };
  const t3Shows = (title) => {
    button.setAttribute("aria-label", `Thread actions for ${title}`);
    h2.textContent = title;
  };

  // No longer a bot: T3 wrote "Thread actions for Ops", the same words as t3+'s label.
  decorateBotBreadcrumb(doc, bot);
  assert.equal(button.getAttribute("aria-label"), "Thread actions for Ops");
  t3Shows("Ops");
  decorateBotBreadcrumb(doc, null);
  assert.equal(button.getAttribute("aria-label"), "Thread actions for Ops", "React never writes a label it has not changed: the marked one would stay");
  assert.deepEqual(button.getAttributeNames(), ["type", "aria-label"], "nothing of t3+'s left");

  // Still a bot after the rename (every thread is one by default), then bots turned off.
  t3Shows(MARKED);
  decorateBotBreadcrumb(doc, bot);
  t3Shows("Ops");
  decorateBotBreadcrumb(doc, { ...bot, thread: { title: "Ops" } });
  decorateBotBreadcrumb(doc, null);
  assert.equal(button.getAttribute("aria-label"), "Thread actions for Ops");

  // T3 still labels it with the marked title: its label comes back, whatever words its
  // heading's text shows (screenshot mode's stand-in, say).
  t3Shows(MARKED);
  decorateBotBreadcrumb(doc, bot);
  h2.textContent = "Inbox Zero";
  decorateBotBreadcrumb(doc, null);
  assert.equal(button.getAttribute("aria-label"), `Thread actions for ${MARKED}`, "T3's label is back");
});

test("breadcrumb: Status colors turned on with a fruit bot open leave its face as it is: no ring, its own clip and edge", () => {
  const dom = createDom("/", `<nav aria-label="Thread breadcrumb"><button type="button" aria-label="Thread actions for ${MARKED}"><h2 id="h">${MARKED}</h2></button></nav>`);
  const doc = dom.window.document;
  const h = doc.getElementById("h");
  const bot = { key: "env1:a", titleLabel: "Ops", status: "working", thread: { title: MARKED } };
  const own = { shape: "watermelon", color: "green" };
  const status = shownBotPrefs(own, { statusColor: "orange" });
  /** The face as T3's heading wears it. */
  const drawn = () => ["--t3plus-bot-fill", "--t3plus-bot-clip", "--t3plus-bot-edge"].map((name) => h.style.getPropertyValue(name));

  decorateBotBreadcrumb(doc, { ...bot, prefs: own });
  const plain = drawn();
  assert.deepEqual(plain.slice(1), [botClipPath("watermelon"), BOT_SKINS.watermelon.stops[1]], "the watermelon's own clip and edge");
  decorateBotBreadcrumb(doc, { ...bot, prefs: status });
  assert.deepEqual(drawn(), plain, "Status colors on: the same face");
  assert.equal(ringed(h), false, "with no ring");
  decorateBotBreadcrumb(doc, null);
  assert.deepEqual(h.getAttributeNames(), ["id"], "nothing of the bot left on T3's heading");
});

test("T3's own elements (the breadcrumb, a hover card) get no badge with Status badges on: none worked out, none stepped, any left there taken off", async () => {
  const dom = createDom("/", `<nav aria-label="Thread breadcrumb"><button type="button" aria-label="Thread actions for ${MARKED}"><h2 id="h">${MARKED}</h2></button></nav>${hoverCardHtml(MARKED)}`);
  const doc = dom.window.document;
  const heading = doc.getElementById("h");
  const card = doc.querySelector(".truncate");
  const badges = { badges: true }; // Status badges on
  const bot = { key: "env1:a", titleLabel: "Ops", status: "working", statusLabel: "Working", thread: { title: MARKED } };
  assert.ok(resolveBotPresentation(bot, badges).badge, "t3+'s own avatars would get one");
  // A badge already on them (drawn before this build): its picture, frames and mark.
  for (const el of [heading, card]) {
    el.style.setProperty("--t3plus-bot-badge", botBadge("working", "Working").url);
    el.style.setProperty("--t3plus-badge-frames", "3");
    el.setAttribute("data-badge", "animated");
  }
  decorateBotBreadcrumb(doc, { ...bot, prefs: badges });
  decorateBotHoverCards(doc, new Map([[MARKED, bot]]), { "env1:a": badges });
  /** Every trace of a badge: its variables, its frame and its mark. */
  const traces = (el) => ["--t3plus-bot-badge", "--t3plus-badge-frames", "--t3plus-badge-x"].map((name) => el.style.getPropertyValue(name)).concat(el.getAttribute("data-badge"));
  for (const el of [heading, card]) {
    assert.ok(el.style.getPropertyValue("--t3plus-bot-fill"), "the face is drawn");
    assert.deepEqual(traces(el), ["", "", "", null], "and no badge");
  }
  // The working face is stepped; a badge never is.
  const frames = new Set();
  const wait = () => new Promise((resolve) => setTimeout(resolve, 20));
  for (const end = Date.now() + 3000; frames.size < 2 && Date.now() < end; await wait()) {
    frames.add(card.style.getPropertyValue("--t3plus-bot-x"));
    assert.equal(card.style.getPropertyValue("--t3plus-badge-x"), "", "no badge frame");
  }
  assert.ok(frames.size > 1, "the face moves");
  decorateBotBreadcrumb(doc, null);
  assert.deepEqual(heading.getAttributeNames(), ["id"], "nothing left on T3's heading");
});

// A soccer ball whose own color is yellow, working: under Status colors its paint is still
// yellow, and the ball is drawn just as it was.
test("Status colors turned on: a ball bot's open hover card and its subagents stay as they are, with no ring", () => {
  const own = { shape: "soccer", color: "yellow" };
  const status = shownBotPrefs(own, { statusColor: "yellow" }); // as the Status view paints it
  const dom = createDom("/", hoverCardHtml(MARKED));
  const doc = dom.window.document;
  const card = doc.querySelector(".truncate");
  const bot = { key: "env1:a", titleLabel: "Ops", status: "working", statusLabel: "Working", thread: { title: MARKED } };
  const face = (el) => ["--t3plus-bot-fill", "--t3plus-bot-clip", "--t3plus-bot-edge"].map((name) => el.style.getPropertyValue(name));

  decorateBotHoverCards(doc, new Map([[MARKED, bot]]), { "env1:a": own });
  const plain = face(card);
  assert.equal(plain[2], BOT_SKINS.soccer.stops[1], "the ball's own edge");
  decorateBotHoverCards(doc, new Map([[MARKED, bot]]), { "env1:a": status });
  assert.deepEqual(face(card), plain, "the open card: the same ball");
  assert.equal(ringed(card), false, "and no ring");

  const { decorate, minis } = botRow();
  const subs = [{ title: "Search", status: "running" }];
  decorate(own, subs);
  const mini = face(minis()[0]);
  decorate(status, subs);
  assert.deepEqual(face(minis()[0]), mini, "its subagents: the same balls");
  assert.equal(ringed(minis()[0]), false, "with no ring either");

  // A fruit keeps its own outline under Status colors, and a planet with sky its own clip.
  for (const shape of ["apple", "saturn"]) {
    const view = resolveBotPresentation({ key: "env1:a", status: "failed" }, shownBotPrefs({ shape, color: "red" }, { statusColor: "red" }));
    assert.equal(view.clip, botClipPath(shape), shape);
  }
});

test("'Same as bot' color under a ball, planet or fruit in its own colors: a plain subagent face in that ball's color, not its unseen paint", () => {
  const { bot, decorate, minis } = botRow();
  const subs = [{ title: "Search", status: "running" }];
  const golf = { shape: "golf", color: "blue" }; // blue: picked once, nowhere on the white golf ball
  decorate(golf, subs, { shape: "robot", color: "same" });
  assert.equal(minis()[0].style.getPropertyValue("--t3plus-bot-fill"), botStill(BOT_SKINS.golf.stops[1], "robot", "awake").url, "white robots under a white golf ball");
  assert.equal(ringed(minis()[0]), false);

  // A project color nobody sees on the ball either.
  const face = (look) => subagentFace({ shape: "basketball", paint: "#3b82f6" }, look);
  assert.equal(face({ shape: "circle", color: "same" }).color, BOT_SKINS.basketball.stops[1]);
  assert.equal(face({ shape: "circle", color: "pink" }).color, "pink", "a color picked for subagents is followed");
  assert.equal(subagentFace({ shape: "hexagon", paint: "#3b82f6" }, { shape: "circle", color: "same" }).color, "#3b82f6", "a plain bot: its paint, as before");

  // Apples under a plain bot in a project color that is the watermelon's own green, then
  // under a watermelon: the same apples, in their own colors, with no ring under either.
  bot.projectColor = BOT_SKINS.watermelon.stops[1];
  const apples = { shape: "apple", color: "same" };
  decorate({ shape: "circle" }, subs, apples);
  const underPlain = minis()[0].style.getPropertyValue("--t3plus-bot-fill");
  assert.equal(ringed(minis()[0]), false, "no ring in the bot's green");
  decorate({ shape: "watermelon" }, subs, apples);
  assert.equal(minis()[0].style.getPropertyValue("--t3plus-bot-fill"), underPlain, "the apples as they are");
  assert.equal(ringed(minis()[0]), false);
});

test("subagents that ended: finished ones happy, failed ones with x eyes and a ✗, stopped ones at rest; all dimmed, failures counted", () => {
  const { decorate, strip, minis } = botRow();
  const subs = [
    { title: "Search", status: "running" },
    { title: "Lint", status: "completed" },
    { title: "Build", status: "failed" },
    { title: "Docs", status: "interrupted" },
    { title: "Deploy", status: "cancelled" },
  ];
  const prefs = { shape: "hexagon", color: "green" };
  decorate(prefs, subs);
  const fills = minis().map((mini) => mini.style.getPropertyValue("--t3plus-bot-fill"));
  assert.deepEqual(fills, ["awake", "done", "failed", "idle", "idle"].map((mood) => botStill("green", "hexagon", mood).url));
  assert.notEqual(fills[2], fills[1], "a failure is not drawn as a success");
  assert.deepEqual(minis().map((mini) => mini.hasAttribute("data-done")), [false, true, true, true, true], "every ended one dimmed");
  assert.equal(strip().title, "1 of 5 subagents working, 1 failed\n• Search\n✓ Lint\n✗ Build\n– Docs\n– Deploy");
  assert.equal(strip().getAttribute("aria-label"), "1 of 5 subagents working, 1 failed");

  // The same faces for a blob, which draws its own still moods.
  decorate({ shape: "pebble", color: "green" }, subs);
  assert.equal(minis()[2].style.getPropertyValue("--t3plus-bot-fill"), botStill("green", "pebble", "failed").url);
  // No failure: nothing said about failures.
  decorate(prefs, subs.slice(0, 2));
  assert.equal(strip().getAttribute("aria-label"), "1 of 2 subagents working");
});

// Under Status colors bots.js passes botBadge the face's color, and the tile is drawn in
// that color's light and mid stops instead of the status's own tones.
test("Status colors: a face's badge wears its status's color, not the badge's own tones", () => {
  const bot = { key: "env1:a", titleLabel: "Ops", status: "working", statusLabel: "Working" };
  const svg = (prefs) => decodeURIComponent(resolveBotPresentation(bot, prefs).badge.url);
  const painted = svg(shownBotPrefs({ shape: "circle" }, { statusColor: "yellow", badges: true }));
  assert.ok(painted.includes(`fill="${BOT_COLORS.yellow.stops[1]}"`), "working's yellow, as on the face");
  assert.ok(!painted.includes('fill="#3b82f6"'), "not the badge's own blue (idle's color there)");
  assert.equal(resolveBotPresentation(bot, shownBotPrefs({ shape: "circle", color: "purple" }, { badges: true })).badge, botBadge("working", "Working"), "without Status colors: the badge as it was");
  assert.equal(resolveBotPresentation(bot, shownBotPrefs({ shape: "circle" }, { statusColor: "yellow" })).badge, null, "Status badges off: none to tint");
});

test("one helper gives a bot's prefs the looks it is drawn with, for the sidebar, the Status view and the Settings preview alike", () => {
  const prefs = { shape: "saturn", color: "purple" };
  assert.equal(shownBotPrefs(prefs), prefs, "neither: its own prefs, as they are");
  assert.equal(shownBotPrefs(prefs, { statusColor: null, badges: false }), prefs);
  assert.deepEqual(shownBotPrefs(prefs, { statusColor: "yellow" }), { shape: "saturn", color: "yellow", statusColors: true }, "a status color (the Status view): its own shape in it");
  assert.deepEqual(shownBotPrefs({ shape: "nope", extra: 1 }, { statusColor: "green" }), { shape: "auto", color: "green", statusColors: true }, "normalized first: nothing else is carried along");
  assert.deepEqual(shownBotPrefs(undefined, { statusColor: "blue" }), { shape: "auto", color: "blue", statusColors: true });
  assert.deepEqual(shownBotPrefs(prefs, { badges: true }), { ...prefs, badges: true }, "Status badges: its own look, with its badge");
  assert.deepEqual(shownBotPrefs(prefs, { statusColor: "yellow", badges: true }), { shape: "saturn", color: "yellow", statusColors: true, badges: true });

  // The Settings preview is T3's list: its working bot in its own look, Status colors on or not.
  const doc = createDom("/", "").window.document;
  const panel = createAppearancePanel(doc, new Proxy({}, { get: () => () => {} }));
  doc.body.append(panel.element);
  const bot = { key: "env1:a", title: "Ops", titleLabel: "Ops", projectColor: null, prefs, preview: "", view: resolveBotPresentation({ key: "env1:a", titleLabel: "Ops" }, prefs) };
  const settings = structuredClone(DEFAULT_SETTINGS);
  settings.sidebar.statusColors = true;
  panel.update({ settings, image: null, imageUrl: "", message: "", bots: [bot], botMarker: "🤖", health: [] });
  const avatar = panel.element.querySelector('.t3plus-preview-avatar[data-status="working"]');
  const expected = resolveBotPresentation({ key: bot.key, titleLabel: "Ops", status: "working", projectColor: null }, shownBotPrefs(bot.prefs));
  assert.equal(ringed(avatar), false, "Saturn keeps its own colors: no ring");
  assert.deepEqual([avatar.style.getPropertyValue("--t3plus-bot-clip"), avatar.style.getPropertyValue("--t3plus-bot-edge")], [BOT_SHAPES.saturn, "transparent"], "its own clip, its sky see-through");
  assert.equal(avatar.style.getPropertyValue("--t3plus-bot-fill"), expected.fill);
});

test("Status colors on every skin: the breadcrumb, a hover card and t3+'s own avatar draw it as without them, with no ring", () => {
  const dom = createDom("/", `<nav aria-label="Thread breadcrumb"><button type="button" aria-label="Thread actions for ${MARKED}"><h2 id="h">${MARKED}</h2></button></nav>${hoverCardHtml(MARKED)}`);
  const doc = dom.window.document;
  const heading = doc.getElementById("h");
  const card = doc.querySelector(".truncate");
  const bot = { key: "env1:a", titleLabel: "Ops", status: "working", statusLabel: "Working", thread: { title: MARKED } };
  const face = (el) => ["--t3plus-bot-fill", "--t3plus-bot-clip", "--t3plus-bot-edge"].map((name) => el.style.getPropertyValue(name));
  for (const shape of Object.keys(BOT_SKINS)) {
    const own = { shape, color: "blue" };
    const status = shownBotPrefs(own, { statusColor: "orange" });
    const plain = resolveBotPresentation(bot, own);
    decorateBotBreadcrumb(doc, { ...bot, prefs: status });
    decorateBotHoverCards(doc, new Map([[MARKED, bot]]), { "env1:a": status });
    const avatar = doc.createElement("span");
    applyAvatarVars(avatar, resolveBotPresentation(bot, status));
    for (const el of [heading, card, avatar]) {
      assert.deepEqual(face(el), [plain.fill, botClipPath(shape), plain.edge], `${shape}: its own face, clip and edge`);
      assert.equal(ringed(el), false, `${shape}: no ring`);
    }
    assert.equal(avatar.querySelectorAll(":scope > .t3plus-bot-face").length, 1, `${shape}: one face child, with nothing inside`);
    assert.equal(avatar.firstElementChild.children.length, 0);
  }
  decorateBotBreadcrumb(doc, null);
  assert.deepEqual(heading.getAttributeNames(), ["id"], "nothing left on T3's heading");
});
