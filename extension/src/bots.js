import { botArt, botBadge, botClipPath, botEdgeColor, botShapeHasOwnColors, botStill, defaultBotColor, defaultBotShape, MOOD_BY_STATUS } from "./botArt.js";
import {
  BOT_COLORS,
  BOT_LIMITS,
  BOT_MARKER_PATTERN,
  BOT_SHAPES,
  BOT_SKINS,
  DEFAULT_BOT_MARKER,
  SAME_AS_BOT,
  SIDEBAR_ROW_PREFIX,
  STORAGE_KEYS,
  T3_CLASSES,
  T3_SELECTORS,
  T3PLUS,
} from "./config.js";
import { subscribeKey } from "./settings.js";
import { BOT_STATUS, isRowStatusWord, rowStatus, rowStatusWord } from "./statusView.js";
import { setSprite } from "./spriteClock.js";
import { setAttr, setVar } from "./dom.js";

// Bot/orchestrator threads: top-level thread rows whose title carries the
// exact marker token (default [[t3plus:bot:v1]]) as its first or last
// whitespace-separated word. No substring or zero-width matching. t3+ never
// renames, pins or reorders threads: the user applies the marker and T3's
// native pin through T3 itself.

/**
 * @returns {{ label: string } | null} label = the title without the marker token.
 */
export function parseBotTitle(title, marker = DEFAULT_BOT_MARKER) {
  if (typeof title !== "string" || !BOT_MARKER_PATTERN.test(marker)) return null;
  const words = title.trim().split(/\s+/);
  if (words[0] === marker) return { label: words.slice(1).join(" ") };
  if (words.length > 1 && words[words.length - 1] === marker) return { label: words.slice(0, -1).join(" ") };
  return null;
}

// T3's row aria-label is "<title>, <status label>, <project>"; its status word is read by
// statusView.js (rowStatusWord), and a face's status follows the view's (BOT_STATUS: a
// usage limit, a snoozed thread that woke and a question all want you).

/** working | waiting | attention | failed | done | idle, from the row's aria-label. */
export const parseRowStatus = (ariaLabel, title) => BOT_STATUS[rowStatus(ariaLabel, title)];

/** The project named at the end of a row's aria-label ("<title>, <status>, <project>"), or "". */
export function parseRowProject(ariaLabel, title) {
  if (typeof ariaLabel !== "string" || !title || !ariaLabel.startsWith(`${title}, `)) return "";
  const parts = ariaLabel.slice(title.length + 2).split(", ");
  if (isRowStatusWord(parts[0])) parts.shift();
  return parts.join(", ");
}

/** T3's own status word for the row ("Input", "Approval", "Working", ...), or "" when it shows none. */
export const parseRowStatusLabel = rowStatusWord;

/** Top-level: not nested under another thread (folder/shelf parents are fine). */
export function isTopLevelThread(thread) {
  const parent = thread.parent;
  return !parent || parent.startsWith(SIDEBAR_ROW_PREFIX.folder) || parent.startsWith(SIDEBAR_ROW_PREFIX.shelf);
}

/** Bots in a sidebar scan, with status and visible child count. */
export function classifyBots(scan, marker, manual = {}, byDefault = false) {
  const childCounts = new Map();
  for (const thread of scan.threads) {
    if (thread.parent) childCounts.set(thread.parent, (childCounts.get(thread.parent) ?? 0) + 1);
  }
  const bots = [];
  for (const thread of scan.threads) {
    if (!isTopLevelThread(thread)) continue;
    // A bot by its title marker, or by choice: every thread when bots are on by
    // default, unless turned off (Option-click), else only the ones turned on.
    // A chosen bot keeps its whole title as the name.
    const chosen = manual[thread.key] ?? byDefault;
    const parsed = parseBotTitle(thread.title, marker) ?? (chosen === true && thread.title ? { label: thread.title } : null);
    if (!parsed) continue;
    bots.push({
      key: thread.key,
      thread,
      titleLabel: parsed.label,
      status: parseRowStatus(thread.ariaLabel, thread.title),
      statusLabel: parseRowStatusLabel(thread.ariaLabel, thread.title),
      childCount: childCounts.get(thread.key) ?? 0,
    });
  }
  return bots;
}

// ---------- Per-bot presentation (local only) ----------
// Two choices per bot: a shape and a color. The color is "project" (the bot
// takes its project's badge color) unless the user picks one of the named ramps.

/** The color that follows the bot's project. */
export const PROJECT_COLOR = "project";

/** The shape nobody picked: each bot gets its own, stable one (botShapeFor). */
export const AUTO_SHAPE = "auto";

/**
 * { shape, color }: shape is a BOT_SHAPES name or AUTO_SHAPE; color is a
 * BOT_COLORS name or PROJECT_COLOR. The two "nothing picked" values are
 * resolved per bot when it is drawn.
 */
