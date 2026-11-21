import assert from "node:assert/strict";
import { test } from "node:test";
import { createBackdropRenderer } from "../src/backdropRenderer.js";
import { STORAGE_KEYS } from "../src/config.js";
import { createProfiles } from "../src/profiles.js";
import { normalizeSettings } from "../src/settings.js";
import { createScopesStore } from "../src/settingsScopes.js";
import { createApp, createDom, createFakeChromeStorage, T3_COMPOSER_HTML, virtualClock } from "./helpers.js";

// The other profiles' glows drawn ahead while the page is idle (backdropRenderer.js warm,
// app.js warmSoon): even the first switch to a profile with its own glow finds its render
// kept, and draws nothing as it lands.

const PANE = { left: 0, top: 0, width: 1200, height: 800, right: 1200, bottom: 800 };
const BOX = { left: 300, top: 700, width: 600, height: 80, right: 900, bottom: 780 };

/** The renderer with its canvas and colors stood in for, on `win`: its encodes counted. */
function standInRenderer(win, { keep = 18 } = {}) {
  const counts = { blobs: 0, created: 0, revoked: 0 };
  win.ImageData = class {
    constructor(data, width, height) {
      Object.assign(this, { data, width, height });
    }
  };
  win.URL.createObjectURL = () => `blob:x/${(counts.created += 1)}`;
  win.URL.revokeObjectURL = () => (counts.revoked += 1);
  const createCanvas = () => ({
    getContext: () => ({ putImageData() {} }),
    toBlob: (done) => {
      counts.blobs += 1;
      setTimeout(() => done(new win.Blob(["png"])), 1);
    },
  });
  const colorBytes = (doc, css) => (/^#[0-9a-f]{6}$/i.test(css) ? [...[1, 3, 5].map((i) => Number.parseInt(css.slice(i, i + 2), 16)), 255] : [10, 10, 10, 255]);
  const renderer = createBackdropRenderer({ win, doc: win.document, delayMs: 5, keep, colorBytes, createCanvas });
  return { renderer, counts };
}

// ---------- The renderer ----------

function rendererPage({ keep } = {}) {
  const dom = createDom("/env/t", `<div id="pane"></div>`);
  const win = dom.window;
  const clock = virtualClock(win);
  const { renderer, counts } = standInRenderer(win, { keep });
  const pane = win.document.getElementById("pane");
  const look = (accent) => normalizeSettings({ composerGradient: { accent } });
  const size = { hostRect: PANE, cx: 0.5, composerWidth: 600 };
  const show = (accent) => renderer.update({ mode: "half-circle", settings: look(accent), host: pane, ...size });
  const near = () => pane.querySelector(".t3plus-glow-near")?.style.backgroundImage ?? "";
  /** Warms `accent`'s glow, the clock moved on until it is drawn: what warm() resolved. */
  const warm = async (accent, options) => {
    const result = renderer.warm(look(accent), size, options);
    await clock.advance(100);
    return result;
  };
  return { win, clock, renderer, counts, pane, look, size, show, near, warm };
}

test("a warmed glow is drawn once, unshown, and a switch to it then shows it in the same update with nothing drawn", async () => {
  const t = rendererPage();
  t.show("#3366ff");
  await t.clock.advance(100);
  const shownNow = t.near();
  assert.equal(t.counts.blobs, 2, "the glow on screen (its two sprites)");
  assert.equal(await t.warm("#ff3366"), "drawn");
  assert.equal(t.counts.blobs, 4, "the other glow's two sprites");
  assert.equal(t.near(), shownNow, "nothing shown from it");
  assert.equal(await t.warm("#ff3366"), "kept", "kept: not drawn again");
  assert.equal(await t.warm("#3366ff"), "kept", "nor the one on screen");
  t.show("#ff3366");
  assert.notEqual(t.near(), shownNow, "shown in the same update: it is under the key a real render asks for");
  await t.clock.advance(100);
  assert.equal(t.counts.blobs, 4, "nothing drawn for the switch");
  t.renderer.clear();
  assert.equal(t.counts.created, t.counts.revoked, "clear releases the warmed images too");
});

test("warming waits for the page's own renders, and one asked for meanwhile, or idle() turning false, stops it", async () => {
  const t = rendererPage();
  assert.equal(await t.warm("#ff3366"), "kept", "nothing shown yet: nothing to warm for");
  t.show("#3366ff");
  assert.equal(await t.warm("#ff3366"), "busy", "the glow on screen is still being drawn");
  await t.clock.advance(100);
  // A real render asked for while a warm is under way: it has the page first.
  const warming = t.renderer.warm(t.look("#ff3366"), t.size);
  t.show("#22cc88");
  await t.clock.advance(100);
  assert.equal(await warming, "busy");
  const drawn = t.counts.blobs;
  t.show("#ff3366");
  await t.clock.advance(100);
  assert.equal(t.counts.blobs, drawn + 2, "the warmed glow was not kept: the switch to it drew it");
  // A switch beginning mid-render.
  let idle = true;
  const stopped = t.renderer.warm(t.look("#aa00aa"), t.size, { idle: () => idle });
  idle = false;
  await t.clock.advance(100);
  assert.equal(await stopped, "busy");
  const before = t.counts.blobs;
  t.show("#aa00aa");
  await t.clock.advance(100);
  assert.equal(t.counts.blobs, before + 2, "nothing kept from it");
  t.renderer.clear();
});

test("warming never pushes the render on screen out of the cache: warmed glows take at most half of it", async () => {
  const t = rendererPage({ keep: 4 });
  t.show("#3366ff");
  await t.clock.advance(100);
  const results = [];
  for (const accent of ["#ff0000", "#00ff00", "#0000ff", "#ffff00", "#00ffff"]) results.push(await t.warm(accent));
  assert.deepEqual(results, ["drawn", "drawn", "kept", "kept", "kept"], "two of four places");
  await t.clock.advance(1100); // past the grace a released image gets
  assert.equal(t.counts.revoked, 0, "nothing released: the render on screen is kept");
  // Shown, a warmed glow is a real render: there is room to warm another.
  t.show("#ff0000");
  assert.equal(await t.warm("#0000ff"), "drawn");
  const drawn = t.counts.blobs;
  t.show("#00ff00");
  t.show("#ff0000");
  await t.clock.advance(100);
  assert.equal(t.counts.blobs, drawn, "the glows on screen and warmed all still kept");
  t.renderer.clear();
});

// ---------- The app ----------

const PAGE = `
  <div data-slot="sidebar-inner"><div data-slot="scroll-area-viewport"><div id="group"><ul id="list">
    <li data-testid="sidebar-project-folder"><button type="button" data-sidebar-row="folder:p/a"><span class="truncate">A</span></button></li>
    <li data-thread-item="env1:a1"><div role="button" data-sidebar-row="env1:a1" data-sidebar-parent="folder:p/a" aria-label="Alpha"><span class="sr-only">Alpha</span></div></li>
  </ul></div></div><div data-slot="sidebar-footer"></div></div>
  <div data-workspace-area="conversation" id="pane"><div data-chat-canvas id="canvas"><div class="messages-timeline-scroll"></div></div></div>
  ${T3_COMPOSER_HTML}`;
// Work and Calm have glows of their own; Same draws Main's.
const PROFILES = {
  active: "main",
  list: [{ id: "main", name: "Main" }, { id: "work", name: "Work" }, { id: "calm", name: "Calm" }, { id: "same", name: "Same" }],
  projects: { "p/a": "main" },
  adopted: true,
};
const SCOPES = { "work|*": { "composerGradient.accent": "#ff3366" }, "calm|*": { "composerGradient.intensity": 30, "composerGradient.ditherStyle": "grain" } };

/** The app with four profiles and the stand-in renderer, on a laid-out pane, its first glow drawn. */
async function appPage({ settings = {} } = {}) {
  const dom = createDom("/env1/a1", PAGE);
  const win = dom.window;
  const doc = win.document;
  const clock = virtualClock(win);
  // jsdom lays nothing out: the pane and the message box get their boxes.
  const rect = win.Element.prototype.getBoundingClientRect;
  win.Element.prototype.getBoundingClientRect = function () {
    if (this.id === "pane") return PANE;
    return this.matches("[data-chat-composer-surface]") ? BOX : rect.call(this);
  };
  // No animations: every switch lands at once.
  win.matchMedia = (q) => ({ matches: q.includes("reduce"), addEventListener() {}, removeEventListener() {} });
  const { renderer, counts } = standInRenderer(win);
  const warms = [];
  const warm = renderer.warm;
  renderer.warm = (...args) => (warms.push(args[0]), warm(...args));
  const storage = createFakeChromeStorage();
  storage.area.data.set(STORAGE_KEYS.profiles, PROFILES);
  storage.area.data.set(STORAGE_KEYS.scopes, { version: 1, overrides: SCOPES });
  storage.area.data.set(STORAGE_KEYS.settings, settings);
  let appRef = null;
  const profiles = createProfiles({ win, doc, area: storage.area, changedEvent: storage.onChanged, onShown: (id) => appRef?.profileShown(id) });
  const { app } = createApp(dom, storage, { profiles, scopesStore: createScopesStore(storage.area, storage.onChanged), backdropRenderer: renderer });
  appRef = app;
  await app.start();
  await clock.advance(0); // the profiles load
  app.watcher.flush();
  await clock.advance(100); // Main's glow drawn
  const near = () => doc.querySelector(".t3plus-glow-near")?.style.backgroundImage ?? "";
  return { win, doc, clock, app, profiles, counts, warms, near };
}

test("a little after start the other profiles' glows are warmed, once each and only those that differ, and the first switch to each draws nothing", async () => {
  const t = await appPage();
  assert.equal(t.counts.blobs, 2, "Main's glow");
  await t.clock.advance(500);
  assert.equal(t.warms.length, 0, "not right away");
  await t.clock.advance(1000);
  assert.equal(t.counts.blobs, 6, "Work's and Calm's glows (Same's is Main's, kept already)");
  assert.deepEqual(t.warms.map((s) => s.composerGradient.accent), ["#ff3366", "theme", "theme"], "the other profiles' resolved looks, Main's left out");
  t.app.watcher.flush();
  await t.clock.advance(3000);
  assert.equal(t.counts.blobs, 6, "a check later draws nothing more");
  const glows = {};
  for (const id of ["work", "calm", "main", "same"]) {
    const before = t.near();
    t.profiles.switchTo(id);
    t.app.watcher.flush();
    glows[id] = t.near();
    if (id !== "same") assert.notEqual(glows[id], before, `${id}: its glow shows as the switch lands`);
  }
  assert.equal(glows.same, glows.main, "Same shows Main's render");
  await t.clock.advance(3000);
  assert.equal(t.counts.blobs, 6, "no switch drew a glow");
});

test("a new look, theme or pane size warms again; nothing is warmed while a switch slides or a project is dragged", async () => {
  const t = await appPage();
  await t.clock.advance(1500);
  let drawn = t.counts.blobs;
  // A profile's own glow changed (in another window, or its dot's editor).
  t.app.setScopedValue("work", "composerGradient.accent", "#22cc88");
  await t.clock.advance(1500);
  assert.equal(t.counts.blobs, drawn + 2, "Work's new glow, warmed");
  // Changed again while a switch slides, then while a project is dragged to a dot:
  // profiles.js says it is busy (its busy() reads the slide and the drag themselves).
  let busy = true;
  t.profiles.busy = () => busy;
  t.app.setScopedValue("work", "composerGradient.accent", "#123456");
  drawn = t.counts.blobs;
  await t.clock.advance(5000);
  assert.equal(t.counts.blobs, drawn, "nothing drawn while a switch slides or a project is dragged");
  busy = false;
  await t.clock.advance(1500);
  assert.equal(t.counts.blobs, drawn + 2, "once it is over, Work's glow is warmed");
  // A T3 theme switch: Main and Calm follow its color (Work has its own).
  drawn = t.counts.blobs;
  t.doc.getElementById("pane").style.setProperty("--primary", "#00aa00");
  t.doc.documentElement.classList.add("dark");
  await t.clock.advance(0);
  t.app.watcher.flush();
  await t.clock.advance(1500);
  assert.equal(t.counts.blobs, drawn + 2 + 2, "Main's glow in it (the update), then Calm's (warmed)");
  // The pane resized: each glow is drawn at the new size, the one on screen by the update.
  drawn = t.counts.blobs;
  const wider = { ...PANE, width: 1400, right: 1400 };
  const rect = t.win.Element.prototype.getBoundingClientRect;
  t.win.Element.prototype.getBoundingClientRect = function () {
    if (this.id === "pane") return wider;
    return this.matches("[data-chat-composer-surface]") ? { ...BOX, width: 700, right: 1000 } : rect.call(this);
  };
  t.win.dispatchEvent(new t.win.Event("resize"));
  t.app.watcher.flush();
  await t.clock.advance(1500);
  assert.equal(t.counts.blobs, drawn + 2 + 4, "Main's glow at the new size, then Work's and Calm's");
  for (const id of ["calm", "work", "same"]) {
    t.profiles.switchTo(id);
    t.app.watcher.flush();
  }
  await t.clock.advance(100);
  assert.equal(t.counts.blobs, drawn + 6, "no switch draws anything");
});

test("stop() cancels a warm still to come, and one under way keeps nothing", async () => {
  const early = await appPage();
  await early.clock.advance(500);
  early.app.stop();
  await early.clock.advance(5000);
  assert.equal(early.warms.length, 0, "never asked for");
  assert.equal(early.counts.blobs, 2, "nothing drawn after Main's glow");
  const t = await appPage();
  while (!t.warms.length) await t.clock.advance(4);
  t.app.stop();
  await t.clock.advance(5000);
  assert.equal(t.warms.length, 1, "the round ends with it");
  assert.equal(t.counts.created, t.counts.revoked, "no image of it is left alive");
});

test("with the Smooth glow (no dither) nothing is warmed", async () => {
  const t = await appPage({ settings: { composerGradient: { dither: false } } });
  await t.clock.advance(3000);
  assert.equal(t.counts.blobs, 0);
});

