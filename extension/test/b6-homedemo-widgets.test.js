import assert from "node:assert/strict";
import { test } from "node:test";
import { parseHomeFeedText } from "../src/homeData.js";
import { createHomeView } from "../src/homeWidgets.js";
import { createDom } from "./helpers.js";

const MIN = 60000;
const DAY = 86400000;
const NOW = Date.UTC(2026, 10, 19, 17, 0, 30); // early in a five-minute rebuild window
const seconds = (ms) => Math.floor(ms / 1000);
// The old week's last two days, recorded every 30 minutes: 60% left, falling to about 5%.
const OLD_WEEK = Array.from({ length: 96 }, (_, i) => [seconds(NOW - (96 - i) * 30 * MIN), 60 - i * 0.57, 100]);

/** A feed with one Claude account whose week resets at `resetsAt` (nothing used yet), as JSON. */
const feedText = (resetsAt, extra = [], generatedAt = new Date(NOW - 10_000).toISOString()) =>
  JSON.stringify({
    version: 1,
    generatedAt,
    limits: { claude: [{ id: "c1", label: "Claude", windows: [{ label: "Weekly", kind: "weekly", durationMins: 10080, usedPercent: 0, resetsAt: new Date(resetsAt).toISOString() }] }], codex: null },
    claudeSeries: [...OLD_WEEK, ...extra],
  });
const poolView = () => createHomeView(createDom("/", "").window.document, { variant: "pool" });
/** The recorded line's points, in the plot's 300 x 72 units. */
const linePoints = (view) => [...view.element.querySelector(".t3plus-w-line").getAttribute("d").matchAll(/[ML](-?[\d.]+) (-?[\d.]+)/g)].map((m) => [Number(m[1]), Number(m[2])]);

test("pool chart: a reset reported a little over a week out (the provider's clock ahead) still draws on the plot", () => {
  const view = poolView();
  view.update({ feed: parseHomeFeedText(feedText(NOW + 7 * DAY + 90_000)), kind: "claude", now: new Date(NOW) });
  const points = linePoints(view);
  assert.ok(points.length >= 2, "a line");
  for (const [x] of points) assert.ok(x >= 0 && x <= 300, `x=${x} is on the plot`);
  view.destroy();
});

test("pool chart: right after a weekly reset it shows this week only, not the old week's tail", () => {
  const view = poolView();
  view.update({ feed: parseHomeFeedText(feedText(NOW + 7 * DAY - 10 * MIN, [[seconds(NOW - 5 * MIN), 100, 100]])), kind: "claude", now: new Date(NOW) });
  const levels = new Set(linePoints(view).map(([, y]) => y));
  assert.equal(levels.size, 1, `one level, 100% (no jump from last week): ${[...levels]}`);
  view.destroy();
});

test("a feed without generatedAt replaces 'Waiting for the home feed…' at once; the same feed read again is no rebuild", () => {
  const view = poolView();
  assert.equal(view.update({ feed: null, kind: "claude", now: new Date(NOW) }), true);
  assert.match(view.element.textContent, /Waiting for the home feed/);
  const text = feedText(NOW + 3 * DAY, [], null);
  assert.equal(parseHomeFeedText(text).generatedAt, null);
  assert.equal(view.update({ feed: parseHomeFeedText(text), kind: "claude", now: new Date(NOW + MIN) }), true, "rebuilt within the same five minutes");
  assert.ok(view.element.querySelector(".t3plus-w-big-num"), "the pool's numbers");
  assert.doesNotMatch(view.element.textContent, /Waiting/);
  assert.equal(view.update({ feed: parseHomeFeedText(text), kind: "claude", now: new Date(NOW + 2 * MIN) }), false, "a fresh parse of the same feed (the 2-minute poll) is the same cards");
  view.destroy();
});