export function normalizeBotPrefs(raw) {
  const value = raw && typeof raw === "object" ? raw : {};
  return {
    shape: Object.hasOwn(BOT_SHAPES, value.shape) ? value.shape : AUTO_SHAPE,
    color: Object.hasOwn(BOT_COLORS, value.color) ? value.color : PROJECT_COLOR,
  };
}

/**
 * A bot's prefs as drawn. `statusColor`: the color of its status, where Status colors paint
 * it (the Status view only; null everywhere else): its own shape in that color (a ball,
 * planet or fruit keeps its own colors; its badge takes the status's). `badges` (Status
 * badges): with its badge. The sidebar, the Status view and the Settings preview all draw
 * through this, so they agree on what a status looks like. Neither: `prefs` itself.
 */
export function shownBotPrefs(prefs, { statusColor = null, badges = false } = {}) {
  const painted = statusColor ? { ...normalizeBotPrefs(prefs), color: statusColor, statusColors: true } : prefs;
  return badges ? { ...painted, badges: true } : painted;
}

/** The shape a bot is drawn in: its own pick, else a stable one from its key. */
export function botShapeFor(bot, prefs) {
  const p = normalizeBotPrefs(prefs);
  return p.shape === AUTO_SHAPE ? defaultBotShape(bot?.key ?? "") : p.shape;
}

/**
 * The color a bot is drawn in: its own pick, else its project's badge color
 * (`bot.projectColor`, a #rrggbb), else a stable one from its key (a thread
 * with no project).
 */
export function botPaintColor(bot, prefs) {
  const p = normalizeBotPrefs(prefs);
  if (p.color !== PROJECT_COLOR) return p.color;
  return bot?.projectColor ?? defaultBotColor(bot?.key ?? "");
}

/** How many per-thread bot choices are kept (on, or off while bots are on by default). */
const MANUAL_LIMIT = 200;
const BOT_KEY = /^[^:\s]+:\S+$/;

export function normalizeBotPrefsMap(raw) {
  const out = {};
  if (!raw || typeof raw !== "object") return out;
  for (const [key, value] of Object.entries(raw).slice(0, BOT_LIMITS.maxBots)) {
    if (BOT_KEY.test(key)) out[key] = normalizeBotPrefs(value);
  }
  return out;
}

/**
 * A title as the remembered-bots list keeps it (cut to a bounded length). What is
 * saved and what is compared against must both go through this: comparing the full
 * title with the stored, shortened one rewrote the list on every check.
 */
export const knownBotTitle = (title) => String(title ?? "").slice(0, 120);

/** Bots seen in the sidebar, as stored: { key: { title, seenAt, projectColor? } }, anything else dropped. */
export function normalizeKnownBots(raw) {
  const out = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  // A sanity bound only: rememberBots keeps every bot on screen (there can be more
  // than the list's cap); trimming here to the cap restarted its write loop.
  for (const [k, v] of Object.entries(raw).slice(0, 1000)) {
    if (v && typeof v === "object" && typeof v.title === "string") {
      out[k] = { title: knownBotTitle(v.title), seenAt: Number(v.seenAt) || 0 };
      if (typeof v.projectColor === "string" && /^#[0-9a-f]{6}$/i.test(v.projectColor)) out[k].projectColor = v.projectColor;
    }
  }
  return out;
}

/** Threads turned into bots (or out of them) by hand, as stored: { "<env>:<thread>": boolean }. */
export function normalizeManualBots(raw) {
  const out = {};
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    // true: a bot; false: turned off while bots are on by default.
    for (const k of Object.keys(raw).slice(0, MANUAL_LIMIT)) if (BOT_KEY.test(k) && typeof raw[k] === "boolean") out[k] = raw[k];
  }
  return out;
}

