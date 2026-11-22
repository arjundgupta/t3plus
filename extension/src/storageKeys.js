// The chrome.storage.local keys t3+ uses (re-exported by config.js). Its own module, with no
// imports: the background worker reads them (backup.js) and must not evaluate config.js.

export const STORAGE_KEYS = Object.freeze({
  settings: "t3plus.settings.v1",
  /** Settings of one profile and/or machine over the base (src/settingsScopes.js). */
  scopes: "t3plus.scopes.v1",
  /** The sidebar's view (src/statusView.js): { view: "projects" | "status", collapsed: { groupId: bool } }. */
  sidebarView: "t3plus.sidebarView.v1",
  image: "t3plus.image.v1",
  /** Per-bot presentation: shape and color. */
  bots: "t3plus.bots.v1",
  /** Threads made bots by Option-click (no title marker): { "<environmentId>:<threadId>": true }. */
  manualBots: "t3plus.botKeys.v1",
  /** Bot threads seen in the sidebar, so Settings can list them. */
  knownBots: "t3plus.knownBots.v1",
  /** Last good copy of t3plus-bots.json (latest message per bot). */
  botFeedCache: "t3plus.botFeed.cache.v1",
  /** Last good copy of t3plus-home.json (home widget data). */
  homeFeedCache: "t3plus.homeFeed.cache.v1",
  /** Profiles (src/profiles.js): { active, list: [{ id, name, color, sky, icon? }], projects: { projectKey: profileId },
   *  last?: { profileId: threadKey }, adopted? }. */
  profiles: "t3plus.profiles.v2",
  /** The last t3+ version whose What's New was shown (whatsNew.js). */
  whatsNew: "t3plus.whatsNew.v1",
  /** Which window opens it, when several start at once (whatsNew.js). */
  whatsNewClaim: "t3plus.whatsNew.claim.v1",
  /** The release whose update card was hidden (updateNotice.js). */
  updateDismissed: "t3plus.updateDismissed.v1",
  /** The release whose popup on the main screen was closed or followed (updateNotice.js). */
  updateToastSeen: "t3plus.updateToastSeen.v1",
});

/**
 * The field of a stored settings, scopes or view value that names the write which stored it:
 * { id: "<window>:<count>", own: the paths of the leaves its window set itself } (settings.js
 * createStampedStore). Two writes holding the same (a toggle switched off and back on) are
 * still two writes, and a leaf set back to what storage held is still a change: by it a
 * window tells its own writes coming back from another window's, and what that window
 * changed (app.js storeSync). It is not part of the value: the normalizers drop it, and
 * exports and backups leave it out. Values stored before it have none.
 */
export const WRITE_STAMP = "t3plusWrite";

/** `value` without its write stamp: the same object when it has none (an image is never copied). */
export function withoutWriteStamp(value) {
  if (!value || typeof value !== "object" || !Object.hasOwn(value, WRITE_STAMP)) return value;
  const rest = { ...value };
  delete rest[WRITE_STAMP];
  return rest;
}
