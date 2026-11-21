// The sidebar's Status view: every thread of the open profile grouped by what it needs,
// for triage. Needs you (an approval, a question, a failure), Working, Done (finished
// since you last looked), Idle. A toggle beside the profile dots switches between it and
// T3's own list, which stays in the page (hidden) and keeps working as before.
//
// Two sources. T3's list itself, for the rows it shows (its status words are the
// latest), and the thread feed (t3plus-threads.json, published by the desktop loader
// from T3's database) for the rest: a collapsed folder's threads are not in T3's list
// at all. Without the feed (the Chrome extension), the view groups the rows T3 shows.

import { STORAGE_KEYS, T3PLUS } from "./config.js";
import { CONFIG_LIMITS, THREADS_FEED_ENDPOINT } from "./hosts.js";
import { createStampedStore } from "./settings.js";

/** T3's status word on a row -> the status here. */
const STATUS_BY_WORD = new Map([
  ["Approval", "approval"],
  ["Input", "input"],
  ["Request", "request"],
  ["Limited", "limited"],
  ["Failed", "failed"],
  ["Woke", "woke"],
  ["Setting up", "preparing"],
  ["Goal", "goal"],
  ["Working", "working"],
  ["Waiting", "waiting"],
  ["Done", "done"],
]);
// "goal": T3's "Working" while the thread pursues an active goal (it labels the row "Goal").
export const STATUSES = Object.freeze(["approval", "input", "request", "limited", "failed", "woke", "preparing", "working", "goal", "waiting", "done", "idle"]);
const KNOWN = new Set(STATUSES);
/** The word shown for a status (T3's own words). */
export const STATUS_WORDS = Object.freeze({
  approval: "Approval",
  input: "Input",
  request: "Request",
  limited: "Limited",
  failed: "Failed",
  woke: "Woke",
  preparing: "Setting up",
  working: "Working",
  goal: "Goal",
  waiting: "Waiting",
  done: "Done",
  idle: "",
});
/** Groups, in triage order: what needs you first. A row's place in its group follows STATUSES. */
export const STATUS_GROUPS = Object.freeze([
  Object.freeze({ id: "needs", label: "Needs you", statuses: ["approval", "input", "request", "limited", "failed", "woke"] }),
  Object.freeze({ id: "working", label: "Working", statuses: ["preparing", "working", "goal", "waiting"] }),
  Object.freeze({ id: "done", label: "Done", statuses: ["done"] }),
  Object.freeze({ id: "idle", label: "Idle", statuses: ["idle"] }),
]);
const GROUP_OF = new Map(STATUS_GROUPS.flatMap((g) => g.statuses.map((s) => [s, g.id])));
/**
 * Bot colors when bots wear their status (Status colors), by the face's row status
 * (bots.js parseRowStatus): a traffic light. Orange wants you, red went wrong, amber
 * is running, green is done; idle is blue.
 */
export const BOT_STATUS_COLORS = Object.freeze({
  attention: "orange",
  failed: "red",
  working: "yellow",
  waiting: "yellow",
  done: "green",
  idle: "blue",
});
/** The bot face's mood row status (bots.js parseRowStatus) for a status here. */
export const BOT_STATUS = Object.freeze({
  approval: "attention",
  input: "attention",
  request: "attention",
  woke: "attention",
  limited: "attention",
  failed: "failed",
  preparing: "working",
  working: "working",
  goal: "working",
  waiting: "waiting",
  done: "done",
  idle: "idle",
});
/** Each status's bot color under Status colors (BOT_STATUS_COLORS through its face's status). */
export const STATUS_BOT_COLORS = Object.freeze(Object.fromEntries(Object.entries(BOT_STATUS).map(([status, face]) => [status, BOT_STATUS_COLORS[face]])));


/** Whether `word` is one of T3's row status words. */
export const isRowStatusWord = (word) => STATUS_BY_WORD.has(word);

/**
 * T3's own status word on a row ("Input", "Approval", "Working", ...), from its aria-label
 * ("<title>, <word>, <project>": Sidebar.logic.ts resolveSidebarRowAccessibility), or ""
 * when it shows none. Read here alone, from one table: the view's statuses and the bot
 * faces' (bots.js) were two tables to keep in step.
 */