/** Stores bot presentation keyed by "<environmentId>:<threadId>". Never sent anywhere. */
export function createBotStore(area, changedEvent) {
  const key = STORAGE_KEYS.bots;
  const knownKey = STORAGE_KEYS.knownBots;
  const manualKey = STORAGE_KEYS.manualBots;
  const normalizeManual = normalizeManualBots;
  async function loadManual() {
    return normalizeManual((await area.get(manualKey))?.[manualKey]);
  }
  async function load() {
    return normalizeBotPrefsMap((await area.get(key))?.[key]);
  }
  // Every change reads, edits and writes a whole list. Run concurrently (two
  // quick Option-clicks), the second read the list from before the first was
  // written and one change was lost: they run one at a time.
  let queue = Promise.resolve();
  const serial = (fn) => {
    const run = queue.then(fn, fn);
    queue = run.catch(() => {});
    return run;
  };
  return {
    load,
    update: (botKey, patch) => serial(async () => {
      const all = await load();
      if (!all[botKey] && Object.keys(all).length >= BOT_LIMITS.maxBots) {
        throw new Error(`t3+ keeps settings for at most ${BOT_LIMITS.maxBots} bots. Forget one first.`);
      }
      all[botKey] = normalizeBotPrefs({ ...all[botKey], ...patch });
      await area.set({ [key]: all });
      return all;
    }),
    forget(botKey) {
      return serial(async () => {
        const all = await load();
        delete all[botKey];
        await area.set({ [key]: all });
        const known = await this.loadKnown();
        delete known[botKey];
        await area.set({ [knownKey]: known });
        return all;
      });
    },
    subscribe(listener) {
      return subscribeKey(changedEvent, key, (value) => listener(normalizeBotPrefsMap(value)));
    },
    /** Bots seen in the sidebar: { key: { title, seenAt } }. Lets Settings list them. */
    async loadKnown() {
      return normalizeKnownBots((await area.get(knownKey))?.[knownKey]);
    },
    async saveKnown(known) {
      await area.set({ [knownKey]: known });
    },
    loadManual,
    /** Makes a thread a bot or not (`on`; omitted: the opposite of now). A choice equal to the default is not stored. */
    toggleManual: (botKey, on, byDefault = false) => serial(async () => {
      const all = await loadManual();
      const next = on ?? !(all[botKey] ?? byDefault);
      if (next === byDefault) delete all[botKey];
      else {
        if (!Object.hasOwn(all, botKey) && Object.keys(all).length >= MANUAL_LIMIT) throw new Error(`t3+ keeps at most ${MANUAL_LIMIT} bot choices.`);
        all[botKey] = next;
      }
      await area.set({ [manualKey]: all });
      return all;
    }),
    subscribeManual(listener) {
      return subscribeKey(changedEvent, manualKey, (value) => listener(normalizeManual(value)));
    },
    subscribeKnown(listener) {
      // Normalized like loadKnown: an imported or hand-edited entry (null, say) broke the settings panel.
      return subscribeKey(changedEvent, knownKey, (value) => listener(normalizeKnownBots(value)));
    },
  };
}

/**
 * Display values for one bot: name, shape, color and the CSS values that draw
 * its avatar. The face follows bot.status (closed eyes when idle, animated
 * when working, ...); without a status it is the neutral open-eyed face.
 * `prefs.badges` (Status badges): a badge on the face for its status; none otherwise,
 * and none worked out. `prefs.statusColors`: the badge is drawn in the face's color.
 */
export function resolveBotPresentation(bot, prefs) {
  const p = normalizeBotPrefs(prefs);
  const paint = botPaintColor(bot, p);
  const shape = botShapeFor(bot, p);
  const mood = MOOD_BY_STATUS[bot.status] ?? "awake";
  const art = botArt(paint, shape, mood);
  return {
    label: bot.titleLabel || "Bot",
    shape,
    color: p.color,
    paint,
    mood,
    fill: art.url,
    frames: art.frames,
    duration: art.duration,
    clip: botClipPath(shape),
    edge: botEdgeColor(paint, shape),
    badge: faceBadge(bot, prefs, paint),
  };
}

/**
 * What the thread is doing, as a small tile on the face's corner: only with Status badges
 * on, and only for a real row (Settings swatches have no status). Under Status colors it
 * is given the face's color: its own tones (blue for working) read as another status there.
 */
function faceBadge(bot, prefs, paint) {
  if (prefs?.badges !== true || !bot.status) return null;
  return botBadge(bot.status, bot.statusLabel, prefs.statusColors === true ? paint : null);
}

// What a face was last drawn with, on each element: written again only when it changes.
// Every check re-applied every bot's face (six style reads, two of them data URLs of a
// few KB), also for the other profiles' hidden rows.
const applied = new WeakMap(); // element -> the view's fields as written (and t3+'s avatars: their face and badge children)
const AVATAR_FIELDS = ["fill", "clip", "edge", "frames", "duration", "shape", "mood", "badge"];
const sameFace = (was, view) => Boolean(was) && AVATAR_FIELDS.every((name) => was[name] === (view[name] ?? null));

// t3+'s own avatars (a sidebar row's, the Status view's, Settings') show the face and its
// badge on two children of their own, and the sprite clock steps those. The avatar holds
// the face's picture (its variables, and the sheet as an unpainted background: content.css)
// and the face child takes that picture as it is (inherit): a frame step restyles one
// small child and parses nothing. Stepped through var() on the avatar, every step of the
// face or its badge substituted and parsed the whole sheet again, tens of KB for a blob.
// T3's own elements (the breadcrumb, a hover card) keep theirs in ::before: t3+ adds no
// children to T3's elements.
const FACE_PART = "t3plus-bot-face";
const BADGE_PART = "t3plus-bot-badge";
const isPart = (el) => el.className === FACE_PART || el.className === BADGE_PART;

/** The avatar's face child, and its badge child while it has a badge: made or dropped to match. */
function avatarParts(el, badge) {
  const doc = el.ownerDocument;
  let face = el.firstElementChild;
  if (face?.className !== FACE_PART) {
    face = doc.createElement("span");
    face.className = FACE_PART;
    el.prepend(face);
  }
  let tile = face.nextElementSibling?.className === BADGE_PART ? face.nextElementSibling : null;
  if (badge && !tile) {
    tile = doc.createElement("span");
    tile.className = BADGE_PART;
    face.after(tile);
  } else if (!badge && tile) {
    setSprite(tile, null, null);
    tile.remove();
    tile = null;
  }
  return { face, tile };
}

