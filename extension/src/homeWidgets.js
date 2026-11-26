import { T3PLUS } from "./config.js";
import { createTooltip, TOOLTIP_ID } from "./homeTooltip.js";
import { createBuilder } from "./dom.js";
import { createDitherCanvas } from "./ditherChart.js";
import { dailyActivity, formatPercent, formatTokens, formatUsd, formatUsdExact, hasPool, heatmap, poolModel, tokenDaily, tokenSeries } from "./homeData.js";

// Home widgets under T3's new-thread composer: four compact cards in a 2x2
// grid, exactly as wide as T3's composer.
//   Codex pool / Claude pool  a compact pool chart: what is left, and the
//                             recorded line of this week so far (past usage only).
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
const POOL_COLORS = { codex: "var(--t3plus-pool-codex, #6f9cf5)", claude: "#d97757" };

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
export function createHomeView(doc, { variant = "home" } = {}) {
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

  function poolCard(feed, kind, now) {
    const title = kind === "codex" ? "Codex pool" : "Claude pool";
    const nowMs = now.getTime();
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
    const pool = base && poolModel(feed, kind, nowMs, { back: (nowMs - from) / DAY });
    if (!pool) return card(`pool t3plus-w-${kind}`, title, "gauge", null, [empty(feed ? "No limits reported." : "Waiting for the home feed…")]);
    const color = POOL_COLORS[kind];
    const W = 300;
    const H = 72;
    const span = Math.max(1, pool.now - pool.from);
    const x = (t) => ((t - pool.from) / span) * W;
    const y = (v) => H - 1 - (Math.max(0, Math.min(pool.cap, v)) / pool.cap) * (H - 8);
    // A single sample (a pool just started being recorded) still shows as a short level line.
    const recorded = pool.recorded.length > 1 ? pool.recorded : [{ t: pool.now - span * 0.02, left: pool.left }, { t: pool.now, left: pool.left }];
    // The week's first sample comes some minutes after its reset (the weekly one, or one
    // used early): a plot starting before that sample (at the reset, the first two hours)
    // left the plot empty up to it, and the line began partway across. When that sample
    // is close to the reset, the line is drawn from the plot's start at its level. A week
    // first recorded hours in (T3 was closed) is not filled in: that part is unknown.
    // Hovers and keys stay on the recorded samples.
    const weekFromReset = firstSample !== undefined && firstSample - weekStart <= 30 * 60000;
    const drawn = weekFromReset && recorded[0].t > pool.from ? [{ t: pool.from, left: recorded[0].left }, ...recorded] : recorded;
    const svg = svgEl("svg", { viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: "none", class: "t3plus-w-plot-svg", "data-t3plus-dither-chart": "area", "aria-hidden": "true" });
    svg.style.setProperty("--pool-color", color);
    svg.append(svgEl("path", { d: `M0 ${y(pool.cap / 2)}H${W}`, class: "t3plus-w-grid" }));
    // The baseline on its own: opaque on light pages, where the gridlines are see-through (content.css).
    svg.append(svgEl("path", { d: `M0 ${H - 0.5}H${W}`, class: "t3plus-w-grid t3plus-w-base" }));
    const line = (points) => points.map((p, i) => `${i ? "L" : "M"}${x(p.t).toFixed(1)} ${y(p.left).toFixed(1)}`).join("");
    const area = (points) => `${line(points)}L${x(points.at(-1).t).toFixed(1)} ${H}L${x(points[0].t).toFixed(1)} ${H}Z`;
    svg.append(svgEl("path", { d: area(drawn), class: "t3plus-w-area" }));
    svg.append(svgEl("path", { d: line(drawn), class: "t3plus-w-line", "vector-effect": "non-scaling-stroke" }));

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
    for (const d = first; d.getTime() < pool.now; tickStep === DAY ? d.setDate(d.getDate() + 1) : d.setHours(d.getHours() + tickStep / HOUR)) {
      const t = d.getTime();
      if (x(t) < 14 || x(t) > W - 14) continue;
      const text = tickStep === DAY ? DAYS[d.getDay()] : d.toLocaleTimeString("en-US", { hour: "numeric" }).replace(":00", "");
      ticks.push(h("span", { style: `left:${pct(t)}`, text }));
    }
    const frac = (points) => points.map((p) => [x(p.t) / W, y(p.left) / H]);
    const poolDither = dither([{ points: frac(drawn), color, fillAlpha: 0.85 }]);
    const poolPlot = h("div", chartAttrs(`pool-${kind}`, `${title}: ${formatPercent(pool.left)} remaining of ${formatPercent(pool.cap)} this week`, { class: "t3plus-w-plot" }), [poolDither, svg]);
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
    // Two plain lines: what is left, and when it resets.
    // A pool of several accounts is larger than 100%: say what it is out of.
    const remaining = Math.round(pool.cap) === 100 ? "remaining" : `remaining of ${formatPercent(pool.cap)}`;
    // Old data says so: when the feed stops updating (T3's CLI or API broke), the
    // percentage would otherwise read as current for days.
    const age = feed.generatedAt ? nowMs - Date.parse(feed.generatedAt) : 0;
    const stale = age > HOUR ? h("div", { class: "t3plus-w-stale", text: `Updated ${age >= 2 * DAY ? `${Math.floor(age / DAY)} days` : age >= DAY ? "1 day" : `${Math.floor(age / HOUR)} h`} ago` }) : null;
    return card(`pool t3plus-w-${kind}`, title, "gauge", null /* the corner stays empty */, [
      h("div", { class: "t3plus-w-pool-head" }, [
        h("span", { class: "t3plus-w-big-num", text: formatPercent(pool.left) }),
        h("span", { class: "t3plus-w-muted", text: remaining }),
      ]),
      pool.nextRefill ? h("div", { class: "t3plus-w-reset", text: `Reset - ${fmtReset(pool.nextRefill.at, pool.now)}` }) : null,
      stale,
      poolPlot,
      h("div", { class: "t3plus-w-axis" }, ticks),
    ]);
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
    // A provider that reports no limits (not connected) gives its place to the other pool.
    const reported = ["codex", "claude"].filter((kind) => hasPool(model.feed, kind));
    const pools = (reported.length === 1 ? reported : ["codex", "claude"]).map((kind) => poolCard(model.feed, kind, now));
    if (pools.length === 1) pools[0].classList.add("t3plus-w-wide");
    element.replaceChildren(...pools, activityCard(model.feed, now), usageCard(model.feed, now));
  }

  return {
    element,
    /** @param {{ feed, now?: Date, cell?: number }} model  cell: the dither cell size in CSS px (the backdrop's) */
    update(model) {
      const now = model.now ?? new Date();
      cell = model.cell ?? cell;
      // The cards are rebuilt when the feed changes, and otherwise every five minutes:
      // on a week-long axis the "now" line moves a hair in that time. A feed without a
      // generatedAt is still a feed: signed as none, it left "Waiting for the home feed…" up.
      const minute = Math.floor(now.getTime() / 300000);
      const fed = model.feed ? (model.feed.generatedAt ?? "feed") : null;
      const next = JSON.stringify([fed, model.kind ?? null, minute, model.spend ?? null]);
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
