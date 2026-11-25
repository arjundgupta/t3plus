import { T3PLUS } from "./config.js";
import { createTooltip, TOOLTIP_ID } from "./homeTooltip.js";
import { createBuilder } from "./dom.js";
import { createDitherCanvas } from "./ditherChart.js";
import { enableCardDrag } from "./cardDrag.js";
import { dailyActivity, dayKey, forecastRows, formatPercent, formatTokens, formatUsd, formatUsdExact, hasPool, hasSession, heatmap, poolModel, projectStats, sessionModel, streakStats, tokenDaily, tokenSeries } from "./homeData.js";

// Home widgets under T3's new-thread composer: four compact cards in a 2x2
// grid, exactly as wide as T3's composer.
//   Codex pool / Claude pool  a compact pool chart: what is left, and the
//                             recorded line of this week so far (past usage only).
//   Claude 5-hour             the same chart for Claude's five-hour window, since it opened.
//   Activity                  an activity graph (AI tokens per day),
//                             20 weeks, with weekday and month labels.
//   Usage                     T3's own usage chart (apps/web/src/components/usage/
//                             UsageProviderChart.tsx): one line per provider with a
//                             12% fill, border gridlines, tiny uppercase axis labels.
// Type and color follow T3: text-sm/medium headings, muted secondary text,
// tabular numbers, Codex in --contrast-foreground, Claude in #d97757.
// Plot geometry stays SVG for stable hit-testing; the visible area and line are
// painted by ditherChart.js as a Bayer dither gradient on the same pixel grid
// as the backdrop. The SVG fills remain the fallback when there is no canvas.

const SVG_NS = "http://www.w3.org/2000/svg";

// Lucide icons (ISC), the icon set T3 uses.
const ICONS = {
  activity: '<rect width="18" height="18" x="3" y="4" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/>',
  gauge: '<path d="m12 14 4-4"/><path d="M3.34 19a10 10 0 1 1 17.32 0"/>',
  chart: '<path d="M3 3v16a2 2 0 0 0 2 2h16"/><path d="m19 9-5 5-4-4-3 3"/>',
  timer: '<path d="M10 2h4"/><path d="m12 14 3-3"/><circle cx="12" cy="14" r="8"/>',
  bell: '<path d="M10.268 21a2 2 0 0 0 3.464 0"/><path d="M3.262 15.326A1 1 0 0 0 4 17h16a1 1 0 0 0 .74-1.673C19.41 13.956 18 12.499 18 8A6 6 0 0 0 6 8c0 4.499-1.411 5.956-2.738 7.326"/>',
  trend: '<path d="M16 17h6v-6"/><path d="m22 17-8.5-8.5-5 5L2 7"/>',
  flame: '<path d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.072-2.143-.224-4.054 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.153.433-2.294 1-3a2.5 2.5 0 0 0 2.5 2.5z"/>',
  folder: '<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>',
};

// Null-prototype tables: a provider named "constructor" or "toString" in a feed falls back
// to its own name and the muted color, not to Object's own members.
const PROVIDER_COLORS = {
  __proto__: null,
  codex: "var(--contrast-foreground, var(--foreground))",
  claude: "#d97757",
  grok: "color-mix(in oklab, var(--contrast-foreground, var(--foreground)) 72%, var(--background))",
  cursor: "#8b8b8b",
  opencode: "#5b9bbd",
  antigravity: "#8c7bd1",
  pi: "#4d9f8a",
};
const PROVIDER_LABELS = { __proto__: null, codex: "Codex", claude: "Claude", grok: "Grok", cursor: "Cursor", opencode: "OpenCode", antigravity: "Antigravity", pi: "Pi" };
/**
 * Pool line colors: blue for Codex, T3's Claude orange for Claude. Codex's is a CSS
 * variable, a step deeper on light pages (content.css), where #6f9cf5 read washed out
 * beside the orange; the charts resolve it through the computed style.
 */
const POOL_COLORS = { codex: "var(--t3plus-pool-codex, #6f9cf5)", claude: "#d97757", session: "#d97757" };

/** The cards a user can show or hide (Settings → t3+ → Widgets): settings.home key and label. */
export const HOME_CARDS = Object.freeze([
  ["claudePool", "Claude Pool"],
  ["claudeSession", "Claude 5-Hour"],
  ["codexPool", "Codex Pool"],
  ["forecast", "Limit Forecast"],
  ["needsYou", "Needs You"],
  ["activity", "Activity"],
  ["usage", "Usage"],
  ["streak", "Streak"],
  ["projects", "Projects"],
]);
/** Whether `show` (settings.home, or none: all) shows the card `key`. */
export const showsCard = (show, key) => show?.[key] !== false;
/** Whether `show` leaves any card to show. */
export const showsAnyCard = (show) => HOME_CARDS.some(([key]) => showsCard(show, key));

/**
 * Which cards have something to show in `feed`, and for those that do not, why:
 * { key: null } when available, { key: "reason" } when not. Before the first feed
 * (null) nothing is known: every card is available (each says it is waiting).
 */
export function cardAvailability(feed) {
  const none = Object.fromEntries(HOME_CARDS.map(([key]) => [key, null]));
  if (!feed) return none;
  return {
    ...none,
    codexPool: hasPool(feed, "codex") ? null : "Codex isn't reporting limits. Turn it on and sign in to it in T3's settings.",
    claudePool: hasPool(feed, "claude") ? null : "Claude isn't reporting a weekly limit. Turn it on and sign in to it in T3's settings.",
    claudeSession: hasSession(feed) ? null : "Claude isn't reporting a 5-hour limit. Turn it on and sign in to it in T3's settings.",
    forecast: hasPool(feed, "codex") || hasPool(feed, "claude") || hasSession(feed) ? null : "No provider is reporting limits to forecast. Turn Claude or Codex on in T3's settings.",
  };
}

/** Where the cards go first (settings.home.order, a comma list of HOME_CARDS keys). */
export const DEFAULT_HOME_ORDER = "codexPool,claudePool,claudeSession,forecast,needsYou,activity,usage,streak,projects";
/**
 * The cards' order from a stored one: known keys once each, in its order, then any it
 * leaves out where the default has them (a card added in an update joins at its place).
 */