/** Draws a bot's face on `el`, one of t3+'s own avatars: its variables and marks, and its children. */
export function applyAvatarVars(el, view) {
  paintFace(el, view, true);
}

/** Draws a face on `el`: one of t3+'s own avatars (`own`), else an element of T3's (its ::before). */
function paintFace(el, view, own) {
  const badge = view.badge ?? null;
  let drawn = applied.get(el);
  // Still as drawn: t3+'s avatar with its children in place, or an element of T3's still
  // wearing the variables (T3 could have rewritten its style since: one short read).
  const intact = own ? drawn?.face?.parentNode === el && (!drawn.tile || drawn.tile.parentNode === el) : el.style.getPropertyValue("--t3plus-bot-edge") !== "";
  if (!sameFace(drawn, view) || !intact) {
    drawn = Object.fromEntries(AVATAR_FIELDS.map((name) => [name, view[name] ?? null]));
    setVar(el, "--t3plus-bot-fill", view.fill);
    setVar(el, "--t3plus-bot-clip", view.clip);
    setVar(el, "--t3plus-bot-edge", view.edge);
    const animated = view.frames > 1;
    setVar(el, "--t3plus-bot-frames", animated ? String(view.frames) : null);
    setAttr(el, "data-t3plus-shape", view.shape);
    setAttr(el, "data-t3plus-mood", view.mood ?? null);
    setAttr(el, "data-animated", animated ? "" : null);
    setVar(el, "--t3plus-bot-badge", badge ? badge.url : null);
    setVar(el, "--t3plus-badge-frames", badge && badge.frames > 1 ? String(badge.frames) : null);
    setAttr(el, "data-badge", badge ? (badge.frames > 1 ? "animated" : "") : null);
    if (own) Object.assign(drawn, avatarParts(el, badge));
    applied.set(el, drawn);
  }
  // The frames are stepped by one shared clock (spriteClock.js; it reads a sprite's frames
  // and duration, and steps only one that moves), told on every draw, drawn anew or not:
  // it lets go of a face taken off the page (the Status view hidden, Settings left), which
  // joins it again here when it is back and drawn once more.
  if (!own) setSprite(el, view, badge);
  else {
    setSprite(drawn.face, view, null);
    if (drawn.tile) setSprite(drawn.tile, null, badge);
  }
}

/** Lets the sprite clock go of a face (and of its children's, on t3+'s avatar). */
function releaseFace(el) {
  applied.delete(el);
  setSprite(el, null, null);
  for (const part of el.children) if (isPart(part)) setSprite(part, null, null);
}

const AVATAR_VARS = ["--t3plus-bot-fill", "--t3plus-bot-clip", "--t3plus-bot-edge", "--t3plus-bot-frames", "--t3plus-bot-badge", "--t3plus-badge-frames"];
/** Removes everything a face drawing set on `el` (its children, its sprite clock). */
export function clearAvatarVars(el) {
  releaseFace(el);
  for (const part of [...el.children]) if (isPart(part)) part.remove();
  for (const name of AVATAR_VARS) el.style.removeProperty(name);
  for (const name of ["data-t3plus-shape", "data-t3plus-mood", "data-animated", "data-badge"]) el.removeAttribute(name);
  if (el.getAttribute("style") === "") el.removeAttribute("style");
}

const LAYOUT_ATTRS = [
  "data-t3plus-bot-body",
  "data-t3plus-bot-top",
  "data-t3plus-bot-name",
  "data-t3plus-bot-title-line",
  "data-t3plus-bot-lines",
  "data-t3plus-bot-hide",
  "data-t3plus-bot-status",
];

/**
 * Tags T3's row lines so CSS can lay the bot out like a chat list entry:
 *   line 1: bot name ............ T3's status/time slot
 *   line 2: latest message, one line, truncated
 * T3's branch line is hidden and the row body sizes to these two lines, so
 * every bot row is the same compact height whether or not T3 gave it a branch.
 */
