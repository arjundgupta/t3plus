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
} from "./bots.js";
import { applyComposerTheme, measureBackdropAnchor, syncBackdropHosts, syncComposerSurfaces } from "./composer.js";
import { botMetaText, botPreviewText, botSubagents, threadIdFromKey, threadSpend } from "./botFeed.js";
import { BOT_FEED_POLL_MS, BOT_LIMITS, DEFAULT_BOT_MARKER, DOM_CHECK_THROTTLE_MS, HOME_FEED_POLL_MS, SAMPLE_IMAGE_PATH, T3_SELECTORS, T3PLUS } from "./config.js";
import { createHomeView } from "./homeWidgets.js";
import { createUsageDither } from "./usageDither.js";
import { createDemoMode } from "./demoMode.js";
import { providerKind } from "./homeData.js";
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

  function resolveImageUrl() {
    const { imageSource } = state.settings.composerGradient;
    if (imageSource === "upload" && state.image) {
      if (objectUrlFor !== state.image.dataUrl) {
        if (objectUrl) win.URL.revokeObjectURL(objectUrl);
        objectUrl = win.URL.createObjectURL(dataUrlToBlob(state.image.dataUrl));
        objectUrlFor = state.image.dataUrl;
      }
      return objectUrl;
    }
    return assetUrl(SAMPLE_IMAGE_PATH);
  }

  /** Bots for the Settings list: every bot seen in the sidebar plus any with saved settings. */
  function botsForPanel() {
    const marker = DEFAULT_BOT_MARKER;
    // The bots in the sidebar now, the most recently seen ones (Settings has no
    // sidebar), and any with saved settings or turned on by hand. With every
    // thread a bot by default, all ever seen would be a long list.
    const recent = Object.entries(state.knownBots)
      .sort((a, b) => (b[1].seenAt ?? 0) - (a[1].seenAt ?? 0))
      .slice(0, BOT_LIMITS.maxBots)
      .map(([key]) => key);
    const keys = new Set([...state.bots.map((b) => b.key), ...recent, ...Object.keys(state.botPrefs), ...Object.keys(state.manualBots).filter((k) => state.manualBots[k] === true)]);
    return [...keys].sort().map((key) => {
      const title = state.knownBots[key]?.title ?? "";
      const titleLabel = parseBotTitle(title, marker)?.label ?? ((state.manualBots[key] ?? state.settings.sidebar.botsDefault) ? title : "");
      const prefs = normalizeBotPrefs(state.botPrefs[key]);
      const projectColor = state.knownBots[key]?.projectColor ?? null;
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

  function render() {
    setBotStyle(state.settings.sidebar.botStyle);
    state.imageUrl = resolveImageUrl();
    applyComposerTheme(doc, computeComposerTheme(state.settings, state.imageUrl));
    panel.update({
      ...state,
      bots: botsForPanel(),
      botMarker: DEFAULT_BOT_MARKER,
    });
    watcher.schedule();
  }

  function rememberBots(bots) {
    let changed = false;
    const next = { ...state.knownBots };
    for (const bot of bots) {
      const known = next[bot.key];
      // The project color is kept too, so Settings can draw the bot when its row is not on screen.
      if (known?.title !== bot.thread.title || (bot.projectColor && known?.projectColor !== bot.projectColor)) {
        next[bot.key] = { title: bot.thread.title, seenAt: Date.now(), ...(bot.projectColor ?? known?.projectColor ? { projectColor: bot.projectColor ?? known.projectColor } : {}) };
        changed = true;
      }
    }
    if (!changed) return;
    const keep = Object.entries(next)
      .sort((a, b) => b[1].seenAt - a[1].seenAt)
      .slice(0, BOT_LIMITS.maxBots * 2);
    state.knownBots = Object.fromEntries(keep);
    botStore.saveKnown(state.knownBots).catch(() => {});
  }

  function syncSidebar() {
    const inner = findSidebarInner(doc);
    if (!inner) return;
    const scan = scanSidebar(inner);
    const { sidebar } = state.settings;

    const bots = sidebar.bots ? classifyBots(scan, DEFAULT_BOT_MARKER, state.manualBots, sidebar.botsDefault) : [];
    // A bot wears its project's color (the badge T3 draws for the project) unless one was picked for it.
    for (const bot of bots) bot.projectColor = threadProjectColor(scan, bot.thread);
    // A bot that changed state (started, finished, asks for something) or a new bot
    // probably has a new latest message: fetch it now instead of waiting for the poll.
    const openKey = threadKeyFromPath(routePath());
    const signature = [openKey, ...bots.map((b) => `${b.key}|${b.status}|${b.statusLabel}`)].join("\n");
    if (signature !== botSignature) {
      botSignature = signature;
      // The desktop loader publishes the bot feed (latest message, subagents) for these threads.
      try {
        // The open thread too, bot or not: the details card shows its spend.
        win.__t3plusTell?.("bots", { keys: [...new Set([...bots.map((b) => b.key), ...(openKey ? [openKey] : [])])] });
      } catch {
        // no loader (the Chrome extension)
      }
      if (bots.length) queueBotFeed();
    }
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
        (key) => botSubagents(state.botFeed, key),
      );
      rememberBots(bots);
    } else {
      clearBotDecoration(inner);
    }

    const routeKey = threadKeyFromPath(routePath());
    const activeBot = shown.find((bot) => bot.key === routeKey) ?? null;
    decorateBotBreadcrumb(doc, activeBot ? { ...activeBot, prefs: state.botPrefs[activeBot.key] } : null);
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
    centeredLane?.style.removeProperty("--chat-lane-inset-end");
    centeredLane = null;
  }
  function syncComposerLane() {
    const lane = state.settings.composerGradient.enabled && !findHero() ? doc.querySelector(T3_SELECTORS.composerLane) : null;
    if (lane !== centeredLane) releaseLane();
    if (!lane) return;
    const canvas = lane.closest("[data-chat-canvas]") ?? lane.parentElement;
    const inset = Number.parseFloat(win.getComputedStyle(canvas).getPropertyValue("--chat-lane-inset-end")) || 0;
    const card = lane.querySelector(T3_SELECTORS.composerSurface) ?? lane;
    const c = card.getBoundingClientRect();
    const blocked =
      inset <= 0 ||
      c.height <= 0 ||
      [...doc.querySelectorAll(T3_SELECTORS.rightOverlays)].some((el) => {
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0 && r.top < c.bottom + 16 && r.bottom > c.top - 16;
      });
    if (blocked) {
      releaseLane();
      return;
    }
    centeredLane = lane;
    if (lane.style.getPropertyValue("--chat-lane-inset-end") !== "0px") lane.style.setProperty("--chat-lane-inset-end", "0px");
  }
  // While the lane's padding animates, nothing else changes in the DOM or in
  // size: the glow is moved every frame until the transition ends.
  let laneFrame = null;
  let laneUntil = 0;
  function followLane(event) {
    if (!event.target?.classList?.contains("chat-composer-lane") || !String(event.propertyName).startsWith("padding")) return;
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
    const g = state.settings.composerGradient;
    const theme = computeComposerTheme(state.settings, state.imageUrl);
    const pane = doc.querySelector(T3_SELECTORS.conversationArea) ?? doc.querySelector(`[${T3PLUS.backdropHostAttr}]`);
    const preview = panel.element.isConnected ? panel.element.querySelector(".t3plus-preview-pane") : null;
    // The composer's center across the pane. The CSS gradient (no dither) reads it
    // from the pane itself; on <html> every change restyled the whole page.
    const anchor = pane ? measureBackdropAnchor(doc) : null;
    if (anchor && anchor.percent !== lastAnchor) lastAnchor = anchor.percent;
    if (pane && !g.dither && Number.isFinite(lastAnchor)) {
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
    renderer.update({
      mode: g.dither ? theme.mode : null,
      settings: state.settings,
      imageSrc: g.imageSource === "upload" && state.image ? state.image.dataUrl : assetUrl(SAMPLE_IMAGE_PATH),
      host: pane ?? preview,
      cx: pane && Number.isFinite(lastAnchor) ? lastAnchor / 100 : 0.5,
      cy,
      wide: Boolean(pane && hero),
      composerWidth: boxRect ? boxRect.width : 0,
    });
  }

  // ---------- Bot hover cards ----------

  function syncHoverCards() {
    if (!state.settings.sidebar.bots || !state.bots.length) return;
    decorateBotHoverCards(doc, new Map(demoBots(state.bots).map((b) => [b.thread.title.trim(), b])), state.botPrefs);
    demo.applyPopups();
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
  const syncHoverCardsSoon = () => syncHoverCards();
  function watchPopups() {
    const body = doc.body;
    if (!body) return;
    const watched = new WeakSet();
    portalObserver = new win.MutationObserver(() => syncHoverCardsSoon());
    const watchPortals = () => {
      for (const el of body.children) {
        if (watched.has(el)) continue;
        watched.add(el);
        // The app root and t3+'s own nodes are not popups.
        if (el.id === "root" || el.hasAttribute(T3PLUS.ownedAttr) || el.querySelector("[data-workspace-area], [data-slot='sidebar-wrapper']")) continue;
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
    if (!overlay || !overlay.classList.contains("items-center")) return null;
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
      if (home.element.isConnected) home.element.remove();
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
    const overlayHeight = hero.overlay.clientHeight;
    if (overlayHeight > 0) {
      const above = hero.stack.querySelector(":scope > .absolute.bottom-full")?.offsetHeight ?? 84;
      const free = overlayHeight - (above + s.height + 16 + home.element.scrollHeight);
      const top = Math.max(24, Math.min(free - 24, free * 0.35));
      setInline(hero.overlay, "padding-top", `${Math.round(top + above)}px`);
    }
    // Measured again: the hero offset just set moves the stack, and the room under it
    // (from the rectangle taken before) would stay wrong until some later check.
    const placed = hero.stack.getBoundingClientRect();
    if (p.height > 0) setInline(home.element, "max-height", `${Math.round(Math.max(160, p.top + p.height - placed.top - placed.height - 40))}px`);
    // Fetched only while the widgets are on screen: on arrival when the copy is
    // older than one poll, then every poll while they stay.
    if (deps.homeFeed && !homeLoading && (!state.homeFeed || nowMs() - lastHomeFetch > HOME_FEED_POLL_MS)) refreshHomeFeed();
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
  function watchLayout() {
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
  // text. Toggled in Settings -> t3+ or with Alt+Shift+D.
  const demo = createDemoMode(doc);
  const demoOn = () => state.settings.demo.enabled;
  const demoBots = (bots) => (demoOn() ? bots.map((b) => ({ ...b, titleLabel: demo.label("bot", b.titleLabel || "Bot") })) : bots);
  let demoPrune = 0;
  function syncDemo() {
    const on = demoOn();
    doc.documentElement.toggleAttribute(T3PLUS.demoAttr, on);
    if (on) {
      demo.apply({ sidebarInner: findSidebarInner(doc) });
      if ((demoPrune += 1) % 50 === 0) demo.prune();
    } else if (demo.active) demo.restore();
  }
  // Option-click a thread row: make it a bot (or a plain thread again). No rename,
  // nothing sent to T3: the choice is a local list of thread keys. A row's own
  // buttons (Settle, Snooze) and every other click keep T3's behaviour.
  function onBotToggleClick(event) {
    if (!event.altKey || event.button !== 0 || event.shiftKey || event.metaKey || event.ctrlKey) return;
    if (!state.settings.sidebar.bots) return;
    const row = event.target?.closest?.(`${T3_SELECTORS.threadItem} ${T3_SELECTORS.sidebarRow}`);
    if (!row || event.target.closest("button")) return;
    const key = row.getAttribute("data-sidebar-row");
    if (!key) return;
    event.preventDefault();
    event.stopPropagation();
    actions.toggleBot(key);
  }

  function onDemoKey(event) {
    if (event.code !== "KeyD" || !event.altKey || !event.shiftKey || event.ctrlKey || event.metaKey) return;
    event.preventDefault();
    actions.setDemo(!demoOn());
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
    const show = Boolean(section && kind && state.settings.home.widgets && !doc.documentElement.hasAttribute(T3PLUS.homeAttr));
    for (const old of doc.querySelectorAll(`[${T3PLUS.detailsPoolAttr}]`)) {
      if (old !== section || !show) old.removeAttribute(T3PLUS.detailsPoolAttr);
    }
    if (!show) {
      if (detailsPool.element.isConnected) detailsPool.element.remove();
      return;
    }
    if (detailsPool.element.parentElement !== section || section.lastElementChild !== detailsPool.element) section.append(detailsPool.element);
    if (section.getAttribute(T3PLUS.detailsPoolAttr) !== kind) section.setAttribute(T3PLUS.detailsPoolAttr, kind);
    if (deps.homeFeed && !homeLoading && (!state.homeFeed || nowMs() - lastHomeFetch > HOME_FEED_POLL_MS)) refreshHomeFeed();
    detailsPool.update({ feed: state.homeFeed, kind, spend: threadSpend(state.botFeed, threadKeyFromPath(routePath()) ?? "") });
  }

  let homeLoading = false;
  let lastHomeFetch = -Infinity;
  const nowMs = () => win.performance?.now?.() ?? Date.now();
  async function refreshHomeFeed() {
    if (!deps.homeFeed || !state.settings.home.widgets) return;
    homeLoading = true;
    lastHomeFetch = nowMs();
    try {
      const next = await deps.homeFeed.load().catch(() => null);
      if (next) state.homeFeed = next;
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
    checkDom();
    doc.querySelector("[data-settings-page-scroll]")?.scrollTo?.(0, 0);
  });
  let settingsOpenAt = null;
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
    const anchor = SETTINGS_ROUTE.test(path) ? findSettingsNavAnchor(doc) : null;
    // Opened from the toolbar icon (…/settings/appearance#t3plus): show t3+ once.
    if (anchor && !openedFromHash && win.location.hash === "#t3plus") {
      openedFromHash = true;
      settingsOpenAt = path;
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
    else if (panel.element.isConnected) panel.element.remove();
  }

  // Cost of the DOM checks, for tuning (window.__t3plusApp.perf in the desktop build).
  const perf = { checks: 0, ms: 0, max: 0, parts: {} };
  const timed = (name, fn) => {
    const t0 = win.performance?.now?.() ?? 0;
    const result = fn();
    const dt = (win.performance?.now?.() ?? 0) - t0;
    perf.parts[name] = (perf.parts[name] ?? 0) + dt;
    return result;
  };
  function checkDom() {
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
    syncSettingsSection();
    const result = timed("composer", () => {
      const r = syncComposerSurfaces(doc, state.settings.glass.enabled);
      syncBackdropHosts(doc, state.settings.composerGradient.enabled);
      return r;
    });
    if (result.orphanEditors > 0 && !warnedOrphans) {
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
    watchLayout();
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
      .finally(() => {
        pendingSaves -= 1;
      })
      .then(() => {
        state.message = message;
        render();
      });
    return saveQueue;
  }

  const actions = {
    setEnabled: (enabled) => persist(gradient({ enabled })),
    setMode: (mode) => persist(gradient({ mode })),
    previewAccent: (accent) => preview(gradient({ accent })),
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
        const record = await prepareImage(file);
        state.image = await imageStore.save(record);
        await persist(gradient({ imageSource: "upload" }), `Saved ${state.image.name} in this browser.`);
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
        link.download = `t3plus-settings-${new Date().toISOString().slice(0, 10)}.json`;
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
      try {
        const keys = await deps.backup.import(JSON.parse(await file.text()));
        // The stores follow storage changes, so every open T3 tab updates by itself.
        state.message = `Restored ${keys.length} saved setting${keys.length === 1 ? "" : "s"} from ${file.name}.`;
      } catch (error) {
        state.message = error instanceof SyntaxError ? "That file is not valid JSON." : error instanceof Error ? error.message : "Could not import.";
      }
      render();
    },
    async reset() {
      await saveQueue.catch(() => {});
      state.settings = await settingsStore.reset();
      state.message = "t3+ appearance reset.";
      render();
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
      if (Object.hasOwn(state.manualBots, key)) state.manualBots = await botStore.toggleManual(key, byDefault, byDefault);
      state.botPrefs = await botStore.forget(key);
      const { [key]: _removed, ...rest } = state.knownBots;
      state.knownBots = rest;
      state.botMessage = "Forgot that bot's settings.";
      render();
    },
  };

  const panel = createAppearancePanel(doc, actions);
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
  const watcher = createDomWatcher({ win, doc, check: checkDom, throttleMs: deps.throttleMs ?? DOM_CHECK_THROTTLE_MS, isNoise, frames: deps.frameChecks ?? true });

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
  async function refreshBotFeed() {
    if (!deps.botFeed || !state.settings.sidebar.bots) return;
    botFeedAt = nowMs();
    const next = await deps.botFeed.load().catch(() => null);
    if (!next && state.botFeed) return; // keep the last good copy on a failed read
    state.botFeed = next;
    render();
  }

  const onVisibility = () => {
    if (doc.visibilityState !== "visible") return;
    if (state.bots.length) refreshBotFeed();
    if (findHero() || detailsPool.element.isConnected) refreshHomeFeed();
  };

  const api = {
    state,
    perf,
    panel,
    watcher,
    actions,
    async start() {
      // A copy orphaned by an extension reload may have left its UI behind.
      doc.getElementById(panel.element.id)?.remove();
      for (const old of doc.querySelectorAll("[data-t3plus-settings-nav]")) old.closest("li")?.remove();
      doc.addEventListener("click", onSettingsClick, true);
      unsubscribers.push(() => doc.removeEventListener("click", onSettingsClick, true));
      doc.addEventListener("keydown", onDemoKey, true);
      unsubscribers.push(() => doc.removeEventListener("keydown", onDemoKey, true));
      doc.addEventListener("click", onBotToggleClick, true);
      unsubscribers.push(() => doc.removeEventListener("click", onBotToggleClick, true));
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
        feedTimer = win.setInterval(() => {
          if (doc.visibilityState === "hidden" || !state.bots.length) return;
          const busy = state.bots.some((b) => b.status === "working" || b.status === "waiting" || b.status === "attention");
          if (busy || nowMs() - botFeedAt >= BOT_FEED_QUIET_MS) refreshBotFeed();
        }, BOT_FEED_POLL_MS);
        unsubscribers.push(() => win.clearInterval(feedTimer));
        refreshBotFeed();
      }
      if (deps.homeFeed) {
        state.homeFeed = await deps.homeFeed.readCache().catch(() => null);
        const homeTimer = win.setInterval(() => {
          if (doc.visibilityState !== "hidden" && state.settings.home.widgets && (findHero() || detailsPool.element.isConnected)) refreshHomeFeed();
        }, HOME_FEED_POLL_MS);
        unsubscribers.push(() => win.clearInterval(homeTimer));
      }
      deps.profiles?.start().catch(() => {});
      unsubscribers.push(() => deps.profiles?.stop());
      watchPopups();
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
      watcher.stop();
      for (const t of botFeedQueue.splice(0)) win.clearTimeout(t);
      stopSprites();
      for (const unsubscribe of unsubscribers.splice(0)) unsubscribe();
      panel.element.remove();
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
      syncComposerSurfaces(doc, false);
      syncBackdropHosts(doc, false);
      deps.backdropRenderer?.clear();
      const cleared = Object.keys(computeComposerTheme(state.settings, null).vars).map((name) => [name, null]);
      for (const el of doc.querySelectorAll(T3_SELECTORS.conversationArea)) el.style.removeProperty("--t3plus-composer-x");
      releaseLane();
      if (laneFrame !== null) win.cancelAnimationFrame?.(laneFrame);
      clearHeroVars();
      layoutObserver?.disconnect();
      applyComposerTheme(doc, { mode: null, glass: false, vars: Object.fromEntries(cleared) });
      if (objectUrl) win.URL.revokeObjectURL(objectUrl);
      objectUrl = null;
      objectUrlFor = null;
    },
  };
  return api;
}
