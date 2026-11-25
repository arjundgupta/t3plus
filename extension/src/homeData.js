import { STORAGE_KEYS } from "./config.js";
import { CONFIG_LIMITS, HOME_FEED_ENDPOINT } from "./hosts.js";
import { createCachedFeed } from "./runtimeFetch.js";

// t3plus-home.json (server/publish_home.py) -> what the home widgets show.
// Pure functions, no DOM, so every number on the home page is unit-tested.

const isDay = (v) => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v);
const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const text = (v, max) => (typeof v === "string" ? v.slice(0, max) : "");
const iso = (v) => (typeof v === "string" && !Number.isNaN(Date.parse(v)) ? v : null);

function cleanWindow(w) {
  if (!w || typeof w !== "object" || typeof w.usedPercent !== "number") return null;
  return {
    kind: text(w.kind, 24),
    durationMins: typeof w.durationMins === "number" ? w.durationMins : null,
    usedPercent: Math.max(0, Math.min(100, w.usedPercent)),
    resetsAt: iso(w.resetsAt),
  };
}

/**
 * A feed's { provider: value } object as entries, without a "__proto__" key: JSON.parse
 * keeps one as an own key, and summed into an object later it reached Object.prototype
 * (every object's cost and tokens became NaN).
 */
const providerEntries = (byProvider) => Object.entries(byProvider).filter(([k]) => k !== "__proto__");

/** Validates the feed. Never throws; returns null for anything unusable. */
export function parseHomeFeedText(raw) {
  if (typeof raw !== "string" || raw.length > CONFIG_LIMITS.maxChars * 4) return null;
  let d;
  try {
    d = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!d || d.version !== 1) return null;
  const activity = new Map();
  for (const [day, cells] of Object.entries(d.activity && typeof d.activity === "object" ? d.activity : {})) {
    if (!isDay(day) || !Array.isArray(cells)) continue;
    activity.set(day, cells.filter((c) => Array.isArray(c) && c.length >= 3).map(([p, t, r]) => [num(p), num(t), num(r)]));
  }
  const spend = new Map();
  for (const [day, byProvider] of Object.entries(d.spend && typeof d.spend === "object" ? d.spend : {})) {
    if (!isDay(day) || !byProvider || typeof byProvider !== "object") continue;
    spend.set(day, Object.fromEntries(providerEntries(byProvider).map(([k, v]) => [k.slice(0, 24), [num(v?.[0]), num(v?.[1])]])));
  }
  const limits = d.limits && typeof d.limits === "object" ? d.limits : {};
  // What the pools are made of: each account's windows, and a Codex account's plan (its weight).
  const windowsOf = (account) => (Array.isArray(account?.windows) ? account.windows : []).map(cleanWindow).filter(Boolean);
  const claude = (Array.isArray(limits.claude) ? limits.claude : []).slice(0, 8).map((c) => ({ windows: windowsOf(c) }));
  const codex =
    limits.codex && Array.isArray(limits.codex.accounts)
      ? { accounts: limits.codex.accounts.slice(0, 32).map((a) => ({ plan: text(a?.plan, 40), windows: windowsOf(a) })) }
      : null;
  // Each five-hour reading's window, by the reading's time: [t, left, cap, reset] (unix seconds).
  const sessionResets = new Map(
    (Array.isArray(d.claudeSessionSeries) ? d.claudeSessionSeries : [])
      .filter((p) => Array.isArray(p) && typeof p[0] === "number" && typeof p[3] === "number" && Number.isFinite(p[3]))
      .map((p) => [p[0] * 1000, p[3] * 1000]),
  );
  // Recorded pools: [unix seconds, left, cap, (five-hour left, five-hour cap)] in percent of a Plus week.
  const series = (list) =>
    (Array.isArray(list) ? list : [])
      .filter((p) => Array.isArray(p) && p.length >= 3 && p.slice(0, 3).every((v) => typeof v === "number" && Number.isFinite(v)) && p[2] > 0)
      .slice(-2000)
      .map(([t, left, cap]) => ({ t: t * 1000, left: Math.max(0, left), cap }))
      .sort((a, b) => a.t - b.t);
  return {
    generatedAt: iso(d.generatedAt),
    // Project names by their place in the list (activity cells name projects by it).
    projects: (Array.isArray(d.projects) ? d.projects : []).slice(0, 500).map((p) => text(p?.title, 60)),
    activity,
    spend,
    claude,
    codex,
    codexSeries: series(d.codexSeries),
    // The optional activity source: AI tokens per day, all providers.
    // {day: [total, {provider: tokens}]} (or a bare total from older feeds).
    aiActivity: new Map(
      Object.entries(d.aiActivity && typeof d.aiActivity === "object" ? d.aiActivity : {}).flatMap(([day, v]) => {
        const total = Array.isArray(v) ? v[0] : v;
        if (!isDay(day) || typeof total !== "number" || !Number.isFinite(total) || total < 0) return [];
        const raw = Array.isArray(v) && v[1] && typeof v[1] === "object" ? v[1] : {};
        const providers = Object.fromEntries(providerEntries(raw).filter(([, n]) => typeof n === "number" && n > 0).map(([k, n]) => [k.slice(0, 24), n]));
        return [[day, { total, providers }]];
      }),
    ),
    claudeSeries: series(d.claudeSeries),
    // Claude's five-hour window, recorded the same way, each reading with the reset of
    // its window (ms; null in feeds from before resets were kept).
    claudeSessionSeries: series(d.claudeSessionSeries).map((p) => ({ ...p, reset: sessionResets.get(p.t) ?? null })),
  };
}


