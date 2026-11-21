import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { setSprite, spriteCount, stopSprites } from "../src/spriteClock.js";

// The sprite clock on a fake window: its timers run by hand, an IntersectionObserver
// whose reports the test makes, and a reduced-motion query the test can turn.
function fakeWindow() {
  let now = 0;
  const timers = [];
  const observers = [];
  const motion = { matches: false };
  let mediaQueries = 0;
  const win = {
    performance: { now: () => now },
    setTimeout: (fn, ms) => timers.push({ fn, ms, at: now + ms }),
    clearTimeout: (id) => {
      if (timers[id - 1]) timers[id - 1].fn = null;
    },
    matchMedia: () => ((mediaQueries += 1), motion),
    document: { visibilityState: "visible" },
    IntersectionObserver: class {
      constructor(callback) {
        this.callback = callback;
        this.targets = new Set();
        observers.push(this);
      }
      observe(el) {
        this.targets.add(el);
      }
      unobserve(el) {
        this.targets.delete(el);
      }
    },
  };
  const el = () => {
    const props = new Map();
    return { isConnected: true, props, style: { setProperty: (k, v) => props.set(k, v), removeProperty: (k) => props.delete(k) }, ownerDocument: { defaultView: win } };
  };
  return {
    win,
    el,
    motion,
    observers,
    mediaQueries: () => mediaQueries,
    pending: () => timers.filter((t) => t.fn),
    /** Runs the clock `ms` on, its timers as they fall due. */
    advance(ms) {
      const end = now + ms;
      for (;;) {
        const due = timers.filter((t) => t.fn && t.at <= end).sort((a, b) => a.at - b.at)[0];
        if (!due) break;
        now = Math.max(now, due.at);
        const fn = due.fn;
        due.fn = null;
        fn();
      }
      now = end;
    },
    /** The observer reports these elements on or off screen. */
    report(entries) {
      observers[0].callback(entries.map(([target, isIntersecting]) => ({ target, isIntersecting })));
    },
  };
}

const WORKING = { frames: 8, duration: 1.6 }; // a frame every 200 ms

beforeEach(() => stopSprites()); // one clock for every window: none left from a test before

test("sprite clock: a face off screen (scrolled away, a hidden profile's, under the Status view) is not stepped, and the clock sleeps while none on screen moves", () => {
  const w = fakeWindow();
  const shown = w.el();
  const hidden = w.el();
  setSprite(shown, WORKING, null);
  setSprite(hidden, WORKING, null);
  assert.equal(w.observers.length, 1, "one observer for the window");
  assert.deepEqual([...w.observers[0].targets], [shown, hidden], "each face watched");
  w.advance(16);
  assert.equal(hidden.props.get("--t3plus-bot-x"), "0.000%", "on screen until said otherwise");
  w.report([[hidden, false]]);
  w.advance(400);
  assert.equal(shown.props.get("--t3plus-bot-x"), "28.571%", "the one on screen moves");
  assert.equal(hidden.props.get("--t3plus-bot-x"), "0.000%", "the one off screen keeps its frame");
  w.report([[shown, false]]);
  w.advance(200);
  const writes = shown.props.get("--t3plus-bot-x");
  w.advance(5000);
  assert.equal(shown.props.get("--t3plus-bot-x"), writes, "nothing on screen: nothing stepped");
  assert.ok(w.pending().every((t) => t.ms >= 10_000), "and no wake but a slow look now and then");
  // Back on screen: on its frame of the moment at once, and moving again.
  w.report([[hidden, true]]);
  w.advance(0);
  assert.equal(hidden.props.get("--t3plus-bot-x"), "57.143%", "at 5616 ms: the 28th frame step, frame 4 of 8");
  w.advance(200);
  assert.equal(hidden.props.get("--t3plus-bot-x"), "71.429%");
  stopSprites();
  assert.equal(w.observers[0].targets.size, 0, "stopped: nothing watched");
  assert.equal(hidden.props.has("--t3plus-bot-x"), false, "and back on its first frame");
});

test("sprite clock: a face that leaves the page off screen is let go of at the next slow look; one on screen as soon as it is reported gone", () => {
  const w = fakeWindow();
  const a = w.el();
  const b = w.el();
  setSprite(a, WORKING, null);
  setSprite(b, WORKING, null);
  w.advance(16);
  w.report([[a, false], [b, false]]);
  w.advance(400);
  a.isConnected = false; // T3 took the sidebar down with it in a hidden folder: no report comes
  w.advance(10_000);
  assert.equal(spriteCount(), 1, "the slow look let go of it");
  assert.equal(w.observers[0].targets.has(a), false);
  w.report([[b, true]]);
  b.isConnected = false;
  w.report([[b, false]]);
  assert.equal(spriteCount(), 0, "reported off the page: let go at once");
  assert.equal(w.pending().length, 1, "the pending look finds nothing and stops");
  w.advance(10_000);
  assert.equal(w.pending().length, 0);
  stopSprites();
});

test("sprite clock: telling it the same sprite again costs nothing; reduced motion holds every face on its first frame until it is lifted", () => {
  const w = fakeWindow();
  const face = w.el();
  setSprite(face, WORKING, null);
  w.advance(16);
  w.advance(600);
  const asked = w.mediaQueries();
  const timers = w.pending().length;
  for (let i = 0; i < 50; i += 1) setSprite(face, { ...WORKING }, null);
  assert.equal(w.pending().length, timers, "no wake asked for");
  assert.equal(face.props.get("--t3plus-bot-x"), "42.857%", "its place kept");
  w.motion.matches = true;
  w.advance(200);
  assert.equal(face.props.get("--t3plus-bot-x"), "0.000%", "reduced motion: the first frame");
  w.advance(5000);
  assert.equal(face.props.get("--t3plus-bot-x"), "0.000%", "and no other");
  assert.equal(w.mediaQueries(), asked, "one media query for the window, asked again and again");
  w.motion.matches = false;
  w.advance(10_000);
  assert.notEqual(face.props.get("--t3plus-bot-x"), "0.000%", "moving again once it is lifted");
  stopSprites();
});
