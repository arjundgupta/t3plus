import assert from "node:assert/strict";
import { test } from "node:test";
import {
  activityStats,
  dailyActivity,
  dayKey,
  formatTokens,
  heatmap,
  parseHomeFeedText,
  poolModel,
  projectSet,
  projectPool,
  tokenSeries,
} from "../src/homeData.js";
import { T3PLUS } from "../src/config.js";
import { createTooltip } from "../src/homeTooltip.js";
import { HEAT_WEEKS } from "../src/homeWidgets.js";
import { createApp, createDom, createFakeChromeStorage, createFakeRemote } from "./helpers.js";

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
  assert.equal(f.projects.length, 2);
  assert.equal(f.claude[0].windows.length, 3, "malformed window dropped");
  assert.equal(f.history.length, 2);
  assert.equal(f.automations[2].threadKey, null);
  for (const bad of ["", "nope", "{}", JSON.stringify({ version: 2 })]) assert.equal(parseHomeFeedText(bad), null);
});

test("activity counts every project and fills a 26-week heatmap ending today", () => {
  const f = feed();
  const all = dailyActivity(f, projectSet(f));
  assert.deepEqual(all.get("2026-11-10"), { threads: 3, runs: 35 });
  const notes = dailyActivity(f, new Set([f.projects.findIndex((p) => p.title === "notes")]));
  assert.deepEqual([...notes.keys()].sort(), ["2026-11-10", "2026-11-12"], "a subset of projects still works");

  const map = heatmap(all, NOW, 26);
  assert.equal(map.columns.length, 26);
  assert.ok(map.columns.every((c) => c.length === 7));
  const cells = map.columns.flat();
  const today = cells.find((c) => c.today);
  assert.equal(today.key, dayKey(NOW));
  assert.ok(today.level > 0);
  assert.ok(cells.filter((c) => c.future).every((c) => c.level === 0), "no levels in the future");
  assert.equal(map.threads, 12);
  assert.equal(map.runs, 72);
  assert.equal(Math.max(...cells.map((c) => c.level)), 4);
});

test("Codex pool: Plus weeks (Pro 200 = 20x, T3's weights), recorded line, projection at the recorded pace with weekly refills", () => {
  const f = feed();
  assert.equal(f.codexSeries.length, 49, "malformed point dropped");
  const now = Date.UTC(2026, 10, 12, 6);
  const pool = poolModel(f, "codex", now);
  assert.equal(pool.cap, 2200);
  assert.equal(pool.left, 1000 + 0 + 100);
  assert.equal(pool.fiveCap, 100);
  assert.equal(pool.fiveLeft, 60);
  assert.ok(Math.abs(pool.burn - 10) < 0.01, "10 points an hour, from the last day of the recorded line");
  assert.equal(pool.recorded.at(-1).left, 1100, "the line ends at the live value");
  assert.deepEqual(pool.nextRefill, { at: Date.UTC(2026, 10, 13), amount: 100 }, "Personal's week comes back first");
  // Projection: 1100 falling 10/h; Personal +100 lands at 18h, Team +1000 at 66h.
  const at = (h) => pool.projected.find((p) => p.t === now + h * 3600000).left;
  assert.equal(at(17.5), 925);
  assert.equal(at(18), 1020, "refill lands");
  assert.equal(at(65.5), 545);
  assert.equal(at(66), 1540, "Team's week comes back");
  assert.equal(pool.runsOutAt, null, "lasts the 3-day window");
  const tight = poolModel({ ...f, codexSeries: f.codexSeries.map((p) => ({ ...p, left: p.left * 3 })) }, "codex", now);
  assert.equal(tight.runsOutAt, now + 40 * 3600000, "30/h: 560 left at 18h, +100, out by 40h");
  assert.ok(pool.projected.every((p) => p.left >= 0 && p.left <= pool.cap));
  assert.equal(projectPool({ recorded: [], left: 50, cap: 100, refills: [], now, until: now + 86400000 }).runsOutAt, null, "no history: flat");
});

test("Claude pool adds up each account's weekly window (100% each)", () => {
  const pool = poolModel(feed(), "claude", Date.UTC(2026, 10, 12, 6));
  assert.equal(pool.cap, 100);
  assert.equal(pool.left, 15);
  assert.equal(pool.fiveLeft, 87);
  assert.equal(poolModel(parseHomeFeedText(JSON.stringify({ ...FEED, limits: { claude: [], codex: null } })), "claude"), null);
});

