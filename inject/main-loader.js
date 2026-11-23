// Evaluated inside the T3 Code desktop app's main process (through Node's inspector).
// Injects t3+ into the app window, re-injects after reloads, and keeps the usage
// feed fresh. Everything here ends when the app quits. `globalThis.__t3plus.dispose()` undoes it.
// `require` is the inspector's while this is evaluated, gone after its first await: every
// module is taken at the top.
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
  const read = (f) => { try { return fs.readFileSync(path.join(HOME, f), "utf8"); } catch { return null; } };
  // What goes into the page, all of it or nothing: the stand-in for the extension APIs and t3+'s build.
  const bundle = () => {
    const files = { stub: read("inject/page-stub.js"), js: read("dist/content.js"), css: read("dist/content.css") };
    return files.stub && files.js && files.css ? files : null;
  };
  // Checked before the copy that is running is touched: with files missing (a rebuild under
  // way, or never built) it keeps its styles and feeds rather than being stopped for nothing.
  if (!bundle()) return "files:error t3+ files missing in ~/.t3plus";
  if (globalThis.__t3plus) { try { globalThis.__t3plus.dispose(); } catch {} }
  const state = { cssKeys: new Map(), undo: [], log: [], injected: new Set() };
  const log = (...a) => { state.log.push(`${new Date().toISOString()} ${a.join(" ")}`); if (state.log.length > 60) state.log.shift(); };
  const feeds = () => ({ home: read("feeds/t3plus-home.json"), bots: read("feeds/t3plus-bots.json"), threads: read("feeds/t3plus-threads.json") });
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
  // The same check in the page, as each script given to it runs: the window may have gone
  // to another page since it was checked here, and that page gets nothing of t3+'s.
  const PAGE_GUARD = `if (location.href !== ${JSON.stringify(appOrigin)} && !location.href.startsWith(${JSON.stringify(`${appOrigin}/`)})) throw new Error("t3+: not the app page");\n`;
  const inPage = (code) => PAGE_GUARD + code;
  const uncss = (wc, key) => { try { Promise.resolve(wc.removeInsertedCSS(key)).catch(() => {}); } catch {} };
  async function inject(wc) {
    // Asked again after each wait: by then the window may show another page, or a newer
    // loader may have taken over (it injects this window itself).
    const gone = () => state.disposed || !isTarget(wc);
    if (gone()) return "skip";
    // The new files first: missing (a rebuild under way), the copy that is running stays
    // as it is rather than being stopped for nothing.
    const files = bundle();
    if (!files) throw new Error("t3+ files missing in ~/.t3plus");
    // A copy that is already running (re-run of `on`, or new files) is stopped first, so
    // the page never needs a reload: newer builds expose their app, the first one bows out
    // when its stand-in extension id goes away.
    const replaced = await wc.executeJavaScript(inPage(`(async () => {
      if (!window.__t3plusInjected) return false;
      if (window.__t3plusApp) { try { window.__t3plusApp.stop(); } catch {} window.__t3plusApp = null; }
      else if (window.chrome && window.chrome.runtime) {
        try { window.chrome.runtime.id = ""; } catch {}
        document.documentElement.appendChild(document.createComment("t3plus")).remove();
        await new Promise((r) => setTimeout(r, 800));
      }
      window.__t3plusInjected = false;
      return true;
    })()`));
    if (gone()) return "skip";
    // The stopped copy's styles: this loader's, or those of the one before it (its dispose
    // leaves them, so the copy was never unstyled while it still ran).
    const oldKey = state.cssKeys.get(wc.id) ?? globalThis.__t3plusCssKeys?.get(wc.id);
    if (oldKey) { try { await wc.removeInsertedCSS(oldKey); } catch {} }
    const svg = read("dist/sample-spectrum.svg") || "";
    const svgLight = read("dist/sample-spectrum-light.svg") || "";
    // This machine as T3 names it, for t3+'s per-machine settings: waited for briefly,
    // else handed over when T3's server answers (t3+ is not held back for it).
    const asking = hostEnvironment();
    const environment = await Promise.race([asking, new Promise((r) => setTimeout(() => r(null), 400))]);
    if (gone()) return "skip";
    if (!environment) {
      asking.then((env) => env && !gone() && wc.executeJavaScript(inPage(`window.__t3plusBoot && (window.__t3plusBoot.environment = ${JSON.stringify(env)});0`)).catch(() => {}));
    }
    // The feeds' times, taken before they are read: a publish that lands while this
    // page is being injected is then seen as newer and pushed (recorded after the
    // awaits, its time was marked as delivered with the older text).
    const feedTimes = Object.fromEntries(Object.entries(FEEDS).map(([kind, feed]) => [kind, mtime(feed.file)]));
    const dataUrl = (text) => (text ? `data:image/svg+xml;base64,${Buffer.from(text).toString("base64")}` : "");
    const boot = { version: VERSION, sampleUrl: dataUrl(svg), sampleLightUrl: dataUrl(svgLight), feeds: feeds(), environment, update: releaseForPage(), keybindings: threadKeybindings() };
    const key = await wc.insertCSS(files.css);
    if (gone()) {
      uncss(wc, key);
      return "skip";
    }
    state.cssKeys.set(wc.id, key);
    (globalThis.__t3plusCssKeys ??= new Map()).set(wc.id, key);
    await wc.executeJavaScript(inPage(`window.__t3plusBoot=${JSON.stringify(boot)};\n${files.stub}\n;window.__t3plusInjected=true;\n${files.js}\n;0`));
    state.injected.add(wc.id);
    for (const kind of Object.keys(FEEDS)) pushed.set(`${wc.id}:${kind}`, feedTimes[kind]); // boot.feeds carried these
    log(replaced ? "re-injected into" : "injected into", wc.id);
    return replaced ? "re-injected" : "injected";
  }
  // One injection at a time per window: a load (a reload, a new page) while the window is
  // still being injected waits for it, then finds that copy and replaces it. Run side by
  // side, both found none running and the page got two copies and two stylesheets. One
  // that never settles (a hung page) holds the next back a few seconds only.
  const injecting = new Map(); // webContents id -> the injection under way, settled
  function injectOnce(wc) {
    const id = wc.id;
    const before = injecting.get(id);
    const ready = before ? Promise.race([before, new Promise((r) => setTimeout(r, 5000))]) : Promise.resolve();
    const run = ready.then(() => inject(wc));
    const settled = run.then(() => {}, () => {});
    injecting.set(id, settled);
    settled.then(() => { if (injecting.get(id) === settled) injecting.delete(id); });
    return run;
  }
  // The user's keybindings.json (T3's rules for every command: a rule for another command
  // on the same key wins over a thread shortcut, as in T3): t3+ runs T3's thread shortcuts
  // over the open profile's threads. Read as T3 reads it (comments and trailing commas
  // allowed); only each rule's key, command and `when` go to the page. null without the
  // file (T3's defaults apply). Followed as T3 follows it: a change is pushed to the page.
  const keybindingsFile = () => path.join(data.config.t3Home, "userdata", "keybindings.json");
  function threadKeybindings() {
    try {
      let text = fs.readFileSync(keybindingsFile(), "utf8");
      text = text.replace(/("(?:[^"\\]|\\.)*")|\/\/[^\r\n]*|\/\*[\s\S]*?\*\//g, (m, str) => (str ? m : " "));
      text = text.replace(/("(?:[^"\\]|\\.)*")|,(\s*[}\]])/g, (m, str, bracket) => (str ? m : (bracket ?? "")));
      const all = JSON.parse(text);
      if (!Array.isArray(all)) return null;
      return all
        .filter((b) => b && typeof b.key === "string" && typeof b.command === "string" && b.key.length <= 128 && b.command.length <= 128 && (b.when === undefined || (typeof b.when === "string" && b.when.length <= 1024)))
        .map((b) => (b.when === undefined ? { key: b.key, command: b.command } : { key: b.key, command: b.command, when: b.when }))
        .slice(-1024); // the page keeps T3's last 256 valid ones
    } catch {
      return null;
    }
  }
  let keybindingsWatched = null;
  function watchKeybindings() {
    try {
      const file = keybindingsFile();
      const onChange = (now, before) => {
        if (state.disposed || (now.mtimeMs === before.mtimeMs && now.size === before.size)) return;
        const rules = JSON.stringify(threadKeybindings());
        for (const wc of electron.webContents.getAllWebContents()) {
          if (!isTarget(wc) || !state.injected.has(wc.id)) continue;
          wc.executeJavaScript(inPage(`window.__t3plusBoot && (window.__t3plusBoot.keybindings = ${rules});0`)).catch(() => {});
        }
      };
      fs.watchFile(file, { interval: 500, persistent: false }, onChange);
      keybindingsWatched = () => fs.unwatchFile(file, onChange);
    } catch {
      keybindingsWatched = null;
    }
  }
  // T3's description of this machine (/.well-known/t3/environment on its local server):
  // its id, its name and what kind of machine it is. Nothing else is kept from it.
  let environmentCache = null;
  async function hostEnvironment() {
    if (environmentCache) return environmentCache;
    try {
      const runtime = JSON.parse(fs.readFileSync(path.join(data.config.t3Home, "userdata", "server-runtime.json"), "utf8"));
      const response = await fetch(`http://127.0.0.1:${Number(runtime.port) || 3773}/.well-known/t3/environment`, { signal: AbortSignal.timeout(1500) });
      const env = await response.json();
      if (typeof env?.environmentId !== "string") return null;
      const short = (v, max) => (typeof v === "string" ? v.slice(0, max) : null);
      environmentCache = { id: short(env.environmentId, 64), label: short(env.label, 64), machine: short(env.platform?.machine, 16) };
      return environmentCache;
    } catch {
      return null; // T3's server not up yet: asked again at the next injection
    }
  }
  // Each window's listeners, taken off on dispose, or as soon as the window is gone along
  // with all that was kept about it (T3 makes and drops web contents: previews, devtools).
  const detach = new Map(); // webContents id -> () => void
  function attach(wc) {
    if (detach.has(wc.id)) return;
    const id = wc.id;
    const onLoad = () => { injectOnce(wc).catch((e) => log("inject failed:", e && e.message)); };
    // Electron passes the text as the third argument (older) or on the event (newer).
    // Only the app's own page speaks for t3+, not a frame embedded in it. Nothing it says
    // may throw here: that would be an uncaught error in T3's main process.
    const onConsole = (event, _level, message) => {
      try {
        const frame = event && event.frame;
        const main = wc.mainFrame;
        if (frame && main && (frame.processId !== main.processId || frame.routingId !== main.routingId)) return;
        onNote(wc, typeof message === "string" ? message : event && event.message);
      } catch (e) {
        log("page note failed:", e && e.message);
      }
    };
    const onDestroyed = () => {
      off();
      keysByWindow.delete(id);
      for (const kind of Object.keys(FEEDS)) pushed.delete(`${id}:${kind}`);
      state.injected.delete(id);
      state.cssKeys.delete(id);
      globalThis.__t3plusCssKeys?.delete(id);
    };
    const off = () => {
      detach.delete(id);
      try { wc.off("did-finish-load", onLoad); wc.off("console-message", onConsole); wc.off("destroyed", onDestroyed); } catch {}
    };
    wc.on("did-finish-load", onLoad);
    wc.on("console-message", onConsole);
    wc.once("destroyed", onDestroyed);
    detach.set(id, off);
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
    // Asked for only while the sidebar's Status view is on screen, every 2 s: a little
    // under that, so each ask gets a fresh copy (timers run a little early or late).
    threads: { file: "feeds/t3plus-threads.json", maxAge: 1800 },
  };
  const data = createFeeds({ home: HOME, log });
  state.undo.push(() => data.dispose());
  let botIds = [];
  const mtime = (f) => { try { return fs.statSync(path.join(HOME, f)).mtimeMs; } catch { return 0; } };
  const pushed = new Map(); // `${wc.id}:${kind}` -> mtime handed to that page
  const running = new Set();
  const lastRun = new Map(); // kind -> when its last publish started
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
    (kind === "bots" ? data.publishBots(botIds) : kind === "threads" ? data.publishThreads() : data.publishHome())
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
      // Hand over the new copies and let t3+ pick them up now rather than at its next poll,
      // those alone (each read asks for a fresh copy: all of them read on every push had the
      // bot feed republished every few seconds while only the threads feed moved).
      // Through t3+'s own hook: a synthetic "visibilitychange" also reached T3's
      // listeners, which report activity to every environment and refresh their data.
      wc.executeJavaScript(inPage(`(() => { Object.assign(window.__t3plusFeeds = window.__t3plusFeeds || {}, ${JSON.stringify(changed)});
        try { window.__t3plusApp?.feedsUpdated?.(${JSON.stringify(Object.keys(changed))}); } catch {} })();0`)).catch(() => {});
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
    if (!Object.hasOwn(FEEDS, kind) || !inUse(wc)) return;
    // Stale once its last publish began (else its file was written) longer ago than its
    // maxAge. Not from when the file was written: a publish that took a while then made
    // the page's next ask look early, and only every other one was answered.
    const last = lastRun.get(kind) ?? mtime(FEEDS[kind].file);
    if (Date.now() - last > FEEDS[kind].maxAge) publish(kind);
  }
  // Threads made bots by Option-click: the bot feed needs their ids.
  // Each window reports its own list (its bots and its open thread); the feed covers
  // all of them. One shared list, replaced by whichever window spoke last, dropped the
  // other window's previews and spend.
  let botKeys = null;
  const keysByWindow = new Map(); // webContents id -> thread ids
  // What a window may report: a sidebar's worth of thread keys, each of a sane length.
  const MAX_KEYS = 256;
  const MAX_KEY_CHARS = 300;
  // The worker covers this many (feeds-worker.js, MAX_BOTS), the most wanted first.
  const MAX_BOTS = 64;
  function onBotKeys(wc, keys) {
    const ids = (Array.isArray(keys) ? keys.slice(0, MAX_KEYS) : []).filter((k) => typeof k === "string" && k.length <= MAX_KEY_CHARS).map((k) => k.slice(k.indexOf(":") + 1));
    keysByWindow.set(wc.id, ids);
    // Most wanted first, for the worker's cap: every window's first key (its open
    // thread), then the rest in each window's order (its bots, top down).
    const lists = [...keysByWindow.values()];
    botIds = [...new Set([...lists.map((l) => l[0]).filter(Boolean), ...lists.flat()])].slice(0, MAX_BOTS);
    // Republished when the threads covered change, not when rows only move among them;
    // whatever publishes next uses the new order.
    const next = JSON.stringify([...botIds].sort());
    if (next === botKeys) return;
    botKeys = next;
    lastRun.delete("bots");
    if (botIds.length) publish("bots");
  }
  function onNote(wc, text) {
    if (typeof text !== "string" || !text.startsWith("[t3plus]") || !isTarget(wc)) return;
    let note;
    try { note = JSON.parse(text.slice(8)); } catch { return; }
    if (!note || typeof note !== "object") return;
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
  // T3's native menu for a project folder gets t3+'s "Move to profile" submenu. T3 builds
  // it here, in the main process, from items its page sends over IPC: as the menu opens
  // the page is asked for the submenu (window.__t3plusApp.projectMenu), and a pick from it
  // goes back to the page. T3 ignores a picked id it does not know. Its own handler is put
  // back on dispose; without it (a T3 that moved the menu) nothing changes.
  const MENU_CHANNEL = "desktop:context-menu";
  const invokeHandlers = electron.ipcMain._invokeHandlers;
  const t3Menu = invokeHandlers instanceof Map ? invokeHandlers.get(MENU_CHANNEL) : null;
  if (typeof t3Menu === "function") {
    const own = t3Menu.__t3plusOwn ?? t3Menu; // an older loader's wrapper left in place: T3's own under it
    const isProjectMenu = (items) => Array.isArray(items) && items.some((i) => i && i.id === "copy-path") && items.some((i) => i && i.id === "project-settings");
    const wrapped = async (event, raw) => {
      let input = raw;
      const wc = event && event.sender;
      try {
        if (!state.disposed && wc && isTarget(wc) && state.injected.has(wc.id) && raw && isProjectMenu(raw.items)) {
          const extra = await Promise.race([
            wc.executeJavaScript(inPage("(() => { try { return window.__t3plusApp?.projectMenu?.() ?? null; } catch { return null; } })()")),
            new Promise((r) => setTimeout(() => r(null), 300)),
          ]);
          if (extra && typeof extra.id === "string" && Array.isArray(extra.children)) {
            // Before T3's destructive items (kept last, after their separator), else at the end.
            // With an item of ours marked separatorBefore, T3 adds no separator of its own
            // before its destructive ones: the first of them gets it explicitly.
            const at = raw.items.findIndex((i) => i && i.destructive === true);
            const items = [...raw.items];
            if (at >= 0) items[at] = { ...items[at], separatorBefore: true };
            items.splice(at < 0 ? items.length : at, 0, extra);
            input = { ...raw, items };
          }
        }
      } catch {}
      const picked = await own(event, input);
      // Told whenever t3+'s submenu was in it, a pick of its or not: the folder right-clicked
      // is forgotten either way (a menu opened later, without a right-click, is not about it).
      if (input !== raw && wc && !wc.isDestroyed()) {
        const pick = typeof picked === "string" && picked.startsWith("t3plus:") ? picked : null;
        wc.executeJavaScript(inPage(`(() => { try { window.__t3plusApp?.projectMenuPick?.(${JSON.stringify(pick)}); } catch {} })();0`)).catch(() => {});
      }
      return picked;
    };
    wrapped.__t3plusOwn = own;
    electron.ipcMain.removeHandler(MENU_CHANNEL);
    electron.ipcMain.handle(MENU_CHANNEL, wrapped);
    state.undo.push(() => {
      // Only when it is still this wrapper (T3 may have registered a new handler since).
      if (invokeHandlers.get(MENU_CHANNEL) !== wrapped) return;
      electron.ipcMain.removeHandler(MENU_CHANNEL);
      electron.ipcMain.handle(MENU_CHANNEL, own);
    });
    log("project menu: Move to profile added");
  } else log("project menu: T3's handler not found, Move to profile off");

  state.publish = publish;
  // Updates: once a day, the latest release of t3+'s public repository on GitHub. This is
  // the one request t3+ makes off this Mac; it sends nothing but the request, and keeps
  // only the release's version and page (in state/, so a restart does not ask again).
  // When it is newer, the page says so (src/updateNotice.js).
  const RELEASES = "https://api.github.com/repos/arjundgupta/t3plus/releases/latest";
  const UPDATE_FILE = "state/t3plus-update.json";
  const UPDATE_EVERY = 24 * 60 * 60 * 1000;
  let release = null;
  try {
    const saved = JSON.parse(read(UPDATE_FILE) || "null");
    if (saved && typeof saved.latest === "string") release = saved;
  } catch {}
  function releaseForPage() {
    return release ? { latest: release.latest, url: release.url ?? null } : null;
  }
  let checking = false;
  async function checkForUpdate() {
    if (state.disposed || checking || (release && Date.now() - (release.checkedAt || 0) < UPDATE_EVERY)) return;
    checking = true;
    try {
      const response = await fetch(RELEASES, { headers: { accept: "application/vnd.github+json", "user-agent": "t3plus" }, signal: AbortSignal.timeout(10000) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const body = await response.json();
      const latest = String(body?.tag_name ?? "").replace(/^v/, "");
      if (!/^\d+\.\d+\.\d+$/.test(latest)) throw new Error("no version in the latest release");
      const url = typeof body.html_url === "string" && body.html_url.startsWith("https://github.com/") ? body.html_url : null;
      release = { latest, url, checkedAt: Date.now() };
      fs.mkdirSync(path.join(HOME, "state"), { recursive: true });
      fs.writeFileSync(path.join(HOME, UPDATE_FILE), JSON.stringify(release));
      if (state.disposed) return;
      const info = JSON.stringify(releaseForPage());
      for (const wc of electron.webContents.getAllWebContents()) {
        if (!isTarget(wc) || !state.injected.has(wc.id)) continue;
        wc.executeJavaScript(inPage(`window.__t3plusBoot && (window.__t3plusBoot.update = ${info}); try { window.__t3plusApp?.updateInfo?.(${info}); } catch {} 0`)).catch(() => {});
      }
    } catch (e) {
      log("update check failed:", String(e && e.message).slice(0, 120)); // tried again at the next tick
    } finally {
      checking = false;
    }
  }
  // A little after start (t3+ is drawn first), then every few hours: a day after the last check.
  const firstCheck = setTimeout(checkForUpdate, 20 * 1000);
  const updateTicks = setInterval(checkForUpdate, 3 * 60 * 60 * 1000);
  firstCheck.unref?.();
  updateTicks.unref?.();
  state.undo.push(() => { clearTimeout(firstCheck); clearInterval(updateTicks); });

  watchKeybindings();
  state.undo.push(() => keybindingsWatched?.());
  state.data = data;
  state.debug = () => ({ lastRun: Object.fromEntries(lastRun), running: [...running], botKeys, health: health && JSON.parse(health) });

  state.dispose = (reload = false) => {
    // A loader still injecting (a second `on` arrived mid-loop) stops attaching and
    // injecting from here on.
    state.disposed = true;
    for (const off of [...detach.values()]) off();
    for (const fn of state.undo.splice(0)) fn();
    // `off` takes t3+'s styles away with its page. A newer loader leaves them to the copy
    // still running until it has stopped that copy (its inject removes them then).
    if (reload) {
      for (const wc of electron.webContents.getAllWebContents()) {
        const key = state.cssKeys.get(wc.id);
        if (key) { uncss(wc, key); globalThis.__t3plusCssKeys?.delete(wc.id); }
        try { if (state.injected.has(wc.id) && !wc.isDestroyed()) wc.reload(); } catch {}
      }
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
    try { results.push(`${wc.id}:${await injectOnce(wc)}`); } catch (e) { results.push(`${wc.id}:error ${e && e.message}`); }
  }
  return results.join(", ");
})()