export function homeOrder(stored) {
  const known = new Set(HOME_CARDS.map(([key]) => key));
  const seen = new Set();
  for (const key of String(stored ?? "").split(",")) if (known.has(key)) seen.add(key);
  const order = [...seen];
  DEFAULT_HOME_ORDER.split(",").forEach((key, i) => {
    if (!seen.has(key)) order.splice(Math.min(i, order.length), 0, key);
  });
  return order;
}
/**
 * The whole order after the cards on show were dragged into `shown`: the hidden ones
 * (turned off, or not reported) keep their places, the shown ones fill theirs anew.
 */
export function mergeOrder(stored, shown) {
  const moved = new Set(shown);
  const queue = [...shown];
  return homeOrder(stored).map((key) => (moved.has(key) ? queue.shift() : key)).join(",");
}
/** An odd card out spans the last row, so the 2-column grid has no hole. */
export function markWide(cards) {
  cards.forEach((card, i) => card.classList.toggle("t3plus-w-wide", cards.length % 2 === 1 && i === cards.length - 1));
}

/** Heatmap length: 20 weeks (the feed carries 140 days). */
export const HEAT_WEEKS = 20;

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const fmtDay = (key) => {
  const [, m, d] = key.split("-").map(Number);
  return `${MONTHS[m - 1]} ${d}`;
};
const fmtWhen = (ms, now) => {
  const d = new Date(ms);
  const sameDay = new Date(now).toDateString() === d.toDateString();
  const time = d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  return sameDay ? time : `${DAYS[d.getDay()]} ${time}`;
};

const LONG_DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
/**
 * "Today 12:00 PM", "Tomorrow 9:00 AM", "Thursday 12:00 PM" within the week, and a
 * date beyond it ("Nov 25, 3:00 PM"): a weekday alone said "Tuesday" on a Tuesday
 * afternoon for next week's reset.
 */
const fmtReset = (ms, now) => {
  // Providers report a reset a fraction of a second early (11:59:59.6): show the minute it means.
  const d = new Date(Math.round(ms / 60000) * 60000);
  const time = d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  const day = new Date(d);
  day.setHours(0, 0, 0, 0);
  const days = Math.round((day - today) / 86400000);
  if (days === 0) return `Today ${time}`;
  if (days === 1) return `Tomorrow ${time}`;
  if (days > 1 && days < 7) return `${LONG_DAYS[d.getDay()]} ${time}`;
  return `${MONTHS[d.getMonth()]} ${d.getDate()}, ${time}`;
};

/**
 * The home widgets. `variant: "pool"` is a single pool card (Codex or Claude,
 * `model.kind`) for T3's thread details panel; the default is the home grid.
 */
