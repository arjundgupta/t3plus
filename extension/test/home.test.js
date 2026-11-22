import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { parseBotFeedText, threadSpend } from "../src/botFeed.js";
import { T3PLUS } from "../src/config.js";
import { CODEX_PLAN_WEIGHTS, createHomeFeed, dailyActivity, dayKey, formatTokens, formatUsd, formatUsdExact, heatmap, parseHomeFeedText, poolModel, poolWeights, tokenDaily, tokenSeries } from "../src/homeData.js";
import { createTooltip } from "../src/homeTooltip.js";
import { createHomeView, HEAT_WEEKS } from "../src/homeWidgets.js";
import { blocksFor, createApp, createDom, createFakeChromeStorage, createFakeRemote, ruleBody } from "./helpers.js";

const NOW = new Date(2026, 10, 12, 1, 0, 0); // Thu Nov 12 2026, local
const FEED = {
  version: 1,
  generatedAt: "2026-11-12T06:00:00Z",
  projects: [
    { title: "billing", root: "C:\\Users\\me\\projects\\billing" },
    { title: "notes", root: "C:\\Users\\me\\projects\\notes" },
  ],
  activity: {
    "2026-11-10": [[0, 2, 30], [1, 1, 5]],
    "2026-11-11": [[0, 1, 4]],
    "2026-11-12": [[1, 3, 12]],
    "2026-10-05": [[0, 4, 20]],
    "2026-10-11": [[0, 1, 1]],
  },
  spend: {
    "2026-11-11": { codex: [3, 1000], claude: [7, 2000] },
    "2026-10-10": { codex: [1, 10] },
  },
  limits: {
    claude: [{ id: "claudeAgent", label: "Claude", windows: [
      { label: "Weekly", kind: "weekly", durationMins: 10080, usedPercent: 85, resetsAt: "2026-11-14T10:00:00Z" },
      { label: "Session", kind: "session", durationMins: 300, usedPercent: 13, resetsAt: "2026-11-12T08:40:00Z" },
      { label: "Monthly spend", kind: "monthly", durationMins: null, usedPercent: 39 },
      { label: "Bad", usedPercent: "x" },
    ] }],
    codex: { accounts: [
      { label: "Team", plan: "ChatGPT Pro 200 Subscription", windows: [{ label: "Weekly", kind: "weekly", durationMins: 10080, usedPercent: 50, resetsAt: "2026-11-15T00:00:00Z" }] },
      { label: "Personal", plan: "ChatGPT Plus Subscription", windows: [
        { label: "Session", kind: "session", durationMins: 300, usedPercent: 40 },
        { label: "Weekly", kind: "weekly", durationMins: 10080, usedPercent: 100, resetsAt: "2026-11-13T00:00:00Z" },
      ] },
      { label: "School", plan: "ChatGPT Plus Subscription", windows: [{ label: "Weekly", kind: "weekly", durationMins: 10080, usedPercent: 0 }] },
    ] },
  },
  limitHistory: [{ t: "2026-11-11T00:00:00Z", weekLeft: 900, weekCap: 1200 }, { t: "2026-11-12T00:00:00Z", weekLeft: 600, weekCap: 1200 }, { t: "nope" }],
  // Codex pool every 30 minutes over the last day, falling 10 points an hour: 1340 -> 1100 (of 2200).
  codexSeries: Array.from({ length: 49 }, (_, i) => [Date.UTC(2026, 10, 11, 6) / 1000 + i * 1800, 1340 - i * 5, 2200]).concat([["bad"]]),
  claudeSeries: [[Date.UTC(2026, 10, 12, 5) / 1000, 115, 200]],
  automations: [
    { title: "Inbox cleanup", project: 0, threadKey: "env1:t1", nextRunAt: "2026-11-12T09:00:00Z", lastStatus: "succeeded" },
    { title: "Notes reminder", project: 1, threadKey: "env1:t2", nextRunAt: "2026-11-12T07:00:00Z", lastStatus: "failed" },
    { title: "No schedule", project: 0, threadKey: null, nextRunAt: null },
  ],
};
const feed = () => parseHomeFeedText(JSON.stringify(FEED));

