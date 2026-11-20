import { botArt, botBadge, botClipPath, botEdgeColor, defaultBotColor, defaultBotShape, MOOD_BY_STATUS } from "./botArt.js";
import {
  BOT_COLORS,
  BOT_LIMITS,
  BOT_MARKER_PATTERN,
  BOT_SHAPES,
  DEFAULT_BOT_MARKER,
  SIDEBAR_ROW_PREFIX,
  STORAGE_KEYS,
  T3_CLASSES,
  T3_SELECTORS,
  T3PLUS,
} from "./config.js";
import { subscribeKey } from "./settings.js";
import { setSprite } from "./spriteClock.js";

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

// T3's row aria-label is "<title>, <status label>, <project>" (Sidebar.logic.ts
// resolveSidebarRowAccessibility); status labels from SidebarThreadRow.tsx.
const STATUS_BY_LABEL = new Map([
  ["Setting up", "working"],
  ["Goal", "working"],
  ["Working", "working"],
  ["Waiting", "waiting"],
  ["Approval", "attention"],
  ["Input", "attention"],
  ["Request", "attention"],
  ["Limited", "failed"],
  ["Failed", "failed"],
  ["Woke", "attention"], // a snoozed thread woke up: it wants you (T3 shows it in warning color)
  ["Done", "done"],
]);

/** working | waiting | attention | failed | done | idle, from the row's aria-label. */
export function parseRowStatus(ariaLabel, title) {
  if (typeof ariaLabel !== "string" || !ariaLabel.startsWith(title)) return "idle";
  const rest = ariaLabel.slice(title.length);
  if (!rest.startsWith(", ")) return "idle";
  const next = rest.slice(2).split(", ")[0];
  return STATUS_BY_LABEL.get(next) ?? "idle";
}

/** The project named at the end of a row's aria-label ("<title>, <status>, <project>"), or "". */
export function parseRowProject(ariaLabel, title) {
  if (typeof ariaLabel !== "string" || !title || !ariaLabel.startsWith(`${title}, `)) return "";
  const parts = ariaLabel.slice(title.length + 2).split(", ");
  if (STATUS_BY_LABEL.has(parts[0])) parts.shift();
  return parts.join(", ");
}

/** T3's own status word for the row ("Input", "Approval", "Working", ...), or "" when it shows none. */
export function parseRowStatusLabel(ariaLabel, title) {
  if (typeof ariaLabel !== "string" || !ariaLabel.startsWith(title)) return "";
  const rest = ariaLabel.slice(title.length);
  if (!rest.startsWith(", ")) return "";
  const next = rest.slice(2).split(", ")[0];
  return STATUS_BY_LABEL.has(next) ? next : "";
}

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
    if (BOT_KEY.test(key)) out[key] = normalizeBotPrefs(value, key);
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

/** Stores bot presentation keyed by "<environmentId>:<threadId>". Never sent anywhere. */
/** Threads turned into bots (or out of them) by hand, as stored: { "<env>:<thread>": boolean }. */
export function normalizeManualBots(raw) {
  const out = {};
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    // true: a bot; false: turned off while bots are on by default.
    for (const k of Object.keys(raw).slice(0, MANUAL_LIMIT)) if (BOT_KEY.test(k) && typeof raw[k] === "boolean") out[k] = raw[k];
  }
  return out;
}

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
      all[botKey] = normalizeBotPrefs({ ...all[botKey], ...patch }, botKey);
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
    // What the thread is doing, as a small tile on the face's corner (only for a real row: Settings swatches have no status).
    badge: bot.status ? botBadge(bot.status, bot.statusLabel) : null,
  };
}

const setAttr = (el, name, value) => {
  if (value === null || value === undefined) {
    if (el.hasAttribute(name)) el.removeAttribute(name);
  } else if (el.getAttribute(name) !== value) {
    el.setAttribute(name, value);
  }
};
const setVar = (el, name, value) => {
  if (value === null) {
    if (el.style.getPropertyValue(name)) el.style.removeProperty(name);
  } else if (el.style.getPropertyValue(name) !== value) {
    el.style.setProperty(name, value);
  }
};

