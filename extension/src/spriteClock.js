// Steps the bot sprites (the working / needs-you faces and their badges).
//
// A CSS animation on background-position is ticked on the main thread at the
// display's rate, 60 times a second or more, although these sprites change
// only three to six times a second. This clock wakes exactly when one of them
// is due its next frame and moves it by writing one custom property on that
// element (content.css reads --t3plus-bot-x / --t3plus-badge-x), so a working
// bot costs a handful of tiny style updates per second and nothing in between.
// It sleeps while nothing is animated and while the page is hidden.

const tracks = new Map(); // element -> { face: { frames, ms } | null, badge: { frames, ms } | null, faceAt, badgeAt }
let timer = null;
let timerWin = null;

const position = (index, frames) => `${((index / (frames - 1)) * 100).toFixed(3)}%`;
const reduced = (win) => {
  try {
    return win.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
  } catch {
    return false;
  }
};

function step() {
  timer = null;
  const win = timerWin;
  if (!win) return;
  const now = win.performance?.now?.() ?? Date.now();
  let next = Infinity;
  for (const [el, t] of tracks) {
    if (!el.isConnected) {
      tracks.delete(el);
      continue;
    }
    for (const [name, prop, key] of [["face", "--t3plus-bot-x", "faceAt"], ["badge", "--t3plus-badge-x", "badgeAt"]]) {
      const track = t[name];
      if (!track) continue;
      const tick = Math.floor(now / track.ms);
      const index = tick % track.frames;
      if (t[key] !== index) {
        t[key] = index;
        el.style.setProperty(prop, position(index, track.frames));
      }
      next = Math.min(next, (tick + 1) * track.ms - now);
    }
  }
  if (!tracks.size || next === Infinity) return;
  // Hidden page: look again in a second instead of stepping frames nobody sees.
  const hidden = win.document?.visibilityState === "hidden";
  timer = win.setTimeout(step, hidden ? 1000 : Math.max(16, next + 1));
}

/**
 * Tells the clock what `el` shows. face / badge: { frames, duration (s) } for an
 * animated sprite, or null for a still one. With neither, `el` is dropped and
 * its frame properties cleared.
 */
export function setSprite(el, face, badge) {
  const win = el.ownerDocument?.defaultView;
  const usable = (s) => (s && s.frames > 1 && s.duration > 0 && win && !reduced(win) ? { frames: s.frames, ms: (s.duration * 1000) / s.frames } : null);
  const f = usable(face);
  const b = usable(badge);
  if (!f) el.style.removeProperty("--t3plus-bot-x");
  if (!b) el.style.removeProperty("--t3plus-badge-x");
  if (!f && !b) {
    tracks.delete(el);
    return;
  }
  const known = tracks.get(el);
  // Same sprite as before: keep its place so a re-render does not restart it.
  const kept = (key, was, is) => (known && was?.frames === is?.frames ? known[key] : -1);
  tracks.set(el, { face: f, badge: b, faceAt: kept("faceAt", known?.face, f), badgeAt: kept("badgeAt", known?.badge, b) });
  if (timer === null) {
    timerWin = win;
    timer = win.setTimeout(step, 0);
  }
}

/** Stops the clock and forgets every sprite (t3+ stopped). */
export function stopSprites() {
  if (timer !== null) timerWin?.clearTimeout(timer);
  timer = null;
  for (const el of tracks.keys()) {
    el.style.removeProperty("--t3plus-bot-x");
    el.style.removeProperty("--t3plus-badge-x");
  }
  tracks.clear();
}

/** How many elements are being stepped (tests, diagnostics). */
export const spriteCount = () => tracks.size;
