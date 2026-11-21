import { T3_CLASSES, T3_SELECTORS, USAGE_ROUTE } from "./config.js";
import { threadKeyFromPath } from "./sidebar.js";

// Breakage reporting. t3+ hooks into T3's page through the selectors in
// config.js. When a T3 update renames one, the feature that uses it quietly
// finds nothing and does nothing; this says which feature and which part, so a
// broken update is obvious instead of "something looks off".
//
// Each check applies on some pages only (a thread, the new-thread page, Settings,
// Usage) and lists the parts of T3's page it needs there. A part counts as
// missing only after it has been missing for GRACE_MS on such a page, so a page
// that is still rendering never reports anything.

export const GRACE_MS = 5000;

/**
 * Which kind of T3 page `path` is. A thread page is read as the rest of t3+ reads it
 * (sidebar.js threadKeyFromPath): T3's own two-part pages (/settings/appearance,
 * /new/x, /pull-requests/42) are not threads and lack a conversation pane, so taking
 * them for one reported the glow as broken there. Exported for tests.
 */
export const healthRoute = (path) => ({
  thread: threadKeyFromPath(path) !== null,
  draft: path.startsWith("/draft"),
  settings: path.startsWith("/settings"),
  usage: path === USAGE_ROUTE,
});

/** { id, label, applies(doc, r), parts: { name: selector } } */
export const HEALTH_CHECKS = Object.freeze([
  {
    id: "sidebar",
    label: "Sidebar bots and profiles",
    // A list there but not shown (a closed sheet) is no missing part. checkVisibility()
    // reads styles only: offsetParent laid out the page, from a timer too.
    applies: (doc) => {
      const inner = doc.querySelector(T3_SELECTORS.sidebarInner);
      return Boolean(doc.querySelector(T3_SELECTORS.sidebarAny)) && (!inner || (inner.checkVisibility?.() ?? inner.offsetParent !== null));
    },
    parts: { "sidebar list": T3_SELECTORS.sidebarInner, "sidebar rows": T3_SELECTORS.sidebarRow, "sidebar footer": T3_SELECTORS.sidebarFooter },
  },
  {
    id: "thread",
    label: "Glow, glass composer and centering",
    applies: (doc, r) => r.thread,
    parts: { "conversation pane": T3_SELECTORS.conversationArea, "composer card": T3_SELECTORS.composerSurface, "composer lane": T3_SELECTORS.composerLane, "message list": T3_SELECTORS.messageList },
  },
  {
    id: "home",
    label: "New-thread page widgets",
    // Only while T3 shows the centered new-thread page (its headline hangs over the
    // composer): T3 docks a draft's composer while a worktree is set up or the draft
    // is working, and that is not a missing hook. Found without the stack hook, so a
    // renamed stack or centering class is still caught.
    applies: (doc, r) => r.draft && Boolean(doc.querySelector(T3_SELECTORS.overlayHeadline)),
    parts: { "new-thread composer": `${T3_SELECTORS.composerOverlay}.${T3_CLASSES.centered}`, "composer stack": T3_SELECTORS.composerStack },
  },
  {
    id: "details",
    label: "Pool card in thread details",
    applies: (doc, r) => r.thread && Boolean(doc.querySelector(T3_SELECTORS.threadDetailsPanel)),
    parts: { "thread details card": T3_SELECTORS.threadDetailsCard },
  },
  {
    id: "settings",
    label: "t3+ entry in Settings",
    applies: (doc, r) => r.settings,
    parts: { "Appearance link": T3_SELECTORS.settingsAppearanceLink },
  },
  {
    id: "usage",
    label: "Dithered Usage chart",
    applies: (doc, r) => r.usage,
    parts: { "usage chart": T3_SELECTORS.usageChart },
  },
]);

// Every DOM check asks (about every frame while T3 changes the page), but a part missing
// now is reported only GRACE_MS from now: on one page, a look at most this often.
export const MIN_GAP_MS = 1000;

export function createHealth({ win, doc, routePath, onChange = () => {} }) {
  const missingSince = new Map(); // "check:part" -> first time it was seen missing
  let problems = [];
  let signature = "[]";
  let recheck = null;
  let trailing = null;
  let lastRun = -Infinity;
  let lastPath = null;
  const now = () => win.performance?.now?.() ?? Date.now();

  /**
   * In every DOM check: the problems as last looked at. A look runs at once on a new page,
   * else at most every MIN_GAP_MS, with one more after the last check asking for one (a
   * part T3 removed in the last change before the page went quiet is still seen).
   */
  function check() {
    const path = routePath();
    const t = now();
    if (path === lastPath && t - lastRun < MIN_GAP_MS) {
      trailing ??= win.setTimeout(() => look(), MIN_GAP_MS - (t - lastRun));
      return problems;
    }
    return look(path, t);
  }

  // Its own timers look by themselves: asking for a DOM check (all of t3+'s steps) to have
  // this one run cost many times more than the look.
  function look(path = routePath(), t = now()) {
    if (trailing !== null) win.clearTimeout(trailing);
    trailing = null;
    lastRun = t;
    lastPath = path;
    const r = healthRoute(path);
    const seen = new Set();
    const next = [];
    let pending = false;
    for (const c of HEALTH_CHECKS) {
      let applies = false;
      try {
        applies = c.applies(doc, r);
      } catch {
        applies = false;
      }
      if (!applies) continue;
      const missing = [];
      for (const [name, selector] of Object.entries(c.parts)) {
        const key = `${c.id}:${name}`;
        let found = false;
        try {
          found = Boolean(doc.querySelector(selector));
        } catch {
          found = false;
        }
        if (found) continue;
        seen.add(key);
        if (!missingSince.has(key)) missingSince.set(key, t);
        if (t - missingSince.get(key) >= GRACE_MS) missing.push(name);
        else pending = true;
      }
      if (missing.length) next.push({ feature: c.label, missing });
    }
    for (const key of [...missingSince.keys()]) if (!seen.has(key)) missingSince.delete(key);
    // Something just went missing: look again once the grace period is over.
    if (pending && recheck === null) {
      recheck = win.setTimeout(() => {
        recheck = null;
        look();
      }, GRACE_MS + 50);
    }
    const nextSignature = JSON.stringify(next);
    if (nextSignature !== signature) {
      signature = nextSignature;
      problems = next;
      onChange(problems);
    }
    return problems;
  }

  return {
    check,
    get problems() {
      return problems;
    },
    stop() {
      for (const timer of [recheck, trailing]) if (timer !== null) win.clearTimeout(timer);
      recheck = null;
      trailing = null;
    },
  };
}