export function rowStatusWord(ariaLabel, title) {
  if (typeof ariaLabel !== "string" || typeof title !== "string" || !ariaLabel.startsWith(`${title}, `)) return "";
  const word = ariaLabel.slice(title.length + 2).split(", ")[0];
  return isRowStatusWord(word) ? word : "";
}

/** The status a T3 row shows, "idle" for none. */
export const rowStatus = (ariaLabel, title) => STATUS_BY_WORD.get(rowStatusWord(ariaLabel, title)) ?? "idle";

// ---------- Which view, and what is folded ----------

/** { view: "projects" | "status", collapsed: { groupId: bool } }: Idle starts folded. */
export function normalizeViewState(raw) {
  const value = raw && typeof raw === "object" ? raw : {};
  const given = value.collapsed && typeof value.collapsed === "object" ? value.collapsed : {};
  const collapsed = {};
  for (const g of STATUS_GROUPS) collapsed[g.id] = typeof given[g.id] === "boolean" ? given[g.id] : g.id === "idle";
  return { view: value.view === "status" ? "status" : "projects", collapsed };
}

export function createViewStore(area, changedEvent) {
  return createStampedStore(area, changedEvent, STORAGE_KEYS.sidebarView, normalizeViewState);
}

// ---------- The thread feed ----------

const ID = /^[^\s:]{1,200}$/;
const MAX_FEED_THREADS = 400;
const short = (value, max) => (typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, max) : "");

/**
 * t3plus-threads.json: { version: 1, generatedAt, environmentId,
 *   threads: [{ id, project, title, status, goal?, at }], projects: { id: { title, keys: [folder key, ...] } } }
 * goal: true on a "working" thread is T3's "Goal" (status "goal" here). A flag beside the
 * status, not a status of its own: a reader that does not know it still shows "Working".
 * @returns {{ environmentId: string, threads: object[], projects: Map<string, { title: string, keys: string[] }> } | null}
 */
export function parseThreadsFeedText(text) {
  if (typeof text !== "string" || !text.trim() || text.length > CONFIG_LIMITS.maxChars) return null;
  let raw;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== "object" || raw.version !== 1 || typeof raw.environmentId !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(raw.environmentId) || !Array.isArray(raw.threads)) return null;
  const projects = new Map();
  for (const [id, p] of Object.entries(raw.projects && typeof raw.projects === "object" ? raw.projects : {})) {
    if (!ID.test(id) || !p || typeof p !== "object") continue;
    const keys = (Array.isArray(p.keys) ? p.keys : []).filter((k) => typeof k === "string" && k.length > 0 && k.length <= 400).slice(0, 4);
    projects.set(id, { title: short(p.title, 60), keys });
  }
  const threads = [];
  for (const t of raw.threads.slice(0, MAX_FEED_THREADS)) {
    if (!t || typeof t !== "object" || !ID.test(t.id ?? "") || !KNOWN.has(t.status)) continue;
    const at = Date.parse(t.at ?? "");
    threads.push({
      key: `${raw.environmentId}:${t.id}`,
      project: typeof t.project === "string" && projects.has(t.project) ? t.project : null,
      title: short(t.title, 120),
      status: t.status === "working" && t.goal === true ? "goal" : t.status,
      at: Number.isFinite(at) ? at : null,
    });
  }
  return { environmentId: raw.environmentId, threads, projects };
}

/** Reads the feed (through the background worker, or the desktop loader's copy). load() -> parsed feed or null. */
export function createThreadsFeed({ fetchRemote, endpoint = THREADS_FEED_ENDPOINT }) {
  // Read every couple of seconds, mostly unchanged: parsed again only when its text is new
  // (the same object back, so nothing downstream sees a change).
  let lastText = null;
  let lastFeed = null;
  return {
    async load() {
      let response;
      try {
        response = await fetchRemote(endpoint);
      } catch {
        return null;
      }
      if (!response?.ok) return null;
      if (response.text !== lastText) {
        lastText = response.text;
        lastFeed = parseThreadsFeedText(response.text);
      }
      return lastFeed;
    },
  };
}

// ---------- The model ----------

/**
 * A folder key from a project's candidates: one T3's list has as it is, else one that
 * differs only in case (repository keys), else null. An exact key comes first: two
 * folders may differ in case alone.
 */