const pad = (n) => String(n).padStart(2, "0");
export const dayKey = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

/** Turns per day for the given project indexes (`projects`), or for every project when null. */
export function dailyActivity(feed, projects = null) {
  const out = new Map();
  for (const [day, cells] of feed.activity) {
    let runs = 0;
    for (const [p, , r] of cells) if (!projects || projects.has(p)) runs += r;
    if (runs) out.set(day, { runs });
  }
  return out;
}

/** The activity source's tokens per day as a heatmap input (value in `runs`, so heatmap() levels it). */
export function tokenDaily(feed) {
  const out = new Map();
  for (const [day, v] of feed.aiActivity) if (v.total > 0) out.set(day, { runs: v.total, providers: v.providers });
  return out;
}

/**
 * GitHub-style heatmap: `weeks` columns ending with the current week
 * (Sunday-first), each cell a level 0-4 by turns, with quartile thresholds
 * over the active days so one huge day does not wash out the rest. `runs`: the total.
 */
export function heatmap(daily, now, weeks = 26) {
  const end = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const start = new Date(end);
  start.setDate(end.getDate() - end.getDay() - (weeks - 1) * 7);
  const values = [...daily.values()].map((v) => v.runs).filter((v) => v > 0).sort((a, b) => a - b);
  const q = (f) => values[Math.min(values.length - 1, Math.floor(values.length * f))] ?? 0;
  const cuts = [q(0.25), q(0.5), q(0.75)];
  const columns = [];
  const today = dayKey(end);
  let runs = 0;
  for (let w = 0; w < weeks; w += 1) {
    const column = [];
    for (let d = 0; d < 7; d += 1) {
      const date = new Date(start);
      date.setDate(start.getDate() + w * 7 + d);
      const key = dayKey(date);
      const v = daily.get(key)?.runs ?? 0;
      const future = date > end;
      if (!future) runs += v;
      const level = future || !v ? 0 : v <= cuts[0] ? 1 : v <= cuts[1] ? 2 : v <= cuts[2] ? 3 : 4;
      column.push({ key, level, runs: v, future, today: key === today });
    }
    columns.push(column);
  }
  return { columns, runs };
}

