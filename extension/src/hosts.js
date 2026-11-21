// Origins and feed URLs t3+ knows. These lists date from the Chrome extension build (now
// removed: t3+ is desktop-only), whose manifest copied them; in the desktop app the
// loader injects t3+ into T3's window and hands the feeds over itself.
//
// HOST_MATCHES: the hosted T3 Code web client, where the extension ran.
export const HOST_MATCHES = Object.freeze(["https://app.t3.codes/*"]);

// FEED_BASE: the folder URL the optional JSON feeds are read from
// (t3plus-bots.json, t3plus-home.json, t3plus-threads.json). The build sets it from
// a feed folder; the desktop build sets none. Left unset, it is a placeholder on the
// reserved .invalid domain and t3+ fetches nothing (the desktop loader hands the feeds over).
/* global __T3PLUS_FEED_BASE__ */
export const DEFAULT_FEED_BASE = "https://feeds.t3plus.invalid/";
const injected = typeof __T3PLUS_FEED_BASE__ === "string" ? __T3PLUS_FEED_BASE__ : "";
export const FEED_BASE = injected || DEFAULT_FEED_BASE;
export const FEEDS_CONFIGURED = FEED_BASE !== DEFAULT_FEED_BASE;

/** The exact feed URLs under a base folder URL. */
export function feedEndpoints(base = FEED_BASE) {
  const root = base.endsWith("/") ? base : `${base}/`;
  return {
    // t3plus-bots.json: the latest message of each bot thread (published by inject/feeds-worker.js).
    bots: `${root}t3plus-bots.json`,
    // t3plus-home.json: pools, activity and usage for the home widgets (server/publish_home.py).
    home: `${root}t3plus-home.json`,
    // t3plus-threads.json: each thread's status, for the sidebar's Status view (the desktop
    // loader publishes it; without it the view shows the threads T3's list shows).
    threads: `${root}t3plus-threads.json`,
  };
}

/**
 * Largest feed accepted, in characters (the home feed allows four times this). Here, not
 * in config.js: the background worker needs only this and the URLs, and a worker that
 * imported config.js evaluated all of its selectors and bot shapes on every start.
 */
export const CONFIG_LIMITS = Object.freeze({ maxChars: 256 * 1024 });

const endpoints = feedEndpoints();
export const BOT_FEED_ENDPOINT = endpoints.bots;
export const HOME_FEED_ENDPOINT = endpoints.home;
export const THREADS_FEED_ENDPOINT = endpoints.threads;

// The feeds the background worker fetches. Not the thread feed: only the desktop loader
// publishes it (the page reads its copy).
const FETCHED_FEEDS = Object.freeze(["bots", "home"]);

/** The fetchable feed URLs under a feed base (the Chrome build's host permissions). */
export function hostPermissionsFor(base) {
  const e = feedEndpoints(base);
  return FETCHED_FEEDS.map((name) => e[name]);
}

/** Every URL the background worker may fetch (the same list as the manifest's host permissions). */
export const FETCH_ENDPOINTS = Object.freeze(hostPermissionsFor(FEED_BASE));
