import { T3_SELECTORS, T3PLUS } from "./config.js";

// ---------- The look: values that differ by profile ----------
// The open profile's glow, glass and bubble values (and its sky, profiles.js) are written
// where content.css reads them: one t3+-owned stylesheet, a rule for each set of elements
// that uses them. As custom properties on <html> they were inherited by every element, so
// each switch between two profiles that differ restyled the whole page (12-17 ms in a
// long thread); a changed rule restyles only the elements it names. Its rules match
// elements T3 remounts on their first paint, as <html>'s values did. A constructed sheet,
// which no page CSP can block (a <style> where a document cannot adopt one, as in jsdom).

/** The elements each set of look values is read on (content.css). */
export const LOOK = Object.freeze({
  /** The pane's glow, and Settings' preview of it. */
  glow: `${T3_SELECTORS.conversationArea}::before, [${T3PLUS.backdropHostAttr}]::before, .t3plus-preview-pane::before`,
  /** The Profiles preview's glow: its own accent (appearancePanel.js), this look's strength. */
  profilePreview: ".t3plus-pp-pane::before",
  /** Glass: T3's composer shell, a fallback card, the preview's card. */
  glass: `${T3_SELECTORS.composerShell}, ${T3_SELECTORS.composerSurface}, [${T3PLUS.surfaceAttr}], .t3plus-preview-card`,
  /** The home widgets' pixel cells. */
  cells: ".t3plus-w-cell",
  /** Your messages' bubbles, and the preview's. */
  bubble: `${T3_SELECTORS.userBubble}, .t3plus-preview-user`,
  /** A profile's editor: what its "Default" glow and bubble swatches show. */
  editor: ".t3plus-profile-editor",
  /** T3's night sky at the top of the sidebar. */
  sky: T3_SELECTORS.skyBackdrop,
});

const looks = new WeakMap(); // document -> { sheet, style, rules: Map<selector, rule>, values: Map<selector, Map<name, value>> }

/** The document's look sheet, attached (made when `create`; else null while there is none). */
function lookOf(doc, create = true) {
  let look = looks.get(doc);
  if (!look) {
    if (!create) return null;
    look = { sheet: null, style: null, rules: new Map(), values: new Map() };
    looks.set(doc, look);
  }
  if (!look.style && adopt(doc, look)) return look;
  if (!look.style?.isConnected) {
    look.style = doc.createElement("style");
    look.style.setAttribute(T3PLUS.ownedAttr, "");
    (doc.head ?? doc.documentElement).append(look.style);
    // A <style> (put back) has a new, empty sheet: its rules are made again.
    look.sheet = look.style.sheet;
    look.rules.clear();
    for (const [selector, values] of look.values) for (const [name, value] of values) ruleOf(look, selector).style.setProperty(name, value);
  }
  return look;
}

/** Puts the look sheet among the document's adopted ones (false where it cannot be). */
function adopt(doc, look) {
  const win = doc.defaultView;
  if (!("adoptedStyleSheets" in doc) || !win?.CSSStyleSheet) return false;
  try {
    look.sheet ??= new win.CSSStyleSheet();
    if (!doc.adoptedStyleSheets.includes(look.sheet)) doc.adoptedStyleSheets = [...doc.adoptedStyleSheets, look.sheet];
    return true;
  } catch {
    look.sheet = null; // not adopted: a <style> instead
    look.rules.clear();
    return false;
  }
}

function ruleOf(look, selector) {
  let rule = look.rules.get(selector);
  if (!rule) {
    rule = look.sheet.cssRules[look.sheet.insertRule(`${selector} {}`, look.sheet.cssRules.length)];
    look.rules.set(selector, rule);
  }
  return rule;
}

/**
 * Sets custom properties ({ name: value }, null removes one) on the elements `selector`
 * (a LOOK value) names. Only changed values are written: an unchanged one restyles nothing.
 */
export function setLook(doc, selector, values) {
  const entries = Object.entries(values);
  const look = lookOf(doc, entries.some(([, value]) => value !== null));
  if (!look) return;
  let own = look.values.get(selector);
  for (const [name, value] of entries) {
    if ((own?.get(name) ?? null) === value) continue;
    if (!own) look.values.set(selector, (own = new Map()));
    if (value === null) {
      own.delete(name);
      ruleOf(look, selector).style.removeProperty(name);
    } else {
      own.set(name, value);
      ruleOf(look, selector).style.setProperty(name, value);
    }
  }
}

