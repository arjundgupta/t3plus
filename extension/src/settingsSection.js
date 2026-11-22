import { T3PLUS, T3_SELECTORS } from "./config.js";

// t3+ gets its own entry in T3's Settings sidebar, right after Appearance.
// T3's settings router knows nothing about it, so "opening" t3+ is a view mode:
// <html data-t3plus-settings> hides T3's sections on the current settings page
// and shows the t3+ panel in their place. Any T3 settings link, or leaving the
// page, closes it again. Nothing of T3's is moved or re-rendered.

/** Any T3 settings page. */
export const SETTINGS_ROUTE = /\/settings(\/|$)/;

const NAV_ANCHOR = T3_SELECTORS.settingsAppearanceLink;
const PAGE = T3_SELECTORS.settingsPage;
/** T3's entry for the settings page t3+ is open over (t3+'s own entry is current then too). */
const T3_CURRENT_ENTRY = `${T3_SELECTORS.settingsNavCurrent}:not([${T3PLUS.ownedAttr}])`;
/** On that entry while t3+'s holds its aria-current. */
const MOVED_ATTR = "data-t3plus-current-moved";

// lucide "square-plus", in T3's icon style.
const ICON = '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect width="18" height="18" x="3" y="3" rx="4"/><path d="M8 12h8"/><path d="M12 8v8"/></svg>';

/** Copies `names` from `source` to `target`, removing those `source` does not have. */
function mirror(target, source, names) {
  for (const name of names) {
    const value = source.getAttribute(name);
    if (value === null) target.removeAttribute(name);
    else if (target.getAttribute(name) !== value) target.setAttribute(name, value);
  }
}

/** T3's Appearance nav button, the anchor for the t3+ entry. */
export function findSettingsNavAnchor(doc) {
  return doc.querySelector(NAV_ANCHOR);
}

/** The column that holds the sections of the current settings page. */
export function findSettingsPage(doc) {
  return doc.querySelector(PAGE);
}

/**
 * The owned nav item: an <li> shaped like T3's, holding a button that copies
 * the Appearance button's classes, so hover, focus and the active state come
 * from T3's own stylesheet (data-active="true").
 */
export function createSettingsNavItem(doc, onOpen) {
  const li = doc.createElement("li");
  li.setAttribute(T3PLUS.ownedAttr, "");
  li.setAttribute("data-slot", "sidebar-menu-item");
  li.setAttribute("data-sidebar", "menu-item");
  li.className = "group/menu-item relative";
  const button = doc.createElement("button");
  button.type = "button";
  button.setAttribute(T3PLUS.ownedAttr, "");
  button.setAttribute("data-sidebar", "menu-button");
  button.setAttribute("data-slot", "sidebar-menu-button");
  button.setAttribute("data-size", "default");
  button.setAttribute("data-t3plus-settings-nav", "");
  // T3's arrow keys move focus between [data-settings-section] entries (focus only:
  // its clicks route by handler, not by this value), so t3+'s entry is one of them.
  button.setAttribute("data-settings-section", "t3plus");
  button.innerHTML = `${ICON}<span class="truncate max-md:sr-only">t3+</span>`;
  button.addEventListener("click", (event) => {
    event.preventDefault();
    onOpen();
  });
  li.appendChild(button);
  let moved = null; // T3's entry whose aria-current t3+'s holds while it is open

  return {
    element: li,
    button,
    /** Puts the item right after `anchor`'s <li>. Returns true when the DOM changed. */
    mount(anchor) {
      const anchorItem = anchor.closest("li");
      if (!anchorItem?.parentElement) return false;
      if (button.className !== anchor.className) button.className = anchor.className;
      // Reachable and announced like T3's own entries: the same role and tab stop
      // as the Appearance button (and its <li>), whatever this T3 version uses.
      mirror(button, anchor, ["role", "tabindex"]);
      mirror(li, anchorItem, ["role"]);
      if (anchorItem.nextElementSibling === li) return false;
      anchorItem.after(li);
      return true;
    },
    /** A dot on the entry while a newer t3+ release is out (updateNotice.js). */
    setUpdate(on) {
      button.toggleAttribute("data-t3plus-update", Boolean(on));
      if (on) button.setAttribute("title", "t3+ update available");
      else button.removeAttribute("title");
    },
    setActive(on) {
      const value = on ? "true" : "false";
      if (button.getAttribute("data-active") !== value) {
        button.setAttribute("data-active", value);
        // aria-selected only means something on a tab/treeitem/option role.
        if (button.hasAttribute("role")) button.setAttribute("aria-selected", value);
        else button.removeAttribute("aria-selected");
        if (on) button.setAttribute("aria-current", "page");
        else button.removeAttribute("aria-current");
      }
      // One current page: the entry of the settings page t3+ is open over (any of them,
      // in any of T3's nav groups) is not it while t3+ is open, and is again after, if T3
      // still has it active. This runs in every check: the page is looked through only
      // when t3+ opens (or T3 draws its nav anew), and nothing is held once it closes.
      if (on) {
        if (moved?.isConnected && !moved.hasAttribute("aria-current")) return;
        moved?.removeAttribute(MOVED_ATTR);
        moved = doc.querySelector(T3_CURRENT_ENTRY);
        if (moved) {
          moved.removeAttribute("aria-current");
          moved.setAttribute(MOVED_ATTR, "");
        }
      } else if (moved) {
        moved.removeAttribute(MOVED_ATTR);
        if (moved.isConnected && moved.getAttribute("data-active") === "true") moved.setAttribute("aria-current", "page");
        moved = null;
      }
    },
  };
}