test("home feed parses, validates and drops bad entries", () => {
  const f = feed();
  assert.equal(f.claude[0].windows.length, 3, "malformed window dropped");
  for (const bad of ["", "nope", "{}", JSON.stringify({ version: 2 })]) assert.equal(parseHomeFeedText(bad), null);
});

test("activity counts every project and fills a 26-week heatmap ending today", () => {
  const f = feed();
  const all = dailyActivity(f);
  assert.deepEqual(all.get("2026-11-10"), { runs: 35 });
  const notes = dailyActivity(f, new Set([1]));
  assert.deepEqual([...notes.keys()].sort(), ["2026-11-10", "2026-11-12"], "a subset of projects still works");

  const map = heatmap(all, NOW, 26);
  assert.equal(map.columns.length, 26);
  assert.ok(map.columns.every((c) => c.length === 7));
  const cells = map.columns.flat();
  const today = cells.find((c) => c.today);
  assert.equal(today.key, dayKey(NOW));
  assert.ok(today.level > 0);
  assert.ok(cells.filter((c) => c.future).every((c) => c.level === 0), "no levels in the future");
  assert.equal(map.runs, 72);
  assert.equal(Math.max(...cells.map((c) => c.level)), 4);
});

test("Codex pool: Plus weeks (Pro 200 = 20x, T3's weights), the recorded line, the next weekly reset", () => {
  const f = feed();
  assert.equal(f.codexSeries.length, 49, "malformed point dropped");
  const now = Date.UTC(2026, 10, 12, 6);
  const pool = poolModel(f, "codex", now);
  assert.equal(pool.cap, 2200);
  assert.equal(pool.left, 1000 + 0 + 100);
  assert.equal(pool.recorded.at(-1).left, 1100, "the line ends at the live value");
  assert.ok(pool.recorded.every((p) => p.t >= pool.from && p.t <= now), "the last 3 days only");
  assert.deepEqual(pool.nextRefill, { at: Date.UTC(2026, 10, 13) }, "Personal's week comes back first");
});

test("Claude pool adds up each account's weekly window (100% each)", () => {
  const pool = poolModel(feed(), "claude", Date.UTC(2026, 10, 12, 6));
  assert.equal(pool.cap, 100);
  assert.equal(pool.left, 15);
  assert.equal(poolModel(parseHomeFeedText(JSON.stringify({ ...FEED, limits: { claude: [], codex: null } })), "claude"), null);
});

test("activity numbers and the token series", () => {
  const f = feed();
  const t = tokenSeries(f, NOW, 14);
  assert.equal(t.days.length, 14);
  assert.equal(t.days.at(-1), dayKey(NOW));
  assert.deepEqual(t.series.map((x) => x.provider), ["codex", "claude"]);
  assert.equal(t.series[1].values.at(-2), 2000);
  assert.deepEqual(t.month.claude, { cost: 7, tokens: 2000 });
  assert.equal(formatTokens(27836752), "28M");
  assert.equal(formatTokens(1500000000), "1.5B");
});

// T3's draft hero (ChatView.tsx): the overlay is centered (items-center) and the
// composer stack holds the composer; the headline hangs above it.
const HERO = `
  <div data-slot="sidebar-inner"><ul>
    <li data-thread-item="env1:a1"><div role="button" data-sidebar-row="env1:a1" aria-label="Fix login, billing"><span class="sr-only">Fix login</span>
      <div class="relative z-10"><div><span>billing</span><span class="group/sidebar-status-slot"><span>5h</span><button type="button">Settle</button></span></div><div><span aria-hidden="true">Fix login</span></div></div></div></li>
  </ul></div>
  <main><div data-workspace-area="conversation"><div class="h-full min-h-0 bg-background"></div></div>
    <div data-chat-composer-overlay="true" class="pointer-events-none absolute inset-0 z-20 flex items-center">
      <div class="chat-composer-lane w-full"><div data-chat-composer-stack="true" class="relative">
        <div class="absolute inset-x-0 bottom-full"><h1>What should we build?</h1></div>
        <div class="relative z-10"><div data-chat-composer-surface="true"><div data-chat-composer-body="true"><div data-testid="composer-editor"></div></div></div></div>
      </div></div>
    </div></main>`;

