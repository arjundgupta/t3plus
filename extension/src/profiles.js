import { STORAGE_KEYS, T3PLUS, T3_SELECTORS } from "./config.js";
import { findSidebarInner, threadKeyFromPath } from "./sidebar.js";

// Profiles, like Dia's (or Arc's spaces): each one shows a set of the sidebar's
// project folders. A row of small dots at the bottom of the sidebar says which
// one is open: click a dot, or swipe sideways with two fingers on the sidebar,
// to switch. The list slides away and the next profile's slides in beside it; a
// swipe moves both with the fingers. Drag a project folder's header and the dots open into named
// chips: drop it on one to move the project there, or on "New" to start a new
// profile with it. Right-click (or double-click) a dot to rename or delete it.
// Everything is local to t3+: T3's projects and folders are only hidden or shown.
//
// Ctrl+Shift+1..9 opens profile 1..9. Each profile has a color, shown on its dot only.
//
// Each profile keeps its own open thread: switching to a profile opens the thread
// last open in it (else its most recent one), and opening a thread that belongs to
// another profile (⌘K, a link, search) switches to that profile.
//
// Stored (STORAGE_KEYS.profiles): { active, list: [{ id, name, color }], projects: { projectKey: profileId },
// last?: { profileId: threadKey }, adopted? }.
// The projects there when profiles started keeping track belong to the first
// profile; one added later joins the profile that was open (placeNew).

const FOLDER_PREFIX = "folder:";
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

