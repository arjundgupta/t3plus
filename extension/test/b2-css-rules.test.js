import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { after, test } from "node:test";
import { JSDOM } from "jsdom";
import { createAppearancePanel } from "../src/appearancePanel.js";
import { DEFAULT_SETTINGS } from "../src/config.js";
import { createStatusView } from "../src/statusView.js";

// content.css read as a cascade: which rule wins, under which @media, and over which of
// t3+'s own elements (jsdom matches the selectors against the real DOM; it does not paint).

const css = readFileSync(new URL("../src/styles/content.css", import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

/** Style rules in file order, each with the at-rules around it (@media, @supports, @container). */
function parseRules(text) {
  const rules = [];
  const context = [];
  let i = 0;
  while (i < text.length) {
    const open = text.indexOf("{", i);
    const close = text.indexOf("}", i);
    if (close !== -1 && (open === -1 || close < open)) {
      context.pop();
      i = close + 1;
      continue;
    }
    if (open === -1) break;
    const prelude = text.slice(i, open).trim();
    if (/^@(media|supports|container)\b/.test(prelude)) {
      context.push(prelude);
      i = open + 1;
      continue;
    }
    const end = text.indexOf("}", open);
    // @property and the like hold descriptors, not declarations.
    if (!prelude.startsWith("@")) rules.push({ sel: prelude, body: text.slice(open + 1, end), context: [...context], at: rules.length });
    i = end + 1;
  }
  return rules;
}
const RULES = parseRules(css);
const inMedia = (rule, pattern) => rule.context.some((c) => pattern.test(c));
const TOP = RULES.filter((r) => r.context.length === 0);

/** Index just past the bracket or parenthesis that closes the one at `open`. */
function closing(text, open) {
  const pairs = { "(": ")", "[": "]" };
  const expected = [pairs[text[open]]];
  let i = open + 1;
  while (expected.length) {
    const ch = text[i];
    if (ch === "\\") i += 2;
    else if (ch === '"' || ch === "'") i = text.indexOf(ch, i + 1) + 1;
    else {
      if (ch in pairs) expected.push(pairs[ch]);
      else if (ch === expected.at(-1)) expected.pop();
      i += 1;
    }
  }
  return i;
}

/** A selector list's selectors (commas inside :is(), :not() or an attribute stay put). */
function splitSelectors(list) {
  const out = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < list.length; i += 1) {
    const ch = list[i];
    if (ch === "\\") i += 1;
    else if (ch === "(" || ch === "[") depth += 1;
    else if (ch === ")" || ch === "]") depth -= 1;
    else if (ch === "," && depth === 0) {
      out.push(list.slice(start, i).trim());
      start = i + 1;
    }
  }
  out.push(list.slice(start).trim());
  return out;
}

const IDENT = /^(?:\\.|[\w-])+/;
const compare = (x, y) => x[0] - y[0] || x[1] - y[1] || x[2] - y[2];
/** [ids, classes, types] of one selector: :where() weighs nothing, :is()/:not()/:has() their heaviest argument. */
function specificity(selector) {
  const total = [0, 0, 0];
  const add = (weight) => weight.forEach((n, k) => (total[k] += n));
  let i = 0;
  while (i < selector.length) {
    const ch = selector[i];
    if (ch === "#" || ch === ".") {
      add(ch === "#" ? [1, 0, 0] : [0, 1, 0]);
      i += 1 + selector.slice(i + 1).match(IDENT)[0].length;
    } else if (ch === "[") {
      add([0, 1, 0]);
      i = closing(selector, i);
    } else if (ch === ":") {
      const element = selector[i + 1] === ":";
      const start = i + (element ? 2 : 1);
      const name = selector.slice(start).match(IDENT)[0];
      i = start + name.length;
      let args = "";
      if (selector[i] === "(") {
        const end = closing(selector, i);
        args = selector.slice(i + 1, end - 1);
        i = end;
      }
      if (element) add([0, 0, 1]);
      else if (["is", "not", "has"].includes(name)) add(splitSelectors(args).map(specificity).reduce((a, b) => (compare(a, b) >= 0 ? a : b)));
      else if (name !== "where") add([0, 1, 0]);
    } else if (/[a-z]/i.test(ch)) {
      add([0, 0, 1]);
      i += selector.slice(i).match(IDENT)[0].length;
    } else i += 1; // combinators, whitespace, *
  }
  return total;
}

/** The last top-level rule whose selector list is exactly `selector`. */
const topRule = (selector) => {
  const rule = TOP.findLast((r) => r.sel === selector);
  assert.ok(rule, `no rule for ${selector}`);
  return rule.body;
};
const rem = (body, prop) => Number(body.match(new RegExp(`(?:^|[;\\s])${prop}:\\s*(-?[\\d.]+)rem`))[1]);

const windows = [];
after(() => windows.forEach((w) => w.close()));
function createDoc() {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", { pretendToBeVisual: true });
  windows.push(dom.window);
  return dom.window.document;
}
/** The real Settings panel, updated with `settings`. */
function createPanel(doc, settings = structuredClone(DEFAULT_SETTINGS)) {
  const actions = new Proxy({}, { get: () => () => undefined });
  const panel = createAppearancePanel(doc, actions);
  doc.body.append(panel.element);
  const show = (s) => panel.update({ settings: s, image: null, imageUrl: "", message: "", bots: [], botMarker: "🤖", health: [], profiles: null, profileAccents: {} });
  show(settings);
  return { panel, show };
}
/** The real Status view: a group of needs-you rows (the open one first) and a folded group. */
function createView(doc) {
  const view = createStatusView(doc, { onOpen() {}, onCollapse() {}, avatar() {} });
  doc.body.append(view.element);
  const row = (key, status, extra = {}) => ({ key, title: key, status, at: 0, folderKey: null, project: "", current: false, ...extra });
  view.update({ groups: [{ id: "needs", label: "Needs you", rows: [row("t1", "approval", { current: true })] }, { id: "working", label: "Working", rows: [row("t2", "working")] }], collapsed: { working: true }, now: 0 });
  return view;
}

test("the specificity reader weighs :where() as nothing and :has() as its argument", () => {
  assert.deepEqual(specificity("[data-t3plus-bot]:has([data-t3plus-bot-title].text-foreground\\/75) [data-t3plus-bot-top]::before"), [0, 4, 1]);
  assert.deepEqual(specificity("[data-t3plus-bot]:where(:has([data-t3plus-bot-title].font-normal)) [data-t3plus-bot-top]::before"), [0, 2, 1]);
  assert.deepEqual(specificity('html:not(.dark) .t3plus-status-row:is([data-status="a"], [data-status="b"])'), [0, 3, 1]);
});

test("a seen bot's name brightens on hover, keyboard focus and when open, as T3's title does: that rule outranks every color the title's classes give it", () => {
  const names = TOP.filter((r) => /(?:^|[;\s])color:/.test(r.body)).flatMap((r) => splitSelectors(r.sel).filter((sel) => sel.endsWith("[data-t3plus-bot-top]::before")).map((sel) => ({ sel, at: r.at })));
  const lit = names.find(({ sel }) => /:is\([^)]*:hover/.test(sel));
  assert.ok(lit, "the full-strength rule");
  // A settled row dims only while it is neither hovered nor focused: never at the same time.
  const rivals = names.filter((r) => r !== lit && !r.sel.includes(":not(:hover)"));
  assert.ok(rivals.length >= 5, "the name's colors for T3's title states");
  for (const rival of rivals) {
    const wins = compare(specificity(lit.sel), specificity(rival.sel)) || lit.at - rival.at;
    assert.ok(wins > 0, `${lit.sel} wins over ${rival.sel}`);
  }
});

test("no ring around any face: no ring rule or variable, a face is one picture in its own clip, and in forced colors a shape in the highlight color", () => {
  assert.doesNotMatch(css, /data-t3plus-ring|--t3plus-ring|--t3plus-bot-ring/, "nothing of Status colors' rings is left");
  const faces = [".t3plus-bot-face", "[data-t3plus-bot-breadcrumb]::before", "[data-t3plus-bot-hover]::before"];
  const drawing = TOP.findLast((r) => faces.every((sel) => splitSelectors(r.sel).includes(sel)));
  assert.match(drawing.body, /clip-path:\s*var\(--t3plus-bot-clip, circle\(50% at 50% 50%\)\);/, "each in its own shape's clip");
  assert.match(drawing.body, /background-color:\s*var\(--t3plus-bot-edge, var\(--primary, #6d7cff\)\);/, "its edge color behind it, as before");
  assert.doesNotMatch(drawing.body, /box-shadow|padding/, "no inset, nothing around it");
  assert.match(topRule(".t3plus-bot-face"), /background-image:\s*inherit;/, "the picture as its avatar holds it");
  assert.ok(!RULES.some((r) => splitSelectors(r.sel).some((sel) => /\.t3plus-bot-face::before|\.t3plus-(bot-sub|face-icon)[^,]*::before/.test(sel) && sel !== ".t3plus-bot-sub::before")), "no face drawn inside another");

  // Forced colors: a row's face and the breadcrumb's stay shapes in the highlight color.
  const forced = RULES.find((r) => inMedia(r, /forced-colors:\s*active/) && splitSelectors(r.sel).includes(".t3plus-bot-face"));
  assert.ok(splitSelectors(forced.sel).includes("[data-t3plus-bot-breadcrumb]::before"));
  assert.match(forced.body, /background:\s*Highlight/);
});

test("the Status view's traffic light is set on each group, so a heading and its rows share it (light-theme shades included)", () => {
  const tokens = (body) => ["needs", "running"].map((name) => body.match(new RegExp(`--t3plus-status-${name}:\\s*([^;]+);`))?.[1]);
  assert.deepEqual(tokens(topRule(".t3plus-status-group")), ["#fb923c", "#facc15"]);
  assert.deepEqual(tokens(topRule("html:not(.dark) .t3plus-status-group")), ["#9a3412", "#854d0e"], "readable on a light sidebar (4.5:1 or better)");
  assert.match(topRule('.t3plus-status-group[data-group="needs"] .t3plus-status-label'), /color:\s*var\(--t3plus-status-needs\)/, "the heading in its rows' orange, not T3's amber");
  const rowRule = (status) => TOP.find((r) => r.sel.startsWith(".t3plus-status-row") && r.sel.includes(`[data-status="${status}"]`)).body;
  assert.match(rowRule("approval"), /--t3plus-status-color:\s*var\(--t3plus-status-needs\)/);
  assert.match(rowRule("working"), /--t3plus-status-color:\s*var\(--t3plus-status-running\)/);
  // In the view, the group holds both its heading and its rows.
  const doc = createDoc();
  createView(doc);
  const group = doc.querySelector('.t3plus-status-group[data-group="needs"]');
  assert.ok(group.querySelector(".t3plus-status-label") && group.querySelector('.t3plus-status-row[data-status="approval"]'));
});

test("a finished subagent's face is dimmed", () => {
  assert.ok(Number(topRule(".t3plus-bot-sub[data-done]").match(/opacity:\s*([\d.]+)/)[1]) < 1);
});

test("an element t3+ hides stays hidden whatever display its class gives it, with or without the page's own reset", () => {
  const guard = TOP.find((r) => /display:\s*none !important/.test(r.body) && splitSelectors(r.sel).includes(".t3plus-section [hidden]"));
  assert.ok(guard, "one rule for t3+'s own hidden elements");
  const doc = createDoc();
  createPanel(doc);
  createView(doc);
  doc.querySelector(".t3plus-scope-clear").hidden = true; // nothing of the profile's own to clear
  const hidden = [...doc.querySelectorAll("[hidden]")];
  // Among them, ones whose class gives them a display: a row's reset (inline-grid), the
  // scope's Clear (a button's inline-flex), a folded Status group's list (flex).
  for (const shown of [".t3plus-row-reset", ".t3plus-scope-clear", ".t3plus-status-list"]) assert.ok(hidden.some((el) => el.matches(shown)), shown);
  for (const el of hidden) assert.ok(el.matches(guard.sel), `${el.className} stays hidden`);
});

test("rows are divided below a shown row only: with Pixel size hidden (the Smooth look), no line runs along the Advanced card's top", () => {
  const divider = TOP.find((r) => /border-top:/.test(r.body) && /\.t3plus-row\b.*\.t3plus-row$/.test(r.sel));
  assert.ok(divider);
  const doc = createDoc();
  const settings = structuredClone(DEFAULT_SETTINGS);
  settings.composerGradient.dither = false;
  const { show } = createPanel(doc, settings);
  const [pixelSize, glass, ...rest] = doc.querySelector(".t3plus-advanced .t3plus-card").children;
  assert.equal(pixelSize.hidden, true, "Pixel size is for the pixel look only");
  assert.equal(glass.matches(divider.sel), false, "the first shown row has no line above it");
  assert.ok(rest.length > 0 && rest.every((row) => row.matches(divider.sel)), "the rows below it do");
  settings.composerGradient.dither = true;
  show(settings);
  assert.equal(glass.matches(divider.sel), true, "below a shown Pixel size, it does");
});

test("every class content.css styles is one t3+'s code puts on an element (no rules for what nothing renders)", () => {
  const walk = (dir) =>
    readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(new URL(`${e.name}/`, dir)) : e.name.endsWith(".js") ? [readFileSync(new URL(e.name, dir), "utf8")] : []));
  const js = walk(new URL("../src/", import.meta.url)).join("\n");
  const classes = [...new Set([...css.matchAll(/\.(t3plus-[\w-]+)/g)].map((m) => m[1]))];
  assert.ok(classes.length > 100);
  assert.deepEqual(classes.filter((name) => !new RegExp(`(?<![\\w-])${name}(?![\\w-])`).test(js)), []);
});

test("every transition stops under prefers-reduced-motion", () => {
  const reduced = /prefers-reduced-motion:\s*reduce/;
  const still = new Set(RULES.filter((r) => inMedia(r, reduced) && /transition:\s*none/.test(r.body)).flatMap((r) => splitSelectors(r.sel)));
  const moving = RULES.filter((r) => !inMedia(r, reduced) && /(?:^|[;\s])transition:(?!\s*none)/.test(r.body)).flatMap((r) => splitSelectors(r.sel));
  assert.ok(moving.includes(".t3plus-advanced-summary::before") && moving.includes("html[data-t3plus-sky-ready] .sidebar-stage-backdrop"));
  assert.deepEqual(moving.filter((sel) => !still.has(sel)), []);
});

test("forced colors: the profile dots and '+', the status dots and every pressed, picked or active mark stay visible", () => {
  const forced = RULES.filter((r) => inMedia(r, /forced-colors:\s*active/));
  const declares = (selector, pattern) => forced.some((r) => splitSelectors(r.sel).includes(selector) && pattern.test(r.body));
  // Dots drawn with a background alone (forced colors drop it): a system color instead.
  for (const dot of [".t3plus-profile-dot::before", ".t3plus-profile-dot:hover::before", ".t3plus-pp-dot", ".t3plus-status-dot::before"]) assert.ok(declares(dot, /background:\s*(ButtonText|CanvasText);/), dot);
  for (const on of ['.t3plus-profile-dot[aria-pressed="true"]::before', ".t3plus-pp-dot[data-on]"]) assert.ok(declares(on, /background:\s*Highlight;/), on);
  // The "+" is two gradients, which forced colors drop unless told not to.
  for (const add of [".t3plus-profile-add::before", ".t3plus-profile-add:hover::before"]) assert.ok(declares(add, /forced-color-adjust:\s*none;[\s\S]*linear-gradient\(ButtonText, ButtonText\)/), add);
  // Swatches and a profile's color show their colors on purpose.
  for (const swatch of [".t3plus-profile-swatch::before", ".t3plus-pp-swatch::before", ".t3plus-pp-chip::before"]) assert.ok(declares(swatch, /forced-color-adjust:\s*none;/), swatch);
  // Pressed, picked or current: outlined, and the focus ring keeps its place on a focused one.
  const focusable = ['.t3plus-button[aria-pressed="true"]', '.t3plus-bot-pick[aria-selected="true"]', '.t3plus-swatch[aria-pressed="true"]', '.t3plus-profile-icon-pick[aria-checked="true"]', '.t3plus-profile-tab[aria-pressed="true"]', '.t3plus-profile-editor .t3plus-profile-swatch[aria-checked="true"]', '.t3plus-pp-chip[aria-checked="true"]', '.t3plus-pp-icon[aria-checked="true"]', '.t3plus-pp-swatch[aria-checked="true"]', '.t3plus-status-toggle[aria-pressed="true"]', '.t3plus-status-row[aria-current="page"]'];
  for (const mark of focusable) assert.ok(declares(`${mark}:not(:focus-visible)`, /outline:\s*2px solid Highlight;/), mark);
  // The picker's active option: the list keeps the focus, the arrow keys move this.
  assert.ok(declares(".t3plus-scope-option[data-active]", /outline:\s*2px solid Highlight;/));
  assert.ok(declares(".t3plus-row[data-scope-own]", /border-inline-start:\s*2px solid Highlight;/), "a setting of the scope's own");
});

test("profile dots: small to see, but each takes the pointer over the bar's height and up to the next dot; dragging a folder, its chips are the targets", () => {
  const dot = topRule(".t3plus-profile-dot");
  const [vertical, horizontal] = topRule(".t3plus-profile-dot::after").match(/inset:\s*(-[\d.]+)rem (-[\d.]+)rem;/).slice(1).map(Number);
  assert.equal(rem(dot, "height") - 2 * vertical, 1.5, "24px tall: the bar's row (the Status button's height), so the bar does not grow");
  assert.equal(-2 * horizontal, rem(topRule(".t3plus-profiles-dots"), "gap"), "half the gap on each side: no dot's target over another's");
  assert.match(topRule("html[data-t3plus-profile-drag] .t3plus-profile-dot::before,\nhtml[data-t3plus-profile-drag] .t3plus-profile-dot::after"), /display:\s*none;/);
  assert.match(topRule("html[data-t3plus-profile-drag] .t3plus-profile-chip"), /display:\s*inline-flex;[\s\S]*align-items:\s*center;/, "a profile's icon beside its name");
  // "+" is faint until the pointer is near, and in full as a drop target.
  const faint = TOP.find((r) => /opacity:\s*0\.35/.test(r.body) && r.sel.includes(".t3plus-profile-add"));
  const doc = createDoc();
  doc.body.innerHTML = '<div class="t3plus-profiles"><div class="t3plus-profiles-dots"><button class="t3plus-profile-dot t3plus-profile-add"><span class="t3plus-profile-chip">New</span></button></div></div>';
  const add = doc.querySelector(".t3plus-profile-add");
  assert.equal(add.matches(faint.sel), true, "faint while the pointer is away");
  doc.documentElement.setAttribute("data-t3plus-profile-drag", "");
  assert.equal(add.matches(faint.sel), false, "in full while a folder is dragged");
});
