import assert from "node:assert/strict";
import { test } from "node:test";
import { hasSession, parseHomeFeedText, sessionModel } from "../src/homeData.js";
import { cardAvailability, createHomeView, HOME_CARDS, homeOrder, mergeOrder, showsAnyCard } from "../src/homeWidgets.js";
import { defaultSettings, normalizeSettings } from "../src/settings.js";
import { createDom } from "./helpers.js";

const NOW = new Date("2026-11-24T21:00:00Z");
const sec = (iso) => Date.parse(iso) / 1000;
const feedWith = (windows, extra = {}) =>
  parseHomeFeedText(
    JSON.stringify({
      version: 1,
      generatedAt: NOW.toISOString(),
      limits: { claude: [{ label: "Claude", plan: "Claude Pro", windows }], codex: null, pool: null },
      claudeSeries: [[sec("2026-11-24T20:00:00Z"), 67, 100]],
      // [t, left, cap, reset of the reading's window]; this window resets 2026-11-25 00:50Z.
      claudeSessionSeries: [
        [sec("2026-11-24T18:00:00Z"), 10, 100, sec("2026-11-24T19:50:00Z")], // the window before: left out
        // Taken after this window opened, but T3 still reported the one that had ended:
        // left out by its reset, not drawn as a drop to empty.
        [sec("2026-11-24T19:55:00Z"), 0, 100, sec("2026-11-24T19:50:00Z")],
        [sec("2026-11-24T19:58:00Z"), 55, 100], // no window known (an older feed): left out
        [sec("2026-11-24T20:00:00Z"), 90, 100, sec("2026-11-25T00:50:00Z")],
        [sec("2026-11-24T20:30:00Z"), 80, 100, sec("2026-11-25T00:50:00Z")],
      ],
      ...extra,
    }),
  );
// The four newer cards off: the layout tests below are about the pool cards.
const OLD = { forecast: false, needsYou: false, streak: false, projects: false };
const SESSION = { label: "Session", kind: "session", durationMins: 300, usedPercent: 27, resetsAt: "2026-11-25T00:49:59.994Z" };
const WEEK = { label: "Weekly", kind: "weekly", durationMins: 10080, usedPercent: 33, resetsAt: "2026-11-29T17:59:59.994Z" };

test("sessionModel: what is left of the five-hour window, its reset, and the line since it opened", () => {
  const m = sessionModel(feedWith([SESSION, WEEK]), NOW.getTime());
  assert.equal(m.left, 73);
  assert.equal(m.cap, 100);
  assert.equal(m.active, true);
  assert.equal(m.nextRefill.at, Date.parse(SESSION.resetsAt));
  assert.equal(m.from, Date.parse(SESSION.resetsAt) - 300 * 60000, "opened five hours before its reset");
  assert.deepEqual(m.recorded.map((p) => p.left), [100, 90, 80, 73], "full at its start, this window's samples, then now");
  assert.equal(m.recorded[0].t, m.from);
  assert.equal(m.end, Date.parse(SESSION.resetsAt), "the chart runs to the reset");
});

test("sessionModel: a window past its reset is full again, with no reset until the next message", () => {
  const m = sessionModel(feedWith([{ ...SESSION, usedPercent: 90, resetsAt: "2026-11-24T20:00:00Z" }, WEEK]), NOW.getTime());
  assert.equal(m.left, 100);
  assert.equal(m.active, false);
  assert.equal(m.nextRefill, null);
  // The hours ahead, empty: not the five hours before (they read as a window just used).
  assert.equal(m.from, NOW.getTime());
  assert.equal(m.end, NOW.getTime() + 300 * 60000);
  assert.deepEqual(m.recorded, []);
});

test("Claude 5-Hour card with no window running: the hours ahead, no line, nothing to hover", () => {
  const dom = createDom("/", "<div></div>");
  const view = createHomeView(dom.window.document);
  view.update({ feed: feedWith([{ ...SESSION, usedPercent: 100, resetsAt: "2026-11-24T20:00:00Z" }, WEEK]), now: NOW, show: OLD });
  const card = view.element.querySelector(".t3plus-w-session");
  assert.equal(card.querySelector(".t3plus-w-big-num").textContent, "100%");
  assert.equal(card.querySelector(".t3plus-w-reset").textContent, "Starts with your next message");
  const plot = card.querySelector(".t3plus-w-plot");
  assert.ok(plot.hasAttribute("data-t3plus-idle"));
  assert.equal(plot.querySelector(".t3plus-w-line, .t3plus-w-area, canvas"), null, "no line drawn");
  assert.equal(plot.getAttribute("tabindex"), null, "not a chart to step through");
  assert.ok(card.querySelectorAll(".t3plus-w-axis span").length >= 3, "the next hours on the axis");
  view.destroy();
});