// T3's pool rules (its usage limits view): one provider's accounts are pooled with a
// weight per plan, every plan known or all of them equal. Codex: Plus 1x, Pro 100 5x,
// Pro 200 20x for its weekly window; Claude's week is unweighted. (inject/feeds-worker.js
// records the pool line by the same rules.)
export const CODEX_PLAN_WEIGHTS = Object.freeze({ "ChatGPT Plus Subscription": 1, "ChatGPT Pro 100 Subscription": 5, "ChatGPT Pro 200 Subscription": 20 });
/** Weights for `accounts`, T3's way: from `table` by plan when every plan is in it, else all equal. */
export function poolWeights(plans, table) {
  const weights = plans.map((plan) => table[plan]);
  return weights.every((w) => typeof w === "number") ? weights : plans.map(() => 1);
}
/** What a window is, as T3 says (kind); a feed without kinds tells by its length. Monthly windows are no week. */
export const isWeekly = (w) => (w.kind ? w.kind === "weekly" : (w.durationMins ?? 0) >= 6 * 1440 && (w.durationMins ?? 0) <= 8 * 1440);

// ---------- Pools (weekly pool charts, compact) ----------

const HOUR = 3600000;

/** The accounts a pool can be made of: every Codex account, or every Claude one. */
const poolSource = (feed, kind) => (kind === "codex" ? (feed.codex?.accounts ?? []) : feed.claude);
// Only accounts that report a week: one whose limits failed to load counted as 100% left.
const reportsWeek = (account) => account.windows.some(isWeekly);
/** Whether `feed` has a pool for `kind` to draw (poolModel is not null), without making it. */
export const hasPool = (feed, kind) => Boolean(feed) && poolSource(feed, kind).some(reportsWeek);

/**
 * One pool for the chart, past usage only: what is left of its cap now, the line recorded
 * over the last `back` days, and when its next weekly reset is ({ at }, or null).
 * Codex: every Codex account's week, weighted by plan (T3's weights; in Plus weeks).
 * Claude: every Claude account's weekly window, 100% each.
 */
export function poolModel(feed, kind, now = Date.now(), { back = 3 } = {}) {
  if (!feed) return null;
  const accounts = poolSource(feed, kind).filter(reportsWeek);
  if (!accounts.length) return null;
  // One account is simply 100%; several Codex ones are summed in Plus weeks.
  const weights = kind !== "codex" || accounts.length === 1 ? accounts.map(() => 1) : poolWeights(accounts.map((a) => a.plan), CODEX_PLAN_WEIGHTS);
  let cap = 0;
  let left = 0;
  let nextReset = Infinity;
  accounts.forEach((a, i) => {
    const w = weights[i] * 100;
    const weekly = a.windows.find(isWeekly);
    cap += w;
    left += w * (1 - (weekly.usedPercent ?? 0) / 100);
    // At 0% used the reset still marks the week (the chart and "Reset - …" say when it ends).
    const at = Date.parse(weekly.resetsAt ?? "");
    if (at > now && at < nextReset) nextReset = at;
  });
  const from = now - back * 24 * HOUR;
  // Each recorded point in today's pool size: one taken while an account was missing
  // (its limits failed to load) had a smaller cap, and plotted as a sudden dip.
  const recorded = [];
  for (const p of kind === "codex" ? feed.codexSeries : feed.claudeSeries) {
    if (p.t < from || p.t > now) continue;
    recorded.push(p.cap > 0 && p.cap !== cap ? { ...p, left: (p.left * cap) / p.cap, cap } : p);
  }
  recorded.push({ t: now, left });
  return { cap: Math.round(cap), left: Math.round(left), from, now, recorded, nextRefill: Number.isFinite(nextReset) ? { at: nextReset } : null };
}

// ---------- Claude's five-hour window ----------

/** A five-hour (session) window, as T3 says (kind); a feed without kinds tells by its length. */
export const isSession = (w) => (w.kind ? w.kind === "session" : (w.durationMins ?? 0) > 0 && (w.durationMins ?? 0) < 1440);
/** Whether a Claude account reports its five-hour window (sessionModel is not null). */
export const hasSession = (feed) => Boolean(feed) && feed.claude.some((a) => a.windows.some(isSession));

/**
 * Claude's five-hour window for its card, past usage only, in poolModel's shape: what is
 * left now (each account 100%), the line recorded since the window opened, and when it
 * resets ({ at }, or null). A window whose reset has passed is full again and has no
 * reset until the next message opens a new one (`active` false).
 */
