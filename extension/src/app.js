import { createAppearancePanel, ensurePanelMounted, findAppearanceContainer } from "./appearancePanel.js";
import { SETTINGS_ROUTE, createSettingsNavItem, findSettingsNavAnchor, findSettingsPage } from "./settingsSection.js";
import {
  classifyBots,
  clearBotDecoration,
  decorateBotRows,
  normalizeBotPrefs,
  parseBotTitle,
  resolveBotPresentation,
  decorateBotBreadcrumb,
  decorateBotHoverCards,
  clearAvatarVars,
  applyAvatarVars,
  knownBotTitle,
  noteBotRowChanges,
  relabelBotTooltips,
  shownBotPrefs,
} from "./bots.js";
import { LOOK, applyComposerTheme, dropLook, measureBackdropAnchor, setLook, syncBackdropHosts, syncComposerSurfaces } from "./composer.js";
import { botMetaText, botPreviewText, botSubagents, threadIdFromKey, threadSpend } from "./botFeed.js";
import { BOT_FEED_POLL_MS, BOT_LIMITS, DEFAULT_BOT_MARKER, DOM_CHECK_THROTTLE_MS, HOME_FEED_POLL_MS, SAMPLE_IMAGE_LIGHT_PATH, SAMPLE_IMAGE_PATH, STORAGE_KEYS, T3_ATTRS, T3_CLASSES, T3_SELECTORS, T3PLUS, USAGE_ROUTE } from "./config.js";
import { createHomeView, showsAnyCard } from "./homeWidgets.js";
import { createUsageDither } from "./usageDither.js";
import { createDemoMode } from "./demoMode.js";
import { hasPool, providerKind } from "./homeData.js";
import { createDomWatcher } from "./domWatcher.js";
import { computeComposerTheme } from "./gradient.js";
import { DITHER_CELL_CSS } from "./backdropRenderer.js";
import { dataUrlToBlob, prepareImageFile } from "./imageStore.js";
import { defaultSettings, newWriteId, normalizeSettings } from "./settings.js";
import { findSidebarInner, scanSidebar, threadKeyFromPath } from "./sidebar.js";
import { threadProjectColor } from "./projectColor.js";
import { stopSprites } from "./spriteClock.js";
import { assignBotShapes, setBotStyle } from "./botArt.js";
import { createHealth } from "./health.js";
import { createUpdateToast } from "./updateNotice.js";
import { applyBubble, clearBubble } from "./bubbles.js";
import { profileHex, profileOf } from "./profiles.js";
import {
  ALL,
  BASE_SCOPE,
  applyEdit,
  clearScopeValues,
  emptyScopes,
  isBaseScope,
  layersOf,
  normalizeScopes,
  parseScopeKey,
  resolveSettings,
  scopeKey,
  scopeValues,
  scopesSetting,
  setScopeValues,
  SCOPED_PATHS,
} from "./settingsScopes.js";
import { BOT_STATUS, STATUS_BOT_COLORS, STATUS_ICON, STATUS_WORDS, ago, buildStatusModel, createStatusView, normalizeViewState } from "./statusView.js";

/** The settings groups Reset puts back: the appearance (background and glass). */
const APPEARANCE_GROUPS = Object.freeze(["composerGradient", "glass"]);
const isAppearancePath = (path) => APPEARANCE_GROUPS.some((group) => path.startsWith(`${group}.`));
/** A folder header's name element (the row itself when T3 marks none). */
const folderName = (row) => row.querySelector(T3_SELECTORS.folderTitle) ?? row;

/**
 * Wires storage, the background/glass theme, the sidebar's bot rows,
 * the Appearance panel, and the DOM watcher. Everything browser-specific comes
 * in through `deps`, so tests can run this in jsdom.
 *
 * deps: {
 *   win, doc,
 *   settingsStore, imageStore,             settings.js / imageStore.js
 *   scopesStore?,                          settingsScopes.js (per profile and machine; without it, one set of settings)
 *   viewStore?, threadsFeed?,              statusView.js (the sidebar's Status view, and each thread's status)
 *   botStore,                              bots.js
 *   botFeed?,                              botFeed.js (latest message per bot, read-only)
 *   backdropRenderer?,                     backdropRenderer.js (canvas dither; omitted in jsdom tests)
 *   homeFeed?,                             homeData.js createHomeFeed (home widget data, read-only)
 *   assetUrl(path) -> string,              chrome.runtime.getURL in the extension
 *   prepareImage?(file, limits) -> record, defaults to prepareImageFile
 *   imageLimits?                           size caps for an uploaded image (the desktop build's are smaller)
 *   desktop?                               running in T3's desktop app (the loader), not the Chrome extension
 *   mirror?() -> stop,                     backup.js mirrorToSync, started with the app and stopped with it
 *   isAlive?() -> boolean, throttleMs?,
 * }
 */
