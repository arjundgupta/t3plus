// Stands in for the Chrome extension APIs t3+ uses, so its content script can run
// inside the T3 Code desktop window. Storage lives in this page's localStorage
// (prefix "t3plus-ext:"). Feeds are handed in by the loader as window.__t3plusFeeds.
(() => {
  const boot = window.__t3plusBoot || {};
  // One-way notes to the loader in the app's main process (it listens for these
  // console lines), so nothing has to poll the page.
  const tell = (what, data) => {
    try { console.debug("[t3plus]" + JSON.stringify({ what, ...data })); } catch {}
  };
  // A feed asked for (chrome.runtime.sendMessage({ url: ".../t3plus-<kind>.json" })) is
  // answered with the loader's copy, and the loader hears it was asked for: it publishes
  // a fresh one when the copy is old.
  const FEED = /\/t3plus-(bots|home|threads)\.json$/;
  const sendMessage = (message, callback) => {
    const kind = (FEED.exec(String(message && message.url)) || [])[1] || null;
    if (kind) tell("ask", { kind });
    const text = kind ? (window.__t3plusFeeds || {})[kind] : null;
    const response = typeof text === "string" && text ? { ok: true, status: 200, text } : { ok: false, status: 404 };
    setTimeout(() => callback && callback(response), 0);
  };
  window.__t3plusFeeds = boot.feeds || {};
  const P = "t3plus-ext:";
  const listeners = new Set();
  const parseRaw = (raw) => {
    try {
      return raw === null ? undefined : JSON.parse(raw);
    } catch {
      return undefined;
    }
  };
  const stored = (key) => {
    try {
      return localStorage.getItem(P + key);
    } catch {
      return null;
    }
  };
  const read = (key) => parseRaw(stored(key));
  // A change record whose values are parsed when a listener reads them, not before: the
  // feed caches and an image are large, and most changes are of keys nobody listens to.
  const lazyChange = (oldRaw, newRaw) => {
    const change = {};
    for (const [name, initial] of [["oldValue", oldRaw], ["newValue", newRaw]]) {
      let raw = initial;
      let value;
      let done = false;
      Object.defineProperty(change, name, { enumerable: true, get: () => (done ? value : ((done = true), (value = parseRaw(raw)), (raw = null), value)) });
    }
    return change;
  };
  // t3+ itself reports which threads are bots (window.__t3plusTell("bots", { keys })):
  // with every thread a bot by default, the stored list holds only the exceptions.
  window.__t3plusTell = tell;
  const emit = (changes) => {
    for (const fn of [...listeners]) {
      try { fn(changes, "local"); } catch (e) { console.warn("t3+ stub listener", e); }
    }
  };
  // Left behind by features this build no longer has (profile tabs).
  for (const gone of ["t3plus.profileView.v1", "t3plus.config.cache.v1", "t3plus.config.local.v1"]) {
    try { localStorage.removeItem(P + gone); } catch {}
  }
  const allKeys = () => Object.keys(localStorage).filter((k) => k.startsWith(P)).map((k) => k.slice(P.length));
  const local = {
    async get(keys) {
      const list = keys == null ? allKeys() : typeof keys === "string" ? [keys] : Array.isArray(keys) ? keys : Object.keys(keys);
      const out = {};
      for (const k of list) {
        const v = read(k);
        if (v !== undefined) out[k] = v;
        else if (keys && typeof keys === "object" && !Array.isArray(keys) && keys[k] !== undefined) out[k] = keys[k];
      }
      return out;
    },
    // Like chrome.storage: all of a set or none of it, and only keys whose value
    // changed are reported. localStorage is T3's own, with one budget for both: a
    // write that does not fit is undone and fails with a message, not half-saved.
    async set(items) {
      const changes = {};
      const written = [];
      try {
        for (const [k, v] of Object.entries(items)) {
          if (v === undefined) continue;
          const raw = JSON.stringify(v);
          const before = localStorage.getItem(P + k);
          if (before === raw) continue;
          localStorage.setItem(P + k, raw);
          written.push([k, before]);
          changes[k] = lazyChange(before, raw);
        }
      } catch (error) {
        for (const [k, before] of written.reverse()) {
          try {
            if (before === null) localStorage.removeItem(P + k);
            else localStorage.setItem(P + k, before);
          } catch {}
        }
        const full = error && (error.name === "QuotaExceededError" || error.code === 22);
        throw new Error(full ? "Not enough room left in T3's storage to save this. Try a smaller image." : String((error && error.message) || error));
      }
      if (Object.keys(changes).length) emit(changes);
    },
    async remove(keys) {
      const changes = {};
      for (const k of [].concat(keys)) {
        // Any stored text, one that no longer parses too (it could never be removed before).
        const before = stored(k);
        if (before === null) continue;
        changes[k] = lazyChange(before, null);
        localStorage.removeItem(P + k);
      }
      if (Object.keys(changes).length) emit(changes);
    },
  };
  const runtime = {
    id: "t3plus-desktop",
    lastError: undefined,
    getURL: (path) => (String(path).endsWith("sample-spectrum.svg") ? boot.sampleUrl || "" : String(path).endsWith("sample-spectrum-light.svg") ? boot.sampleLightUrl || "" : ""),
    getManifest: () => ({ version: boot.version || "0.0.0" }),
    sendMessage,
  };
  // Another T3 window shares this localStorage: its saves arrive here as "storage"
  // events and are passed on like this window's own, so both stay in step (and
  // neither saves over the other with what it had before).
  if (window.__t3plusStorageRelay) window.removeEventListener("storage", window.__t3plusStorageRelay);
  window.__t3plusStorageRelay = (event) => {
    if (event.storageArea !== localStorage || !event.key || !event.key.startsWith(P)) return;
    emit({ [event.key.slice(P.length)]: lazyChange(event.oldValue, event.newValue) });
  };
  window.addEventListener("storage", window.__t3plusStorageRelay);
  const storage = { local, onChanged: { addListener: (fn) => listeners.add(fn), removeListener: (fn) => listeners.delete(fn) } };
  const host = window.chrome && typeof window.chrome === "object" ? window.chrome : {};
  for (const [k, v] of Object.entries({ runtime, storage })) {
    try { host[k] = v; } catch {}
    if (host[k] !== v) { try { Object.defineProperty(host, k, { value: v, configurable: true }); } catch {} }
  }
  if (window.chrome !== host) { try { window.chrome = host; } catch {} }
})();
