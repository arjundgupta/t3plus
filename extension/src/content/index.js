// Entry point. Bundled by build-desktop.mjs into ../dist/content.js (an IIFE), which the
// desktop loader injects into T3's window; inject/page-stub.js provides the chrome.*
// storage and messaging APIs it uses (a stand-in from when this was a Chrome extension).
//
// Read-only toward T3: this script touches only the DOM of the page, extension
// storage, its own backup copy in T3's localStorage (t3plus.backup.v1, see backup.js)
// and, in the desktop app, the trackpad events of T3's desktop bridge. It does not read
// cookies or credentials, call T3's WebSocket/RPC, or send anything to T3's server. The
// only reads are the three feeds (t3plus-bots.json, t3plus-home.json,
// t3plus-threads.json), handed over by the desktop loader.
import { createT3Plus } from "../app.js";
import { exportAll, importAll, mirrorToSync, PAGE_BACKUP_KEY, readSynced } from "../backup.js";
import { createBackdropRenderer } from "../backdropRenderer.js";
import { createBotFeed } from "../botFeed.js";
import { createHomeFeed } from "../homeData.js";
import { createBotStore } from "../bots.js";
import { setBlobRasterizer, setBotArtEncoder } from "../botArt.js";
import { createImageStore, normalizeImageRecord } from "../imageStore.js";
import { createRuntimeFetcher, feedsAnswered } from "../runtimeFetch.js";
import { createSettingsStore, normalizeSettings } from "../settings.js";
import { createProfiles, normalizeProfiles, profileHex } from "../profiles.js";
import { createScopesStore, liftProfileColors, migrateProfileColors, normalizeScopes } from "../settingsScopes.js";
import { createThreadsFeed, createViewStore } from "../statusView.js";
import { createWhatsNew } from "../whatsNew.js";
import { createUpdateNotice } from "../updateNotice.js";
import { normalizeBotPrefsMap, normalizeKnownBots, normalizeManualBots } from "../bots.js";
import { DESKTOP_IMAGE_LIMITS, IMAGE_LIMITS, STORAGE_KEYS } from "../config.js";
import { FEEDS_CONFIGURED } from "../hosts.js";

const area = chrome.storage.local;
const sync = chrome.storage.sync;
const changed = chrome.storage.onChanged;
// The T3 Code desktop app, where the loader stands in for the extension (inject/page-stub.js).
const desktop = chrome.runtime?.id === "t3plus-desktop";

const fetchRemote = createRuntimeFetcher(chrome.runtime);
// The bot and home feeds, when something answers for them (see feedsAnswered). In the
// desktop app the loader already holds them in the page (window.__t3plusFeeds): the first
// paint reads that copy, and none is kept in T3's localStorage, whose room T3 needs.
const feedDeps = () => {
  if (!feedsAnswered(chrome.runtime, FEEDS_CONFIGURED)) return {};
  if (!desktop) return { botFeed: createBotFeed({ area, fetchRemote }), homeFeed: createHomeFeed({ area, fetchRemote }) };
  area.remove([STORAGE_KEYS.botFeedCache, STORAGE_KEYS.homeFeedCache]).catch(() => {}); // an earlier build kept copies there
  const loaderCopy = (kind) => () => window.__t3plusFeeds?.[kind] ?? null;
  return {
    botFeed: createBotFeed({ area: null, fetchRemote, readLocal: loaderCopy("bots") }),
    homeFeed: createHomeFeed({ area: null, fetchRemote, readLocal: loaderCopy("home") }),
  };
};

// Bot faces as small PNGs instead of per-pixel SVG (see botArt.js).
setBotArtEncoder((pixels, width, height, fills) => {
  if (!fills.every((hex) => hex === "transparent" || /^#[0-9a-f]{6}$/i.test(hex))) return null;
  // [r, g, b, a]; "transparent" lets a sprite have clear pixels (the status badge's corners).
  const palette = fills.map((hex) => (hex === "transparent" ? [0, 0, 0, 0] : [...[1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16)), 255]));
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  const image = ctx.createImageData(width, height);
  for (let i = 0; i < pixels.length; i += 1) {
    image.data.set(palette[pixels[i]], i * 4);
  }
  ctx.putImageData(image, 0, 0);
  return canvas.toDataURL("image/png");
});
// Blob sheets drawn once into a picture, not laid out and painted as SVG on every frame
// step (blobAvatars.js).
setBlobRasterizer((width, height, draw) => {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx || typeof ctx.roundRect !== "function") return null;
  draw(ctx);
  return canvas.toDataURL("image/png");
});

// Desktop loader: a newer copy stops the one before it instead of reloading the window.
try {
  window.__t3plusApp?.stop();
} catch {
  // the old copy is gone already
}