export function createT3Plus(deps) {
  const { win, doc, settingsStore, imageStore, botStore, assetUrl } = deps;
  const prepareImage = deps.prepareImage ?? prepareImageFile;
  // T3 Code desktop routes in the URL hash (t3code://app/#/<environmentId>/<threadId>); the web app uses the path.
  const routePath = () => {
    const hash = win.location.hash ?? "";
    return hash.startsWith("#/") ? hash.slice(1).split(/[?#]/)[0] : win.location.pathname;
  };

  const state = {
    // What is drawn: the base with the scopes of the open profile and machine over it
    // (on t3+'s Settings page, the scope being edited there, so its preview is that one's).
    settings: defaultSettings(),
    // Stored: the base (All profiles on All devices), and each scope's own values.
    base: defaultSettings(),
    scopes: emptyScopes(),
    // Which scope Settings edits (its "Applying t3+ for … on …" bar). Not stored.
    editScope: BASE_SCOPE,
    // The sidebar's view (Projects or Status) and its folded groups.
    view: normalizeViewState(null),
    threadsFeed: null,
    image: null,
    imageUrl: null,
    message: "",
    botPrefs: {},
    manualBots: {},
    knownBots: {},
    botMessage: "",
    bots: [],
    botFeed: null,
    homeFeed: null,
  };
  let objectUrl = null;
  let objectUrlFor = null;
  let warnedOrphans = false;
  const unsubscribers = [];
  // Set by stop(). A save, a feed read or start() itself can finish after it;
  // without this they re-rendered and re-ran checks in the stopped copy, so a
  // re-injected t3+ ran twice (two glows, two panels).
  let stopped = false;

  /** The sample's light version, while the sample (not an upload) is the image shown. */
  function sampleLightUrl(settings = state.settings) {
    const usesUpload = settings.composerGradient.imageSource === "upload" && state.image;
    return usesUpload ? null : assetUrl(SAMPLE_IMAGE_LIGHT_PATH) || null;
  }
  function resolveImageUrl() {
    const { imageSource } = state.settings.composerGradient;
    if (imageSource === "upload" && state.image) {
      if (objectUrlFor !== state.image.dataUrl) {
        if (objectUrl) win.URL.revokeObjectURL(objectUrl);
        objectUrl = null;
        objectUrlFor = state.image.dataUrl;
        try {
          objectUrl = win.URL.createObjectURL(dataUrlToBlob(state.image.dataUrl));
        } catch {
          // A stored image that does not decode (a hand-edited or damaged backup):
          // the sample instead. Thrown here, it broke every render and the panel.
        }
      }
      if (objectUrl) return objectUrl;
    }
    // The upload is removed or not in use: release its in-memory copy (made again if it comes back).
    if (objectUrl) {
      win.URL.revokeObjectURL(objectUrl);
      objectUrl = null;
      objectUrlFor = null;
    }
    return assetUrl(SAMPLE_IMAGE_PATH);
  }

  /** Bots for the Settings list: every bot seen in the sidebar plus any with saved settings. */
  function botsForPanel() {
    const marker = DEFAULT_BOT_MARKER;
    // The bots in the sidebar now, the most recently seen ones (Settings has no
    // sidebar), and any with saved settings or turned on by hand. With every
    // thread a bot by default, all ever seen would be a long list.
    // A thread turned off by hand is no bot: listed as "Bot", its Forget button
    // cleared that choice and made it a bot again.
    const recent = Object.entries(state.knownBots)
      .filter(([key]) => state.manualBots[key] !== false)
      .sort((a, b) => (b[1].seenAt ?? 0) - (a[1].seenAt ?? 0))
      .slice(0, BOT_LIMITS.maxBots)
      .map(([key]) => key);
    const prefsKeys = Object.keys(state.botPrefs).filter((k) => state.manualBots[k] !== false);
    const keys = new Set([...state.bots.map((b) => b.key), ...recent, ...prefsKeys, ...Object.keys(state.manualBots).filter((k) => state.manualBots[k] === true)]);
    const live = new Map(state.bots.map((b) => [b.key, b]));
    return [...keys].sort().map((key) => {
      // A bot in the sidebar keeps its name after Forget (which clears what was stored).
      const title = state.knownBots[key]?.title ?? (live.has(key) ? knownBotTitle(live.get(key).thread.title) : "");
      const titleLabel = parseBotTitle(title, marker)?.label ?? ((state.manualBots[key] ?? state.settings.sidebar.botsDefault) ? title : "");
      const prefs = normalizeBotPrefs(state.botPrefs[key]);
      const projectColor = state.knownBots[key]?.projectColor ?? live.get(key)?.projectColor ?? null;
      if (demoOn()) {
        // Screenshot mode covers Settings too: the bot list and the live preview show stand-ins.
        const label = demo.label("bot", titleLabel || "Bot");
        const view = resolveBotPresentation({ key, titleLabel: label, projectColor }, prefs);
        const entry = state.botFeed?.entries.get(threadIdFromKey(key));
        const meta = entry ? [entry.model, entry.computer && demo.label("machine", entry.computer)].filter(Boolean).join(" · ") : "";
        const preview = botPreviewText(state.botFeed, key) ? demo.label("botMessage", key) : "";
        return { key, title: label, titleLabel: label, projectColor, prefs, view, preview, meta };
      }
      const view = resolveBotPresentation({ key, titleLabel, projectColor }, prefs);
      return { key, title, titleLabel, projectColor, prefs, view, preview: botPreviewText(state.botFeed, key), meta: botMetaText(state.botFeed, key) };
    });
  }

  // ---------- Profiles and machines: which settings are drawn ----------
  // The profile on screen (profiles.js onShown) and the machine of the open thread (its
  // route; kept on pages without one, so Settings or the new-thread page look the same).
  let shownProfile = null;
  let device = null;
  const profilesOn = () => state.base.sidebar.profiles && Boolean(deps.profiles?.isLoaded?.());
  /** The profile and machine open now (ALL for none): their settings are the ones in use. */
  const liveScope = () => ({ profile: profilesOn() && shownProfile ? shownProfile : ALL, device: device ?? ALL });
  const settingsOpen = () => doc.documentElement.hasAttribute(T3PLUS.settingsAttr);
  /** What is drawn: the open profile and machine, or on t3+'s Settings page the scope edited there. */
  const drawnScope = () => (settingsOpen() ? state.editScope : liveScope());
  let drawnKey = "";
  /** The scope Settings edits, if it is still one there is (a profile deleted elsewhere, profiles off: All). */
  function checkEditScope() {
    const { profile, device: machine } = state.editScope;
    const keepProfile = profile === ALL || panelProfiles().some((p) => p.id === profile);
    const keepDevice = machine === ALL || deviceList().some((d) => d.id === machine);
    if (!keepProfile || !keepDevice) state.editScope = { profile: keepProfile ? profile : ALL, device: keepDevice ? machine : ALL };
  }
  function resolve() {
    if (!isBaseScope(state.editScope)) checkEditScope();
    const scope = drawnScope();
    drawnKey = scopeKey(scope);
    state.settings = resolveSettings(state.base, state.scopes, scope);
    warmSoon(); // a look may have changed: the other profiles' glows too
  }
  /** After a change of profile, machine or page: drawn again when the settings in use changed. */
  let contextRoute = null;
  function syncContext() {
    const route = routePath();
    if (route !== contextRoute) {
      contextRoute = route;
      measureDue = true; // another page: everything is somewhere else
    }
    const routeKey = threadKeyFromPath(route);
    const env = routeKey ? routeKey.slice(0, routeKey.indexOf(":")) : null;
    if (env) device = env;
    else device ??= hostEnvironment()?.id ?? null;
    if (scopeKey(drawnScope()) === drawnKey) return;
    resolve();
    render();
  }

  // This machine as T3 names it (the desktop loader asks T3's server), and the other
  // machines threads in the sidebar run on.
  const hostEnvironment = () => {
    const env = win.__t3plusBoot?.environment;
    return env && typeof env.id === "string" ? env : null;
  };
  const seenDevices = new Set();
  function deviceList() {
    const host = hostEnvironment();
    const ids = [];
    const add = (id) => {
      if (id && id !== ALL && !ids.includes(id)) ids.push(id);
    };
    add(host?.id);
    for (const id of seenDevices) add(id);
    if (device) add(device);
    for (const key of Object.keys(state.scopes.overrides)) add(parseScopeKey(key)?.device);
    const others = ids.filter((id) => id !== host?.id);
    return ids.map((id) => {
      if (id === host?.id) return { id, label: demoOn() ? demo.label("machine", host.label || "This Mac") : host.label || "This Mac", kind: host.machine || "laptop", here: true };
      const n = others.indexOf(id) + 1;
      // A machine T3 does not name to t3+: by its place (a server T3 connects to, mostly).
      const label = host ? (others.length > 1 ? `Remote machine ${n}` : "Remote machine") : others.length > 1 ? `Machine ${n}` : "This machine";
      return { id, label, kind: host ? "server" : "laptop", here: !host && id === device };
    });
  }

  /** "Work", "All profiles on Studio Mac": a scope as Settings names it. */
  function scopeName(scope, profiles = panelProfiles(), devices = deviceList()) {
    const profile = scope.profile === ALL ? null : (profiles.find((p) => p.id === scope.profile)?.name ?? "A deleted profile");
    const machine = scope.device === ALL ? null : (devices.find((d) => d.id === scope.device)?.label ?? "Another machine");
    if (profile && machine) return `${profile} on ${machine}`;
    return profile ?? (machine ? `All profiles on ${machine}` : "All profiles");
  }
  function panelProfiles() {
    if (!profilesOn()) return [];
    return deps.profiles.state.list.map((p, i) => ({ id: p.id, name: demoOn() ? `Profile ${i + 1}` : p.name, color: profileHex(p.color), icon: p.icon ?? null }));
  }

  /**
   * For All profiles on All devices: each setting some scope sets itself, and those scopes'
   * names. The ones that apply to what is open come first; the one deciding what you see
   * now (the narrowest) is marked "open". A profile's scope while profiles are off
   * applies nowhere: not named.
   */
  function elsewhereNames(profiles, devices) {
    const live = liveScope();
    const liveLayers = layersOf(live);
    const on = profilesOn();
    const names = {};
    for (const path of SCOPED_PATHS) {
      const keys = scopesSetting(state.scopes, path).filter((key) => on || parseScopeKey(key).profile === ALL);
      if (!keys.length) continue;
      const applying = liveLayers.filter((key) => keys.includes(key));
      const deciding = applying.at(-1);
      const ordered = [...applying.reverse(), ...keys.filter((key) => !applying.includes(key))];
      names[path] = ordered.map((key) => `${scopeName(parseScopeKey(key), profiles, devices)}${key === deciding ? " (open)" : ""}`);
    }
    return names;
  }

  // The Settings panel (a chip per bot) is brought up to date only while it is
  // on screen, and once when it is put there: with many bots, every render (a slider
  // step, a feed read, a storage echo) restyled thousands of detached swatches.
  let panelStale = true;
  function updatePanel() {
    panelStale = false;
    const profiles = deps.profiles?.state ?? null;
    const scopeProfiles = panelProfiles();
    const devices = deviceList();
    const edit = state.editScope;
    const base = isBaseScope(edit);
    panel.update({
      ...state,
      // The values of the scope being edited (what is drawn may be the open profile's).
      settings: resolveSettings(state.base, state.scopes, edit),
      bots: botsForPanel(),
      botMarker: DEFAULT_BOT_MARKER,
      // A newer t3+ release, while its card is not hidden.
      update: deps.updates?.pending ?? null,
      // The sample's light version (the Image row's thumbnail on a light page); none for an upload.
      imageLightUrl: sampleLightUrl(),
      // Profiles (their icons and colors), when they are on, and each one's glow color
      // (its preview in the Profiles card).
      profiles: profiles && profilesOn() ? { list: profiles.list, active: profiles.active, sky: Boolean(deps.profiles.hasSky?.()) } : null,
      profileAccents: Object.fromEntries(scopeProfiles.map((p) => [p.id, resolveSettings(state.base, state.scopes, { profile: p.id, device: ALL }).composerGradient.accent])),
      // The scope bar: what is edited, the choices, what the scope sets itself, and for
      // All profiles on All devices which settings some scope sets otherwise.
      scope: {
        edit,
        name: scopeName(edit, scopeProfiles, devices),
        live: liveScope(),
        profiles: scopeProfiles,
        devices,
        own: scopeValues(state.scopes, edit),
        elsewhere: base ? elsewhereNames(scopeProfiles, devices) : {},
      },
    });
  }

  function render() {
    if (stopped) return;
    const s = state.settings;
    setBotStyle(s.sidebar.botStyle);
    state.imageUrl = resolveImageUrl();
    applyComposerTheme(doc, computeComposerTheme(s, state.imageUrl, sampleLightUrl()));
    // What "Default" means in a profile's glow and bubble swatches (the dot's editor):
    // the value for all profiles, as it is on this machine.
    const wide = resolveSettings(state.base, state.scopes, { profile: ALL, device: device ?? ALL });
    const own = wide.composerGradient.accent;
    setLook(doc, LOOK.editor, { "--t3plus-look-accent": own === "theme" ? null : own });
    // Your messages' bubbles: in the color the settings in use say, else T3's.
    applyBubble(doc, s.chat.bubble === "theme" ? null : s.chat.bubble, wide.chat.bubble === "theme" ? null : wide.chat.bubble);
    panelChanged();
    watcher.schedule();
  }
  /** What Settings shows changed: brought up to date now if it is on screen, else once it is put there. */
  function panelChanged() {
    if (panel.element.isConnected) updatePanel();
    else panelStale = true;
  }

  function rememberBots(bots) {
    let next = null; // a copy of the list, made once something in it changes
    for (const bot of bots) {
      const known = state.knownBots[bot.key];
      const title = knownBotTitle(bot.thread.title);
      // The project color is kept too, so Settings can draw the bot when its row is not on screen.
      if (known?.title !== title || (bot.projectColor && known?.projectColor !== bot.projectColor)) {
        next ??= { ...state.knownBots };
        next[bot.key] = { title, seenAt: Date.now(), ...(bot.projectColor ?? known?.projectColor ? { projectColor: bot.projectColor ?? known.projectColor } : {}) };
      }
    }
    if (!next) return;
    // The cap only trims bots that are not on screen. Trimming visible ones (more
    // than the cap in the sidebar) dropped some each check, re-added them the next,
    // and rewrote storage on every check: a loop that never settled.
    // Bots seen in the last ten minutes are kept too: another T3 window sharing this
    // list may show them, and trimming its bots made it write them back, which
    // trimmed this window's: two windows rewriting the list back and forth.
    const visible = new Set(bots.map((b) => b.key));
    const recent = Date.now() - 10 * 60 * 1000;
    const rest = Object.entries(next)
      .filter(([key]) => !visible.has(key))
      .sort((a, b) => b[1].seenAt - a[1].seenAt);
    const room = Math.max(0, BOT_LIMITS.maxBots * 2 - visible.size);
    const others = rest.filter(([, v], i) => i < room || v.seenAt >= recent);
    state.knownBots = Object.fromEntries([...Object.entries(next).filter(([key]) => visible.has(key)), ...others]);
    botStore.saveKnown(state.knownBots).catch(() => {});
  }

  /** Tells the loader which threads to publish the bot feed for, and reads it when that changed. */
  function followBots(bots) {
    // A bot that changed state (started, finished, asks for something) or a new bot
    // probably has a new latest message: fetch it now instead of waiting for the poll.
    const openKey = threadKeyFromPath(routePath());
    // The open profile's bots before the other profiles' (hidden) ones, which come first in
    // T3's list as often as not: the loader's feed covers the first 64 (main-loader.js).
    const profiles = profilesOn() && shownProfile ? deps.profiles.state : null;
    const shown = [];
    const hidden = [];
    for (const bot of bots) {
      const { folderKey } = bot.thread;
      (!profiles || folderKey === null || profileOf(profiles, folderKey) === shownProfile ? shown : hidden).push(bot);
    }
    const ordered = hidden.length ? [...shown, ...hidden] : bots;
    const signature = [openKey, shownProfile, ...ordered.map((b) => `${b.key}|${b.status}|${b.statusLabel}`)].join("\n");
    if (signature === botSignature) return;
    botSignature = signature;
    // The desktop loader publishes the bot feed (latest message, subagents) for these threads.
    try {
      // The open thread too, bot or not: the details card shows its spend.
      // Most wanted first (the loader's feed has a cap): the open thread, then the bots top down.
      win.__t3plusTell?.("bots", { keys: [...new Set([...(openKey ? [openKey] : []), ...ordered.map((b) => b.key)])] });
    } catch {
      // no loader (the Chrome extension)
    }
    // The open thread's spend (thread details) comes from the same feed, bots or not.
    if (bots.length || openKey) queueBotFeed();
  }

  // The prefs bots are drawn with outside the Status view (T3's list, the breadcrumb, hover
  // cards, the subagents under a row): their own, with Status badges on each with its badge
  // (bots.js shownBotPrefs). Status colors paint the Status view's faces only
  // (drawStatusFace): everywhere else a bot wears its own color, and so does its badge.
  // Rebuilt only when Status badges, the bots or the prefs change, so a check with nothing
  // new hands back the same object.
  let paintMemo = { prefs: null, keys: "", painted: null };
  function paintedPrefs(bots) {
    if (!state.settings.sidebar.statusBadges) return state.botPrefs;
    const keys = bots.map((bot) => bot.key).join("\u0001");
    if (paintMemo.prefs === state.botPrefs && paintMemo.keys === keys) return paintMemo.painted;
    const painted = { ...state.botPrefs };
    for (const bot of bots) painted[bot.key] = shownBotPrefs(state.botPrefs[bot.key], { badges: true });
    paintMemo = { prefs: state.botPrefs, keys, painted };
    return painted;
  }

  function syncBreadcrumb(shown) {
    const routeKey = threadKeyFromPath(routePath());
    const activeBot = state.settings.sidebar.bots ? (shown.find((bot) => bot.key === routeKey) ?? null) : null;
    decorateBotBreadcrumb(doc, activeBot ? { ...activeBot, prefs: paintedPrefs(shown)[activeBot.key] } : null);
  }

  // A bot as kept while T3's sidebar is gone: without the rows it was read from, which
  // (the whole sidebar they were in, t3+'s faces on them too) stayed in memory until a
  // sidebar was read again.
  const withoutRows = (bot) => ({ ...bot, thread: { title: bot.thread.title, folderKey: bot.thread.folderKey } });
  // Sidebars cleared of bot decoration while bots are off (bots.js clearBotDecoration):
  // once as they go off, not in every check.
  const botsCleared = new WeakSet();
  /** Each bot's project color: a folder's badge read once for all the threads in it. */
  function projectColors(scan, bots) {
    const folders = new Map(); // folder key -> its badge's color, or null
    for (const bot of bots) {
      const { folderKey } = bot.thread;
      if (folderKey !== null && !folders.has(folderKey)) folders.set(folderKey, threadProjectColor(scan, bot.thread));
      const color = folderKey === null ? threadProjectColor(scan, bot.thread) : folders.get(folderKey);
      // Settled and snoozed rows have no badge to read: the color remembered from the
      // row before keeps the bot's face from turning another color when it settles.
      bot.projectColor = color ?? state.knownBots[bot.key]?.projectColor ?? null;
    }
  }

  function syncSidebar() {
    const inner = findSidebarInner(doc);
    lastInner = inner;
    if (!inner) {
      // No sidebar list on screen (closed and unmounted, or a layout t3+ does not
      // know): the breadcrumb still follows the open thread, from the bots seen
      // last (T3 reuses its heading, which kept the previous bot's name and face),
      // and the loader still hears which thread is open.
      if (lastScan) {
        state.bots = state.bots.map(withoutRows);
        lastScan = null;
      }
      followBots(state.bots);
      syncBreadcrumb(demoBots(state.bots));
      return;
    }
    // Screenshot mode reads titles through its stand-ins, as T3 wrote them.
    const scan = scanSidebar(inner, demo.active ? { textOf: demo.realText } : {});
    lastScan = scan;
    // The machines threads run on (Settings offers each one its own settings).
    for (const thread of scan.threads) {
      if (seenDevices.size >= 16) break;
      const i = thread.key.indexOf(":");
      if (i > 0) seenDevices.add(thread.key.slice(0, i));
    }
    const { sidebar } = state.settings;

    const bots = sidebar.bots ? classifyBots(scan, DEFAULT_BOT_MARKER, state.manualBots, sidebar.botsDefault) : [];
    // A bot wears its project's color (the badge T3 draws for the project) unless one was picked for it.
    projectColors(scan, bots);
    followBots(bots);
    state.bots = bots;
    // Dealt with the Status view's bots that T3's list does not show (syncStatus).
    assignBotShapes(bots.map((b) => b.key).concat(statusDraw.bots));
    const shown = demoBots(bots);
    if (sidebar.bots) {
      decorateBotRows(
        doc,
        scan,
        shown,
        paintedPrefs(shown),
        (key) => (demoOn() ? demo.label("botMessage", key) : botPreviewText(state.botFeed, key)),
        // Screenshot mode: the strip's tooltip lists subagent titles, so they get stand-ins.
        (key) => {
          const subs = botSubagents(state.botFeed, key);
          return demoOn() ? subs.map((s, i) => ({ ...s, title: demo.label("title", s.title || `${key}#${i}`) })) : subs;
        },
        { shape: sidebar.subagentShape, color: sidebar.subagentColor },
      );
      rememberBots(bots);
      botsCleared.delete(inner);
    } else if (!botsCleared.has(inner)) {
      clearBotDecoration(inner);
      botsCleared.add(inner);
    }

    syncBreadcrumb(shown);
    syncHoverCards();
  }

  // ---------- The Status view (statusView.js) ----------
  // A button beside the profile dots switches the sidebar between T3's list and the
  // threads grouped by status. T3's list stays in the page, hidden, so nothing of T3's
  // is lost; the view draws its own rows and opens a thread as T3's row would.
  let lastScan = null; // the sidebar as the last check read it
  let lastInner = null; // and where it is (syncSidebar, earlier in the same check)
  const statusView = createStatusView(doc, {
    onOpen: (key) => openThread(key),
    onCollapse: (group, collapsed) => saveView({ ...state.view, collapsed: { ...state.view.collapsed, [group]: collapsed } }),
    avatar: (el, row) => drawStatusFace(el, row, state.settings.sidebar),
  });
  const statusToggle = doc.createElement("button");
  statusToggle.type = "button";
  statusToggle.className = "t3plus-status-toggle";
  statusToggle.setAttribute(T3PLUS.ownedAttr, "");
  statusToggle.innerHTML = STATUS_ICON;
  // One name, its pressed state says whether the view shows.
  statusToggle.setAttribute("aria-label", "Threads by status");
  statusToggle.title = "Threads by status";
  statusToggle.addEventListener("click", () => saveView({ ...state.view, view: state.view.view === "status" ? "projects" : "status" }));
  // Its row when there are no profile dots to sit beside.
  const statusToggleRow = doc.createElement("div");
  statusToggleRow.className = "t3plus-status-toggle-row";
  statusToggleRow.setAttribute(T3PLUS.ownedAttr, "");
  function saveView(next) {
    state.view = normalizeViewState(next);
    watcher.flush();
    viewSync?.write().catch(() => {});
  }

  /** Opens a thread as its row in T3's list would (T3's own navigation), else by its address. */
  function openThread(key) {
    const inner = findSidebarInner(doc);
    const item = inner && [...inner.querySelectorAll(T3_SELECTORS.threadItem)].find((el) => el.getAttribute(T3_ATTRS.threadItem) === key);
    const row = item?.querySelector(T3_SELECTORS.sidebarRow);
    // Inert only because the Status view hides T3's list: still T3's own navigation
    // (inert lifted for the click), not an address pushed past T3's router.
    const blocker = row?.closest("[inert]") ?? null;
    if (row && (!blocker || blocker === hiddenList)) {
      if (blocker) blocker.removeAttribute("inert");
      try {
        row.click();
      } finally {
        if (blocker && hiddenList === blocker) blocker.setAttribute("inert", "");
      }
      return;
    }
    const i = key.indexOf(":");
    if (i <= 0) return;
    const path = `/${encodeURIComponent(key.slice(0, i))}/${encodeURIComponent(key.slice(i + 1))}`;
    if ((win.location.hash ?? "").startsWith("#/")) win.location.hash = `#${path}`;
    else {
      win.history.pushState(win.history.state, "", path);
      win.dispatchEvent(new win.PopStateEvent("popstate", { state: win.history.state }));
    }
  }

  // A row's face: its bot's (in its status's color with Status colors on: here only, see
  // paintedPrefs; with its badge with Status badges on), or a dot. `sidebar`: the settings
  // it is drawn in (those of the profile the view shows).
  // A face drawn already is left as it is (bots.js applyAvatarVars).
  const BOT_FACE = "t3plus-status-face t3plus-bot-avatar";
  const DOT_FACE = "t3plus-status-face t3plus-status-dot";
  function drawStatusFace(el, row, sidebar) {
    if (!row.bot) {
      if (el.className === DOT_FACE) return;
      clearAvatarVars(el);
      el.className = DOT_FACE;
      return;
    }
    const { statusColors, statusBadges } = sidebar;
    const prefs = shownBotPrefs(state.botPrefs[row.key], { statusColor: statusColors ? STATUS_BOT_COLORS[row.status] : null, badges: statusBadges });
    const bot = { key: row.key, titleLabel: row.bot.label, status: BOT_STATUS[row.status], statusLabel: STATUS_WORDS[row.status], projectColor: state.knownBots[row.key]?.projectColor ?? null };
    if (el.className !== BOT_FACE) el.className = BOT_FACE;
    applyAvatarVars(el, resolveBotPresentation(bot, prefs));
  }

  // T3's list: the one holding its folders and threads (hidden while the view shows).
  function threadList(inner, scan) {
    const first = scan.folders.values().next().value?.li ?? scan.threads[0]?.li ?? null;
    const list = first?.parentElement ?? null;
    return list && inner.contains(list) ? list : null;
  }
  // Hidden, and inert: T3's arrow keys in the sidebar skip inert rows (not merely
  // invisible ones), so they never move the focus into the list nobody sees.
  let hiddenList = null;
  function showT3List() {
    hiddenList?.removeAttribute("data-t3plus-status-hidden");
    hiddenList?.removeAttribute("inert");
    hiddenList = null;
  }
  /**
   * Draws `view` (a statusView.js view) from T3's rows as a check read them (`scan`) and the
   * thread feed: the threads of profile `profile` (null: every thread, profiles off), in
   * the sidebar settings `sidebar`. Built only when something it is made from changed (a
   * check runs about every frame while T3 streams). draw() says whether it drew anything.
   */
  function statusDrawing(view) {
    let inputs = "";
    let from = []; // the rest it was last built from (the feed, the profiles, the prefs...)
    let signature = "";
    // Its bots T3's list does not show (a collapsed folder's). They are dealt their shapes
    // with the sidebar's (syncSidebar): drawn here in one never dealt, a bot could change
    // face as its row appeared in T3's list.
    let bots = [];
    function draw(scan, profile, sidebar) {
      const profiles = profile ? deps.profiles.state : null;
      const folderTitles = new Map([...scan.folders].map(([key, { row }]) => [key, ((demo.active ? demo.realText(folderName(row)) : folderName(row).textContent) ?? "").trim()]));
      const made = [
        scan.threads.map((t) => `${t.key}|${t.ariaLabel}|${t.parent ?? ""}|${t.current ? 1 : 0}`).join("\n"),
        [...folderTitles].map(([key, title]) => `${key}|${title}`).join("\n"), // a renamed project too
        Math.floor(Date.now() / 60000),
      ].join("\u0001");
      const looks = `${demoOn()}|${JSON.stringify(state.view.collapsed)}|${sidebar.bots}|${sidebar.botsDefault}|${sidebar.statusColors}|${sidebar.statusBadges}|${sidebar.botStyle}`;
      const rest = [state.threadsFeed, profiles, profile, looks, state.botPrefs, state.manualBots, state.knownBots];
      if (made === inputs && rest.every((value, i) => value === from[i])) return false;
      inputs = made;
      from = rest;
      const groups = buildStatusModel({
        scan,
        feed: state.threadsFeed,
        folderTitles,
        // A thread of the feed whose project has no folder here (another remote name, a
        // worktree) is no profile's: left out rather than shown in the first one.
        include: (folderKey, fromList) => !profiles || (folderKey === null ? fromList : profileOf(profiles, folderKey) === profile),
      });
      // As shown: a bot's name without its marker; screenshot mode's stand-ins. A row is a
      // bot as in the sidebar (bots.js classifyBots): by its marker, or chosen (by hand, or
      // every thread by default), when bots are on.
      for (const group of groups) {
        for (const row of group.rows) {
          const marked = parseBotTitle(row.title, DEFAULT_BOT_MARKER);
          row.bot = sidebar.bots ? (marked ?? ((state.manualBots[row.key] ?? sidebar.botsDefault) && row.title ? { label: row.title } : null)) : null;
          const title = marked ? marked.label : row.title;
          row.title = demoOn() ? demo.label(marked ? "bot" : "title", title || row.key) : title;
          if (demoOn() && row.project) row.project = demo.label("project", row.project);
        }
      }
      // Its bots T3's list does not show, those drawn (a folded group's rows are not): dealt
      // their shapes with the list's before they are drawn, in the style they are drawn in
      // (a copy for the next profile may draw in one never dealt yet). Dealt already, the
      // same keys again cost nothing (botArt.js).
      bots = groups.flatMap((g) => (state.view.collapsed[g.id] ? [] : g.rows.filter((r) => r.bot && !r.fromList).map((r) => r.key)));
      assignBotShapes(state.bots.map((b) => b.key).concat(bots));
      const now = Date.now();
      // Drawn again only when something shown changed (ages count by the minute); for a
      // face, whether its row is a bot (a marker added or removed changes no title shown).
      const shown = JSON.stringify([state.view.collapsed, sidebar.statusColors, sidebar.statusBadges, sidebar.botStyle, Math.floor(now / 60000), groups.map((g) => [g.id, g.rows.map((r) => [r.key, r.title, r.project, r.status, r.current, r.at, Boolean(r.bot), state.botPrefs[r.key] ?? null, state.knownBots[r.key]?.projectColor ?? null])])]);
      if (shown === signature) return false;
      signature = shown;
      view.update({ groups, collapsed: state.view.collapsed, now, word: (row) => (row.status === "done" || row.status === "idle" || row.status === "working" ? "" : STATUS_WORDS[row.status]) });
      return true;
    }
    return {
      draw,
      get bots() {
        return bots;
      },
      /** Drawn afresh by the next draw, its bots dealt again (out of the page, or back in it). */
      reset() {
        inputs = "";
        signature = "";
        bots = [];
      },
    };
  }
  const statusDraw = statusDrawing(statusView);

  // ---------- A profile switch over the Status view ----------
  // A switch slides the view as it slides T3's list (profiles.js setSlideView): the view on
  // screen goes out as it is, and a copy of it as the next profile shows it comes in (its
  // threads, in its own Status colors, badges and bot style). Landed, the view itself is
  // drawn for that profile in the same frame, just as its copy was.
  let statusHeld = false;
  const statusSlide = {
    element: () => (statusView.element.isConnected ? statusView.element : null),
    copyFor: statusCopy,
    hold() {
      statusHeld = true;
    },
    release() {
      statusHeld = false;
      if (!stopped) syncStatus();
    },
  };
  /** The Status view as profile `id` shows it (statusSlide), and redraw() for what changes while it slides. */
  function statusCopy(id) {
    let sidebar = null; // the settings it is drawn in, as drawn last
    const view = createStatusView(doc, { avatar: (el, row) => drawStatusFace(el, row, sidebar) });
    const drawing = statusDrawing(view);
    const redraw = () => {
      // As the view draws it once landed (drawnScope): on t3+'s Settings page that is the
      // scope edited there, whichever profile is open.
      sidebar = resolveSettings(state.base, state.scopes, settingsOpen() ? state.editScope : { profile: id, device: device ?? ALL }).sidebar;
      return Boolean(lastScan) && inBotStyle(sidebar.botStyle, () => drawing.draw(lastScan, id, sidebar));
    };
    redraw();
    return { element: view.element, redraw };
  }
  /** Runs `draw` with bots drawn (and dealt their shapes) in `style`; the style in use again after. */
  function inBotStyle(style, draw) {
    setBotStyle(style);
    try {
      return draw();
    } finally {
      setBotStyle(state.settings.sidebar.botStyle);
    }
  }

  function syncStatus() {
    const inner = lastInner?.isConnected ? lastInner : null;
    const footer = inner?.querySelector(T3_SELECTORS.sidebarFooter) ?? null;
    const on = state.view.view === "status";
    // The button: beside the profile dots, or on a row of its own.
    const bar = footer?.querySelector(":scope > .t3plus-profiles") ?? null;
    const home = bar ?? (footer ? statusToggleRow : null);
    if (home && statusToggle.parentElement !== home) home.append(statusToggle);
    if (!home) statusToggle.remove();
    if (!bar && footer) {
      if (statusToggleRow.parentElement !== footer || footer.firstElementChild !== statusToggleRow) footer.prepend(statusToggleRow);
    } else statusToggleRow.remove();
    if (statusToggle.getAttribute("aria-pressed") !== String(on)) statusToggle.setAttribute("aria-pressed", String(on));
    const scan = inner ? lastScan : null;
    const list = on && scan ? threadList(inner, scan) : null;
    // The view goes on or off screen (its button, another window): a switch sliding what
    // was there lands first. Left going, the copy of one kept sliding over the other.
    if (statusView.element.isConnected !== Boolean(list)) deps.profiles?.landNow?.();
    if (!list) {
      showT3List();
      if (statusView.element.isConnected) statusView.element.remove();
      statusDraw.reset();
      return;
    }
    if (hiddenList !== list) {
      showT3List();
      hiddenList = list;
      list.setAttribute("data-t3plus-status-hidden", "");
      list.setAttribute("inert", "");
    }
    // In the page again (shown again, or T3 remounted its sidebar with it inside): the
    // sprite clock let go of its faces while they were out of the page, and each face
    // drawn joins the clock again (bots.js applyAvatarVars), or a working one stayed on
    // one frame.
    if (!statusView.element.isConnected) statusDraw.reset();
    if (statusView.element.nextElementSibling !== list || statusView.element.parentElement !== list.parentElement) list.before(statusView.element);
    if (threadsFeedDue()) refreshThreadsFeed();
    // While a switch slides it, it goes out as it is (statusSlide).
    if (statusHeld) return;
    // The open profile's threads (all of them while profiles are off).
    statusDraw.draw(scan, profilesOn() && shownProfile ? shownProfile : null, state.settings.sidebar);
  }

  // The thread feed is read only while the view is on screen: on arrival, then every
  // couple of seconds (the loader publishes it when asked, from T3's database).
  const THREADS_FEED_MS = 2000;
  let threadsLoading = false;
  let threadsAt = -Infinity;
  // A little under the clock's tick, so each tick reads (timers run a little early or late).
  const threadsFeedDue = () => Boolean(deps.threadsFeed) && !threadsLoading && doc.visibilityState !== "hidden" && nowMs() - threadsAt > THREADS_FEED_MS - 200;
  async function refreshThreadsFeed() {
    threadsLoading = true;
    threadsAt = nowMs();
    try {
      // A failed read keeps the copy there is, as the other feeds do (the view's clock asks again).
      const next = await deps.threadsFeed.load().catch(() => null);
      if (!stopped && next) state.threadsFeed = next;
    } finally {
      threadsLoading = false;
    }
    if (!stopped) watcher.schedule();
  }
  let statusTimer = null;
  function followStatusClock() {
    // While the view shows: the feed's next read, and ages that grow without any change.
    const wanted = state.view.view === "status" && !stopped;
    if (wanted && statusTimer === null) statusTimer = win.setInterval(() => doc.visibilityState !== "hidden" && watcher.schedule(), THREADS_FEED_MS);
    else if (!wanted && statusTimer !== null) {
      win.clearInterval(statusTimer);
      statusTimer = null;
    }
  }

  // ---------- Composer lane ----------
  // T3 keeps the room for the details card or a preview window on the right
  // (--chat-lane-inset-end on the chat canvas) on the timeline and on the composer's
  // lane alike, so the composer always lines up with the messages above it. t3+
  // leaves that room alone: the composer is centered on the chat column, never on the
  // pane while the messages keep T3's room (it sat off to one side of them). The glow
  // follows the composer wherever T3 puts it.
  /** An earlier t3+ build gave the composer's lane its own room: taken off, so T3's layout holds. */
  function clearLaneOverrides() {
    for (const lane of doc.querySelectorAll(T3_SELECTORS.composerLane)) {
      lane.removeAttribute("data-t3plus-lane-slide");
      // Only the zero it wrote: T3 keeps its own room on the chat canvas, not on the lane.
      if (lane.style.getPropertyValue("--chat-lane-inset-end").trim() === "0px") lane.style.removeProperty("--chat-lane-inset-end");
    }
  }
  // While T3 slides the composer's lane (its draft-to-thread move when the first message is
  // sent, a Web Animation on the lane), nothing else changes in the DOM or in size: the
  // glow is moved every frame until the slide ends. The rect t3+ measures includes the
  // animation's transform, so measured once at its start the glow stayed where the
  // composer started.
  let laneFrame = null;
  const lanesAnimating = new Set(); // the slides followed, until each settles
  const lanesSeen = new WeakSet(); // every slide ever followed (one is never followed twice)
  function followLaneAnimations() {
    const running = doc.querySelector(T3_SELECTORS.composerLane)?.getAnimations?.().filter((a) => !lanesSeen.has(a) && (a.pending || a.playState === "running")) ?? [];
    for (const a of running) {
      lanesSeen.add(a);
      lanesAnimating.add(a);
      a.finished.catch(() => {}).finally(() => {
        lanesAnimating.delete(a);
        if (lanesAnimating.size || stopped) return;
        // The last one ended: one more placement where the composer stopped.
        stopFollowing();
        measureDue = true;
        timed("dither", () => syncDither(true));
      });
    }
    if (lanesAnimating.size && laneFrame === null) {
      const step = () => {
        laneFrame = null;
        if (stopped || !lanesAnimating.size) return;
        timed("dither", () => syncDither(true));
        if (laneFrame === null) laneFrame = win.requestAnimationFrame(step);
      };
      laneFrame = win.requestAnimationFrame?.(step) ?? null;
    }
  }
  function stopFollowing() {
    if (laneFrame !== null) win.cancelAnimationFrame?.(laneFrame);
    laneFrame = null;
  }

  let lastAnchor = null;
  let glowAt = null; // where the glow was last measured to go: { pane, paneRect, hero, cy, boxWidth }
  /** The pane's box, the composer's center across it and its width, and on the new-thread
   *  page (where the composer floats mid-pane) the height to center the glow at. */
  function measureGlow(pane, hero) {
    const anchor = measureBackdropAnchor(doc, pane);
    if (anchor) lastAnchor = anchor.percent;
    const paneRect = anchor?.hostRect ?? pane.getBoundingClientRect();
    // The message box sizes the glow. In a thread it is a sibling of the pane, not inside it.
    const box = hero?.overlay.querySelector(T3_SELECTORS.composerSurface) ?? null;
    const boxRect = box ? box.getBoundingClientRect() : (anchor?.composer ?? null);
    let cy = null;
    if (hero) {
      const c = box ? boxRect : hero.stack.getBoundingClientRect();
      if (paneRect.height > 0 && c.height > 0) cy = Math.max(0, Math.min(1.2, (c.top + c.height * 0.9 - paneRect.top) / paneRect.height)); // around the composer
    }
    return { pane, paneRect, hero: Boolean(hero), cy, boxWidth: boxRect ? boxRect.width : 0 };
  }
  /** Feeds the canvas dither renderer: the conversation pane, or the Settings preview on the
   *  Appearance page. `measure`: something may have moved the pane or the composer (else what
   *  was measured last is used: a check for the sidebar alone reads no layout). */
  function syncDither(measure = true) {
    const renderer = deps.backdropRenderer;
    if (!renderer) return;
    const look = state.settings;
    const g = look.composerGradient;
    const theme = computeComposerTheme(look, state.imageUrl, sampleLightUrl(look));
    const preview = panel.element.isConnected ? panel.element.querySelector(".t3plus-preview-pane") : null;
    // With t3+'s settings open, the live preview is what is on screen: T3 keeps the
    // last thread rendered behind its Settings, and drawn into that pane instead, the
    // preview only ever showed the CSS look (no Grain, Spectrum or pixel size).
    const pane = preview && SETTINGS_ROUTE.test(routePath()) ? null : (doc.querySelector(T3_SELECTORS.conversationArea) ?? doc.querySelector(`[${T3PLUS.backdropHostAttr}]`));
    // On the new-thread page every check places the composer (syncHome): measured each time.
    const hero = pane ? findHero() : null;
    if (!pane) glowAt = null;
    else if (measure || hero || glowAt?.pane !== pane || Boolean(glowAt?.hero) !== Boolean(hero)) {
      glowAt = measureGlow(pane, hero);
      followLaneAnimations();
    }
    // The composer's center across the pane, for the CSS gradient (no dither): on the pane
    // itself (on <html> every change restyled the whole page), and only while the CSS glow
    // is shown (an inherited property written every frame of a slide restyles the whole
    // timeline below the pane). That is the Smooth look, or the dithered look while its
    // render is missing or failed (the CSS fallback shows then, and must sit under the
    // composer too).
    const fallbackShown = !g.dither || !doc.documentElement.hasAttribute("data-t3plus-dithered");
    if (pane && g.enabled && fallbackShown && Number.isFinite(lastAnchor)) {
      const value = `${lastAnchor.toFixed(2)}%`;
      if (pane.style.getPropertyValue("--t3plus-composer-x") !== value) pane.style.setProperty("--t3plus-composer-x", value);
    }
    syncProfilePreview();
    const size = glowSize(pane);
    renderer.update({
      mode: g.dither ? theme.mode : null,
      settings: look,
      imageSrc: g.imageSource === "upload" && state.image ? state.image.dataUrl : assetUrl(SAMPLE_IMAGE_PATH),
      // The sample has a version for light pages (the renderer picks it there); an upload is shown as it is.
      imageSrcLight: g.imageSource === "upload" && state.image ? null : assetUrl(SAMPLE_IMAGE_LIGHT_PATH) || null,
      host: pane ?? preview,
      ...size,
      cy: glowAt?.cy ?? null,
      wide: Boolean(glowAt?.hero),
    });
    noteGlowSize(size);
  }
  /** The pane's size as the glow is drawn at it: its box, the composer's center across it
   *  (0..1) and the message box's width (renderer update() and warm()). */
  const glowSize = (pane) => ({
    hostRect: glowAt?.paneRect ?? null,
    cx: pane && Number.isFinite(lastAnchor) ? lastAnchor / 100 : 0.5,
    composerWidth: glowAt?.boxWidth ?? 0,
  });

  // ---------- Warming the other profiles' glows ----------
  // The first switch to a profile whose glow differs from every render kept drew it as the
  // switch landed (15-30 ms of canvas work then). While the page is idle, the other
  // profiles' glows are drawn ahead at the pane's size now (backdropRenderer.js warm), so
  // even a first switch finds its render. Asked for a little after start and again after
  // the pane's size, the theme or a look changes: each ask starts over, so a slider dragged
  // or a window resized warms once, when it has settled.
  const WARM_AFTER_MS = 1000;
  // No warming while a switch slides (or follows the fingers) or a project is dragged to a
  // dot (profiles.js busy): it would be main-thread work in the middle of the switch.
  let warmTimer = null;
  let cancelIdle = null;
  let warmRound = 0; // a new round (or stop()) ends the one under way
  let warmedSize = "";
  /** Warms the other profiles' glows once the page has been quiet a moment. */
  function warmSoon() {
    if (stopped || !deps.backdropRenderer?.warm) return;
    stopWarm();
    const round = warmRound;
    warmTimer = win.setTimeout(() => {
      warmTimer = null;
      warmNext(round, null);
    }, WARM_AFTER_MS);
  }
  function stopWarm() {
    warmRound += 1;
    if (warmTimer !== null) win.clearTimeout(warmTimer);
    warmTimer = null;
    cancelIdle?.();
    cancelIdle = null;
  }
  /** Runs `fn` when the page is idle (requestIdleCallback; a short timer where there is none). Returns its cancel. */
  function whenIdle(fn) {
    if (typeof win.requestIdleCallback === "function") {
      const id = win.requestIdleCallback(fn);
      return () => win.cancelIdleCallback?.(id);
    }
    const id = win.setTimeout(fn, 50);
    return () => win.clearTimeout(id);
  }
  /**
   * One glow per idle moment: `looks` (null: read at the first) are the ones still to warm.
   * A switch sliding, or a render of the page's own under way, waits for the next round.
   */
  function warmNext(round, looks) {
    cancelIdle = whenIdle(async () => {
      cancelIdle = null;
      const idle = () => round === warmRound && !deps.profiles?.busy?.();
      if (!idle()) {
        if (round === warmRound) warmSoon();
        return;
      }
      if (!glowAt) return; // no pane (t3+'s Settings, Usage): warmed again on the way back
      const queue = looks ?? otherProfileGlows();
      while (queue.length) {
        const result = await deps.backdropRenderer.warm(queue[0], glowSize(glowAt.pane), { idle });
        if (round !== warmRound) return;
        if (result === "busy") return warmSoon();
        queue.shift();
        if (result === "drawn") return warmNext(round, queue);
      }
    });
  }
  /** The settings of each profile not on screen, as they would draw here: only those with
   *  the dither glow (an image look decodes its image, and the renderer keeps the one shown
   *  decoded; the Smooth look is CSS). The renderer skips glows it has kept already. */
  function otherProfileGlows() {
    if (!profilesOn()) return [];
    return deps.profiles.state.list
      .filter((p) => p.id !== shownProfile)
      .map((p) => resolveSettings(state.base, state.scopes, { profile: p.id, device: device ?? ALL }))
      .filter(({ composerGradient: g }) => g.enabled && g.dither && g.mode === "half-circle");
  }
  /** The glow drawn at a new pane size: the other profiles' glows are warmed at it too. */
  function noteGlowSize({ hostRect, cx, composerWidth }) {
    const key = hostRect ? `${hostRect.width}x${hostRect.height}|${cx}|${composerWidth}` : "";
    if (key === warmedSize) return;
    warmedSize = key;
    if (key) warmSoon();
  }

  /** The Profiles preview in Settings: its own glow, in the glow color of the profile picked there. */
  function syncProfilePreview() {
    const renderer = deps.previewRenderer;
    if (!renderer) return;
    const host = panel.element.isConnected && SETTINGS_ROUTE.test(routePath()) ? panel.element.querySelector(".t3plus-pp-pane") : null;
    const g = state.settings.composerGradient;
    const accent = panel.profilePreviewAccent?.() ?? g.accent;
    renderer.update({
      // The glow only (an image keeps its own colors): the preview shows its CSS glow otherwise.
      mode: host && g.enabled && g.dither && g.mode !== "image" ? "half-circle" : null,
      settings: { ...state.settings, composerGradient: { ...g, accent } },
      host,
      cx: 0.5,
    });
  }

  // ---------- Bot hover cards ----------

  function syncHoverCards({ fromPopup = false } = {}) {
    if (state.settings.sidebar.bots && state.bots.length) {
      const byTitle = new Map(demoBots(state.bots).map((b) => [b.thread.title.trim(), b]));
      decorateBotHoverCards(doc, byTitle, paintedPrefs(state.bots), demo.active ? demo.realText : null);
      relabelBotTooltips(doc, byTitle);
    }
    // Screenshot mode covers popups as they open, bots or not (hover cards, ⌘K).
    // In a full check syncDemo covers them anyway: once is enough.
    if (fromPopup) demo.applyPopups();
  }

  // T3's hover card is a tooltip popup portaled to a direct child of <body>.
  // Small observers decorate it right away, in the same task: T3 mounts the
  // popup during a frame's rendering, so waiting for the next animation frame
  // showed its raw title for one frame. This touches only the popup's few
  // elements, never the app. They watch only <body>'s own children and,
  // inside each portal, its subtree, never the app root, so streaming chat
  // text costs nothing here.
  let popupObserver = null;
  let portalObserver = null;
  const syncHoverCardsSoon = () => syncHoverCards({ fromPopup: true });
  function watchPopups() {
    const body = doc.body;
    // No <body> yet (the Chrome script runs at document_start): the next check tries again.
    if (!body || popupObserver) return;
    const watched = new WeakSet();
    portalObserver = new win.MutationObserver(() => syncHoverCardsSoon());
    const watchPortals = () => {
      for (const el of body.children) {
        if (watched.has(el)) continue;
        watched.add(el);
        // The app root and t3+'s own nodes are not popups.
        if (el.id === T3_SELECTORS.appRootId || el.hasAttribute(T3PLUS.ownedAttr) || el.querySelector(`[data-workspace-area], ${T3_SELECTORS.sidebarWrapper}`)) continue;
        portalObserver.observe(el, { childList: true, subtree: true, characterData: true });
      }
    };
    popupObserver = new win.MutationObserver(() => {
      watchPortals();
      syncHoverCardsSoon();
    });
    popupObserver.observe(body, { childList: true });
    watchPortals();
  }

  // ---------- Home widgets (new-thread page) ----------

  /** The charts' pixel size (CSS px): the backdrop's dither cell. */
  const ditherCell = () => DITHER_CELL_CSS[state.settings.composerGradient.ditherSize] ?? DITHER_CELL_CSS.medium;

  /** T3's draft hero: the composer overlay is centered (items-center) instead of docked at the bottom. */
  function findHero() {
    const overlay = doc.querySelector(T3_SELECTORS.composerOverlay);
    if (!overlay || !overlay.classList.contains(T3_CLASSES.centered)) return null;
    const stack = overlay.querySelector(T3_SELECTORS.composerStack);
    return stack ? { overlay, stack } : null;
  }

  // The hero's measurements are plain inline sizes on two elements: T3's
  // composer overlay (its padding-top) and t3+'s own widget grid (width and
  // max-height). As custom properties (on <html>, then on the overlay) they
  // were inherited by every element below, and each change restyled all of
  // them: the overlay alone holds about 650, four times per visit.
  let heroOverlay = null;
  function clearHeroVars() {
    heroOverlay?.style.removeProperty("padding-top");
    heroOverlay?.removeAttribute(T3PLUS.heroAttr);
    heroOverlay = null;
  }
  /** Off the new-thread page: t3+'s hero layout goes at once (also from the overlay's
   *  class watch, the moment T3 docks the composer), the attribute first. */
  function leaveHero() {
    doc.documentElement.removeAttribute(T3PLUS.homeAttr);
    clearHeroVars();
    // T3 often drops the cards itself (navigation re-renders the overlay), so the
    // tooltip is hidden whether or not they were still in the page.
    if (home.element.isConnected) home.element.remove();
    home.hide();
  }
  const setInline = (el, name, value) => {
    if (el.style.getPropertyValue(name) !== value) el.style.setProperty(name, value);
  };

  /**
   * The Needs You card's rows: the Status view's "Needs you" group (T3's rows over the
   * thread feed), for the open profile, named as the sidebar names them (a bot without its
   * marker, screenshot mode's stand-ins). Null when there is nothing to build it from yet.
   */
  function needsForHome() {
    const scan = lastScan;
    if (threadsFeedDue()) refreshThreadsFeed();
    if (!scan && !state.threadsFeed) return null;
    const folderTitles = new Map([...(scan?.folders ?? [])].map(([key, { row }]) => [key, ((demo.active ? demo.realText(folderName(row)) : folderName(row).textContent) ?? "").trim()]));
    const profile = scan && profilesOn() && shownProfile ? shownProfile : null;
    const profiles = profile ? deps.profiles.state : null;
    const groups = buildStatusModel({
      scan,
      feed: state.threadsFeed,
      folderTitles,
      include: (folderKey, fromList) => !profiles || (folderKey === null ? fromList : profileOf(profiles, folderKey) === profile),
    });
    const now = Date.now();
    const rows = (groups.find((g) => g.id === "needs")?.rows ?? []).slice(0, 20).map((r) => {
      const marked = parseBotTitle(r.title, DEFAULT_BOT_MARKER);
      const title = marked ? marked.label : r.title;
      return {
        key: r.key,
        status: r.status,
        word: STATUS_WORDS[r.status],
        title: demoOn() ? demo.label(marked ? "bot" : "title", title || r.key) : title,
        project: demoOn() && r.project ? demo.label("project", r.project) : r.project,
        ago: ago(r.at, now),
      };
    });
    return { rows };
  }

  function syncHome() {
    // Without a feed (a build with no feed folder) the cards could only ever wait, and
    // T3's own usage rows, which they replace, stay as T3 draws them.
    // Every card turned off (Settings → t3+ → Widgets) is the same as the widgets off.
    const widgets = Boolean(state.settings.home.widgets && showsAnyCard(state.settings.home) && deps.homeFeed);
    // Whether the widgets are on at all, whatever the page: content.css centers any
    // new-thread composer by it together with T3's own hero class, so the centering comes
    // and goes in the same style pass as T3's layout (no frame with T3's room on a hero,
    // or t3+'s zero on a thread).
    if (doc.documentElement.hasAttribute(T3PLUS.widgetsAttr) !== widgets) doc.documentElement.toggleAttribute(T3PLUS.widgetsAttr, widgets);
    const hero = widgets ? findHero() : null;
    if (!hero) {
      leaveHero();
      return;
    }
    if (heroOverlay !== hero.overlay) {
      clearHeroVars();
      heroOverlay = hero.overlay;
      heroOverlay.setAttribute(T3PLUS.heroAttr, "");
    }
    if (home.element.parentElement !== hero.stack) hero.stack.append(home.element);
    if (!doc.documentElement.hasAttribute(T3PLUS.homeAttr)) doc.documentElement.setAttribute(T3PLUS.homeAttr, "");
    // Filled before measuring: placed while still empty, the block moved again
    // once the cards arrived.
    home.update({
      feed: state.homeFeed,
      cell: ditherCell(),
      show: state.settings.home,
      needs: state.settings.home.needsYou !== false ? needsForHome() : null,
      // Screenshot mode covers project names on the Projects card as it does in the sidebar.
      projectLabel: demoOn() ? (title) => demo.label("project", title) : null,
    });
    // The cards are exactly as wide as the composer: content.css hangs them from its stack
    // (left and right 0), so no width is measured or written (a width written in the check
    // lagged a frame behind a resize, and came out narrower on a narrow window).
    const pane = doc.querySelector(T3_SELECTORS.conversationArea) ?? hero.overlay;
    const p = pane.getBoundingClientRect();
    const s = hero.stack.getBoundingClientRect();
    // Place the whole hero block (headline, composer, widgets) a little above
    // the pane's middle: 35% of the spare height above it, 65% below. That is
    // close to T3's own spot on a laptop screen and scales with taller ones;
    // the widgets stay clear of the bottom edge.
    // T3's banners (a usage-limit fallback, an upload error) hang below the new-thread
    // composer, right where the widgets sit: the widgets start below them.
    let banners = 0;
    for (const b of hero.overlay.querySelectorAll(T3_SELECTORS.composerBanner)) {
      const r = b.getBoundingClientRect();
      if (r.height > 0 && r.top >= s.bottom - 4) banners = Math.max(banners, r.bottom - s.bottom);
    }
    // A custom property, not top itself: browsers rewrite a calc() they hand back,
    // so comparing it would rewrite the style on every check.
    setInline(home.element, "--t3plus-banner-h", banners > 0 ? `${Math.round(banners)}px` : "");
    const overlayHeight = hero.overlay.clientHeight;
    if (overlayHeight > 0) {
      const above = [...doc.querySelectorAll(T3_SELECTORS.heroHeadline)].find((el) => el.parentElement === hero.stack)?.offsetHeight ?? 84;
      const free = overlayHeight - (above + s.height + 16 + banners + home.element.scrollHeight);
      const top = Math.max(24, Math.min(free - 24, free * 0.35));
      setInline(hero.overlay, "padding-top", `${Math.round(top + above)}px`);
    }
    // Measured again: the hero offset just set moves the stack, and the room under it
    // (from the rectangle taken before) would stay wrong until some later check.
    const placed = hero.stack.getBoundingClientRect();
    if (p.height > 0) setInline(home.element, "max-height", `${Math.round(Math.max(160, p.top + p.height - placed.top - placed.height - banners - 40))}px`);
    // Fetched only while the widgets are on screen: on arrival when the copy is
    // older than one poll, then every poll while they stay.
    if (homeFeedDue()) refreshHomeFeed();
  }

  // ---------- Layout changes ----------
  // A pane or composer that changes size without a DOM change (the sidebar or a
  // panel opening, the terminal drawer, a window resize, the composer growing)
  // moves the glow right in the ResizeObserver callback: after layout, before
  // paint, so it follows in the same frame. Without it, nothing noticed, and
  // the glow stayed where the composer had been. Only the glow, t3+'s own
  // contained layer, changes there; anything that could resize T3's elements
  // (the new-thread page's placement) waits for the check in the next frame,
  // or T3's own ResizeObservers would report a loop.
  let layoutObserver = null;
  const layoutWatched = new Set();
  // The pane's and the composers' sizes last reported (the glow moves with the pane's box
  // and a composer's width; a composer's height matters on the new-thread page only).
  const layoutSizes = new WeakMap();
  // Whether something may have moved the pane, the composer or what is beside it since
  // they were last measured: the observers here, a resize, a setting, a route, or a change
  // in the page outside the sidebar. A check for the sidebar alone (a profile switch's
  // slide, its rows and their faces) measures nothing: each read there forced a style
  // recalc and layout of the page in the middle of the slide.
  let measureDue = true;
  const moved = () => {
    measureDue = true;
    watcher.schedule();
  };
  // T3 keeps the composer's room (--chat-lane-inset-end on the chat canvas) inline on the
  // canvas, and says whether the composer is the new-thread hero by its overlay's class.
  // Both change without adding or resizing anything else t3+ watches, so they are watched
  // here, and acted on in the observer's own callback: right after T3's commit and before
  // the frame is painted (T3 may commit inside its own ResizeObserver, after t3+'s frame
  // check), so the glow never shows a frame beside the composer, and the hero's layout is
  // gone the moment T3 docks the composer.
  let styleObserver = null;
  const styleWatched = new Set();
  function onLaneStyle(records) {
    let canvasMoved = false;
    for (const { target } of records) {
      if (target === heroOverlay && !target.classList.contains(T3_CLASSES.centered)) leaveHero();
      else if (target.matches?.(T3_SELECTORS.chatCanvas)) canvasMoved = true;
    }
    if (canvasMoved && !stopped) timed("dither", () => syncDither(true));
    moved();
  }
  function watchLaneStyles() {
    const MO = win.MutationObserver;
    if (!MO) return;
    const canvases = [...doc.querySelectorAll(T3_SELECTORS.chatCanvas)];
    // The composer overlay's class says whether this is the new-thread hero
    // (items-center). Only its class: t3+ writes the overlay's own padding.
    const overlays = [...doc.querySelectorAll(T3_SELECTORS.composerOverlay)];
    const wanted = new Set([...canvases, ...overlays]);
    if (wanted.size === styleWatched.size && [...wanted].every((el) => styleWatched.has(el))) return;
    styleObserver?.disconnect();
    measureDue = true; // something new to measure
    styleObserver = new MO(onLaneStyle);
    for (const el of canvases) styleObserver.observe(el, { attributes: true, attributeFilter: ["style", "class"] });
    for (const el of overlays) if (!canvases.includes(el)) styleObserver.observe(el, { attributes: true, attributeFilter: ["class"] });
    styleWatched.clear();
    for (const el of wanted) styleWatched.add(el);
  }
  function watchLayout() {
    watchLaneStyles();
    const RO = win.ResizeObserver;
    if (!RO) return;

    const wanted = new Set();
    const pane = doc.querySelector(T3_SELECTORS.conversationArea) ?? doc.querySelector(`[${T3PLUS.backdropHostAttr}]`);
    if (pane) wanted.add(pane);
    // The pane and the composer card, not the composer overlay: t3+ sets the
    // overlay's padding on the new-thread page, so watching it would report
    // t3+'s own change back (a ResizeObserver loop warning).
    for (const el of doc.querySelectorAll(T3_SELECTORS.composerSurface)) wanted.add(el);
    if (wanted.size === layoutWatched.size && [...wanted].every((el) => layoutWatched.has(el))) return;
    measureDue = true;
    layoutObserver ??= new RO((entries) => {
      measureDue = true;
      const glowMoves = entries.filter(movesGlow).length > 0; // (every entry's size noted)
      // Placing the glow is a few rect reads and one transform (renders stay debounced in
      // the renderer): done for every move, also in a storm of changes (a window or panel
      // dragged), where the throttled check alone left it 200 ms behind the composer.
      if (glowMoves) timed("dither", () => syncDither(true));
      watcher.schedule();
    });
    for (const el of layoutWatched) if (!wanted.has(el)) layoutObserver.unobserve(el);
    for (const el of wanted) if (!layoutWatched.has(el)) layoutObserver.observe(el, { box: "border-box" });
    layoutWatched.clear();
    for (const el of wanted) layoutWatched.add(el);
  }

  /** Whether a size the layout observer reports can move the glow: the pane's, or a
   *  composer's width (a composer growing a line taller moves nothing in a thread). */
  function movesGlow(entry) {
    const box = entry.borderBoxSize?.[0] ?? null;
    const was = layoutSizes.get(entry.target);
    if (!box) return true;
    layoutSizes.set(entry.target, box);
    if (!was || was.inlineSize !== box.inlineSize) return true;
    return was.blockSize !== box.blockSize && (!entry.target.matches(T3_SELECTORS.composerSurface) || findHero() !== null);
  }

  // ---------- Screenshot mode ----------
  // A read-only cover over T3's visible text (demoMode.js): stand-in thread
  // titles, projects, branches, machines, bot names and message
  // text. Off unless turned on in Settings -> t3+ (no shortcut: t3+'s keys are profiles').
  const demo = createDemoMode(doc);
  const demoOn = () => state.settings.demo.enabled;
  const demoBots = (bots) => (demoOn() ? bots.map((b) => ({ ...b, titleLabel: demo.label("bot", b.titleLabel || "Bot") })) : bots);
  let demoPrune = 0;
  function syncDemo() {
    const on = demoOn();
    // React updates streaming text in place, which only a characterData watch sees:
    // without it the reply being written showed its real text until some other change.
    watcher.watchTextChanges?.(on);
    doc.documentElement.toggleAttribute(T3PLUS.demoAttr, on);
    if (on) {
      demo.apply({ sidebarInner: findSidebarInner(doc) });
      if ((demoPrune += 1) % 50 === 0) demo.prune();
    } else if (demo.active) demo.restore();
  }
  // ---------- Thread details: the current provider's pool ----------
  // When T3's thread details show "Usage limits", t3+ replaces its rows with
  // the pool chart of the provider in the composer (Codex or Claude), the same
  // card as on the home page. On the new-thread page the section is hidden by
  // CSS, because the widgets below the composer already show both pools.
  function syncThreadDetails() {
    const card = doc.querySelector(T3_SELECTORS.threadDetailsCard);
    const section = card?.querySelector(T3_SELECTORS.threadDetailsUsage) ?? null;
    const picker = doc.querySelector(T3_SELECTORS.modelPicker);
    const kind = providerKind(picker?.getAttribute("aria-label") ?? picker?.textContent);
    const eligible = Boolean(section && kind && state.settings.home.widgets && !doc.documentElement.hasAttribute(T3PLUS.homeAttr));
    // The feed is fetched for the card even before there is one to show.
    if (eligible && homeFeedDue()) refreshHomeFeed();
    // T3's own rows are replaced only by a pool t3+ can draw: with no feed (a build
    // without one, a publish that keeps failing) or no limits for this provider,
    // T3's numbers stay instead of "Waiting for the home feed…".
    const show = eligible && hasPool(state.homeFeed, kind);
    for (const old of doc.querySelectorAll(`[${T3PLUS.detailsPoolAttr}]`)) {
      if (old !== section || !show) old.removeAttribute(T3PLUS.detailsPoolAttr);
    }
    // The pool changes the card's height: whether it reaches beside the composer is decided
    // again (t3+'s own nodes coming and going start no check of their own).
    if (!show) {
      if (detailsPool.element.isConnected) {
        detailsPool.element.remove();
        moved();
      }
      detailsPool.hide();
      return;
    }
    if (detailsPool.element.parentElement !== section || section.lastElementChild !== detailsPool.element) {
      const opening = !detailsPool.element.isConnected;
      section.append(detailsPool.element);
      moved();
      // Just opened: its spend comes from the bot feed, which may not have been read
      // for this thread (bots off, or no bots on screen).
      if (opening && nowMs() - botFeedAt > 10_000) refreshBotFeed();
    }
    if (section.getAttribute(T3PLUS.detailsPoolAttr) !== kind) section.setAttribute(T3PLUS.detailsPoolAttr, kind);
    if (detailsPool.update({ feed: state.homeFeed, kind, spend: threadSpend(state.botFeed, threadKeyFromPath(routePath()) ?? ""), cell: ditherCell() })) moved();
  }

  let homeLoading = false;
  let homeAgain = false;
  let lastHomeFetch = -Infinity;
  const nowMs = () => win.performance?.now?.() ?? Date.now();
  // With no copy yet (the first read, a build without a feed, a feed that keeps
  // failing), it is asked again at most this often. A read that brings a new feed ends
  // in a check, and a check that read again straight away was a loop of requests and checks.
  const HOME_FEED_RETRY_MS = 15_000;
  /** On arrival when the copy is older than one poll (or there is none), then every poll while it is on screen. */
  const homeFeedDue = () =>
    Boolean(deps.homeFeed) && !homeLoading && nowMs() - lastHomeFetch > (state.homeFeed ? HOME_FEED_POLL_MS : HOME_FEED_RETRY_MS);
  async function refreshHomeFeed() {
    if (!deps.homeFeed || !state.settings.home.widgets || stopped) return;
    // One read at a time. One asked for meanwhile (new files from the loader) runs
    // after it, so an older answer never lands over a newer one.
    if (homeLoading) {
      homeAgain = true;
      return;
    }
    homeLoading = true;
    let changed = false;
    try {
      do {
        homeAgain = false;
        lastHomeFetch = nowMs();
        const next = await deps.homeFeed.load().catch(() => null);
        // The same feed back (its text unchanged) is no news: nothing to draw.
        if (!next || next === state.homeFeed || stopped) continue;
        state.homeFeed = next;
        changed = true;
        // Settings' Widgets row offers only the cards with something to show.
        panelChanged();
      } while (homeAgain && !stopped);
    } finally {
      homeLoading = false;
    }
    if (changed) watcher.schedule();
  }


  // ---------- t3+ settings section ----------
  // An owned "t3+" entry after Appearance in T3's Settings sidebar. Opening it
  // is a view mode (see settingsSection.js); it closes on any T3 settings link
  // or when the path changes.
  const settingsNav = createSettingsNavItem(doc, () => {
    settingsOpenAt = routePath();
    settingsOpenHash = win.location.hash;
    checkDom();
    doc.querySelector(T3_SELECTORS.settingsPageScroll)?.scrollTo?.(0, 0);
  });
  let settingsOpenAt = null;
  // A T3 settings search result changes only the hash (#section) of the page under
  // t3+: that closes t3+ too, or the section it points to stayed hidden.
  let settingsOpenHash = "";
  let openedFromHash = false;
  // Asked to open (the update popup's Update): t3+'s page, once T3's Settings is drawn.
  let openWhenReady = false;
  function openT3plusSettings() {
    openWhenReady = true;
    if (!SETTINGS_ROUTE.test(routePath())) win.location.hash = "#/settings/general";
    checkDom();
  }
  function onSettingsClick(event) {
    const link = event.target?.closest?.("[data-settings-section]");
    if (!link || link.hasAttribute(T3PLUS.ownedAttr) || settingsOpenAt === null) return;
    settingsOpenAt = null;
    syncSettingsSection();
  }
  function syncSettingsSection() {
    const path = routePath();
    if (settingsOpenAt !== null && settingsOpenAt !== path) settingsOpenAt = null;
    const hash = win.location.hash;
    if (settingsOpenAt !== null && hash !== settingsOpenHash && hash !== "#t3plus") settingsOpenAt = null;
    const anchor = SETTINGS_ROUTE.test(path) ? findSettingsNavAnchor(doc) : null;
    // Opened from the toolbar icon (…/settings/appearance#t3plus): show t3+ once.
    if (anchor && !openedFromHash && win.location.hash === "#t3plus") {
      openedFromHash = true;
      settingsOpenAt = path;
      settingsOpenHash = hash;
    }
    if (anchor && openWhenReady) {
      openWhenReady = false;
      settingsOpenAt = path;
      settingsOpenHash = hash;
      win.requestAnimationFrame(() => doc.querySelector(T3_SELECTORS.settingsPageScroll)?.scrollTo?.(0, 0));
    }
    let container = null;
    if (anchor) {
      settingsNav.mount(anchor);
      if (settingsOpenAt !== null) container = findSettingsPage(doc);
    } else {
      // parentNode, not isConnected: React takes down only the top node of a route it
      // unmounts, so t3+'s entry can still sit in T3's detached nav. Left there, it would
      // keep that whole removed Settings tree alive.
      if (settingsNav.element.parentNode) settingsNav.element.remove();
      settingsOpenAt = null;
      // Older T3 without the settings nav hook: the panel stays under Appearance.
      container = findAppearanceContainer(doc, path);
    }
    const open = Boolean(anchor && container);
    settingsNav.setActive(open);
    doc.documentElement.toggleAttribute(T3PLUS.settingsAttr, open);
    markSettingsPage(open ? container : null);
    if (container) {
      // Put (back) on the page: drawn there again, and its faces (the bots' chips, the
      // preview's) join the sprite clock again, which let go of them while they were off it.
      if (!panel.element.isConnected) panelStale = true;
      ensurePanelMounted(container, panel.element);
    } else {
      // Leaving Settings (T3 may have taken the page down with the panel in it, which
      // leaves the panel a child of the detached page: parentNode, as for the entry).
      if (panel.element.parentNode) panel.element.remove();
      panel.leave();
    }
    if (panelStale && panel.element.isConnected) updatePanel();
    // The Widgets row says which cards have data: read the feed if it is due.
    if (container && homeFeedDue()) refreshHomeFeed();
  }

  // While t3+'s section is open, T3's sections in the page's column and the header's page
  // actions (they act on the T3 page underneath) are hidden (content.css). The two are
  // marked, so opening and closing restyle what is in them: hidden by a rule keyed on
  // <html> alone, each open and close restyled the whole page.
  const SETTINGS_HIDE = "data-t3plus-settings-hide";
  let settingsMarked = [];
  function markSettingsPage(column) {
    const next = column ? [[column, "sections"], [doc.querySelector(T3_SELECTORS.settingsHeaderActions), "actions"]].filter(([el]) => el) : [];
    for (const [el] of settingsMarked) if (!next.some(([other]) => other === el)) el.removeAttribute(SETTINGS_HIDE);
    for (const [el, what] of next) if (el.getAttribute(SETTINGS_HIDE) !== what) el.setAttribute(SETTINGS_HIDE, what);
    settingsMarked = next;
  }

  // Cost of the DOM checks, for tuning (window.__t3plusApp.perf in the desktop build).
  const perf = { checks: 0, ms: 0, max: 0, parts: {} };
  // Each step on its own: one that throws on some T3 markup it does not expect is
  // reported once and skipped, and the steps after it (screenshot mode's cover, the
  // health check that reports the breakage) still run.
  const failedSteps = new Set();
  const timed = (name, fn) => {
    const t0 = win.performance?.now?.() ?? 0;
    try {
      return fn();
    } catch (error) {
      if (!failedSteps.has(name)) {
        failedSteps.add(name);
        win.console?.error?.(`t3+: the ${name} step failed`, error);
      }
      return undefined;
    } finally {
      perf.parts[name] = (perf.parts[name] ?? 0) + ((win.performance?.now?.() ?? 0) - t0);
    }
  };
  function checkDom() {
    if (stopped) return;
    const started = win.performance?.now?.() ?? 0;
    try {
      checkDomNow();
    } finally {
      const dt = (win.performance?.now?.() ?? 0) - started;
      perf.checks += 1;
      perf.ms += dt;
      if (dt > perf.max) perf.max = dt;
    }
  }
  function checkDomNow() {
    // After the extension reloads, this old copy loses its chrome APIs. Bow out
    // so it does not fight the fresh copy over the panel.
    if (deps.isAlive && !deps.isAlive()) {
      api.stop();
      return;
    }
    if (!popupObserver) watchPopups();
    timed("settings", syncSettingsSection);
    const result = timed("composer", () => {
      const r = syncComposerSurfaces(doc, state.settings.glass.enabled, { countOrphans: !warnedOrphans });
      syncBackdropHosts(doc, state.settings.composerGradient.enabled);
      return r;
    });
    if (result?.orphanEditors > 0 && !warnedOrphans) {
      warnedOrphans = true;
      win.console?.warn?.("t3+: found a composer editor without T3's surface/body hooks. Update src/config.js selectors.");
    }
    // Sidebar rows that appear (a project folder opened, a new thread) are
    // decorated in the frame T3 adds them, before it is painted: checks run
    // on the next animation frame. (A MutationObserver that decorated them
    // right away ran between T3's own render steps while it switched threads,
    // and T3 had to redo its layout five or six times, about 100 ms.)
    timed("context", syncContext);
    timed("sidebar", syncSidebar);
    timed("profiles", () => deps.profiles?.sync(lastInner));
    timed("status", syncStatus);
    followStatusClock();
    timed("layout", watchLayout);
    const measure = measureDue;
    measureDue = false;
    // The hero first, then the glow: syncHome moves the new-thread composer, and
    // the glow is centered on where the composer ends up. Measured the other way
    // round, the glow kept the composer's old spot and sat too low behind the cards.
    timed("home", syncHome);
    timed("dither", () => syncDither(measure));
    timed("details", syncThreadDetails);
    // T3's chart is on its Usage page only: looked for there (and dropped once it is gone).
    timed("usage", () => usageDither.sync({ search: routePath() === USAGE_ROUTE, cell: ditherCell() }));
    timed("demo", syncDemo);
    timed("health", () => health.check());
  }

  // ---------- Settings ----------

  // Preview changes (slider drags, color picking) repaint without writing storage. Every
  // change is made in the scope Settings edits: values that can differ go to it, the
  // rest (profiles on or off, screenshot mode) to the base.
  function preview(update) {
    checkEditScope(); // never into a scope that is gone (a profile deleted in another window)
    const next = applyEdit(state, state.editScope, update);
    state.base = next.base;
    state.scopes = next.scopes;
    resolve();
    render();
  }
  const gradient = (patch) => (s) => ({ ...s, composerGradient: { ...s.composerGradient, ...patch } });
  const glass = (patch) => (s) => ({ ...s, glass: { ...s.glass, ...patch } });

  // ---------- Other windows ----------
  // Every T3 window shows the settings, their scopes and the sidebar's view, and writes
  // each of them whole. What another window changed is what its write's stamp says its
  // window set: only that is taken over, so what this window changed and has not saved
  // yet stays. This window's own saves coming back are no news. (Taken whole, and ignored
  // while this window was saving, another window's change could be missed here, and the
  // next save here undid it everywhere. Told apart by what they held, a write passed for
  // another holding the same, and a setting set back to what storage held was lost.)
  const isRecord = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);
  /** The leaves where `after` differs from `before`: [path, value] (undefined: gone). */
  function changedLeaves(before, after, path = [], out = []) {
    for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
      const a = before[key];
      const b = after[key];
      if (isRecord(a) || isRecord(b)) changedLeaves(isRecord(a) ? a : {}, isRecord(b) ? b : {}, [...path, key], out);
      else if (!Object.is(a, b)) out.push([[...path, key], b]);
    }
    return out;
  }
  /** `value` with those leaves set (removed for undefined), copying the objects on their way only. */
  function withLeaves(value, leaves) {
    const result = { ...value };
    for (const [path, leaf] of leaves) {
      let at = result;
      for (const key of path.slice(0, -1)) at = at[key] = { ...(isRecord(at[key]) ? at[key] : {}) };
      if (leaf === undefined) delete at[path.at(-1)];
      else at[path.at(-1)] = leaf;
    }
    return result;
  }
  /** The leaf of `value` at `path` (undefined: none). */
  const leafAt = (value, path) => path.reduce((at, key) => (isRecord(at) ? at[key] : undefined), value);
  // Each change storage reports names its write, the leaves its window set itself and the
  // write it landed on (settings.js createStampedStore). So every window knows the order the
  // writes landed in, and what each changed, even where two hold the same (a setting
  // switched off and back on, or set to what storage held). Chrome reports every change to
  // every window in that order. The desktop stub (inject/page-stub.js) reports a window's
  // own write at once, inside it, and another window's later, as a "storage" event: a write
  // here can be made before another window's change is heard, and land after it without it.
  // Its report then names that change as the write it landed on (windows sharing one copy of
  // localStorage), or that change's report, coming later, names a write from before this
  // one (windows with a copy each, a process each). Either way the change takes its place
  // when its report comes, and the window whose write left it out writes it again.
  /** What heard() found a reported change to be. */
  const HEARD = {
    nothing: null, // this window's own write coming back
    taken: "taken", // another window's change, now in state
    resave: "resave", // another window's change, now in state, that storage lacks: state is to be written again
  };
  /** `state[key]`, stored whole in `store` (`normalize`: as it is stored), kept in step with the other windows. */
  function storeSync(store, key, normalize) {
    // The latest writes, in the order they landed: { id, value, own: [path, leaf] of the leaves
    // its window set itself, mine: made here }. This window's own are placed as made; another
    // window's on the write it landed on, or first (on one from before them all).
    const landed = [];
    const LANDED_KEPT = 30;
    let floor = null; // what storage held before them (as read)
    // What every window comes to once it has heard those writes: the latest one's value, with
    // each one's own leaves over it in the order they landed (a later one's over an earlier
    // one's). Where state differs from it, the leaf is this window's own, not written yet.
    let agreed = null;
    let writes = Promise.resolve(); // one at a time: a write never lands before an earlier one
    const same = (a, b) => changedLeaves(a, b).length === 0;
    function agree() {
      if (landed.length > LANDED_KEPT) landed.shift();
      const latest = landed.at(-1)?.value ?? floor;
      agreed = normalize(landed.reduce((value, write) => withLeaves(value, write.own), latest));
    }
    /** Whether storage holds a write of this window's that lacks what was agreed since: to be written again. */
    const lacking = () => Boolean(landed.at(-1)?.mine) && !same(landed.at(-1).value, agreed);
    async function writeNow() {
      const value = normalize(state[key]);
      const own = changedLeaves(agreed, value);
      if (!own.length && !lacking()) return; // nothing new here, nothing storage lacks that this window is to write
      // Placed before it is made: the desktop stub reports it inside the write.
      const write = { id: newWriteId(), value, own, mine: true };
      landed.push(write);
      agree();
      try {
        await store.save(value, { id: write.id, own: own.map(([path]) => path) });
      } catch (error) {
        // Not written (storage full): its leaves are this window's own again, not written yet.
        const at = landed.indexOf(write);
        if (at >= 0) landed.splice(at, 1);
        agree();
        throw error;
      }
    }
    return {
      key,
      /** From state[key] as t3+ starts: as read, or as a change reported meanwhile left it. */
      begin() {
        floor = state[key];
        agree();
      },
      /** Writes state[key] as it is when its turn comes, after this window's earlier writes. */
      write() {
        const run = writes.then(writeNow);
        writes = run.catch(() => {});
        return run;
      },
      /**
       * A change storage reported, from `before` to `next` (`write`: its stamp): what it is here
       * (HEARD), another window's taken into state[key].
       */
      heard(next, before, write) {
        if (landed.some((w) => w.mine && w.id === write.id)) return HEARD.nothing;
        const pending = changedLeaves(agreed, state[key]);
        // Without a stamp (an import), or saved without its own leaves: all it changed.
        const own = write.own ? write.own.map((path) => [path, leafAt(next, path)]) : changedLeaves(before, next);
        landed.splice(landed.findLastIndex((w) => w.id === write.after) + 1, 0, { id: write.id, value: next, own, mine: false });
        agree();
        state[key] = normalize(withLeaves(agreed, pending));
        return lacking() ? HEARD.resave : HEARD.taken;
      },
    };
  }
  const settingsSync = storeSync(settingsStore, "base", normalizeSettings);
  const scopesSync = deps.scopesStore ? storeSync(deps.scopesStore, "scopes", normalizeScopes) : null;
  const viewSync = deps.viewStore ? storeSync(deps.viewStore, "view", normalizeViewState) : null;

  // Saves run one at a time and always write the latest local state, so quick
  // successive changes (toggle, then mode) cannot overwrite each other. Each store is
  // written only when it changed (each write echoes to every window).
  let saveQueue = Promise.resolve();
  async function writeStores() {
    await settingsSync.write();
    await scopesSync?.write();
  }
  function persist(update, message = "") {
    preview(update);
    return queueSave(message);
  }
  /** A change to the scopes themselves (a scope cleared, a profile's color from its dot). */
  function commitScopes(next, message = "") {
    if (next === state.scopes) return saveQueue;
    state.scopes = next;
    resolve();
    render();
    return queueSave(message);
  }
  /** `message`: what Settings says once it is saved (none: a save of another window's change, which says nothing). */
  function queueSave(message) {
    saveQueue = saveQueue
      .catch(() => {})
      .then(writeStores)
      .then(
        () => {
          if (message !== undefined) state.message = message;
        },
        // Said, not swallowed: this window shows the change, but a reload or another
        // window would not have it (screenshot mode off there, say).
        (error) => {
          state.message = `Could not save that change${error instanceof Error && error.message ? `: ${error.message}` : "."}`;
        },
      )
      .finally(render);
    return saveQueue;
  }

  /**
   * A backup's background image larger than this build stores (one from the Chrome
   * extension, imported in the desktop app) is shrunk the way an upload here would be.
   * Resolves to false when it could not be (it is left out), else true.
   */
  async function fitBackupImage(backup) {
    const image = backup?.data?.[STORAGE_KEYS.image];
    if (!deps.imageLimits || typeof image?.dataUrl !== "string" || image.dataUrl.length <= deps.imageLimits.maxStoredChars) return true;
    try {
      const record = await prepareImage(dataUrlToBlob(image.dataUrl), deps.imageLimits);
      backup.data[STORAGE_KEYS.image] = { ...record, name: image.name ?? record.name };
      return true;
    } catch {
      delete backup.data[STORAGE_KEYS.image];
      return false;
    }
  }

  const actions = {
    // The update card: hidden until the next release.
    dismissUpdate: (latest) => deps.updates?.dismiss(latest),
    setEnabled: (enabled) => persist(gradient({ enabled })),
    setMode: (mode) => persist(gradient({ mode })),
    previewAccent: (accent) => preview(gradient({ accent })),
    // Profiles (Settings → t3+): a profile's icon or colors, and the turn its sky takes.
    updateProfile: (id, patch) => deps.profiles?.update(id, patch),
    profileSkyTurn: (value) => deps.profiles?.skyTurnFor?.(value) ?? null,
    previewProfile: () => watcher.schedule(),
    setAccent: (accent) => persist(gradient({ accent })),
    // Your messages' bubbles ("theme" or "#rrggbb"); a preview while a custom color is dragged.
    previewBubble: (bubble) => preview((s) => ({ ...s, chat: { ...s.chat, bubble } })),
    setBubble: (bubble) => persist((s) => ({ ...s, chat: { ...s.chat, bubble } })),
    previewIntensity: (intensity) => preview(gradient({ intensity })),
    setIntensity: (intensity) => persist(gradient({ intensity })),
    setDither: (dither) => persist(gradient({ dither })),
    setDitherSize: (ditherSize) => persist(gradient({ ditherSize })),
    setDitherStyle: (ditherStyle) => persist(gradient({ ditherStyle })),
    setLook: (look) => persist(gradient(look === "smooth" ? { dither: false } : { dither: true, ditherStyle: look })),
    useSample: () => persist(gradient({ imageSource: "sample" }), "Using the sample image."),
    setGlass: (enabled) => persist(glass({ enabled })),
    previewGlassStrength: (strength) => preview(glass({ strength })),
    setGlassStrength: (strength) => persist(glass({ strength })),
    setSidebarFeature: (name, on) => persist((s) => ({ ...s, sidebar: { ...s.sidebar, [name]: on } })),
    setHomeWidgets: (on) => persist((s) => ({ ...s, home: { ...s.home, widgets: on } })),
    /** One home card on or off (homeWidgets.js HOME_CARDS key). */
    setHomeCard: (key, on) => persist((s) => ({ ...s, home: { ...s.home, [key]: on } })),
    /** The home cards' order (a comma list of their keys), dragged on the home page or in Settings. */
    setHomeOrder: (order) => persist((s) => ({ ...s, home: { ...s.home, order } })),
    setDemo: (on) => persist((s) => ({ ...s, demo: { ...s.demo, enabled: on } })),
    async chooseImage(file) {
      state.message = "Preparing image…";
      render();
      try {
        const record = deps.imageLimits ? await prepareImage(file, deps.imageLimits) : await prepareImage(file);
        state.image = await imageStore.save(record);
        await persist(gradient({ imageSource: "upload" }), `Saved ${state.image.name} ${deps.desktop ? "on this computer" : "in this browser"}.`);
      } catch (error) {
        state.message = error instanceof Error ? error.message : "Could not use that image.";
        render();
      }
    },
    async removeImage() {
      await imageStore.remove();
      state.image = null;
      await persist(gradient({ imageSource: "sample" }), "Removed the uploaded image.");
    },
    async exportSettings() {
      if (!deps.backup) return;
      try {
        const data = await deps.backup.export();
        const blob = new win.Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
        const url = win.URL.createObjectURL(blob);
        const link = doc.createElement("a");
        link.href = url;
        // Today's date where the user is (en-CA is YYYY-MM-DD), not UTC's.
        link.download = `t3plus-settings-${new Date().toLocaleDateString("en-CA")}.json`;
        doc.body.append(link);
        link.click();
        link.remove();
        win.setTimeout(() => win.URL.revokeObjectURL(url), 5000);
        state.message = "Exported your t3+ settings.";
      } catch (error) {
        state.message = error instanceof Error ? error.message : "Could not export.";
      }
      render();
    },
    async importSettings(file) {
      if (!deps.backup) return;
      // Screenshot mode stays as it is, like on Reset: a backup made with it off
      // turned it off mid-recording, with real names on screen.
      const covered = demoOn();
      try {
        const backup = JSON.parse(await file.text());
        // A backup from before profiles' glow and bubble colors became their settings.
        const lifted = backup?.data && typeof backup.data === "object" ? deps.liftProfileColors?.(backup.data[STORAGE_KEYS.profiles], backup.data[STORAGE_KEYS.scopes]) : null;
        if (lifted) Object.assign(backup.data, { [STORAGE_KEYS.profiles]: lifted.profiles, [STORAGE_KEYS.scopes]: lifted.scopes });
        const saved = backup?.data?.[STORAGE_KEYS.settings];
        if (saved && typeof saved === "object") backup.data[STORAGE_KEYS.settings] = { ...saved, demo: { ...(saved.demo ?? {}), enabled: covered } };
        const shrunk = await fitBackupImage(backup);
        const { keys, skipped } = await deps.backup.import(backup);
        // The stores follow storage changes, so every open T3 tab updates by itself.
        // Screenshot mode: a backup's file name can be personal ("acme-client-backup.json").
        const left = shrunk === false || skipped.includes(STORAGE_KEYS.image) ? " The background image did not fit, so it was left out." : "";
        state.message = `Restored ${keys.length} saved setting${keys.length === 1 ? "" : "s"} from ${covered ? "the backup file" : file.name}.${left}`;
      } catch (error) {
        state.message = error instanceof SyntaxError ? "That file is not valid JSON." : error instanceof Error ? error.message : "Could not import.";
      }
      render();
    },
    // Settings -> Advanced -> Reset: the appearance (background and glass) only. Features
    // (bots, profiles, bot style, usage widgets, screenshot mode) stay as they are: the
    // button promises appearance only, and switching screenshot mode off by surprise
    // would show real names.
    // In the save queue like any change, on the latest local state: done on its own,
    // a change made while it loaded and saved was written, then lost on screen.
    // For All profiles on All devices: back to the defaults. For a scope: it follows the
    // wider ones again (its own background and glass values go).
    reset() {
      const scope = state.editScope;
      if (!isBaseScope(scope)) {
        return commitScopes(clearScopeValues(state.scopes, scope, SCOPED_PATHS.filter(isAppearancePath)), `${scopeName(scope)} has no appearance of its own now.`);
      }
      const d = defaultSettings();
      const kept = Object.values(state.scopes.overrides).some((values) => Object.keys(values).some(isAppearancePath));
      return persist((s) => ({ ...s, ...Object.fromEntries(APPEARANCE_GROUPS.map((group) => [group, d[group]])) }), kept ? "t3+ appearance reset. Profiles or machines with an appearance of their own keep it (pick one above to reset it)." : "t3+ appearance reset.");
    },

    // ---------- Scopes (the "Applying t3+ for … on …" bar) ----------
    /** Which profile and machine Settings edits ({ profile, device }, ALL for All). */
    setEditScope(scope) {
      const profiles = panelProfiles().map((p) => p.id);
      const devices = deviceList().map((d) => d.id);
      const profile = scope?.profile !== ALL && profiles.includes(scope?.profile) ? scope.profile : ALL;
      const machine = scope?.device !== ALL && devices.includes(scope?.device) ? scope.device : ALL;
      state.editScope = { profile, device: machine };
      resolve();
      render();
    },
    /** `paths` follow All profiles on All devices everywhere again: every scope's own values for them go. */
    clearEverywhere(paths) {
      let next = state.scopes;
      for (const key of Object.keys(next.overrides)) next = clearScopeValues(next, parseScopeKey(key), paths);
      return commitScopes(next, "That setting is the same for every profile and device now.");
    },
    /** The scope edited follows the wider ones again: for `paths`, or for everything. */
    clearScope(paths = null) {
      const scope = state.editScope;
      if (isBaseScope(scope)) return saveQueue;
      return commitScopes(clearScopeValues(state.scopes, scope, paths), paths ? "" : `${scopeName(scope)} has no settings of its own now.`);
    },

    // ---------- Bots ----------
    async updateBot(key, patch) {
      try {
        state.botPrefs = await botStore.update(key, patch);
        state.botMessage = "";
      } catch (error) {
        state.botMessage = error instanceof Error ? error.message : "Could not save that bot setting.";
      }
      render();
    },
    async toggleBot(key) {
      try {
        state.manualBots = await botStore.toggleManual(key, undefined, state.settings.sidebar.botsDefault);
        state.botMessage = "";
      } catch (error) {
        state.botMessage = error instanceof Error ? error.message : "Could not change that bot.";
      }
      render();
      watcher.flush();
    },
    async forgetBot(key) {
      const byDefault = state.settings.sidebar.botsDefault;
      try {
        // A choice to make it a bot goes with its settings; one that turned it off stays.
        if (state.manualBots[key] === true) state.manualBots = await botStore.toggleManual(key, byDefault, byDefault);
        state.botPrefs = await botStore.forget(key);
        const { [key]: _removed, ...rest } = state.knownBots;
        state.knownBots = rest;
        state.botMessage = "Forgot that bot's settings.";
      } catch (error) {
        state.botMessage = error instanceof Error ? error.message : "Could not forget that bot.";
      }
      render();
    },
  };

  // A newer t3+ release: a popup in the corner of the main screen, once per release.
  const updateToast = createUpdateToast(doc, {
    onOpen: (latest) => {
      deps.updates?.toastDone(latest);
      openT3plusSettings();
    },
    onClose: (latest) => deps.updates?.toastDone(latest),
  });
  const panel = createAppearancePanel(doc, actions, { desktop: Boolean(deps.desktop), version: deps.version ?? null });
  const home = createHomeView(doc, { onReorder: (order) => actions.setHomeOrder(order), onOpen: (key) => openThread(key) });
  const detailsPool = createHomeView(doc, { variant: "pool" });
  const usageDither = createUsageDither(doc);

  // Streaming chat text lands inside T3's message lists (a side chat in the right panel
  // has its own), which hold nothing t3+ decorates or measures: those mutations never
  // schedule a check. Nor do t3+'s own nodes coming and going (a profile switch's sliding
  // copy, the dots, a probe): each of those ran another full check with nothing of T3's
  // changed. A change to a list itself (one mounted or swapped) is no streaming.
  const owned = (node) => node.nodeType === 1 && node.hasAttribute(T3PLUS.ownedAttr);
  const inTimeline = (node) => {
    const el = node.nodeType === 1 ? node : node.parentElement;
    const list = el?.closest(T3_SELECTORS.messageList);
    return Boolean(list && list !== el);
  };
  const isNoise = (record) => {
    // Screenshot mode covers message text too: from the records themselves once its first
    // pass has run (onRecords below), until then in a full check.
    if (state.settings.demo.enabled && !demo.active) return false;
    if (inTimeline(record.target)) return true;
    if (record.target.closest?.(`[${T3PLUS.ownedAttr}]`)) return true;
    const nodes = [...record.addedNodes, ...record.removedNodes];
    return nodes.length > 0 && nodes.every(owned);
  };
  // A change in the page outside the sidebar may have moved the pane or the composer
  // (T3 drawing a thread, the details card loading): measured again at the next check.
  // A bot row T3 changed is decorated afresh (the others are left as they are).
  const followChanges = (records) => {
    noteBotRowChanges(records);
    if (measureDue) return;
    const inner = lastInner?.isConnected ? lastInner : null;
    if (!inner || records.some((record) => !inner.contains(record.target))) measureDue = true;
  };
  const tellLoader = (what, data) => {
    try {
      win.__t3plusTell?.(what, data);
    } catch {
      // no loader (the Chrome extension)
    }
  };
  const health = createHealth({
    win,
    doc,
    routePath,
    onChange: (problems) => {
      state.health = problems;
      tellLoader("health", { problems });
      render();
    },
  });
  const watcher = createDomWatcher({
    win,
    doc,
    check: checkDom,
    throttleMs: deps.throttleMs ?? DOM_CHECK_THROTTLE_MS,
    isNoise,
    onChange: followChanges,
    frames: deps.frameChecks ?? true,
    // While a storm holds the full check back, screenshot mode's cover still follows
    // every frame: a reply streaming in would otherwise show its real text between checks.
    quick: () => {
      if (!stopped && demoOn()) timed("demo", syncDemo);
    },
    // Screenshot mode: what React changed in a timeline (a streamed token, rows mounted as
    // it scrolls) is covered right here, before paint, without a full check for each.
    onRecords: (records) => {
      if (!stopped && demo.active) timed("demoRecords", () => demo.coverTimelineRecords(records));
    },
  });

  // ---------- Bot feed (latest message per bot) ----------
  // Driven by the bots themselves: a state change fetches right away (and once
  // more a little later, for a message that lands after the status flips). The
  // timer below only covers what that misses: every tick while a bot is busy
  // (messages arrive mid-run), and a slow refresh when all of them are quiet.
  const BOT_FEED_QUIET_MS = 5 * BOT_FEED_POLL_MS;
  let feedTimer = null;
  let botSignature = "";
  let botFeedAt = -Infinity;
  let botFeedQueue = [];
  function queueBotFeed() {
    if (!deps.botFeed) return;
    for (const t of botFeedQueue) win.clearTimeout(t);
    botFeedQueue = [1500, 12000].map((ms) => win.setTimeout(() => refreshBotFeed(), ms));
  }
  /** Something on screen reads the bot feed: bot rows, or the open thread's spend in its details. */
  const botFeedWanted = () => state.bots.length > 0 || detailsPool.element.isConnected;
  let botLoading = false;
  let botAgain = false;
  async function refreshBotFeed() {
    if (!deps.botFeed || stopped || (!state.settings.sidebar.bots && !detailsPool.element.isConnected)) return;
    // One read at a time, like the home feed: overlapping reads (a state change, the
    // poll, new files from the loader) could land out of order.
    if (botLoading) {
      botAgain = true;
      return;
    }
    botLoading = true;
    let changed = false;
    try {
      do {
        botAgain = false;
        botFeedAt = nowMs();
        const next = await deps.botFeed.load().catch(() => null);
        // A failed read keeps the last good copy; the same feed back (its text unchanged) is no news.
        if (stopped || (!next && state.botFeed) || next === state.botFeed) continue;
        state.botFeed = next;
        changed = true;
      } while (botAgain && !stopped);
    } finally {
      botLoading = false;
    }
    if (!changed || stopped) return;
    // What reads it: the bot rows and the open thread's spend (a check), and Settings' bot list.
    panelChanged();
    watcher.schedule();
  }

  const onVisibility = () => {
    if (doc.visibilityState !== "visible") return;
    if (botFeedWanted()) refreshBotFeed();
    if (findHero() || detailsPool.element.isConnected) refreshHomeFeed();
  };

  const api = {
    state,
    perf,
    /** The profile on screen changed (profiles.js onShown; one sliding in counts): its settings are drawn. */
    profileShown(id) {
      shownProfile = id ?? null;
      if (stopped) return;
      resolve();
      render();
    },
    /** A profile was deleted here: its settings go with it. */
    profileDeleted(id) {
      if (stopped || typeof id !== "string") return;
      let next = state.scopes;
      for (const key of Object.keys(next.overrides)) if (parseScopeKey(key)?.profile === id) next = clearScopeValues(next, parseScopeKey(key));
      if (state.editScope.profile === id) state.editScope = { ...state.editScope, profile: ALL };
      commitScopes(next);
    },
    /** A profile's own value for `path` (on All devices), or undefined: the dot's editor shows it. */
    scopedValue(profileId, path) {
      return scopeValues(state.scopes, { profile: profileId, device: ALL })[path];
    },
    /** Sets (or with null, clears) a profile's own value for `path` on All devices. */
    setScopedValue(profileId, path, value) {
      if (stopped || typeof profileId !== "string") return;
      const scope = { profile: profileId, device: ALL };
      commitScopes(value === null ? clearScopeValues(state.scopes, scope, [path]) : setScopeValues(state.base, state.scopes, scope, { [path]: value }));
    },
    /** Profiles loaded or changed (profiles.js onChange): the Settings card is brought up to date. */
    profilesChanged() {
      if (stopped) return;
      // A profile Settings edits deleted in another window: All, shown and edited.
      if (!isBaseScope(state.editScope)) {
        const was = scopeKey(state.editScope);
        checkEditScope();
        if (scopeKey(state.editScope) !== was) {
          resolve();
          render();
        }
      }
      panelChanged();
      warmSoon(); // a profile added, or the stored ones loaded: their glows are warmed
    },
    /** T3's native menu for a project folder is opening (desktop loader): t3+'s "Move to profile" submenu, or null. */
    projectMenu() {
      if (stopped || !state.settings.sidebar.profiles) return null;
      return deps.profiles?.projectMenu?.() ?? null;
    },
    /** A pick from that submenu (its item id). */
    projectMenuPick(itemId) {
      if (stopped || !state.settings.sidebar.profiles) return false;
      return deps.profiles?.projectMenuPick?.(itemId) ?? false;
    },
    /** The desktop loader's latest t3+ release (after its daily check). */
    updateInfo(info) {
      if (!stopped) deps.updates?.set(info);
    },
    /** A newer release came in, or its card was hidden: the popup, the card and the Settings entry's dot follow. */
    updateChanged() {
      if (stopped) return;
      settingsNav.setUpdate(Boolean(deps.updates?.pending));
      updateToast.show(deps.updates?.toastDue ?? null);
      panelChanged();
    },
    /**
     * The desktop loader handed over new copies of these feeds (`kinds`; every feed when it
     * does not say): those are read now, not at the next poll. Each read also asks the
     * loader for a fresh copy: one of a feed not handed over had it republish the bot feed
     * every few seconds while the Status view's feed came in.
     */
    feedsUpdated(kinds = null) {
      if (stopped) return;
      const handed = (kind) => !Array.isArray(kinds) || kinds.includes(kind);
      if (handed("bots") && botFeedWanted()) refreshBotFeed();
      if (handed("home") && (findHero() || detailsPool.element.isConnected)) refreshHomeFeed();
      if (handed("threads") && state.view.view === "status" && deps.threadsFeed && !threadsLoading) refreshThreadsFeed();
    },
    panel,
    watcher,
    actions,
    async start() {
      // Stopped before it started (a newer copy took over first): nothing to set up.
      if (stopped) return;
      // The backup mirror is the app's: however it is stopped (a newer copy, the extension
      // gone), its listener goes too, and a copy stopped first never starts one.
      if (deps.mirror) unsubscribers.push(deps.mirror());
      // A copy orphaned by an extension reload may have left its UI behind.
      doc.getElementById(panel.element.id)?.remove();
      for (const old of doc.querySelectorAll("[data-t3plus-settings-nav]")) old.closest("li")?.remove();
      doc.addEventListener("click", onSettingsClick, true);
      unsubscribers.push(() => doc.removeEventListener("click", onSettingsClick, true));
      // Every open T3 window follows the others' changes, from before they are read here:
      // one another window writes meanwhile (T3 opens its windows at once) is newer than
      // what was read.
      let reading = true;
      const early = {}; // state key -> the newest value reported while reading
      const follow = (key, apply) => (next, before, write) => {
        if (reading) early[key] = next;
        else apply(next, before, write);
      };
      const take = (key) =>
        follow(key, (next) => {
          state[key] = next;
          render();
        });
      // The settings, their scopes and the view: another window's change is taken in
      // (storeSync). Where a write of this window undid it in storage, or will when it
      // lands, the value is written again, with it.
      const merge = (sync, resave, show) =>
        follow(sync.key, (next, before, write) => {
          const heard = sync.heard(next, before, write);
          if (!heard) return;
          if (heard === HEARD.resave) resave();
          show();
        });
      const redraw = () => {
        resolve();
        render();
      };
      unsubscribers.push(
        settingsStore.subscribe(merge(settingsSync, () => queueSave(), redraw)),
        scopesSync ? deps.scopesStore.subscribe(merge(scopesSync, () => queueSave(), redraw)) : () => {},
        viewSync ? deps.viewStore.subscribe(merge(viewSync, () => viewSync.write().catch(() => {}), () => watcher.schedule())) : () => {},
        imageStore.subscribe(take("image")),
        botStore.subscribe(take("botPrefs")),
        botStore.subscribeManual?.(take("manualBots")) ?? (() => {}),
        botStore.subscribeKnown(take("knownBots")),
      );
      // The feeds' stored copies with the rest, in one round trip: each read waited on
      // before the profile filter could apply.
      const [base, scopes, view, image, botPrefs, knownBots, manualBots, botFeed, homeFeed] = await Promise.all([
        settingsStore.load(),
        deps.scopesStore?.load() ?? emptyScopes(),
        deps.viewStore?.load() ?? normalizeViewState(null),
        imageStore.load(),
        botStore.load(),
        botStore.loadKnown(),
        botStore.loadManual?.() ?? {},
        deps.botFeed?.readCache().catch(() => null) ?? null,
        deps.homeFeed?.readCache().catch(() => null) ?? null,
      ]);
      if (stopped) return; // stopped while loading (its subscriptions went with it)
      reading = false;
      Object.assign(state, { base, scopes, view, image, botPrefs, knownBots, manualBots, botFeed, homeFeed }, early);
      for (const sync of [settingsSync, scopesSync, viewSync]) sync?.begin();
      clearLaneOverrides();
      resolve();
      doc.addEventListener("visibilitychange", onVisibility);
      unsubscribers.push(() => doc.removeEventListener("visibilitychange", onVisibility));
      // The window (or its zoom) changed size: the glow is placed right here, in the frame's
      // resize steps, before it is laid out and painted (a check alone can come a frame
      // later, or 200 ms later while a drag keeps the page busy).
      const onResize = () => {
        if (!stopped) timed("dither", () => syncDither(true));
        moved();
      };
      win.addEventListener?.("resize", onResize, { passive: true });
      unsubscribers.push(() => win.removeEventListener?.("resize", onResize));
      if (deps.botFeed) {
        feedTimer = win.setInterval(() => {
          if (doc.visibilityState === "hidden" || !botFeedWanted()) return;
          const busy = state.bots.some((b) => b.status === "working" || b.status === "waiting" || b.status === "attention");
          if (busy || nowMs() - botFeedAt >= BOT_FEED_QUIET_MS) refreshBotFeed();
        }, BOT_FEED_POLL_MS);
        unsubscribers.push(() => win.clearInterval(feedTimer));
        refreshBotFeed();
      }
      if (deps.homeFeed) {
        const homeTimer = win.setInterval(() => {
          if (doc.visibilityState !== "hidden" && state.settings.home.widgets && (findHero() || detailsPool.element.isConnected)) refreshHomeFeed();
        }, HOME_FEED_POLL_MS);
        unsubscribers.push(() => win.clearInterval(homeTimer));
      }
      // A switch slides the Status view too, while it shows (statusSlide).
      deps.profiles?.setSlideView?.(statusSlide);
      deps.profiles?.start().catch(() => {});
      unsubscribers.push(() => {
        deps.profiles?.stop();
        deps.profiles?.setSlideView?.(null);
      });
      deps.whatsNew?.start().catch(() => {});
      unsubscribers.push(() => deps.whatsNew?.stop());
      if (deps.updates) {
        settingsNav.setUpdate(Boolean(deps.updates.pending));
        deps.updates.start().catch(() => {});
        unsubscribers.push(() => {
          deps.updates.stop();
          updateToast.show(null);
        });
      }
      watchPopups();
      // A T3 theme switch (light/dark, another palette) changes only <html>'s class and
      // theme attributes: the glow (and the Settings preview) take the new colors right
      // away, on every page, not at some later check.
      const themeObserver = new win.MutationObserver(() => {
        moved();
        warmSoon(); // the other profiles' glows in the new colors
      });
      themeObserver.observe(doc.documentElement, { attributes: true, attributeFilter: ["class", "data-theme", "data-theme-id"] });
      unsubscribers.push(() => themeObserver.disconnect());
      unsubscribers.push(() => {
        popupObserver?.disconnect();
        portalObserver?.disconnect();
      });
      watcher.start();
      tellLoader("health", { problems: health.problems });
      unsubscribers.push(() => health.stop());
      render();
    },
    stop() {
      stopped = true;
      stopWarm();
      watcher.stop();
      for (const t of botFeedQueue.splice(0)) win.clearTimeout(t);
      stopSprites();
      for (const unsubscribe of unsubscribers.splice(0)) unsubscribe();
      panel.element.remove();
      panel.leave();
      settingsNav.setActive(false); // the current settings page's entry's aria-current back, if t3+ had it
      settingsNav.element.remove();
      home.element.remove();
      home.destroy();
      detailsPool.element.remove();
      detailsPool.destroy();
      usageDither.clear();
      // The Status view: T3's list back, the view and its button gone.
      showT3List();
      statusView.destroy();
      statusToggle.remove();
      statusToggleRow.remove();
      followStatusClock();
      for (const el of doc.querySelectorAll(`[${T3PLUS.detailsPoolAttr}]`)) el.removeAttribute(T3PLUS.detailsPoolAttr);
      demo.restore();
      doc.documentElement.removeAttribute(T3PLUS.demoAttr);
      doc.documentElement.removeAttribute(T3PLUS.settingsAttr);
      markSettingsPage(null);
      doc.documentElement.removeAttribute(T3PLUS.homeAttr);
      doc.documentElement.removeAttribute(T3PLUS.widgetsAttr);
      clearBotDecoration(doc.documentElement);
      // T3's breadcrumb heading and any open hover card wear a bot face too.
      decorateBotBreadcrumb(doc, null);
      for (const el of doc.querySelectorAll("[data-t3plus-bot-hover], [data-t3plus-hover-raw]")) {
        clearAvatarVars(el);
        for (const name of ["data-t3plus-bot-hover", "data-t3plus-bot-hover-label", "data-t3plus-hover-raw"]) el.removeAttribute(name);
      }
      syncComposerSurfaces(doc, false);
      // Before the fallback host loses its tag, which is how it is found.
      for (const el of doc.querySelectorAll(`${T3_SELECTORS.conversationArea}, [${T3PLUS.backdropHostAttr}]`)) el.style.removeProperty("--t3plus-composer-x");
      syncBackdropHosts(doc, false);
      deps.backdropRenderer?.clear();
      deps.previewRenderer?.clear();
      const cleared = Object.keys(computeComposerTheme(state.settings, null).vars).map((name) => [name, null]);
      clearLaneOverrides();
      stopFollowing();
      lanesAnimating.clear();
      clearHeroVars();
      layoutObserver?.disconnect();
      layoutWatched.clear();
      styleObserver?.disconnect();
      styleWatched.clear();
      applyComposerTheme(doc, { mode: null, glass: false, vars: Object.fromEntries(cleared) });
      clearBubble(doc);
      dropLook(doc);
      if (objectUrl) win.URL.revokeObjectURL(objectUrl);
      objectUrl = null;
      objectUrlFor = null;
    },
  };
  return api;
}