test("activity numbers and the token series", () => {
  const f = feed();
  const stats = activityStats(dailyActivity(f, projectSet(f)), NOW);
  assert.deepEqual(stats, { week: 51, streak: 3, best: 35 });
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

test("app: four compact cards mount under the hero composer (and only there) and follow settings", async () => {
  const storage = createFakeChromeStorage();
  const remote = createFakeRemote({ ok: true, status: 200, text: JSON.stringify(FEED) });
  const homeFeed = (await import("../src/homeData.js")).createHomeFeed({ area: storage.area, fetchRemote: remote });
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

test("pools weigh plans as T3 does: Claude's week is unweighted; Codex is Plus 1x, Pro 100 5x, Pro 200 20x, or all equal when a plan is unknown", async () => {
  const { poolWeights, CODEX_PLAN_WEIGHTS, claudeTier } = await import("../src/homeData.js");
  assert.deepEqual(poolWeights(["ChatGPT Plus Subscription", "ChatGPT Pro 200 Subscription"], CODEX_PLAN_WEIGHTS), [1, 20]);
  assert.deepEqual(poolWeights(["ChatGPT Plus Subscription", "Team"], CODEX_PLAN_WEIGHTS), [1, 1], "an unknown plan: all equal");
  assert.equal(claudeTier("Claude Max 20x"), "Ultra");
  assert.equal(claudeTier("Claude Max"), "Max");
  const withPlans = JSON.parse(JSON.stringify(FEED));
  withPlans.limits.claude = [
    { id: "claudeAgent", label: "Claude", plan: "Claude Pro", windows: [{ label: "Weekly", kind: "weekly", durationMins: 10080, usedPercent: 85, resetsAt: "2026-11-14T10:00:00Z" }] },
    { id: "claude_work", label: "Work", plan: "Claude Max", windows: [{ label: "Weekly", kind: "weekly", durationMins: 10080, usedPercent: 40, resetsAt: "2026-11-17T11:00:00Z" }] },
  ];
  const pool = poolModel(parseHomeFeedText(JSON.stringify(withPlans)), "claude", Date.UTC(2026, 10, 12, 6));
  assert.equal(pool.cap, 200, "one week each");
  assert.equal(pool.left, 15 + 60);
  assert.deepEqual(pool.refills.map((r) => r.amount), [85], "only refills inside the 3-day window are drawn");
  const week = poolModel(parseHomeFeedText(JSON.stringify(withPlans)), "claude", Date.UTC(2026, 10, 12, 6), { ahead: 7 });
  assert.deepEqual(week.refills.map((r) => r.amount), [85, 40]);

  const codex = JSON.parse(JSON.stringify(FEED));
  codex.limits.codex = { label: "Hub", accounts: [
    { label: "A", plan: "ChatGPT Plus Subscription", windows: [{ label: "Weekly", kind: "weekly", durationMins: 10080, usedPercent: 0, resetsAt: "2026-11-14T10:00:00Z" }] },
    { label: "B", plan: "ChatGPT Pro 200 Subscription", windows: [{ label: "Weekly", kind: "weekly", durationMins: 10080, usedPercent: 100, resetsAt: "2026-11-14T10:00:00Z" }] },
    { label: "C", plan: "ChatGPT Free", windows: [{ label: "Monthly", kind: "monthly", durationMins: 43200, usedPercent: 30, resetsAt: "2026-12-01T10:00:00Z" }] },
  ] };
  const c = poolModel(parseHomeFeedText(JSON.stringify(codex)), "codex", Date.UTC(2026, 10, 12, 6));
  assert.equal(c.accounts, 2, "a monthly window is no week: that account is not in the weekly pool");
  assert.equal(c.cap, 2100);
  assert.equal(c.left, 100, "Plus at 0% used + Pro 200 at 100%: 5% left, as T3 shows");
});

test("a recorded pool point is drawn in today's pool size (a probe that missed an account is no dip)", async () => {
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

test("Activity uses the activity source's tokens per day when the feed has them", async () => {
  const { tokenDaily } = await import("../src/homeData.js");
  const f = parseHomeFeedText(JSON.stringify({ ...FEED, aiActivity: { "2026-11-11": [1018102370, { codex: 416198814, claude: 601903556, cursor: 0 }], "2026-11-10": 0, "2026-11-08": 7, bad: 5, "2026-11-09": "x" } }));
  assert.deepEqual([...f.aiActivity.keys()], ["2026-11-11", "2026-11-10", "2026-11-08"]);
  assert.deepEqual(f.aiActivity.get("2026-11-11").providers, { codex: 416198814, claude: 601903556 }, "zero providers dropped");
  assert.deepEqual([...tokenDaily(f)], [
    ["2026-11-11", { threads: 0, runs: 1018102370, providers: { codex: 416198814, claude: 601903556 } }],
    ["2026-11-08", { threads: 0, runs: 7, providers: {} }],
  ], "older feeds (bare totals) still work");
});

test("hover: a T3-style tooltip for heatmap days and chart points, a crosshair, and clean removal", async () => {
  const storage = createFakeChromeStorage();
  const feedJson = { ...FEED, aiActivity: { [dayKey(new Date())]: [900, { codex: 600, claude: 300 }] } };
  const remote = createFakeRemote({ ok: true, status: 200, text: JSON.stringify(feedJson) });
  const homeFeed = (await import("../src/homeData.js")).createHomeFeed({ area: storage.area, fetchRemote: remote });
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

test("the glow follows the composer in the same frame, and the watcher skips its throttle right after a navigation", async () => {
  const { readFile } = await import("node:fs/promises");
  const css = await readFile(new URL("../src/styles/content.css", import.meta.url), "utf8");
  const appSource = await readFile(new URL("../src/app.js", import.meta.url), "utf8");
  // No animated custom properties on <html>: each change restyled the whole page.
  assert.doesNotMatch(css, /@property --t3plus-glow/);
  assert.doesNotMatch(css.replace(/\/\*[\s\S]*?\*\//g, ""), /\.t3plus-glow-pos\s*\{[^}]*transition/);
  assert.match(css, /\.t3plus-home\s*\{[\s\S]*max-width: calc\(100vw - 1rem\)/);
  assert.match(css, /\.t3plus-w-now-label\s*\{[\s\S]*bottom: calc\(100% - 0\.375rem\)/);
  assert.match(css, /\.t3plus-details-pool \.t3plus-w-pool-head\s*\{[\s\S]*flex-wrap: wrap/);
  assert.match(appSource, /Math\.max\(0, Math\.min\(s\.width, room\)\)/);
  const { createDomWatcher } = await import("../src/domWatcher.js");
  const dom = createDom("/", "<div></div>");
  let runs = 0;
  const watcher = createDomWatcher({ win: dom.window, doc: dom.window.document, check: () => (runs += 1), throttleMs: 10_000 });
  watcher.start();
  assert.equal(runs, 1);
  watcher.schedule(); // throttled: waits ~10 s
  dom.window.dispatchEvent(new dom.window.PopStateEvent("popstate")); // a navigation
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(runs, 2, "ran right away after the navigation");
  dom.window.document.body.append(dom.window.document.createElement("p")); // the new route renders
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(runs, 3, "still unthrottled during the burst");
  watcher.stop();
});

test("with frames, a change is checked in the next animation frame; a storm of changes falls back to the throttle", async () => {
  const { createDomWatcher } = await import("../src/domWatcher.js");
  const dom = createDom("/", "<div></div>");
  const doc = dom.window.document;
  let runs = 0;
  const watcher = createDomWatcher({ win: dom.window, doc, check: () => (runs += 1), throttleMs: 10_000, frames: true });
  watcher.start();
  assert.equal(runs, 1);
  doc.body.append(doc.createElement("p"));
  await new Promise((r) => dom.window.requestAnimationFrame(() => setTimeout(r, 0)));
  assert.equal(runs, 2, "next frame, not 10 s later");
  for (let i = 0; i < 60; i += 1) watcher.flush(); // a storm
  assert.equal(watcher.storming(), true);
  const before = runs;
  doc.body.append(doc.createElement("p"));
  await new Promise((r) => dom.window.requestAnimationFrame(() => setTimeout(r, 0)));
  assert.equal(runs, before, "throttled while storming");
  watcher.stop();
});

test("the glow is t3+'s own layer in the pane: placing and resizing it never writes on <html>", async () => {
  const { createBackdropRenderer } = await import("../src/backdropRenderer.js");
  const dom = createDom("/env/thread", `<div data-workspace-area="conversation"><p>timeline</p></div>`);
  const doc = dom.window.document;
  const pane = doc.querySelector('[data-workspace-area="conversation"]');
  pane.getBoundingClientRect = () => ({ left: 200, top: 50, width: 1200, height: 800, right: 1400, bottom: 850 });
  const renderer = createBackdropRenderer({ win: dom.window, doc });
  const settings = { composerGradient: { intensity: 45, ditherSize: "medium", ditherStyle: "bayer", accent: "#3366ff" } };
  renderer.update({ mode: "half-circle", settings, imageSrc: null, host: pane, cx: 0.5, composerWidth: 700 });
  const layer = pane.firstElementChild;
  assert.ok(layer.classList.contains("t3plus-glow"), "first child of the pane");
  const pos = layer.querySelector(".t3plus-glow-pos");
  assert.match(pos.style.transform, /^translate\(600(\.00)?px, 8\d\d\.\d\dpx\)$/);
  const width = parseFloat(layer.querySelector(".t3plus-glow-near").style.width);
  assert.ok(Math.abs(width - 2 * 0.76 * 700) < 8, `sized from the message box (${width})`);
  assert.equal(doc.documentElement.style.length, 0, "nothing on <html>");
  renderer.update({ mode: "half-circle", settings, imageSrc: null, host: pane, cx: 0.4, composerWidth: 700, wide: true });
  assert.match(pos.style.transform, /^translate\(480(\.00)?px,/);
  assert.ok(layer.hasAttribute("data-wide"));
  assert.equal(doc.documentElement.style.length, 0);
  renderer.clear();
  assert.equal(pane.querySelector(".t3plus-glow"), null);
});

test("pool card: two plain lines, what remains and when it resets (to the minute it means)", async () => {
  const { createHomeView } = await import("../src/homeWidgets.js");
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

test("profiles: dots in the sidebar footer, folders of other profiles hidden, a moved folder follows its profile", async () => {
  const { createProfiles, normalizeProfiles } = await import("../src/profiles.js");
  const { createFakeChromeStorage } = await import("./helpers.js");
  const folder = (key, title) => `<li data-testid="sidebar-project-folder"><button data-sidebar-row="folder:${key}"><span class="truncate">${title}</span></button></li>`;
  // T3 puts a folder's threads after it, as siblings that name their folder.
  const thread = (key, parent) => `<li data-thread-item="env1:${key}"><div data-sidebar-row="env1:${key}" data-sidebar-parent="${parent}">${key}</div></li>`;
  const dom = createDom("/", `<div data-slot="sidebar-inner"><ul>${folder("p/a", "Alpha")}${thread("t1", "folder:p/a")}${folder("p/b", "Beta")}${thread("t2", "folder:p/b")}${thread("t3", "shelf:settled")}</ul><div data-slot="sidebar-footer"><ul></ul></div></div>`);
  const doc = dom.window.document;
  const storage = createFakeChromeStorage();
  const profiles = createProfiles({ win: dom.window, doc, area: storage.area, changedEvent: storage.onChanged });
  await profiles.start();
  const footer = doc.querySelector('[data-slot="sidebar-footer"]');
  assert.ok(footer.firstElementChild.classList.contains("t3plus-profiles"), "at the top of the footer");
  assert.equal(doc.querySelectorAll(".t3plus-profile-dot:not(.t3plus-profile-add)").length, 1, "one profile to start with");
  assert.equal(doc.querySelectorAll("[data-t3plus-profile-off]").length, 0, "it shows every project");

  await profiles.save({ ...profiles.state, list: [...profiles.state.list, { id: "work", name: "Work" }], projects: { "p/b": "work" } });
  assert.equal(doc.querySelector('[data-sidebar-row="folder:p/b"]').closest("li").hasAttribute("data-t3plus-profile-off"), true, "Beta lives in Work");
  assert.equal(doc.querySelector('[data-thread-item="env1:t2"]').hasAttribute("data-t3plus-profile-off"), true, "and so does its thread");
  assert.equal(doc.querySelector('[data-thread-item="env1:t3"]').hasAttribute("data-t3plus-profile-off"), false, "settled threads stay");
  profiles.switchTo("work");
  assert.equal(doc.querySelector('[data-sidebar-row="folder:p/a"]').closest("li").hasAttribute("data-t3plus-profile-off"), true);
  assert.equal(doc.querySelector('[data-sidebar-row="folder:p/b"]').closest("li").hasAttribute("data-t3plus-profile-off"), false);
  assert.equal(doc.querySelector('.t3plus-profile-dot[data-profile="work"]').getAttribute("aria-pressed"), "true");
  assert.deepEqual(normalizeProfiles({ list: [], projects: { x: "nope" } }), { active: "main", list: [{ id: "main", name: "Main", color: "default" }], projects: {} }, "bad data falls back to one profile");
  profiles.stop();
  assert.equal(doc.querySelector(".t3plus-profiles"), null);
  assert.equal(doc.querySelectorAll("[data-t3plus-profile-off]").length, 0, "stopping shows every folder again");
});

test("profiles: turning bots off leaves the profile dots alone", async () => {
  const { createProfiles } = await import("../src/profiles.js");
  const { clearBotDecoration } = await import("../src/bots.js");
  const { createFakeChromeStorage } = await import("./helpers.js");
  const dom = createDom("/", `<div data-slot="sidebar-inner"><ul><li data-testid="sidebar-project-folder"><button data-sidebar-row="folder:p/a">Alpha</button></li></ul><div data-slot="sidebar-footer"><ul></ul></div></div>`);
  const doc = dom.window.document;
  const storage = createFakeChromeStorage();
  const profiles = createProfiles({ win: dom.window, doc, area: storage.area, changedEvent: storage.onChanged });
  await profiles.start();
  const stray = doc.createElement("span");
  stray.setAttribute("data-t3plus-owned", "");
  doc.querySelector("ul").append(stray);
  clearBotDecoration(doc.querySelector('[data-slot="sidebar-inner"]'));
  assert.equal(stray.isConnected, false, "bot leftovers still go");
  assert.ok(doc.querySelector(".t3plus-profiles-name"), "the profile name stays");
  assert.equal(doc.querySelectorAll(".t3plus-profile-dot").length, 2, "the dot and the add button stay");
  profiles.stop();
});

test("profiles: Ctrl+Shift+1..9 opens that profile, and each dot wears its profile's color", async () => {
  const { createProfiles, PROFILE_COLORS } = await import("../src/profiles.js");
  const { createFakeChromeStorage } = await import("./helpers.js");
  const dom = createDom("/", `<div data-slot="sidebar-inner"><ul></ul><div data-slot="sidebar-footer"><ul></ul></div></div>`);
  const doc = dom.window.document;
  const storage = createFakeChromeStorage();
  const profiles = createProfiles({ win: dom.window, doc, area: storage.area, changedEvent: storage.onChanged });
  await profiles.start();
  await profiles.save({ ...profiles.state, list: [...profiles.state.list, { id: "work", name: "Work", color: "green" }] });
  const dot = doc.querySelector('.t3plus-profile-dot[data-profile="work"]');
  assert.equal(dot.style.getPropertyValue("--t3plus-profile-color"), PROFILE_COLORS.green);
  assert.equal(doc.querySelector('.t3plus-profile-dot[data-profile="main"]').style.getPropertyValue("--t3plus-profile-color"), "", "default: T3's own dot color");
  doc.dispatchEvent(new dom.window.KeyboardEvent("keydown", { code: "Digit2", ctrlKey: true, bubbles: true }));
  assert.equal(profiles.state.active, "main", "Ctrl alone does nothing");
  doc.dispatchEvent(new dom.window.KeyboardEvent("keydown", { code: "Digit2", ctrlKey: true, shiftKey: true, bubbles: true }));
  assert.equal(profiles.state.active, "work");
  doc.dispatchEvent(new dom.window.KeyboardEvent("keydown", { code: "Digit2", metaKey: true, bubbles: true }));
  doc.dispatchEvent(new dom.window.KeyboardEvent("keydown", { code: "Digit1", metaKey: true, bubbles: true }));
  assert.equal(profiles.state.active, "work", "Cmd+digit is left to T3");
  doc.dispatchEvent(new dom.window.KeyboardEvent("keydown", { code: "Digit1", ctrlKey: true, shiftKey: true, bubbles: true }));
  assert.equal(profiles.state.active, "main");
  profiles.stop();
});

test("profiles: the first profile has no delete button; another one's projects return to it when deleted", async () => {
  const { createProfiles } = await import("../src/profiles.js");
  const { createFakeChromeStorage } = await import("./helpers.js");
  const dom = createDom("/", `<div data-slot="sidebar-inner"><ul></ul><div data-slot="sidebar-footer"><ul></ul></div></div>`);
  const doc = dom.window.document;
  const storage = createFakeChromeStorage();
  const profiles = createProfiles({ win: dom.window, doc, area: storage.area, changedEvent: storage.onChanged });
  await profiles.start();
  await profiles.save({ ...profiles.state, list: [...profiles.state.list, { id: "work", name: "2", color: "blue" }], projects: { "p/b": "work" } });
  const menu = (id) => doc.querySelector(`.t3plus-profile-dot[data-profile="${id}"]`).dispatchEvent(new dom.window.MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
  menu("main");
  assert.equal(doc.querySelector(".t3plus-profile-editor .t3plus-profile-delete"), null, "Main cannot be deleted");
  menu("work");
  doc.querySelector(".t3plus-profile-editor .t3plus-profile-delete").click();
  assert.deepEqual(profiles.state.list.map((p) => p.id), ["main"]);
  assert.deepEqual(profiles.state.projects, { "p/b": "main" }, "its project is back in Main (and still placed, not new)");
  profiles.stop();
});

test("thread spend: parsed from the bot feed and shown under the details pool card", async () => {
  const { parseBotFeedText, threadSpend } = await import("../src/botFeed.js");
  const { createHomeView } = await import("../src/homeWidgets.js");
  const feed = parseBotFeedText(JSON.stringify({ version: 1, bots: { t1: { text: "hi", role: "assistant", spend: { usd: 121.974, tokens: 354000000 } }, t2: { text: "x", spend: { usd: "nope" } } } }));
  assert.deepEqual(threadSpend(feed, "env1:t1"), { usd: 121.974, tokens: 354000000 });
  assert.equal(threadSpend(feed, "env1:t2"), null, "bad values are dropped");
  const dom = createDom("/", "<div></div>");
  const view = createHomeView(dom.window.document, { variant: "pool" });
  view.update({ feed: parseHomeFeedText(JSON.stringify(FEED)), kind: "claude", now: new Date("2026-11-16T20:00:00Z"), spend: threadSpend(feed, "env1:t1") });
  assert.equal(view.element.querySelector(".t3plus-w-spend").textContent, "Spend$121.97 · 354M");
});

test("health: a part missing past the grace period is reported with its feature; found again, it clears", async () => {
  const { createHealth, GRACE_MS } = await import("../src/health.js");
  const dom = createDom("/env1/thread1", `<div data-workspace-area="conversation"></div>`);
  let t = 0;
  const win = { performance: { now: () => t }, setTimeout: () => 1, clearTimeout: () => {} };
  const changes = [];
  const health = createHealth({ win, doc: dom.window.document, routePath: () => "/env1/thread1", onChange: (p) => changes.push(p) });
  assert.deepEqual(health.check(), [], "missing, but within the grace period");
  t = GRACE_MS + 1;
  const problems = health.check();
  assert.equal(problems.length, 1);
  assert.equal(problems[0].feature, "Glow, glass composer and centering");
  assert.deepEqual(problems[0].missing, ["composer card", "composer lane", "message list"]);
  dom.window.document.body.innerHTML = `<div data-workspace-area="conversation"></div><div data-chat-composer-surface="true"></div><div class="chat-composer-lane"></div><div class="messages-timeline-scroll"></div>`;
  assert.deepEqual(health.check(), []);
  assert.equal(changes.length, 2, "told once when it broke, once when it recovered");
});

test("profiles: a drop counts where the chips were, a lost release or a cancel moves nothing, and new names stay unique", async () => {
  const { createProfiles } = await import("../src/profiles.js");
  const { createFakeChromeStorage } = await import("./helpers.js");
  const folder = (key, title) => `<li data-testid="sidebar-project-folder"><button data-sidebar-row="folder:${key}"><span class="truncate">${title}</span></button></li>`;
  const dom = createDom("/", `<div data-slot="sidebar-inner"><ul>${folder("p/a", "Alpha")}</ul><div data-slot="sidebar-footer"><ul></ul></div></div>`);
  const doc = dom.window.document;
  const win = dom.window;
  const storage = createFakeChromeStorage();
  const profiles = createProfiles({ win, doc, area: storage.area, changedEvent: storage.onChanged });
  await profiles.start();
  await profiles.save({ ...profiles.state, list: [...profiles.state.list, { id: "work", name: "2", color: "blue" }], projects: { "p/a": "work" }, active: "work" });
  // Layout stand-in: the "Main" chip is under the pointer only while the chips are open.
  const html = doc.documentElement;
  doc.elementFromPoint = () => (html.hasAttribute("data-t3plus-profile-drag") ? doc.querySelector('.t3plus-profile-dot[data-profile="main"]') : null);
  const header = doc.querySelector('[data-sidebar-row="folder:p/a"]');
  const pe = (target, type, buttons, x = 50, y = 50) => target.dispatchEvent(new win.MouseEvent(type, { bubbles: true, cancelable: true, button: 0, buttons, clientX: x, clientY: y }));
  const startDrag = () => {
    pe(header, "pointerdown", 1, 10, 10);
    pe(doc.body, "pointermove", 1, 40, 40);
    pe(doc.body, "pointermove", 1, 50, 50);
    assert.ok(html.hasAttribute("data-t3plus-profile-drag"), "dragging");
  };
  startDrag();
  pe(doc.body, "pointerup", 0);
  assert.equal(profiles.state.projects["p/a"], "main", "dropped on Main's chip: back in Main");

  await profiles.save({ ...profiles.state, projects: { "p/a": "work" } });
  startDrag();
  pe(doc.body, "pointercancel", 0);
  assert.equal(profiles.state.projects["p/a"], "work", "a cancelled pointer is not a drop");
  assert.equal(html.hasAttribute("data-t3plus-profile-drag"), false);

  startDrag();
  pe(doc.body, "pointermove", 0, 60, 60); // the button came up where no pointerup was delivered
  assert.equal(html.hasAttribute("data-t3plus-profile-drag"), false, "the drag ends");
  assert.equal(doc.querySelector(".t3plus-profile-ghost"), null, "no ghost left following the pointer");
  assert.equal(profiles.state.projects["p/a"], "work");

  // Names: "2" exists; after deleting "2" and keeping "3", a new profile is "4", not a second "3".
  await profiles.save({ ...profiles.state, list: [{ id: "main", name: "Main" }, { id: "c", name: "3" }], projects: {}, active: "main" });
  await new Promise((r) => setTimeout(r, 0)); // a drag's end swallows only the click that ends it
  doc.querySelector('.t3plus-profile-dot[data-profile="+new"]').click();
  await new Promise((r) => setTimeout(r, 200));
  assert.deepEqual(profiles.state.list.map((p) => p.name), ["Main", "3", "4"]);
  // Ctrl+Shift+1 typed in the open rename field does not switch profiles.
  const input = doc.querySelector(".t3plus-profile-editor input");
  assert.ok(input, "the new profile opens its rename field");
  const active = profiles.state.active;
  input.dispatchEvent(new win.KeyboardEvent("keydown", { code: "Digit1", ctrlKey: true, shiftKey: true, bubbles: true }));
  assert.equal(profiles.state.active, active);
  profiles.stop();
});

test("profiles: projects there at first go to the first profile; one added later joins the open profile instead of vanishing", async () => {
  const { createProfiles } = await import("../src/profiles.js");
  const { createFakeChromeStorage } = await import("./helpers.js");
  const folder = (key) => `<li data-testid="sidebar-project-folder"><button data-sidebar-row="folder:${key}"><span class="truncate">${key}</span></button></li>`;
  const dom = createDom("/", `<div data-slot="sidebar-inner"><ul id="list">${folder("p/a")}${folder("p/b")}</ul><div data-slot="sidebar-footer"><ul></ul></div></div>`);
  const doc = dom.window.document;
  const storage = createFakeChromeStorage();
  // An existing setup: Work open, p/b moved there, p/a never moved.
  await storage.area.set({ "t3plus.profiles.v2": { active: "work", list: [{ id: "main", name: "Main" }, { id: "work", name: "Work" }], projects: { "p/b": "work" } } });
  const realNow = Date.now;
  let now = realNow();
  Date.now = () => now;
  try {
    const profiles = createProfiles({ win: dom.window, doc, area: storage.area, changedEvent: storage.onChanged });
    await profiles.start();
    assert.equal(profiles.state.projects["p/a"], "main", "a project that was already there stays in the first profile");
    assert.ok(doc.querySelector('[data-sidebar-row="folder:p/a"]').closest("li").hasAttribute("data-t3plus-profile-off"));
    now += 11_000; // later, in Work: a new project
    doc.getElementById("list").insertAdjacentHTML("beforeend", folder("p/new"));
    profiles.sync();
    assert.equal(profiles.state.projects["p/new"], "work", "the new project joins the open profile");
    assert.equal(doc.querySelector('[data-sidebar-row="folder:p/new"]').closest("li").hasAttribute("data-t3plus-profile-off"), false, "and stays in view");
    assert.equal(profiles.state.adopted, true);
    // Saved once per new project: syncing again writes nothing.
    let writes = 0;
    const set = storage.area.set;
    storage.area.set = async (items) => ((writes += 1), set(items));
    profiles.sync();
    profiles.sync();
    assert.equal(writes, 0);
    storage.area.set = set;
    // An older backup imported later (no adoption mark, Work open): its unplaced
    // projects are existing ones and go to the first profile, not the open one.
    now += 60_000;
    await storage.area.set({ "t3plus.profiles.v2": { active: "work", list: [{ id: "main", name: "Main" }, { id: "work", name: "Work" }], projects: { "p/b": "work" } } });
    profiles.sync();
    assert.equal(profiles.state.projects["p/new"], "main");
    assert.equal(profiles.state.projects["p/a"], "main");
    assert.equal(profiles.state.projects["p/b"], "work");
    profiles.stop();
  } finally {
    Date.now = realNow;
  }
});

test("profiles from the keyboard: arrows move between dots, F2 renames, tabbing out keeps the typed name, Escape cancels back to the dot", async () => {
  const { createProfiles } = await import("../src/profiles.js");
  const { createFakeChromeStorage } = await import("./helpers.js");
  const dom = createDom("/", `<div data-slot="sidebar-inner"><ul></ul><div data-slot="sidebar-footer"><button id="out">Settings</button></div></div>`);
  const win = dom.window;
  const doc = win.document;
  const storage = createFakeChromeStorage();
  await storage.area.set({ "t3plus.profiles.v2": { active: "main", list: [{ id: "main", name: "Main" }, { id: "work", name: "Work" }], projects: {} } });
  const profiles = createProfiles({ win, doc, area: storage.area, changedEvent: storage.onChanged });
  await profiles.start();
  const dot = (id) => doc.querySelector(`.t3plus-profile-dot[data-profile="${id}"]`);
  const key = (el, k) => el.dispatchEvent(new win.KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true }));
  assert.equal(doc.querySelector(".t3plus-profiles-dots").getAttribute("role"), "toolbar");
  assert.equal(dot("main").tabIndex, 0, "the open profile is the one Tab stop");
  assert.equal(dot("work").tabIndex, -1);
  dot("main").focus();
  key(dot("main"), "ArrowRight");
  assert.equal(doc.activeElement, dot("work"));
  key(dot("work"), "F2");
  const input = doc.querySelector(".t3plus-profile-editor input");
  assert.equal(doc.activeElement, input, "F2 opens the rename field");
  input.value = "Clients";
  doc.querySelector(".t3plus-profile-editor .t3plus-profile-swatch").focus(); // Tab on through the editor...
  await new Promise((r) => setTimeout(r, 5));
  assert.ok(doc.querySelector(".t3plus-profile-editor"), "still open while focus is inside it");
  doc.getElementById("out").focus(); // ...and out of it
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(doc.querySelector(".t3plus-profile-editor"), null, "closed once focus left it");
  assert.equal(profiles.state.list[1].name, "Clients", "and the typed name was kept");
  key(dot("work"), "F2");
  doc.querySelector(".t3plus-profile-editor input").value = "Nope";
  key(doc.querySelector(".t3plus-profile-editor .t3plus-profile-swatch"), "Escape");
  assert.equal(doc.querySelector(".t3plus-profile-editor"), null, "Escape from a swatch closes it too");
  assert.equal(profiles.state.list[1].name, "Clients", "without renaming");
  assert.equal(doc.activeElement, dot("work"), "focus goes back to the dot");
  profiles.stop();
});

test("widget tooltips: one element per view (unique ids), and hide() closes one left open by a still pointer", async () => {
  const { createHomeView } = await import("../src/homeWidgets.js");
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

test("profiles: hidden rows are inert (T3's arrow keys skip them), the swipe listener lives on the sidebar, and the terminal keeps Ctrl+Shift+digits", async () => {
  const { createProfiles } = await import("../src/profiles.js");
  const { createFakeChromeStorage } = await import("./helpers.js");
  const folder = (key, title) => `<li data-testid="sidebar-project-folder"><button data-sidebar-row="folder:${key}"><span class="truncate">${title}</span></button></li>`;
  const dom = createDom("/", `<div data-slot="sidebar-inner"><ul>${folder("p/a", "Alpha")}${folder("p/b", "Beta")}</ul><div data-slot="sidebar-footer"><ul></ul></div></div><div data-thread-terminal-drawer><textarea class="xterm-helper-textarea"></textarea></div>`);
  const doc = dom.window.document;
  const win = dom.window;
  const added = [];
  const docAdd = doc.addEventListener.bind(doc);
  doc.addEventListener = (type, fn, opts) => (added.push(type), docAdd(type, fn, opts));
  const storage = createFakeChromeStorage();
  const profiles = createProfiles({ win, doc, area: storage.area, changedEvent: storage.onChanged });
  await profiles.start();
  assert.ok(!added.includes("wheel"), "no wheel listener on the document");
  await profiles.save({ ...profiles.state, list: [...profiles.state.list, { id: "work", name: "Work" }], projects: { "p/b": "work" } });
  const beta = doc.querySelector('[data-sidebar-row="folder:p/b"]').closest("li");
  assert.ok(beta.hasAttribute("data-t3plus-profile-off") && beta.hasAttribute("inert"), "hidden and inert");
  // A sideways swipe on the sidebar still switches.
  const inner = doc.querySelector('[data-slot="sidebar-inner"]');
  for (let i = 0; i < 4; i += 1) inner.dispatchEvent(new win.WheelEvent("wheel", { bubbles: true, cancelable: true, deltaX: 30, deltaY: 0 }));
  assert.equal(profiles.state.active, "work");
  assert.ok(!beta.hasAttribute("inert"), "shown again: not inert");
  // In the terminal, Ctrl+Shift+1 is the program's.
  doc.querySelector(".xterm-helper-textarea").dispatchEvent(new win.KeyboardEvent("keydown", { code: "Digit1", ctrlKey: true, shiftKey: true, bubbles: true }));
  assert.equal(profiles.state.active, "work");
  profiles.stop();
  assert.equal(doc.querySelectorAll("[inert]").length, 0, "stop() leaves nothing inert");
});

test("token counts never read 1000K or 10.0M, and Codex accounts without a reported week do not count as 100% left", async () => {
  const { formatTokens, poolModel } = await import("../src/homeData.js");
  assert.deepEqual([999, 999_400, 999_600, 9_949_999, 9_999_999, 999_999_999, 9.96e9].map(formatTokens), ["999", "999K", "1.0M", "9.9M", "10M", "1.0B", "10B"]);
  const week = { label: "Weekly", kind: "weekly", durationMins: 10080, usedPercent: 60, resetsAt: "2026-11-20T00:00:00Z" };
  const feed = { codex: { accounts: [{ label: "A", plan: "Plus", windows: [week] }, { label: "B (limits failed to load)", plan: "Pro", windows: [] }] }, codexSeries: [], claude: [], claudeSeries: [] };
  const pool = poolModel(feed, "codex", Date.parse("2026-11-17T00:00:00Z"));
  assert.equal(pool.cap, 100, "only the account that reports a week");
  assert.equal(Math.round(pool.left), 40);
  assert.equal(poolModel({ ...feed, codex: { accounts: [{ label: "B", plan: "Pro", windows: [] }] } }, "codex"), null);
});

test("pool card: data that stopped updating says how old it is", async () => {
  const { createHomeView } = await import("../src/homeWidgets.js");
  const dom = createDom("/", "<div></div>");
  const view = createHomeView(dom.window.document, { variant: "pool" });
  const feedJson = { ...FEED, generatedAt: "2026-11-16T14:00:00Z", limits: { claude: [{ id: "c1", label: "Claude", plan: "Claude Pro", windows: [{ label: "Weekly", durationMins: 10080, usedPercent: 36, resetsAt: "2026-11-19T16:59:59Z" }] }], codex: null, pool: null } };
  view.update({ feed: parseHomeFeedText(JSON.stringify(feedJson)), kind: "claude", now: new Date("2026-11-16T20:00:00Z") });
  assert.equal(view.element.querySelector(".t3plus-w-stale")?.textContent, "Updated 6 h ago");
  view.update({ feed: parseHomeFeedText(JSON.stringify({ ...feedJson, generatedAt: "2026-11-16T19:50:00Z" })), kind: "claude", now: new Date("2026-11-16T20:00:00Z") });
  assert.equal(view.element.querySelector(".t3plus-w-stale"), null, "fresh data has no note");
  view.destroy();
});

test("profiles: screenshot mode shows Profile 1, Profile 2 instead of the names", async () => {
  const { createProfiles } = await import("../src/profiles.js");
  const { createFakeChromeStorage } = await import("./helpers.js");
  const dom = createDom("/", `<div data-slot="sidebar-inner"><ul></ul><div data-slot="sidebar-footer"><ul></ul></div></div>`);
  const doc = dom.window.document;
  let demo = false;
  const storage = createFakeChromeStorage();
  const profiles = createProfiles({ win: dom.window, doc, area: storage.area, changedEvent: storage.onChanged, isDemo: () => demo });
  await profiles.start();
  await profiles.save({ ...profiles.state, list: [...profiles.state.list, { id: "w", name: "Acme payroll", color: "blue" }] });
  const dot = () => doc.querySelector('.t3plus-profile-dot[data-profile="w"]');
  assert.match(dot().title, /Acme payroll/);
  demo = true;
  profiles.sync();
  assert.ok(!dot().title.includes("Acme") && dot().textContent === "Profile 2", dot().title);
  demo = false;
  profiles.sync();
  assert.equal(dot().textContent, "Acme payroll");
  profiles.stop();
});

test("dollars never read $1000, $100.00 or $10.0k", async () => {
  const { formatUsd, formatUsdExact } = await import("../src/homeData.js");
  const cases = [[12.345, "$12.35"], [99.994, "$99.99"], [99.996, "$100"], [999.4, "$999"], [999.6, "$1.0k"], [9949, "$9.9k"], [9994, "$10k"], [12345, "$12k"]];
  for (const [v, want] of cases) assert.equal(formatUsd(v), want, String(v));
  assert.equal(formatUsdExact(999.994), "$999.99");
  assert.equal(formatUsdExact(999.996), "$1.00k");
});
