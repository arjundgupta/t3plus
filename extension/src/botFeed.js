import { BOT_LIMITS, CONFIG_LIMITS, STORAGE_KEYS } from "./config.js";
import { BOT_FEED_ENDPOINT } from "./hosts.js";

// t3plus-bots.json: the latest message of each bot thread, published by
// server/publish_bot_feed.py (read-only on T3's database). Format v1:
//   { version: 1, generatedAt, environmentId,
//     bots: { "<threadId>": { text, role, at, model?, effort?, computer?,
//                              subagents?: [{ title, status }] } } }
// subagents: the latest run's subagents while any of them is still working.
// Keyed by thread id (the part of the sidebar key after "<environmentId>:").

/** @returns {{ entries: Map<string, { text, role, at }>, generatedAt: string | null } | null} */
export function parseBotFeedText(text) {
  if (typeof text !== "string" || !text.trim() || text.length > CONFIG_LIMITS.maxChars) return null;
  let raw;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== "object" || raw.version !== 1 || !raw.bots || typeof raw.bots !== "object") return null;
  const entries = new Map();
  for (const [threadId, entry] of Object.entries(raw.bots).slice(0, BOT_LIMITS.maxBots * 4)) {
    if (!entry || typeof entry !== "object" || !threadId || /\s/.test(threadId)) continue;
    const short = (v, max) => (typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, max) : "");
    const clean = short(entry.text, BOT_LIMITS.maxPreviewChars);
    const model = short(entry.model, 32);
    const computer = short(entry.computer, 32);
    const subagents = (Array.isArray(entry.subagents) ? entry.subagents : [])
      .slice(0, 12)
      .filter((s) => s && typeof s === "object")
      .map((s) => ({ title: short(s.title, 60), status: short(s.status, 16) }));
    const spendUsd = Number(entry.spend?.usd);
    const spendTokens = Number(entry.spend?.tokens);
    const spend = Number.isFinite(spendUsd) && Number.isFinite(spendTokens) && spendTokens > 0 ? { usd: Math.max(0, spendUsd), tokens: Math.max(0, Math.round(spendTokens)) } : null;
    // Kept even when empty: an entry says the feed covers the thread (it has no
    // messages yet); a thread with none is one the feed does not cover.
    entries.set(threadId, {
      text: clean,
      role: entry.role === "user" ? "user" : "assistant",
      at: typeof entry.at === "string" ? entry.at.slice(0, 40) : null,
      model,
      computer,
      subagents,
      spend,
    });
  }
  return { entries, generatedAt: typeof raw.generatedAt === "string" ? raw.generatedAt.slice(0, 40) : null };
}

/** Thread id from a sidebar key "<environmentId>:<threadId>" (thread ids may contain ":"). */
export const threadIdFromKey = (key) => {
  const i = String(key).indexOf(":");
  return i < 0 ? String(key) : String(key).slice(i + 1);
};

/**
 * Preview line for a bot row: "You: …" for the user's own last message. Empty for a
 * thread the feed does not cover (a publisher that only covers marked threads, a
 * remote environment, beyond its cap): "No messages yet" only when it says so.
 */
export function botPreviewText(feed, key) {
  const entry = feed?.entries.get(threadIdFromKey(key));
  if (!entry) return "";
  if (!entry.text) return "No messages yet";
  return entry.role === "user" ? `You: ${entry.text}` : entry.text;
}

/** What the thread has cost so far ({ usd, tokens }), or null. */
export function threadSpend(feed, key) {
  return feed?.entries.get(threadIdFromKey(key))?.spend ?? null;
}

/** The bot's subagents while any is working ([] otherwise). */
export function botSubagents(feed, key) {
  return feed?.entries.get(threadIdFromKey(key))?.subagents ?? [];
}

/** "GPT-6.1 Sol · studio-mac": the bot's model and computer, from the feed. */
export function botMetaText(feed, key) {
  const entry = feed?.entries.get(threadIdFromKey(key));
  return entry ? [entry.model, entry.computer].filter(Boolean).join(" · ") : "";
}

/**
 * Loads the feed through the background worker, falling back to the cached
 * copy. load() resolves to the parsed feed or null.
 */
export function createBotFeed({ area, fetchRemote, endpoint = BOT_FEED_ENDPOINT }) {
  let cachedText = null; // what this copy last wrote to the cache
  async function readCache() {
    const value = (await area.get(STORAGE_KEYS.botFeedCache))?.[STORAGE_KEYS.botFeedCache];
    return typeof value?.text === "string" ? parseBotFeedText(value.text) : null;
  }
  return {
    endpoint,
    readCache,
    async load() {
      let response;
      try {
        response = await fetchRemote(endpoint);
      } catch {
        response = null;
      }
      const parsed = response?.ok ? parseBotFeedText(response.text) : null;
      if (parsed) {
        // The cache is a convenience: a failed write (storage full) must not throw
        // away the fresh feed it was copying. Written only when the text changed: on
        // the desktop it is T3's own localStorage, read and written on its main thread.
        if (response.text !== cachedText) {
          await Promise.resolve(area.set({ [STORAGE_KEYS.botFeedCache]: { text: response.text } }))
            .then(() => (cachedText = response.text))
            .catch(() => {});
        }
        return parsed;
      }
      return readCache();
    },
  };
}