export function sessionModel(feed, now = Date.now()) {
  if (!feed) return null;
  const accounts = feed.claude.filter((a) => a.windows.some(isSession));
  if (!accounts.length) return null;
  let cap = 0;
  let left = 0;
  let nextReset = Infinity;
  let length = 300 * 60000;
  let active = false;
  for (const a of accounts) {
    const w = a.windows.find(isSession);
    const at = Date.parse(w.resetsAt ?? "");
    // No reset reported: the reported use still stands.
    const open = !Number.isFinite(at) || at > now;
    cap += 100;
    left += 100 * (1 - (open ? w.usedPercent : 0) / 100);
    if (open) active = true;
    if (open && at < nextReset) nextReset = at;
    if (w.durationMins) length = w.durationMins * 60000;
  }
  // The window opened `length` before its reset; never after now (the provider's clock a little ahead).
  // With none running, the chart shows the five hours a window opened now would cover,
  // empty: not the five hours before, which read as a window that had just been used.
  const from = active ? Math.min(now - 60000, Number.isFinite(nextReset) ? nextReset - length : now - length) : now;
  const recorded = [];
  if (active) {
    // A window opens at 0% used: its start is a known point even before any sample was
    // recorded in it (samples only began when t3+ started recording this window).
    const opened = Number.isFinite(nextReset);
    if (opened) recorded.push({ t: from, left: cap });
    for (const p of feed.claudeSessionSeries ?? []) {
      if (p.t < from || p.t > now) continue;
      // Only readings of this window: T3 can still report the one that just ended a few
      // minutes into the next (its 100% drew a drop to empty at the new window's start).
      // A reading with no window known is left out once the window is.
      if (Number.isFinite(nextReset) && (p.reset === null || p.reset === undefined || Math.abs(p.reset - nextReset) > 5 * 60000)) continue;
      recorded.push(p.cap > 0 && p.cap !== cap ? { ...p, left: (p.left * cap) / p.cap, cap } : p);
    }
    recorded.push({ t: now, left });
  }
  // `end`: the chart spans the whole window, up to its reset (the line stops at now).
  const end = active && Number.isFinite(nextReset) ? Math.max(now, nextReset) : active ? now : now + length;
  return { cap: Math.round(cap), left: Math.round(left), from, now, end, recorded, active, nextRefill: Number.isFinite(nextReset) ? { at: nextReset } : null };
}

// ---------- Limit Forecast ----------

/**
 * Where a limit is headed at the pace used since its window opened: `cap` and `left` in
 * the pool's units, the window from `start` to `reset` (ms). One of
 *   { state: "early" }               under ten minutes in, too soon to tell
 *   { state: "unused" }              nothing used yet
 *   { state: "runsOut", at }         the pace empties it before the reset, at `at`
 *   { state: "lasts", leftAtReset }  it lasts, with about that much left (in % of cap)
 * plus usedFrac (0..1 now) and projectedFrac (0..1 at the reset, capped at 1).
 */
export function forecast({ cap, left, start, reset, now }) {
  const used = Math.max(0, cap - left);
  const usedFrac = cap > 0 ? Math.min(1, used / cap) : 0;
  const base = { usedFrac, projectedFrac: usedFrac };
  const elapsed = now - start;
  if (!(cap > 0) || !Number.isFinite(reset) || !Number.isFinite(start)) return { state: "unused", ...base };
  if (used <= 0) return { state: "unused", ...base };
  if (elapsed < 10 * 60000) return { state: "early", ...base };
  const rate = used / elapsed; // pool units per ms
  const projected = used + rate * Math.max(0, reset - now);
  const projectedFrac = Math.min(1, projected / cap);
  if (left <= 0) return { state: "runsOut", at: now, usedFrac, projectedFrac };
  const at = now + left / rate;
  if (at < reset) return { state: "runsOut", at, usedFrac, projectedFrac };
  return { state: "lasts", leftAtReset: Math.max(0, Math.round(((cap - projected) / cap) * 100)), usedFrac, projectedFrac };
}