/** A look value as the page has it ("" when unset). */
export function lookValue(doc, selector, name) {
  return looks.get(doc)?.rules.get(selector)?.style.getPropertyValue(name) ?? "";
}

/** t3+ stopped: its look sheet goes, and every value in it. */
export function dropLook(doc) {
  const look = looks.get(doc);
  if (!look) return;
  looks.delete(doc);
  if (look.style) look.style.remove();
  else if (look.sheet && doc.adoptedStyleSheets?.includes(look.sheet)) doc.adoptedStyleSheets = doc.adoptedStyleSheets.filter((sheet) => sheet !== look.sheet);
}

// Where content.css reads each theme value (gradient.js computeComposerTheme).
const THEME_LOOKS = [
  [LOOK.glow, ["--t3plus-accent", "--t3plus-core", "--t3plus-halo", "--t3plus-fade", "--t3plus-scrim-top", "--t3plus-scrim-bottom", "--t3plus-image"]],
  [LOOK.profilePreview, ["--t3plus-core", "--t3plus-halo", "--t3plus-fade"]],
  [LOOK.glass, ["--t3plus-glass-opacity", "--t3plus-glass-blur"]],
  [LOOK.cells, ["--t3plus-dither-cell"]],
];
// The dither tile every pixel surface layers in is the same in every look: on <html>.
const TILE = "--t3plus-dither";

/**
 * Writes the theme: its on/off attributes and the dither tile on <html>, its values in
 * the look sheet. The backdrop and glass rules in content.css key off these, so React
 * remounting the composer or conversation needs no JS: the new elements match the same
 * selectors on their first paint.
 */
export function applyComposerTheme(doc, theme) {
  const root = doc.documentElement;
  const tile = theme.vars[TILE];
  if (tile === null) root.style.removeProperty(TILE);
  else if (tile !== undefined && root.style.getPropertyValue(TILE) !== tile) root.style.setProperty(TILE, tile);
  for (const [selector, names] of THEME_LOOKS) {
    setLook(doc, selector, Object.fromEntries(names.filter((name) => Object.hasOwn(theme.vars, name)).map((name) => [name, theme.vars[name]])));
  }
  if (theme.mode) {
    if (root.getAttribute(T3PLUS.modeAttr) !== theme.mode) root.setAttribute(T3PLUS.modeAttr, theme.mode);
  } else root.removeAttribute(T3PLUS.modeAttr);
  root.toggleAttribute(T3PLUS.glassAttr, Boolean(theme.glass));
}

/**
 * Fallback for a T3 build that drops data-chat-composer-surface but keeps the
 * body hook: tags the body's parent so content.css can still give that card
 * its glass. Idempotent and cheap; the DOM watcher calls it after mutations.
 *
 * @returns {{ tagged: number, orphanEditors: number }}
 *   orphanEditors counts chat composer editors with neither hook above them,
 *   meaning the selectors in config.js need updating (0 unless `countOrphans`: the
 *   app asks until it has said so once). Only editors in T3's chat composer area
 *   count: T3 reuses the same editor elsewhere (for example the font preview on
 *   Settings > Appearance), and those are not chat composers.
 */
export function syncComposerSurfaces(doc, enabled, { countOrphans = true } = {}) {
  const tagged = doc.querySelectorAll(`[${T3PLUS.surfaceAttr}]`);
  if (!enabled) {
    for (const el of tagged) el.removeAttribute(T3PLUS.surfaceAttr);
    return { tagged: 0, orphanEditors: 0 };
  }

  const wanted = new Set();
  for (const body of doc.querySelectorAll(T3_SELECTORS.composerBody)) {
    if (body.closest(T3_SELECTORS.composerSurface)) continue;
    if (body.parentElement) wanted.add(body.parentElement);
  }
  for (const el of tagged) {
    if (!wanted.has(el)) el.removeAttribute(T3PLUS.surfaceAttr);
  }
  for (const el of wanted) {
    if (!el.hasAttribute(T3PLUS.surfaceAttr)) el.setAttribute(T3PLUS.surfaceAttr, "");
  }

  let orphanEditors = 0;
  for (const editor of countOrphans ? doc.querySelectorAll(T3_SELECTORS.composerEditor) : []) {
    if (!editor.closest(T3_SELECTORS.chatComposerArea)) continue;
    if (!editor.closest(`${T3_SELECTORS.composerSurface}, ${T3_SELECTORS.composerBody}`)) orphanEditors += 1;
  }
  return { tagged: wanted.size, orphanEditors };
}