// A fresh install (new version unpacked elsewhere, reinstall, another computer)
// gets its preferences back, from Chrome Sync or the copy in T3's page storage,
// before t3+ reads them. See backup.js. The desktop app keeps neither: it has no Chrome
// Sync, and its storage is T3's page storage itself, where a copy would be lost with what
// it copies and only take twice the room (one an earlier build left there is removed).
let page = null;
try {
  page = window.localStorage;
  if (desktop) {
    page.removeItem(PAGE_BACKUP_KEY);
    page = null;
  }
} catch {
  page = null;
}
let appRef = null;
const app = createT3Plus({
  win: window,
  doc: document,
  profiles: createProfiles({
    win: window,
    doc: document,
    area,
    changedEvent: changed,
    isEnabled: () => appRef?.state.settings.sidebar.profiles ?? true,
    isDemo: () => appRef?.state.settings.demo.enabled ?? false,
    // The profile on screen: its settings are drawn (its own glow, bots, ...).
    onShown: (id) => appRef?.profileShown?.(id),
    // Loaded or changed (here, in Settings, or in another window): the Settings card follows.
    onChange: () => appRef?.profilesChanged?.(),
    onDelete: (id) => appRef?.profileDeleted?.(id),
    // A profile's own glow and bubble colors (its dot's editor): its settings.
    scoped: {
      get: (profileId, path) => appRef?.scopedValue?.(profileId, path),
      set: (profileId, path, value) => appRef?.setScopedValue?.(profileId, path, value),
    },
    // T3's desktop app reports each touch on the trackpad: a finished swipe ends there,
    // so the next swipe switches again right away.
    trackpad:
      typeof window.desktopBridge?.onTrackpadScrollBegin === "function"
        ? {
            onBegin: (fn) => window.desktopBridge.onTrackpadScrollBegin(fn),
            onEnd: typeof window.desktopBridge.onTrackpadScrollEnd === "function" ? (fn) => window.desktopBridge.onTrackpadScrollEnd(fn) : undefined,
          }
        : null,
    // T3's keys for its thread shortcuts (the loader reads keybindings.json), kept to the open profile.
    threadKeybindings: () => window.__t3plusBoot?.keybindings ?? null,
  }),
  version: chrome.runtime.getManifest?.().version,
  // After an update, what changed (once); every version's notes are in Settings → t3+ → Changelog too.
  whatsNew: createWhatsNew({ win: window, doc: document, area, version: chrome.runtime.getManifest?.().version }),
  // A newer t3+ release (the desktop loader checks GitHub once a day): a popup once, and a card in Settings → t3+.
  ...(desktop
    ? {
        updates: createUpdateNotice({
          area,
          changedEvent: changed,
          version: chrome.runtime.getManifest?.().version,
          release: window.__t3plusBoot?.update ?? null,
          onChange: () => appRef?.updateChanged?.(),
        }),
      }
    : {}),
  settingsStore: createSettingsStore(area, changed),
  scopesStore: createScopesStore(area, changed),
  viewStore: createViewStore(area, changed),
  // Published by the desktop loader only (no server script writes it for the extension).
  ...(desktop ? { threadsFeed: createThreadsFeed({ fetchRemote }) } : {}),
  liftProfileColors: (profiles, scopes) => liftProfileColors(profiles, scopes, profileHex),
  imageStore: createImageStore(area, changed),
  // The desktop build stores into T3's own localStorage (inject/page-stub.js).
  ...(desktop ? { desktop: true, imageLimits: DESKTOP_IMAGE_LIMITS } : {}),
  botStore: createBotStore(area, changed),
  ...feedDeps(),
  backdropRenderer: createBackdropRenderer({ win: window, doc: document }),
  // The Profiles preview in Settings → t3+ (its own glow, in the color being picked).
  previewRenderer: createBackdropRenderer({ win: window, doc: document, marksPage: false }),
  assetUrl: (path) => chrome.runtime.getURL(path),
  isAlive: () => Boolean(chrome.runtime?.id),
  backup: {
    export: () => exportAll(area, chrome.runtime.getManifest().version),
    import: (data) =>
      importAll(area, data, {
        [STORAGE_KEYS.settings]: normalizeSettings,
        [STORAGE_KEYS.scopes]: normalizeScopes,
        [STORAGE_KEYS.bots]: normalizeBotPrefsMap,
        [STORAGE_KEYS.profiles]: normalizeProfiles,
        [STORAGE_KEYS.knownBots]: normalizeKnownBots,
        [STORAGE_KEYS.manualBots]: normalizeManualBots,
        // The app shrinks a larger one to the desktop's cap first; this is the backstop.
        [STORAGE_KEYS.image]: (record) => normalizeImageRecord(record, desktop ? DESKTOP_IMAGE_LIMITS : IMAGE_LIMITS),
      }),
  },
  // The page copy, per origin (there is no Chrome Sync in the desktop app).
  mirror: () => mirrorToSync({ local: area, sync: null, page, changedEvent: changed }),
});

appRef = app;
window.__t3plusApp = app;
// The synced keys read once: restored when missing, then the profiles and scopes in them
// lifted (their old glow and bubble colors become their settings) before anything reads them.
readSynced(area, { sync, page })
  .catch(() => ({ values: null }))
  .then(({ values }) => migrateProfileColors(area, profileHex, values).catch(() => false))
  .then(() => app.start())
  .catch((error) => {
    console.warn("t3+: failed to start", error);
  });
