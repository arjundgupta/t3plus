import assert from "node:assert/strict";
import { test } from "node:test";
import { dayKey, forecast, forecastRows, parseHomeFeedText, projectStats, streakStats } from "../src/homeData.js";
import { createHomeView } from "../src/homeWidgets.js";
import { createDom } from "./helpers.js";

const HOUR = 3600000;
const NOW = new Date(2026, 10, 24, 16, 0); // Tue Nov 24 2026, 4 PM local
const back = (days) => dayKey(new Date(NOW.getFullYear(), NOW.getMonth(), NOW.getDate() - days));

// ---------- Limit Forecast ----------

test("forecast: a pace that empties the window before its reset says when", () => {
  const now = NOW.getTime();
  // 60% used in 2 h: 30%/h, 40% left lasts 80 minutes; the reset is 3 h away.
  const f = forecast({ cap: 100, left: 40, start: now - 2 * HOUR, reset: now + 3 * HOUR, now });
  assert.equal(f.state, "runsOut");
  assert.equal(f.at, now + 80 * 60000);
  assert.equal(f.usedFrac, 0.6);
  assert.equal(f.projectedFrac, 1, "capped at the whole window");
});

test("forecast: a pace that lasts says about how much is left at the reset", () => {
  const now = NOW.getTime();
  // 20% in 2 h: 10%/h, 3 h more is 30%: 50% left at the reset.
  const f = forecast({ cap: 100, left: 80, start: now - 2 * HOUR, reset: now + 3 * HOUR, now });
  assert.equal(f.state, "lasts");
  assert.equal(f.leftAtReset, 50);
  assert.equal(f.projectedFrac, 0.5);
});

test("forecast: nothing used, too early, or no reset is no guess", () => {
  const now = NOW.getTime();
  assert.equal(forecast({ cap: 100, left: 100, start: now - HOUR, reset: now + HOUR, now }).state, "unused");
  assert.equal(forecast({ cap: 100, left: 90, start: now - 5 * 60000, reset: now + HOUR, now }).state, "early");
  assert.equal(forecast({ cap: 100, left: 90, start: NaN, reset: NaN, now }).state, "unused");
});

test("forecastRows: the 5-hour window and each weekly pool that reports", () => {
  const now = NOW.getTime();
  const iso = (ms) => new Date(ms).toISOString();
  const feed = parseHomeFeedText(
    JSON.stringify({
      version: 1,
      generatedAt: iso(now),
      limits: {
        claude: [{ label: "Claude", windows: [
          { kind: "session", durationMins: 300, usedPercent: 50, resetsAt: iso(now + 3 * HOUR) },
          { kind: "weekly", durationMins: 10080, usedPercent: 10, resetsAt: iso(now + 5 * 24 * HOUR) },
        ] }],
        codex: null,
      },
    }),
  );
  const rows = forecastRows(feed, now);
  assert.deepEqual(rows.map((r) => r.label), ["Claude 5-Hour", "Claude Week"]);
  // 50% in the 2 h since the window opened: 25%/h, the other 50% lasts 2 h, before the reset.
  assert.equal(rows[0].state, "runsOut");
  assert.equal(rows[0].at, now + 2 * HOUR);
  // 10% in 2 days: 5%/day, 5 days more is 25%: 65% left.
  assert.equal(rows[1].state, "lasts");
  assert.equal(rows[1].leftAtReset, 65);
  assert.deepEqual(forecastRows(null), []);
});

// ---------- Streak ----------

test("streakStats: the run up to today, the longest, today against the average, the busiest weekday", () => {
  const daily = new Map([
    [back(0), { runs: 300 }],
    [back(1), { runs: 100 }],
    [back(2), { runs: 100 }],
    // a gap at 3
    [back(4), { runs: 100 }],
    [back(5), { runs: 100 }],
    [back(6), { runs: 100 }],
    [back(7), { runs: 100 }],
  ]);
  const s = streakStats(daily, NOW);
  assert.equal(s.current, 3);
  assert.equal(s.longest, 4);
  assert.equal(s.alive, true);
  assert.equal(s.today, 300);
  assert.equal(s.ratio, 3, "today 300 against 100 a day");
  assert.equal(s.busiest, "Tuesdays", "today's 300 makes Tuesday the busiest");
  assert.equal(s.last14.length, 14);
  assert.deepEqual(s.last14.slice(-4), [false, true, true, true]);
});

test("streakStats: nothing yet today keeps yesterday's streak alive", () => {
  const s = streakStats(new Map([[back(1), { runs: 5 }], [back(2), { runs: 5 }]]), NOW);
  assert.equal(s.current, 2);
  assert.equal(s.alive, false);
  assert.equal(s.ratio, null);
  assert.equal(streakStats(new Map(), NOW).current, 0);
});

// ---------- Projects ----------

const projectFeed = () =>
  parseHomeFeedText(
    JSON.stringify({
      version: 1,
      generatedAt: NOW.toISOString(),
      projects: [{ title: "billing" }, { title: "notes" }, {}],
      activity: {
        [back(0)]: [[0, 1, 10], [1, 0, 2], [2, 0, 50]],
        [back(3)]: [[1, 2, 20]],
        [back(9)]: [[0, 0, 99]], // older than a week
      },
    }),
  );