export function createHomeView(doc, { variant = "home", onReorder = null, onOpen = null } = {}) {
  const h = createBuilder(doc);
  const svgEl = (tag, attrs = {}) => {
    const el = doc.createElementNS(SVG_NS, tag);
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
    return el;
  };
  const icon = (name) => {
    const svg = svgEl("svg", { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", "stroke-width": "2", "stroke-linecap": "round", "stroke-linejoin": "round", "aria-hidden": "true", class: "t3plus-w-icon" });
    svg.innerHTML = ICONS[name];
    return svg;
  };
  const card = (name, title, iconName, aside, body) =>
    h("section", { class: `t3plus-w t3plus-w-${name}`, "aria-label": title }, [
      h("header", { class: "t3plus-w-head" }, [icon(iconName), h("h3", { text: title }), aside ? h("span", { class: "t3plus-w-aside" }, aside) : null]),
      ...[].concat(body),
    ]);
  const empty = (message) => h("p", { class: "t3plus-w-empty", text: message });

  const element =
    variant === "pool"
      ? h("div", { class: "t3plus-details-pool", "data-t3plus-owned": "" })
      : h("div", { id: T3PLUS.homeId, class: "t3plus-home", "data-t3plus-owned": "" });
  let signature = "";

  // ---------------- Hover: T3-style tooltip + a crosshair on the charts ----------------
  // Cards register what to show; one delegated pointer handler on t3+'s own
  // grid drives everything (no listeners on T3's DOM).
  const tip = createTooltip(doc, variant === "pool" ? `${TOOLTIP_ID}-pool` : TOOLTIP_ID);
  const cellTips = new WeakMap(); // heatmap cell -> tooltip content
  const plotHovers = new WeakMap(); // chart plot -> (fraction 0..1) => { frac, content, dots: [{ y, color }] }
  // The keyboard's way to the same numbers: each chart is a Tab stop whose arrow keys step
  // through its days (or the pool's samples), with the tooltip and a line read out.
  const keyCharts = new WeakMap(); // focusable chart -> { key, size, pick(index) }
  const selected = new WeakMap(); // focusable chart -> the index picked by keys
  // One status line for the view, kept across rebuilds: a live region made anew is not
  // announced the first time.
  const said = h("div", { class: "t3plus-sr-only", role: "status", "aria-live": "polite" });
  let marked = null;
  let dithers = []; // the current cards' dither canvases
  let cell; // their pixel size (CSS px), as the last update gave it
  const dither = (series) => {
    const d = createDitherCanvas(doc, series, { cell });
    dithers.push(d);
    return d.canvas;
  };

  function clearMarker() {
    marked?.querySelector(":scope > .t3plus-w-hover")?.removeAttribute("data-on");
    marked = null;
  }

  /** `box`: the plot's rect, measured for the hit (the crosshair moves by its pixels). */
  function showMarker(plot, hit, box) {
    let marker = plot.querySelector(":scope > .t3plus-w-hover");
    if (!marker) {
      marker = h("div", { class: "t3plus-w-hover", "aria-hidden": "true" }, [h("span", { class: "t3plus-w-hover-line" })]);
      plot.append(marker);
    }
    marker.style.translate = `${(hit.frac * box.width).toFixed(1)}px 0`;
    const dots = [...marker.querySelectorAll(".t3plus-w-hover-dot")];
    hit.dots.forEach((d, i) => {
      const dot = dots[i] ?? marker.appendChild(h("span", { class: "t3plus-w-hover-dot" }));
      dot.style.translate = `0 ${(d.y * box.height).toFixed(1)}px`;
      dot.style.background = d.color;
    });
    for (const extra of dots.slice(hit.dots.length)) extra.remove();
    if (marked && marked !== plot) clearMarker();
    marker.setAttribute("data-on", "");
    marked = plot;
  }

  function showCell(cell) {
    clearMarker();
    const r = cell.getBoundingClientRect();
    tip.show({ x: r.left + r.width / 2, top: r.top, bottom: r.bottom }, cellTips.get(cell));
  }
  /** `box`: the plot's rect, when already measured. */
  function showHit(plot, hit, box = plot.getBoundingClientRect()) {
    showMarker(plot, hit, box);
    tip.show({ x: box.left + hit.frac * box.width, top: box.top, bottom: box.bottom }, hit.content);
  }

  function onPointerMove(event) {
    // A card being dragged (cardDrag.js): no tooltips under it.
    if (element.hasAttribute("data-t3plus-sorting")) {
      clearMarker();
      tip.hide();
      return;
    }
    const target = event.target;
    const cell = target?.closest?.(".t3plus-w-cell");
    if (cell && cellTips.has(cell)) {
      showCell(cell);
      return;
    }
    const plot = target?.closest?.(".t3plus-w-plot");
    const hover = plot && plotHovers.get(plot);
    if (!hover) {
      clearMarker();
      tip.hide();
      return;
    }
    const r = plot.getBoundingClientRect();
    const hit = hover(r.width > 0 ? Math.max(0, Math.min(1, (event.clientX - r.left) / r.width)) : 1);
    if (hit) showHit(plot, hit, r);
  }

  element.addEventListener("pointermove", onPointerMove);
  element.addEventListener("pointerleave", () => {
    clearMarker();
    tip.hide();
  });

  // ---------------- Keys: the same numbers without a pointer ----------------
  const contentText = (c) => [`${c.label}:`, (c.rows ?? []).map((r) => `${r.name} ${r.value}`).join(", "), c.total ? `${c.total.name} ${c.total.value}` : ""].filter(Boolean).join(" ");
  let heatSel = null; // the heatmap cell picked by keys
  function clearHeatSel() {
    heatSel?.removeAttribute("data-t3plus-sel");
    heatSel = null;
  }
  function pick(chart, index) {
    const entry = keyCharts.get(chart);
    const i = Math.max(0, Math.min(entry.size - 1, index));
    selected.set(chart, i);
    const shown = entry.pick(i);
    clearHeatSel();
    if (shown.cell) {
      heatSel = shown.cell;
      heatSel.setAttribute("data-t3plus-sel", "");
      showCell(shown.cell);
    } else showHit(chart, shown.hit);
    said.textContent = contentText(shown.content);
  }
  // A chart focused by a click (it is a Tab stop, so a click focuses it) is the pointer's:
  // picked then, the latest day's tooltip and ring jumped over the one under the pointer.
  let pointerDown = false;
  element.addEventListener("pointerdown", () => (pointerDown = true));
  for (const type of ["pointerup", "pointercancel", "pointerleave"]) element.addEventListener(type, () => (pointerDown = false));
  element.addEventListener("focusin", (event) => {
    const chart = event.target;
    // The latest day (or now) first.
    if (keyCharts.has(chart) && !pointerDown) pick(chart, selected.get(chart) ?? keyCharts.get(chart).size - 1);
  });
  element.addEventListener("focusout", (event) => {
    if (!keyCharts.has(event.target)) return;
    clearMarker();
    clearHeatSel();
    tip.hide();
  });
  element.addEventListener("keydown", (event) => {
    const chart = event.target;
    const entry = keyCharts.get(chart);
    if (!entry || event.altKey || event.ctrlKey || event.metaKey) return;
    if (event.key === "Escape") {
      tip.hide();
      return;
    }
    const at = selected.get(chart) ?? entry.size - 1;
    const week = entry.key === "activity" ? 7 : 1; // the heatmap's columns are weeks
    const day = entry.key === "activity" ? 1 : 0;
    const to = { ArrowLeft: at - week, ArrowRight: at + week, ArrowUp: day ? at - day : undefined, ArrowDown: day ? at + day : undefined, Home: 0, End: entry.size - 1 }[event.key];
    if (to === undefined) return;
    event.preventDefault();
    pick(chart, to);
  });
  /** A chart's attributes: one Tab stop, arrow keys inside (role application), its summary as its name. */
  const chartAttrs = (key, label, extra) => ({ ...extra, tabindex: "0", role: "application", "aria-roledescription": "chart", "aria-label": label, "data-t3plus-chart": key });

  // ---------------- Pool (Codex / Claude) ----------------

  /** `kind`: "codex", "claude" (the weekly pools) or "session" (Claude's five-hour window). */
  function poolCard(feed, kind, now) {
    const session = kind === "session";
    const title = session ? "Claude 5-Hour" : kind === "codex" ? "Codex Pool" : "Claude Pool";
    const iconName = session ? "timer" : "gauge";
    const nowMs = now.getTime();
    const pool = session ? sessionModel(feed, nowMs) : weeklyPool(feed, kind, nowMs);
    if (!pool) return card(`pool t3plus-w-${kind}`, title, iconName, null, [empty(feed ? "No limits reported." : "Waiting for the home feed…")]);
    return poolChart(feed, kind, pool, title, iconName, nowMs, session ? "this 5-hour window" : "this week");
  }

  function weeklyPool(feed, kind, nowMs) {
    const DAY = 86400000;
    const HOUR = 3600000;
    // Past usage only: this week so far (since the last weekly reset), over the
    // part of it that was recorded, so a pool recorded for a few hours fills the
    // chart with those hours instead of a sliver at the end of an empty week.
    const base = poolModel(feed, kind, nowMs);
    // A reset more than a week out (the provider's clock a little ahead, right after a
    // reset) put the week's start after now and the line far off the plot: that week
    // has just begun, a minute ago.
    const weekStart = Math.min(nowMs - 60000, base?.nextRefill ? base.nextRefill.at - 7 * DAY : nowMs - 3 * DAY);
    const firstSample = base ? (kind === "codex" ? feed.codexSeries : feed.claudeSeries).find((p) => p.t >= weekStart)?.t : undefined;
    const from = Math.max(weekStart, Math.min(firstSample ?? nowMs, nowMs - 2 * HOUR));
    return base && poolModel(feed, kind, nowMs, { back: (nowMs - from) / DAY });
  }

  function poolChart(feed, kind, pool, title, iconName, nowMs, period) {
    const DAY = 86400000;
    const HOUR = 3600000;
    const color = POOL_COLORS[kind];
    const W = 300;
    const H = 72;
    // The five-hour chart runs to the window's reset (pool.end); the weekly ones end at now.
    const end = pool.end ?? pool.now;
    const span = Math.max(1, end - pool.from);
    const x = (t) => ((t - pool.from) / span) * W;
    const y = (v) => H - 1 - (Math.max(0, Math.min(pool.cap, v)) / pool.cap) * (H - 8);
    // A single sample (a pool just started being recorded) still shows as a short level line.
    const recorded = pool.recorded.length > 1 ? pool.recorded : [{ t: pool.now - (pool.now - pool.from) * 0.02, left: pool.left }, { t: pool.now, left: pool.left }];
    // No five-hour window running: the hours ahead, empty (no line, nothing to hover).
    const idle = pool.active === false;
    const svg = svgEl("svg", { viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: "none", class: "t3plus-w-plot-svg", "data-t3plus-dither-chart": "area", "aria-hidden": "true" });
    svg.style.setProperty("--pool-color", color);
    svg.append(svgEl("path", { d: `M0 ${y(pool.cap / 2)}H${W}`, class: "t3plus-w-grid" }));
    // The baseline on its own: opaque on light pages, where the gridlines are see-through (content.css).
    svg.append(svgEl("path", { d: `M0 ${H - 0.5}H${W}`, class: "t3plus-w-grid t3plus-w-base" }));
    const line = (points) => points.map((p, i) => `${i ? "L" : "M"}${x(p.t).toFixed(1)} ${y(p.left).toFixed(1)}`).join("");
    const area = (points) => `${line(points)}L${x(points.at(-1).t).toFixed(1)} ${H}L${x(points[0].t).toFixed(1)} ${H}Z`;
    if (!idle) {
      svg.append(svgEl("path", { d: area(recorded), class: "t3plus-w-area" }));
      svg.append(svgEl("path", { d: line(recorded), class: "t3plus-w-line", "vector-effect": "non-scaling-stroke" }));
    }

    const pct = (t) => `${((x(t) / W) * 100).toFixed(2)}%`;
    // Day names over a few days; hours ("6 PM") over a shorter span.
    const ticks = [];
    const tickStep = span > 36 * HOUR ? DAY : span > 12 * HOUR ? 6 * HOUR : span > 6 * HOUR ? 3 * HOUR : HOUR;
    const first = new Date(pool.from);
    if (tickStep === DAY) first.setHours(24, 0, 0, 0);
    else first.setHours(Math.ceil((first.getHours() + first.getMinutes() / 60 + 0.001) / (tickStep / HOUR)) * (tickStep / HOUR), 0, 0, 0);
    // Stepped on the local calendar (next midnight, next 6 PM), not by fixed
    // milliseconds: across a daylight-saving change a 24 h step lands on 11 PM or
    // 1 AM and the day names came out wrong ("Sun, Sun, Mon").
    for (const d = first; d.getTime() < end; tickStep === DAY ? d.setDate(d.getDate() + 1) : d.setHours(d.getHours() + tickStep / HOUR)) {
      const t = d.getTime();
      if (x(t) < 14 || x(t) > W - 14) continue;
      const text = tickStep === DAY ? DAYS[d.getDay()] : d.toLocaleTimeString("en-US", { hour: "numeric" }).replace(":00", "");
      ticks.push(h("span", { style: `left:${pct(t)}`, text }));
    }
    const frac = (points) => points.map((p) => [x(p.t) / W, y(p.left) / H]);
    if (idle) {
      const emptyPlot = h("div", { class: "t3plus-w-plot", "data-t3plus-idle": "", role: "img", "aria-label": `${title}: no window running; the next message starts one` }, [svg]);
      return finishPool(emptyPlot);
    }
    const poolDither = dither([{ points: frac(recorded), color, fillAlpha: 0.85 }]);
    const poolPlot = h("div", chartAttrs(`pool-${kind}`, `${title}: ${formatPercent(pool.left)} remaining of ${formatPercent(pool.cap)} ${period}`, { class: "t3plus-w-plot" }), [poolDither, svg]);
    const poolHover = (f) => {
      const t = pool.from + f * span;
      let best = recorded[0];
      for (const p of recorded) if (Math.abs(p.t - t) < Math.abs(best.t - t)) best = p;
      if (!best) return null;
      return {
        frac: x(best.t) / W,
        dots: [{ y: y(best.left) / H, color }],
        content: {
          label: `${fmtWhen(best.t, pool.now)}${best.t === pool.now ? " · now" : ""}`,
          rows: [{ name: "Left", value: `${formatPercent(best.left)} of ${formatPercent(pool.cap)}`, color }],
        },
      };
    };
    plotHovers.set(poolPlot, poolHover);
    // Keys step an hour at least: samples come every ten minutes, a thousand in a week.
    const stops = [];
    for (const p of recorded) if (!stops.length || p.t - stops.at(-1) >= HOUR) stops.push(p.t);
    if (stops.at(-1) !== recorded.at(-1).t) stops.push(recorded.at(-1).t);
    keyCharts.set(poolPlot, {
      key: `pool-${kind}`,
      size: stops.length,
      pick: (i) => {
        const hit = poolHover((stops[i] - pool.from) / span);
        return { hit, content: hit.content };
      },
    });
    return finishPool(poolPlot);

    // Two plain lines: what is left, and when it resets; then the plot and its hours.
    function finishPool(plot) {
    // A pool of several accounts is larger than 100%: say what it is out of.
    const remaining = Math.round(pool.cap) === 100 ? "remaining" : `remaining of ${formatPercent(pool.cap)}`;
    // Old data says so: when the feed stops updating (T3's CLI or API broke), the
    // percentage would otherwise read as current for days.
    const age = feed.generatedAt ? nowMs - Date.parse(feed.generatedAt) : 0;
    const stale = age > HOUR ? h("div", { class: "t3plus-w-stale", text: `Updated ${age >= 2 * DAY ? `${Math.floor(age / DAY)} days` : age >= DAY ? "1 day" : `${Math.floor(age / HOUR)} h`} ago` }) : null;
    // A five-hour window that has run out is full again; the next message opens a new one.
    const reset = pool.nextRefill
      ? h("div", { class: "t3plus-w-reset", text: `Reset - ${fmtReset(pool.nextRefill.at, pool.now)}` })
      : pool.active === false
        ? h("div", { class: "t3plus-w-reset", text: "Starts with your next message" })
        : null;
    return card(`pool t3plus-w-${kind}`, title, iconName, null /* the corner stays empty */, [
      h("div", { class: "t3plus-w-pool-head" }, [
        h("span", { class: "t3plus-w-big-num", text: formatPercent(pool.left) }),
        h("span", { class: "t3plus-w-muted", text: remaining }),
      ]),
      reset,
      stale,
      plot,
      h("div", { class: "t3plus-w-axis" }, ticks),
    ]);
    }
  }

  // ---------------- Activity ----------------

  // Fills its card: a weekday column (Mon / Wed / Fri), month labels on top,
  // and one square per day, scaled to the card's width.
  function activityCard(feed, now) {
    if (!feed) return card("activity", "Activity", "activity", null, [empty("Waiting for the home feed…")]);
    // The activity source's numbers (AI tokens per day) when the feed has them; T3 turns otherwise.
    const tokens = feed.aiActivity.size > 0;
    const daily = tokens ? tokenDaily(feed) : dailyActivity(feed);
    const map = heatmap(daily, now, HEAT_WEEKS);
    const unit = tokens ? "tokens" : "turns";
    const amount = (v) => (tokens ? formatTokens(v) : v.toLocaleString("en-US"));
    const grid = h("div", chartAttrs("activity", `Activity: ${amount(map.runs)} ${unit} over the last ${HEAT_WEEKS} weeks`, { class: "t3plus-w-heat" }));
    const days = []; // the cells up to today, a column (a week) after another
    grid.style.setProperty("--weeks", String(HEAT_WEEKS));
    const place = (el, col, row) => {
      el.style.gridColumn = String(col);
      el.style.gridRow = String(row);
      return el;
    };
    for (const [row, label] of [[3, "Mon"], [5, "Wed"], [7, "Fri"]]) grid.append(place(h("span", { class: "t3plus-w-heat-day", text: label }), 1, row));
    let lastMonth = -1;
    let lastLabel = -Infinity;
    map.columns.forEach((column, w) => {
      // The month of the week's last day, so a label sits on the month's first full week.
      const month = Number(column[6].key.slice(5, 7)) - 1;
      if (month !== lastMonth && w - lastLabel >= 3 && w < HEAT_WEEKS - 1) {
        grid.append(place(h("span", { class: "t3plus-w-heat-month", text: MONTHS[month] }), w + 2, 1));
        lastLabel = w;
      }
      lastMonth = month;
      column.forEach((cell, d) => {
        const el = h("span", { class: "t3plus-w-cell", "data-level": String(cell.level) });
        if (cell.future) el.setAttribute("data-future", "");
        if (cell.today) el.setAttribute("data-today", "");
        if (!cell.future) {
          const providers = Object.entries(daily.get(cell.key)?.providers ?? {}).sort((a, b) => b[1] - a[1]);
          cellTips.set(el, {
            label: `${DAYS[new Date(`${cell.key}T12:00:00`).getDay()]}, ${fmtDay(cell.key)}`,
            rows: providers.map(([p, n]) => ({ name: PROVIDER_LABELS[p] ?? p, value: formatTokens(n), color: PROVIDER_COLORS[p] ?? "var(--muted-foreground)" })),
            total: { name: tokens ? "Total" : "Turns", value: cell.runs ? amount(cell.runs) : "No activity" },
          });
          days.push(el);
        }
        grid.append(place(el, w + 2, d + 2));
      });
    });
    keyCharts.set(grid, { key: "activity", size: days.length, pick: (i) => ({ cell: days[i], content: cellTips.get(days[i]) }) });
    return card("activity", "Activity", "activity", [h("span", { class: "t3plus-w-muted", text: `${amount(map.runs)} ${unit}` })], [grid]);
  }

  // ---------------- Usage (T3's chart) ----------------

  function usageCard(feed, now) {
    if (!feed) return card("usage", "Usage", "chart", null, [empty("Waiting for the home feed…")]);
    const { days, series, month } = tokenSeries(feed, now, 14);
    if (!series.length) return card("usage", "Usage", "chart", null, [empty("No usage recorded in the last two weeks.")]);
    const W = 300;
    const H = 72;
    const max = Math.max(1, ...series.flatMap((s) => s.values));
    const step = W / (days.length - 1);
    const y = (v) => H - (v / max) * (H - 6);
    const svg = svgEl("svg", { viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: "none", class: "t3plus-w-plot-svg", "data-t3plus-dither-chart": "line", "aria-hidden": "true" });
    svg.append(svgEl("path", { d: `M0 ${y(max)}H${W}M0 ${y(max / 2)}H${W}`, class: "t3plus-w-grid" }));
    svg.append(svgEl("path", { d: `M0 ${H - 0.5}H${W}`, class: "t3plus-w-grid t3plus-w-base" }));
    for (const s of series) {
      const line = s.values.map((v, i) => `${i ? "L" : "M"}${(i * step).toFixed(1)} ${y(v).toFixed(1)}`).join("");
      const area = svgEl("path", { d: `${line}L${W} ${H}L0 ${H}Z`, fill: PROVIDER_COLORS[s.provider] ?? "var(--muted-foreground)", "fill-opacity": "0.12" });
      const stroke = svgEl("path", { d: line, fill: "none", stroke: PROVIDER_COLORS[s.provider] ?? "var(--muted-foreground)", "stroke-width": "2", "vector-effect": "non-scaling-stroke" });
      svg.append(area, stroke);
    }
    const legend = Object.entries(month)
      .filter(([, v]) => v.tokens > 0)
      .sort((a, b) => b[1].tokens - a[1].tokens)
      .slice(0, 3)
      .map(([p, v]) =>
        h("span", { class: "t3plus-w-legend-item", title: `${PROVIDER_LABELS[p] ?? p} this month: ${formatTokens(v.tokens)} tokens, ${formatUsd(v.cost)}` }, [
          h("span", { class: "t3plus-w-legend-dot", style: `background:${PROVIDER_COLORS[p] ?? "var(--muted-foreground)"}` }),
          `${PROVIDER_LABELS[p] ?? p} ${formatTokens(v.tokens)}`,
        ]));
    const totalCost = Object.values(month).reduce((n, v) => n + v.cost, 0);
    const label = (key) => fmtDay(key).toUpperCase();
    // Largest series first, so a smaller one stays visible on top of it.
    const usageDither = dither([...series]
      .sort((a, b) => b.values.reduce((n, v) => n + v, 0) - a.values.reduce((n, v) => n + v, 0))
      .map((s) => ({ points: s.values.map((v, i) => [i / (days.length - 1), y(v) / H]), color: PROVIDER_COLORS[s.provider] ?? "var(--muted-foreground)", fillAlpha: 0.75 })));
    const usagePlot = h("div", chartAttrs("usage", `Tokens per day by provider, last ${days.length} days`, { class: "t3plus-w-plot" }), [usageDither, svg]);
    const usageHover = (frac) => {
      const i = Math.round(frac * (days.length - 1));
      const key = days[i];
      const spend = Object.values(feed.spend.get(key) ?? {}).reduce((n, [cost]) => n + cost, 0);
      const total = series.reduce((n, s) => n + s.values[i], 0);
      return {
        frac: i / (days.length - 1),
        dots: series.map((s) => ({ y: y(s.values[i]) / H, color: PROVIDER_COLORS[s.provider] ?? "var(--muted-foreground)" })),
        content: {
          label: `${DAYS[new Date(`${key}T12:00:00`).getDay()]}, ${fmtDay(key)}`,
          rows: [...series].sort((a, b) => b.values[i] - a.values[i]).map((s) => ({ name: PROVIDER_LABELS[s.provider] ?? s.provider, value: formatTokens(s.values[i]), color: PROVIDER_COLORS[s.provider] ?? "var(--muted-foreground)" })),
          total: { name: "Total", value: `${formatTokens(total)} · ${formatUsd(spend)}` },
        },
      };
    };
    plotHovers.set(usagePlot, usageHover);
    keyCharts.set(usagePlot, {
      key: "usage",
      size: days.length,
      pick: (i) => {
        const hit = usageHover(i / (days.length - 1));
        return { hit, content: hit.content };
      },
    });
    // The middle date sits over its own day, not halfway: with an even number of days
    // no day is at the middle, and the halfway label named the day after it.
    const midLabel = (list) => {
      const mid = Math.floor(list.length / 2);
      const el = h("span", { class: "t3plus-w-axis-mid", text: label(list[mid]) });
      el.style.left = `${((mid / Math.max(1, list.length - 1)) * 100).toFixed(2)}%`;
      return el;
    };
    return card("usage", "Usage", "chart", [h("span", { class: "t3plus-w-muted", text: `${formatUsd(totalCost)} this month` })], [
      h("div", { class: "t3plus-w-usage-plot" }, [
        h("div", { class: "t3plus-w-yaxis" }, [h("span", { text: formatTokens(max) }), h("span", { text: "0" })]),
        usagePlot,
      ]),
      h("div", { class: "t3plus-w-axis t3plus-w-axis-spread" }, [h("span", { text: label(days[0]) }), midLabel(days), h("span", { text: label(days.at(-1)) })]),
      h("div", { class: "t3plus-w-legend" }, legend),
    ]);
  }

  // ---------------- Needs You ----------------
  // Threads waiting on you (app.js builds them from the Status view's model): an approval,
  // a question, a failure. A row opens its thread.
  const NEEDS_TONE = { approval: "ask", input: "ask", request: "ask", limited: "bad", failed: "bad", woke: "info" };
  function needsCard(needs, now) {
    const title = "Needs You";
    if (!needs) return card("needs", title, "bell", null, [empty("Waiting for the sidebar…")]);
    if (!needs.rows.length) return card("needs", title, "bell", null, [h("p", { class: "t3plus-w-muted t3plus-w-needs-clear", text: "Nothing needs you right now." })]);
    const shown = needs.rows.slice(0, 3);
    const more = needs.rows.length - shown.length;
    const list = h(
      "ul",
      { class: "t3plus-w-needs-list" },
      shown.map((row) =>
        h("li", {}, [
          h("button", { type: "button", class: "t3plus-w-needs-row", "data-t3plus-open": row.key, title: `Open ${row.title}` }, [
            h("span", { class: "t3plus-w-needs-word", "data-tone": NEEDS_TONE[row.status] ?? "ask", text: row.word || "Needs you" }),
            h("span", { class: "t3plus-w-needs-title", text: row.title || "Untitled thread" }),
            h("span", { class: "t3plus-w-muted t3plus-w-needs-meta", text: [row.project, row.ago].filter(Boolean).join(" · ") }),
          ]),
        ]),
      ),
    );
    return card("needs", title, "bell", [h("span", { class: "t3plus-w-muted", text: `${needs.rows.length} waiting` })], [list, more > 0 ? h("div", { class: "t3plus-w-muted t3plus-w-needs-more", text: `+${more} more in the Status view` }) : null]);
  }
  element.addEventListener("click", (event) => {
    const row = event.target?.closest?.("[data-t3plus-open]");
    if (row && element.contains(row)) onOpen?.(row.getAttribute("data-t3plus-open"));
    // A day of the Streak card's strip: its numbers on the card's line; clicked again, today's.
    const day = event.target?.closest?.("[data-t3plus-day]");
    const strip = day?.parentElement;
    if (day && streakPick.has(strip)) {
      const key = day.getAttribute("data-t3plus-day");
      streakPick.get(strip)(streakDay === key ? null : key);
    }
  });
  let streakDay = null; // the day picked on the Streak card's strip (null: today)
  const streakPick = new WeakMap(); // strip -> show(day key or null)

  // ---------------- Limit Forecast ----------------
  function forecastCard(feed, now) {
    const title = "Limit Forecast";
    const nowMs = now.getTime();
    const rows = forecastRows(feed, nowMs);
    if (!rows.length) return card("forecast", title, "trend", null, [empty(feed ? "No limits reported." : "Waiting for the home feed…")]);
    const say = (r) =>
      r.state === "runsOut"
        ? `Runs out ${fmtReset(r.at, nowMs)}`
        : r.state === "lasts"
          ? `Lasts · ~${r.leftAtReset}% left at reset`
          : r.state === "early"
            ? "Too early to tell"
            : r.state === "idle"
              ? "No session running"
              : "Nothing used yet";
    return card("forecast", title, "trend", [h("span", { class: "t3plus-w-muted", text: "At your pace" })], [
      h(
        "div",
        { class: "t3plus-w-fc" },
        rows.map((r) => {
          const bar = h("div", { class: "t3plus-w-fc-bar", "aria-hidden": "true" }, [h("span", { class: "t3plus-w-fc-projected" }), h("span", { class: "t3plus-w-fc-used" })]);
          bar.style.setProperty("--used", `${(r.usedFrac * 100).toFixed(1)}%`);
          bar.style.setProperty("--projected", `${(r.projectedFrac * 100).toFixed(1)}%`);
          bar.style.setProperty("--fc-color", r.key === "codex" ? POOL_COLORS.codex : POOL_COLORS.claude);
          return h("div", { class: "t3plus-w-fc-row", "data-state": r.state, title: r.reset ? `Resets ${fmtReset(r.reset, nowMs)}` : "" }, [
            h("div", { class: "t3plus-w-fc-text" }, [h("span", { class: "t3plus-w-fc-label", text: r.label }), h("span", { class: "t3plus-w-fc-say", text: say(r) })]),
            bar,
          ]);
        }),
      ),
    ]);
  }

  // ---------------- Streak ----------------
  function streakCard(feed, now) {
    const title = "Streak";
    if (!feed) return card("streak", title, "flame", null, [empty("Waiting for the home feed…")]);
    const tokens = feed.aiActivity.size > 0;
    const daily = tokens ? tokenDaily(feed) : dailyActivity(feed);
    const s = streakStats(daily, now);
    const amount = (v) => (tokens ? `${formatTokens(v)} tokens` : `${v.toLocaleString("en-US")} turns`);
    const days = (n) => `${n} day${n === 1 ? "" : "s"}`;
    // The 14 days of the strip, oldest first; the last is today.
    const keys = Array.from({ length: 14 }, (_, i) => dayKey(new Date(now.getFullYear(), now.getMonth(), now.getDate() - (13 - i))));
    const todayKey = keys[13];
    const dayName = (key) => (key === todayKey ? "Today" : `${DAYS[new Date(`${key}T12:00:00`).getDay()]}, ${fmtDay(key)}`);
    const providersOf = (key) => Object.entries(daily.get(key)?.providers ?? {}).sort((a, b) => b[1] - a[1]);
    // What the line under the streak says for a day: its amount, against the average, by provider.
    const lineFor = (key) => {
      const v = daily.get(key)?.runs ?? 0;
      if (!v) return key === todayKey ? "Nothing yet today" : `${dayName(key)} · No activity`;
      const ratio = s.average > 0 ? ` · ${(v / s.average).toFixed(1)}× your average` : "";
      const split = providersOf(key);
      const by = split.length > 1 ? ` · ${split.slice(0, 3).map(([p, n]) => `${PROVIDER_LABELS[p] ?? p} ${formatTokens(n)}`).join(", ")}` : "";
      return `${dayName(key)} ${key === todayKey ? "" : "· "}${amount(v)}${ratio}${by}`;
    };
    const line = h("div", { class: "t3plus-w-muted t3plus-w-streak-today", "aria-live": "polite" });
    const cells = keys.map((key, i) => {
      const cell = h("span", { class: "t3plus-w-cell", "data-level": s.last14[i] ? "3" : "0", "data-t3plus-day": key });
      if (key === todayKey) cell.setAttribute("data-today", "");
      // The Activity heatmap's tooltip, on hover.
      cellTips.set(cell, {
        label: `${DAYS[new Date(`${key}T12:00:00`).getDay()]}, ${fmtDay(key)}`,
        rows: providersOf(key).map(([p, n]) => ({ name: PROVIDER_LABELS[p] ?? p, value: formatTokens(n), color: PROVIDER_COLORS[p] ?? "var(--muted-foreground)" })),
        total: { name: tokens ? "Total" : "Turns", value: daily.get(key)?.runs ? (tokens ? formatTokens(daily.get(key).runs) : daily.get(key).runs.toLocaleString("en-US")) : "No activity" },
      });
      return cell;
    });
    // A day picked (a click, or arrow keys) shows its numbers on the line; none: today's.
    // Kept across rebuilds while it is still in the strip.
    if (streakDay && !keys.includes(streakDay)) streakDay = null;
    const show = (key) => {
      streakDay = key && key !== todayKey ? key : null;
      setLine();
    };
    const setLine = () => {
      line.textContent = lineFor(streakDay ?? todayKey);
      for (const cell of cells) cell.toggleAttribute("data-t3plus-picked", cell.getAttribute("data-t3plus-day") === streakDay);
    };
    setLine();
    const strip = h("div", chartAttrs("streak", `Last 14 days: ${s.last14.filter(Boolean).length} active. Arrow keys pick a day.`, { class: "t3plus-w-streak-strip", title: "Click a day to see its usage" }), cells);
    streakPick.set(strip, show);
    keyCharts.set(strip, {
      key: "streak",
      size: cells.length,
      pick: (i) => {
        show(keys[i]);
        return { cell: cells[i], content: cellTips.get(cells[i]) };
      },
    });
    return card("streak", title, "flame", null, [
      h("div", { class: "t3plus-w-pool-head" }, [h("span", { class: "t3plus-w-big-num", text: days(s.current) }), h("span", { class: "t3plus-w-muted", text: s.current && !s.alive ? "use it today to keep it" : "in a row" })]),
      h("div", { class: "t3plus-w-reset", text: `Longest ${days(s.longest)}${s.busiest ? ` · Busiest on ${s.busiest}` : ""}` }),
      line,
      strip,
    ]);
  }

  // ---------------- Projects ----------------
  function projectsCard(feed, now, label) {
    const title = "Projects";
    if (!feed) return card("projects", title, "folder", null, [empty("Waiting for the home feed…")]);
    const list = projectStats(feed, now);
    if (!list.length) return card("projects", title, "folder", null, [empty("No project activity in the last 7 days.")]);
    const top = Math.max(1, ...list.flatMap((p) => p.perDay));
    // Each project's share against the busiest one: a bar that takes the row's free width,
    // so a wide card reads as one line instead of a name far from its numbers.
    const most = Math.max(1, ...list.map((p) => p.runs));
    return card("projects", title, "folder", [h("span", { class: "t3plus-w-muted", text: "Last 7 days" })], [
      h(
        "ul",
        { class: "t3plus-w-project-list" },
        list.map((p) =>
          h("li", { class: "t3plus-w-project", title: `${p.runs} turns, ${p.threads} new thread${p.threads === 1 ? "" : "s"}` }, [
            h("span", { class: "t3plus-w-project-name", text: label ? label(p.title) : p.title }),
            h("span", { class: "t3plus-w-project-share", "aria-hidden": "true" }, [h("span", { style: `width:${Math.max(3, (p.runs / most) * 100).toFixed(1)}%` })]),
            h("span", { class: "t3plus-w-project-days", "aria-hidden": "true" }, p.perDay.map((v) => {
              const bar = h("span", {});
              bar.style.height = `${Math.max(v ? 18 : 6, (v / top) * 100).toFixed(0)}%`;
              if (!v) bar.setAttribute("data-zero", "");
              return bar;
            })),
            h("span", { class: "t3plus-w-muted t3plus-w-project-runs", text: `${p.runs.toLocaleString("en-US")} turns` }),
          ]),
        ),
      ),
    ]);
  }

  /** The cards for `model`, in place of the ones shown. */
  function rebuild(model, now) {
    if (variant === "pool") {
      element.replaceChildren(poolCard(model.feed, model.kind === "codex" ? "codex" : "claude", now));
      // What this thread has cost so far, in the style of T3's Context row below.
      if (model.spend) {
        const usd = formatUsdExact(model.spend.usd);
        element.append(
          h("div", { class: "t3plus-w-spend", title: `${model.spend.tokens.toLocaleString("en-US")} tokens, priced like T3's Usage page` }, [
            h("span", { class: "t3plus-w-spend-label", text: "Spend" }),
            h("span", { class: "t3plus-w-spend-value" }, [h("span", { text: usd }), h("span", { class: "t3plus-w-muted", text: ` · ${formatTokens(model.spend.tokens)}` })]),
          ]),
        );
      }
      return;
    }
    // A card with nothing to show (its provider off, or signed out) is left out; Settings
    // says why and does not offer it (cardAvailability).
    const unavailable = cardAvailability(model.feed);
    const make = {
      codexPool: () => poolCard(model.feed, "codex", now),
      claudePool: () => poolCard(model.feed, "claude", now),
      claudeSession: () => poolCard(model.feed, "session", now),
      activity: () => activityCard(model.feed, now),
      usage: () => usageCard(model.feed, now),
      forecast: () => forecastCard(model.feed, now),
      needsYou: () => needsCard(model.needs ?? null, now),
      streak: () => streakCard(model.feed, now),
      projects: () => projectsCard(model.feed, now, model.projectLabel ?? null),
    };
    // Only the cards picked in Settings → t3+ → Widgets, in the order they were dragged into.
    const cards = homeOrder(model.show?.order)
      .filter((key) => !unavailable[key] && showsCard(model.show, key))
      .map((key) => {
        const card = make[key]();
        card.setAttribute("data-t3plus-card", key);
        return card;
      });
    markWide(cards);
    element.replaceChildren(...cards);
  }

  // Cards are dragged by their header to a new place; the order is kept (settings.home.order).
  let lastOrder = null;
  const sorter =
    variant === "home" && onReorder
      ? enableCardDrag(element, {
          item: ".t3plus-w",
          handle: ".t3plus-w-head",
          keyOf: (el) => el.getAttribute("data-t3plus-card"),
          onLive: (grid) => markWide([...grid.children].filter((el) => el.matches(".t3plus-w"))),
          onOrder: (keys) => onReorder(mergeOrder(lastOrder, keys)),
        })
      : null;
  if (sorter) element.setAttribute("data-t3plus-sortable", "");

  return {
    element,
    /** @param {{ feed, now?: Date, cell?: number, show?: object }} model  cell: the dither cell size in CSS px (the backdrop's); show: settings.home (which cards, their order) */
    update(model) {
      const now = model.now ?? new Date();
      cell = model.cell ?? cell;
      // The cards are rebuilt when the feed changes, and otherwise every five minutes:
      // on a week-long axis the "now" line moves a hair in that time. A feed without a
      // generatedAt is still a feed: signed as none, it left "Waiting for the home feed…" up.
      const minute = Math.floor(now.getTime() / 300000);
      const fed = model.feed ? (model.feed.generatedAt ?? "feed") : null;
      const shown = HOME_CARDS.filter(([key]) => showsCard(model.show, key) && !cardAvailability(model.feed)[key]).map(([key]) => key);
      lastOrder = model.show?.order ?? null;
      // Not while a card is being dragged: rebuilt under the pointer, it was dropped.
      if (sorter?.dragging()) return false;
      // Needs You's rows, and screenshot mode (it renames projects), are part of what is shown.
      const next = JSON.stringify([fed, model.kind ?? null, minute, model.spend ?? null, shown, homeOrder(lastOrder), model.needs ?? null, Boolean(model.projectLabel)]);
      if (next === signature) {
        // Same cards: repaint only if the pixel size or layout changed (a no-op otherwise).
        for (const d of dithers) d.paint({ cell });
        return false;
      }
      signature = next;
      // A chart in use by keys is picked again in the new cards: rebuilt under it, the focus fell to the page.
      const focused = keyCharts.get(doc.activeElement) && element.contains(doc.activeElement) ? doc.activeElement : null;
      const refocus = focused && { key: keyCharts.get(focused).key, index: selected.get(focused) };
      tip.hide();
      marked = null;
      heatSel = null;
      for (const d of dithers) d.disconnect();
      dithers = [];
      rebuild(model, now);
      element.append(said);
      if (refocus) {
        const chart = element.querySelector(`[data-t3plus-chart="${refocus.key}"]`);
        if (chart && keyCharts.has(chart)) {
          if (refocus.index !== undefined) selected.set(chart, Math.min(refocus.index, keyCharts.get(chart).size - 1));
          chart.focus({ preventScroll: true });
        }
      }
      return true;
    },
    /**
     * Hides the tooltip and the chart crosshair. For when the cards leave the
     * page under a still pointer (a keyboard shortcut or a thread switch): no
     * pointerleave comes then, and the tooltip on <body> would stay up.
     */
    hide() {
      clearMarker();
      tip.hide();
    },
    /** Removes the tooltip from <body> (t3+ stopped). */
    destroy() {
      for (const d of dithers) d.disconnect();
      dithers = [];
      tip.remove();
    },
  };

}