function markBotLayout(row, titleEl, label) {
  const body = [...row.children].find(
    (child) => child.classList?.contains("relative") && child.classList?.contains("z-10"),
  );
  if (!body) {
    markSlimBotLayout(row, titleEl, label);
    return;
  }
  // T3's own lines only: t3+'s appended meta line is not one of them.
  const lines = [...body.children].filter((child) => child?.nodeType === 1 && !child.hasAttribute(T3PLUS.ownedAttr));
  const [top, titleLine, metaLine] = lines;
  setAttr(body, "data-t3plus-bot-body", "");
  setAttr(body, "data-t3plus-bot-lines", metaLine ? "3" : "2");
  if (top) {
    setAttr(top, "data-t3plus-bot-top", "");
    setAttr(top, "data-t3plus-bot-name", label);
    for (const child of [...top.children]) {
      if (child.hasAttribute(T3PLUS.ownedAttr)) continue;
      // Both ways: while a row is dragged, T3 renders its drop label in the status
      // slot's element, and a hide mark left from then hid the status for good.
      const status = child.classList?.contains(T3_CLASSES.statusSlot);
      setAttr(child, status ? "data-t3plus-bot-status" : "data-t3plus-bot-hide", "");
      setAttr(child, status ? "data-t3plus-bot-hide" : "data-t3plus-bot-status", null);
    }
  }
  if (titleLine) {
    setAttr(titleLine, "data-t3plus-bot-title-line", "");
    for (const child of [...titleLine.children]) {
      if (child !== titleEl && !child.contains(titleEl)) setAttr(child, "data-t3plus-bot-hide", "");
    }
  }
  if (metaLine) setAttr(metaLine, "data-t3plus-bot-hide", "");
}

/**
 * T3's project-grouped rows have no card body: one line (draft mark, title,
 * provider icons, status/time) and an optional branch line sit straight in the
 * row. The row itself becomes the bot body and its first line a two-row grid
 * (content.css): the name and T3's status on top, the latest message (shown on
 * the title span) below. The branch line is hidden.
 */
function markSlimBotLayout(row, titleEl, label) {
  const lines = [...row.children].filter((child) => child?.nodeType === 1 && !child.hasAttribute(T3PLUS.ownedAttr));
  const top = lines.find((line) => titleEl && line.contains(titleEl)) ?? lines[0];
  if (!top) return;
  setAttr(row, "data-t3plus-bot-body", "slim");
  setAttr(row, "data-t3plus-bot-lines", "2");
  setAttr(top, "data-t3plus-bot-top", "");
  setAttr(top, "data-t3plus-bot-name", label);
  // T3's own children only: t3+'s subagent strip also lives in this line.
  const own = [...top.children].filter((child) => !child.hasAttribute(T3PLUS.ownedAttr));
  for (const child of own) {
    if (child === titleEl) continue;
    const status = child.classList?.contains(T3_CLASSES.statusSlot) || (child.classList?.contains("ml-auto") && child === own.at(-1));
    setAttr(child, status ? "data-t3plus-bot-status" : "data-t3plus-bot-hide", "");
    setAttr(child, status ? "data-t3plus-bot-hide" : "data-t3plus-bot-status", null);
  }
  for (const line of lines) if (line !== top) setAttr(line, "data-t3plus-bot-hide", "");
}

function clearBotLayout(row) {
  const selector = LAYOUT_ATTRS.map((name) => `[${name}]`).join(", ");
  for (const el of [row, ...row.querySelectorAll(selector)]) for (const name of LAYOUT_ATTRS) el.removeAttribute(name);
}

const swept = new WeakSet(); // documents cleared of v0.5's third line

// Each bot row as it was last decorated: done again only when what it shows changed (its
// face, name, status, message or subagents), a part of t3+'s in it went missing, or T3
// changed something inside it (noteBotRowChanges). Every check redid every row's layout
// marks, face and subagents (some twenty DOM reads and three queries a row), nearly
// always on rows in which nothing had changed.
const decorated = new WeakMap(); // row -> { status, view, preview, subagents, look, titleEl, avatar, strip }
function sameDecoration(was, row, bot, view, preview, subagents, look) {
  return (
    was.status === bot.status &&
    was.preview === preview &&
    was.titleEl === bot.thread.titleEl &&
    was.view.label === view.label &&
    was.view.paint === view.paint &&
    sameFace(was.view, view) &&
    (was.subagents === subagents || (!was.subagents.length && !subagents.length)) &&
    was.look.shape === look.shape &&
    was.look.color === look.color &&
    // T3 dropping t3+'s nodes is no change the checks hear of (they are t3+'s own).
    was.avatar.parentNode === row &&
    (!was.strip || row.contains(was.strip))
  );
}

/**
 * Takes the DOM watcher's mutation records: a bot row T3 changed something in (a line
 * re-rendered, its status slot swapped) is decorated afresh at the next check.
 */
export function noteBotRowChanges(records) {
  for (const { target } of records) {
    const row = (target.nodeType === 1 ? target : target.parentElement)?.closest(`[${T3PLUS.botAttr}]`);
    if (row) decorated.delete(row);
  }
}

/**
 * Styles bot rows in place: data attributes on T3's row and lines, and one
 * t3+-owned avatar element. Idempotent: a row is decorated again only when
 * something it shows or holds changed, and then only changed values are
 * written. Undecorates rows that stopped being bots.
 * @param {(key: string) => string} previewFor latest-message line for a bot
 * @param {{ shape: string, color: string }} subagentLook subagents' shape and color
 *   (settings sidebar.subagentShape/Color): SAME_AS_BOT for their bot's
 */
