// Content script entry. Bundled by build.mjs into dist/content.js (an IIFE,
// because MV3 content scripts cannot be ES modules).
//
// Read-only toward T3: this script touches only the DOM of the page and
// extension storage. It does not read cookies or credentials, call T3's
// WebSocket/RPC, or send anything to T3's server. The only reads are the two
// feeds (t3plus-bots.json, t3plus-home.json), fetched by the background worker
// (src/background.js), or handed over by the desktop loader.
import { createT3Plus } from "../app.js";
import { exportAll, importAll, mirrorToSync, restoreBackups } from "../backup.js";
import { createBackdropRenderer } from "../backdropRenderer.js";
import { createBotFeed } from "../botFeed.js";
import { createHomeFeed } from "../homeData.js";
import { createBotStore } from "../bots.js";
import { setBotArtEncoder } from "../botArt.js";
import { createImageStore, normalizeImageRecord } from "../imageStore.js";
import { createRuntimeFetcher } from "../runtimeFetch.js";
import { createSettingsStore, normalizeSettings } from "../settings.js";
import { createProfiles, normalizeProfiles } from "../profiles.js";
import { createWhatsNew } from "../whatsNew.js";
import { normalizeBotPrefsMap, normalizeKnownBots, normalizeManualBots } from "../bots.js";
import { DESKTOP_IMAGE_LIMITS, STORAGE_KEYS } from "../config.js";

const area = chrome.storage.local;
const sync = chrome.storage.sync;
const changed = chrome.storage.onChanged;

const fetchRemote = createRuntimeFetcher(chrome.runtime);

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

// Desktop loader: a newer copy stops the one before it instead of reloading the window.
try {
  window.__t3plusApp?.stop();
} catch {
  // the old copy is gone already
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
    // The open profile's dither color: the glow is drawn again in it.
    onLook: () => appRef?.profilesLook?.(),
    // Loaded or changed (here, in Settings, or in another window): the Settings card follows.
    onChange: () => appRef?.profilesChanged?.(),
  }),
  version: chrome.runtime.getManifest?.().version,
  // After an update, what changed (once); always in Settings → t3+.
  whatsNew: createWhatsNew({ win: window, doc: document, area, version: chrome.runtime.getManifest?.().version }),
  settingsStore: createSettingsStore(area, changed),
  imageStore: createImageStore(area, changed),
  // The desktop build stores into T3's own localStorage (inject/page-stub.js).
  ...(chrome.runtime?.id === "t3plus-desktop" ? { desktop: true, imageLimits: DESKTOP_IMAGE_LIMITS } : {}),
  botStore: createBotStore(area, changed),
  botFeed: createBotFeed({ area, fetchRemote }),
  homeFeed: createHomeFeed({ area, fetchRemote }),
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
        [STORAGE_KEYS.bots]: normalizeBotPrefsMap,
        [STORAGE_KEYS.profiles]: normalizeProfiles,
        [STORAGE_KEYS.knownBots]: normalizeKnownBots,
        [STORAGE_KEYS.manualBots]: normalizeManualBots,
        [STORAGE_KEYS.image]: normalizeImageRecord,
      }),
  },
});

// A fresh install (new version unpacked elsewhere, reinstall, another computer)
// gets its preferences back, from Chrome Sync or the copy in T3's page storage,
// before t3+ reads them. See backup.js.
let page = null;
try {
  page = window.localStorage;
} catch {
  page = null;
}
appRef = app;
window.__t3plusApp = app;
restoreBackups(area, { sync, page })
  .catch(() => [])
  .then(() => {
    mirrorToSync({ local: area, sync, page, changedEvent: changed });
    return app.start();
  })
  .catch((error) => {
    console.warn("t3+: failed to start", error);
  });