test("sessionModel: no five-hour window, no card", () => {
  const feed = feedWith([WEEK]);
  assert.equal(hasSession(feed), false);
  assert.equal(sessionModel(feed, NOW.getTime()), null);
  assert.equal(sessionModel(null), null);
});

test("home grid: a Claude 5-hour card beside the Claude pool, two cards a row", () => {
  const dom = createDom("/", "<div></div>");
  const view = createHomeView(dom.window.document);
  view.update({ feed: feedWith([SESSION, WEEK]), now: NOW, show: OLD });
  const titles = [...view.element.querySelectorAll(".t3plus-w h3")].map((e) => e.textContent);
  assert.deepEqual(titles, ["Claude Pool", "Claude 5-Hour", "Activity", "Usage"]);
  assert.equal(view.element.querySelectorAll(".t3plus-w-wide").length, 0, "a full 2x2 grid");
  const card = view.element.querySelector(".t3plus-w-session");
  assert.equal(card.querySelector(".t3plus-w-pool-head").textContent, "73%remaining");
  assert.match(card.querySelector(".t3plus-w-reset").textContent, /^Reset - /);
  assert.match(card.querySelector("[data-t3plus-chart]").getAttribute("aria-label"), /this 5-hour window/);
  view.destroy();
});

test("home grid: without a five-hour window the Claude pool still spans the row", () => {
  const dom = createDom("/", "<div></div>");
  const view = createHomeView(dom.window.document);
  view.update({ feed: feedWith([WEEK]), now: NOW, show: OLD });
  assert.equal(view.element.querySelector(".t3plus-w-session"), null);
  assert.ok(view.element.querySelector(".t3plus-w-usage").classList.contains("t3plus-w-wide"), "three cards: the last spans its row");
  view.destroy();
});

test("home grid: only the cards picked in Settings → t3+ → Widgets", () => {
  const dom = createDom("/", "<div></div>");
  const view = createHomeView(dom.window.document);
  const titles = () => [...view.element.querySelectorAll(".t3plus-w h3")].map((e) => e.textContent);
  view.update({ feed: feedWith([SESSION, WEEK]), now: NOW, show: { ...OLD, claudePool: false, activity: false } });
  assert.deepEqual(titles(), ["Claude 5-Hour", "Usage"]);
  assert.equal(view.element.querySelectorAll(".t3plus-w-wide").length, 0, "two cards share a row");
  view.update({ feed: feedWith([SESSION, WEEK]), now: NOW, show: OLD });
  assert.deepEqual(titles(), ["Claude Pool", "Claude 5-Hour", "Activity", "Usage"], "a change of picks rebuilds the cards");
  view.destroy();
});

test("settings: every home card is on by default, and a stored choice is kept", () => {
  assert.equal(showsAnyCard(Object.fromEntries(HOME_CARDS.map(([key]) => [key, false]))), false);
  assert.equal(showsAnyCard({ claudePool: false, claudeSession: false, codexPool: false, activity: false, usage: false }), true, "the newer cards are still on");
  const d = defaultSettings();
  for (const [key] of HOME_CARDS) assert.equal(d.home[key], true, key);
  assert.equal(normalizeSettings({ home: { usage: false, activity: "x" } }).home.usage, false);
  assert.equal(normalizeSettings({ home: { activity: "x" } }).home.activity, true, "an invalid value falls back");
});

test("homeOrder: known keys once, in the stored order; missing ones join at their default place", () => {
  assert.deepEqual(homeOrder(undefined), ["codexPool", "claudePool", "claudeSession", "forecast", "needsYou", "activity", "usage", "streak", "projects"]);
  assert.deepEqual(homeOrder("usage,activity,usage,bogus"), ["codexPool", "claudePool", "claudeSession", "forecast", "needsYou", "usage", "activity", "streak", "projects"]);
  assert.deepEqual(homeOrder("claudePool,usage,codexPool,activity"), ["claudePool", "usage", "claudeSession", "forecast", "needsYou", "codexPool", "activity", "streak", "projects"], "the missing cards at their default places");
  // An order saved before the newer cards existed keeps its own order; they join at their places.
  assert.deepEqual(homeOrder("claudeSession,claudePool,codexPool,usage,activity"), ["claudeSession", "claudePool", "codexPool", "forecast", "needsYou", "usage", "activity", "streak", "projects"]);
});