/** The limits to forecast, as rows: { key, label, color, ...forecast() }. */
export function forecastRows(feed, now = Date.now()) {
  if (!feed) return [];
  const rows = [];
  const session = sessionModel(feed, now);
  if (session?.active && session.nextRefill) {
    rows.push({ key: "session", label: "Claude 5-Hour", reset: session.nextRefill.at, ...forecast({ cap: session.cap, left: session.left, start: session.from, reset: session.nextRefill.at, now }) });
  } else if (session) rows.push({ key: "session", label: "Claude 5-Hour", reset: null, state: "idle", usedFrac: 0, projectedFrac: 0 });
  for (const [kind, label] of [["claude", "Claude Week"], ["codex", "Codex Week"]]) {
    const pool = poolModel(feed, kind, now, { back: 0 });
    if (!pool) continue;
    const reset = pool.nextRefill?.at ?? NaN;
    rows.push({ key: kind, label, reset: Number.isFinite(reset) ? reset : null, ...forecast({ cap: pool.cap, left: pool.left, start: reset - 7 * 86400000, reset, now }) });
  }
  return rows;
}

// ---------- Streak ----------

const WEEKDAYS = ["Sundays", "Mondays", "Tuesdays", "Wednesdays", "Thursdays", "Fridays", "Saturdays"];
/**
 * From a daily map (tokenDaily or dailyActivity: day -> { runs }): the streak of active
 * days up to today (or up to yesterday while today has none yet: still alive), the
 * longest one in the data, today's amount against the average active day of the four
 * weeks before, the busiest weekday over the last eight weeks, and the last 14 days.
 */
export function streakStats(daily, now) {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const keyAt = (back) => dayKey(new Date(today.getFullYear(), today.getMonth(), today.getDate() - back));
  const amount = (back) => daily.get(keyAt(back))?.runs ?? 0;
  const todayAmount = amount(0);
  let current = 0;
  for (let back = todayAmount > 0 ? 0 : 1; amount(back) > 0; back += 1) current += 1;
  const days = [...daily.keys()].filter((k) => (daily.get(k)?.runs ?? 0) > 0).sort();
  let longest = 0;
  let run = 0;
  let prev = null;
  for (const key of days) {
    const d = new Date(`${key}T12:00:00`);
    run = prev && Math.round((d - prev) / 86400000) === 1 ? run + 1 : 1;
    longest = Math.max(longest, run);
    prev = d;
  }
  longest = Math.max(longest, current);
  const before = [];
  for (let back = 1; back <= 28; back += 1) if (amount(back) > 0) before.push(amount(back));
  const average = before.length ? before.reduce((n, v) => n + v, 0) / before.length : 0;
  const byWeekday = Array(7).fill(0);
  for (let back = 0; back < 56; back += 1) byWeekday[new Date(today.getFullYear(), today.getMonth(), today.getDate() - back).getDay()] += amount(back);
  const top = Math.max(...byWeekday);
  return {
    current,
    longest,
    alive: todayAmount > 0,
    today: todayAmount,
    ratio: average > 0 && todayAmount > 0 ? todayAmount / average : null,
    /** The average active day of the four weeks before today (0: none), to compare any day with. */
    average,
    busiest: top > 0 ? WEEKDAYS[byWeekday.indexOf(top)] : null,
    last14: Array.from({ length: 14 }, (_, i) => amount(13 - i) > 0),
  };
}

// ---------- Projects ----------

/**
 * The most active projects of the last `days` days by turns: [{ title, runs, threads, perDay }]
 * (perDay: turns per day, oldest first), at most `limit`, unnamed ones left out.
 */
export function projectStats(feed, now, { days = 7, limit = 4 } = {}) {
  const keys = Array.from({ length: days }, (_, i) => dayKey(new Date(now.getFullYear(), now.getMonth(), now.getDate() - (days - 1 - i))));
  const byProject = new Map();
  keys.forEach((key, i) => {
    for (const [p, threads, runs] of feed.activity.get(key) ?? []) {
      const title = feed.projects[p];
      if (!title || !(runs > 0 || threads > 0)) continue;
      const entry = byProject.get(p) ?? { title, runs: 0, threads: 0, perDay: Array(days).fill(0) };
      entry.runs += runs;
      entry.threads += threads;
      entry.perDay[i] += runs;
      byProject.set(p, entry);
    }
  });
  return [...byProject.values()].sort((a, b) => b.runs - a.runs || a.title.localeCompare(b.title)).slice(0, limit);
}

