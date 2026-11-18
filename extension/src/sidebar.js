import { NON_THREAD_ROUTE_SEGMENTS, SIDEBAR_ROW_PREFIX, T3_SELECTORS, T3PLUS } from "./config.js";

// Reads T3's sidebar through its stable row hooks. t3+ never moves, re-creates
// or re-parents T3's rows; bot rows are decorated in place (bots.js).

/**
 * The thread sidebar: the sidebar-inner that holds thread rows or project
 * folders. Null on pages where the sidebar shows something else (or nothing),
 * so nothing is read from an unrelated panel.
 */
export function findSidebarInner(doc) {
  for (const inner of doc.querySelectorAll(T3_SELECTORS.sidebarInner)) {
    if (inner.querySelector(`${T3_SELECTORS.threadItem}, ${T3_SELECTORS.projectFolderItem}`)) return inner;
  }
  return null;
}

/**
 * Snapshot of the sidebar's rows.
 * threads: [{ key, li, row, parent, folderKey, title, titleEl, ariaLabel, current }]
 * folders: Map<logicalProjectKey, { li, row }>
 * shelves: Map<"shelf:x", li>
 */
export function scanSidebar(inner, { textOf = null } = {}) {
  const threads = [];
  const folders = new Map();
  const shelves = new Map();
  if (!inner) return { threads, folders, shelves, folderMode: false };

  for (const row of inner.querySelectorAll(T3_SELECTORS.sidebarRow)) {
    const id = row.getAttribute("data-sidebar-row") ?? "";
    const li = row.closest("li");
    // T3's list motion fades removed rows out as inert, aria-hidden clones; skip them.
    if (li && li.hasAttribute("inert") && li.getAttribute("aria-hidden") === "true") continue;
    if (id.startsWith(SIDEBAR_ROW_PREFIX.folder)) {
      if (li) folders.set(id.slice(SIDEBAR_ROW_PREFIX.folder.length), { li, row });
      continue;
    }
    if (id.startsWith(SIDEBAR_ROW_PREFIX.shelf)) {
      if (li) shelves.set(id, li);
      continue;
    }
    const item = row.closest(T3_SELECTORS.threadItem);
    if (!item || item.getAttribute("data-thread-item") !== id) continue;
    const parent = row.getAttribute("data-sidebar-parent");
    const titleInfo = readRowTitle(row, textOf);
    const ariaParts = (row.getAttribute("aria-label") ?? "").split(", ");
    const projectKey = row.getAttribute("data-project-key") ?? row.getAttribute("data-project") ?? (ariaParts.length > 1 ? ariaParts.at(-1) : null);
    threads.push({
      key: id,
      li: item,
      row,
      parent,
      folderKey: parent?.startsWith(SIDEBAR_ROW_PREFIX.folder) ? parent.slice(SIDEBAR_ROW_PREFIX.folder.length) : null,
      projectKey,
      title: titleInfo.title,
      titleEl: titleInfo.titleEl,
      ariaLabel: row.getAttribute("aria-label") ?? "",
      current: row.getAttribute("aria-current") === "page",
    });
  }
  return { threads, folders, shelves, folderMode: folders.size > 0 };
}

/**
 * T3 renders the title twice: an sr-only copy (exact text) and an aria-hidden
 * visible span with a dir attribute. Returns both (visible one may be null
 * while the row is being renamed). `textOf(el)` reads an element's text (screenshot
 * mode passes one that sees through its stand-ins: read back, a stand-in title was
 * taken for the real one, and the row's status and the remembered title with it).
 */
export function readRowTitle(row, textOf = null) {
  const text = (el) => (textOf ? textOf(el) : (el.textContent ?? ""));
  const srOnly = row.querySelector(T3_SELECTORS.rowSrOnlyTitle);
  let title = srOnly ? text(srOnly) : "";
  let titleEl = null;
  if (title) {
    for (const span of row.querySelectorAll(T3_SELECTORS.rowVisibleTitle)) {
      if (span.childElementCount === 0 && text(span) === title) {
        titleEl = span;
        break;
      }
    }
  }
  if (!titleEl) {
    // T3's project-grouped rows have no sr-only copy: the visible [dir] span is the title.
    const span = row.querySelector(T3_SELECTORS.rowDirTitle);
    if (span && span.childElementCount === 0 && (!title || text(span) === title)) {
      titleEl = span;
      title ||= text(span);
    }
  }
  if (!titleEl && !title) {
    // T3 leaves dir off a title with no letter in it ("2025", only emoji): then the
    // title is the plain span the row's label ("<title>, <status>, <project>") starts with.
    const label = row.getAttribute("aria-label") ?? "";
    for (const span of row.querySelectorAll("span")) {
      if (span.childElementCount !== 0 || span.hasAttribute("role") || span.closest(`[${T3PLUS.ownedAttr}]`)) continue;
      const value = text(span);
      if (value.trim() && (label === value || label.startsWith(`${value}, `))) {
        titleEl = span;
        title = value;
        break;
      }
    }
  }
  return { title, titleEl };
}

/** "/<environmentId>/<threadId>" -> "<environmentId>:<threadId>", else null. */
export function threadKeyFromPath(pathname) {
  const parts = String(pathname ?? "").split("/").filter(Boolean);
  if (parts.length !== 2 || NON_THREAD_ROUTE_SEGMENTS.includes(parts[0])) return null;
  try {
    const [environmentId, threadId] = parts.map(decodeURIComponent);
    return environmentId && threadId ? `${environmentId}:${threadId}` : null;
  } catch {
    return null;
  }
}