test("mergeOrder: hidden cards keep their places while the shown ones are reordered", () => {
  // Codex not shown: only the other four were dragged.
  assert.equal(mergeOrder(undefined, ["usage", "claudePool", "claudeSession", "activity"]), "codexPool,usage,claudePool,forecast,needsYou,claudeSession,activity,streak,projects");
});

test("home grid: cards follow the stored order", () => {
  const dom = createDom("/", "<div></div>");
  const view = createHomeView(dom.window.document);
  view.update({ feed: feedWith([SESSION, WEEK]), now: NOW, show: { ...OLD, order: "usage,claudeSession,activity,claudePool" } });
  assert.deepEqual([...view.element.querySelectorAll(".t3plus-w")].map((e) => e.getAttribute("data-t3plus-card")), ["usage", "claudeSession", "activity", "claudePool"]);
  view.destroy();
});

test("home grid: dragging a card by its header past another reports the new order", () => {
  const dom = createDom("/", "<div></div>");
  const win = dom.window;
  const orders = [];
  const view = createHomeView(win.document, { onReorder: (order) => orders.push(order) });
  win.document.body.append(view.element);
  view.update({ feed: feedWith([SESSION, WEEK]), now: NOW, show: OLD });
  // A 2x2 grid of 100x50 cards, laid out by their place among the cards.
  const cards = () => [...view.element.querySelectorAll(".t3plus-w")];
  for (const card of cards()) {
    card.getBoundingClientRect = () => {
      const i = cards().indexOf(card);
      const left = (i % 2) * 100;
      const top = Math.floor(i / 2) * 50;
      return { left, top, right: left + 100, bottom: top + 50, width: 100, height: 50 };
    };
  }
  // jsdom has no PointerEvent: a mouse event with a pointer id.
  const fire = (target, type, x, y) => {
    const event = new win.MouseEvent(type, { bubbles: true, cancelable: true, button: 0, clientX: x, clientY: y });
    Object.defineProperty(event, "pointerId", { value: 1 });
    return target.dispatchEvent(event);
  };
  const head = view.element.querySelector('[data-t3plus-card="claudePool"] .t3plus-w-head');
  fire(head, "pointerdown", 10, 10);
  fire(head, "pointermove", 20, 10); // starts the drag
  fire(head, "pointermove", 160, 70); // over the Usage card, bottom right
  fire(head, "pointerup", 160, 70);
  assert.deepEqual(cards().map((c) => c.getAttribute("data-t3plus-card")), ["claudeSession", "activity", "usage", "claudePool"]);
  assert.equal(orders.length, 1);
  assert.equal(orders[0], "codexPool,claudeSession,activity,forecast,needsYou,usage,claudePool,streak,projects");
  view.destroy();
});

test("cardAvailability: a card whose provider reports nothing is not offered, with its reason", () => {
  const feed = feedWith([SESSION, WEEK]); // Claude only, Codex off
  const unavailable = cardAvailability(feed);
  assert.match(unavailable.codexPool, /Codex isn't reporting limits/);
  for (const key of ["claudePool", "claudeSession", "activity", "usage"]) assert.equal(unavailable[key], null, key);
  assert.ok(Object.values(cardAvailability(null)).every((v) => v === null), "no feed yet: nothing is known, all offered");
  const noSession = cardAvailability(feedWith([WEEK]));
  assert.match(noSession.claudeSession, /5-hour/);
});

test("home grid: a card turned on but with nothing to show stays out, and comes back once it reports", () => {
  const dom = createDom("/", "<div></div>");
  const view = createHomeView(dom.window.document);
  const keys = () => [...view.element.querySelectorAll(".t3plus-w")].map((e) => e.getAttribute("data-t3plus-card"));
  view.update({ feed: feedWith([SESSION, WEEK]), now: NOW, show: { ...OLD, codexPool: true } });
  assert.deepEqual(keys(), ["claudePool", "claudeSession", "activity", "usage"]);
  const codex = { accounts: [{ label: "Plus", plan: "ChatGPT Plus Subscription", windows: [{ label: "Weekly", kind: "weekly", durationMins: 10080, usedPercent: 10, resetsAt: "2026-11-29T00:00:00Z" }] }] };
  const both = parseHomeFeedText(JSON.stringify({ version: 1, generatedAt: "2026-11-24T21:01:00Z", limits: { claude: [{ label: "Claude", windows: [SESSION, WEEK] }], codex } }));
  view.update({ feed: both, now: NOW, show: { ...OLD, codexPool: true } });
  assert.deepEqual(keys(), ["codexPool", "claudePool", "claudeSession", "activity", "usage"]);
  view.destroy();
});