/** Tokens per provider per day for the last `days` days (T3's usage chart), plus month totals. */
export function tokenSeries(feed, now, days = 14) {
  const keys = [];
  for (let i = days - 1; i >= 0; i -= 1) {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i);
    keys.push(dayKey(d));
  }
  const providers = new Set();
  for (const key of keys) for (const p of Object.keys(feed.spend.get(key) ?? {})) providers.add(p);
  const order = ["codex", "claude", ...[...providers].filter((p) => p !== "codex" && p !== "claude").sort()];
  const series = order
    .filter((p) => providers.has(p))
    .map((p) => ({ provider: p, values: keys.map((k) => feed.spend.get(k)?.[p]?.[1] ?? 0) }))
    .filter((s) => s.values.some((v) => v > 0));
  const monthStart = dayKey(new Date(now.getFullYear(), now.getMonth(), 1));
  const today = dayKey(now);
  // Null-prototype: a provider key is never one of Object's own (see providerEntries).
  const month = Object.create(null);
  for (const [day, byProvider] of feed.spend) {
    if (day < monthStart || day > today) continue;
    for (const [p, [cost, tokens]] of Object.entries(byProvider)) {
      month[p] ??= { cost: 0, tokens: 0 };
      month[p].cost += cost;
      month[p].tokens += tokens;
    }
  }
  return { days: keys, series, month };
}

export const formatPercent = (v) => `${Math.round(v).toLocaleString("en-US")}%`;
/**
 * "$12.34", "$123", "$1.2k", "$12k". Like formatTokens, each form starts where the
 * one below would round up into it: no "$1000", "$100.00" or "$10.0k".
 */
export function formatUsd(value) {
  const v = Number(value) || 0;
  if (v >= 9950) return `$${Math.round(v / 1000)}k`;
  if (v >= 999.5) return `$${(v / 1000).toFixed(1)}k`;
  if (v >= 99.995) return `$${Math.round(v)}`;
  return `$${v.toFixed(2)}`;
}
/** Cents always ("$12.34", "$1.23k"), for one thread's spend; never "$1000.00". */
export const formatUsdExact = (value) => {
  const v = Number(value) || 0;
  return v >= 999.995 ? `$${(v / 1000).toFixed(2)}k` : `$${v.toFixed(2)}`;
};

export function formatTokens(v) {
  const n = Number(v) || 0;
  // Each unit starts where the one below would round up to 1000 of itself, and the
  // decimal goes where it would round to 10: no "1000K", "10.0M" or "1000M".
  if (n >= 999.5e6) return `${(n / 1e9).toFixed(n >= 9.95e9 ? 0 : 1)}B`;
  if (n >= 999.5e3) return `${(n / 1e6).toFixed(n >= 9.95e6 ? 0 : 1)}M`;
  if (n >= 1e3) return `${Math.round(n / 1e3)}K`;
  return String(Math.round(n));
}

/**
 * Which pool belongs to the model in T3's composer picker, from its label
 * ("Claude Opus 5.5, High", "GPT-6.1 Sol, High"): "claude", "codex" or null.
 */
export function providerKind(label) {
  const text = String(label ?? "");
  if (/\b(claude|opus|sonnet|haiku|fable)\b/i.test(text)) return "claude";
  if (/\b(gpt|codex|o[1-9]|sol|terra|astra)\b/i.test(text)) return "codex";
  return null;
}

/**
 * The home feed, loaded through the background worker (or the desktop loader's copy),
 * with a stored copy to fall back to (runtimeFetch.js createCachedFeed). load() resolves
 * to the parsed feed or null; an unchanged feed is the same object.
 */
export const createHomeFeed = ({ area, fetchRemote, endpoint = HOME_FEED_ENDPOINT, readLocal }) =>
  createCachedFeed({ area, key: STORAGE_KEYS.homeFeedCache, fetchRemote, endpoint, parse: parseHomeFeedText, readLocal });
