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
  // Recorded pools: [unix seconds, left, cap, (five-hour left, five-hour cap)] in percent of a Plus week.
  const series = (list) =>
    (Array.isArray(list) ? list : [])
      .filter((p) => Array.isArray(p) && p.length >= 3 && p.slice(0, 3).every((v) => typeof v === "number" && Number.isFinite(v)) && p[2] > 0)
      .slice(-2000)
      .map(([t, left, cap]) => ({ t: t * 1000, left: Math.max(0, left), cap }))
      .sort((a, b) => a.t - b.t);
  return {
    generatedAt: iso(d.generatedAt),
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