export function normalizeProfiles(raw) {
  const value = raw && typeof raw === "object" ? raw : {};
  const list = (Array.isArray(value.list) ? value.list : [])
    .filter((p) => p && typeof p.id === "string" && /^[a-z0-9-]{1,40}$/i.test(p.id))
    .slice(0, MAX_PROFILES)
    .map((p, i) => ({
      id: p.id,
      name: String(p.name ?? "").replace(/\s+/g, " ").trim().slice(0, 32) || "Profile",
      color: Object.hasOwn(PROFILE_COLORS, p.color ?? "") ? p.color : COLOR_ORDER[i % COLOR_ORDER.length],
    }));
  if (!list.length) list.push({ id: "main", name: "Main", color: "default" });
  const ids = new Set(list.map((p) => p.id));
  const projects = {};
  // First-profile entries are kept too: a project in the map is one t3+ has placed,
  // and a project not in it is new (placeNew).
  for (const [key, id] of Object.entries(value.projects && typeof value.projects === "object" ? value.projects : {}).slice(0, MAX_PROJECTS)) {
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

/** The profile a project folder belongs to. */
export function profileOf(state, projectKey) {
  return state.projects[projectKey] ?? state.list[0].id;
}

/** "17h" / "3d" / "2w" -> minutes; null for anything else. */
function ageMinutes(text) {
  const m = /^(\d+)\s*(s|m|h|d|w|mo|y)$/.exec(String(text).trim());
  if (!m) return null;
  return Number(m[1]) * { s: 1 / 60, m: 1, h: 60, d: 1440, w: 10080, mo: 43200, y: 525600 }[m[2]];
}

export function createProfiles({ win, doc, area, changedEvent, isEnabled = () => true, isDemo = () => false }) {
  // Screenshot mode: profile names are the user's own words ("Acme work"), so the
  // dots, chips and name pill say "Profile 1", "Profile 2". The rename field,
  // opened on purpose, keeps the real name.
  const shownName = (p, i) => (isDemo() ? `Profile ${i + 1}` : p.name);
  let state = normalizeProfiles(null);
  let loaded = false;
  let running = false; // between start() and stop(): a load that lands after stop() changes nothing
  const key = STORAGE_KEYS.profiles;

  async function load() {
    const stored = (await area.get(key))?.[key];
    if (!running) return;
    state = normalizeProfiles(stored);
    loaded = true;
    sync();
  }
  let saving = Promise.resolve();
  function save(next) {
    state = normalizeProfiles(next);
    sync();
    saving = saving.catch(() => {}).then(() => area.set({ [key]: state }));
    return saving;
  }
  const onChanged = (changes, areaName) => {
    if (!running || (areaName && areaName !== "local")) return;
    if (!changes?.[key]) return;
    const next = normalizeProfiles(changes[key].newValue);
    // This window's own save coming back: nothing to redo.
    if (JSON.stringify(next) === JSON.stringify(state)) return;
    // Mid-switch, the thread just noted for the profile being left is not saved yet: kept.
    state = slide ? normalizeProfiles({ ...next, last: { ...(next.last ?? {}), ...(state.last ?? {}) } }) : next;
    sync();
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

  function renderDots() {
    const signature = JSON.stringify([state.list, dragging ? 1 : 0, isDemo()]);
    // While a switch slides in, its dot is the open one already.
    const shown = slide?.committed ? slide.id : state.active;
    if (signature === dotsSignature) {
      // Only the open profile changed: the dots stay (a rebuild dropped keyboard focus).
      for (const dot of dots.querySelectorAll(".t3plus-profile-dot:not(.t3plus-profile-add)")) {
        const on = dot.dataset.profile === shown;
        if (dot.getAttribute("aria-pressed") !== String(on)) dot.setAttribute("aria-pressed", String(on));
        if (dot.tabIndex !== (on ? 0 : -1)) dot.tabIndex = on ? 0 : -1;
      }
      return;
    }
    dotsSignature = signature;
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
      if (PROFILE_COLORS[p.color]) dot.style.setProperty("--t3plus-profile-color", PROFILE_COLORS[p.color]);
      const label = doc.createElement("span");
      label.className = "t3plus-profile-chip";
      label.textContent = name;
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

  let nameTimer = null;
  function flashName(id = state.active) {
    const i = state.list.findIndex((p) => p.id === id);
    if (i < 0) return;
    name.textContent = shownName(state.list[i], i);
    name.setAttribute("data-show", "");
    win.clearTimeout(nameTimer);
    nameTimer = win.setTimeout(() => name.removeAttribute("data-show"), 900);
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
  // thread key -> project key, for threads seen in a folder (their rows go when a
  // folder is collapsed; the profile of a thread opened from there is still known).
  const threadProjects = new Map();
  const cssEscape = (v) => (win.CSS?.escape ? win.CSS.escape(v) : String(v).replace(/["\\]/g, "\\$&"));
  const rowOf = (inner, thread) => inner?.querySelector(`${T3_SELECTORS.threadItem}[data-thread-item="${cssEscape(thread)}"] ${T3_SELECTORS.sidebarRow}`) ?? null;
  /** The profile a thread belongs to, or null for one in no folder (pinned, settled, the flat sidebar). */
  function threadProfile(thread) {
    const parent = rowOf(sidebarInner(), thread)?.getAttribute("data-sidebar-parent") ?? "";
    const project = parent.startsWith(FOLDER_PREFIX) ? parent.slice(FOLDER_PREFIX.length) : threadProjects.get(thread);
    return project === undefined ? null : profileOf(state, project);
  }
  /** Most recent first: a thread at work or waiting on you, then by the age T3 shows ("17h"), then list order. */
  function recentThreadOf(id) {
    const inner = sidebarInner();
    let best = null;
    for (const item of inner?.querySelectorAll(T3_SELECTORS.threadItem) ?? []) {
      const row = item.querySelector(T3_SELECTORS.sidebarRow);
      const parent = row?.getAttribute("data-sidebar-parent") ?? "";
      if (!parent.startsWith(FOLDER_PREFIX) || profileOf(state, parent.slice(FOLDER_PREFIX.length)) !== id) continue;
      const status = (row.getAttribute("aria-label") ?? "").split(", ")[1] ?? "";
      let age = ACTIVE_STATUS.test(status) ? 0 : Infinity;
      if (age) for (const el of row.querySelectorAll("span")) {
        if (el.childElementCount) continue;
        const minutes = ageMinutes(el.textContent);
        if (minutes !== null) {
          age = minutes;
          break;
        }
      }
      if (!best || age < best.age) best = { thread: item.getAttribute("data-thread-item"), age };
    }
    return best?.thread ?? null;
  }
  /** Opens the thread profile `id` should show, if it is not open already. */
  function openThreadOf(id) {
    const inner = sidebarInner();
    let target = state.last?.[id] ?? null;
    if (target) {
      const owner = threadProfile(target);
      // Moved to another profile since, or gone: its folder is open, yet its row is not there.
      const project = threadProjects.get(target);
      const folderOpen = project !== undefined && inner?.querySelector(`[data-sidebar-row="${cssEscape(FOLDER_PREFIX + project)}"][aria-expanded="true"]`);
      if ((owner !== null && owner !== id) || (!rowOf(inner, target) && folderOpen)) target = null;
    }
    target ??= recentThreadOf(id);
    if (!target || !onThreadPage()) return;
    const pending = opening && Date.now() - opening.at < 1500 ? opening.thread : null;
    if (target === (pending ?? currentThread())) return;
    navigate(target);
  }
  function navigate(thread) {
    opening = { thread, at: Date.now() };
    const row = rowOf(sidebarInner(), thread);
    if (row && !row.closest("[inert]")) {
      row.click(); // T3's own navigation, as if clicked
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
    // One this window opened for a switch: not a thread opened from elsewhere. Only the
    // newest such request counts as current; an older one landing late is overtaken.
    const own = opening && Date.now() - opening.at < 1500;
    if (own && opening.thread !== thread) return;
    if (own) opening = null;
    if (state.last?.[owner] !== thread) {
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
      saving = saving.catch(() => {}).then(() => area.set({ [key]: state }));
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
  const SLIDE_MS = 240;
  const SLIDE_GAP = 12;
  const SLIDE_EASE = "cubic-bezier(0.25, 1, 0.5, 1)";
  const SLIDING_ATTR = "data-t3plus-profile-sliding";
  // Nothing in the copy can be found, focused or clicked: T3's and t3+'s own lookups
  // (rows, folders, ids) find the real list only. data-sidebar-parent stays (styles).
  const COPY_DROP = ["id", "data-thread-item", "data-testid", "data-sidebar-row", "tabindex", "aria-controls", "aria-labelledby", "aria-describedby", "aria-owns", "aria-activedescendant"];
  let slide = null;
  let landing = false; // inside land(): a route followed now waits for the next check
  // Each profile's place in the list (this window only): back to where you were.
  const scrollTops = new Map();
  const reducedMotion = () => Boolean(win.matchMedia?.("(prefers-reduced-motion: reduce)").matches);
  const canSlide = () => Boolean(folderList()?.animate) && !reducedMotion();
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
    const ul = folderList();
    const group = ul?.parentElement;
    if (!ul?.animate || !group || !dir) return null;
    const box = ul.getBoundingClientRect();
    if (!(box.width > 0)) return null;
    const outer = group.getBoundingClientRect();
    const scroller = ul.closest(T3_SELECTORS.sidebarScroller);
    scrollTops.set(state.active, scroller?.scrollTop ?? 0);
    const s = {
      id: null, dir, ul, group, scroller, ghost: null, anims: [], timer: null,
      phase: "drag", committed: false, navPending: false, open: false, apply: null, pairs: [], copies: new Map(),
      left: box.left - outer.left - group.clientLeft, top: box.top - outer.top - group.clientTop,
      width: box.width, height: ul.offsetHeight, distance: Math.round(box.width) + SLIDE_GAP,
      x: 0, y: 0, raw: 0, v: 0, moves: [], position: null,
    };
    group.setAttribute(SLIDING_ATTR, "");
    if (win.getComputedStyle(group).position === "static") {
      s.position = group.style.position;
      group.style.position = "relative";
    }
    ul.style.willChange = "transform";
    slide = s;
    setTarget(s, id, dir);
    return s;
  }
  /** The profile coming in from side `dir`: a copy of the list as it would show. */
  function setTarget(s, id, dir) {
    if (s.ghost) s.copies.set(s.id, { ghost: s.ghost, pairs: s.pairs });
    s.ghost?.remove();
    s.ghost = null;
    s.pairs = [];
    s.id = id;
    s.dir = dir;
    if (!id) return;
    // Back and forth across the start of a swipe: the copy made the first time.
    const kept = s.copies.get(id);
    if (kept) {
      s.ghost = kept.ghost;
      s.pairs = kept.pairs;
      s.group.append(s.ghost);
      s.y = (s.scroller?.scrollTop ?? 0) - (scrollTops.get(id) ?? 0);
      placeSlide(s);
      return;
    }
    const ghost = s.ul.cloneNode(false);
    // The rows that profile shows; the others (most of the list) as empty hidden
    // stand-ins, so first-child and sibling styles come out as in the real list.
    for (const item of s.ul.children) {
      if (shownIn(item, id)) {
        const copy = copyItem(item, id);
        s.pairs.push([item, copy]);
        ghost.append(copy);
      } else {
        const stub = item.cloneNode(false);
        for (const attr of COPY_DROP) stub.removeAttribute(attr);
        stub.setAttribute("data-t3plus-profile-off", "");
        ghost.append(stub);
      }
    }
    for (const attr of COPY_DROP) ghost.removeAttribute(attr);
    ghost.setAttribute(T3PLUS.ownedAttr, "");
    ghost.setAttribute("data-t3plus-profile-next", "");
    ghost.setAttribute("aria-hidden", "true");
    ghost.setAttribute("inert", "");
    ghost.removeAttribute("style");
    Object.assign(ghost.style, {
      position: "absolute", left: `${s.left}px`, top: `${s.top}px`, width: `${s.width}px`,
      minHeight: `${s.height}px`, margin: "0", pointerEvents: "none", willChange: "transform",
    });
    // Shown at the place it was left at (the top, the first time).
    s.y = (s.scroller?.scrollTop ?? 0) - (scrollTops.get(id) ?? 0);
    s.group.append(ghost);
    s.ghost = ghost;
    placeSlide(s);
  }
  /** The project a row of the list belongs to: a folder's, or a thread's in a folder (else null). */
  function rowProject(item) {
    if (item.matches(T3_SELECTORS.projectFolderItem)) {
      const header = item.querySelector(`[data-sidebar-row^="${FOLDER_PREFIX}"]`);
      return header ? header.getAttribute("data-sidebar-row").slice(FOLDER_PREFIX.length) : null;
    }
    if (!item.matches(T3_SELECTORS.threadItem)) return null;
    const parent = item.querySelector("[data-sidebar-parent]")?.getAttribute("data-sidebar-parent") ?? "";
    return parent.startsWith(FOLDER_PREFIX) ? parent.slice(FOLDER_PREFIX.length) : null;
  }
  // Rows of no project (pinned and settled threads, headings) show in every profile.
  const shownIn = (item, id) => {
    const project = rowProject(item);
    return project === null || profileOf(state, project) === id;
  };
  /** A row of the list (a folder, a thread, a heading) as it shows in profile `id`. */
  function copyItem(item, id) {
    const copy = item.cloneNode(true);
    copy.toggleAttribute("data-t3plus-profile-off", !shownIn(item, id));
    for (const el of [copy, ...copy.querySelectorAll("*")]) for (const attr of COPY_DROP) el.removeAttribute(attr);
    return copy;
  }
  /** T3 moved the open-thread highlight (the thread opened mid-slide): the copy follows. */
  function refreshCopy(s) {
    // Screenshot mode covers T3's text after this check: a fresh copy could show it.
    if (isDemo()) return;
    const current = (el) => Boolean(el.querySelector("[aria-current]"));
    for (const pair of s.pairs) {
      const [item, copy] = pair;
      if (!item.isConnected || current(item) === current(copy)) continue;
      pair[1] = copyItem(item, s.id);
      copy.replaceWith(pair[1]);
    }
  }
  const shift = (x, y = 0) => `translate3d(${x}px, ${y}px, 0)`;
  function placeSlide(s) {
    s.ul.style.transform = shift(s.x);
    if (s.ghost) s.ghost.style.transform = shift(s.x + s.dir * s.distance, s.y);
  }
  /** Runs a switch to `id` as a slide (or at once, with nothing to slide). */
  function slideTo(id, dir, { open = false, apply }) {
    const s = canSlide() ? beginSlide(id, dir) : null;
    if (!s) {
      const scroller = folderList()?.closest(T3_SELECTORS.sidebarScroller) ?? null;
      if (scroller) scrollTops.set(state.active, scroller.scrollTop);
      // Asked for first: T3 draws the thread while the sidebar changes.
      if (open) openThreadOf(id);
      apply();
      placeList(scroller, id, open);
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
    if (s.committed) {
      renderDots();
      flashName(s.id);
    }
    for (const a of s.anims) a.cancel();
    const run = (el, from, end, y) =>
      el.animate([{ transform: shift(from, y) }, { transform: shift(end, y) }], { duration: ms, easing: SLIDE_EASE, fill: "forwards" });
    s.anims = [run(s.ul, s.x, to, 0)];
    if (s.ghost) s.anims.push(run(s.ghost, s.x + s.dir * s.distance, to + s.dir * s.distance, s.y));
    s.anims[0].onfinish = () => land(s);
    // The finish event needs the page to be painting; the switch must happen regardless.
    s.timer = win.setTimeout(() => land(s), ms + 150);
    if (s.committed && s.open) {
      s.navPending = true;
      // Once the slide runs on the compositor, T3 may take the main thread to draw the thread.
      const go = () => {
        if (!s.navPending) return;
        s.navPending = false;
        openThreadOf(s.id);
      };
      Promise.all(s.anims.map((a) => a.ready)).then(() => win.requestAnimationFrame(() => win.setTimeout(go, 0)), go);
    }
  }
  /** The slide is over: the real list takes the copy's place, in the same frame. */
  function land(s) {
    if (slide !== s) return;
    slide = null;
    win.clearTimeout(s.timer);
    for (const a of s.anims) a.cancel();
    s.ul.style.removeProperty("transform");
    s.ul.style.removeProperty("will-change");
    s.ghost?.remove();
    s.group.removeAttribute(SLIDING_ATTR);
    if (s.position !== null) s.group.style.position = s.position;
    if (!s.committed) {
      renderDots();
      return;
    }
    landing = true;
    try {
      s.apply?.();
    } finally {
      landing = false;
    }
    placeList(s.scroller, s.id, s.open);
    // Not asked for yet (a window in the background paints no frames): now.
    if (s.navPending) {
      s.navPending = false;
      openThreadOf(s.id);
    }
    // A route that wanted following while it slid (a thread of another profile opened):
    // once whatever landed it (a click, a key, a swipe) has started its own switch.
    win.setTimeout(() => {
      if (running && !slide) followRoute();
    }, 0);
  }
  /** The list where it was left in profile `id`; switched because one of its threads opened
   *  (⌘K, a link), that thread's row in view. */
  function placeList(scroller, id, open) {
    if (scroller) scroller.scrollTop = scrollTops.get(id) ?? 0;
    if (!open) rowOf(sidebarInner(), currentThread() ?? "")?.scrollIntoView?.({ block: "nearest" });
  }
  /** Fingers back on the pad while the list springs back: it carries on from where it is. */
  function resume(s) {
    const m = /matrix\(([^)]+)\)/.exec(win.getComputedStyle(s.ul).transform ?? "");
    const x = m ? Number(m[1].split(",")[4]) || 0 : s.x;
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
    if (!navigate) s.navPending = false;
    land(s);
  }

  // ---------- Rename / delete (right-click or double-click a dot) ----------
  let editor = null;
  function closeEditor(refocus = false) {
    const id = editor?.dataset.profile;
    const hadFocus = editor?.contains(doc.activeElement);
    editor?.remove();
    editor = null;
    // Closed from the keyboard (Escape, Enter): back to the profile's dot, not lost to <body>.
    if (refocus || hadFocus) dots.querySelector(`.t3plus-profile-dot[data-profile="${id}"]`)?.focus();
  }
  function openEditor(id) {
    closeEditor();
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
      const value = input.value.trim();
      if (value && value !== profile.name) save({ ...state, list: state.list.map((p) => (p.id === id ? { ...p, name: value } : p)) });
      closeEditor(refocus);
    };
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
      closeEditor();
      if (wasActive) openThreadOf(list[0].id);
    });
    const swatches = doc.createElement("div");
    swatches.className = "t3plus-profile-colors";
    swatches.setAttribute("role", "radiogroup");
    swatches.setAttribute("aria-label", "Dot color");
    for (const [color, hex] of Object.entries(PROFILE_COLORS)) {
      const swatch = doc.createElement("button");
      swatch.type = "button";
      swatch.className = "t3plus-profile-swatch";
      swatch.setAttribute("role", "radio");
      swatch.setAttribute("aria-checked", String(profile.color === color));
      swatch.setAttribute("aria-label", color === "default" ? "Default" : color[0].toUpperCase() + color.slice(1));
      swatch.title = swatch.getAttribute("aria-label");
      if (hex) swatch.style.setProperty("--t3plus-profile-color", hex);
      // Keep the name field's focus (and its pending rename) while picking a color.
      swatch.addEventListener("pointerdown", (e) => e.preventDefault());
      swatch.addEventListener("click", () => {
        profile.color = color;
        save({ ...state, list: state.list.map((p) => (p.id === id ? { ...p, color } : p)) });
        for (const el of swatches.children) el.setAttribute("aria-checked", String(el === swatch));
        input.focus();
      });
      swatches.append(swatch);
    }
    const row = doc.createElement("div");
    row.className = "t3plus-profile-editor-row";
    row.append(input);
    if (!isFirst) row.append(remove);
    editor.append(row, swatches);
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
        dots.querySelector('.t3plus-profile-dot[tabindex="0"]')?.focus({ preventScroll: true });
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
  // The listener sits on the sidebar, and only while profiles are on: a
  // non-passive wheel listener on the document made every scroll in T3 (the
  // chat while it streams) wait for the main thread.
  let wheelHost = null;
  function watchWheel(host) {
    if (host === wheelHost) return;
    wheelHost?.removeEventListener("wheel", onWheel, { capture: true });
    wheelHost = host;
    wheelHost?.addEventListener("wheel", onWheel, { capture: true, passive: false });
  }
  // One gesture: wheel events with no pause longer than this. After it, the
  // fingers (and the momentum that follows them) have stopped. Wheel events cannot
  // tell fingers resting on the pad from lifted ones: long enough for a hesitation.
  const SWIPE_IDLE_MS = 140;
  // A swipe that has switched swallows what follows it the same way (the momentum,
  // and events T3's drawing of the thread held back) until a pause this long, or
  // until the fingers go the other way.
  const SWIPE_DONE_MS = 260;
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
  let gesture = null; // { at, axis, sx, sy, raw, last, slows, done, sign, quiet, frame }
  let swipeTimer = null;
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
      gesture = { at: t, axis: null, sx: 0, sy: 0, raw: 0, last: 0, slows: 0, done: false, sign: 0, quiet: 0, frame: 0 };
    }
    const g = gesture;
    g.at = t;
    if (g.axis === null) {
      // Sideways or up and down, decided over the first few pixels and kept to the end:
      // scrolling the list never turns into a switch halfway.
      g.sx += dx;
      g.sy += dy;
      if (Math.abs(g.sx) + Math.abs(g.sy) < 4) {
        if (Math.abs(dx) > Math.abs(dy)) event.preventDefault();
        return;
      }
      g.axis = Math.abs(g.sx) > Math.abs(g.sy) * 1.2 ? "x" : "y";
      if (g.axis === "y") return;
      event.preventDefault();
      armSwipeEnd();
      if (g.done) countQuiet(g);
      else drag(-g.sx, t);
      return;
    }
    if (g.axis !== "x") return;
    event.preventDefault();
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
        useUp(g, g.raw < 0 ? 1 : -1);
        step(g.sign);
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
    if (s.ghost && s.scroller) s.y = s.scroller.scrollTop - (scrollTops.get(s.id) ?? 0);
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
  let dragging = null; // { project, ghost }
  let swallowClick = false;
  function onPointerDown(event) {
    if (!isEnabled() || event.button !== 0 || event.altKey || event.metaKey || event.ctrlKey) return;
    const header = event.target.closest?.(`[data-sidebar-row^="${FOLDER_PREFIX}"]`);
    if (!header || header.closest(`[${T3PLUS.ownedAttr}]`)) return;
    const project = header.getAttribute("data-sidebar-row").slice(FOLDER_PREFIX.length);
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
      const over = doc.elementFromPoint(event.clientX, event.clientY)?.closest?.(".t3plus-profile-dot") ?? null;
      for (const dot of dots.children) dot.toggleAttribute("data-over", dot === over);
      dragging.over = over;
      return;
    }
    if (!pending || (event.buttons & 1) === 0) {
      pending = null;
      return;
    }
    if (Math.hypot(event.clientX - pending.x, event.clientY - pending.y) < 6) return;
    const ghost = doc.createElement("div");
    ghost.className = "t3plus-profile-ghost";
    ghost.setAttribute(T3PLUS.ownedAttr, "");
    ghost.textContent = pending.title;
    ghost.style.transform = `translate(${event.clientX + 12}px, ${event.clientY + 10}px)`;
    doc.body.append(ghost);
    dragging = { project: pending.project, ghost, over: null };
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
    const { project, ghost, over } = dragging;
    // Where it was dropped, found while the dots are still open as named chips:
    // closing them first shrank "Main" and "New" away from under the pointer, so
    // a drop on most of their label landed on nothing.
    const hit = drop && Number.isFinite(event.clientX) ? doc.elementFromPoint(event.clientX, event.clientY)?.closest?.(".t3plus-profile-dot") : null;
    const target = drop ? (hit && dots.contains(hit) ? hit : over) : null;
    dragging = null;
    ghost.remove();
    doc.documentElement.removeAttribute("data-t3plus-profile-drag");
    // The pointerup ends T3's click on the header: keep it from toggling the folder.
    swallowClick = true;
    win.setTimeout(() => (swallowClick = false), 0);
    dotsSignature = "";
    if (!target) {
      renderDots();
      return;
    }
    let id = target.dataset.profile;
    let list = state.list;
    if (id === "+new") {
      id = newProfileId();
      list = [...list, { id, name: nextName(list), color: nextColor(list) }];
    }
    save({ ...state, list, projects: { ...state.projects, [project]: id } });
    if (target.dataset.profile === "+new") openEditor(id);
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
    const room = Math.max(0, MAX_PROJECTS - Object.keys(state.projects).length);
    const fresh = [...new Set(projects)].filter((project) => !Object.hasOwn(state.projects, project)).slice(0, room);
    if (!fresh.length && (state.adopted || adopting)) return false;
    const to = adopting ? state.list[0].id : state.active;
    save({ ...state, projects: { ...state.projects, ...Object.fromEntries(fresh.map((project) => [project, to])) }, ...(adopting ? {} : { adopted: true }) });
    return true;
  }

  // ---------- Applying it to T3's sidebar ----------
  // The sidebar with the thread rows (there can be a second, right-hand one), or the
  // first one while it has none yet: the dots show in an empty sidebar too.
  const sidebarInner = () => findSidebarInner(doc) ?? doc.querySelector(T3_SELECTORS.sidebarInner);
  function folderList() {
    const inner = sidebarInner();
    return inner?.querySelector(T3_SELECTORS.projectFolderItem)?.parentElement ?? null;
  }

  function sync() {
    const on = isEnabled() && loaded;
    const inner = sidebarInner();
    const footer = inner?.querySelector(T3_SELECTORS.sidebarFooter);
    watchWheel(on ? inner : null);
    if (!on && slide) {
      // Profiles turned off mid-switch: dropped, the list as it was.
      slide.committed = false;
      slide.navPending = false;
      land(slide);
      gesture = null;
    }
    if (!on || !footer) {
      if (bar.isConnected) bar.remove();
      for (const el of doc.querySelectorAll("[data-t3plus-profile-off]")) {
        el.removeAttribute("data-t3plus-profile-off");
        el.removeAttribute("inert");
      }
      return;
    }
    if (bar.parentElement !== footer || footer.firstElementChild !== bar) footer.prepend(bar);
    renderDots();
    // Hidden rows are also inert: T3's arrow-key navigation in the sidebar skips
    // [inert] rows, and stopped at a hidden one (display: none takes no focus).
    const hide = (el, off) => {
      if (el.hasAttribute("data-t3plus-profile-off") !== off) {
        el.toggleAttribute("data-t3plus-profile-off", off);
        el.toggleAttribute("inert", off);
      }
    };
    const folders = [];
    for (const folder of inner.querySelectorAll(T3_SELECTORS.projectFolderItem)) {
      const header = folder.querySelector(`[data-sidebar-row^="${FOLDER_PREFIX}"]`);
      if (header) folders.push([folder, header.getAttribute("data-sidebar-row").slice(FOLDER_PREFIX.length)]);
    }
    if (placeNew(folders.map(([, project]) => project))) return; // saved, and synced again with it
    for (const [folder, project] of folders) hide(folder, profileOf(state, project) !== state.active);
    if (slide?.ghost) refreshCopy(slide);
    // A folder's threads are its next siblings, not its children: each row names
    // its folder in data-sidebar-parent. Pinned and settled threads stay everywhere.
    for (const item of inner.querySelectorAll(T3_SELECTORS.threadItem)) {
      const parent = item.querySelector("[data-sidebar-parent]")?.getAttribute("data-sidebar-parent") ?? "";
      const inFolder = parent.startsWith(FOLDER_PREFIX);
      if (inFolder) {
        const thread = item.getAttribute("data-thread-item");
        if (thread && threadProjects.get(thread) !== parent.slice(FOLDER_PREFIX.length)) {
          threadProjects.delete(thread); // most recent last, for the bound below
          threadProjects.set(thread, parent.slice(FOLDER_PREFIX.length));
          if (threadProjects.size > 3000) threadProjects.delete(threadProjects.keys().next().value);
        }
      }
      hide(item, inFolder && profileOf(state, parent.slice(FOLDER_PREFIX.length)) !== state.active);
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
      running = false;
      win.clearTimeout(nameTimer);
      win.clearTimeout(swipeTimer);
      if (persistTimer !== null) {
        win.clearTimeout(persistTimer);
        persistTimer = null;
        area.set({ [key]: state }).catch?.(() => {});
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
      dragging?.ghost.remove();
      dragging = null;
      pending = null;
      doc.documentElement.removeAttribute("data-t3plus-profile-drag");
      closeEditor();
      loaded = false;
      sync();
    },
    /** For tests and the settings panel. */
    switchTo,
    save,
  };
}