test("app: four compact cards mount under the hero composer (and only there) and follow settings", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: NOW }); // the cards cover the days before today: the fixture's days
  const storage = createFakeChromeStorage();
  const remote = createFakeRemote({ ok: true, status: 200, text: JSON.stringify(FEED) });
  const homeFeed = createHomeFeed({ area: storage.area, fetchRemote: remote });
  const dom = createDom("/draft/abc", HERO);
  const doc = dom.window.document;
  const { app } = createApp(dom, storage, { homeFeed });
  try {
    await app.start();
    await new Promise((r) => setTimeout(r, 0));
    app.watcher.flush();

    const home = doc.getElementById(T3PLUS.homeId);
    assert.ok(home, "mounted");
    assert.equal(home.parentElement, doc.querySelector('[data-chat-composer-stack="true"]'), "inside T3's composer stack");
    assert.ok(doc.documentElement.hasAttribute(T3PLUS.homeAttr));
    assert.deepEqual([...home.querySelectorAll(".t3plus-w-head h3")].map((e) => e.textContent), ["Codex pool", "Claude pool", "Activity", "Usage"]);
    assert.equal(home.querySelectorAll(".t3plus-w-cell").length, HEAT_WEEKS * 7);
    assert.match(home.querySelector(".t3plus-w-codex .t3plus-w-big-num").textContent, /%$/);
    assert.equal(home.querySelector(".t3plus-w-codex .t3plus-w-line-projected"), null, "past usage only: no projection");
    assert.ok(home.querySelector(".t3plus-w-codex .t3plus-w-line"), "the recorded line");
    assert.ok(home.querySelectorAll(".t3plus-w-usage path[stroke]").length >= 2, "one line per provider");
    assert.equal(home.querySelectorAll("button").length, 0, "nothing duplicates the sidebar");

    await app.actions.setHomeWidgets(false);
    app.watcher.flush();
    assert.equal(doc.getElementById(T3PLUS.homeId), null);
    assert.equal(doc.documentElement.hasAttribute(T3PLUS.homeAttr), false);
  } finally {
    app.stop();
  }
});

test("app: no widgets in a normal thread (composer docked at the bottom)", async () => {
  const dom = createDom("/env1/a1", HERO.replace("flex items-center", "bottom-0 inset-x-0"));
  const { app } = createApp(dom, undefined, { homeFeed: { readCache: async () => null, load: async () => null } });
  await app.start();
  app.watcher.flush();
  assert.equal(dom.window.document.getElementById(T3PLUS.homeId), null);
  app.stop();
});

test("pools weigh plans as T3 does: Claude's week is unweighted; Codex is Plus 1x, Pro 100 5x, Pro 200 20x, or all equal when a plan is unknown", () => {
  assert.deepEqual(poolWeights(["ChatGPT Plus Subscription", "ChatGPT Pro 200 Subscription"], CODEX_PLAN_WEIGHTS), [1, 20]);
  assert.deepEqual(poolWeights(["ChatGPT Plus Subscription", "Team"], CODEX_PLAN_WEIGHTS), [1, 1], "an unknown plan: all equal");
  const withPlans = JSON.parse(JSON.stringify(FEED));
  withPlans.limits.claude = [
    { id: "claudeAgent", label: "Claude", plan: "Claude Pro", windows: [{ label: "Weekly", kind: "weekly", durationMins: 10080, usedPercent: 85, resetsAt: "2026-11-14T10:00:00Z" }] },
    { id: "claude_work", label: "Work", plan: "Claude Max", windows: [{ label: "Weekly", kind: "weekly", durationMins: 10080, usedPercent: 40, resetsAt: "2026-11-17T11:00:00Z" }] },
  ];
  const pool = poolModel(parseHomeFeedText(JSON.stringify(withPlans)), "claude", Date.UTC(2026, 10, 12, 6));
  assert.equal(pool.cap, 200, "one week each");
  assert.equal(pool.left, 15 + 60);
  assert.deepEqual(pool.nextRefill, { at: Date.parse("2026-11-14T10:00:00Z") }, "the first account's week resets first");

  const codex = JSON.parse(JSON.stringify(FEED));
  codex.limits.codex = { label: "Hub", accounts: [
    { label: "A", plan: "ChatGPT Plus Subscription", windows: [{ label: "Weekly", kind: "weekly", durationMins: 10080, usedPercent: 0, resetsAt: "2026-11-14T10:00:00Z" }] },
    { label: "B", plan: "ChatGPT Pro 200 Subscription", windows: [{ label: "Weekly", kind: "weekly", durationMins: 10080, usedPercent: 100, resetsAt: "2026-11-14T10:00:00Z" }] },
    { label: "C", plan: "ChatGPT Free", windows: [{ label: "Monthly", kind: "monthly", durationMins: 43200, usedPercent: 30, resetsAt: "2026-12-01T10:00:00Z" }] },
  ] };
  const c = poolModel(parseHomeFeedText(JSON.stringify(codex)), "codex", Date.UTC(2026, 10, 12, 6));
  assert.equal(c.cap, 2100, "a monthly window is no week: that account is not in the weekly pool");
  assert.equal(c.left, 100, "Plus at 0% used + Pro 200 at 100%: 5% left, as T3 shows");
});