/** Writes the avatar CSS variables onto `el` (row avatar, breadcrumb, Settings preview). */
export function applyAvatarVars(el, view) {
  setVar(el, "--t3plus-bot-fill", view.fill);
  setVar(el, "--t3plus-bot-clip", view.clip);
  setVar(el, "--t3plus-bot-edge", view.edge);
  const animated = view.frames > 1;
  setVar(el, "--t3plus-bot-frames", animated ? String(view.frames) : null);
  setAttr(el, "data-t3plus-shape", view.shape);
  setAttr(el, "data-t3plus-mood", view.mood ?? null);
  setAttr(el, "data-animated", animated ? "" : null);
  const badge = view.badge ?? null;
  setVar(el, "--t3plus-bot-badge", badge ? badge.url : null);
  setVar(el, "--t3plus-badge-frames", badge && badge.frames > 1 ? String(badge.frames) : null);
  setAttr(el, "data-badge", badge ? (badge.frames > 1 ? "animated" : "") : null);
  // The frames are stepped by one shared clock, only when a frame is due (spriteClock.js).
  setSprite(el, animated ? { frames: view.frames, duration: view.duration } : null, badge && badge.frames > 1 ? badge : null);
}

const AVATAR_VARS = ["--t3plus-bot-fill", "--t3plus-bot-clip", "--t3plus-bot-edge", "--t3plus-bot-frames", "--t3plus-bot-badge", "--t3plus-badge-frames"];
/** Removes everything applyAvatarVars set on an element of T3's (its sprite clock too). */
export function clearAvatarVars(el) {
  setSprite(el, null, null);
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

/**
 * Styles bot rows in place: data attributes on T3's row and lines, and one
 * t3+-owned avatar element. Idempotent: only changed values are written, so
 * re-running after each mutation is cheap. Undecorates rows that stopped
 * being bots.
 * @param {(key: string) => string} previewFor latest-message line for a bot
 */
export function decorateBotRows(doc, scan, bots, prefsByKey, previewFor = () => "", subagentsFor = () => []) {
  const botRows = new Set();
  for (const bot of bots) {
    const { row, titleEl } = bot.thread;
    botRows.add(row);
    const view = resolveBotPresentation(bot, prefsByKey[bot.key]);
    const preview = previewFor(bot.key);
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
    syncSubagents(doc, row, subagentsFor(bot.key), view);

    // Rows decorated by v0.5 carried a third (model/computer) line; drop it.
    for (const old of row.querySelectorAll(".t3plus-bot-metaline")) old.remove();
  }
  for (const row of scan.threads.map((t) => t.row)) {
    if (!botRows.has(row) && row.hasAttribute(T3PLUS.botAttr)) undecorateBotRow(row);
  }
}

const SUBAGENT_DONE = new Set(["completed", "failed", "interrupted", "cancelled", "canceled"]);
const MAX_MINIS = 6;
/**
 * A third line of tiny robots under a bot that is running subagents: one per
 * subagent, stepping through the working face while it works and dimmed once
 * done. Hover shows their titles. Gone when none is working any more.
 */
function syncSubagents(doc, row, subagents, view) {
  // A card row's body stacks its lines, so the strip is a line of its own there; in
  // a slim row it is the third row of the top line's grid (content.css). In a card's
  // one-line top row it squeezed the bot's name.
  const card = row.getAttribute("data-t3plus-bot-body") === "slim" ? null : row.querySelector(":scope > [data-t3plus-bot-body]");
  const host = card ?? row.querySelector("[data-t3plus-bot-top]") ?? row;
  let strip = row.querySelector(".t3plus-bot-subs");
  if (!subagents.length) {
    if (strip) {
      for (const el of strip.children) setSprite(el, null, null);
      strip.remove();
    }
    return;
  }
  if (strip && strip.parentElement !== host) host.append(strip);
  const signature = JSON.stringify([view.paint, subagents]);
  if (strip?.dataset.signature === signature) return;
  if (!strip) {
    strip = doc.createElement("span");
    strip.className = "t3plus-bot-subs";
    strip.setAttribute(T3PLUS.ownedAttr, "");
    host.append(strip);
  }
  for (const el of strip.children) setSprite(el, null, null);
  strip.replaceChildren();
  strip.dataset.signature = signature;
  const working = subagents.filter((s) => !SUBAGENT_DONE.has(s.status)).length;
  strip.title = `${working} of ${subagents.length} subagents working\n${subagents.map((s) => `${SUBAGENT_DONE.has(s.status) ? "✓" : "•"} ${s.title || "Subagent"}`).join("\n")}`;
  strip.setAttribute("aria-label", `${working} of ${subagents.length} subagents working`);
  for (const s of subagents.slice(0, MAX_MINIS)) {
    const done = SUBAGENT_DONE.has(s.status);
    const art = botArt(done ? "gray" : view.paint, "robot", done ? "done" : "working");
    const mini = doc.createElement("i");
    mini.className = "t3plus-bot-sub";
    if (done) mini.setAttribute("data-done", "");
    mini.style.setProperty("--t3plus-bot-fill", art.url);
    mini.style.setProperty("--t3plus-bot-frames", String(art.frames));
    mini.style.setProperty("--t3plus-bot-clip", botClipPath("robot"));
    strip.append(mini);
    setSprite(mini, art.frames > 1 ? { frames: art.frames, duration: art.duration } : null, null);
  }
  if (subagents.length > MAX_MINIS) {
    const more = doc.createElement("span");
    more.className = "t3plus-bot-subs-more";
    more.textContent = `+${subagents.length - MAX_MINIS}`;
    strip.append(more);
  }
}

export function undecorateBotRow(row) {
  for (const el of row.querySelectorAll(".t3plus-bot-avatar, .t3plus-bot-sub")) setSprite(el, null, null);
  row.removeAttribute(T3PLUS.botAttr);
  row.removeAttribute("aria-description");
  if (row.getAttribute("style") === "") row.removeAttribute("style");
  clearBotLayout(row);
  for (const el of row.querySelectorAll(`[${T3PLUS.botTitleAttr}]`)) el.removeAttribute(T3PLUS.botTitleAttr);
  for (const el of row.querySelectorAll(`[${T3PLUS.ownedAttr}]`)) el.remove();
}

/** Removes all bot decoration under `root` (feature off, or stop). */
export function clearBotDecoration(root) {
  for (const row of root.querySelectorAll(`[${T3PLUS.botAttr}]`)) undecorateBotRow(row);
  // Profiles (profiles.js) live in the same sidebar and stay when bots are off: the dots,
  // and the copy of the list that slides in while switching.
  for (const el of root.querySelectorAll(`[${T3PLUS.ownedAttr}]`)) if (!el.closest(".t3plus-profiles, [data-t3plus-profile-next]")) el.remove();
}

/** Decorates the active thread breadcrumb without changing T3's route/header structure. */
const ACTIONS_PREFIX = "Thread actions for ";
/** The heading's actions button: T3 labels it with the raw title, marker and all. */
const actionsButton = (heading) => heading.closest?.(`button[aria-label^="${ACTIONS_PREFIX}"]`) ?? null;

export function decorateBotBreadcrumb(doc, bot) {
  const heading = bot ? doc.querySelector(T3_SELECTORS.breadcrumbHeading) : null;
  for (const old of doc.querySelectorAll(`${T3_SELECTORS.breadcrumbHeading}[data-t3plus-bot-breadcrumb]`)) {
    if (old === heading) continue;
    old.removeAttribute("data-t3plus-bot-breadcrumb");
    old.removeAttribute("data-t3plus-bot-breadcrumb-label");
    // All of it: the mood, animation and badge stayed on T3's heading after leaving a bot.
    clearAvatarVars(old);
  }
  // T3's label back where t3+ set the bot's name (unless T3 has set its own since).
  for (const button of doc.querySelectorAll("button[data-t3plus-raw-label]")) {
    if (heading && actionsButton(heading) === button) continue;
    if (button.getAttribute("aria-label") === button.getAttribute("data-t3plus-set-label")) button.setAttribute("aria-label", button.getAttribute("data-t3plus-raw-label"));
    button.removeAttribute("data-t3plus-raw-label");
    button.removeAttribute("data-t3plus-set-label");
  }
  if (!heading) return;
  const view = resolveBotPresentation(bot, bot.prefs);
  setAttr(heading, "data-t3plus-bot-breadcrumb", "");
  setAttr(heading, "data-t3plus-bot-breadcrumb-label", view.label);
  applyAvatarVars(heading, view);
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
    // Re-drawn whenever what it shows changes, not only its title: an open card
    // follows screenshot mode (the label), and the bot's shape, color and status.
    const view = resolveBotPresentation(bot, prefsByKey[bot.key]);
    const signature = `${raw}\u0000${view.label}\u0000${view.shape}\u0000${view.paint}\u0000${view.mood}\u0000${bot.status ?? ""}`;
    if (el.getAttribute("data-t3plus-hover-raw") === signature && el.hasAttribute("data-t3plus-bot-hover")) continue;
    el.setAttribute("data-t3plus-hover-raw", signature);
    el.setAttribute("data-t3plus-bot-hover", "");
    el.setAttribute("data-t3plus-bot-hover-label", view.label);
    applyAvatarVars(el, view);
  }
}