test("projectStats: the busiest named projects of the last 7 days, with turns per day", () => {
  const list = projectStats(projectFeed(), NOW);
  assert.deepEqual(list.map((p) => [p.title, p.runs, p.threads]), [["notes", 22, 2], ["billing", 10, 1]], "an unnamed project is left out");
  assert.deepEqual(list[0].perDay, [0, 0, 0, 20, 0, 0, 2]);
});

// ---------- The cards ----------

test("Needs You: rows for what waits on you; a row opens its thread", () => {
  const dom = createDom("/", "<div></div>");
  const opened = [];
  const view = createHomeView(dom.window.document, { onOpen: (key) => opened.push(key) });
  const rows = [
    { key: "env:a", status: "approval", word: "Approval", title: "Fix login", project: "acme-api", ago: "5m" },
    { key: "env:b", status: "failed", word: "Failed", title: "Deploy", project: "", ago: "1h" },
    { key: "env:c", status: "input", word: "Input", title: "Pick a name", project: "notes", ago: "2h" },
    { key: "env:d", status: "limited", word: "Limited", title: "Big refactor", project: "", ago: "3h" },
  ];
  view.update({ feed: projectFeed(), now: NOW, show: { needsYou: true }, needs: { rows } });
  const card = view.element.querySelector(".t3plus-w-needs");
  assert.equal(card.querySelectorAll(".t3plus-w-needs-row").length, 3, "three at most");
  assert.match(card.textContent, /4 waiting/);
  assert.match(card.textContent, /\+1 more/);
  assert.equal(card.querySelector('[data-t3plus-open="env:b"] .t3plus-w-needs-word').getAttribute("data-tone"), "bad");
  card.querySelector('[data-t3plus-open="env:a"]').click();
  assert.deepEqual(opened, ["env:a"]);
  view.update({ feed: projectFeed(), now: NOW, show: { needsYou: true }, needs: { rows: [] } });
  assert.match(view.element.querySelector(".t3plus-w-needs").textContent, /Nothing needs you/);
  view.destroy();
});

test("Projects card: names covered by screenshot mode's stand-ins when given", () => {
  const dom = createDom("/", "<div></div>");
  const view = createHomeView(dom.window.document);
  view.update({ feed: projectFeed(), now: NOW, show: {}, projectLabel: (t) => `P-${t.length}` });
  const names = [...view.element.querySelectorAll(".t3plus-w-project-name")].map((e) => e.textContent);
  assert.deepEqual(names, ["P-5", "P-7"]);
  view.destroy();
});

test("Streak card: the streak, the longest, and the 14-day strip", () => {
  const dom = createDom("/", "<div></div>");
  const view = createHomeView(dom.window.document);
  view.update({ feed: projectFeed(), now: NOW, show: {} });
  const card = view.element.querySelector(".t3plus-w-streak");
  assert.match(card.querySelector(".t3plus-w-big-num").textContent, /^1 day$/);
  assert.equal(card.querySelectorAll(".t3plus-w-streak-strip .t3plus-w-cell").length, 14);
  view.destroy();
});

test("no element inside a card shares the card's own class (its styles would land on the card)", () => {
  const dom = createDom("/", "<div></div>");
  const view = createHomeView(dom.window.document);
  const rows = [{ key: "env:a", status: "approval", word: "Approval", title: "Fix login", project: "acme-api", ago: "5m" }];
  view.update({ feed: projectFeed(), now: NOW, show: {}, needs: { rows } });
  for (const card of view.element.querySelectorAll(".t3plus-w")) {
    const own = [...card.classList].filter((c) => c.startsWith("t3plus-w-") && c !== "t3plus-w-wide");
    for (const c of own) assert.equal(card.querySelector(`.${c}`), null, `${c} is used inside its own card`);
  }
  view.destroy();
});

test("Streak card: a day clicked shows its numbers on the line; clicked again, today's; arrow keys pick days too", () => {
  const dom = createDom("/", "<div></div>");
  const win = dom.window;
  const view = createHomeView(win.document);
  win.document.body.append(view.element);
  const feed = parseHomeFeedText(
    JSON.stringify({
      version: 1,
      generatedAt: NOW.toISOString(),
      aiActivity: { [back(0)]: [300e6, { claude: 300e6 }], [back(3)]: [100e6, { claude: 90e6, codex: 10e6 }] },
    }),
  );
  view.update({ feed, now: NOW, show: {} });
  const card = () => view.element.querySelector(".t3plus-w-streak");
  const line = () => card().querySelector(".t3plus-w-streak-today").textContent;
  assert.match(line(), /^Today 300M tokens/);
  const day = card().querySelector(`[data-t3plus-day="${back(3)}"]`);
  day.click();
  assert.match(line(), /· 100M tokens · 1\.0× your average · Claude 90M, Codex 10M$/);
  assert.ok(day.hasAttribute("data-t3plus-picked"));
  day.click();
  assert.match(line(), /^Today 300M tokens/, "clicked again: back to today");
  // Keys: the strip is a Tab stop; Home goes to the oldest day.
  const strip = card().querySelector(".t3plus-w-streak-strip");
  strip.focus();
  strip.dispatchEvent(new win.KeyboardEvent("keydown", { key: "Home", bubbles: true }));
  assert.match(line(), /· No activity$/);
  view.destroy();
});
