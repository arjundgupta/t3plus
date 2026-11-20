import { STORAGE_KEYS, T3PLUS } from "./config.js";

// What's New: what changed in each t3+ version, in plain words. After an update it
// opens once on its own (a sheet over T3, like an editor's "What's New" tab); it is
// always in Settings → t3+ too. A fresh install opens nothing.
//
// For a release: name the "Unreleased" entry after the new version (package.json),
// as in CHANGELOG.md. Each note is [lead, text]: "Lead: text."

export const WHATS_NEW = Object.freeze([
  {
    version: "0.22.0",
    date: "2026-11-20",
    notes: [
      ["What's New", "after t3+ updates, this list opens once to show what changed. It's always in Settings → t3+ too."],
      ["Threads swap smoothly", "switching profiles fades the chat out and the profile's thread in, instead of cutting over."],
      ["Roomier Settled rows", "bot rows under Settled have space above and below their two lines."],
      ["Which profile you're in", "its name sits beside the dots in its color, with an icon if you pick one."],
      ["Profile colors", "each profile has a dot color, a sky color (the sky at the top of the sidebar) and a dither color (the glow behind the chat), picked on their own. Right-click a dot for them, or use Settings → t3+ → Profiles for your own colors and a live preview."],
    ],
  },
  {
    version: "0.21.0",
    date: "2026-11-19",
    notes: [
      ["Profiles slide like Dia", "the open profile's list slides away as the next one slides in beside it. The sidebar is never blank."],
      ["Swipe with your fingers", "a two-finger swipe on the sidebar moves the lists as you go. Let go past a third of the way (or flick) to switch, or it springs back. One swipe is one switch, however long its momentum."],
      ["Smoother switching", "the profile's thread opens while the list slides, and T3 drawing it no longer stalls the slide. Each profile keeps its place in the list."],
      ["Keyboard", "Enter or Space on a profile dot keeps the focus on the dots, and holding Ctrl+Shift+1–9 switches once."],
    ],
  },
  {
    version: "0.20.0",
    date: "2026-11-19",
    notes: [
      ["Profiles keep their thread", "switching opens the thread you last had open in that profile (else its most recent), and opening another profile's thread (⌘K, a link) switches to that profile."],
      ["Bots in Settings", "a row of chips, A to Z. Click one to change its shape or color; Escape closes it."],
      ["Saturn faces", "no longer sit on a colored square."],
    ],
  },
  {
    version: "0.19.0",
    date: "2026-11-17",
    notes: [
      ["Shortcuts", "t3+'s shortcuts are for profiles only. Screenshot mode is off by default and set in Settings."],
      ["Exact thread spend", "priced the way T3's Usage page prices it: long-context and fast rates, and each message once per thread."],
      ["Screenshot mode covers more", "branch and machine names, side chats, T3's tooltips, menus, toasts and dialogs, and the window title."],
      ["Fixes", "from a full code review: two endless loops, new projects vanishing from a profile, bot faces changing when other rows come and go, and more."],
    ],
  },
]);

/** -1, 0 or 1 for two "1.2.3" versions. */
export function compareVersions(a, b) {
  const pa = String(a).split(".").map((n) => Number.parseInt(n, 10) || 0);
  const pb = String(b).split(".").map((n) => Number.parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i += 1) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) < (pb[i] ?? 0) ? -1 : 1;
  return 0;
}

/** Opens on its own only after an update to a version with notes (not on a fresh install). */
export function shouldShowWhatsNew(seen, version, entries = WHATS_NEW) {
  if (!seen || !version || !/^\d+\.\d+\.\d+$/.test(seen)) return false;
  return compareVersions(version, seen) > 0 && entries.some((e) => e.version === version);
}

/** The notes as headings and lists; the installed version is marked. */
export function renderNotes(doc, { version, entries = WHATS_NEW, headingLevel = "h3", titles = true } = {}) {
  const root = doc.createElement("div");
  root.className = "t3plus-notes";
  for (const entry of entries) {
    const block = doc.createElement("section");
    block.className = "t3plus-notes-version";
    const head = doc.createElement(headingLevel);
    head.className = "t3plus-notes-title";
    head.textContent = entry.version === "Unreleased" ? "Next update" : entry.version;
    const badge = entry.version === version ? "Installed" : entry.version === "Unreleased" ? "In this build" : null;
    if (badge) {
      const b = doc.createElement("span");
      b.className = "t3plus-notes-badge";
      b.textContent = badge;
      head.append(" ", b);
    }
    const list = doc.createElement("ul");
    for (const [lead, text] of entry.notes) {
      const li = doc.createElement("li");
      const strong = doc.createElement("strong");
      strong.textContent = `${lead}:`;
      li.append(strong, ` ${text}`);
      list.append(li);
    }
    if (titles) block.append(head);
    block.append(list);
    root.append(block);
  }
  return root;
}

