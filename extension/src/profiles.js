import { SIDEBAR_ROW_PREFIX, STORAGE_KEYS, T3PLUS, T3_ATTRS, T3_SELECTORS } from "./config.js";
import { themeStamp } from "./color.js";
import { LOOK, setLook } from "./composer.js";
import { findSidebarInner, readRowTitle, threadKeyFromPath } from "./sidebar.js";
import { rowStatusWord } from "./statusView.js";
import { PROFILE_ICONS, profileIconSvg } from "./profileIcons.js";

// Profiles, like Dia's (or Arc's spaces): each one shows a set of the sidebar's
// project folders. A row of small dots at the bottom of the sidebar says which
// one is open: click a dot, or swipe sideways with two fingers on the sidebar,
// to switch. The list slides away and the next profile's slides in beside it; a
// swipe moves both with the fingers. Drag a project folder's header and the dots open into named
// chips: drop it on one to move the project there, or on "New" to start a new
// profile with it. Right-click (or double-click) a dot to rename or delete it.
// Everything is local to t3+: T3's projects and folders are only hidden or shown.
//
// Ctrl+Shift+1..9 opens profile 1..9. Each profile has a color, worn by its dot and its
// name pill, and a sky color of its own for T3's night sky over the list (nightly builds).
//
// Each profile keeps its own open thread: switching to a profile opens the thread
// last open in it (else its most recent one), and opening a thread that belongs to
// another profile (⌘K, a link, search) switches to that profile.
//
// Stored (STORAGE_KEYS.profiles): { active, list: [{ id, name, color, sky, icon? }], projects: { projectKey: profileId },
// last?: { profileId: threadKey }, adopted? }.
// The projects there when profiles started keeping track belong to the first
// profile; one added later joins the profile that was open (placeNew).

const { folder: FOLDER_PREFIX, shelf: SHELF_PREFIX } = SIDEBAR_ROW_PREFIX;
/** The project of a folder header row (T3_SELECTORS.folderHeader). */
const folderProject = (header) => header.getAttribute(T3_ATTRS.sidebarRow).slice(FOLDER_PREFIX.length);
/** A thread row's data-sidebar-parent, "" when it has none. */
const rowParentOf = (el) => el?.getAttribute(T3_ATTRS.sidebarParent) ?? "";
// On the rows of the other profiles (hidden, and inert).
const OFF_ATTR = "data-t3plus-profile-off";
const THREAD_KEY = /^[^:\s]+:\S{1,300}$/;
// Statuses that mean a thread is active right now: the most recent of a profile's threads.
const ACTIVE_STATUS = /^(Working|Setting up|Goal|Waiting|Approval|Input|Request|Woke)$/;
const MAX_PROFILES = 9;
const MAX_PROJECTS = 1000;
// When profiles first keep track, the projects T3 shows in this long (it may render
// them over a few moments) are the existing ones and go to the first profile.
const ADOPT_GRACE_MS = 10_000;
const SWIPE_PX = 70;
/** Dot colors. "default" is T3's foreground (the dots' plain white/gray). */
export const PROFILE_COLORS = Object.freeze({
  default: null,
  blue: "#3b82f6",
  purple: "#8b5cf6",
  pink: "#ec4899",
  red: "#ef4444",
  orange: "#f97316",
  yellow: "#eab308",
  green: "#22c55e",
  teal: "#14b8a6",
});
const COLOR_ORDER = ["default", "blue", "purple", "green", "orange", "pink", "teal", "yellow", "red"];
// A profile's colors (its dot, the sidebar's sky) are each one of PROFILE_COLORS' names,
// or a custom "#rrggbb" made in Settings → t3+. Its glow and chat bubble colors are its
// settings (the profile's scope, settingsScopes.js), like everything else in Settings.
const HEX_COLOR = /^#[0-9a-f]{6}$/i;
const isColorValue = (v) => typeof v === "string" && (Object.hasOwn(PROFILE_COLORS, v) || HEX_COLOR.test(v));
const colorOf = (v, fallback) => (isColorValue(v) ? v.toLowerCase() : fallback);

/** A stored color as "#rrggbb" (null for "default"). */
export function profileHex(value) {
  if (typeof value !== "string") return null;
  if (Object.hasOwn(PROFILE_COLORS, value)) return PROFILE_COLORS[value];
  return HEX_COLOR.test(value) ? value.toLowerCase() : null;
}

/** The OKLCH hue (degrees) of a "#rrggbb". */
export function oklchHue(hex) {
  const lin = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  const [r, g, b] = [1, 3, 5].map((i) => lin(Number.parseInt(hex.slice(i, i + 2), 16) / 255));
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  const a = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const bb = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  return ((Math.atan2(bb, a) * 180) / Math.PI + 360) % 360;
}

/** The turn (degrees, the short way round) from a sky of hue `base` to the color `value`; null for default. */
export function skyTurn(value, base) {
  const hex = profileHex(value);
  if (!hex) return null;
  return ((((oklchHue(hex) - base) % 360) + 540) % 360) - 180;
}

export function normalizeProfiles(raw) {
  const value = raw && typeof raw === "object" ? raw : {};
  const seen = new Set();
  const list = (Array.isArray(value.list) ? value.list : [])
    .filter((p) => p && typeof p.id === "string" && /^[a-z0-9-]{1,40}$/i.test(p.id))
    // One entry per id (a hand-edited backup can repeat one): a second made a second dot
    // for the same profile, and deleting either deleted both.
    .filter((p) => !seen.has(p.id) && seen.add(p.id))
    .slice(0, MAX_PROFILES)
    .map((p, i) => ({
      id: p.id,
      name: String(p.name ?? "").replace(/\s+/g, " ").trim().slice(0, 32) || "Profile",
      color: colorOf(p.color, COLOR_ORDER[i % COLOR_ORDER.length]),
      // The sidebar's sky (the same choices); default: T3's own.
      sky: colorOf(p.sky, "default"),
      ...(Object.hasOwn(PROFILE_ICONS, p.icon ?? "") ? { icon: p.icon } : {}),
    }));
  if (!list.length) list.push({ id: "main", name: "Main", color: "default", sky: "default" });
  const ids = new Set(list.map((p) => p.id));
  const projects = {};
  // First-profile entries are kept too: a project in the map is one t3+ has placed,
  // and a project not in it is new (placeNew). Most recently placed last: past the cap
  // the oldest go (t3+'s own saves make room first, roomFor).
  for (const [key, id] of Object.entries(value.projects && typeof value.projects === "object" ? value.projects : {}).slice(-MAX_PROJECTS)) {
    if (typeof key === "string" && key.length <= 400 && ids.has(id)) projects[key] = id;
  }
  const last = {};
  for (const [id, thread] of Object.entries(value.last && typeof value.last === "object" ? value.last : {})) {
    if (ids.has(id) && typeof thread === "string" && THREAD_KEY.test(thread)) last[id] = thread;
  }
  return {
    active: ids.has(value.active) ? value.active : list[0].id,
    list,
    projects,
    ...(Object.keys(last).length ? { last } : {}),
    ...(value.adopted === true ? { adopted: true } : {}),
  };
}

/** `obj[key]` when it is the object's own (a key like "constructor" is no inherited function). */
const getOwn = (obj, key) => (obj && Object.hasOwn(obj, key) ? obj[key] : undefined);

/** The profile a project folder belongs to. */
export function profileOf(state, projectKey) {
  return getOwn(state.projects, projectKey) ?? state.list[0].id;
}

/**
 * How far an animation has eased along its keyframes (0..1), as the browser has it (no
 * style read); one that has ended, or a stand-in that cannot say: 1.
 */
const eased = (anim) => anim?.effect?.getComputedTiming?.().progress ?? 1;

/** "17h" / "3d" / "2w" -> minutes; null for anything else. */
function ageMinutes(text) {
  const m = /^(\d+)\s*(s|m|h|d|w|mo|y)$/.exec(String(text).trim());
  if (!m) return null;
  return Number(m[1]) * { s: 1 / 60, m: 1, h: 60, d: 1440, w: 10080, mo: 43200, y: 525600 }[m[2]];
}

/**
 * deps: win, doc, area + changedEvent (storage), isEnabled(), isDemo(),
 *   onShown(id)   the profile on screen changed (one sliding in counts): the app draws its settings,
 *   onChange()    profiles loaded or changed (Settings follows),
 *   onDelete(id)  a profile was deleted here (its settings go with it),
 *   scoped?       { get(profileId, path), set(profileId, path, value | null) }: a profile's own
 *                 settings (its glow and bubble colors in the dot's editor), settingsScopes.js,
 *   trackpad?     { onBegin(fn), onEnd?(fn) -> unsubscribe }: T3's reports of each touch on the
 *                 trackpad, and of its end (the fingers lifted and the momentum over).
 */