export function decorateBotRows(doc, scan, bots, prefsByKey, previewFor = () => "", subagentsFor = () => [], subagentLook = SAME_LOOK) {
  const botRows = new Set();
  for (const bot of bots) {
    const { row, titleEl } = bot.thread;
    botRows.add(row);
    const view = resolveBotPresentation(bot, prefsByKey[bot.key]);
    const preview = previewFor(bot.key);
    const subagents = subagentsFor(bot.key);
    const was = decorated.get(row);
    if (was && sameDecoration(was, row, bot, view, preview, subagents, subagentLook)) continue;
    setAttr(row, T3PLUS.botAttr, bot.status);
    setAttr(row, "aria-description", preview ? `t3+ bot: ${view.label}. ${preview}` : `t3+ bot: ${view.label}`);
    markBotLayout(row, titleEl, view.label);

    let avatar = [...row.children].find((child) => child.classList?.contains("t3plus-bot-avatar"));
    if (!avatar) {
      avatar = doc.createElement("span");
      avatar.className = "t3plus-bot-avatar";
      avatar.setAttribute(T3PLUS.ownedAttr, "");
      avatar.setAttribute("aria-hidden", "true");
      row.append(avatar);
    }
    applyAvatarVars(avatar, view);
    setAttr(avatar, "data-status", bot.status);

    if (titleEl) setAttr(titleEl, T3PLUS.botTitleAttr, preview);
    const strip = syncSubagents(doc, row, subagents, view, subagentLook);
    decorated.set(row, { status: bot.status, view, preview, subagents, look: subagentLook, titleEl, avatar, strip });
  }
  // Rows decorated by v0.5 carried a third (model/computer) line: dropped once a page
  // (only t3+ ever drew it), not looked for in every row of every check.
  if (!swept.has(doc)) {
    swept.add(doc);
    for (const old of doc.querySelectorAll(".t3plus-bot-metaline")) old.remove();
  }
  for (const row of scan.threads.map((t) => t.row)) {
    if (!botRows.has(row) && row.hasAttribute(T3PLUS.botAttr)) undecorateBotRow(row);
  }
}

// A subagent that has ended, by how: its face (dimmed, like every ended one) and its
// mark in the strip's tooltip. Failed and stopped ones had the finished face's happy
// eyes and a ✓ too.
const SUBAGENT_STOPPED = Object.freeze({ mood: "idle", mark: "–" });
const SUBAGENT_ENDS = new Map([
  ["completed", Object.freeze({ mood: "done", mark: "✓" })],
  ["failed", Object.freeze({ mood: "failed", mark: "✗" })],
  ["interrupted", SUBAGENT_STOPPED],
  ["cancelled", SUBAGENT_STOPPED],
  ["canceled", SUBAGENT_STOPPED],
]);
/** One still working: open eyes. */
const SUBAGENT_WORKING = Object.freeze({ mood: "awake", mark: "•" });
const MAX_MINIS = 6;
const SAME_LOOK = Object.freeze({ shape: SAME_AS_BOT, color: SAME_AS_BOT });

/**
 * A subagent's face under the bot drawn as `view`: its bot's shape and color, unless
 * Settings sets them ({ shape, color, clip }). Its bot's color is the one the bot shows:
 * a ball, a planet or a fruit shows its own colors, not its paint (and a subagent in one
 * of those shapes keeps its own colors too).
 */
export function subagentFace(view, look = SAME_LOOK) {
  const pickedShape = look?.shape !== SAME_AS_BOT && Object.hasOwn(BOT_SHAPES, look?.shape ?? "") ? look.shape : null;
  const pickedColor = look?.color !== SAME_AS_BOT && Object.hasOwn(BOT_COLORS, look?.color ?? "") ? look.color : null;
  const shape = pickedShape ?? view.shape;
  // In its paint, a plain face under a white golf ball came out in the project's blue,
  // a color nowhere on its bot: its ball's own middle color instead.
  const color = pickedColor ?? (botShapeHasOwnColors(view.shape) ? BOT_SKINS[view.shape].stops[1] : view.paint);
  return { shape, color, clip: botClipPath(shape) };
}

/**
 * A third line of tiny faces under a bot that is running subagents: one per
 * subagent, in its bot's shape and color (or the ones Settings sets for them),
 * still, and dimmed once ended: happy eyes when finished, x eyes when failed.
 * Hover shows their titles. Gone when none is working any more. Returns the strip, or
 * null. Nearly every bot has none: it is looked for, and its faces worked out, only for
 * one that has subagents.
 */
