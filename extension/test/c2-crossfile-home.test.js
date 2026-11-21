import assert from "node:assert/strict";
import { test } from "node:test";
import { createTooltip } from "../src/homeTooltip.js";
import { createDom } from "./helpers.js";

test("the chart tooltip is measured again only when its anchor, its content or the window's width changes", () => {
  const dom = createDom("/", "");
  const doc = dom.window.document;
  const tip = createTooltip(doc);
  let reads = 0;
  Object.defineProperty(tip.element, "offsetWidth", { get: () => ((reads += 1), 120) });
  const content = { label: "Thu, Nov 19", rows: [{ name: "Claude", value: "2K" }] };
  const anchor = { x: 100, top: 50, bottom: 60 };
  tip.show(anchor, content);
  const first = reads;
  for (let i = 0; i < 10; i += 1) tip.show({ ...anchor }, { ...content, rows: [...content.rows] });
  assert.equal(reads, first, "the same day: not measured again");
  tip.show({ ...anchor, top: 40 }, content);
  assert.equal(reads, first + 1, "the anchor moved (the grid scrolled): placed again");
  assert.equal(tip.element.style.getPropertyValue("--tip-y").endsWith("px"), true);
  tip.show({ ...anchor, top: 40 }, { label: "Fri, Nov 20" });
  assert.equal(reads, first + 2, "other content, another size");
  tip.hide();
  tip.show({ ...anchor, top: 40 }, { label: "Fri, Nov 20" });
  assert.ok(tip.element.hasAttribute("data-open"), "shown again after a hide");
});

test("a provider named like Object's own members neither reaches Object.prototype nor draws as Object", async (t) => {
  const { parseHomeFeedText, tokenSeries } = await import("../src/homeData.js");
  const { createHomeView } = await import("../src/homeWidgets.js");
  const now = new Date(2026, 10, 19, 12);
  const day = "2026-11-19";
  const text = `{"version":1,"generatedAt":"2026-11-19T12:00:00Z","spend":{"${day}":{"codex":[3,1000],"__proto__":[5,700],"constructor":[1,300]}},"aiActivity":{"${day}":[1300,{"codex":1000,"__proto__":7,"constructor":300}]}}`;
  try {
    const feed = parseHomeFeedText(text);
    const series = tokenSeries(feed, now);
    assert.equal(Object.hasOwn(Object.prototype, "cost"), false);
    assert.equal(Object.cost, undefined);
    assert.deepEqual(Object.keys(series.month).sort(), ["codex", "constructor"]);
    t.mock.timers.enable({ apis: ["Date"], now });
    const dom = createDom("/", "");
    const view = createHomeView(dom.window.document);
    dom.window.document.body.append(view.element);
    view.update({ feed });
    const html = view.element.outerHTML;
    assert.ok(!html.includes("[object Object]") && !html.includes("native code"), "no Object members drawn");
    assert.match(view.element.textContent, /constructor 300/, "its own name, in the legend");
    view.destroy?.();
  } finally {
    delete Object.prototype.cost;
    delete Object.prototype.tokens;
    delete Object.cost;
    delete Object.tokens;
  }
});

