import assert from "node:assert/strict";
import { test } from "node:test";
import { BOT_LIMITS, T3PLUS, STORAGE_KEYS } from "../src/config.js";
import { LOOK, lookValue } from "../src/composer.js";
import {
  createApp,
  createDom,
  createFakeChromeStorage,
  fakeImageRecord,
  settle,
  sidebarHtml,
  T3_APPEARANCE_HTML,
  T3_COMPOSER_HTML,
  threadRowHtml,
} from "./helpers.js";

const panelIn = (doc) => doc.getElementById(T3PLUS.panelId);
const modeOf = (doc) => doc.documentElement.getAttribute(T3PLUS.modeAttr);
// The glow's values, on the pane's glow layer (composer.js setLook), not on <html>.
const glowValue = (doc, name) => lookValue(doc, LOOK.glow, name);

function click(dom, el) {
  el.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
}

function chooseMode(dom, panel, value) {
  const input = panel.querySelector(`input[type="radio"][value="${value}"]`);
  input.checked = true;
  input.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
}

test("panel mounts after T3's last Appearance section and only on that route", async () => {
  const dom = createDom("/settings/appearance", T3_APPEARANCE_HTML);
  const doc = dom.window.document;
  const { app } = createApp(dom);
  await app.start();

  const panel = panelIn(doc);
  assert.ok(panel, "panel inserted");
  assert.equal(panel.previousElementSibling.id, "appearance-interface");
  assert.equal(panel.parentElement.id, "page-container");

  dom.window.history.pushState({}, "", "/settings/general");
  app.watcher.flush();
  assert.equal(panelIn(doc), null, "removed when leaving Appearance");
  app.stop();
});

test("panel does not mount on other pages that happen to share section ids", async () => {
  const dom = createDom("/settings/general", T3_APPEARANCE_HTML);
  const { app } = createApp(dom);
  await app.start();
  assert.equal(panelIn(dom.window.document), null);
  app.stop();
});

test("panel is reinserted after T3 rerenders the Appearance page", async () => {
  const dom = createDom("/settings/appearance", T3_APPEARANCE_HTML);
  const doc = dom.window.document;
  const { app } = createApp(dom);
  await app.start();

  // React rebuilds the page container from scratch.
  doc.querySelector("[data-settings-page-scroll]").innerHTML = T3_APPEARANCE_HTML.replace(
    /^\s*<div data-settings-page-scroll>|<\/div>\s*$/g,
    "",
  );
  await settle();
  assert.equal(panelIn(doc), null);
  app.watcher.flush();
  assert.equal(panelIn(doc)?.previousElementSibling.id, "appearance-interface");

  // A later section appended by T3 pushes t3+ back to the end.
  doc.getElementById("page-container").append(doc.createElement("section"));
  app.watcher.flush();
  assert.equal(doc.getElementById("page-container").lastElementChild.id, T3PLUS.panelId);
  app.stop();
});

