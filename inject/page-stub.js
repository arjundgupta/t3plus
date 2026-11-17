// Stands in for the Chrome extension APIs t3+ uses, so its content script can run
// inside the T3 Code desktop window. Storage lives in this page's localStorage
// (prefix "t3plus-ext:"). Feeds are handed in by the loader as window.__t3plusFeeds.
(() => {
  if (window.__t3plusStub) {
    // Loaded before this build: add what newer content scripts expect.
    window.__t3plusTell ??= (what, data) => {
      try { console.debug("[t3plus]" + JSON.stringify({ what, ...data })); } catch {}
    };
    return;
  }
  const boot = window.__t3plusBoot || {};
  window.__t3plusFeeds = boot.feeds || {};
  const P = "t3plus-ext:";
  const listeners = new Set();
  const read = (key) => {
    try {
      const raw = localStorage.getItem(P + key);
      return raw === null ? undefined : JSON.parse(raw);
    } catch {
      return undefined;
    }
  };
  // One-way notes to the loader in the app's main process (it listens for these
  // console lines), so nothing has to poll the page.
  const tell = (what, data) => {
    try { console.debug("[t3plus]" + JSON.stringify({ what, ...data })); } catch {}
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
    async set(items) {
      const changes = {};
      for (const [k, v] of Object.entries(items)) {
        changes[k] = { oldValue: read(k), newValue: v };
        localStorage.setItem(P + k, JSON.stringify(v));
      }
      emit(changes);
    },
    async remove(keys) {
      const changes = {};
      for (const k of [].concat(keys)) {
        changes[k] = { oldValue: read(k), newValue: undefined };
        localStorage.removeItem(P + k);
      }
      emit(changes);
    },
  };
  const feedFor = (url) => {
    const f = window.__t3plusFeeds || {};
    if (url.endsWith("/t3plus-home.json")) return f.home;
    if (url.endsWith("/t3plus-bots.json")) return f.bots;
    return null;
  };
  const runtime = {
    id: "t3plus-desktop",
    lastError: undefined,
    getURL: (path) => (String(path).endsWith("sample-spectrum.svg") ? boot.sampleUrl || "" : ""),
    getManifest: () => ({ version: boot.version || "0.0.0" }),
    sendMessage(message, callback) {
      const url = String(message && message.url);
      const kind = url.endsWith("/t3plus-home.json") ? "home" : url.endsWith("/t3plus-bots.json") ? "bots" : null;
      if (kind) tell("ask", { kind });
      const text = feedFor(url);
      const response = typeof text === "string" && text ? { ok: true, status: 200, text } : { ok: false, status: 404 };
      setTimeout(() => callback && callback(response), 0);
    },
  };
  const storage = { local, onChanged: { addListener: (fn) => listeners.add(fn), removeListener: (fn) => listeners.delete(fn) } };
  const host = window.chrome && typeof window.chrome === "object" ? window.chrome : {};
  for (const [k, v] of Object.entries({ runtime, storage })) {
    try { host[k] = v; } catch {}
    if (host[k] !== v) { try { Object.defineProperty(host, k, { value: v, configurable: true }); } catch {} }
  }
  if (window.chrome !== host) { try { window.chrome = host; } catch {} }
  window.__t3plusStub = true;
})();