test("keyboard: each chart is a Tab stop whose arrow keys step through its days, with the tooltip and a status line", async (t) => {
  const { parseHomeFeedText } = await import("../src/homeData.js");
  const { createHomeView } = await import("../src/homeWidgets.js");
  const now = new Date(2026, 10, 19, 12);
  t.mock.timers.enable({ apis: ["Date"], now });
  const spend = { "2026-11-18": { codex: [3, 1000], claude: [7, 2000] }, "2026-11-19": { codex: [1, 500] } };
  const feed = parseHomeFeedText(JSON.stringify({ version: 1, generatedAt: "2026-11-19T12:00:00Z", spend, activity: { "2026-11-12": [[0, 1, 4]], "2026-11-19": [[0, 1, 2]] } }));
  const dom = createDom("/", "");
  const doc = dom.window.document;
  const view = createHomeView(doc);
  doc.body.append(view.element);
  view.update({ feed, now });
  const key = (el, k) => el.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true }));
  const status = () => view.element.querySelector('[role="status"]').textContent;
  const tip = () => doc.querySelector(".t3plus-tip");

  const usage = view.element.querySelector('[data-t3plus-chart="usage"]');
  assert.equal(usage.tabIndex, 0);
  assert.equal(usage.getAttribute("role"), "application", "not img: browse mode would swallow the arrow keys");
  usage.focus();
  assert.match(status(), /^Thu, Nov 19: Codex 500/, "the latest day first");
  assert.ok(tip().hasAttribute("data-open"));
  assert.ok(usage.querySelector(".t3plus-w-hover[data-on]"), "its crosshair");
  key(usage, "ArrowLeft");
  assert.match(status(), /^Wed, Nov 18: Claude 2K, Codex 1K Total 3K · \$10/);
  key(usage, "Escape");
  assert.equal(tip().hasAttribute("data-open"), false);

  const heat = view.element.querySelector('[data-t3plus-chart="activity"]');
  heat.focus();
  assert.match(status(), /Nov 19: Turns 2$/, "today");
  key(heat, "ArrowLeft");
  assert.match(status(), /Nov 12: Turns 4$/, "a week back");
  assert.ok(view.element.querySelector(".t3plus-w-cell[data-t3plus-sel]"));
  heat.blur();
  assert.equal(view.element.querySelector(".t3plus-w-cell[data-t3plus-sel]"), null);

  usage.focus();
  assert.match(status(), /^Wed, Nov 18/, "back on the day it was left on");
  key(usage, "ArrowLeft");
  view.update({ feed: { ...feed, generatedAt: "2026-11-19T12:05:00Z" }, now }); // the feed republished
  const again = view.element.querySelector('[data-t3plus-chart="usage"]');
  assert.notEqual(again, usage, "rebuilt");
  assert.equal(doc.activeElement, again, "the focus stays on the chart");
  assert.match(status(), /^Tue, Nov 17/, "on the same day");
  view.destroy();
});

test("a chart focused by a click is the pointer's: no day is picked for it, Tab still picks the latest", async (t) => {
  const { parseHomeFeedText } = await import("../src/homeData.js");
  const { createHomeView } = await import("../src/homeWidgets.js");
  const now = new Date(2026, 10, 19, 12);
  t.mock.timers.enable({ apis: ["Date"], now });
  const feed = parseHomeFeedText(JSON.stringify({ version: 1, generatedAt: "2026-11-19T12:00:00Z", activity: { "2026-11-12": [[0, 1, 4]], "2026-11-19": [[0, 1, 2]] } }));
  const dom = createDom("/", "");
  const doc = dom.window.document;
  const view = createHomeView(doc);
  doc.body.append(view.element);
  view.update({ feed, now });
  const heat = view.element.querySelector('[data-t3plus-chart="activity"]');
  const tip = () => doc.querySelector(".t3plus-tip");
  const cell = heat.querySelector(".t3plus-w-cell");
  cell.dispatchEvent(new dom.window.Event("pointerdown", { bubbles: true }));
  heat.focus(); // what a click on a Tab stop does
  cell.dispatchEvent(new dom.window.Event("pointerup", { bubbles: true }));
  assert.equal(view.element.querySelector(".t3plus-w-cell[data-t3plus-sel]"), null, "no ring on today's cell under a pointer elsewhere");
  assert.ok(!tip()?.hasAttribute("data-open"), "no tooltip jumping to today");
  heat.blur();
  heat.focus(); // Tab
  assert.ok(view.element.querySelector(".t3plus-w-cell[data-t3plus-sel]"), "from the keyboard: today, ringed");
  view.destroy();
});