test("controls switch modes, persist, and drive the composer theme", async () => {
  const dom = createDom("/settings/appearance", T3_APPEARANCE_HTML + T3_COMPOSER_HTML);
  const doc = dom.window.document;
  const { app, storage } = createApp(dom);
  await app.start();
  const panel = panelIn(doc);
  const imageRow = panel.querySelector(".t3plus-thumb").closest(".t3plus-row");
  const accentRow = panel.querySelector('[aria-label="Glow color"]').closest(".t3plus-row");

  assert.equal(modeOf(doc), "half-circle");
  assert.equal(imageRow.hidden, true);
  assert.equal(accentRow.hidden, false);

  chooseMode(dom, panel, "image");
  await settle();
  assert.equal(modeOf(doc), "image");
  assert.equal(imageRow.hidden, false);
  assert.equal(accentRow.hidden, true);
  assert.match(glowValue(doc, "--t3plus-image"), /assets\/sample-spectrum\.svg/);
  assert.equal(storage.area.data.get(STORAGE_KEYS.settings).composerGradient.mode, "image");

  const toggle = panel.querySelector('[role="switch"]');
  click(dom, toggle);
  await settle();
  assert.equal(toggle.getAttribute("aria-checked"), "false");
  assert.equal(modeOf(doc), null, "disabled removes the background");
  assert.ok(doc.documentElement.hasAttribute(T3PLUS.glassAttr), "glass is independent of the background");

  click(dom, toggle);
  chooseMode(dom, panel, "half-circle");
  await settle();
  assert.equal(modeOf(doc), "half-circle");

  // Slider drag previews without writing storage; release persists.
  const slider = panel.querySelector('input[type="range"]');
  slider.value = "90";
  slider.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  assert.equal(glowValue(doc, "--t3plus-core"), "63%");
  assert.equal(storage.area.data.get(STORAGE_KEYS.settings).composerGradient.intensity, 45);
  slider.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
  await settle();
  assert.equal(storage.area.data.get(STORAGE_KEYS.settings).composerGradient.intensity, 90);

  // Custom glow color, then back to the theme's.
  const color = panel.querySelector('[aria-label="Custom glow color"]');
  color.value = "#ff3366";
  color.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
  await settle();
  assert.equal(glowValue(doc, "--t3plus-accent"), "#ff3366");
  click(dom, panel.querySelector('[aria-label="Glow color"] [aria-label="Theme"]'));
  await settle();
  assert.equal(glowValue(doc, "--t3plus-accent"), "");

  // Reset.
  click(dom, [...panel.querySelectorAll("button")].find((b) => b.textContent === "Reset"));
  await settle();
  assert.equal(storage.area.data.get(STORAGE_KEYS.settings).composerGradient.intensity, 45);
  assert.equal(panel.querySelector('[role="status"]').textContent, "t3+ appearance reset.");
  app.stop();
});

test("settings survive a reload", async () => {
  const storage = createFakeChromeStorage();
  const first = createApp(createDom("/settings/appearance", T3_APPEARANCE_HTML), storage).app;
  await first.start();
  await first.actions.setMode("image");
  await first.actions.setIntensity(30);
  first.stop();

  const dom = createDom("/env/thread", T3_COMPOSER_HTML);
  const second = createApp(dom, storage).app;
  await second.start();
  assert.equal(modeOf(dom.window.document), "image");
  assert.equal(glowValue(dom.window.document, "--t3plus-scrim-top"), "83%");
  assert.equal(glowValue(dom.window.document, "--t3plus-scrim-bottom"), "73%");
  second.stop();
});