function folderFor(project, folderTitles, byLower) {
  if (!project) return null;
  for (const key of project.keys) if (folderTitles.has(key)) return key;
  for (const key of project.keys) {
    const known = byLower.get(key.toLowerCase());
    if (known) return known;
  }
  return null;
}

/**
 * The rows, grouped: [{ id, label, rows: [{ key, title, status, at, folderKey, project, current }] }]
 * (empty groups left out). scan: sidebar.js scanSidebar; feed: parseThreadsFeedText (or
 * null); folderTitles: Map folder key -> its name; include(folderKey or null, fromList): whether
 * a thread of that folder belongs in the view (the open profile's); fromList: T3's list shows it.
 */
export function buildStatusModel({ scan, feed = null, folderTitles = new Map(), include = () => true }) {
  const rows = new Map();
  if (feed) {
    // Each folder key by its lowercase (the first of several that differ only in case).
    const byLower = new Map();
    for (const key of folderTitles.keys()) if (!byLower.has(key.toLowerCase())) byLower.set(key.toLowerCase(), key);
    const projectFolders = new Map(); // project id -> folder key, once per project
    for (const t of feed.threads) {
      const project = t.project ? feed.projects.get(t.project) : null;
      if (t.project && !projectFolders.has(t.project)) projectFolders.set(t.project, folderFor(project, folderTitles, byLower));
      const folderKey = t.project ? projectFolders.get(t.project) : null;
      rows.set(t.key, { key: t.key, title: t.title, status: t.status, at: t.at, folderKey, project: (folderKey && folderTitles.get(folderKey)) || project?.title || "", current: false, fromList: false });
    }
  }
  // T3's own rows over the feed's: what its list shows now is the latest.
  for (const thread of scan?.threads ?? []) {
    const parent = thread.parent ?? "";
    // Settled and snoozed threads are dealt with (or put off).
    if (parent === "shelf:settled" || parent === "shelf:snoozed") {
      rows.delete(thread.key);
      continue;
    }
    const before = rows.get(thread.key);
    // A row nested under another thread: a fork (the feed lists it) keeps its place; a
    // subagent or side chat (the feed leaves it out, or there is no feed) is part of its thread.
    const nested = parent && !parent.startsWith("folder:") && !parent.startsWith("shelf:");
    if (nested && !before) continue;
    // A nested row names its thread as parent, not a folder: its folder is the feed's.
    const folderKey = thread.folderKey ?? before?.folderKey ?? null;
    rows.set(thread.key, {
      key: thread.key,
      title: thread.title || before?.title || "",
      status: rowStatus(thread.ariaLabel, thread.title),
      at: before?.at ?? null,
      folderKey,
      project: (folderKey && folderTitles.get(folderKey)) || before?.project || "",
      current: Boolean(thread.current),
      fromList: true,
    });
  }
  const groups = STATUS_GROUPS.map((g) => ({ id: g.id, label: g.label, rows: [] }));
  const byId = new Map(groups.map((g) => [g.id, g]));
  for (const row of rows.values()) {
    if (!include(row.folderKey, row.fromList)) continue;
    byId.get(GROUP_OF.get(row.status) ?? "idle").rows.push(row);
  }
  const rank = new Map(STATUSES.map((s, i) => [s, i]));
  for (const g of groups) {
    // Most urgent kind first, then the most recent (rows T3 shows but the feed does
    // not have yet are new: first).
    g.rows.sort((a, b) => rank.get(a.status) - rank.get(b.status) || (b.at ?? Infinity) - (a.at ?? Infinity) || a.title.localeCompare(b.title));
  }
  return groups.filter((g) => g.rows.length > 0);
}

/** "now", "5m", "3h", "2d", "3w", "4mo", "2y": as T3 writes ages. */
export function ago(at, now = Date.now()) {
  if (!Number.isFinite(at)) return "";
  const minutes = Math.max(0, (now - at) / 60000);
  if (minutes < 1) return "now";
  if (minutes < 60) return `${Math.floor(minutes)}m`;
  if (minutes < 1440) return `${Math.floor(minutes / 60)}h`;
  if (minutes < 10080) return `${Math.floor(minutes / 1440)}d`;
  if (minutes < 43200) return `${Math.floor(minutes / 10080)}w`;
  if (minutes < 525600) return `${Math.floor(minutes / 43200)}mo`;
  return `${Math.floor(minutes / 525600)}y`;
}

