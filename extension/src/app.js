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
  knownBotTitle,
  relabelBotTooltips,
} from "./bots.js";
import { applyComposerTheme, measureBackdropAnchor, syncBackdropHosts, syncComposerSurfaces } from "./composer.js";
import { botMetaText, botPreviewText, botSubagents, threadIdFromKey, threadSpend } from "./botFeed.js";
import { BOT_FEED_POLL_MS, BOT_LIMITS, DEFAULT_BOT_MARKER, DOM_CHECK_THROTTLE_MS, HOME_FEED_POLL_MS, SAMPLE_IMAGE_PATH, STORAGE_KEYS, T3_CLASSES, T3_SELECTORS, T3PLUS } from "./config.js";
import { createHomeView } from "./homeWidgets.js";
import { createUsageDither } from "./usageDither.js";
import { createDemoMode } from "./demoMode.js";
import { poolModel, providerKind } from "./homeData.js";
import { createDomWatcher } from "./domWatcher.js";
import { computeComposerTheme } from "./gradient.js";
import { dataUrlToBlob, prepareImageFile } from "./imageStore.js";
import { defaultSettings } from "./settings.js";
import { findSidebarInner, scanSidebar, threadKeyFromPath } from "./sidebar.js";
import { threadProjectColor } from "./projectColor.js";
import { stopSprites } from "./spriteClock.js";
import { assignBotShapes, setBotStyle } from "./botArt.js";
import { createHealth } from "./health.js";

