// Evaluated inside the T3 Code desktop app's main process (through Node's inspector).
// Injects t3+ into the app window, re-injects after reloads, and keeps the usage
// feed fresh. Everything here ends when the app quits. `globalThis.__t3plus.dispose()` undoes it.
(async () => {
  const electron = require("electron");
  const fs = require("fs");
  const path = require("path");
  const os = require("os");
  const HOME = path.join(os.homedir(), ".t3plus");
  // The version t3+ reports (Settings, backups): the extension's own, not a copy here.
  let VERSION = "0.0.0";
  try { VERSION = JSON.parse(fs.readFileSync(path.join(HOME, "extension/package.json"), "utf8")).version || VERSION; } catch {}
  // The data feeds (inject/feeds.js), loaded fresh on every run of the loader.
  const feedsModule = path.join(HOME, "inject/feeds.js");
  delete require.cache[require.resolve(feedsModule)];
  const createFeeds = require(feedsModule);
  if (globalThis.__t3plus) { try { globalThis.__t3plus.dispose(); } catch {} }
  const state = { cssKeys: new Map(), timers: [], undo: [], log: [], injected: new Set() }; // timers: none since feeds went event-driven
  const log = (...a) => { state.log.push(`${new Date().toISOString()} ${a.join(" ")}`); if (state.log.length > 60) state.log.shift(); };
  const read = (f) => { try { return fs.readFileSync(path.join(HOME, f), "utf8"); } catch { return null; } };
  const feeds = () => ({ home: read("feeds/t3plus-home.json"), bots: read("feeds/t3plus-bots.json") });
  const appOrigin = __APP_ORIGIN__;
  // The origin itself, not a prefix of it ("t3code://app" must not match "t3code://apple").
  const isTarget = (wc) => {
    try {
      if (wc.isDestroyed() || wc.getType() !== "window") return false;
      const url = wc.getURL();
      return url === appOrigin || url.startsWith(`${appOrigin}/`);
    } catch {
      return false;
    }
  };
  async function inject(wc) {
    if (state.disposed || !isTarget(wc)) return "skip";
    // The new files first: missing (a rebuild under way, or never built), the copy
    // that is running stays as it is rather than being stopped for nothing.
    const stub = read("inject/page-stub.js"), js = read("dist/content.js"), css = read("dist/content.css");
    if (!stub || !js || !css) throw new Error("t3+ files missing in ~/.t3plus");
    // A copy that is already running (re-run of `on`, or new files) is stopped first, so
    // the page never needs a reload: newer builds expose their app, the first one bows out
    // when its stand-in extension id goes away.
    const replaced = await wc.executeJavaScript(`(async () => {
      if (!window.__t3plusInjected) return false;
      if (window.__t3plusApp) { try { window.__t3plusApp.stop(); } catch {} window.__t3plusApp = null; }
      else if (window.chrome && window.chrome.runtime) {
        try { window.chrome.runtime.id = ""; } catch {}
        document.documentElement.appendChild(document.createComment("t3plus")).remove();
        await new Promise((r) => setTimeout(r, 800));
      }
      window.__t3plusStub = false; window.__t3plusInjected = false;
      return true;
    })()`);
    const oldKey = state.cssKeys.get(wc.id) ?? (globalThis.__t3plusCssKeys && globalThis.__t3plusCssKeys.get(wc.id));
    if (oldKey) { try { await wc.removeInsertedCSS(oldKey); } catch {} }
    const svg = read("dist/sample-spectrum.svg") || "";
    // The feeds' times, taken before they are read: a publish that lands while this
    // page is being injected is then seen as newer and pushed (recorded after the
    // awaits, its time was marked as delivered with the older text).
    const feedTimes = Object.fromEntries(Object.entries(FEEDS).map(([kind, feed]) => [kind, mtime(feed.file)]));
    const boot = { version: VERSION, sampleUrl: `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`, feeds: feeds() };
    state.cssKeys.set(wc.id, await wc.insertCSS(css));
    (globalThis.__t3plusCssKeys ??= new Map()).set(wc.id, state.cssKeys.get(wc.id));
    await wc.executeJavaScript(`window.__t3plusBoot=${JSON.stringify(boot)};\n${stub}\n;window.__t3plusInjected=true;\n${js}\n;0`);
    state.injected.add(wc.id);
    for (const kind of Object.keys(FEEDS)) pushed.set(`${wc.id}:${kind}`, feedTimes[kind]); // boot.feeds carried these
    log(replaced ? "re-injected into" : "injected into", wc.id);
    return replaced ? "re-injected" : "injected";
  }
  function attach(wc) {
    const onLoad = () => { inject(wc).catch((e) => log("inject failed:", e && e.message)); };
    wc.on("did-finish-load", onLoad);
    // Electron passes the text as the third argument (older) or on the event (newer).
    // Only the app's own page speaks for t3+, not a frame embedded in it.
    const onConsole = (event, _level, message) => {
      const frame = event && event.frame;
      const main = wc.mainFrame;
      if (frame && main && (frame.processId !== main.processId || frame.routingId !== main.routingId)) return;
      onNote(wc, typeof message === "string" ? message : event && event.message);
    };
    wc.on("console-message", onConsole);
    state.undo.push(() => { try { wc.off("did-finish-load", onLoad); wc.off("console-message", onConsole); } catch {} });
  }
  const onCreated = (_e, wc) => attach(wc);
  electron.app.on("web-contents-created", onCreated);
  state.undo.push(() => electron.app.off("web-contents-created", onCreated));

  // Feeds are published on demand, with no polling. t3+ asks for a feed only while
  // something on screen uses it (bots in the sidebar, the usage widgets or the details
  // pool); the stand-in passes each ask on as a console line, which arrives here as an
  // event. A feed that is asked for while the window is in use, and whose file is
  // stale, is republished and handed to the page. An idle app costs nothing at all.
  const FEEDS = {
    home: { file: "feeds/t3plus-home.json", maxAge: 5 * 60 * 1000 },
    bots: { file: "feeds/t3plus-bots.json", maxAge: 3 * 1000 },
  };
  const data = createFeeds({ home: HOME, log });
  state.undo.push(() => data.dispose());
  let botIds = [];
  const mtime = (f) => { try { return fs.statSync(path.join(HOME, f)).mtimeMs; } catch { return 0; } };
  const pushed = new Map(); // `${wc.id}:${kind}` -> mtime handed to that page
  const running = new Set();
  const lastRun = new Map();
  const queued = new Set();
  function publish(kind) {
    const feed = FEEDS[kind];
    if (!feed) return;
    // The bot feed needs the page's list of bot threads first: published without it,
    // it would replace a good file with an empty one.
    if (kind === "bots" && botKeys === null) return;
    // Asked again while one is running (the bot list just changed): run once more after it.
    if (running.has(kind)) {
      queued.add(kind);
      return;
    }
    running.add(kind);
    lastRun.set(kind, Date.now()); // an unchanged feed keeps its file (and its time) as it is
    (kind === "bots" ? data.publishBots(botIds) : data.publishHome())
      .then(() => pushFeeds())
      .catch((err) => log(`${kind} feed publish failed:`, String(err && err.message).slice(0, 200)))
      .finally(() => {
        running.delete(kind);
        if (queued.delete(kind)) publish(kind);
      });
  }
  function pushFeeds() {
    for (const wc of electron.webContents.getAllWebContents()) {
      if (!isTarget(wc) || !state.injected.has(wc.id)) continue;
      const changed = {};
      for (const [kind, feed] of Object.entries(FEEDS)) {
        const at = mtime(feed.file);
        if (at && pushed.get(`${wc.id}:${kind}`) !== at) { changed[kind] = read(feed.file); pushed.set(`${wc.id}:${kind}`, at); }
      }
      if (!Object.keys(changed).length) continue;
      // Hand over the new copies and let t3+ pick them up now rather than at its next poll.
      // Through t3+'s own hook: a synthetic "visibilitychange" also reached T3's
      // listeners, which report activity to every environment and refresh their data.
      wc.executeJavaScript(`(() => { Object.assign(window.__t3plusFeeds = window.__t3plusFeeds || {}, ${JSON.stringify(changed)});
        try { window.__t3plusApp?.feedsUpdated?.(); } catch {} })();0`).catch(() => {});
    }
  }
  // The app window never reports itself hidden (T3 turns background throttling off), so
  // "in use" is judged here: shown and not minimized. Focus does not matter: T3 on a
  // second screen while you work elsewhere still gets fresh data.
  function inUse(wc) {
    const win = electron.BrowserWindow.fromWebContents(wc);
    if (!win) return true;
    return win.isVisible() && !win.isMinimized();
  }
  function onAsk(wc, kind) {
    const feed = FEEDS[kind];
    if (!feed || !inUse(wc)) return;
    if (Date.now() - Math.max(mtime(feed.file), lastRun.get(kind) || 0) > feed.maxAge) publish(kind);
  }
  // Threads made bots by Option-click: the bot feed needs their ids.
  // Each window reports its own list (its bots and its open thread); the feed covers
  // all of them. One shared list, replaced by whichever window spoke last, dropped the
  // other window's previews and spend.
  let botKeys = null;
  const keysByWindow = new Map(); // webContents id -> thread ids
  function onBotKeys(wc, keys) {
    const ids = (Array.isArray(keys) ? keys : []).filter((k) => typeof k === "string").map((k) => k.slice(k.indexOf(":") + 1));
    if (!keysByWindow.has(wc.id)) wc.once("destroyed", () => { keysByWindow.delete(wc.id); });
    keysByWindow.set(wc.id, ids);
    // Most wanted first, for the worker's cap: every window's first key (its open
    // thread), then the rest in each window's order (its bots, top down).
    const lists = [...keysByWindow.values()];
    const all = [...new Set([...lists.map((l) => l[0]).filter(Boolean), ...lists.flat()])];
    // Republished when the set changes, not when rows only move.
    const next = JSON.stringify([...all].sort());
    if (next === botKeys) return;
    botKeys = next;
    botIds = all;
    lastRun.delete("bots");
    if (all.length) publish("bots");
  }
  function onNote(wc, text) {
    if (typeof text !== "string" || !text.startsWith("[t3plus]") || !isTarget(wc)) return;
    let note;
    try { note = JSON.parse(text.slice(8)); } catch { return; }
    if (note.what === "ask") onAsk(wc, note.kind);
    else if (note.what === "bots") onBotKeys(wc, note.keys);
    else if (note.what === "health") onHealth(note.problems);
  }
  // What t3+ reports it cannot find in T3's page (see src/health.js), with T3's
  // version, so a breaking T3 update is easy to pin down.
  let health = null;
  function onHealth(problems) {
    const list = (Array.isArray(problems) ? problems : [])
      .filter((p) => p && typeof p.feature === "string")
      .slice(0, 20)
      .map((p) => ({ feature: p.feature.slice(0, 80), missing: (Array.isArray(p.missing) ? p.missing : []).filter((m) => typeof m === "string").slice(0, 10).map((m) => m.slice(0, 80)) }));
    const next = JSON.stringify(list);
    if (next === health) return;
    health = next;
    const entry = { at: new Date().toISOString(), t3Version: electron.app.getVersion(), problems: list };
    try {
      fs.mkdirSync(path.join(HOME, "state"), { recursive: true });
      fs.writeFileSync(path.join(HOME, "state/health.json"), JSON.stringify(entry, null, 1));
    } catch {}
    log(list.length ? `health: ${list.map((p) => p.feature).join(", ")} not found in T3 ${entry.t3Version}` : `health: all features found (T3 ${entry.t3Version})`);
  }
  state.publish = publish;
  state.data = data;
  state.debug = () => ({ lastRun: Object.fromEntries(lastRun), running: [...running], botKeys, health: health && JSON.parse(health), timers: state.timers.length });

  state.dispose = (reload = false) => {
    // A loader still injecting (a second `on` arrived mid-loop) stops attaching and
    // injecting from here on.
    state.disposed = true;
    for (const t of state.timers) clearInterval(t);
    for (const fn of state.undo.splice(0)) fn();
    for (const wc of electron.webContents.getAllWebContents()) {
      const key = state.cssKeys.get(wc.id);
      try { if (key) { Promise.resolve(wc.removeInsertedCSS(key)).catch(() => {}); globalThis.__t3plusCssKeys && globalThis.__t3plusCssKeys.delete(wc.id); } } catch {}
      try { if (reload && state.injected.has(wc.id) && !wc.isDestroyed()) wc.reload(); } catch {}
    }
    delete globalThis.__t3plus;
    return "disposed";
  };
  globalThis.__t3plus = state;

  // Older installs kept the bot list on disk for the Python publisher.
  try { fs.rmSync(path.join(HOME, "state/bot-keys.json"), { force: true }); } catch {}
  const results = [];
  for (const wc of electron.webContents.getAllWebContents()) {
    if (state.disposed) break;
    attach(wc);
    try { results.push(`${wc.id}:${await inject(wc)}`); } catch (e) { results.push(`${wc.id}:error ${e && e.message}`); }
  }
  return results.join(", ");
})()