// ---------- The view ----------

const SVG = 'xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"';
// lucide "list-checks" (T3's icon set): the toggle beside the profile dots.
export const STATUS_ICON = `<svg ${SVG}><path d="m3 17 2 2 4-4"/><path d="m3 7 2 2 4-4"/><path d="M13 6h8"/><path d="M13 12h8"/><path d="M13 18h8"/></svg>`;
const CHEVRON = `<svg ${SVG}><path d="m9 18 6-6-6-6"/></svg>`;

/**
 * The view's DOM. update(model) brings it up to date and touches only what changed:
 * rows are kept by thread key, and a row's parts are written only when they differ.
 * deps: onOpen(key) (a row was picked), onCollapse(groupId, collapsed), avatar(el, row)
 * (draws a row's face: a bot's, or a status dot; it skips what is drawn already).
 */
export function createStatusView(doc, { onOpen, onCollapse, avatar }) {
  const root = doc.createElement("div");
  root.className = "t3plus-status-view";
  root.setAttribute("data-t3plus-owned", "");
  root.setAttribute("role", "region");
  root.setAttribute("aria-label", "Threads by status");
  const empty = doc.createElement("p");
  empty.className = "t3plus-status-empty";
  empty.textContent = "No threads here yet.";
  const sections = new Map(); // group id -> { section, header, count, list, collapsed }
  const rowsByKey = new Map(); // thread key -> { li, button, face, title, project, meta, sig }

  function sectionFor(group) {
    let s = sections.get(group.id);
    if (s) return s;
    const section = doc.createElement("section");
    section.className = "t3plus-status-group";
    section.dataset.group = group.id;
    const header = doc.createElement("button");
    header.type = "button";
    header.className = "t3plus-status-head";
    header.innerHTML = CHEVRON;
    const label = doc.createElement("span");
    label.className = "t3plus-status-label";
    label.textContent = group.label;
    const count = doc.createElement("span");
    count.className = "t3plus-status-count";
    header.append(label, count);
    const list = doc.createElement("ul");
    list.className = "t3plus-status-list";
    list.id = `t3plus-status-${group.id}`;
    header.setAttribute("aria-controls", list.id);
    section.append(header, list);
    s = { section, header, count, list, collapsed: null };
    header.addEventListener("click", () => onCollapse?.(group.id, !s.collapsed));
    sections.set(group.id, s);
    return s;
  }

  function rowFor(key) {
    let r = rowsByKey.get(key);
    if (r) return r;
    const li = doc.createElement("li");
    li.className = "t3plus-status-item";
    const button = doc.createElement("button");
    button.type = "button";
    button.className = "t3plus-status-row";
    button.setAttribute(T3PLUS.statusThreadAttr, key);
    const face = doc.createElement("span");
    face.className = "t3plus-status-face";
    face.setAttribute("aria-hidden", "true");
    const text = doc.createElement("span");
    text.className = "t3plus-status-text";
    const title = doc.createElement("span");
    title.className = "t3plus-status-title";
    const project = doc.createElement("span");
    project.className = "t3plus-status-project";
    text.append(title, project);
    const meta = doc.createElement("span");
    meta.className = "t3plus-status-meta";
    button.append(face, text, meta);
    li.append(button);
    r = { li, button, face, title, project, meta, sig: "" };
    rowsByKey.set(key, r);
    return r;
  }

  const setText = (el, value) => {
    if (el.textContent !== value) el.textContent = value;
  };

  // Rows are buttons; the arrow keys move between them (one Tab stop for the view).
  root.addEventListener("keydown", (event) => {
    const step = { ArrowDown: 1, ArrowUp: -1 }[event.key];
    const all = [...root.querySelectorAll(".t3plus-status-head, .t3plus-status-list:not([hidden]) .t3plus-status-row")];
    const at = all.indexOf(doc.activeElement);
    if (at < 0) return;
    let next = null;
    if (step) next = all[Math.max(0, Math.min(all.length - 1, at + step))];
    else if (event.key === "Home") next = all[0];
    else if (event.key === "End") next = all.at(-1);
    if (!next) return;
    event.preventDefault();
    event.stopPropagation(); // T3's own sidebar arrow keys are for its rows
    next.focus();
  });
  root.addEventListener("click", (event) => {
    const button = event.target.closest?.(".t3plus-status-row");
    if (button && root.contains(button)) onOpen?.(button.getAttribute(T3PLUS.statusThreadAttr));
  });

  /**
   * model: { groups (buildStatusModel), collapsed: { groupId: bool }, now, word(row) -> the
   * meta text's status word or "" }.
   */
  function update({ groups, collapsed = {}, now = Date.now(), word = (row) => STATUS_WORDS[row.status] }) {
    // A row that moves is taken out and put back: the focus on it would drop to the page.
    const focused = root.contains(doc.activeElement) ? doc.activeElement : null;
    const shownGroups = new Set(groups.map((g) => g.id));
    const shownRows = new Set();
    let previous = null;
    for (const group of groups) {
      const s = sectionFor(group);
      const isCollapsed = Boolean(collapsed[group.id]);
      if (s.collapsed !== isCollapsed) {
        s.collapsed = isCollapsed;
        s.header.setAttribute("aria-expanded", String(!isCollapsed));
        s.list.hidden = isCollapsed;
      }
      setText(s.count, String(group.rows.length));
      // In order, after the group before it (moved only when out of place).
      const after = previous ? previous.section.nextSibling : root.firstChild;
      if (after !== s.section) root.insertBefore(s.section, after);
      previous = s;
      // A collapsed group's rows are not drawn (their faces would animate unseen).
      if (isCollapsed) {
        for (const li of [...s.list.children]) li.remove();
        continue;
      }
      let cursor = s.list.firstChild;
      for (const row of group.rows) {
        shownRows.add(row.key);
        const r = rowFor(row.key);
        const status = word(row);
        const metaText = status || ago(row.at, now);
        const sig = `${row.title}\u0000${row.project}\u0000${row.status}\u0000${metaText}\u0000${row.current}`;
        if (sig !== r.sig) {
          r.sig = sig;
          setText(r.title, row.title || "Untitled");
          setText(r.project, row.project);
          r.project.hidden = !row.project;
          setText(r.meta, metaText);
          r.meta.dataset.status = status ? row.status : "";
          r.button.dataset.status = row.status;
          if (row.current) r.button.setAttribute("aria-current", "page");
          else r.button.removeAttribute("aria-current");
          r.button.setAttribute("aria-label", [row.title || "Untitled", STATUS_WORDS[row.status], row.project].filter(Boolean).join(", "));
        }
        avatar?.(r.face, row);
        if (r.li !== cursor) s.list.insertBefore(r.li, cursor);
        else cursor = cursor.nextSibling;
      }
      // What is left after the last row is no longer in this group.
      while (cursor) {
        const next = cursor.nextSibling;
        cursor.remove();
        cursor = next;
      }
    }
    for (const [id, s] of sections) if (!shownGroups.has(id)) s.section.remove();
    for (const [key, r] of rowsByKey) {
      if (shownRows.has(key)) continue;
      r.li.remove();
      rowsByKey.delete(key);
    }
    empty.hidden = groups.length > 0;
    if (!groups.length && empty.parentNode !== root) root.append(empty);
    if (focused && focused.isConnected && doc.activeElement !== focused) focused.focus({ preventScroll: true });
    setTabStop(root.contains(doc.activeElement) ? doc.activeElement : null);
  }
  // One Tab stop: where the focus is (the arrow keys move it), else the open thread's row,
  // else the first one there is.
  function setTabStop(at) {
    const all = [...root.querySelectorAll(".t3plus-status-head, .t3plus-status-row")];
    const stop = at ?? root.querySelector('.t3plus-status-row[aria-current="page"]') ?? all[0] ?? null;
    for (const el of all) {
      const tab = el === stop ? 0 : -1;
      if (el.tabIndex !== tab) el.tabIndex = tab;
    }
  }
  root.addEventListener("focusin", (event) => {
    if (event.target.matches?.(".t3plus-status-head, .t3plus-status-row")) setTabStop(event.target);
  });

  return {
    element: root,
    update,
    destroy() {
      root.remove();
      rowsByKey.clear();
      sections.clear();
    },
  };
}