export function createWhatsNew({ win, doc, area, version, entries = WHATS_NEW }) {
  const key = STORAGE_KEYS.whatsNew;
  let sheet = null;
  let returnFocus = null;
  let openTimer = null;
  let running = false;
  let lastKey = -Infinity;
  let walled = []; // the page behind the sheet, made inert while it is open
  const onType = () => (lastKey = win.performance.now());

  function close() {
    if (!sheet) return;
    sheet.remove();
    sheet = null;
    for (const el of walled) el.removeAttribute("inert");
    walled = [];
    if (returnFocus?.isConnected) returnFocus.focus({ preventScroll: true });
    returnFocus = null;
  }
  // Keys while the sheet is open are the sheet's. Listening on the window from the start
  // (before T3 adds its own) and marking them handled: T3's shortcuts skip a key whose
  // default is prevented (⌘K, ⌘B and the composer's do nothing behind the sheet).
  function onKey(event) {
    if (!sheet) return;
    const inSheet = sheet.contains(event.target);
    event.stopImmediatePropagation();
    if (event.key === "Escape") {
      event.preventDefault();
      close();
      return;
    }
    if (event.key === "Tab") {
      event.preventDefault();
      const focusable = [...sheet.querySelectorAll("button, a[href]")];
      if (!focusable.length) return;
      const at = focusable.indexOf(doc.activeElement);
      const next = at < 0 ? (event.shiftKey ? focusable.length - 1 : 0) : (at + (event.shiftKey ? -1 : 1) + focusable.length) % focusable.length;
      focusable[next].focus();
      return;
    }
    // Enter or Space on the sheet's own button still presses it.
    if (inSheet && (event.key === "Enter" || event.key === " ")) return;
    event.preventDefault();
  }
  win.addEventListener("keydown", onKey, true);

  /** The sheet with every version's notes, over T3. */
  function open() {
    if (sheet) return;
    win.clearTimeout(openTimer);
    returnFocus = doc.activeElement instanceof win.HTMLElement ? doc.activeElement : null;
    sheet = doc.createElement("div");
    sheet.className = "t3plus-whatsnew";
    sheet.setAttribute(T3PLUS.ownedAttr, "");
    sheet.setAttribute("role", "dialog");
    sheet.setAttribute("aria-modal", "true");
    sheet.setAttribute("aria-labelledby", "t3plus-whatsnew-title");
    const page = doc.createElement("div");
    page.className = "t3plus-whatsnew-page";
    const header = doc.createElement("header");
    header.className = "t3plus-whatsnew-header";
    const title = doc.createElement("h2");
    title.id = "t3plus-whatsnew-title";
    title.textContent = "What's New";
    const sub = doc.createElement("p");
    sub.textContent = `t3+ ${version}`;
    const heading = doc.createElement("div");
    heading.append(title, sub);
    const closeButton = doc.createElement("button");
    closeButton.type = "button";
    closeButton.className = "t3plus-whatsnew-close";
    closeButton.setAttribute("aria-label", "Close What's New");
    closeButton.textContent = "×";
    closeButton.addEventListener("click", close);
    header.append(heading, closeButton);
    page.append(header, renderNotes(doc, { version, entries }));
    sheet.append(page);
    // A click on the dimmed space around the page closes it.
    sheet.addEventListener("click", (event) => {
      if (event.target === sheet) close();
    });
    // The page behind is out of reach (Tab, a screen reader) while it is open.
    walled = [...doc.body.children].filter((el) => !el.hasAttribute("inert"));
    for (const el of walled) el.setAttribute("inert", "");
    doc.body.append(sheet);
    if (!win.matchMedia?.("(prefers-reduced-motion: reduce)").matches) {
      sheet.animate?.([{ opacity: 0 }, { opacity: 1 }], { duration: 180, easing: "cubic-bezier(0, 0, 0.2, 1)" });
    }
    closeButton.focus({ preventScroll: true });
  }

  return {
    open,
    close,
    get isOpen() {
      return Boolean(sheet);
    },
    async start() {
      running = true;
      if (!version || !area) return;
      let got;
      try {
        got = await area.get([key, STORAGE_KEYS.settings, STORAGE_KEYS.profiles]);
      } catch {
        return; // unreadable: try again next start, nothing marked seen
      }
      if (!running) return;
      let seen = got?.[key] ?? null;
      // No record, but t3+ was here before (its settings or profiles): an update from a
      // version before What's New, or a reinstall that brought them back.
      if (!seen && (got?.[STORAGE_KEYS.settings] !== undefined || got?.[STORAGE_KEYS.profiles] !== undefined)) seen = "0.0.0";
      const show = shouldShowWhatsNew(seen, version, entries);
      // Several windows starting at once: the last to claim it opens it.
      const claim = show ? `${version}:${Math.random().toString(36).slice(2)}` : null;
      if (got?.[key] !== version || claim) {
        try {
          await area.set({ [key]: version, ...(claim ? { [STORAGE_KEYS.whatsNewClaim]: claim } : {}) });
        } catch {
          return;
        }
      }
      if (!show || !running) return;
      win.addEventListener("keydown", onType, true);
      // Once T3 has settled in, where it can be seen, and not while you type (its close
      // button takes the focus).
      const attempt = async () => {
        if (!running) return;
        if (doc.visibilityState === "hidden") {
          doc.addEventListener("visibilitychange", attempt, { once: true });
          return;
        }
        if (win.performance.now() - lastKey < 2000) {
          openTimer = win.setTimeout(attempt, 1000);
          return;
        }
        const mine = (await area.get(STORAGE_KEYS.whatsNewClaim).catch(() => ({})))?.[STORAGE_KEYS.whatsNewClaim] === claim;
        win.removeEventListener("keydown", onType, true);
        if (running && mine) open();
      };
      openTimer = win.setTimeout(attempt, 1500);
    },
    stop() {
      running = false;
      win.clearTimeout(openTimer);
      win.removeEventListener("keydown", onType, true);
      win.removeEventListener("keydown", onKey, true);
      close();
    },
  };
}