/**
 * Fallback for a T3 build without data-workspace-area="conversation": tags the
 * composer overlay's parent as the backdrop host. Cheaper than a CSS :has()
 * rule, which would be re-evaluated on every streaming mutation.
 * @returns {number} hosts tagged
 */
export function syncBackdropHosts(doc, enabled) {
  const tagged = doc.querySelectorAll(`[${T3PLUS.backdropHostAttr}]`);
  const wanted = new Set();
  if (enabled && !doc.querySelector(T3_SELECTORS.conversationArea)) {
    for (const overlay of doc.querySelectorAll(T3_SELECTORS.composerOverlay)) {
      if (overlay.parentElement) wanted.add(overlay.parentElement);
    }
  }
  for (const el of tagged) if (!wanted.has(el)) el.removeAttribute(T3PLUS.backdropHostAttr);
  for (const el of wanted) if (!el.hasAttribute(T3PLUS.backdropHostAttr)) el.setAttribute(T3PLUS.backdropHostAttr, "");
  return wanted.size;
}

/**
 * Where the composer card sits across the backdrop host (the pane, found when not
 * given): { host, hostRect, composer, percent } (percent 0..100, the card's center),
 * or null while there is no laid-out card. The composer's center keeps the glow behind
 * it when the details rail changes the pane's geometry.
 */
export function measureBackdropAnchor(doc, host = doc.querySelector(T3_SELECTORS.conversationArea) ?? doc.querySelector(`[${T3PLUS.backdropHostAttr}]`)) {
  if (!host || typeof host.getBoundingClientRect !== "function") return null;
  const hostRect = host.getBoundingClientRect();
  if (hostRect.width < 1) return null;
  const composer = findComposerCard(doc, hostRect);
  if (!composer) return null;
  const center = ((composer.left + composer.width / 2 - hostRect.left) / hostRect.width) * 100;
  return { host, hostRect, composer, percent: Math.max(0, Math.min(100, center)) };
}

/**
 * The rect of the composer card that sits over the painted pane. In T3 the
 * composer overlay is a SIBLING of the conversation area (ChatView.tsx), so it
 * is searched document-wide: the card (surface, else shell, else body) that is
 * laid out and overlaps the pane horizontally the most. A stale composer from
 * the previous thread, or one still mounting, never wins.
 */
function findComposerCard(doc, hostRect) {
  const minWidth = Math.min(240, hostRect.width * 0.25);
  for (const selector of [T3_SELECTORS.composerSurface, T3_SELECTORS.composerShell, T3_SELECTORS.composerBody]) {
    let best = null;
    let bestOverlap = 0;
    for (const el of doc.querySelectorAll(selector)) {
      if (!el.isConnected || typeof el.getBoundingClientRect !== "function") continue;
      const r = el.getBoundingClientRect();
      if (r.width < minWidth) continue;
      const overlap = Math.min(r.left + r.width, hostRect.left + hostRect.width) - Math.max(r.left, hostRect.left);
      if (overlap > bestOverlap) {
        best = r;
        bestOverlap = overlap;
      }
    }
    if (best) return best;
  }
  return null;
}

/** Composer cards content.css can make glass. Exported so tests can assert remounted nodes match it. */
export const PAINTED_SURFACE_SELECTOR = `${T3_SELECTORS.composerSurface}, [${T3PLUS.surfaceAttr}]`;

/** Elements content.css paints the backdrop layer on (mirrors content.css). */
export const BACKDROP_HOST_SELECTOR = `${T3_SELECTORS.conversationArea}, [${T3PLUS.backdropHostAttr}]`;
