import { STORAGE_KEYS } from "./config.js";

// Updates: the desktop loader checks t3+'s public repository on GitHub for its latest
// release once a day (inject/main-loader.js) and hands the page { latest, url }. When
// that is newer than the version running, a popup on the main screen says so once (its
// Update opens Settings → t3+), Settings → t3+ shows a card with the command that updates
// it, and the t3+ entry in Settings' sidebar a dot. Hiding the card hides them all until
// the next release. The page itself makes no request.

/** The commands that update t3+ (the README's): on macOS, and in Windows' PowerShell. */
export const UPDATE_COMMAND = "git -C ~/.t3plus pull && sh ~/.t3plus/build.sh && node ~/.t3plus/t3plus.mjs on";
export const WINDOWS_UPDATE_COMMAND = 'git -C "$HOME\\.t3plus" pull; node "$HOME\\.t3plus\\windows\\build.mjs"; node "$HOME\\.t3plus\\t3plus.mjs" on; node "$HOME\\.t3plus\\windows\\startup.mjs" on';
/** The one for the computer `win` is on. */
export const updateCommand = (win) => (/\bWindows NT\b/.test(win?.navigator?.userAgent ?? "") ? WINDOWS_UPDATE_COMMAND : UPDATE_COMMAND);

const VERSION = /^v?(\d+)\.(\d+)\.(\d+)$/;

/** True when `latest` is a later x.y.z than `current`. Anything else (unparsable) is not. */
export function isNewer(latest, current) {
  const a = VERSION.exec(String(latest ?? ""));
  const b = VERSION.exec(String(current ?? ""));
  if (!a || !b) return false;
  for (let i = 1; i <= 3; i += 1) {
    const d = Number(a[i]) - Number(b[i]);
    if (d) return d > 0;
  }
  return false;
}

/** The loader's release info, kept only when it is what it should be. */
export function normalizeRelease(info) {
  if (!info || typeof info !== "object") return null;
  const latest = String(info.latest ?? "").replace(/^v/, "");
  if (!VERSION.test(latest)) return null;
  const url = typeof info.url === "string" && info.url.startsWith("https://github.com/") ? info.url : null;
  return { latest, url };
}

/**
 * The release to tell about: `pending` is { latest, url, current } while a newer release
 * than `version` is out and its card was not hidden, else null. `onChange` runs when that
 * may have changed (the loader's info came in, the card was hidden here or in another window).
 */
export function createUpdateNotice({ area, changedEvent, version, release = null, onChange = () => {} }) {
  let info = normalizeRelease(release);
  let dismissed = null;
  let toastSeen = null; // the release whose popup was closed or followed
  let loaded = false; // what was hidden is known (the popup waits for it)
  let stopped = false;
  const onStored = (changes, areaName) => {
    if (areaName && areaName !== "local") return;
    let moved = false;
    for (const [key, set] of [[STORAGE_KEYS.updateDismissed, (v) => (dismissed = v)], [STORAGE_KEYS.updateToastSeen, (v) => (toastSeen = v)]]) {
      const change = changes?.[key];
      if (!change) continue;
      set(typeof change.newValue === "string" ? change.newValue : null);
      moved = true;
    }
    if (moved) onChange();
  };
  return {
    get pending() {
      if (!info || !isNewer(info.latest, version) || dismissed === info.latest) return null;
      return { ...info, current: version };
    },
    /** The popup on the main screen: once per release, while its card is not hidden either. */
    get toastDue() {
      const pending = this.pending;
      return loaded && pending && toastSeen !== pending.latest ? pending : null;
    },
    /** The popup was closed, or its Update followed: not shown again for `latest`. */
    toastDone(latest) {
      toastSeen = latest;
      onChange();
      Promise.resolve(area?.set({ [STORAGE_KEYS.updateToastSeen]: latest })).catch(() => {});
    },
    /** The loader's latest release, at boot or after a check. */
    set(next) {
      const value = normalizeRelease(next);
      if (JSON.stringify(value) === JSON.stringify(info)) return;
      info = value;
      onChange();
    },
    /** Hides the card (and the dot) until a release after `latest`. */
    dismiss(latest) {
      dismissed = latest;
      onChange();
      Promise.resolve(area?.set({ [STORAGE_KEYS.updateDismissed]: latest })).catch(() => {});
    },
    async start() {
      changedEvent?.addListener?.(onStored);
      try {
        const stored = (await area?.get([STORAGE_KEYS.updateDismissed, STORAGE_KEYS.updateToastSeen])) ?? {};
        const value = (key) => (typeof stored[key] === "string" ? stored[key] : null);
        dismissed ??= value(STORAGE_KEYS.updateDismissed);
        toastSeen ??= value(STORAGE_KEYS.updateToastSeen);
      } catch {
        // nothing stored: the card and the popup show
      }
      if (stopped) return;
      loaded = true;
      onChange();
    },
    stop() {
      stopped = true;
      changedEvent?.removeListener?.(onStored);
    },
  };
}

const CLOSE_ICON = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>';

/**
 * The popup in the corner of the main screen: "t3+ 0.23.3 is out", an Update button
 * (`onOpen`) and a close button (`onClose`). It never takes the focus: a screen reader
 * hears it politely.
 */
export function createUpdateToast(doc, { onOpen, onClose }) {
  const el = doc.createElement("div");
  el.className = "t3plus-update-toast";
  el.setAttribute("role", "status");
  el.setAttribute("aria-live", "polite");
  el.hidden = true;
  const text = doc.createElement("div");
  text.className = "t3plus-update-toast-text";
  const title = doc.createElement("p");
  title.className = "t3plus-update-toast-title";
  const desc = doc.createElement("p");
  desc.className = "t3plus-update-toast-desc";
  text.append(title, desc);
  const open = doc.createElement("button");
  open.type = "button";
  open.className = "t3plus-update-toast-open";
  open.textContent = "Update";
  const close = doc.createElement("button");
  close.type = "button";
  close.className = "t3plus-update-toast-close";
  close.setAttribute("aria-label", "Close");
  close.innerHTML = CLOSE_ICON;
  el.append(text, open, close);
  let shown = null;
  open.addEventListener("click", () => shown && onOpen(shown));
  close.addEventListener("click", () => shown && onClose(shown));
  return {
    element: el,
    /** Shows the popup for `update` ({ latest, current }), or takes it away (null). */
    show(update) {
      shown = update?.latest ?? null;
      if (!update) {
        el.hidden = true;
        el.remove();
        return;
      }
      title.textContent = `t3+ ${update.latest} is out`;
      desc.textContent = update.current ? `You have ${update.current}.` : "A new version of t3+.";
      el.hidden = false;
      if (!el.isConnected) doc.body.append(el);
    },
  };
}
