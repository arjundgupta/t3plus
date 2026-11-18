import { T3_SELECTORS } from "./config.js";

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

const route = (path) => ({
  thread: /^\/[^/]+\/[^/]+$/.test(path) && !path.startsWith("/settings") && !path.startsWith("/draft"),
  draft: path.startsWith("/draft"),
  settings: path.startsWith("/settings"),
  usage: path === "/usage",
});

/** { id, label, applies(doc, r), parts: { name: selector } } */
export const HEALTH_CHECKS = Object.freeze([
  {
    id: "sidebar",
    label: "Sidebar bots and profiles",
    applies: (doc) => Boolean(doc.querySelector(T3_SELECTORS.sidebarAny) && doc.querySelector(T3_SELECTORS.sidebarInner)?.offsetParent !== null),
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
    applies: (doc, r) => r.draft && Boolean(doc.querySelector(`${T3_SELECTORS.composerOverlay} .absolute.bottom-full`)),
    parts: { "new-thread composer": `${T3_SELECTORS.composerOverlay}.items-center`, "composer stack": T3_SELECTORS.composerStack },
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

export function createHealth({ win, doc, routePath, onChange = () => {}, schedule = () => {} }) {
  const missingSince = new Map(); // "check:part" -> first time it was seen missing
  let problems = [];
  let signature = "[]";
  let recheck = null;
  const now = () => win.performance?.now?.() ?? Date.now();

  function check() {
    const r = route(routePath());
    const t = now();
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
        schedule();
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
      if (recheck !== null) win.clearTimeout(recheck);
      recheck = null;
    },
  };
}
