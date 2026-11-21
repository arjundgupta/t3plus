/** fetchRemote for the extension: asks the background worker, which holds the host permission.
 *  (In the desktop app the loader's stand-in answers the same message.) */
export function createRuntimeFetcher(runtime) {
  return (url) =>
    new Promise((resolve) => {
      try {
        runtime.sendMessage({ type: "t3plus/fetch-config", url }, (response) => {
          const lastError = runtime.lastError;
          resolve(lastError ? { ok: false, status: 0, error: lastError.message } : response);
        });
      } catch (error) {
        resolve({ ok: false, status: 0, error: error instanceof Error ? error.message : String(error) });
      }
    });
}

/**
 * Something answers feed messages: a build with a feed folder, or a stand-in for the
 * worker (the desktop loader, the harness), which answers in the page whatever the
 * build's base. Only the packaged extension's manifest names a background worker, and
 * built without a folder it would only be woken to say "No feed folder".
 */
export const feedsAnswered = (runtime, configured) => configured || !runtime?.getManifest?.()?.background;

/**
 * A read-only JSON feed (the bot feed, the home feed): loaded through fetchRemote, with a
 * copy kept in `area` under `key` for the first paint and for when the feed cannot be
 * reached. `readLocal` instead (the desktop, where the loader already holds the feed in
 * the page): the copy is read from there, and nothing is stored.
 *
 * The same text is parsed once: load() and readCache() then resolve to the same object,
 * so a caller can tell an unchanged feed by identity. A failed fetch resolves to what was
 * last resolved, and reads the stored copy only when there is nothing yet: that copy can
 * be older than the one in memory (its write may have failed).
 */
export function createCachedFeed({ area = null, key, fetchRemote, endpoint, parse, readLocal = null }) {
  let lastText = null;
  let lastParsed = null;
  const parseOnce = (text) => {
    if (text !== lastText) {
      lastText = text;
      lastParsed = parse(text);
    }
    return lastParsed;
  };
  let storedText = null; // the text the area holds, as far as this copy knows
  let last = null; // what load() or readCache() last resolved to
  async function readStored() {
    if (readLocal) return readLocal();
    const text = area ? (await area.get(key))?.[key]?.text : null;
    if (typeof text === "string") storedText = text;
    return text;
  }
  async function readCache() {
    const text = await readStored();
    return (last = typeof text === "string" ? parseOnce(text) : null);
  }
  return {
    endpoint,
    readCache,
    async load() {
      let response = null;
      try {
        response = await fetchRemote(endpoint);
      } catch {
        response = null;
      }
      const parsed = response?.ok ? parseOnce(response.text) : null;
      if (!parsed) return last ?? readCache();
      // The copy is a convenience: a failed write (storage full) must not throw away
      // the fresh feed it was copying. Written only when the text changed.
      if (area && !readLocal && response.text !== storedText) {
        await Promise.resolve(area.set({ [key]: { text: response.text } }))
          .then(() => (storedText = response.text))
          .catch(() => {});
      }
      return (last = parsed);
    },
  };
}