export function createProfiles({ win, doc, area, changedEvent, isEnabled = () => true, isDemo = () => false, onShown = null, onChange = null, onDelete = null, scoped = null, trackpad = null }) {
  // Screenshot mode: profile names are the user's own words ("Acme work"), so the
  // dots, chips and name pill say "Profile 1", "Profile 2". The rename field,
  // opened on purpose, keeps the real name.
  const shownName = (p, i) => (isDemo() ? `Profile ${i + 1}` : p.name);
  let state = normalizeProfiles(null);
  let loaded = false;
  let running = false; // between start() and stop(): a load that lands after stop() changes nothing
  const key = STORAGE_KEYS.profiles;

  // Storage changes seen so far: a load that read before one of them is stale.
  let changes = 0;
  async function load() {
    const seen = changes;
    const stored = (await area.get(key))?.[key];
    if (!running) return;
    if (changes === seen) {
      // (else onChanged has the newer one)
      state = normalizeProfiles(stored);
      storedJson = stored === undefined ? null : JSON.stringify(state);
    }
    loaded = true;
    sync();
    onChange?.();
  }
  let saving = Promise.resolve();
  // This window's writes not yet seen coming back (their JSON). Its own echo is not news
  // from another window: taken as such, an older write's echo undid a newer save, which
  // the queued write then lost for good.
  const echoes = [];
  // What storage holds now, as far as this window knows: a write of the same is skipped
  // (storage reports no change for it, so its echo would never come back and would stay
  // to swallow another window's write of that value).
  let storedJson = null;
  function write() {
    const value = normalizeProfiles(state); // its JSON is the echo's (key order and all)
    const json = JSON.stringify(value);
    if (json === storedJson) return Promise.resolve();
    const before = storedJson;
    storedJson = json;
    echoes.push(json);
    if (echoes.length > 20) echoes.shift();
    // Turned down (T3's storage full, an extension reloaded under this copy; thrown or
    // rejected): storage still holds what it did, and no echo of this is coming. Taken as
    // stored, the next save of the same was skipped and lost.
    return new Promise((resolve) => resolve(area.set({ [key]: value }))).catch((error) => {
      if (storedJson === json) storedJson = before;
      const echo = echoes.lastIndexOf(json);
      if (echo >= 0) echoes.splice(echo, 1);
      throw error;
    });
  }
  function save(next) {
    state = normalizeProfiles(next);
    saving = saving.catch(() => {}).then(write); // queued first: a check that throws loses no save
    // Most callers do not wait for it. A write storage turns down is not lost (the next save
    // of the same state writes it), so it is no unhandled rejection either; a caller that
    // waits still sees it.
    saving.catch(() => {});
    sync();
    onChange?.();
    return saving;
  }
  const onChanged = (changes_, areaName) => {
    if (!running || (areaName && areaName !== "local")) return;
    if (!changes_?.[key]) return;
    changes += 1;
    const next = normalizeProfiles(changes_[key].newValue);
    const json = JSON.stringify(next);
    storedJson = json;
    // This window's own save coming back (the latest, or an older one): nothing to redo.
    const own = echoes.indexOf(json);
    if (own >= 0) {
      echoes.splice(0, own + 1);
      return;
    }
    if (json === JSON.stringify(state)) return;
    // Mid-switch, the thread just noted for the profile being left is not saved yet: kept.
    state = slide ? normalizeProfiles({ ...next, last: { ...(next.last ?? {}), ...(state.last ?? {}) } }) : next;
    sync();
    onChange?.();
  };

  // ---------- The dots ----------
  const bar = doc.createElement("div");
  bar.className = "t3plus-profiles";
  bar.setAttribute(T3PLUS.ownedAttr, "");
  // A toolbar of buttons (the open profile pressed), not a tablist: "New" and the
  // rename editor are no tabs. Arrow keys move between the dots (onDotKey).
  bar.setAttribute("role", "group");
  bar.setAttribute("aria-label", "t3+ profiles");
  // The name shown on a switch is announced too.
  const name = doc.createElement("div");
  name.className = "t3plus-profiles-name";
  name.setAttribute(T3PLUS.ownedAttr, "");
  name.setAttribute("role", "status");
  const dots = doc.createElement("div");
  dots.className = "t3plus-profiles-dots";
  dots.setAttribute("role", "toolbar");
  dots.setAttribute("aria-label", "Profiles");
  bar.append(name, dots);
  let dotsSignature = "";
  let tabShown = null; // the profile the Tab stop was last given to

  function renderDots() {
    const signature = JSON.stringify([state.list, dragging ? 1 : 0, isDemo()]);
    // While a switch slides in, its dot is the open one already.
    const shown = slide?.committed ? slide.id : state.active;
    flashName(shown);
    if (signature === dotsSignature) {
      // Only the open profile changed: the dots stay (a rebuild dropped keyboard focus).
      // The Tab stop goes to the open profile (a switch moves it), but not back while the
      // arrows move it around the dots.
      const roving = dots.contains(doc.activeElement) && shown === tabShown;
      tabShown = shown;
      for (const dot of dots.querySelectorAll(".t3plus-profile-dot")) {
        const on = dot.dataset.profile === shown;
        if (!dot.classList.contains("t3plus-profile-add") && dot.getAttribute("aria-pressed") !== String(on)) dot.setAttribute("aria-pressed", String(on));
        if (!roving && dot.tabIndex !== (on ? 0 : -1)) dot.tabIndex = on ? 0 : -1;
      }
      return;
    }
    dotsSignature = signature;
    tabShown = shown;
    dots.replaceChildren();
    for (const [i, p] of state.list.entries()) {
      const dot = doc.createElement("button");
      dot.type = "button";
      dot.className = "t3plus-profile-dot";
      dot.setAttribute(T3PLUS.ownedAttr, "");
      dot.setAttribute("aria-pressed", String(p.id === shown));
      // One stop in the Tab order (the open profile); arrows reach the rest.
      dot.tabIndex = p.id === shown ? 0 : -1;
      const name = shownName(p, i);
      dot.setAttribute("aria-label", `${name} (profile ${i + 1})`);
      dot.setAttribute("aria-keyshortcuts", i < 9 ? `Control+Shift+${i + 1}` : "");
      dot.title = i < 9 ? `${name}  ⌃⇧${i + 1}` : name;
      dot.dataset.profile = p.id;
      if (profileHex(p.color)) dot.style.setProperty("--t3plus-profile-color", profileHex(p.color));
      const label = doc.createElement("span");
      label.className = "t3plus-profile-chip";
      label.textContent = name;
      if (p.icon) label.insertAdjacentHTML("afterbegin", profileIconSvg(p.icon, 11));
      dot.append(label);
      dots.append(dot);
    }
    if (state.list.length < MAX_PROFILES) {
      const add = doc.createElement("button");
      add.type = "button";
      add.className = "t3plus-profile-dot t3plus-profile-add";
      add.setAttribute(T3PLUS.ownedAttr, "");
      add.setAttribute("aria-label", "New profile");
      add.tabIndex = -1;
      add.title = "New profile";
      add.dataset.profile = "+new";
      const label = doc.createElement("span");
      label.className = "t3plus-profile-chip";
      label.textContent = "New";
      add.append(label);
      dots.append(add);
    }
  }

  // The open profile's name, always beside the dots, in its color (announced when it
  // changes). T3's sky at the top of the sidebar takes the profile's sky color.
  function flashName(id = state.active) {
    const i = state.list.findIndex((p) => p.id === id);
    if (i < 0) return;
    const p = state.list[i];
    const text = shownName(p, i);
    const shownKey = `${p.icon ?? ""}|${text}`;
    if (name.dataset.shown !== shownKey) {
      name.dataset.shown = shownKey;
      const label = doc.createElement("span");
      label.className = "t3plus-profiles-name-text";
      label.textContent = text;
      name.replaceChildren(label);
      if (p.icon) name.insertAdjacentHTML("afterbegin", profileIconSvg(p.icon, 11));
    }
    const color = profileHex(p.color) ?? "";
    if (name.style.getPropertyValue("--t3plus-profile-color") !== color) {
      if (color) name.style.setProperty("--t3plus-profile-color", color);
      else name.style.removeProperty("--t3plus-profile-color");
    }
    tintSky(p.sky);
    setShown(p.id);
  }
  // The profile on screen (one sliding in already): its settings are drawn.
  let shown = null;
  function setShown(id) {
    if (id === shown) return;
    shown = id;
    onShown?.(id);
  }
  /** T3's night art at the top of the sidebar, when this T3 shows it (nightly builds). */
  const nightSky = () => doc.querySelector(T3_SELECTORS.nightSky);
  /** The hue of the theme's own sky (its middle color), read from T3's CSS. */
  // Some themes mix it (color-mix(in oklch, the art's color 38%, the sky's)): the resolved
  // color is read from a probe, once per theme. Only T3's theme counts (color.js
  // themeStamp): taken for a theme change, t3+'s own values on <html> had it probed on
  // every switch, each probe a forced style recalc.
  let skyProbe = null;
  let skyBaseKey = "";
  let skyBaseHue = 278;
  function skyBase() {
    const stamp = themeStamp(doc.documentElement);
    if (stamp === skyBaseKey) return skyBaseHue;
    // From the art's container: on the art itself t3+ has turned the colors already.
    const host = nightSky()?.closest(T3_SELECTORS.skyBackdrop);
    if (!host) return skyBaseHue;
    if (!skyProbe) {
      skyProbe = doc.createElement("span");
      skyProbe.setAttribute(T3PLUS.ownedAttr, "");
      skyProbe.setAttribute("aria-hidden", "true");
      skyProbe.style.cssText = "position:absolute;width:0;height:0;overflow:hidden;color:var(--stage-night-mid)";
    }
    host.parentElement?.append(skyProbe);
    const color = win.getComputedStyle(skyProbe).color;
    skyProbe.remove();
    const m = /oklch\(\s*[\d.]+%?\s+[\d.]+\s+([\d.]+)/i.exec(color);
    const hue = m ? Number.parseFloat(m[1]) : /^#[0-9a-f]{6}$/i.test(color) ? oklchHue(color) : rgbHue(color);
    skyBaseKey = stamp; // also when unreadable: not probed again until the theme changes
    if (Number.isFinite(hue)) skyBaseHue = hue;
    return skyBaseHue;
  }
  /** The OKLCH hue of "rgb(r, g, b)" (how some colors come back computed). */
  function rgbHue(color) {
    const m = /rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/i.exec(color ?? "");
    if (!m) return Number.NaN;
    return oklchHue(`#${[m[1], m[2], m[3]].map((v) => Math.round(Number(v)).toString(16).padStart(2, "0")).join("")}`);
  }
  let skyApplied = "";
  const skyTint = Boolean(win.CSS?.supports?.("color", "oklch(from red l c h)"));
  function tintSky(color) {
    const root = doc.documentElement;
    if (color === null || !skyTint) {
      if (!skyApplied) return;
      skyApplied = "";
      root.removeAttribute("data-t3plus-sky");
      root.removeAttribute("data-t3plus-sky-ready");
      setLook(doc, LOOK.sky, { "--t3plus-sky-turn": null, "--t3plus-sky-mix": null });
      return;
    }
    // The turn from the theme's sky to the profile's sky color, the short way round.
    const t = profileHex(color) ? skyTurn(color, skyBase()) : null; // default: nothing to measure
    const turn = t ?? 0;
    const mix = t === null ? "0" : "1"; // default: T3's sky (a switch to it glides back too)
    const key = `${turn.toFixed(1)}|${mix}`;
    if (key === skyApplied) return; // checked on every DOM check: written only on a change
    const first = !skyApplied;
    skyApplied = key;
    if (!root.hasAttribute("data-t3plus-sky")) root.setAttribute("data-t3plus-sky", "");
    // On the sky itself (composer.js setLook), where the glide runs: on <html>, each
    // switch between two skies restyled the whole page for two values only it reads.
    setLook(doc, LOOK.sky, { ...(t !== null ? { "--t3plus-sky-turn": turn.toFixed(1) } : {}), "--t3plus-sky-mix": mix });
    // Glides between profiles, not in from T3's sky on every load.
    if (first) win.requestAnimationFrame?.(() => skyApplied && root.setAttribute("data-t3plus-sky-ready", ""));
  }

  function nextColor(list) {
    const used = new Set(list.map((p) => p.color));
    return COLOR_ORDER.find((c) => !used.has(c)) ?? COLOR_ORDER[list.length % COLOR_ORDER.length];
  }

  /** "4" for a fourth profile, or the next number no profile is called yet (after a delete). */
  function nextName(list) {
    let n = list.length + 1;
    while (list.some((p) => p.name === String(n))) n += 1;
    return String(n);
  }

  function newProfileId() {
    let id;
    do id = `p${Math.random().toString(36).slice(2, 8)}`;
    while (state.list.some((p) => p.id === id));
    return id;
  }

  /**
   * Opens profile `id`. With `open` (a switch you made: a dot, the keys, a swipe), the
   * thread last open in that profile opens too, else its most recent thread; one
   * that switched because you opened a thread (follow) leaves that thread open.
   */
  function switchTo(id, direction = 0, { open = true } = {}) {
    useUp(gesture); // the rest of a swipe in progress moves nothing
    // A switch still sliding lands first. Its thread is not opened when another switch
    // takes its place (T3 would draw a thread nobody sees); the new one opens its own.
    const pending = slide?.committed && slide.navPending ? slide.id : null;
    if (pending && pending === id) {
      landNow(); // its own thread, with its fade
      return;
    }
    if (slide) landNow({ navigate: false });
    if (id === state.active || !state.list.some((p) => p.id === id)) {
      if (pending) openThreadOf(pending);
      return;
    }
    const from = state.list.findIndex((p) => p.id === state.active);
    const to = state.list.findIndex((p) => p.id === id);
    // One landed before its thread opened: the open thread is not its own to remember.
    const apply = leave(id, { note: !pending });
    slideTo(id, direction || Math.sign(to - from), { open, apply });
  }
  /** Notes the thread to come back to in the profile being left; returns the switch itself. */
  function leave(id, { note = true } = {}) {
    if (!note) return () => save({ ...state, active: id });
    const leaving = state.active;
    // The thread open now is the one to come back to in the profile being left
    // (a pinned or settled thread too: they show in every profile).
    const current = currentThread();
    const last = { ...(state.last ?? {}) };
    if (current && (threadProfile(current) ?? leaving) === leaving) last[leaving] = current;
    state = { ...state, last };
    return () => save({ ...state, active: id });
  }

  // ---------- The profile's own thread ----------
  const routeThread = () => {
    const hash = win.location.hash ?? "";
    return threadKeyFromPath(hash.startsWith("#/") ? hash.slice(1).split(/[?#]/)[0] : win.location.pathname);
  };
  const currentThread = () => routeThread();
  // On a page that is not a thread (Settings, a draft, Usage), switching profiles
  // leaves it open; on a thread or the start page, the profile's thread opens.
  const onThreadPage = () => {
    const hash = win.location.hash ?? "";
    const path = hash.startsWith("#/") ? hash.slice(1).split(/[?#]/)[0] : win.location.pathname;
    return path === "/" || path === "" || routeThread() !== null;
  };
  // What this window last asked T3 to open, until the address shows it. A switch made
  // while T3 is still opening the previous one compares against it, and the late
  // arrival of that previous one is not taken for a thread opened from elsewhere.
  let opening = null; // { thread, at }
  // A switch made where no thread shows (Settings, a draft): coming back to the chat (T3
  // reopens the thread it had) opens the profile's own thread, instead of switching back.
  let openLater = null;
  // thread key -> project key, for threads seen in a folder (their rows go when a
  // folder is collapsed; the profile of a thread opened from there is still known). One
  // seen outside any folder since (settled, snoozed, pinned, T3's flat list) has none.
  const threadProjects = new Map();
  const cssEscape = (v) => (win.CSS?.escape ? win.CSS.escape(v) : String(v).replace(/["\\]/g, "\\$&"));
  const rowOf = (inner, thread) => inner?.querySelector(`${T3_SELECTORS.threadItem}[${T3_ATTRS.threadItem}="${cssEscape(thread)}"] ${T3_SELECTORS.sidebarRow}`) ?? null;
  /** Whether `inner` shows T3's list of threads (not Settings' own sidebar, a search's results, or no sidebar at all). */
  const listShown = (inner) => Boolean(inner?.querySelector(T3_SELECTORS.projectFolderItem) ?? inner?.querySelector(T3_SELECTORS.threadItem));
  /**
   * The project of a thread row whose data-sidebar-parent is `parent`: its folder's, or, for a
   * row T3 nests under another thread (a fork, a subagent, a side chat), that thread's as
   * sync() last noted it (T3 lists it above the rows nested under it). Null in a shelf or
   * in no folder.
   */
  function parentProject(parent) {
    if (parent.startsWith(FOLDER_PREFIX)) return parent.slice(FOLDER_PREFIX.length);
    return parent && !parent.startsWith(SHELF_PREFIX) ? (threadProjects.get(parent) ?? null) : null;
  }
  /** The profile a thread belongs to, or null for one in no folder (pinned, settled, the flat sidebar). */
  function threadProfile(thread) {
    const row = rowOf(sidebarInner(), thread);
    // Where T3 shows its row, that decides; else the folder it was seen in (collapsed since).
    const project = row ? parentProject(rowParentOf(row)) : (threadProjects.get(thread) ?? null);
    return project === null ? null : profileOf(state, project);
  }
  /** Most recent first: a thread at work or waiting on you, then by the age T3 shows ("17h"), then list order. */
  function recentThreadOf(id) {
    const inner = sidebarInner();
    let best = null;
    for (const item of inner?.querySelectorAll(T3_SELECTORS.threadItem) ?? []) {
      const row = item.querySelector(T3_SELECTORS.sidebarRow);
      const project = parentProject(rowParentOf(row));
      if (project === null || profileOf(state, project) !== id) continue;
      // The status after the title (a title can hold ", "), and the age from T3's slot,
      // never the title itself (a thread titled "3m").
      const { title, titleEl } = readRowTitle(row);
      let age = ACTIVE_STATUS.test(rowStatusWord(row.getAttribute("aria-label"), title)) ? 0 : Infinity;
      if (age) for (const el of row.querySelectorAll("span")) {
        if (el.childElementCount || el === titleEl || el.closest(`[${T3PLUS.ownedAttr}]`)) continue;
        const minutes = ageMinutes(el.textContent);
        if (minutes !== null) {
          age = minutes;
          break;
        }
      }
      if (!best || age < best.age) best = { thread: item.getAttribute(T3_ATTRS.threadItem), age };
    }
    return best?.thread ?? null;
  }
  /** Whether `thread` is still to be opened: on a thread page, and neither open nor being opened. */
  function toOpen(thread) {
    if (!thread || !onThreadPage()) return false;
    const pending = opening && Date.now() - opening.at < 1500 ? opening.thread : null;
    return thread !== (pending ?? currentThread());
  }
  /** The thread profile `id` should show, when it is not the one open already (else null). */
  function threadFor(id) {
    // Nothing opens off a thread page, nor is anything judged there: back in the chat it is
    // asked for again (openLater).
    if (!onThreadPage()) return null;
    const inner = sidebarInner();
    let target = getOwn(state.last, id) ?? null;
    if (target) {
      const owner = threadProfile(target);
      // Moved to another profile since, or gone: its folder is open, yet its row is not there.
      const project = threadProjects.get(target);
      // Its row may be missing because its folder is collapsed (then it opens by address),
      // or because T3 shows no list (Settings, a search, a window too narrow for the
      // sidebar): kept. Known folder: that one is open. Unknown (seen in an earlier
      // session): none of the profile's folders is collapsed. Either way the thread is
      // gone: forgotten.
      const gone = !rowOf(inner, target) && listShown(inner) && (project !== undefined
        ? Boolean(inner.querySelector(`[${T3_ATTRS.sidebarRow}="${cssEscape(FOLDER_PREFIX + project)}"][aria-expanded="true"]`))
        : ![...inner.querySelectorAll(`${T3_SELECTORS.folderHeader}[aria-expanded="false"]`)].some((h) => profileOf(state, folderProject(h)) === id));
      if ((owner !== null && owner !== id) || gone) {
        if (gone) {
          const { [id]: _gone, ...rest } = state.last ?? {};
          state = { ...state, last: rest };
          persistSoon();
        }
        target = null;
      }
    }
    target ??= recentThreadOf(id);
    return toOpen(target) ? target : null;
  }
  /** Opens the thread profile `id` should show, if it is not open already; `fade` is the
   *  chat's fade-out started with the slide (shown again if there is nothing to open).
   *  `target`: that thread as found when the switch started (checked again, not looked up). */
  function openThreadOf(id, fade = null, target = threadFor(id)) {
    if (toOpen(target)) navigate(target, fade);
    else fade?.show();
  }
  function navigate(thread, fade = null) {
    opening = { thread, at: Date.now() };
    fade?.arm();
    const row = rowOf(sidebarInner(), thread);
    // The profile's rows are inert until the switch lands (and T3's list while the Status
    // view covers it): still T3's own navigation, inert lifted for the click.
    const lifted = row ? ownInert(row) : null;
    if (lifted) {
      for (const el of lifted) el.removeAttribute("inert");
      try {
        row.click(); // T3's own navigation, as if clicked
      } finally {
        for (const el of lifted) el.setAttribute("inert", "");
      }
      return;
    }
    // Not in the list (its folder is collapsed): by its address.
    const i = thread.indexOf(":");
    const path = `/${encodeURIComponent(thread.slice(0, i))}/${encodeURIComponent(thread.slice(i + 1))}`;
    if ((win.location.hash ?? "").startsWith("#/")) win.location.hash = `#${path}`;
    else {
      win.history.pushState(win.history.state, "", path);
      win.dispatchEvent(new win.PopStateEvent("popstate", { state: win.history.state }));
    }
  }
  /** The inert ancestors of a row, when t3+ set every one of them (else null: T3's own). */
  function ownInert(row) {
    const lifted = [];
    for (let el = row.closest("[inert]"); el; el = el.parentElement?.closest("[inert]") ?? null) {
      if (!el.hasAttribute(OFF_ATTR) && !el.hasAttribute("data-t3plus-status-hidden")) return null;
      lifted.push(el);
    }
    return lifted;
  }
  // The thread swaps smoothly too: the chat fades out with the slide, T3 draws the
  // profile's thread while it is hidden (asked for once the fade runs on the
  // compositor, so a frame of it at full strength never shows), and it fades in once
  // drawn. Opacity only: a move would throw off where t3+ measures the composer to be.
  let threadFade = null;
  function fadeOut() {
    // The main conversation's message list: the composer stays (a faded parent would
    // stop its glass blurring the glow behind it).
    const canvas = doc.querySelector(`${T3_SELECTORS.conversationArea} ${T3_SELECTORS.messageList}`) ?? doc.querySelector(T3_SELECTORS.messageList);
    if (!canvas?.animate || reducedMotion() || !win.requestAnimationFrame) return null;
    // Taking over one still fading: from where it is, as that fade has it. (Its computed
    // opacity, read here right after the switch's own writes, was a forced style recalc.)
    const from = threadFade?.level() ?? 1;
    threadFade?.cancel();
    const out = canvas.animate([{ opacity: from }, { opacity: 0 }], { duration: Math.round(90 * from), easing: "cubic-bezier(0.4, 0, 1, 1)", fill: "forwards" });
    let frame = 0;
    let seen = null;
    let inn = null;
    let at = 0; // where it comes back in from
    const fade = {
      out,
      armed: false,
      /** The chat's opacity now: on its way out, or back in. */
      level: () => (inn ? at + (1 - at) * eased(inn) : from * (1 - eased(out))),
      /** T3 is asked for the thread now: shown again a frame after it has drawn it (or after a second). */
      arm() {
        if (threadFade !== fade || fade.armed) return;
        fade.armed = true;
        const before = win.location.href;
        const started = win.performance.now();
        // Drawn: the old thread's rows have gone (more of its output streaming in is not
        // the new thread), or, from an empty list, rows came after the address changed.
        const rowSel = T3_SELECTORS.timelineRow;
        const old = [...canvas.querySelectorAll(rowSel)];
        let drawn = false;
        seen = new win.MutationObserver(() => {
          if (win.location.href === before) return;
          drawn = old.length ? old.every((row) => !row.isConnected) : canvas.querySelector(rowSel) !== null;
        });
        seen.observe(canvas, { childList: true, subtree: true });
        const wait = () => {
          if (threadFade !== fade) return;
          if (!drawn && win.performance.now() - started < 1000) frame = win.requestAnimationFrame(wait);
          else fade.show();
        };
        frame = win.requestAnimationFrame(wait);
      },
      /** Back in (the thread is drawn, or there was none to open). */
      show() {
        if (threadFade !== fade || inn) return;
        seen?.disconnect();
        win.cancelAnimationFrame(frame);
        frame = win.requestAnimationFrame(() => {
          if (threadFade !== fade) return;
          at = fade.level();
          inn = canvas.animate([{ opacity: at }, { opacity: 1 }], { duration: 200, easing: "cubic-bezier(0, 0, 0.2, 1)" });
          out.cancel();
          inn.onfinish = () => {
            if (threadFade === fade) threadFade = null;
          };
        });
      },
      cancel() {
        win.cancelAnimationFrame(frame);
        seen?.disconnect();
        out.cancel();
        inn?.cancel();
        if (threadFade === fade) threadFade = null;
      },
    };
    threadFade = fade;
    return fade;
  }
  // A thread opened from anywhere (⌘K, a link, search, the sidebar): remembered for
  // its profile, and when it belongs to another profile, that profile opens.
  let routeSeen = null;
  let routeSettled = false;
  function followRoute() {
    const thread = currentThread();
    if (thread !== routeSeen) {
      routeSeen = thread;
      routeSettled = false;
    }
    if (!thread || routeSettled || slide || landing) return;
    const owner = threadProfile(thread);
    if (owner === null) return; // pinned, settled, not rendered yet: decided when known
    routeSettled = true;
    if (openLater !== null) {
      const wanted = openLater;
      openLater = null;
      if (wanted === state.active && owner !== state.active && !(opening && opening.thread === thread)) {
        openThreadOf(state.active);
        return;
      }
    }
    // One this window opened for a switch: not a thread opened from elsewhere. Only the
    // newest such request counts as current; an older one landing late is overtaken.
    const own = opening && Date.now() - opening.at < 1500;
    if (own && opening.thread !== thread) return;
    if (own) opening = null;
    if (getOwn(state.last, owner) !== thread) {
      state = { ...state, last: { ...(state.last ?? {}), [owner]: thread } };
      persistSoon();
    }
    // One this window opened for a switch that a later switch overtook (it opened no
    // thread of its own, or not yet): no switching back to it.
    if (owner !== state.active && !own) switchTo(owner, 0, { open: false });
  }
  // The open thread is written down a moment later, not on every navigation.
  let persistTimer = null;
  function persistSoon() {
    win.clearTimeout(persistTimer);
    persistTimer = win.setTimeout(() => {
      persistTimer = null;
      if (!running) return;
      saving = saving.catch(() => {}).then(write);
      saving.catch(() => {}); // turned down: written with the next save (as in save())
    }, 400);
  }

  function step(delta) {
    const i = state.list.findIndex((p) => p.id === state.active);
    const next = state.list[i + delta];
    if (next) switchTo(next.id, delta);
  }

  // ---------- The slide ----------
  // Like Dia: the open profile's list slides away sideways and the next profile's
  // slides in beside it, both moving with the fingers on a swipe. The next one is a
  // copy of T3's list laid out as the switch will leave it (the other profiles'
  // folders are rendered, only hidden); when it is in place, the real list takes
  // over in one frame. Transform only, so the compositor runs it: it keeps moving
  // while T3 draws the profile's thread, which is asked for once it has started.
  // Where the app shows a view of its own in the list's place (the Status view), that
  // view slides the same way: the app makes its copy (setSlideView).
  const SLIDE_MS = 240;
  const SLIDE_GAP = 12;
  const SLIDE_EASE = "cubic-bezier(0.25, 1, 0.5, 1)";
  const SLIDING_ATTR = "data-t3plus-profile-sliding";
  // Nothing in the copy can be found, focused or clicked: T3's and t3+'s own lookups
  // (rows, folders, ids, the Status view's threads) find the real one only.
  // data-sidebar-parent stays (styles).
  const COPY_DROP = ["id", T3_ATTRS.threadItem, "data-testid", T3_ATTRS.sidebarRow, T3PLUS.statusThreadAttr, "tabindex", "aria-controls", "aria-labelledby", "aria-describedby", "aria-owns", "aria-activedescendant"];
  const DROPPED = new Set(COPY_DROP);
  const HAS_DROPPED = COPY_DROP.map((name) => `[${name}]`).join(", ");
  let slide = null;
  let landing = false; // inside land(): a route followed now waits for the next check
  // Each profile's place in the list (this window only): back to where you were.
  const scrollTops = new Map();
  const reducedMotion = () => Boolean(win.matchMedia?.("(prefers-reduced-motion: reduce)").matches);
  // The app's own view in T3's list's place, when it has one (setSlideView).
  let slideView = null;
  /** What a switch slides: the app's view while it shows (the Status view), else T3's list. */
  function slideSurface() {
    const own = slideView?.element() ?? null;
    return own ? { el: own, view: slideView } : { el: folderList(), view: null };
  }
  // Only what is on screen slides: a hidden one switches at once.
  const canSlide = () => {
    const { el } = slideSurface();
    return Boolean(el?.animate) && !reducedMotion() && (typeof el.checkVisibility !== "function" || el.checkVisibility());
  };
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  // Past the first or last profile the list gives a little and springs back.
  const rubber = (x, d) => Math.sign(x) * (1 - 1 / ((Math.abs(x) * 0.55) / d + 1)) * d * 0.35;
  const unrubber = (x, d) => {
    const k = 1 / Math.max(0.05, 1 - Math.abs(x) / (d * 0.35)) - 1;
    return (Math.sign(x) * k * d) / 0.55;
  };

  /** Starts a slide toward profile `id` (null: none that way, the list only gives). */
  function beginSlide(id, dir) {
    for (let i = 0; slide && i < 3; i += 1) landNow(); // never two at once
    const { el, view } = slideSurface();
    const group = el?.parentElement;
    if (!el?.animate || !group || !dir) return null;
    // Everything measured before anything is written: each read after a write was a
    // forced style recalc (and layout) of its own.
    const box = el.getBoundingClientRect();
    if (!(box.width > 0)) return null;
    const outer = group.getBoundingClientRect();
    const scroller = el.closest(T3_SELECTORS.sidebarScroller);
    const placed = win.getComputedStyle(group).position !== "static";
    const s = {
      // `el`: what slides out (T3's list, or the app's `view` in its place).
      id: null, dir, el, view, group, scroller, ghost: null, anims: [], timer: null,
      phase: "drag", committed: false, navPending: false, open: false, apply: null, target: null, fade: null,
      pairs: [], copies: new Map(), watch: null, changed: new Set(), redraw: null,
      left: box.left - outer.left - group.clientLeft, top: box.top - outer.top - group.clientTop,
      width: box.width, height: el.offsetHeight, distance: Math.round(box.width) + SLIDE_GAP,
      // Where the list is scrolled to (the slide reads it no more after this).
      scrollTop: scroller?.scrollTop ?? 0,
      x: 0, y: 0, raw: 0, v: 0, from: 0, to: 0, moves: [], position: null,
    };
    scrollTops.set(state.active, s.scrollTop);
    group.setAttribute(SLIDING_ATTR, "");
    if (!placed) {
      s.position = group.style.position;
      group.style.position = "relative";
    }
    el.style.willChange = "transform";
    if (view) view.hold(); // it goes out as it is
    else {
      // A row shown in the copy that changes while it slides (T3 moves the open-thread
      // highlight; the app draws the profile's own bot look): its copy follows (refreshCopy).
      s.watch = win.MutationObserver ? new win.MutationObserver((records) => noteChanges(s, records)) : null;
      s.watch?.observe(el, { subtree: true, childList: true, attributes: true, characterData: true });
    }
    slide = s;
    setTarget(s, id, dir);
    return s;
  }
  /** The profile coming in from side `dir`: a copy of the list (or the app's view) as it would show. */
  function setTarget(s, id, dir) {
    // The changes so far are the copy's going out (each kept copy has its own).
    noteChanges(s, s.watch?.takeRecords() ?? []);
    if (s.ghost) s.copies.set(s.id, { ghost: s.ghost, pairs: s.pairs, changed: s.changed, redraw: s.redraw });
    s.ghost?.remove();
    s.ghost = null;
    s.pairs = [];
    s.changed = new Set();
    s.redraw = null;
    s.id = id;
    s.dir = dir;
    if (!id) return;
    // Shown at the place it was left at (the top, the first time).
    s.y = s.scrollTop - (scrollTops.get(id) ?? 0);
    // Back and forth across the start of a swipe: the copy made the first time, with
    // what changed in its rows while another was shown.
    const kept = s.copies.get(id);
    if (kept) {
      s.ghost = kept.ghost;
      s.pairs = kept.pairs;
      s.changed = kept.changed;
      s.redraw = kept.redraw;
      s.group.append(s.ghost);
      refreshCopy(s);
      placeSlide(s);
      return;
    }
    const ghost = s.view ? viewCopy(s, id) : listCopy(s, id);
    unfind(ghost);
    ghost.setAttribute(T3PLUS.ownedAttr, "");
    ghost.setAttribute("data-t3plus-profile-next", "");
    ghost.setAttribute("aria-hidden", "true");
    ghost.setAttribute("inert", "");
    ghost.removeAttribute("style");
    Object.assign(ghost.style, {
      position: "absolute", left: `${s.left}px`, top: `${s.top}px`, width: `${s.width}px`,
      minHeight: `${s.height}px`, margin: "0", pointerEvents: "none", willChange: "transform",
    });
    s.group.append(ghost);
    s.ghost = ghost;
    placeSlide(s);
  }
  /** T3's list as profile `id` shows it: its rows, each paired with its copy (refreshCopy). */
  function listCopy(s, id) {
    const ghost = s.el.cloneNode(false);
    // The rows that profile shows; the others (most of the list) as empty hidden
    // stand-ins, so first-child and sibling styles come out as in the real list.
    for (const item of s.el.children) {
      if (shownIn(item, id)) {
        const copy = copyItem(item, true);
        s.pairs.push([item, copy]);
        ghost.append(copy);
      } else {
        const stub = item.cloneNode(false);
        unfind(stub);
        stub.setAttribute(OFF_ATTR, "");
        ghost.append(stub);
      }
    }
    return ghost;
  }
  /** The app's view as profile `id` shows it, drawn by the app (and again by `redraw`). */
  function viewCopy(s, id) {
    const { element, redraw } = s.view.copyFor(id);
    s.redraw = redraw;
    unfindInside(element);
    return element;
  }
  /** The project a row of the list belongs to: a folder's, or a thread's in a folder (directly or nested under one of its threads; else null). */
  function rowProject(item) {
    if (item.matches(T3_SELECTORS.projectFolderItem)) {
      const header = item.querySelector(T3_SELECTORS.folderHeader);
      return header ? folderProject(header) : null;
    }
    if (!item.matches(T3_SELECTORS.threadItem)) return null;
    return parentProject(rowParentOf(item.querySelector(T3_SELECTORS.rowParent)));
  }
  // Rows of no project (pinned and settled threads, headings) show in every profile.
  const shownIn = (item, id) => {
    const project = rowProject(item);
    return project === null || profileOf(state, project) === id;
  };
  /** Drops what lets `el` itself be found, focused or clicked (COPY_DROP). */
  function unfind(el) {
    const { attributes } = el;
    for (let i = attributes.length - 1; i >= 0; i -= 1) if (DROPPED.has(attributes[i].name)) el.removeAttribute(attributes[i].name);
  }
  /** The same for everything inside `root`: only the elements that carry one of them (most carry none). */
  function unfindInside(root) {
    for (const el of root.querySelectorAll(HAS_DROPPED)) unfind(el);
  }
  /** A row of the list (a folder, a thread, a heading) as it shows in the profile coming in (`shown`: it is one of its). */
  function copyItem(item, shown) {
    const copy = item.cloneNode(true);
    copy.toggleAttribute(OFF_ATTR, !shown);
    unfind(copy);
    unfindInside(copy);
    return copy;
  }
  /** Marks the rows of the list a change happened in (the slide's watch reports it), for
   *  the copy shown and the ones kept from earlier in the swipe. */
  function noteChanges(s, records) {
    for (const record of records) {
      let el = record.target;
      while (el && el.parentNode !== s.el) el = el.parentNode;
      if (!el) continue;
      s.changed.add(el);
      for (const kept of s.copies.values()) kept.changed.add(el);
    }
  }
  /** What the copy shows changed (T3 moved the open-thread highlight as the thread opened
   *  mid-slide; the profile's own settings decorated a row another way): a row shown in it
   *  is copied again, so the real list takes over with nothing on it changing. */
  function refreshCopy(s) {
    if (s.redraw) {
      // A copy of the app's view: the app draws it again, its new parts unfindable too.
      if (s.redraw()) unfindInside(s.ghost);
      return;
    }
    noteChanges(s, s.watch?.takeRecords() ?? []);
    if (!s.changed.size) return;
    // Screenshot mode covers T3's text after this check: a fresh copy could show it.
    if (!isDemo()) {
      for (const pair of s.pairs) {
        const [item, copy] = pair;
        if (!s.changed.has(item) || !item.isConnected) continue;
        pair[1] = copyItem(item, shownIn(item, s.id));
        copy.replaceWith(pair[1]);
      }
    }
    s.changed.clear();
  }
  const shift = (x, y = 0) => `translate3d(${x}px, ${y}px, 0)`;
  function placeSlide(s) {
    s.el.style.transform = shift(s.x);
    if (s.ghost) s.ghost.style.transform = shift(s.x + s.dir * s.distance, s.y);
  }
  /** Runs a switch to `id` as a slide (or at once, with nothing to slide). */
  function slideTo(id, dir, { open = false, apply }) {
    openLater = open && !onThreadPage() ? id : null;
    const s = canSlide() ? beginSlide(id, dir) : null;
    if (!s) {
      const scroller = folderList()?.closest(T3_SELECTORS.sidebarScroller) ?? null;
      const at = scroller?.scrollTop ?? null;
      if (scroller) scrollTops.set(state.active, at);
      // Asked for first: T3 draws the thread while the sidebar changes.
      if (open) openThreadOf(id);
      apply();
      placeList(scroller, id, open, at);
      flashName(id);
      return;
    }
    s.apply = apply;
    s.open = open;
    settle(s, true, SLIDE_MS);
  }
  /** Lets go: on to the next profile (commit) or back to where it was. */
  function settle(s, commit, duration) {
    s.phase = "settle";
    s.committed = commit && Boolean(s.id);
    const to = s.committed ? -s.dir * s.distance : 0;
    // As fast as the fingers were going, within reason.
    const ms = duration ?? Math.round(clamp(Math.abs(to - s.x) / Math.max(Math.abs(s.v), 0.9), 120, 260));
    // Its dot, its name and sky, and its settings drawn (renderDots shows the one sliding in).
    if (s.committed) renderDots();
    for (const a of s.anims) a.cancel();
    // Where the list goes from and to: resume() works out where it is in between.
    s.from = s.x;
    s.to = to;
    const run = (el, from, end, y) =>
      el.animate([{ transform: shift(from, y) }, { transform: shift(end, y) }], { duration: ms, easing: SLIDE_EASE, fill: "forwards" });
    s.anims = [run(s.el, s.x, to, 0)];
    if (s.ghost) s.anims.push(run(s.ghost, s.x + s.dir * s.distance, to + s.dir * s.distance, s.y));
    s.anims[0].onfinish = () => land(s);
    // The finish event needs the page to be painting; the switch must happen regardless.
    s.timer = win.setTimeout(() => land(s), ms + 150);
    if (s.committed && s.open) {
      s.navPending = true;
      // The thread to open, found once (each look scans the whole list). The chat fades
      // out with the slide when there is one.
      s.target = threadFor(s.id);
      s.fade = s.target ? fadeOut() : null;
      // Once the slide (and the fade) run on the compositor, T3 may take the main thread
      // to draw the thread.
      const go = () => {
        if (!s.navPending) return;
        s.navPending = false;
        openThreadOf(s.id, s.fade, s.target);
      };
      Promise.all([...s.anims, ...(s.fade ? [s.fade.out] : [])].map((a) => a.ready)).then(() => win.requestAnimationFrame(() => win.setTimeout(go, 0)), go);
    }
  }
  /** The slide is over: the real list (or the app's view) takes the copy's place, in the same frame. */
  function land(s) {
    if (slide !== s) return;
    slide = null;
    s.watch?.disconnect();
    win.clearTimeout(s.timer);
    for (const a of s.anims) a.cancel();
    s.el.style.removeProperty("transform");
    s.el.style.removeProperty("will-change");
    s.ghost?.remove();
    s.group.removeAttribute(SLIDING_ATTR);
    if (s.position !== null) s.group.style.position = s.position;
    if (!s.committed) {
      renderDots();
      s.view?.release();
      return;
    }
    landing = true;
    try {
      s.apply?.();
    } finally {
      landing = false;
    }
    // The app's view shows the profile that slid in, in the frame its copy goes.
    s.view?.release();
    placeList(s.scroller, s.id, s.open, s.scrollTop);
    // Not asked for yet (a window in the background paints no frames): now.
    if (s.navPending) {
      s.navPending = false;
      openThreadOf(s.id, s.fade, s.target);
    }
    // A route that wanted following while it slid (a thread of another profile opened):
    // once whatever landed it (a click, a key, a swipe) has started its own switch.
    win.setTimeout(() => {
      if (running && !slide) followRoute();
    }, 0);
  }
  /** The list where it was left in profile `id` (`at`: where it is scrolled to now, kept
   *  without a write, which forced a layout even unchanged); switched because one of its
   *  threads opened (⌘K, a link), that thread's row in view. */
  function placeList(scroller, id, open, at) {
    const top = scrollTops.get(id) ?? 0;
    if (scroller && top !== at) scroller.scrollTop = top;
    if (!open) rowOf(sidebarInner(), currentThread() ?? "")?.scrollIntoView?.({ block: "nearest" });
  }
  /** Fingers back on the pad while the list springs back: it carries on from where it is. */
  function resume(s) {
    // Where it is on screen, from how far the spring back has eased (its computed
    // transform, read mid-gesture right after a write, was a forced style recalc).
    const x = s.from + (s.to - s.from) * eased(s.anims[0]);
    for (const a of s.anims) a.cancel();
    s.anims = [];
    win.clearTimeout(s.timer);
    s.phase = "drag";
    s.x = x;
    s.raw = s.id ? x : unrubber(x, s.distance);
    s.moves = [];
    s.v = 0;
    placeSlide(s);
  }
  /** Ends a slide now: one let go goes where it was going, one still under the fingers goes back. */
  function landNow({ navigate = true } = {}) {
    const s = slide;
    if (!s) return;
    if (s.phase === "drag") s.committed = false;
    if (!navigate && s.navPending) {
      s.navPending = false;
      s.fade?.show(); // its thread is not opened: the chat back (or the next switch's fade takes over)
    }
    land(s);
  }

  // ---------- Rename / delete (right-click or double-click a dot) ----------
  let editor = null;
  let editorCommit = null;
  function closeEditor(refocus = false) {
    const id = editor?.dataset.profile;
    const hadFocus = editor?.contains(doc.activeElement);
    editor?.remove();
    editor = null;
    editorCommit = null;
    // Closed from the keyboard (Escape, Enter): back to the profile's dot, not lost to
    // <body> (the open profile's, when its own was deleted).
    if (refocus || hadFocus) (dots.querySelector(`.t3plus-profile-dot[data-profile="${id}"]`) ?? dots.querySelector('.t3plus-profile-dot[tabindex="0"]'))?.focus();
  }
  function openEditor(id) {
    if (editorCommit) editorCommit(); // the name being typed in the open one is kept
    else closeEditor();
    const profile = state.list.find((p) => p.id === id);
    if (!profile) return;
    editor = doc.createElement("div");
    editor.className = "t3plus-profile-editor";
    editor.setAttribute(T3PLUS.ownedAttr, "");
    editor.dataset.profile = id;
    const input = doc.createElement("input");
    input.type = "text";
    input.value = profile.name;
    input.maxLength = 32;
    input.setAttribute("aria-label", "Profile name");
    const remove = doc.createElement("button");
    remove.type = "button";
    remove.className = "t3plus-profile-delete";
    remove.setAttribute("aria-label", "Delete profile");
    // lucide "trash-2", T3's icon set.
    remove.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/><line x1="10" x2="10" y1="11" y2="17"/><line x1="14" x2="14" y1="11" y2="17"/></svg>';
    // The first profile holds every project nobody moved: it cannot be deleted.
    const isFirst = state.list[0].id === id;
    remove.title = `Delete (its projects move to ${shownName(state.list[0], 0)})`;
    const self = editor;
    const commit = (refocus = false) => {
      if (editor !== self) return;
      editorCommit = null;
      const value = input.value.trim();
      if (value && value !== profile.name) save({ ...state, list: state.list.map((p) => (p.id === id ? { ...p, name: value } : p)) });
      closeEditor(refocus);
    };
    editorCommit = commit;
    // For the whole editor, not just the name field: tabbing on through the delete
    // button and the swatches left it open for good, and dropped the typed name.
    editor.addEventListener("keydown", (e) => {
      e.stopPropagation(); // typing here is not a T3 shortcut
      if (e.key === "Escape") {
        e.preventDefault();
        closeEditor(true);
      } else if (e.key === "Enter" && e.target === input) {
        e.preventDefault();
        commit(true);
      }
    });
    editor.addEventListener("focusout", () => win.setTimeout(() => editor === self && !self.contains(doc.activeElement) && commit(), 0));
    remove.addEventListener("click", () => {
      if (state.list[0].id === id) return;
      const list = state.list.filter((p) => p.id !== id);
      // Its projects go back to the first profile (still placed: they are not new).
      const projects = Object.fromEntries(Object.entries(state.projects).map(([k, pid]) => [k, pid === id ? list[0].id : pid]));
      const wasActive = state.active === id;
      const last = { ...(state.last ?? {}) };
      delete last[id];
      save({ ...state, list, projects, last, active: wasActive ? list[0].id : state.active });
      onDelete?.(id);
      closeEditor();
      if (wasActive) openThreadOf(list[0].id);
    });
    // Arrow keys move (and pick) within a row of choices; one Tab stop each.
    const roving = (group, selector) => {
      group.addEventListener("keydown", (e) => {
        const step = { ArrowLeft: -1, ArrowUp: -1, ArrowRight: 1, ArrowDown: 1 }[e.key];
        if (!step) return;
        e.preventDefault();
        const all = [...group.querySelectorAll(selector)];
        const next = all[(all.indexOf(doc.activeElement) + step + all.length) % all.length];
        next.focus();
        next.click();
      });
    };
    const keepFocus = (el) => el.addEventListener("pointerdown", (e) => e.preventDefault()); // the name field keeps it
    const pick = (group, chosen) => {
      for (const el of group.querySelectorAll("[role=radio]")) {
        el.setAttribute("aria-checked", String(el === chosen));
        el.tabIndex = el === chosen ? 0 : -1;
      }
      if (!group.contains(doc.activeElement)) input.focus();
    };
    const change = (patch) => {
      Object.assign(profile, patch);
      save({ ...state, list: state.list.map((p) => (p.id === id ? { ...p, ...patch } : p)) });
    };

    // Its icon, shown before its name.
    const icons = doc.createElement("div");
    icons.className = "t3plus-profile-icons";
    icons.setAttribute("role", "radiogroup");
    icons.setAttribute("aria-label", "Icon");
    for (const key of [null, ...Object.keys(PROFILE_ICONS)]) {
      const b = doc.createElement("button");
      b.type = "button";
      b.className = "t3plus-profile-icon-pick";
      b.setAttribute("role", "radio");
      b.setAttribute("aria-label", key ? PROFILE_ICONS[key].label : "No icon");
      b.title = b.getAttribute("aria-label");
      const on = (profile.icon ?? null) === key;
      b.setAttribute("aria-checked", String(on));
      b.tabIndex = on ? 0 : -1;
      if (key) b.innerHTML = profileIconSvg(key, 13);
      keepFocus(b);
      b.addEventListener("click", () => {
        change({ icon: key });
        pick(icons, b);
      });
      icons.append(b);
    }
    roving(icons, "[role=radio]");

    // One row of colors for the dot, the sky, the glow or the chat bubbles (the same
    // choices), and which of them it colors. The dot and the sky are the profile's own;
    // the glow and bubble colors are its settings (shown in Settings too), so "Default"
    // there means the one set for all profiles.
    const SCOPED_FIELDS = { glow: "composerGradient.accent", bubble: "chat.bubble" };
    const fields = [["color", "Dot"], ...(skyTint && nightSky() ? [["sky", "Sky"]] : []), ...(scoped ? [["glow", "Glow"], ["bubble", "Bubble"]] : [])];
    const presetOf = (hex) => Object.entries(PROFILE_COLORS).find(([, h]) => h === hex)?.[0] ?? null;
    // As stored now (Settings or another window may have changed it since it opened).
    const valueOf = (f) => {
      if (!Object.hasOwn(SCOPED_FIELDS, f)) return (state.list.find((p) => p.id === id) ?? profile)[f] ?? "default";
      const value = scoped.get(id, SCOPED_FIELDS[f]);
      return typeof value === "string" && HEX_COLOR.test(value) ? (presetOf(value) ?? value) : "default";
    };
    const setValue = (f, value) => {
      if (Object.hasOwn(SCOPED_FIELDS, f)) scoped.set(id, SCOPED_FIELDS[f], value === "default" ? null : profileHex(value));
      else change({ [f]: value });
    };
    let field = "color";
    const tabs = doc.createElement("div");
    tabs.className = "t3plus-profile-tabs";
    tabs.setAttribute("role", "group");
    tabs.setAttribute("aria-label", "Color of");
    const swatches = doc.createElement("div");
    swatches.className = "t3plus-profile-colors";
    swatches.setAttribute("role", "radiogroup");
    roving(swatches, "[role=radio]");
    const paint = () => {
      const label = fields.find(([f]) => f === field)[1];
      for (const t of tabs.children) t.setAttribute("aria-pressed", String(t.dataset.field === field));
      swatches.dataset.field = field;
      swatches.setAttribute("aria-label", `${label} color`);
      swatches.replaceChildren();
      const current = valueOf(field);
      const choices = Object.entries(PROFILE_COLORS);
      // A custom color (made in Settings → t3+) shows as one more choice, picked.
      if (HEX_COLOR.test(current)) choices.push([current, current]);
      for (const [value, hex] of choices) {
        const swatch = doc.createElement("button");
        swatch.type = "button";
        swatch.className = "t3plus-profile-swatch";
        swatch.setAttribute("role", "radio");
        const name = value === "default" ? "Default" : HEX_COLOR.test(value) ? "Custom" : value[0].toUpperCase() + value.slice(1);
        swatch.setAttribute("aria-label", name);
        swatch.title = value !== "default" ? name : field === "sky" ? "Default (T3's sky)" : Object.hasOwn(SCOPED_FIELDS, field) ? "Default (the one for all profiles, Settings → t3+)" : name;
        swatch.setAttribute("aria-checked", String(current === value));
        swatch.tabIndex = current === value ? 0 : -1;
        if (hex) swatch.style.setProperty("--t3plus-profile-color", hex);
        keepFocus(swatch);
        swatch.addEventListener("click", () => {
          setValue(field, value);
          pick(swatches, swatch);
        });
        swatches.append(swatch);
      }
    };
    for (const [f, label] of fields) {
      const t = doc.createElement("button");
      t.type = "button";
      t.className = "t3plus-profile-tab";
      t.dataset.field = f;
      t.textContent = label;
      keepFocus(t);
      t.addEventListener("click", () => {
        field = f;
        paint();
      });
      tabs.append(t);
    }
    paint();
    const row = doc.createElement("div");
    row.className = "t3plus-profile-editor-row";
    row.append(input);
    if (!isFirst) row.append(remove);
    editor.append(row, icons, tabs, swatches);
    bar.append(editor);
    input.focus();
    input.select();
  }
  dots.addEventListener("click", (event) => {
    const dot = event.target.closest?.(".t3plus-profile-dot");
    if (!dot) return;
    if (dot.dataset.profile === "+new") {
      // A new profile still sliding in: a second click (a double-click) makes no other.
      if (slide?.committed && !state.list.some((p) => p.id === slide.id)) return;
      useUp(gesture);
      landNow();
      const id = newProfileId();
      const profile = { id, name: nextName(state.list), color: nextColor(state.list) };
      slideTo(id, 1, {
        apply: () => {
          save({ ...state, list: [...state.list, profile], active: id });
          flashName();
          openEditor(id);
        },
      });
      return;
    }
    // Pressed from the keyboard (Enter or Space on a focused dot: a click with no detail).
    const fromKeys = event.detail === 0 && doc.activeElement === dot;
    switchTo(dot.dataset.profile);
    if (fromKeys) holdFocus();
  });
  // T3 puts the focus in the composer when it opens a thread. A switch made from the
  // keyboard on the dots keeps it on them (the arrows go on to the next profile),
  // unless you click or press a key first.
  // (Checked each frame: in a window without the system focus, focus moves fire no events.)
  let releaseFocus = null;
  function holdFocus() {
    releaseFocus?.();
    const until = win.performance.now() + 1500;
    let frame = 0;
    let times = 0;
    const check = () => {
      const active = doc.activeElement;
      // Not from a dialog T3 opened (an approval, a prompt), and not over and over.
      if (win.performance.now() > until || times >= 2 || active?.closest?.('dialog, [role="dialog"], [role="alertdialog"], [aria-modal="true"]')) {
        releaseFocus?.();
        return;
      }
      if (!bar.contains(active)) {
        times += 1;
        dots.querySelector('.t3plus-profile-dot[aria-pressed="true"]')?.focus({ preventScroll: true });
      }
      frame = win.requestAnimationFrame(check);
    };
    frame = win.requestAnimationFrame(check);
    const done = () => releaseFocus?.();
    doc.addEventListener("pointerdown", done, true);
    doc.addEventListener("keydown", done, true);
    releaseFocus = () => {
      win.cancelAnimationFrame(frame);
      doc.removeEventListener("pointerdown", done, true);
      doc.removeEventListener("keydown", done, true);
      releaseFocus = null;
    };
  }
  dots.addEventListener("dblclick", (event) => {
    const dot = event.target.closest?.(".t3plus-profile-dot");
    if (dot && dot.dataset.profile !== "+new") openEditor(dot.dataset.profile);
  });
  dots.addEventListener("contextmenu", (event) => {
    const dot = event.target.closest?.(".t3plus-profile-dot");
    if (!dot || dot.dataset.profile === "+new") return;
    event.preventDefault();
    openEditor(dot.dataset.profile);
  });
  // Keyboard: arrows (and Home/End) move between the dots, Enter or Space opens one
  // (a button's click), F2 renames it (the context-menu key opens the editor too).
  dots.addEventListener("keydown", (event) => {
    const dot = event.target.closest?.(".t3plus-profile-dot");
    if (!dot || event.altKey || event.ctrlKey || event.metaKey) return;
    if (event.key === "F2" && dot.dataset.profile !== "+new") {
      event.preventDefault();
      openEditor(dot.dataset.profile);
      return;
    }
    const all = [...dots.querySelectorAll(".t3plus-profile-dot")];
    const i = all.indexOf(dot);
    const to = { ArrowLeft: i - 1, ArrowUp: i - 1, ArrowRight: i + 1, ArrowDown: i + 1, Home: 0, End: all.length - 1 }[event.key];
    if (to === undefined) return;
    event.preventDefault();
    event.stopPropagation(); // T3's sidebar arrow-key navigation is for its rows
    const next = all[(to + all.length) % all.length];
    for (const el of all) el.tabIndex = el === next ? 0 : -1;
    next.focus();
  });

  // ---------- Swipe (two-finger horizontal scroll on the sidebar) ----------
  // The listener sits on the sidebar, and only while profiles are on. It is passive:
  // it never cancels a wheel event. The sidebar has nothing to scroll sideways, and a
  // canceled first event kept Chromium from starting its scroll gesture, so T3 never
  // reported the touch (trackpad.onBegin) that tells one swipe from the next.
  let wheelHost = null;
  function watchWheel(host) {
    if (host === wheelHost) return;
    wheelHost?.removeEventListener("wheel", onWheel, { capture: true });
    wheelHost = host;
    wheelHost?.addEventListener("wheel", onWheel, { capture: true, passive: true });
  }
  // One gesture: wheel events with no pause longer than this. After it, the
  // fingers (and the momentum that follows them) have stopped. Wheel events cannot
  // tell fingers resting on the pad from lifted ones: long enough for a hesitation.
  const SWIPE_IDLE_MS = 140;
  // A swipe that has switched swallows what follows it (the momentum, and events T3's
  // drawing of the thread held back) until the fingers touch the trackpad again: T3's
  // desktop app reports each touch (trackpad.onBegin, as its own back/forward swipe
  // uses). Without that report (the Chrome extension), until a pause this long, or
  // until the fingers go the other way. A pause alone made a quick second swipe part
  // of the first one's momentum: it moved nothing until you stopped (or clicked).
  const SWIPE_DONE_MS = 260;
  // Each touch is reported once, and separately from the wheel events: before a
  // gesture's first event (then the gesture starts at most this long after it) or
  // after it (T3 busy). A gesture takes the first report that is its own; only a
  // report after that is a new touch. A report that came late for its own gesture,
  // taken for a new touch, ended a fast flick early: its momentum switched twice.
  const TOUCH_LEAD_MS = 120;
  // ...counted in painted frames as well: while T3 draws the thread no frames are
  // painted, and the momentum it held back arrives all at once afterwards.
  const SWIPE_DONE_FRAMES = 8;
  function countQuiet(g) {
    win.cancelAnimationFrame?.(g.frame);
    if (!win.requestAnimationFrame) {
      g.quiet = SWIPE_DONE_FRAMES; // no frames to count: the time alone
      return;
    }
    g.quiet = 0;
    const tick = () => {
      g.quiet += 1;
      if (gesture === g && g.quiet < SWIPE_DONE_FRAMES) g.frame = win.requestAnimationFrame(tick);
    };
    g.frame = win.requestAnimationFrame(tick);
  }
  /** The swipe in progress has done its switch (or another switch replaced it): the rest of it moves nothing. */
  function useUp(g, sign = 0) {
    if (!g) return;
    g.done = true;
    g.sign = sign;
    countQuiet(g);
  }
  // ---------- T3's own trackpad back/forward swipe ----------
  // T3 turns a two-finger swipe anywhere outside a dialog or a sideways scroller into a
  // step back or forward in history (window.history.back / forward), with an arrow at
  // the window's edge. Over the sidebar that swipe switches profiles here: while one
  // lasts (and its momentum, and T3's end of it), T3's arrow is hidden and its step is
  // not taken. It went back a thread (another profile's) under a profile switch.
  // T3 takes its step when the gesture ends (fingers lifted, momentum over), which may be
  // long after the last wheel event (fingers resting): with T3's report of that end the
  // guard holds until it (and a moment more); without it, a while after the last event.
  const SWIPE_GUARD_MS = 400;
  const GUARD_HOLD_MAX_MS = 15_000; // never stuck if an end report is lost
  let guardUntil = -Infinity;
  let guardHeld = false;
  let guardTimer = null;
  let endReports = false; // T3's end reports are subscribed to
  // No touch in progress: none reported yet, or this gesture's end was (wheel events held
  // back may come after it). A sideways wheel with no touch reported is a mouse's (a thumb
  // wheel, Shift+wheel): no end report follows it (held for one, T3's own back and forward
  // were dropped for 15 s).
  let ended = true;
  function guardSwipe() {
    guardHeld = endReports && !ended;
    guardUntil = win.performance.now() + (guardHeld ? GUARD_HOLD_MAX_MS : SWIPE_GUARD_MS);
    if (!doc.documentElement.hasAttribute("data-t3plus-profile-swipe")) doc.documentElement.setAttribute("data-t3plus-profile-swipe", "");
    win.clearTimeout(guardTimer);
    guardTimer = win.setTimeout(endGuard, (guardHeld ? GUARD_HOLD_MAX_MS : SWIPE_GUARD_MS) + 20);
  }
  /** T3 reports the gesture's end: the guard lasts a moment more (T3 steps right then), then ends. */
  function onTouchEnd() {
    ended = true;
    if (gesture) gesture.ended = true; // a touch reported after this is another gesture's
    if (!guardHeld) return;
    guardHeld = false;
    guardUntil = win.performance.now() + 150;
    win.clearTimeout(guardTimer);
    guardTimer = win.setTimeout(endGuard, 170);
  }
  function endGuard() {
    guardHeld = false;
    win.clearTimeout(guardTimer);
    guardTimer = null;
    guardUntil = -Infinity;
    doc.documentElement.removeAttribute("data-t3plus-profile-swipe");
  }
  let historyHooks = null; // { back, forward }: what t3+ put on window.history
  function hookHistory() {
    const history = win.history;
    if (!history || historyHooks) return;
    historyHooks = {};
    for (const name of ["back", "forward"]) {
      const step = history[name];
      if (typeof step !== "function") continue;
      // Its own property, over History's: deleted again on stop (unless replaced since).
      const hook = function (...args) {
        if (win.performance.now() < guardUntil) return undefined;
        return step.apply(this, args);
      };
      history[name] = hook;
      historyHooks[name] = hook;
    }
  }
  function unhookHistory() {
    for (const [name, hook] of Object.entries(historyHooks ?? {})) if (win.history?.[name] === hook) delete win.history[name];
    historyHooks = null;
    endGuard();
  }

  let gesture = null; // { at, touched, ended, axis, sx, sy, raw, last, slows, done, sign, quiet, frame }
  let swipeTimer = null;
  let touchAt = -Infinity;
  /** Fingers on the trackpad: a swipe that has switched is over, and the next one is new. */
  function onTouchBegin() {
    touchAt = win.performance.now();
    ended = false;
    const g = gesture;
    if (!g) return;
    if (!g.touched && !g.ended) {
      g.touched = true; // its own touch, reported after its first event
      // A sideways swipe's own touch, late (maybe no event after it: fingers resting): the
      // guard holds again until this gesture's end. Not for a later touch (another gesture).
      if (g.axis === "x") guardSwipe();
      return;
    }
    if (!g.done) return;
    win.cancelAnimationFrame?.(g.frame);
    gesture = null;
  }
  let stopTouch = null;
  function onWheel(event) {
    if (!isEnabled() || state.list.length < 2 || event.ctrlKey) return; // ctrl: pinch-zoom
    if (!event.target.closest?.(T3_SELECTORS.sidebarInner)) return;
    const scale = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? 400 : 1;
    const dx = event.deltaX * scale;
    const dy = event.deltaY * scale;
    const t = win.performance.now();
    const g0 = gesture;
    const fresh = !g0
      || (g0.done ? t - g0.at > SWIPE_DONE_MS && g0.quiet >= SWIPE_DONE_FRAMES : t - g0.at > SWIPE_IDLE_MS)
      // After a switch, the other way or up and down: a new gesture (the momentum
      // goes on the way the swipe went).
      || (g0.done && g0.sign && Math.sign(dx) === -g0.sign && Math.abs(dx) >= 3)
      || (g0.done && Math.abs(dy) > Math.abs(dx) * 1.2 && Math.abs(dy) >= 3);
    if (fresh) {
      if (g0) win.cancelAnimationFrame?.(g0.frame);
      gesture = { at: t, touched: t - touchAt < TOUCH_LEAD_MS, ended: false, axis: null, sx: 0, sy: 0, raw: 0, last: 0, slows: 0, done: false, sign: 0, quiet: 0, frame: 0 };
    }
    const g = gesture;
    g.at = t;
    if (g.axis === null) {
      // Sideways or up and down, decided over the first few pixels and kept to the end:
      // scrolling the list never turns into a switch halfway.
      g.sx += dx;
      g.sy += dy;
      if (Math.abs(g.sx) + Math.abs(g.sy) < 4) return;
      g.axis = Math.abs(g.sx) > Math.abs(g.sy) * 1.2 ? "x" : "y";
      if (g.axis === "y") return;
      guardSwipe();
      armSwipeEnd();
      if (g.done) countQuiet(g);
      else drag(-g.sx, t);
      return;
    }
    if (g.axis !== "x") return;
    guardSwipe();
    armSwipeEnd();
    if (g.done) {
      countQuiet(g);
      return;
    }
    drag(-dx, t);
  }
  function armSwipeEnd() {
    win.clearTimeout(swipeTimer);
    swipeTimer = win.setTimeout(endSwipe, SWIPE_IDLE_MS);
  }
  /** The fingers moved the list by `delta` px at time `t` (left is negative: the next profile). */
  function drag(delta, t) {
    const g = gesture;
    g.slows = Math.abs(delta) < Math.abs(g.last) ? g.slows + 1 : 0;
    g.last = -delta;
    if (slide && slide.phase !== "drag") {
      // Springing back: picked up where it is. A switch still landing: landed first,
      // and its profile is the open one.
      if (!slide.committed) resume(slide);
      else landNow();
    }
    const i = state.list.findIndex((p) => p.id === state.active);
    const neighbor = (dir) => state.list[i + dir]?.id ?? null;
    let s = slide;
    if (!s && canSlide()) s = beginSlide(neighbor(delta < 0 ? 1 : -1), delta < 0 ? 1 : -1);
    if (!s) {
      // Nothing to slide (reduced motion): one switch once the fingers have gone far enough.
      g.raw += delta;
      if (Math.abs(g.raw) >= SWIPE_PX) {
        const sign = g.raw < 0 ? 1 : -1; // the way the fingers went (as DOM deltaX)
        step(sign);
        // Used up after the switch, whose own useUp forgets that way: swiping straight back
        // is then a new swipe, as after a slide.
        useUp(g, sign);
      }
      return;
    }
    s.raw += delta;
    // Speed over the last 80 ms of movement (px/ms): a single event says little.
    s.moves.push([t, s.raw]);
    while (s.moves.length > 2 && t - s.moves[0][0] > 80) s.moves.shift();
    const [t0, raw0] = s.moves[0];
    s.v = t - t0 >= 8 ? (s.raw - raw0) / (t - t0) : 0;
    // Back past where it started: the profile on the other side comes in instead.
    const dir = s.raw < 0 ? 1 : s.raw > 0 ? -1 : s.dir;
    if (dir !== s.dir) setTarget(s, neighbor(dir), dir);
    s.x = s.id ? clamp(s.raw, -s.distance, s.distance) : rubber(s.raw, s.distance);
    // The list scrolled under the copy (a swipe that began a little diagonally): kept in line.
    if (s.ghost && s.scroller) {
      s.scrollTop = s.scroller.scrollTop;
      s.y = s.scrollTop - (scrollTops.get(s.id) ?? 0);
    }
    placeSlide(s);
    // All the way over, or let go with the list well on its way (the momentum slowing
    // down): no need to wait for the last of the momentum.
    // (A finger slowing down looks the same as momentum dying out: only well past half.)
    if (s.id && (Math.abs(s.x) >= s.distance || (g.slows >= 6 && Math.abs(s.x) > s.distance * 0.6))) commitSwipe(s);
  }
  function commitSwipe(s) {
    useUp(gesture, -Math.sign(s.raw)); // the way the fingers went (as DOM deltaX)
    s.apply = leave(s.id);
    s.open = true;
    settle(s, true);
  }
  function endSwipe() {
    const s = slide;
    if (s && s.phase === "drag") {
      // A third of the way, or a flick toward the next profile. A commit keeps the
      // gesture (done): what it held back still moves nothing.
      const toward = -s.dir;
      if (s.id && (Math.abs(s.x) > s.distance * 0.3 || (s.v * toward > 0.5 && Math.abs(s.x) > 16))) {
        commitSwipe(s);
        return;
      }
      settle(s, false);
    }
    if (!gesture?.done) gesture = null; // a done one swallows the rest until a longer pause
  }

  // ---------- Drag a folder onto a profile ----------
  let pending = null; // { x, y, project, title, header }
  let dragging = null; // { project, ghost, shield, over }
  let swallowClick = false;
  // While a folder is dragged, a shield over the page holds the grabbing cursor and no
  // text is selected. (A rule for every element did both: each drag's start and drop
  // restyled the whole page.) The dot under the pointer is found through it.
  const dotAt = (x, y, shield) => (doc.elementsFromPoint?.(x, y) ?? []).find((el) => el !== shield)?.closest?.(".t3plus-profile-dot") ?? null;
  const onSelectStart = (event) => {
    if (pending || dragging) event.preventDefault();
  };
  function onPointerDown(event) {
    if (!isEnabled() || event.button !== 0 || event.altKey || event.metaKey || event.ctrlKey) return;
    const header = event.target.closest?.(T3_SELECTORS.folderHeader);
    if (!header || header.closest(`[${T3PLUS.ownedAttr}]`)) return;
    const project = folderProject(header);
    const title = (header.querySelector(T3_SELECTORS.folderTitle)?.textContent || header.textContent || "Project").trim().slice(0, 40);
    pending = { x: event.clientX, y: event.clientY, project, title };
  }
  function onPointerMove(event) {
    if (dragging) {
      // The button is up but no pointerup came (released outside the window, or the
      // app lost focus mid-drag): end the drag instead of dragging the ghost along.
      if ((event.buttons & 1) === 0) {
        endDrag(event, false);
        return;
      }
      dragging.ghost.style.transform = `translate(${event.clientX + 12}px, ${event.clientY + 10}px)`;
      const over = dotAt(event.clientX, event.clientY, dragging.shield);
      for (const dot of dots.children) dot.toggleAttribute("data-over", dot === over);
      dragging.over = over;
      return;
    }
    if (!pending || (event.buttons & 1) === 0) {
      pending = null;
      return;
    }
    if (Math.hypot(event.clientX - pending.x, event.clientY - pending.y) < 6) return;
    const shield = doc.createElement("div");
    shield.className = "t3plus-profile-shield";
    shield.setAttribute(T3PLUS.ownedAttr, "");
    const ghost = doc.createElement("div");
    ghost.className = "t3plus-profile-ghost";
    ghost.setAttribute(T3PLUS.ownedAttr, "");
    ghost.textContent = pending.title;
    ghost.style.transform = `translate(${event.clientX + 12}px, ${event.clientY + 10}px)`;
    doc.body.append(shield, ghost);
    win.getSelection?.()?.removeAllRanges();
    dragging = { project: pending.project, ghost, shield, over: null };
    pending = null;
    doc.documentElement.setAttribute("data-t3plus-profile-drag", "");
    dotsSignature = "";
    renderDots();
  }
  function endDrag(event, drop) {
    if (!dragging) {
      pending = null;
      return;
    }
    const { project, ghost, shield, over } = dragging;
    // Where it was dropped, found while the dots are still open as named chips:
    // closing them first shrank "Main" and "New" away from under the pointer, so
    // a drop on most of their label landed on nothing.
    const hit = drop && Number.isFinite(event.clientX) ? dotAt(event.clientX, event.clientY, shield) : null;
    const target = drop ? (hit && dots.contains(hit) ? hit : over) : null;
    dragging = null;
    ghost.remove();
    shield.remove();
    doc.documentElement.removeAttribute("data-t3plus-profile-drag");
    // The pointerup ends T3's click on the header: keep it from toggling the folder.
    swallowClick = true;
    win.setTimeout(() => (swallowClick = false), 0);
    dotsSignature = "";
    if (!target) {
      renderDots();
      return;
    }
    moveProject(project, target.dataset.profile);
  }
  /** Moves a project folder to the profile `to` ("+new": a new one, its editor opened). */
  function moveProject(project, to) {
    let id = to;
    let list = state.list;
    if (id === "+new") {
      if (list.length >= MAX_PROFILES) return false;
      id = newProfileId();
      list = [...list, { id, name: nextName(list), color: nextColor(list) }];
    } else if (!list.some((p) => p.id === id)) return false;
    // Placed last, as the most recently placed (roomFor); one new to the map may need room.
    const { [project]: _moved, ...rest } = state.projects;
    save({ ...state, list, projects: { ...roomFor(rest, 1), [project]: id } });
    if (to === "+new") openEditor(id);
    return true;
  }

  // ---------- Right-click a folder: "Move to profile" ----------
  // T3's menu for a project folder is a native one, built in the app's main process.
  // The desktop loader adds this submenu to it (inject/main-loader.js): it asks for
  // projectMenu() as the menu opens, and hands back the pick (projectMenuPick).
  const MENU_ID = "t3plus:move:";
  let menuProject = null; // { project, at }: the folder right-clicked last
  function onContextMenu(event) {
    const header = isEnabled() ? event.target.closest?.(T3_SELECTORS.folderHeader) : null;
    menuProject = header && !header.closest(`[${T3PLUS.ownedAttr}]`) ? { project: folderProject(header), at: Date.now() } : null;
  }
  /** The submenu for the folder just right-clicked, or null (none, or profiles off). */
  function projectMenu() {
    if (!running || !loaded || !isEnabled() || !menuProject || Date.now() - menuProject.at > 3000) return null;
    const current = profileOf(state, menuProject.project);
    return {
      id: `${MENU_ID}menu`,
      label: "Move to profile",
      separatorBefore: true,
      children: [
        ...state.list.map((p, i) => ({ id: `${MENU_ID}${p.id}`, label: shownName(p, i), checked: p.id === current, disabled: p.id === current })),
        ...(state.list.length < MAX_PROFILES ? [{ id: `${MENU_ID}+new`, label: "New profile", separatorBefore: true }] : []),
      ],
    };
  }
  /** A pick from that submenu (a menu item id): the folder moves there. */
  function projectMenuPick(itemId) {
    const pending = menuProject;
    menuProject = null;
    if (!running || !loaded || !isEnabled() || !pending || typeof itemId !== "string" || !itemId.startsWith(MENU_ID)) return false;
    const to = itemId.slice(MENU_ID.length);
    if (to === profileOf(state, pending.project)) return false;
    return moveProject(pending.project, to);
  }
  const onPointerUp = (event) => endDrag(event, true);
  // A cancelled pointer (the system took it over) is not a drop.
  const onPointerCancel = (event) => endDrag(event, false);
  const onKeyDown = (event) => {
    if (event.key === "Escape" && dragging) endDrag(event, false);
    // Ctrl+Shift+1..9: open that profile. Cmd+digit stays T3's. Not while the
    // rename field is in use (the editor belongs to the profile being renamed).
    if (!isEnabled() || !event.ctrlKey || !event.shiftKey || event.metaKey || event.altKey) return;
    if (editor?.contains(event.target)) return;
    // In T3's terminal the keys belong to the program running there (vim's Ctrl+^).
    if (event.target?.closest?.(T3_SELECTORS.terminal)) return;
    const n = /^Digit([1-9])$/.exec(event.code)?.[1];
    const target = n && state.list[Number(n) - 1];
    if (!target) return;
    event.preventDefault();
    event.stopPropagation();
    if (event.repeat) return; // held down: one switch
    switchTo(target.id); // its side, from the profile open once any slide has landed
  };
  const onClick = (event) => {
    if (!swallowClick) return;
    swallowClick = false;
    event.preventDefault();
    event.stopPropagation();
  };

  // ---------- Projects nobody has placed ----------
  // Those T3 shows when profiles first keep track go to the first profile, where
  // every project used to belong. One that shows up after that was just added, so it
  // joins the open profile: put in the first one, it vanished as soon as it was made.
  let adoptUntil = null;
  function placeNew(projects) {
    if (!projects.length) return false;
    const t = Date.now();
    // A list without the mark (an older backup imported, a window still on an older
    // t3+) starts a new grace period: its unplaced projects are the existing ones.
    if (state.adopted) adoptUntil = null;
    else adoptUntil ??= t + ADOPT_GRACE_MS;
    const adopting = !state.adopted && t < adoptUntil;
    let fresh = [...new Set(projects)].filter((project) => !Object.hasOwn(state.projects, project));
    let placed = state.projects;
    if (fresh.length) {
      // Past the cap, as many as there is room for (roomFor): the others stay unplaced.
      placed = roomFor(placed, fresh.length);
      fresh = fresh.slice(0, MAX_PROJECTS - Object.keys(placed).length);
    }
    if (!fresh.length && (state.adopted || adopting)) return false;
    const to = adopting ? state.list[0].id : state.active;
    save({ ...state, projects: { ...placed, ...Object.fromEntries(fresh.map((project) => [project, to])) }, ...(adopting ? {} : { adopted: true }) });
    return true;
  }
  // The folders T3 has shown this session (sync). Placed folders are kept up to a cap and
  // nothing else removes one, so the map fills up with deleted projects' and other machines'.
  const seenProjects = new Set();
  /**
   * `projects` (most recently placed last) with room made for `n` more where it is full:
   * the least recently placed of the folders not seen this session go. A folder seen stays
   * (dropped, it would come back as a new one and join the open profile), so with too few
   * others to drop there is less room.
   */
  function roomFor(projects, n) {
    let over = Object.keys(projects).length + n - MAX_PROJECTS;
    if (over <= 0) return projects;
    const kept = {};
    for (const [project, id] of Object.entries(projects)) {
      if (over > 0 && !seenProjects.has(project)) over -= 1;
      else kept[project] = id;
    }
    return kept;
  }

  // ---------- Applying it to T3's sidebar ----------
  // The sidebar with the thread rows (there can be a second, right-hand one), or the
  // first one while it has none yet: the dots show in an empty sidebar too. Looked up
  // once a task: a switch asks for it a dozen times, and each lookup searches the page.
  let innerFound = null;
  let innerKept = false;
  function sidebarInner() {
    if (!innerKept || !innerFound?.isConnected) keepInner(findSidebarInner(doc) ?? doc.querySelector(T3_SELECTORS.sidebarInner));
    return innerFound;
  }
  function keepInner(inner) {
    innerFound = inner;
    if (innerKept) return;
    innerKept = true;
    queueMicrotask(() => {
      innerKept = false;
      innerFound = null;
    });
  }
  // Whether this copy may have hidden rows (from the start: an orphaned copy may have).
  let hidAny = true;
  /** Shows every row t3+ hid: profiles off, or no footer to put the dots in. */
  function showAll() {
    if (!hidAny) return;
    hidAny = false;
    for (const el of doc.querySelectorAll(`[${OFF_ATTR}]`)) {
      el.removeAttribute(OFF_ATTR);
      el.removeAttribute("inert");
    }
  }
  function folderList() {
    const inner = sidebarInner();
    return inner?.querySelector(T3_SELECTORS.projectFolderItem)?.parentElement ?? null;
  }

  /** `found`: the sidebar the app's check found just now (not searched for again). */
  function sync(found = null) {
    if (found) keepInner(found);
    if (!isEnabled() || !loaded) {
      watchWheel(null);
      if (slide) {
        // Profiles turned off mid-switch: dropped, the list (and the chat) as they were.
        slide.committed = false;
        slide.navPending = false;
        slide.fade?.show();
        land(slide);
        gesture = null;
      }
      if (bar.isConnected) bar.remove();
      tintSky(null);
      setShown(null);
      showAll();
      return;
    }
    const inner = sidebarInner();
    const footer = inner?.querySelector(T3_SELECTORS.sidebarFooter);
    watchWheel(inner);
    if (!footer) {
      if (bar.isConnected) bar.remove();
      showAll();
      return;
    }
    if (bar.parentElement !== footer || footer.firstElementChild !== bar) footer.prepend(bar);
    renderDots();
    // Hidden rows are also inert: T3's arrow-key navigation in the sidebar skips
    // [inert] rows, and stopped at a hidden one (display: none takes no focus).
    const hide = (el, off) => {
      if (el.hasAttribute(OFF_ATTR) === off) return;
      el.toggleAttribute(OFF_ATTR, off);
      el.toggleAttribute("inert", off);
      if (off) hidAny = true;
    };
    const folders = [];
    for (const folder of inner.querySelectorAll(T3_SELECTORS.projectFolderItem)) {
      const header = folder.querySelector(T3_SELECTORS.folderHeader);
      if (!header) continue;
      const project = folderProject(header);
      folders.push([folder, project]);
      seenProjects.add(project);
    }
    if (placeNew(folders.map(([, project]) => project))) return; // saved, and synced again with it
    for (const [folder, project] of folders) hide(folder, profileOf(state, project) !== state.active);
    if (slide?.ghost) refreshCopy(slide);
    // A folder's threads are its next siblings, not its children: each row names
    // its folder in data-sidebar-parent, or the thread T3 nests it under (a fork, a
    // subagent: in that thread's folder, noted just above). Pinned and settled threads
    // stay everywhere.
    for (const item of inner.querySelectorAll(T3_SELECTORS.threadItem)) {
      const project = parentProject(rowParentOf(item.querySelector(T3_SELECTORS.rowParent)));
      const thread = item.getAttribute(T3_ATTRS.threadItem);
      if (thread && (threadProjects.get(thread) ?? null) !== project) {
        // Noted again (most recent last, for the bound below), or no more once out of any
        // folder (settled, pinned, T3's flat list): the folder it was in no longer says.
        threadProjects.delete(thread);
        if (project !== null) {
          threadProjects.set(thread, project);
          if (threadProjects.size > 3000) threadProjects.delete(threadProjects.keys().next().value);
        }
      }
      hide(item, project !== null && profileOf(state, project) !== state.active);
    }
    followRoute();
  }

  return {
    sync,
    get state() {
      return state;
    },
    start() {
      running = true;
      changedEvent?.addListener?.(onChanged);
      doc.addEventListener("pointerdown", onPointerDown, true);
      doc.addEventListener("pointermove", onPointerMove, true);
      doc.addEventListener("pointerup", onPointerUp, true);
      doc.addEventListener("pointercancel", onPointerCancel, true);
      doc.addEventListener("keydown", onKeyDown, true);
      doc.addEventListener("click", onClick, true);
      doc.addEventListener("contextmenu", onContextMenu, true);
      doc.addEventListener("selectstart", onSelectStart, true);
      hookHistory();
      try {
        const stopBegin = trackpad?.onBegin(onTouchBegin) ?? null;
        const stopEnd = trackpad?.onEnd?.(onTouchEnd) ?? null;
        endReports = typeof stopEnd === "function";
        stopTouch = stopBegin || stopEnd ? () => (stopBegin?.(), stopEnd?.()) : null;
      } catch {
        stopTouch = null; // no report: the pause decides, as in the Chrome extension
      }
      return load();
    },
    stop() {
      changedEvent?.removeListener?.(onChanged);
      doc.removeEventListener("pointerdown", onPointerDown, true);
      doc.removeEventListener("pointermove", onPointerMove, true);
      doc.removeEventListener("pointerup", onPointerUp, true);
      doc.removeEventListener("pointercancel", onPointerCancel, true);
      doc.removeEventListener("keydown", onKeyDown, true);
      doc.removeEventListener("click", onClick, true);
      doc.removeEventListener("contextmenu", onContextMenu, true);
      doc.removeEventListener("selectstart", onSelectStart, true);
      try {
        stopTouch?.();
      } catch {
        // T3's bridge went with the window
      }
      stopTouch = null;
      endReports = false;
      ended = true; // the end of a touch begun now is no longer reported
      unhookHistory();
      menuProject = null;
      running = false;
      win.clearTimeout(swipeTimer);
      const flush = persistTimer !== null;
      if (flush) {
        win.clearTimeout(persistTimer);
        persistTimer = null;
      }
      if (slide) {
        // Stopped mid-switch: dropped (nothing is saved after stop).
        slide.committed = false;
        slide.navPending = false;
        land(slide);
      }
      if (gesture) win.cancelAnimationFrame?.(gesture.frame);
      gesture = null;
      for (const el of doc.querySelectorAll("[data-t3plus-profile-next]")) el.remove();
      releaseFocus?.();
      threadFade?.cancel();
      dragging?.ghost.remove();
      dragging?.shield.remove();
      dragging = null;
      pending = null;
      doc.documentElement.removeAttribute("data-t3plus-profile-drag");
      closeEditor();
      loaded = false;
      sync();
      // The thread note not yet written. Storage may turn it down (an extension reloaded
      // under this copy): write() reports that as a rejection, never a throw.
      if (flush) write().catch(() => {});
    },
    /**
     * The app's own view in T3's list's place (the Status view), which a switch slides
     * instead of the list (null: none). view: {
     *   element() -> Element | null    that view, while it is the one on screen,
     *   copyFor(id) -> { element, redraw() -> boolean }
     *                                  a copy of it as profile `id` shows it (made inert and
     *                                  unfindable here), drawn again by redraw() where what it
     *                                  shows has changed (true: something was),
     *   hold()                         a slide moves it: it goes out as it is,
     *   release()                      the slide is over: drawn now for the profile open }
     */
    setSlideView(view) {
      slideView = view;
    },
    /** Ends a switch's slide now, as a click mid-slide does (the app's view goes on or off
     *  screen under it: what it moves is no longer what shows). */
    landNow: () => landNow(),
    /** A switch sliding (or following the fingers), or a project being dragged to a dot:
     *  other main-thread work waits for it (the app's glow warming). */
    busy: () => slide !== null || dragging !== null,
    /** For tests and the settings panel. */
    switchTo,
    save,
    /** Settings → t3+: a profile's icon or colors (checked as stored values are). */
    update(id, patch) {
      // Before the stored profiles have loaded, the one default profile here is not them:
      // saving it would replace them all.
      if (!loaded || !state.list.some((p) => p.id === id)) return Promise.resolve();
      return save({ ...state, list: state.list.map((p) => (p.id === id ? { ...p, ...patch } : p)) });
    },
    projectMenu,
    projectMenuPick,
    /** Whether the stored profiles have loaded (until then Settings shows none). */
    isLoaded: () => loaded,
    /** Whether this T3 draws the night sky a profile can color (and the browser can turn it). */
    hasSky: () => skyTint && Boolean(nightSky()),
    /** For a preview: the turn that gives the sky the color `value` (null: T3's sky). */
    skyTurnFor: (value) => (skyTint && profileHex(value) ? skyTurn(value, skyBase()) : null),
  };
}
