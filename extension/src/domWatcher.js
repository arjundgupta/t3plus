/**
 * Runs `check` after DOM mutations and SPA navigations. No polling.
 *
 * With `frames` (the live app), a check runs in the next animation frame,
 * before the browser paints it: whatever T3 just changed (a panel opened, a
 * route rendered, rows added) is followed by t3+ in that same frame, so its
 * glow, widgets and decorations never show a frame late or out of place.
 * Several changes in one frame share one check. Only a storm of changes (more
 * than STORM_CHECKS checks within a second) falls back to one check per
 * `throttleMs`, which bounds the cost of anything that keeps the DOM busy. The
 * storm lasts while changes keep coming (each within a check or so of the
 * last) and ends once they pause. During one, `quick` (when given) still runs
 * every frame that had a change: what must never show a frame late (screenshot
 * mode's cover) keeps up while the full check waits.
 * Without frames (tests), checks wait `throttleMs` as before.
 *
 * `isNoise(node)`, when given, marks mutations t3+ never needs to react to
 * (text streaming into the message list): a batch made only of those is
 * dropped without scheduling a check.
 */
const STORM_CHECKS = 40;
const STORM_HOLD_MS = 1000;

export function createDomWatcher({ win, doc, check, throttleMs, isNoise = null, frames = false, quick = null }) {
  let timer = null;
  let frame = null;
  let observer = null;
  let lastRun = -Infinity;
  // After a navigation, checks skip the throttle for a short burst, so route
  // changes (the glow moving, the home cards) follow T3 immediately.
  let burstUntil = -Infinity;
  const BURST_MS = 600;
  const now = () => win.performance?.now?.() ?? Date.now();
  const raf = frames && typeof win.requestAnimationFrame === "function" ? (f) => win.requestAnimationFrame(f) : null;
  let windowStart = -Infinity;
  let windowChecks = 0;
  // A storm, once it starts, holds until the changes pause. Measured per second
  // only, it ended every second: after a throttled tail, checks went back to
  // every frame, and a sustained storm still ran about 40 checks a second.
  let stormUntil = -Infinity;
  let lastAsk = -Infinity;
  const stormGap = Math.max(250, throttleMs * 1.5);
  let quickFrame = null;
  // Between start() and stop() only: a late schedule() (a save or feed read that
  // finished after stop) must not run a check in a stopped copy.
  let running = false;
  // Text changed in place (React sets a text node's value, as when a reply
  // streams) is a characterData mutation. Only screenshot mode needs those.
  let watchText = false;
  const options = () => ({ childList: true, subtree: true, characterData: watchText });

  function run() {
    if (timer !== null) win.clearTimeout(timer);
    if (frame !== null) win.cancelAnimationFrame?.(frame);
    timer = null;
    frame = null;
    const t = now();
    if (t - windowStart > 1000) {
      windowStart = t;
      windowChecks = 0;
    }
    windowChecks += 1;
    if (windowChecks >= STORM_CHECKS) stormUntil = Math.max(stormUntil, t + STORM_HOLD_MS);
    lastRun = t;
    if (quickFrame !== null) win.cancelAnimationFrame?.(quickFrame);
    quickFrame = null;
    check();
  }

  function runQuick() {
    quickFrame = null;
    if (running) quick();
  }

  // A hidden page (background tab, minimized window) owes nobody a repaint: the
  // check waits until the page is shown again.
  let owed = false;
  function schedule() {
    if (!running) return;
    if (doc.visibilityState === "hidden") {
      owed = true;
      return;
    }
    const t = now();
    if (t < stormUntil && t - lastAsk < stormGap) stormUntil = t + STORM_HOLD_MS;
    lastAsk = t;
    if (frame !== null) return;
    const bursting = t < burstUntil;
    const storming = t < stormUntil;
    if (raf && storming && !bursting && quick && quickFrame === null) quickFrame = raf(runQuick);
    if (timer !== null) return;
    if (raf && (bursting || !storming)) {
      frame = raf(run);
      return;
    }
    const wait = bursting ? 0 : Math.max(0, throttleMs - (t - lastRun));
    timer = win.setTimeout(run, wait);
  }

  const onVisibility = () => {
    if (doc.visibilityState === "hidden" || !owed) return;
    owed = false;
    schedule();
  };

  const onNavigate = () => {
    burstUntil = now() + BURST_MS;
    if (timer !== null) {
      win.clearTimeout(timer);
      timer = null;
    }
    schedule();
  };

  return {
    start() {
      running = true;
      observer = new win.MutationObserver((records) => {
        if (isNoise && records.every((record) => isNoise(record.target))) return;
        schedule();
      });
      observer.observe(doc.documentElement, options());
      // T3 uses client-side routing. The Navigation API sees pushState too;
      // popstate covers back/forward where it is missing.
      win.navigation?.addEventListener?.("currententrychange", onNavigate);
      win.addEventListener("popstate", onNavigate);
      doc.addEventListener("visibilitychange", onVisibility);
      run();
    },
    stop() {
      running = false;
      observer?.disconnect();
      observer = null;
      win.navigation?.removeEventListener?.("currententrychange", onNavigate);
      win.removeEventListener("popstate", onNavigate);
      doc.removeEventListener("visibilitychange", onVisibility);
      if (timer !== null) win.clearTimeout(timer);
      if (frame !== null) win.cancelAnimationFrame?.(frame);
      if (quickFrame !== null) win.cancelAnimationFrame?.(quickFrame);
      timer = null;
      frame = null;
      quickFrame = null;
    },
    schedule,
    /** Also react to text changed in place (screenshot mode covers streaming text). */
    watchTextChanges(on) {
      if (watchText === Boolean(on)) return;
      watchText = Boolean(on);
      observer?.observe(doc.documentElement, options());
    },
    /** Runs a pending check now. For tests, layout changes (ResizeObserver) and state changes that should show immediately. */
    flush() {
      run();
    },
    /** True while changes are coming faster than one check per frame can follow. */
    storming() {
      return now() < stormUntil;
    },
  };
}