/**
 * Wires storage, the background/glass theme, the sidebar's bot rows,
 * the Appearance panel, and the DOM watcher. Everything browser-specific comes
 * in through `deps`, so tests can run this in jsdom.
 *
 * deps: {
 *   win, doc,
 *   settingsStore, imageStore,             settings.js / imageStore.js
 *   botStore,                              bots.js
 *   botFeed?,                              botFeed.js (latest message per bot, read-only)
 *   backdropRenderer?,                     backdropRenderer.js (canvas dither; omitted in jsdom tests)
 *   homeFeed?,                             homeData.js createHomeFeed (home widget data, read-only)
 *   assetUrl(path) -> string,              chrome.runtime.getURL in the extension
 *   prepareImage?(file, limits) -> record, defaults to prepareImageFile
 *   imageLimits?                           size caps for an uploaded image (the desktop build's are smaller)
 *   desktop?                               running in T3's desktop app (the loader), not the Chrome extension
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
    settings: defaultSettings(),
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

  // The Settings panel (a chip per bot) is brought up to date only while it is
  // on screen, and once when it is put there: with many bots, every render (a slider
  // step, a feed read, a storage echo) restyled thousands of detached swatches.
  let panelStale = true;
  function updatePanel() {
    panelStale = false;
    const profiles = deps.profiles?.state ?? null;
    panel.update({
      ...state,
      bots: botsForPanel(),
      botMarker: DEFAULT_BOT_MARKER,
      // Profiles (their icons and colors), when they are on.
      profiles: profiles && state.settings.sidebar.profiles && deps.profiles.isLoaded?.() ? { list: profiles.list, active: profiles.active, sky: Boolean(deps.profiles.hasSky?.()) } : null,
      ditherAccent: deps.profiles?.ditherAccent?.() ?? null,
    });
  }

  /** The settings as drawn: the open profile's dither color, when it has one, over the glow's. */
  function lookSettings() {
    const accent = state.settings.sidebar.profiles ? deps.profiles?.ditherAccent?.() : null;
    return accent ? { ...state.settings, composerGradient: { ...state.settings.composerGradient, accent } } : state.settings;
  }

  function render() {
    if (stopped) return;
    setBotStyle(state.settings.sidebar.botStyle);
    state.imageUrl = resolveImageUrl();
    applyComposerTheme(doc, computeComposerTheme(lookSettings(), state.imageUrl));
    // The glow's own color (Look), apart from a profile's override: the "Default" dither
    // swatches show it.
    const own = state.settings.composerGradient.accent;
    if (own === "theme") doc.documentElement.style.removeProperty("--t3plus-look-accent");
    else if (doc.documentElement.style.getPropertyValue("--t3plus-look-accent") !== own) doc.documentElement.style.setProperty("--t3plus-look-accent", own);
    if (panel.element.isConnected) updatePanel();
    else panelStale = true;
    watcher.schedule();
  }

  function rememberBots(bots) {
    let changed = false;
    const next = { ...state.knownBots };
    for (const bot of bots) {
      const known = next[bot.key];
      const title = knownBotTitle(bot.thread.title);
      // The project color is kept too, so Settings can draw the bot when its row is not on screen.
      if (known?.title !== title || (bot.projectColor && known?.projectColor !== bot.projectColor)) {
        next[bot.key] = { title, seenAt: Date.now(), ...(bot.projectColor ?? known?.projectColor ? { projectColor: bot.projectColor ?? known.projectColor } : {}) };
        changed = true;
      }
    }
    if (!changed) return;
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
    const signature = [openKey, ...bots.map((b) => `${b.key}|${b.status}|${b.statusLabel}`)].join("\n");
    if (signature === botSignature) return;
    botSignature = signature;
    // The desktop loader publishes the bot feed (latest message, subagents) for these threads.
    try {
      // The open thread too, bot or not: the details card shows its spend.
      // Most wanted first (the loader's feed has a cap): the open thread, then the bots top down.
      win.__t3plusTell?.("bots", { keys: [...new Set([...(openKey ? [openKey] : []), ...bots.map((b) => b.key)])] });
    } catch {
      // no loader (the Chrome extension)
    }
    // The open thread's spend (thread details) comes from the same feed, bots or not.
    if (bots.length || openKey) queueBotFeed();
  }

  function syncBreadcrumb(shown) {
    const routeKey = threadKeyFromPath(routePath());
    const activeBot = state.settings.sidebar.bots ? (shown.find((bot) => bot.key === routeKey) ?? null) : null;
    decorateBotBreadcrumb(doc, activeBot ? { ...activeBot, prefs: state.botPrefs[activeBot.key] } : null);
  }

  function syncSidebar() {
    const inner = findSidebarInner(doc);
    if (!inner) {
      // No sidebar list on screen (closed and unmounted, or a layout t3+ does not
      // know): the breadcrumb still follows the open thread, from the bots seen
      // last (T3 reuses its heading, which kept the previous bot's name and face),
      // and the loader still hears which thread is open.
      followBots(state.bots);
      syncBreadcrumb(demoBots(state.bots));
      return;
    }
    // Screenshot mode reads titles through its stand-ins, as T3 wrote them.
    const scan = scanSidebar(inner, demo.active ? { textOf: demo.realText } : {});
    const { sidebar } = state.settings;

    const bots = sidebar.bots ? classifyBots(scan, DEFAULT_BOT_MARKER, state.manualBots, sidebar.botsDefault) : [];
    // A bot wears its project's color (the badge T3 draws for the project) unless one was picked for it.
    // Settled and snoozed rows have no badge to read: the color remembered from the
    // row before keeps the bot's face from turning another color when it settles.
    for (const bot of bots) bot.projectColor = threadProjectColor(scan, bot.thread) ?? state.knownBots[bot.key]?.projectColor ?? null;
    followBots(bots);
    state.bots = bots;
    assignBotShapes(bots.map((b) => b.key));
    const shown = demoBots(bots);
    if (sidebar.bots) {
      decorateBotRows(
        doc,
        scan,
        shown,
        state.botPrefs,
        (key) => (demoOn() ? demo.label("botMessage", key) : botPreviewText(state.botFeed, key)),
        // Screenshot mode: the strip's tooltip lists subagent titles, so they get stand-ins.
        (key) => {
          const subs = botSubagents(state.botFeed, key);
          return demoOn() ? subs.map((s, i) => ({ ...s, title: demo.label("title", s.title || `${key}#${i}`) })) : subs;
        },
      );
      rememberBots(bots);
    } else {
      clearBotDecoration(inner);
    }

    syncBreadcrumb(shown);
    syncHoverCards();
  }

  // ---------- Composer centering ----------
  // T3 shifts the composer left by the room it keeps for the details card or a
  // preview window on the right (--chat-lane-inset-end), even when that card
  // sits above the composer and could never touch it. Then the composer and
  // its glow sit left of the pane's middle. When nothing on the right overlaps
  // the composer's height, t3+ gives the composer's lane its full width back
  // (the timeline above keeps T3's room); when something does, T3's room stays.
  // CSS animates the change, and the glow follows it frame by frame.
  let centeredLane = null;
  function releaseLane() {
    // T3's room comes back at once (no slide): something beside the composer needs it now.
    centeredLane?.removeAttribute("data-t3plus-lane-slide");
    centeredLane?.style.removeProperty("--chat-lane-inset-end");
    centeredLane = null;
  }
  // Where a right overlay is heading, not where it is mid-slide: T3 animates
  // the details card's top (150 ms), so a check made as it starts moving saw
  // the old spot and kept the composer under the card (or out from under it).
  function overlayBox(el) {
    const r = el.getBoundingClientRect();
    const top = Number.parseFloat(el.style?.top);
    const parent = el.offsetParent ?? el.parentElement;
    if (!Number.isFinite(top) || !parent) return r;
    const t = parent.getBoundingClientRect().top + (parent.clientTop || 0) + top;
    return { left: r.left, right: r.right, width: r.width, height: r.height, top: t, bottom: t + r.height };
  }
  /**
   * Whether `el` is on screen over the chat beside the composer card `c`. A
   * webview docked in the right panel is beside the chat, not over it, and T3
   * parks the webviews of background tabs at the top left behind everything
   * (negative z-index, or hidden): neither keeps the composer from centering.
   */
  function besideComposer(el, c, canvasRect) {
    const r = overlayBox(el);
    if (!(r.width > 0 && r.height > 0)) return false;
    if (r.right <= canvasRect.left || r.left >= canvasRect.right) return false;
    if (!(r.top < c.bottom + 16 && r.bottom > c.top - 16)) return false;
    const cs = win.getComputedStyle(el);
    if (cs.visibility === "hidden" || cs.display === "none" || Number.parseFloat(cs.zIndex) < 0) return false;
    return true;
  }
  function syncComposerLane() {
    const lane = state.settings.composerGradient.enabled && !findHero() ? doc.querySelector(T3_SELECTORS.composerLane) : null;
    if (lane !== centeredLane) releaseLane();
    if (!lane) return;
    const canvas = lane.closest(T3_SELECTORS.chatCanvas) ?? lane.parentElement;
    const inset = Number.parseFloat(win.getComputedStyle(canvas).getPropertyValue("--chat-lane-inset-end")) || 0;
    const card = lane.querySelector(T3_SELECTORS.composerSurface) ?? lane;
    const c = card.getBoundingClientRect();
    const canvasRect = canvas.getBoundingClientRect();
    const blocked = inset <= 0 || c.height <= 0 || [...doc.querySelectorAll(T3_SELECTORS.rightOverlays)].some((el) => besideComposer(el, c, canvasRect));
    if (blocked) {
      releaseLane();
      return;
    }
    centeredLane = lane;
    if (lane.style.getPropertyValue("--chat-lane-inset-end") !== "0px") {
      // Only t3+'s own centering slides (content.css); room T3 makes for a card that
      // overlaps the composer is made at once, as T3 does, or the composer ran under
      // the card while it slid.
      lane.setAttribute("data-t3plus-lane-slide", "");
      lane.style.setProperty("--chat-lane-inset-end", "0px");
    }
  }
  // While the lane's padding animates, nothing else changes in the DOM or in
  // size: the glow is moved every frame until the transition ends.
  let laneFrame = null;
  let laneUntil = 0;
  function followLane(event) {
    if (!event.target?.classList?.contains(T3_CLASSES.composerLane) || !String(event.propertyName).startsWith("padding")) return;
    if (event.type !== "transitionrun") {
      // Settled: one last placement where the composer stopped.
      laneUntil = 0;
      timed("dither", syncDither);
      return;
    }
    laneUntil = nowMs() + 600;
    if (laneFrame !== null) return;
    const step = () => {
      laneFrame = null;
      timed("dither", syncDither);
      if (nowMs() < laneUntil) laneFrame = win.requestAnimationFrame(step);
    };
    laneFrame = win.requestAnimationFrame?.(step) ?? null;
  }

  let lastAnchor = null;
  /** Feeds the canvas dither renderer: the conversation pane, or the Settings preview on the Appearance page. */
  function syncDither() {
    const renderer = deps.backdropRenderer;
    if (!renderer) return;
    const look = lookSettings();
    const g = look.composerGradient;
    const theme = computeComposerTheme(look, state.imageUrl);
    const preview = panel.element.isConnected ? panel.element.querySelector(".t3plus-preview-pane") : null;
    // With t3+'s settings open, the live preview is what is on screen: T3 keeps the
    // last thread rendered behind its Settings, and drawn into that pane instead, the
    // preview only ever showed the CSS look (no Grain, Spectrum or pixel size).
    const pane = preview && SETTINGS_ROUTE.test(routePath()) ? null : (doc.querySelector(T3_SELECTORS.conversationArea) ?? doc.querySelector(`[${T3PLUS.backdropHostAttr}]`));
    // The composer's center across the pane. The CSS gradient (no dither) reads it
    // from the pane itself; on <html> every change restyled the whole page.
    const anchor = pane ? measureBackdropAnchor(doc) : null;
    if (anchor && anchor.percent !== lastAnchor) lastAnchor = anchor.percent;
    // Only while the CSS glow is shown: an inherited property written every frame of
    // a slide restyles the whole timeline below the pane.
    // That is the Smooth look, or the dithered look while its render is missing or
    // failed (the CSS fallback shows then, and must sit under the composer too).
    const fallbackShown = !g.dither || !doc.documentElement.hasAttribute("data-t3plus-dithered");
    if (pane && g.enabled && fallbackShown && Number.isFinite(lastAnchor)) {
      const value = `${lastAnchor.toFixed(2)}%`;
      if (pane.style.getPropertyValue("--t3plus-composer-x") !== value) pane.style.setProperty("--t3plus-composer-x", value);
    }
    // On the new-thread page the composer floats mid-pane: center the glow on it.
    let cy = null;
    const hero = findHero();
    // The message box sizes the glow. In a thread it is a sibling of the pane, not inside it.
    const box = pane ? (hero?.overlay.querySelector(T3_SELECTORS.composerSurface) ?? null) : null;
    const boxRect = box ? box.getBoundingClientRect() : (anchor?.composer ?? null);
    if (pane && hero) {
      const card = box ?? hero.stack;
      const p = pane.getBoundingClientRect();
      const c = card.getBoundingClientRect();
      if (p.height > 0 && c.height > 0) cy = Math.max(0, Math.min(1.2, (c.top + c.height * 0.9 - p.top) / p.height)); // around the composer
    }
    syncProfilePreview();
    renderer.update({
      mode: g.dither ? theme.mode : null,
      settings: look,
      imageSrc: g.imageSource === "upload" && state.image ? state.image.dataUrl : assetUrl(SAMPLE_IMAGE_PATH),
      host: pane ?? preview,
      cx: pane && Number.isFinite(lastAnchor) ? lastAnchor / 100 : 0.5,
      cy,
      wide: Boolean(pane && hero),
      composerWidth: boxRect ? boxRect.width : 0,
    });
  }

  /** The Profiles preview in Settings: its own glow, in the dither color being picked. */
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
      decorateBotHoverCards(doc, byTitle, state.botPrefs, demo.active ? demo.realText : null);
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
    heroOverlay = null;
  }
  const setInline = (el, name, value) => {
    if (el.style.getPropertyValue(name) !== value) el.style.setProperty(name, value);
  };

  function syncHome() {
    const hero = state.settings.home.widgets ? findHero() : null;
    if (!hero) {
      // T3 often drops the cards itself (navigation re-renders the overlay), so the
      // tooltip is hidden whether or not they were still in the page.
      if (home.element.isConnected) home.element.remove();
      home.hide();
      doc.documentElement.removeAttribute(T3PLUS.homeAttr);
      clearHeroVars();
      return;
    }
    if (heroOverlay !== hero.overlay) {
      clearHeroVars();
      heroOverlay = hero.overlay;
    }
    if (home.element.parentElement !== hero.stack) hero.stack.append(home.element);
    if (!doc.documentElement.hasAttribute(T3PLUS.homeAttr)) doc.documentElement.setAttribute(T3PLUS.homeAttr, "");
    // Filled before measuring: placed while still empty, the block moved again
    // once the cards arrived.
    home.update({ feed: state.homeFeed });
    const pane = doc.querySelector(T3_SELECTORS.conversationArea) ?? hero.overlay;
    const p = pane.getBoundingClientRect();
    const s = hero.stack.getBoundingClientRect();
    if (p.width > 0) {
      // Centered on the composer (T3 shifts it when the details card is open), but
      // never wider than the room on its narrower side, so it stays inside the pane.
      const center = s.left + s.width / 2;
      const room = 2 * Math.min(center - p.left, p.left + p.width - center) - 48;
      // As wide as T3's composer (the stack), within the room on its narrower side.
      setInline(home.element, "width", `${Math.round(Math.max(0, Math.min(s.width, room)))}px`);
    }
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
  // T3 keeps the composer's room (--chat-lane-inset-end on the chat canvas) and
  // places the details card in inline styles. Opening the right panel or the
  // details card changes those without adding or resizing anything t3+ watches,
  // so the composer kept a decision made a frame too early and did not move.
  // Style changes on the canvas and the right overlays now trigger a check.
  let styleObserver = null;
  let toggleObserver = null;
  const styleWatched = new Set();
  function watchLaneStyles() {
    const MO = win.MutationObserver;
    if (!MO) return;
    const placed = [...doc.querySelectorAll(`${T3_SELECTORS.chatCanvas}, ${T3_SELECTORS.rightOverlays}`)];
    // The composer overlay's class says whether this is the new-thread hero
    // (items-center). Only its class: t3+ writes the overlay's own padding.
    const overlays = [...doc.querySelectorAll(T3_SELECTORS.composerOverlay)];
    const wanted = new Set([...placed, ...overlays]);
    if (wanted.size === styleWatched.size && [...wanted].every((el) => styleWatched.has(el))) return;
    styleObserver?.disconnect();
    toggleObserver?.disconnect();
    styleObserver = new MO(() => watcher.schedule());
    // A section inside the card opening or closing (T3's collapsibles flip hidden,
    // open, data-state or aria-expanded) changes the card's height with no element
    // added: watched too, by those attributes only (t3+'s own chart in the card
    // changes others as the pointer moves).
    toggleObserver = new MO(() => watcher.schedule());
    // Not a ResizeObserver on the details card: T3 resizes the card inside its own
    // ResizeObserver callbacks, and any observer on it made the browser report a
    // loop each time the right panel opened. What T3 adds inside the card (a
    // changes list loading) reaches the DOM watcher anyway.
    for (const el of placed) {
      styleObserver.observe(el, { attributes: true, attributeFilter: ["style", "class"] });
      if (el.matches(T3_SELECTORS.rightOverlays)) toggleObserver.observe(el, { attributes: true, subtree: true, attributeFilter: ["hidden", "open", "data-state", "aria-expanded"] });
    }
    for (const el of overlays) if (!placed.includes(el)) styleObserver.observe(el, { attributes: true, attributeFilter: ["class"] });
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
    layoutObserver ??= new RO(() => {
      if (!watcher.storming()) timed("dither", syncDither);
      watcher.schedule();
    });
    for (const el of layoutWatched) if (!wanted.has(el)) layoutObserver.unobserve(el);
    for (const el of wanted) if (!layoutWatched.has(el)) layoutObserver.observe(el, { box: "border-box" });
    layoutWatched.clear();
    for (const el of wanted) layoutWatched.add(el);
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
    const show = eligible && Boolean(state.homeFeed && poolModel(state.homeFeed, kind, Date.now()));
    for (const old of doc.querySelectorAll(`[${T3PLUS.detailsPoolAttr}]`)) {
      if (old !== section || !show) old.removeAttribute(T3PLUS.detailsPoolAttr);
    }
    if (!show) {
      if (detailsPool.element.isConnected) detailsPool.element.remove();
      detailsPool.hide();
      return;
    }
    if (detailsPool.element.parentElement !== section || section.lastElementChild !== detailsPool.element) {
      const opening = !detailsPool.element.isConnected;
      section.append(detailsPool.element);
      // Just opened: its spend comes from the bot feed, which may not have been read
      // for this thread (bots off, or no bots on screen).
      if (opening && nowMs() - botFeedAt > 10_000) refreshBotFeed();
    }
    if (section.getAttribute(T3PLUS.detailsPoolAttr) !== kind) section.setAttribute(T3PLUS.detailsPoolAttr, kind);
    detailsPool.update({ feed: state.homeFeed, kind, spend: threadSpend(state.botFeed, threadKeyFromPath(routePath()) ?? "") });
  }

  let homeLoading = false;
  let homeAgain = false;
  let lastHomeFetch = -Infinity;
  const nowMs = () => win.performance?.now?.() ?? Date.now();
  // With no copy yet (the first read, a build without a feed, a feed that keeps
  // failing), it is asked again at most this often. Every read ends in a check, and
  // a check that read again straight away was a loop of requests and checks.
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
    try {
      do {
        homeAgain = false;
        lastHomeFetch = nowMs();
        const next = await deps.homeFeed.load().catch(() => null);
        if (next && !stopped) state.homeFeed = next;
      } while (homeAgain && !stopped);
    } finally {
      homeLoading = false;
    }
    watcher.schedule();
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
    let container = null;
    if (anchor) {
      settingsNav.mount(anchor);
      if (settingsOpenAt !== null) container = findSettingsPage(doc);
    } else {
      if (settingsNav.element.isConnected) settingsNav.element.remove();
      settingsOpenAt = null;
      // Older T3 without the settings nav hook: the panel stays under Appearance.
      container = findAppearanceContainer(doc, path);
    }
    const open = Boolean(anchor && container);
    settingsNav.setActive(open);
    doc.documentElement.toggleAttribute(T3PLUS.settingsAttr, open);
    if (container) ensurePanelMounted(container, panel.element);
    else {
      // Leaving Settings (T3 may have taken the page down with the panel in it).
      if (panel.element.isConnected) panel.element.remove();
      panel.closeBotEditor();
    }
    if (panelStale && panel.element.isConnected) updatePanel();
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
      const r = syncComposerSurfaces(doc, state.settings.glass.enabled);
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
    timed("sidebar", syncSidebar);
    timed("profiles", () => deps.profiles?.sync());
    timed("layout", watchLayout);
    // The hero first, then the glow: syncHome moves the new-thread composer, and
    // the glow is centered on where the composer ends up. Measured the other way
    // round, the glow kept the composer's old spot and sat too low behind the cards.
    timed("home", syncHome);
    timed("lane", syncComposerLane);
    timed("dither", syncDither);
    timed("details", syncThreadDetails);
    timed("usage", () => usageDither.sync());
    timed("demo", syncDemo);
    timed("health", () => health.check());
  }

  // ---------- Settings ----------

  // Preview changes (slider drags, color picking) repaint without writing storage.
  function preview(update) {
    state.settings = update(state.settings);
    render();
  }
  const gradient = (patch) => (s) => ({ ...s, composerGradient: { ...s.composerGradient, ...patch } });
  const glass = (patch) => (s) => ({ ...s, glass: { ...s.glass, ...patch } });

  // Saves run one at a time and always write the latest local state, so quick
  // successive changes (toggle, then mode) cannot overwrite each other.
  let saveQueue = Promise.resolve();
  let pendingSaves = 0;
  function persist(update, message = "") {
    preview(update);
    pendingSaves += 1;
    saveQueue = saveQueue
      .catch(() => {})
      .then(() => settingsStore.save(state.settings))
      .then(
        () => {
          state.message = message;
        },
        // Said, not swallowed: this window shows the change, but a reload or another
        // window would not have it (screenshot mode off there, say).
        (error) => {
          state.message = `Could not save that change${error instanceof Error && error.message ? `: ${error.message}` : "."}`;
        },
      )
      .finally(() => {
        pendingSaves -= 1;
        render();
      });
    return saveQueue;
  }

  const actions = {
    openWhatsNew: () => deps.whatsNew?.open(),
    setEnabled: (enabled) => persist(gradient({ enabled })),
    setMode: (mode) => persist(gradient({ mode })),
    previewAccent: (accent) => preview(gradient({ accent })),
    // Profiles (Settings → t3+): a profile's icon or colors, and the turn its sky takes.
    updateProfile: (id, patch) => deps.profiles?.update(id, patch),
    profileSkyTurn: (value) => deps.profiles?.skyTurnFor?.(value) ?? null,
    previewProfile: () => watcher.schedule(),
    setAccent: (accent) => persist(gradient({ accent })),
    previewIntensity: (intensity) => preview(gradient({ intensity })),
    setIntensity: (intensity) => persist(gradient({ intensity })),
    setDither: (dither) => persist(gradient({ dither })),
    setDitherSize: (ditherSize) => persist(gradient({ ditherSize })),
    setDitherStyle: (ditherStyle) => persist(gradient({ ditherStyle })),
    setLook: (look) => persist(gradient(look === "smooth" ? { dither: false } : { dither: true, ditherStyle: look })),
    useSample: () => persist(gradient({ imageSource: "sample" }), "Using the packaged sample image."),
    setGlass: (enabled) => persist(glass({ enabled })),
    previewGlassStrength: (strength) => preview(glass({ strength })),
    setGlassStrength: (strength) => persist(glass({ strength })),
    setSidebarFeature: (name, on) => persist((s) => ({ ...s, sidebar: { ...s.sidebar, [name]: on } })),
    setHomeWidgets: (on) => persist((s) => ({ ...s, home: { ...s.home, widgets: on } })),
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
        const saved = backup?.data?.[STORAGE_KEYS.settings];
        if (saved && typeof saved === "object") backup.data[STORAGE_KEYS.settings] = { ...saved, demo: { ...(saved.demo ?? {}), enabled: covered } };
        const keys = await deps.backup.import(backup);
        // The stores follow storage changes, so every open T3 tab updates by itself.
        // Screenshot mode: a backup's file name can be personal ("acme-client-backup.json").
        state.message = `Restored ${keys.length} saved setting${keys.length === 1 ? "" : "s"} from ${covered ? "the backup file" : file.name}.`;
      } catch (error) {
        state.message = error instanceof SyntaxError ? "That file is not valid JSON." : error instanceof Error ? error.message : "Could not import.";
      }
      render();
    },
    // In the save queue like any change, on the latest local state: done on its own,
    // a change made while it loaded and saved was written, then lost on screen.
    reset() {
      const d = defaultSettings();
      return persist((s) => ({ ...s, composerGradient: d.composerGradient, glass: d.glass }), "t3+ appearance reset.");
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
      // A choice to make it a bot goes with its settings; one that turned it off stays.
      if (state.manualBots[key] === true) state.manualBots = await botStore.toggleManual(key, byDefault, byDefault);
      state.botPrefs = await botStore.forget(key);
      const { [key]: _removed, ...rest } = state.knownBots;
      state.knownBots = rest;
      state.botMessage = "Forgot that bot's settings.";
      render();
    },
  };

  const panel = createAppearancePanel(doc, actions, { desktop: Boolean(deps.desktop), version: deps.version ?? null, whatsNew: Boolean(deps.whatsNew) });
  const home = createHomeView(doc);
  const detailsPool = createHomeView(doc, { variant: "pool" });
  const usageDither = createUsageDither(doc);

  // Streaming chat text lands inside T3's message list, which holds nothing
  // t3+ decorates or measures: those mutations never schedule a check.
  let timeline = null;
  let timelineLookup = -Infinity;
  const isNoise = (node) => {
    if (state.settings.demo.enabled) return false; // screenshot mode covers message text too
    if (!timeline?.isConnected) {
      // Look it up again at most every 250 ms (pages without a chat have none).
      const t = win.performance?.now?.() ?? Date.now();
      if (t - timelineLookup < 250) return false;
      timelineLookup = t;
      timeline = doc.querySelector(T3_SELECTORS.messageList);
    }
    return Boolean(timeline && timeline !== node && timeline.contains(node));
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
    schedule: () => watcher.schedule(),
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
    frames: deps.frameChecks ?? true,
    // While a storm holds the full check back, screenshot mode's cover still follows
    // every frame: a reply streaming in would otherwise show its real text between checks.
    quick: () => {
      if (!stopped && demoOn()) timed("demo", syncDemo);
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
        if (stopped || (!next && state.botFeed)) continue; // keep the last good copy on a failed read
        state.botFeed = next;
        changed = true;
      } while (botAgain && !stopped);
    } finally {
      botLoading = false;
    }
    if (changed) render();
  }

  const onVisibility = () => {
    if (doc.visibilityState !== "visible") return;
    if (botFeedWanted()) refreshBotFeed();
    if (findHero() || detailsPool.element.isConnected) refreshHomeFeed();
  };

  const api = {
    state,
    perf,
    /** The open profile's dither color changed (profiles.js onLook): drawn again in it. */
    profilesLook() {
      if (!stopped) render();
    },
    /** Profiles loaded or changed (profiles.js onChange): the Settings card is brought up to date. */
    profilesChanged() {
      if (stopped) return;
      if (panel.element.isConnected) updatePanel();
      else panelStale = true;
    },
    /** The desktop loader handed over new feeds: read them now, not at the next poll. */
    feedsUpdated() {
      if (stopped) return;
      if (botFeedWanted()) refreshBotFeed();
      if (findHero() || detailsPool.element.isConnected) refreshHomeFeed();
    },
    panel,
    watcher,
    actions,
    async start() {
      // Stopped before it started (a newer copy took over first): nothing to set up.
      if (stopped) return;
      // A copy orphaned by an extension reload may have left its UI behind.
      doc.getElementById(panel.element.id)?.remove();
      for (const old of doc.querySelectorAll("[data-t3plus-settings-nav]")) old.closest("li")?.remove();
      doc.addEventListener("click", onSettingsClick, true);
      unsubscribers.push(() => doc.removeEventListener("click", onSettingsClick, true));
      for (const type of ["transitionrun", "transitionend", "transitioncancel"]) {
        doc.addEventListener(type, followLane, true);
        unsubscribers.push(() => doc.removeEventListener(type, followLane, true));
      }
      const [settings, image, botPrefs, knownBots, manualBots] = await Promise.all([
        settingsStore.load(),
        imageStore.load(),
        botStore.load(),
        botStore.loadKnown(),
        botStore.loadManual?.() ?? {},
      ]);
      if (stopped) return; // stopped while loading: register nothing
      Object.assign(state, { settings, image, botPrefs, knownBots, manualBots });
      unsubscribers.push(
        // Other tabs (or this one) saving keeps every open T3 tab in sync.
        settingsStore.subscribe((next) => {
          // While this tab is saving, its local state is newer than the echo.
          if (pendingSaves > 0) return;
          state.settings = next;
          render();
        }),
        imageStore.subscribe((next) => {
          state.image = next;
          render();
        }),
        botStore.subscribe((next) => {
          state.botPrefs = next;
          render();
        }),
        botStore.subscribeManual?.((next) => {
          state.manualBots = next;
          render();
        }) ?? (() => {}),
        botStore.subscribeKnown((next) => {
          state.knownBots = next;
          render();
        }),
      );
      doc.addEventListener("visibilitychange", onVisibility);
      unsubscribers.push(() => doc.removeEventListener("visibilitychange", onVisibility));
      const onResize = () => watcher.schedule();
      win.addEventListener?.("resize", onResize, { passive: true });
      unsubscribers.push(() => win.removeEventListener?.("resize", onResize));
      if (deps.botFeed) {
        state.botFeed = await deps.botFeed.readCache().catch(() => null);
        if (stopped) return;
        feedTimer = win.setInterval(() => {
          if (doc.visibilityState === "hidden" || !botFeedWanted()) return;
          const busy = state.bots.some((b) => b.status === "working" || b.status === "waiting" || b.status === "attention");
          if (busy || nowMs() - botFeedAt >= BOT_FEED_QUIET_MS) refreshBotFeed();
        }, BOT_FEED_POLL_MS);
        unsubscribers.push(() => win.clearInterval(feedTimer));
        refreshBotFeed();
      }
      if (deps.homeFeed) {
        state.homeFeed = await deps.homeFeed.readCache().catch(() => null);
        if (stopped) return;
        const homeTimer = win.setInterval(() => {
          if (doc.visibilityState !== "hidden" && state.settings.home.widgets && (findHero() || detailsPool.element.isConnected)) refreshHomeFeed();
        }, HOME_FEED_POLL_MS);
        unsubscribers.push(() => win.clearInterval(homeTimer));
      }
      deps.profiles?.start().catch(() => {});
      unsubscribers.push(() => deps.profiles?.stop());
      deps.whatsNew?.start().catch(() => {});
      unsubscribers.push(() => deps.whatsNew?.stop());
      watchPopups();
      // A T3 theme switch (light/dark, another palette) changes only <html>'s class and
      // theme attributes: the glow (and the Settings preview) take the new colors right
      // away, on every page, not at some later check.
      const themeObserver = new win.MutationObserver(() => watcher.schedule());
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
      watcher.stop();
      for (const t of botFeedQueue.splice(0)) win.clearTimeout(t);
      stopSprites();
      for (const unsubscribe of unsubscribers.splice(0)) unsubscribe();
      panel.element.remove();
      settingsNav.setActive(false); // Appearance's aria-current back, if t3+ had it
      settingsNav.element.remove();
      home.element.remove();
      home.destroy();
      detailsPool.element.remove();
      detailsPool.destroy();
      usageDither.clear();
      for (const el of doc.querySelectorAll(`[${T3PLUS.detailsPoolAttr}]`)) el.removeAttribute(T3PLUS.detailsPoolAttr);
      demo.restore();
      doc.documentElement.removeAttribute(T3PLUS.demoAttr);
      doc.documentElement.removeAttribute(T3PLUS.settingsAttr);
      doc.documentElement.removeAttribute(T3PLUS.homeAttr);
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
      const cleared = [...Object.keys(computeComposerTheme(state.settings, null).vars), "--t3plus-look-accent"].map((name) => [name, null]);
      releaseLane();
      if (laneFrame !== null) win.cancelAnimationFrame?.(laneFrame);
      clearHeroVars();
      layoutObserver?.disconnect();
      layoutWatched.clear();
      styleObserver?.disconnect();
      toggleObserver?.disconnect();
      styleWatched.clear();
      applyComposerTheme(doc, { mode: null, glass: false, vars: Object.fromEntries(cleared) });
      if (objectUrl) win.URL.revokeObjectURL(objectUrl);
      objectUrl = null;
      objectUrlFor = null;
    },
  };
  return api;
}