function syncSubagents(doc, row, subagents, view, look) {
  let strip = row.querySelector(".t3plus-bot-subs");
  if (!subagents.length) {
    strip?.remove();
    return null;
  }
  // A card row's body stacks its lines, so the strip is a line of its own there; in
  // a slim row it is the third row of the top line's grid (content.css). In a card's
  // one-line top row it squeezed the bot's name.
  const card = row.getAttribute("data-t3plus-bot-body") === "slim" ? null : row.querySelector(":scope > [data-t3plus-bot-body]");
  const host = card ?? row.querySelector("[data-t3plus-bot-top]") ?? row;
  if (strip && strip.parentElement !== host) host.append(strip);
  const face = subagentFace(view, look);
  const signature = JSON.stringify([face.shape, face.color, subagents]);
  if (strip?.dataset.signature === signature) return strip;
  if (!strip) {
    strip = doc.createElement("span");
    strip.className = "t3plus-bot-subs";
    strip.setAttribute(T3PLUS.ownedAttr, "");
    host.append(strip);
  }
  strip.replaceChildren();
  strip.dataset.signature = signature;
  const working = subagents.filter((s) => !SUBAGENT_ENDS.has(s.status)).length;
  const failed = subagents.filter((s) => s.status === "failed").length;
  const summary = `${working} of ${subagents.length} subagents working${failed ? `, ${failed} failed` : ""}`;
  strip.title = `${summary}\n${subagents.map((s) => `${(SUBAGENT_ENDS.get(s.status) ?? SUBAGENT_WORKING).mark} ${s.title || "Subagent"}`).join("\n")}`;
  strip.setAttribute("aria-label", summary);
  for (const s of subagents.slice(0, MAX_MINIS)) {
    const end = SUBAGENT_ENDS.get(s.status);
    const art = botStill(face.color, face.shape, (end ?? SUBAGENT_WORKING).mood);
    const mini = doc.createElement("i");
    mini.className = "t3plus-bot-sub";
    if (end) mini.setAttribute("data-done", "");
    mini.style.setProperty("--t3plus-bot-fill", art.url);
    mini.style.setProperty("--t3plus-bot-clip", face.clip);
    strip.append(mini);
  }
  if (subagents.length > MAX_MINIS) {
    const more = doc.createElement("span");
    more.className = "t3plus-bot-subs-more";
    more.textContent = `+${subagents.length - MAX_MINIS}`;
    strip.append(more);
  }
  return strip;
}

export function undecorateBotRow(row) {
  decorated.delete(row);
  for (const el of row.querySelectorAll(".t3plus-bot-avatar")) releaseFace(el);
  row.removeAttribute(T3PLUS.botAttr);
  row.removeAttribute("aria-description");
  if (row.getAttribute("style") === "") row.removeAttribute("style");
  clearBotLayout(row);
  for (const el of row.querySelectorAll(`[${T3PLUS.botTitleAttr}]`)) el.removeAttribute(T3PLUS.botTitleAttr);
  for (const el of row.querySelectorAll(`[${T3PLUS.ownedAttr}]`)) el.remove();
}

// t3+'s parts of the sidebar that are no bot's, which stay when bots are off: the profile
// dots and the copy of the list that slides in while switching (profiles.js), and the
// Status view with its button's row (app.js). Taken out by every check with bots off and
// put back by the same check, the view lost the keyboard focus and each removal set off
// the next check, without end.
const NOT_BOT_PARTS = ".t3plus-profiles, [data-t3plus-profile-next], .t3plus-status-view, .t3plus-status-toggle-row";

/** Removes all bot decoration under `root` (feature off, or stop). */
export function clearBotDecoration(root) {
  for (const row of root.querySelectorAll(`[${T3PLUS.botAttr}]`)) undecorateBotRow(row);
  for (const el of root.querySelectorAll(`[${T3PLUS.ownedAttr}]`)) if (!el.closest(NOT_BOT_PARTS)) el.remove();
}

/**
 * A bot's prefs for its face on T3's own elements (the breadcrumb, a hover card): with no
 * badge, whatever Status badges says. Only t3+'s avatars have a badge child to draw one
 * in (content.css): here it was worked out, and a moving one stepped, for nothing.
 */
const t3ElementPrefs = (prefs) => (prefs?.badges ? { ...prefs, badges: false } : prefs);

/** Decorates the active thread breadcrumb without changing T3's route/header structure. */
const ACTIONS_PREFIX = "Thread actions for ";
/** The heading's actions button: T3 labels it with the raw title, marker and all. */
const actionsButton = (heading) => heading.closest?.(`button[aria-label^="${ACTIONS_PREFIX}"]`) ?? null;

/**
 * Whether the label t3+ took off T3's actions button is still T3's: t3+'s is on it and
 * T3's heading does not show those words. Once the marker is taken off the title in T3,
 * T3's own label is the same as t3+'s: the stale marked one put back stayed (T3 does
 * not write a label it has not changed).
 */
function rawLabelIsCurrent(button) {
  const set = button.getAttribute("data-t3plus-set-label");
  const title = button.querySelector(T3_SELECTORS.breadcrumbHeading)?.textContent.trim() ?? "";
  return button.getAttribute("aria-label") === set && set !== `${ACTIONS_PREFIX}${title}`;
}

