// Steps the bot sprites (the working / needs-you faces and their badges).
//
// A CSS animation on background-position is ticked on the main thread at the
// display's rate, 60 times a second or more, although these sprites change
// only three to twelve times a second. This clock wakes exactly when one of them
// is due its next frame and moves it by writing one custom property on that
// element (content.css reads --t3plus-bot-x / --t3plus-badge-x), so a working
// bot costs a handful of tiny style updates per second and nothing in between.
// It steps only the sprites on screen: one scrolled out of the sidebar, in another
// profile's (hidden) folder or in T3's list while the Status view covers it waits,
// and is put on its frame of the moment as it comes back (an IntersectionObserver
// says which are on screen). It sleeps while nothing on screen moves and while the
// page is hidden, and keeps every face on its first frame while motion is reduced.

const tracks = new Map(); // element -> { face: { frames, ms } | null, badge, faceAt, badgeAt, shown }
const SPRITES = Object.freeze([
  ["face", "--t3plus-bot-x", "faceAt"],
  ["badge", "--t3plus-badge-x", "badgeAt"],
]);
let timer = null;
let timerWin = null;
const PRUNE_MS = 10_000;

const position = (index, frames) => `${((index / (frames - 1)) * 100).toFixed(3)}%`;

// Per window, made once: asked on every step.
const motionQueries = new WeakMap(); // window -> its prefers-reduced-motion MediaQueryList, or null
function reduced(win) {
  if (!motionQueries.has(win)) {
    let query = null;
    try {
      query = win.matchMedia?.("(prefers-reduced-motion: reduce)") ?? null;
    } catch {
      query = null;
    }
    motionQueries.set(win, query);
  }
  return motionQueries.get(win)?.matches === true;
}

const observers = new WeakMap(); // window -> its IntersectionObserver (none without the API: every sprite counts as shown)
function observerOf(win) {
  if (!observers.has(win)) {
    const IO = win.IntersectionObserver;
    observers.set(win, typeof IO === "function" ? new IO((entries) => onShown(win, entries)) : null);
  }
  return observers.get(win);
}
function onShown(win, entries) {
  let back = false;
  for (const { target, isIntersecting } of entries) {
    const t = tracks.get(target);
    if (!t || t.shown === isIntersecting) continue;
    if (!target.isConnected) {
      forget(target); // taken off the page (one on screen until then): let go now
      continue;
    }
    t.shown = isIntersecting;
    back ||= isIntersecting;
  }
  // Back on screen: on its frame of the moment now, not at the next wake (or never, asleep).
  if (back) wake(win, 0);
}

function wake(win, ms) {
  if (timer !== null) timerWin.clearTimeout(timer);
  timerWin = win;
  timer = win.setTimeout(step, ms);
}

/** Lets go of `el`: no longer stepped or watched, and back on its first frame. */
function forget(el) {
  tracks.delete(el);
  const win = el.ownerDocument?.defaultView;
  if (win) observers.get(win)?.unobserve(el);
  for (const [, prop] of SPRITES) el.style.removeProperty(prop);
}

function step() {
  timer = null;
  const win = timerWin;
  if (!win) return;
  const now = win.performance?.now?.() ?? Date.now();
  // Reduced motion: every sprite on its first frame, none stepped.
  const still = reduced(win);
  let next = Infinity;
  for (const [el, t] of tracks) {
    if (!el.isConnected) {
      forget(el);
      continue;
    }
    if (!t.shown) continue;
    for (const [name, prop, at] of SPRITES) {
      const track = t[name];
      if (!track) continue;
      const tick = still ? 0 : Math.floor(now / track.ms);
      const index = tick % track.frames;
      if (t[at] !== index) {
        t[at] = index;
        el.style.setProperty(prop, position(index, track.frames));
      }
      if (!still) next = Math.min(next, (tick + 1) * track.ms - now);
    }
  }
  if (next === Infinity) {
    // Nothing on screen moves: asleep until a sprite comes on screen or a new one is set.
    // Others are looked at now and then: to let go of any the page dropped meanwhile
    // (nothing reports an element that leaves the page off screen), and to move them
    // again once motion is no longer reduced.
    if (tracks.size) timer = win.setTimeout(step, PRUNE_MS);
    return;
  }
  // Hidden page: look again in a second instead of stepping frames nobody sees.
  const hidden = win.document?.visibilityState === "hidden";
  timer = win.setTimeout(step, hidden ? 1000 : Math.max(16, next + 1));
}

const moves = (s) => Boolean(s) && s.frames > 1 && s.duration > 0;
/** The clock's pace for sprite `s`: { frames, ms } (a frame's), or null for one that does not move. */
const pace = (s) => (moves(s) ? { frames: s.frames, ms: (s.duration * 1000) / s.frames } : null);
/** Whether the clock already steps sprite `s` at pace `p` (or both stand still). */
const paced = (p, s) => (p === null ? !moves(s) : moves(s) && p.frames === s.frames && p.ms === (s.duration * 1000) / s.frames);

/**
 * Tells the clock what `el` shows. face / badge: { frames, duration (s) } for an
 * animated sprite, or null for a still one. With neither, `el` is dropped and
 * its frame properties cleared. Costs nothing when nothing changed (asked on every draw).
 */
export function setSprite(el, face, badge) {
  const win = el.ownerDocument?.defaultView;
  const known = tracks.get(el);
  if (!win || (!moves(face) && !moves(badge))) {
    // Nothing that moves: an element the clock does not step carries no frame property.
    if (known) forget(el);
    return;
  }
  if (known && paced(known.face, face) && paced(known.badge, badge)) return;
  const f = pace(face);
  const b = pace(badge);
  // Same sprite as before: keep its place so a re-render does not restart it.
  const kept = (key, was, is) => (known && was?.frames === is?.frames ? known[key] : -1);
  if (!f) el.style.removeProperty("--t3plus-bot-x");
  if (!b) el.style.removeProperty("--t3plus-badge-x");
  // On screen until its observer says otherwise (its first report comes after the next layout).
  tracks.set(el, { face: f, badge: b, faceAt: kept("faceAt", known?.face, f), badgeAt: kept("badgeAt", known?.badge, b), shown: known?.shown ?? true });
  if (!known) observerOf(win)?.observe(el);
  if (timer === null) wake(win, 0);
}

/** Stops the clock and forgets every sprite (t3+ stopped). */
export function stopSprites() {
  if (timer !== null) timerWin?.clearTimeout(timer);
  timer = null;
  for (const el of tracks.keys()) forget(el);
}

/** How many elements are being stepped (tests, diagnostics). */
export const spriteCount = () => tracks.size;