test("a recorded pool point is drawn in today's pool size (a probe that missed an account is no dip)", () => {
  const feed = JSON.parse(JSON.stringify(FEED));
  const soon = new Date(Date.UTC(2026, 10, 14, 10)).toISOString();
  feed.limits.codex = { label: "Hub", accounts: [
    { label: "A", plan: "ChatGPT Plus Subscription", windows: [{ label: "Weekly", kind: "weekly", durationMins: 10080, usedPercent: 50, resetsAt: soon }] },
    { label: "B", plan: "ChatGPT Pro 100 Subscription", windows: [{ label: "Weekly", kind: "weekly", durationMins: 10080, usedPercent: 50, resetsAt: soon }] },
  ] };
  const at = Date.UTC(2026, 10, 12, 6);
  feed.codexSeries = [[at / 1000 - 3600, 50, 100], [at / 1000 - 1800, 300, 600]];
  const pool = poolModel(parseHomeFeedText(JSON.stringify(feed)), "codex", at);
  assert.equal(pool.cap, 600);
  assert.deepEqual(pool.recorded.slice(0, 2).map((p) => Math.round(p.left)), [300, 300], "50 of 100 is 300 of 600");
});

test("Activity uses the activity source's tokens per day when the feed has them", () => {
  const f = parseHomeFeedText(JSON.stringify({ ...FEED, aiActivity: { "2026-11-11": [1018102370, { codex: 416198814, claude: 601903556, cursor: 0 }], "2026-11-10": 0, "2026-11-08": 7, bad: 5, "2026-11-09": "x" } }));
  assert.deepEqual([...f.aiActivity.keys()], ["2026-11-11", "2026-11-10", "2026-11-08"]);
  assert.deepEqual(f.aiActivity.get("2026-11-11").providers, { codex: 416198814, claude: 601903556 }, "zero providers dropped");
  assert.deepEqual([...tokenDaily(f)], [
    ["2026-11-11", { runs: 1018102370, providers: { codex: 416198814, claude: 601903556 } }],
    ["2026-11-08", { runs: 7, providers: {} }],
  ], "older feeds (bare totals) still work");
});

test("hover: a T3-style tooltip for heatmap days and chart points, a crosshair, and clean removal", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: NOW }); // today is the fixture's, also past midnight
  const storage = createFakeChromeStorage();
  const feedJson = { ...FEED, aiActivity: { [dayKey(NOW)]: [900, { codex: 600, claude: 300 }] } };
  const remote = createFakeRemote({ ok: true, status: 200, text: JSON.stringify(feedJson) });
  const homeFeed = createHomeFeed({ area: storage.area, fetchRemote: remote });
  const dom = createDom("/draft/abc", HERO);
  const doc = dom.window.document;
  const { app } = createApp(dom, storage, { homeFeed });
  const move = (el) => el.dispatchEvent(new dom.window.MouseEvent("pointermove", { bubbles: true, clientX: 10, clientY: 10 }));
  try {
    await app.start();
    await new Promise((r) => setTimeout(r, 0));
    app.watcher.flush();
    const home = doc.getElementById(T3PLUS.homeId);
    assert.equal(home.querySelectorAll(".t3plus-w-cell[title]").length, 0, "no native title tooltips");

    move(home.querySelector(".t3plus-w-cell[data-today]"));
    const tip = doc.getElementById("t3plus-tip");
    assert.ok(tip && tip.parentElement === doc.body, "one tooltip on <body>");
    assert.ok(tip.hasAttribute("data-open"));
    assert.equal(tip.getAttribute("aria-hidden"), "true");
    assert.deepEqual([...tip.querySelectorAll(".t3plus-tip-row")].map((r) => r.textContent), ["Codex600", "Claude300", "Total900"]);

    move(home.querySelector(".t3plus-w-usage .t3plus-w-plot svg"));
    assert.match(tip.querySelector(".t3plus-tip-total").textContent, /^Total/);
    const marker = home.querySelector(".t3plus-w-usage .t3plus-w-hover");
    assert.ok(marker.hasAttribute("data-on"), "crosshair shown");
    assert.ok(marker.querySelectorAll(".t3plus-w-hover-dot").length >= 2, "a dot per provider");
    assert.match(marker.style.translate, /px 0$/, "moved by translate (composited), not left");
    assert.equal(marker.style.left, "");

    move(home.querySelector(".t3plus-w-codex .t3plus-w-plot svg"));
    assert.match(tip.querySelector(".t3plus-tip-row").textContent, /^Left/);
    assert.equal(marker.hasAttribute("data-on"), false, "only one crosshair at a time");

    home.dispatchEvent(new dom.window.MouseEvent("pointerleave"));
    assert.equal(tip.hasAttribute("data-open"), false, "fades out on leave");
  } finally {
    app.stop();
  }
  assert.equal(doc.getElementById("t3plus-tip"), null, "removed when t3+ stops");
});