export function decorateBotBreadcrumb(doc, bot) {
  const heading = bot ? doc.querySelector(T3_SELECTORS.breadcrumbHeading) : null;
  for (const old of doc.querySelectorAll(`${T3_SELECTORS.breadcrumbHeading}[data-t3plus-bot-breadcrumb]`)) {
    if (old === heading) continue;
    if (old.getAttribute("aria-label") === old.getAttribute("data-t3plus-bot-breadcrumb-label")) old.removeAttribute("aria-label");
    old.removeAttribute("data-t3plus-bot-breadcrumb");
    old.removeAttribute("data-t3plus-bot-breadcrumb-label");
    // All of it: the mood, animation and badge stayed on T3's heading after leaving a bot.
    clearAvatarVars(old);
  }
  // T3's label back where t3+ set the bot's name (unless T3 has set its own since).
  for (const button of doc.querySelectorAll("button[data-t3plus-raw-label]")) {
    if (heading && actionsButton(heading) === button) continue;
    if (rawLabelIsCurrent(button)) button.setAttribute("aria-label", button.getAttribute("data-t3plus-raw-label"));
    button.removeAttribute("data-t3plus-raw-label");
    button.removeAttribute("data-t3plus-set-label");
  }
  if (!heading) return;
  const view = resolveBotPresentation(bot, t3ElementPrefs(bot.prefs));
  // The heading's name is the bot's: its hidden raw title (marker and all) and the drawn
  // name were both read out. Not over a label T3 gave it itself.
  const named = heading.getAttribute("aria-label");
  if (named === null || named === heading.getAttribute("data-t3plus-bot-breadcrumb-label")) setAttr(heading, "aria-label", view.label);
  setAttr(heading, "data-t3plus-bot-breadcrumb", "");
  setAttr(heading, "data-t3plus-bot-breadcrumb-label", view.label);
  paintFace(heading, view, false);
  // "Thread actions for [[t3plus:bot:v1]] Orchestrator" read out the marker: the bot's name instead.
  const button = actionsButton(heading);
  const label = button?.getAttribute("aria-label") ?? "";
  const wanted = `${ACTIONS_PREFIX}${view.label}`;
  if (button && label !== wanted) {
    if (label !== button.getAttribute("data-t3plus-set-label")) button.setAttribute("data-t3plus-raw-label", label);
    button.setAttribute("data-t3plus-set-label", wanted);
    button.setAttribute("aria-label", wanted);
  }
}

/**
 * Tooltips that show a bot's raw title (marker and all, as over the breadcrumb)
 * show its name instead. Only whole text equal to a marked title is changed, and
 * not the hover card's title (decorateBotHoverCards reads that one).
 */
export function relabelBotTooltips(root, botsByTitle) {
  for (const popup of root.querySelectorAll(T3_SELECTORS.tooltipPopup)) {
    const walker = popup.ownerDocument.createTreeWalker(popup, 4 /* NodeFilter.SHOW_TEXT */);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const bot = botsByTitle.get((n.nodeValue ?? "").trim());
      if (!bot?.titleLabel || bot.titleLabel === bot.thread?.title?.trim() || n.parentElement?.closest(HOVER_CARD_TITLE)) continue;
      n.nodeValue = bot.titleLabel;
    }
  }
}

/** The thread hover card's title line (ThreadHoverCard.tsx): first line of T3's tooltip popup. */
// T3 main uses font-medium; the open redesign stack (#28839-#28845) switches it to font-semibold.
export const HOVER_CARD_TITLE = T3_SELECTORS.hoverCardTitle;

/**
 * T3's thread hover card shows the raw title, marker included. Like the
 * breadcrumb, t3+ hides that text and shows the bot's face and clean name.
 * Matches cards by title against the bots in the sidebar. Idempotent; a card
 * T3 reuses for another thread is re-checked by its text.
 * @param {Map<string, object>} botsByTitle raw title -> bot (from classifyBots)
 */
export function decorateBotHoverCards(root, botsByTitle, prefsByKey, textOf = null) {
  for (const el of root.querySelectorAll(HOVER_CARD_TITLE)) {
    // The title as T3 wrote it (screenshot mode's stand-in read through), like the sidebar's.
    const raw = (textOf ? textOf(el) : el.textContent) ?? "";
    const bot = botsByTitle.get(raw.trim());
    if (!bot) {
      if (el.getAttribute("data-t3plus-hover-raw") === raw && !el.hasAttribute("data-t3plus-bot-hover")) continue;
      el.setAttribute("data-t3plus-hover-raw", raw);
      if (el.hasAttribute("data-t3plus-bot-hover")) clearAvatarVars(el);
      el.removeAttribute("data-t3plus-bot-hover");
      el.removeAttribute("data-t3plus-bot-hover-label");
      continue;
    }
    // Kept in step with what it shows, not only its title: an open card follows screenshot
    // mode (the label) and the bot's face (shape, color, status). Only what changed is
    // written: paintFace compares the whole face.
    const view = resolveBotPresentation(bot, t3ElementPrefs(prefsByKey[bot.key]));
    setAttr(el, "data-t3plus-hover-raw", raw);
    setAttr(el, "data-t3plus-bot-hover", "");
    setAttr(el, "data-t3plus-bot-hover-label", view.label);
    paintFace(el, view, false);
  }
}