test("uploading an image stores it locally and uses it; removing falls back to the sample", async () => {
  const dom = createDom("/settings/appearance", T3_APPEARANCE_HTML);
  const doc = dom.window.document;
  const { app, storage } = createApp(dom, undefined, { prepareImage: async (file) => fakeImageRecord(file.name) });
  await app.start();
  await app.actions.setMode("image");

  await app.actions.chooseImage({ name: "mine.png", type: "image/png", size: 10 });
  assert.equal(storage.area.data.get(STORAGE_KEYS.image).name, "mine.png");
  assert.match(glowValue(doc, "--t3plus-image"), /^url\("blob:/);
  assert.match(panelIn(doc).textContent, /Using mine\.png \(1600×900\)/);

  await app.actions.removeImage();
  assert.equal(storage.area.data.has(STORAGE_KEYS.image), false);
  assert.match(glowValue(doc, "--t3plus-image"), /sample-spectrum\.svg/);
  app.stop();
});

test("a failed upload shows the error and keeps the previous image", async () => {
  const dom = createDom("/settings/appearance", T3_APPEARANCE_HTML);
  const { app, storage } = createApp(dom, undefined, {
    prepareImage: async () => {
      throw new Error("Use a PNG, JPEG, WebP, AVIF, or GIF image.");
    },
  });
  await app.start();
  await app.actions.chooseImage({ name: "doc.pdf", type: "application/pdf", size: 10 });
  assert.equal(panelIn(dom.window.document).querySelector('[role="status"]').textContent, "Use a PNG, JPEG, WebP, AVIF, or GIF image.");
  assert.equal(storage.area.data.has(STORAGE_KEYS.image), false);
  app.stop();
});

test("a change saved in one tab repaints another open tab", async () => {
  const storage = createFakeChromeStorage();
  const settingsTab = createApp(createDom("/settings/appearance", T3_APPEARANCE_HTML), storage).app;
  const chatDom = createDom("/env/thread", T3_COMPOSER_HTML);
  const chatTab = createApp(chatDom, storage).app;
  await settingsTab.start();
  await chatTab.start();

  await settingsTab.actions.setEnabled(false);
  assert.equal(modeOf(chatDom.window.document), null);
  await settingsTab.actions.setEnabled(true);
  assert.equal(modeOf(chatDom.window.document), "half-circle");
  settingsTab.stop();
  chatTab.stop();
});

test("stop removes every trace from the page", async () => {
  const dom = createDom("/settings/appearance", T3_APPEARANCE_HTML + T3_COMPOSER_HTML);
  const doc = dom.window.document;
  const { app, storage } = createApp(dom);
  await app.start();
  app.stop();
  assert.equal(panelIn(doc), null);
  assert.equal(modeOf(doc), null);
  assert.equal(doc.documentElement.getAttribute("style") ?? "", "");
  assert.equal(doc.querySelector("style[data-t3plus-owned]"), null, "the look's stylesheet goes too");
  assert.equal(glowValue(doc, "--t3plus-core"), "");
  assert.equal(storage.onChanged.listenerCount(), 0);
});

test("an orphaned copy (extension reloaded) shuts itself down on the next check", async () => {
  const dom = createDom("/settings/appearance", T3_APPEARANCE_HTML);
  let alive = true;
  const { app } = createApp(dom, undefined, { isAlive: () => alive });
  await app.start();
  assert.ok(panelIn(dom.window.document));
  alive = false;
  app.watcher.flush();
  assert.equal(panelIn(dom.window.document), null);
});

test("composer lane: t3+ never moves it off the messages; T3 changing its room on the canvas moves the glow in that same callback (before paint), and the card moving alone checks nothing", async () => {
  // ChatView.tsx: the canvas carries T3's room for the details card; the card is
  // an absolutely placed aside whose top T3 animates (transition-[top]).
  const dom = createDom(
    "/env/thread",
    `<div data-workspace-area="conversation"></div>
     <div data-chat-canvas="true" id="canvas" style="--chat-lane-inset-end: 212px">
       <aside data-thread-details-panel="inline" style="right: 12px; top: 12px; width: 280px"></aside>
       <div class="chat-composer-lane"><div data-chat-composer-surface="true" id="card"></div></div>
     </div>`,
  );
  const doc = dom.window.document;
  const box = (top, height) => () => ({ left: 0, right: 100, width: 100, top, height, bottom: top + height });
  doc.getElementById("canvas").getBoundingClientRect = box(52, 814);
  doc.getElementById("card").getBoundingClientRect = box(735, 131);
  const aside = doc.querySelector("aside");
  aside.getBoundingClientRect = box(64, 277);
  const lane = doc.querySelector(".chat-composer-lane");
  const updates = [];
  const { app } = createApp(dom, undefined, { backdropRenderer: { update: (o) => updates.push(o), clear() {} } });
  await app.start();
  app.watcher.flush();
  assert.equal(lane.style.getPropertyValue("--chat-lane-inset-end"), "", "T3's room stays, so the composer lines up with the messages");

  let scheduled = 0;
  const schedule = app.watcher.schedule;
  app.watcher.schedule = () => {
    scheduled += 1;
  };
  // T3 gives the composer its room back (the card closed): only the canvas's inline style changes.
  const before = updates.length;
  doc.getElementById("canvas").style.setProperty("--chat-lane-inset-end", "0px");
  await settle();
  assert.ok(scheduled > 0, "T3 changing the room on the canvas triggers a check");
  assert.ok(updates.length > before, "and the glow is placed in the observer's callback, before any check runs");
  assert.equal(lane.style.getPropertyValue("--chat-lane-inset-end"), "");

  // The card moving (its top animated) or a section opening inside it moves no composer: nothing to do.
  scheduled = 0;
  aside.style.top = "640px";
  await settle();
  assert.equal(scheduled, 0, "the card moving is not watched");
  const section = doc.createElement("section");
  aside.append(section);
  await settle();
  scheduled = 0;
  section.setAttribute("data-state", "open");
  await settle();
  assert.equal(scheduled, 0, "the card's own changes are not watched any more");
  // A window resize (or zoom) places the glow in the resize event itself, before any check.
  const atResize = updates.length;
  dom.window.dispatchEvent(new dom.window.Event("resize"));
  assert.ok(updates.length > atResize, "placed in the resize event");
  app.watcher.schedule = schedule;
  app.watcher.flush();
  assert.equal(lane.style.getPropertyValue("--chat-lane-inset-end"), "", "T3's room, as always");
  app.stop?.();
});

test("new-thread hero: T3 switching the composer overlay's class alone triggers a check; t3+'s own padding does not", async () => {
  const dom = createDom("/env/draft", `<div data-workspace-area="conversation"></div><div data-chat-composer-overlay="true" class="flex items-end"></div>`);
  const doc = dom.window.document;
  const { app } = createApp(dom);
  await app.start();
  app.watcher.flush();
  let scheduled = 0;
  const schedule = app.watcher.schedule;
  app.watcher.schedule = () => {
    scheduled += 1;
  };
  const overlay = doc.querySelector('[data-chat-composer-overlay="true"]');
  overlay.style.paddingTop = "120px";
  await settle();
  assert.equal(scheduled, 0, "t3+ writing the hero offset does not re-trigger itself");
  overlay.className = "flex items-center";
  await settle();
  assert.ok(scheduled > 0, "T3 centering the composer (draft hero) triggers a check");
  app.watcher.schedule = schedule;
});

test("a stopped copy stays stopped: late saves, late loads and a start() cut short leave nothing behind", async () => {
  const storage = createFakeChromeStorage();
  const dom = createDom("/settings/appearance", T3_APPEARANCE_HTML);
  const doc = dom.window.document;
  const { app } = createApp(dom, storage, { throttleMs: 0 });
  await app.start();
  app.stop();
  const traces = () => [...doc.documentElement.attributes].filter((a) => /t3plus/.test(a.name)).length + doc.querySelectorAll("[data-t3plus-owned], .t3plus-glow, .t3plus-section").length;
  assert.equal(traces(), 0, "stop() cleans up");
  await app.actions.setIntensity(70); // a save that lands after stop
  app.watcher.schedule();
  await settle();
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(traces(), 0, "nothing came back");

  // stop() while start() is still loading the stores: start must not register anything.
  const storage2 = createFakeChromeStorage();
  const dom2 = createDom("/settings/appearance", T3_APPEARANCE_HTML);
  const { app: app2 } = createApp(dom2, storage2, { throttleMs: 0 });
  const starting = app2.start();
  app2.stop();
  await starting;
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(storage2.onChanged.listenerCount(), 0, "no storage listeners left behind");
  await storage2.area.set({ [STORAGE_KEYS.settings]: { composerGradient: { intensity: 10 } } });
  await settle();
  assert.equal([...dom2.window.document.documentElement.attributes].filter((a) => /t3plus/.test(a.name)).length, 0);
});

test("more bots on screen than the remembered-bots cap: storage settles instead of being rewritten every check", async () => {
  const n = BOT_LIMITS.maxBots * 2 + 12;
  const rows = Array.from({ length: n }, (_, i) => threadRowHtml({ key: `env1:t${i}`, title: `Thread ${i}` })).join("");
  const dom = createDom("/", `<div data-slot="sidebar-inner"><div data-slot="sidebar-content"><ul id="thread-list">${rows}</ul></div></div>`);
  const storage = createFakeChromeStorage();
  storage.area.data.set(STORAGE_KEYS.settings, { sidebar: { bots: true, botsDefault: true } });
  let writes = 0;
  const set = storage.area.set;
  storage.area.set = async (items) => {
    if (STORAGE_KEYS.knownBots in items) writes += 1;
    return set(items);
  };
  const { app } = createApp(dom, storage);
  await app.start();
  for (let i = 0; i < 5; i += 1) {
    app.watcher.flush();
    await settle();
  }
  const first = writes;
  for (let i = 0; i < 10; i += 1) {
    app.watcher.flush();
    await settle();
  }
  assert.ok(first >= 1, "the bots were remembered");
  assert.equal(writes, first, "no more writes once every bot on screen is known");
  assert.equal(Object.keys(app.state.knownBots).length, n, "the bots on screen are all kept");
  app.stop();
});

test("composer lane: stays where T3 puts it whatever is on the right (a floating preview, a docked or parked webview)", async () => {
  const dom = createDom(
    "/env/thread",
    `<div data-workspace-area="conversation"></div>
     <div data-chat-canvas="true" id="canvas" style="--chat-lane-inset-end: 300px">
       <section data-preview-mini-player="browser" style="left: 700px; top: 500px; width: 320px; height: 300px"></section>
       <div class="chat-composer-lane"><div data-chat-composer-surface="true" id="card"></div></div>
     </div>
     <div data-preview-viewport="tab1" id="docked" style="position: fixed"></div>
     <div data-preview-viewport="tab2" id="parked" style="position: fixed; z-index: -1"></div>`,
  );
  const doc = dom.window.document;
  const box = (left, width, top, height) => () => ({ left, width, right: left + width, top, height, bottom: top + height });
  doc.getElementById("canvas").getBoundingClientRect = box(200, 1000, 50, 800);
  doc.getElementById("card").getBoundingClientRect = box(300, 700, 700, 130);
  const mini = doc.querySelector("section[data-preview-mini-player]");
  mini.getBoundingClientRect = box(900, 320, 550, 300);
  doc.getElementById("docked").getBoundingClientRect = box(1210, 500, 50, 800); // the right panel, beside the canvas
  doc.getElementById("parked").getBoundingClientRect = box(0, 1280, 0, 800); // a background tab's webview
  const lane = doc.querySelector(".chat-composer-lane");
  const { app } = createApp(dom);
  await app.start();
  app.watcher.flush();
  assert.equal(lane.style.getPropertyValue("--chat-lane-inset-end"), "", "the mini player beside the composer: T3's room");
  mini.remove();
  app.watcher.flush();
  assert.equal(lane.style.getPropertyValue("--chat-lane-inset-end"), "", "nothing beside it: still T3's room, never t3+'s");
  assert.equal(lane.hasAttribute("data-t3plus-lane-slide"), false);
  app.stop();
});

test("a T3 theme switch on <html> alone triggers a check (the glow takes the new colors); the new-thread widgets start below T3's composer banners", async () => {
  const dom = createDom(
    "/env/draft",
    `<div data-workspace-area="conversation"></div>
     <div data-chat-composer-overlay="true" class="flex items-center"><div data-chat-composer-stack="true" id="stack"><div data-chat-composer-surface="true"></div><div data-composer-banner-stack="true" id="banner"></div></div></div>`,
  );
  const doc = dom.window.document;
  const box = (top, height) => () => ({ left: 0, right: 600, width: 600, top, height, bottom: top + height });
  doc.getElementById("stack").getBoundingClientRect = box(300, 120);
  doc.getElementById("banner").getBoundingClientRect = box(424, 40); // hangs 44 px below the composer
  doc.querySelector('[data-workspace-area="conversation"]').getBoundingClientRect = box(0, 900);
  const { app } = createApp(dom, undefined, { homeFeed: { readCache: async () => null, load: async () => null } }); // the cards need a feed source
  await app.start();
  app.watcher.flush();
  const home = doc.querySelector(".t3plus-home");
  assert.ok(home, "widgets shown");
  assert.equal(home.style.getPropertyValue("--t3plus-banner-h"), "44px");
  let scheduled = 0;
  const schedule = app.watcher.schedule;
  app.watcher.schedule = () => {
    scheduled += 1;
  };
  doc.documentElement.setAttribute("data-theme-id", "midnight");
  await settle();
  assert.ok(scheduled > 0, "theme change noticed");
  app.watcher.schedule = schedule;
  app.stop();
});

test("a bot title longer than the remembered-bots list keeps is saved once, not rewritten on every check", async () => {
  const long = `A very long thread title ${"that keeps going ".repeat(10)}`;
  assert.ok(long.length > 120);
  const dom = createDom("/", `<div data-slot="sidebar-inner"><div data-slot="sidebar-content"><ul id="thread-list">${threadRowHtml({ key: "env1:t1", title: long })}</ul></div></div>`);
  const storage = createFakeChromeStorage();
  storage.area.data.set(STORAGE_KEYS.settings, { sidebar: { bots: true, botsDefault: true } });
  let writes = 0;
  const set = storage.area.set;
  storage.area.set = async (items) => {
    if (STORAGE_KEYS.knownBots in items) writes += 1;
    return set(items);
  };
  const { app } = createApp(dom, storage);
  await app.start();
  for (let i = 0; i < 8; i += 1) {
    app.watcher.flush();
    await settle();
  }
  assert.equal(writes, 1, "remembered once; the storage echo (shortened title) matches what the next check compares");
  app.stop();
});

test("no home feed yet: the read is retried at most every few seconds, not on every check", async () => {
  // Frame checks on and real time: the flush-driven harness cannot see a loop in which
  // each read ends in a check that reads again.
  const hero = `
  <main><div data-workspace-area="conversation"><div class="h-full"></div></div>
    <div data-chat-composer-overlay="true" class="pointer-events-none absolute inset-0 z-20 flex items-center">
      <div class="chat-composer-lane w-full"><div data-chat-composer-stack="true" class="relative">
        <div class="absolute inset-x-0 bottom-full"><h1>What should we build?</h1></div>
        <div class="relative z-10"><div data-chat-composer-surface="true"><div data-chat-composer-body="true"><div data-testid="composer-editor"></div></div></div></div>
      </div></div>
    </div></main>`;
  const dom = createDom("/draft/abc", hero);
  let loads = 0;
  const homeFeed = { load: async () => ((loads += 1), null), readCache: async () => null };
  const { app } = createApp(dom, createFakeChromeStorage(), { homeFeed, frameChecks: true, throttleMs: 200 });
  await app.start();
  await new Promise((r) => setTimeout(r, 600));
  assert.equal(loads, 1, `${loads} reads in 600 ms`);
  assert.ok(app.perf.checks < 10, `${app.perf.checks} checks in 600 ms`);
  app.stop();
});

test("a check step that throws is skipped: the steps after it (screenshot mode, health) still run", async () => {
  const storage = createFakeChromeStorage();
  storage.area.data.set(STORAGE_KEYS.settings, { demo: { enabled: true } });
  const dom = createDom("/env1/a1", sidebarHtml());
  const errors = [];
  dom.window.console.error = (...args) => errors.push(args.join(" "));
  const profiles = {
    start: async () => {},
    stop() {},
    sync() {
      throw new TypeError("unexpected T3 markup");
    },
  };
  const { app } = createApp(dom, storage, { profiles });
  await app.start(); // the first check runs inside start(): it must not reject
  app.watcher.flush();
  const doc = dom.window.document;
  assert.ok(doc.documentElement.hasAttribute("data-t3plus-demo"), "screenshot mode still applied");
  const visible = [...doc.querySelectorAll('[data-thread-item] span[dir="auto"]')].map((s) => s.textContent);
  assert.ok(!visible.includes("Fix login"), `real titles covered: ${visible}`);
  assert.equal(errors.filter((e) => /profiles step failed/.test(e)).length, 1, "reported once");
  app.stop();
});