test("tooltip skips null rows instead of exposing a literal null", () => {
  const dom = createDom("/draft/abc", "");
  const tip = createTooltip(dom.window.document);
  tip.show(
    { x: 40, top: 80, bottom: 100 },
    { label: "2:17 PM", rows: [{ name: "Left", value: "293% of 600" }, { name: null, value: null }, { name: "null", value: "null" }] },
  );
  assert.equal(dom.window.document.getElementById("t3plus-tip").textContent, "2:17 PMLeft293% of 600");
});

test("content.css: the glow follows the composer in the same frame; the cards stay inside the window and the pool head wraps", () => {
  // No animated custom properties for the glow: on <html>, each change restyled the whole page.
  assert.deepEqual(blocksFor("@property --t3plus-glow"), []);
  const placed = blocksFor(".t3plus-glow-pos").filter(({ sel }) => sel.split(",").some((s) => s.trim().endsWith(".t3plus-glow-pos")));
  assert.ok(placed.length > 0 && placed.every(({ body }) => !/transition/.test(body)), "moved in the same frame, never eased behind the composer");
  assert.match(ruleBody(".t3plus-home"), /left:\s*0;[\s\S]*right:\s*0;/, "hung from the composer stack: exactly its width");
  assert.doesNotMatch(ruleBody(".t3plus-home"), /(^|[;{\s])(max-)?width:/, "no width of its own");
  assert.match(ruleBody(".t3plus-details-pool .t3plus-w-pool-head"), /flex-wrap:\s*wrap/);
});

test("the cards take the composer's width from CSS (hung from its stack): no width is measured or written, so none lags a resize", async () => {
  const dom = createDom("/draft/abc", HERO);
  const doc = dom.window.document;
  const pane = doc.querySelector('[data-workspace-area="conversation"]');
  const stack = doc.querySelector('[data-chat-composer-stack="true"]');
  const box = (left, width) => () => ({ left, width, right: left + width, top: 0, height: 100, bottom: 100 });
  const { app } = createApp(dom, undefined, { homeFeed: { readCache: async () => null, load: async () => null } });
  await app.start();
  for (const [paneWidth, composerLeft, composerWidth] of [[1600, 450, 700], [1000, 600, 700], [604, 13, 578]]) {
    pane.getBoundingClientRect = box(0, paneWidth);
    stack.getBoundingClientRect = box(composerLeft, composerWidth);
    app.watcher.flush();
    const cards = doc.getElementById(T3PLUS.homeId);
    assert.equal(cards.parentElement, stack, "inside the composer stack");
    assert.equal(cards.style.width, "", `${paneWidth}: no inline width`);
  }
  app.stop?.();
});

test("pool card: two plain lines, what remains and when it resets (to the minute it means)", () => {
  const dom = createDom("/", "<div></div>");
  const view = createHomeView(dom.window.document, { variant: "pool" });
  const now = new Date("2026-11-16T20:00:00Z");
  const feedJson = { ...FEED, limits: { claude: [{ id: "c1", label: "Claude", plan: "Claude Pro", windows: [{ label: "Weekly", durationMins: 10080, usedPercent: 36, resetsAt: "2026-11-19T16:59:59.594Z" }] }], codex: null, pool: null } };
  view.update({ feed: parseHomeFeedText(JSON.stringify(feedJson)), kind: "claude", now });
  const card = view.element.querySelector(".t3plus-w");
  assert.equal(card.querySelector(".t3plus-w-pool-head").textContent, "64%remaining");
  const expected = `Reset - ${["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"][new Date("2026-11-19T17:00:00Z").getDay()]} ${new Date("2026-11-19T17:00:00Z").toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}`;
  assert.equal(card.querySelector(".t3plus-w-reset").textContent, expected, "rounded to the minute");
  assert.equal(card.querySelector(".t3plus-w-aside"), null, "no 'Lasts the week' in the corner");
  view.destroy();
});

test("pool card: a reset reads Today or Tomorrow, then its weekday within the week, else its date", () => {
  const dom = createDom("/", "<div></div>");
  const now = new Date(2026, 10, 16, 20, 0); // Monday 8 PM, local
  const resetLine = (resetsAt) => {
    const view = createHomeView(dom.window.document, { variant: "pool" });
    const feedJson = { ...FEED, limits: { claude: [{ id: "c1", label: "Claude", plan: "Claude Pro", windows: [{ label: "Weekly", durationMins: 10080, usedPercent: 36, resetsAt: resetsAt.toISOString() }] }], codex: null, pool: null } };
    view.update({ feed: parseHomeFeedText(JSON.stringify(feedJson)), kind: "claude", now });
    const text = view.element.querySelector(".t3plus-w-reset").textContent;
    view.destroy();
    return text;
  };
  const time = (d) => d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  for (const [resetsAt, day] of [
    [new Date(2026, 10, 16, 21, 0), "Today"],
    [new Date(2026, 10, 17, 9, 0), "Tomorrow"],
    [new Date(2026, 10, 20, 12, 0), "Friday"],
    [new Date(2026, 10, 23, 10, 0), "Nov 23,"], // a week on: the date, not "Monday"
  ]) {
    assert.equal(resetLine(resetsAt), `Reset - ${day} ${time(resetsAt)}`);
  }
});

test("a single account's pool is 100%, whatever its plan (Codex Pro, Claude Max)", () => {
  const week = (used) => ({ label: "Weekly", kind: "weekly", durationMins: 10080, usedPercent: used, resetsAt: "2026-11-18T16:39:52.000Z" });
  const f = parseHomeFeedText(
    JSON.stringify({
      version: 1,
      limits: {
        codex: { checkedAt: "2026-11-17T01:00:00Z", accounts: [{ label: "Codex", plan: "ChatGPT Pro 200 Subscription", windows: [week(4)] }] },
        claude: [{ id: "claudeAgent", label: "Claude", plan: "Claude Max", windows: [week(39)] }],
      },
    }),
  );
  const now = Date.UTC(2026, 10, 17, 2);
  assert.deepEqual([poolModel(f, "codex", now).left, poolModel(f, "codex", now).cap], [96, 100]);
  assert.deepEqual([poolModel(f, "claude", now).left, poolModel(f, "claude", now).cap], [61, 100]);
});

test("thread spend: parsed from the bot feed and shown under the details pool card", () => {
  const feed = parseBotFeedText(JSON.stringify({ version: 1, bots: { t1: { text: "hi", role: "assistant", spend: { usd: 121.974, tokens: 354000000 } }, t2: { text: "x", spend: { usd: "nope" } } } }));
  assert.deepEqual(threadSpend(feed, "env1:t1"), { usd: 121.974, tokens: 354000000 });
  assert.equal(threadSpend(feed, "env1:t2"), null, "bad values are dropped");
  const dom = createDom("/", "<div></div>");
  const view = createHomeView(dom.window.document, { variant: "pool" });
  view.update({ feed: parseHomeFeedText(JSON.stringify(FEED)), kind: "claude", now: new Date("2026-11-16T20:00:00Z"), spend: threadSpend(feed, "env1:t1") });
  assert.equal(view.element.querySelector(".t3plus-w-spend").textContent, "Spend$121.97 · 354M");
});

test("widget tooltips: one element per view (unique ids), and hide() closes one left open by a still pointer", () => {
  const dom = createDom("/", "<div></div>");
  const doc = dom.window.document;
  const home = createHomeView(doc);
  const pool = createHomeView(doc, { variant: "pool" });
  const now = new Date("2026-11-16T20:00:00Z");
  home.update({ feed: parseHomeFeedText(JSON.stringify(FEED)), now });
  pool.update({ feed: parseHomeFeedText(JSON.stringify(FEED)), kind: "claude", now });
  doc.body.append(home.element, pool.element);
  const plotOf = (view) => view.element.querySelector(".t3plus-w-plot");
  for (const view of [home, pool]) plotOf(view).dispatchEvent(new dom.window.MouseEvent("pointermove", { bubbles: true, clientX: 5, clientY: 5 }));
  const tips = [...doc.querySelectorAll(".t3plus-tip")];
  assert.equal(tips.length, 2);
  assert.equal(new Set(tips.map((t) => t.id)).size, 2, "no duplicate ids");
  assert.ok(tips.every((t) => t.hasAttribute("data-open")));
  // The cards leave the page under a still pointer (a thread switch): no pointerleave comes.
  home.element.remove();
  home.hide();
  assert.equal(tips.filter((t) => t.hasAttribute("data-open")).length, 1, "the home tooltip closed, the other is untouched");
  assert.equal(home.element.querySelector(".t3plus-w-hover[data-on]"), null, "and its crosshair");
  home.destroy();
  pool.destroy();
});

test("token counts never read 1000K or 10.0M, and Codex accounts without a reported week do not count as 100% left", () => {
  assert.deepEqual([999, 999_400, 999_600, 9_949_999, 9_999_999, 999_999_999, 9.96e9].map(formatTokens), ["999", "999K", "1.0M", "9.9M", "10M", "1.0B", "10B"]);
  const week = { label: "Weekly", kind: "weekly", durationMins: 10080, usedPercent: 60, resetsAt: "2026-11-20T00:00:00Z" };
  const feed = { codex: { accounts: [{ label: "A", plan: "Plus", windows: [week] }, { label: "B (limits failed to load)", plan: "Pro", windows: [] }] }, codexSeries: [], claude: [], claudeSeries: [] };
  const pool = poolModel(feed, "codex", Date.parse("2026-11-17T00:00:00Z"));
  assert.equal(pool.cap, 100, "only the account that reports a week");
  assert.equal(Math.round(pool.left), 40);
  assert.equal(poolModel({ ...feed, codex: { accounts: [{ label: "B", plan: "Pro", windows: [] }] } }, "codex"), null);
});

test("pool card: data that stopped updating says how old it is", () => {
  const dom = createDom("/", "<div></div>");
  const view = createHomeView(dom.window.document, { variant: "pool" });
  const feedJson = { ...FEED, generatedAt: "2026-11-16T14:00:00Z", limits: { claude: [{ id: "c1", label: "Claude", plan: "Claude Pro", windows: [{ label: "Weekly", durationMins: 10080, usedPercent: 36, resetsAt: "2026-11-19T16:59:59Z" }] }], codex: null, pool: null } };
  view.update({ feed: parseHomeFeedText(JSON.stringify(feedJson)), kind: "claude", now: new Date("2026-11-16T20:00:00Z") });
  assert.equal(view.element.querySelector(".t3plus-w-stale")?.textContent, "Updated 6 h ago");
  view.update({ feed: parseHomeFeedText(JSON.stringify({ ...feedJson, generatedAt: "2026-11-16T19:50:00Z" })), kind: "claude", now: new Date("2026-11-16T20:00:00Z") });
  assert.equal(view.element.querySelector(".t3plus-w-stale"), null, "fresh data has no note");
  view.destroy();
});

test("dollars never read $1000, $100.00 or $10.0k", () => {
  const cases = [[12.345, "$12.35"], [99.994, "$99.99"], [99.996, "$100"], [999.4, "$999"], [999.6, "$1.0k"], [9949, "$9.9k"], [9994, "$10k"], [12345, "$12k"]];
  for (const [v, want] of cases) assert.equal(formatUsd(v), want, String(v));
  assert.equal(formatUsdExact(999.994), "$999.99");
  assert.equal(formatUsdExact(999.996), "$1.00k");
});

test("leaving the new-thread page: the hero layout goes in the overlay's class watch, before any check (T3 docked the composer in that commit)", async () => {
  const dom = createDom("/draft/abc", HERO);
  const doc = dom.window.document;
  const overlay = doc.querySelector("[data-chat-composer-overlay]");
  const { app } = createApp(dom, undefined, { homeFeed: { readCache: async () => null, load: async () => null } });
  await app.start();
  app.watcher.flush();
  const html = doc.documentElement;
  assert.ok(html.hasAttribute(T3PLUS.homeAttr) && html.hasAttribute(T3PLUS.widgetsAttr), "on the hero, widgets on");
  assert.ok(overlay.hasAttribute(T3PLUS.heroAttr), "the overlay t3+ lays out is marked");
  let checks = 0;
  const schedule = app.watcher.schedule;
  app.watcher.schedule = () => {
    checks += 1;
  };
  overlay.classList.remove("items-center"); // T3 docks the composer: the first message sent
  await new Promise((r) => setTimeout(r, 0)); // the observer's callback (a microtask), no check
  assert.equal(html.hasAttribute(T3PLUS.homeAttr), false, "the page attribute is gone at once");
  assert.equal(overlay.hasAttribute(T3PLUS.heroAttr), false);
  assert.equal(overlay.style.getPropertyValue("padding-top"), "", "the hero's padding with it");
  assert.equal(doc.getElementById(T3PLUS.homeId), null, "the cards with it");
  assert.ok(html.hasAttribute(T3PLUS.widgetsAttr), "the widgets setting itself stays");
  app.watcher.schedule = schedule;
  app.stop?.();
  assert.equal(html.hasAttribute(T3PLUS.widgetsAttr), false, "and goes when t3+ stops");
});

test("content.css: the new-thread centering keys on T3's own hero class on the canvas holding it, never on a page attribute alone", () => {
  const css = readFileSync(new URL("../src/styles/content.css", import.meta.url), "utf8");
  const hero = '[data-chat-canvas]:has(> [data-chat-composer-overlay="true"][class~="items-center"])';
  assert.ok(css.includes(`html[data-t3plus-widgets] ${hero} {`), "the room zeroed only on a canvas holding a hero");
  assert.ok(css.includes(`html[data-t3plus-widgets] ${hero} > aside[data-thread-details-panel="inline"]`), "and only that canvas's inline card hidden");
  assert.doesNotMatch(css, /html\[data-t3plus-home\] \[data-chat-canvas\]/, "no page-wide zero (it reached side chats and lingered on the thread the first message opened)");
  assert.doesNotMatch(css, /html\[data-t3plus-home\] aside\[data-thread-details-panel="inline"\]/);
});

test("the glow follows T3's own slide of the composer (a Web Animation on its lane) every frame until it ends, then once more where it stopped", async () => {
  const dom = createDom("/env1/a1", `<div data-workspace-area="conversation"></div><div data-chat-canvas><div class="chat-composer-lane"><div data-chat-composer-surface="true"></div></div></div>`);
  const doc = dom.window.document;
  const lane = doc.querySelector(".chat-composer-lane");
  let finish;
  const animation = { playState: "running", pending: false, finished: new Promise((r) => (finish = r)) };
  lane.getAnimations = () => (animation.playState === "running" ? [animation] : []);
  const frames = [];
  dom.window.requestAnimationFrame = (f) => frames.push(f);
  dom.window.cancelAnimationFrame = () => {};
  const updates = [];
  const { app } = createApp(dom, undefined, { backdropRenderer: { update: (o) => updates.push(o), clear() {} } });
  await app.start();
  app.watcher.flush();
  assert.ok(frames.length > 0, "a frame asked for while the slide runs");
  const before = updates.length;
  for (let i = 0; i < 3 && frames.length; i += 1) frames.shift()();
  assert.ok(updates.length >= before + 3, "placed again every frame");
  animation.playState = "finished";
  finish();
  await new Promise((r) => setTimeout(r, 0));
  const settled = updates.length;
  assert.ok(settled > before + 3, "one last placement when it ends");
  while (frames.length) frames.shift()();
  assert.ok(updates.length <= settled + 1, "and the frames stop");
  app.stop?.();
});
