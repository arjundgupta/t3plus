import assert from "node:assert/strict";
import { test } from "node:test";
import { hasPool, parseHomeFeedText, poolModel } from "../src/homeData.js";

// Whether there is a pool to draw is asked in every DOM check while the thread details
// show Usage limits: answered without making the pool (poolModel), and always the same.

const week = (usedPercent, extra = {}) => ({ label: "Weekly", durationMins: 10080, usedPercent, resetsAt: "2026-11-19T16:59:59Z", ...extra });
const month = { label: "Monthly", durationMins: 43200, usedPercent: 10, resetsAt: "2026-12-01T00:00:00Z" };
const LIMITS = {
  "both, several Codex accounts": { claude: [{ id: "c1", label: "Claude", plan: "Claude Max", windows: [week(36)] }], codex: { accounts: [{ label: "A", plan: "ChatGPT Plus Subscription", windows: [week(10)] }, { label: "B", plan: "ChatGPT Pro 100 Subscription", windows: [week(50, { kind: "weekly" })] }] } },
  "a monthly window only": { claude: [{ id: "c1", label: "Claude", plan: "Claude Pro", windows: [month] }], codex: { accounts: [{ label: "A", plan: "x", windows: [month] }] } },
  "limits that failed to load": { claude: [{ id: "c1", label: "Claude", plan: "Claude Pro", windows: [] }], codex: { accounts: [{ label: "A", plan: "x", windows: [] }] } },
  "a week told by its length alone, reset in the past": { claude: [{ id: "c1", label: "Claude", plan: "", windows: [week(99, { label: "7 days", resetsAt: "2020-01-01T00:00:00Z" })] }], codex: null },
  "no accounts": { claude: [], codex: null },
};

test("hasPool answers as poolModel does, for every kind of limits, without making the pool", () => {
  for (const [name, limits] of Object.entries(LIMITS)) {
    const feed = parseHomeFeedText(JSON.stringify({ version: 1, generatedAt: "2026-11-16T14:00:00Z", limits }));
    for (const kind of ["codex", "claude"]) {
      for (const now of [Date.parse("2026-11-16T14:00:00Z"), Date.parse("2026-12-30T00:00:00Z")]) {
        assert.equal(hasPool(feed, kind), Boolean(poolModel(feed, kind, now)), `${name}, ${kind}`);
      }
    }
  }
  assert.equal(hasPool(null, "claude"), false, "no feed yet");
});

test("the home charts' tooltip, rebuilt as the pointer moves over them, sets off no DOM check (it is t3+'s own)", async () => {
  const { createTooltip } = await import("../src/homeTooltip.js");
  const { createApp, createDom, createFakeChromeStorage } = await import("./helpers.js");
  const dom = createDom("/", "<main></main>");
  const { app } = createApp(dom, createFakeChromeStorage(), { throttleMs: 0 });
  await app.start();
  app.watcher.flush();
  await new Promise((resolve) => setTimeout(resolve, 10));
  const checks = app.perf.checks;
  const tip = createTooltip(dom.window.document);
  for (let i = 0; i < 20; i += 1) {
    tip.show({ x: 100 + i, top: 200, bottom: 220 }, { label: `Nov ${i}`, rows: [{ name: "Tokens", value: String(i) }] });
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  tip.hide();
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(app.perf.checks, checks);
  // Moves over the same point (a new content object each time, reading the same): its rows are kept.
  const point = () => ({ label: "Nov 3", rows: [{ name: "Tokens", value: "1.2M", color: "#22aa66" }], total: { name: "Total", value: "1.2M" } });
  tip.show({ x: 100, top: 200, bottom: 220 }, point());
  const label = tip.element.firstChild;
  tip.show({ x: 104, top: 200, bottom: 220 }, point());
  assert.equal(tip.element.firstChild, label, "not built again");
  tip.show({ x: 104, top: 200, bottom: 220 }, { ...point(), label: "Nov 4" });
  assert.notEqual(tip.element.firstChild, label, "another point: built anew");
  assert.equal(tip.element.firstChild.textContent, "Nov 4");
  tip.remove();
  app.stop();
});
