import assert from "node:assert/strict";
import { test } from "node:test";
import { createBotFeed } from "../src/botFeed.js";
import { STORAGE_KEYS, T3PLUS } from "../src/config.js";
import { createHomeFeed } from "../src/homeData.js";
import { createCachedFeed, feedsAnswered } from "../src/runtimeFetch.js";
import { createApp, createDom, createFakeChromeStorage, settle } from "./helpers.js";

/** A storage area that counts its reads and writes, and can be made to refuse writes. */
const countingArea = () => {
  const storage = createFakeChromeStorage();
  const counts = { get: 0, set: 0 };
  const { get, set } = storage.area;
  const area = Object.assign(storage.area, {
    refuse: false,
    get: (keys) => ((counts.get += 1), get(keys)),
    set: (items) => {
      counts.set += 1;
      if (area.refuse) return Promise.reject(new Error("Not enough room"));
      return set(items);
    },
  });
  return { area, counts };
};
const homeText = (generatedAt) => JSON.stringify({ version: 1, generatedAt });

for (const [name, create, key] of [
  ["home", createHomeFeed, STORAGE_KEYS.homeFeedCache],
  ["bot", createBotFeed, STORAGE_KEYS.botFeedCache],
]) {
  const text = (at) => (name === "home" ? homeText(at) : JSON.stringify({ version: 1, generatedAt: at, bots: { t1: { text: at } } }));

  test(`the ${name} feed: a stored copy read back is not written again, the same text is not parsed again, a new one is written once`, async () => {
    const { area, counts } = countingArea();
    area.data.set(key, { text: text("2026-11-16T10:00:00Z") });
    let answer = { ok: true, status: 200, text: text("2026-11-16T10:00:00Z") };
    const feed = create({ area, fetchRemote: async () => answer });
    const cached = await feed.readCache();
    assert.equal(await feed.load(), cached, "the same text as stored: the same object");
    assert.equal(counts.set, 0, "nothing written");
    answer = { ok: true, status: 200, text: text("2026-11-16T10:05:00Z") };
    const fresh = await feed.load();
    assert.notEqual(fresh, cached);
    assert.equal(await feed.load(), fresh);
    assert.equal(counts.set, 1, "the new text, once");
  });

  test(`the ${name} feed: a failed fetch keeps the newest copy, though its write failed, and reads the store once`, async () => {
    const { area, counts } = countingArea();
    area.data.set(key, { text: text("2026-11-10T00:00:00Z") });
    area.refuse = true; // T3's storage is full
    let answer = { ok: true, status: 200, text: text("2026-11-16T00:00:00Z") };
    const feed = create({ area, fetchRemote: async () => answer });
    const fresh = await feed.load();
    answer = { ok: false, status: 0, error: "offline" };
    const reads = counts.get;
    assert.equal(await feed.load(), fresh, "not the older stored copy");
    assert.equal(counts.get, reads, "the store is not read");

    const offline = create({ area, fetchRemote: async () => answer });
    const first = await offline.load();
    assert.equal(first.generatedAt, "2026-11-10T00:00:00Z", "nothing fetched yet: the stored copy");
    const before = counts.get;
    assert.equal(await offline.load(), first);
    assert.equal(counts.get, before, "read once, not on every failed poll");
  });

  test(`the ${name} feed in the desktop app reads the loader's copy, never asks for one, and stores nothing`, async () => {
    const asked = [];
    const feed = create({ area: null, fetchRemote: async (url) => (asked.push(url), { ok: true, status: 200, text: text("2026-11-16T11:00:00Z") }), readLocal: () => text("2026-11-16T10:00:00Z") });
    assert.equal((await feed.readCache()).generatedAt, "2026-11-16T10:00:00Z");
    assert.deepEqual(asked, [], "a read of the copy is no ask (that would have the loader publish)");
    assert.equal((await feed.load()).generatedAt, "2026-11-16T11:00:00Z");
  });
}

test("createCachedFeed without a stored copy or a loader copy resolves to null", async () => {
  const feed = createCachedFeed({ key: "k", endpoint: "e", parse: () => ({}), fetchRemote: async () => ({ ok: false, status: 404 }) });
  assert.equal(await feed.readCache(), null);
  assert.equal(await feed.load(), null);
});

test("feeds are asked for only where something answers: a build with a feed folder, the desktop loader, the harness", () => {
  const extension = { id: "nclf", getManifest: () => ({ version: "1", background: { service_worker: "background.js" } }) };
  assert.equal(feedsAnswered(extension, false), false, "the released extension without a feed folder would only wake its worker");
  assert.equal(feedsAnswered(extension, true), true);
  assert.equal(feedsAnswered({ id: "t3plus-desktop", getManifest: () => ({ version: "1" }) }, false), true, "the desktop stub answers in the page");
  assert.equal(feedsAnswered({ id: "t3plus-harness", getManifest: () => ({ version: "0.0.0-harness" }) }, false), true, "and the harness");
});

const HERO = `<main><div data-workspace-area="conversation"></div>
  <div data-chat-composer-overlay="true" class="flex items-center"><div data-chat-composer-stack="true"><div data-chat-composer-surface="true"></div></div></div></main>`;

test("without a feed source the home cards are not mounted: no cards that wait forever, T3's own usage rows stay", async () => {
  const dom = createDom("/draft/abc", HERO);
  const doc = dom.window.document;
  const { app } = createApp(dom);
  await app.start();
  app.watcher.flush();
  assert.equal(doc.getElementById(T3PLUS.homeId), null);
  assert.equal(doc.documentElement.hasAttribute(T3PLUS.homeAttr), false);
  assert.ok(!doc.body.textContent.includes("Waiting for the home feed"));
  app.stop();
});

test("a home feed read back unchanged runs no check", async () => {
  const dom = createDom("/draft/abc", HERO);
  const feed = { generatedAt: "x" };
  let reads = 0;
  const { app } = createApp(dom, createFakeChromeStorage(), { homeFeed: { readCache: async () => feed, load: async () => ((reads += 1), feed) } });
  await app.start();
  await settle();
  app.watcher.flush();
  await settle();
  reads = 0;
  const scheduled = [];
  const schedule = app.watcher.schedule;
  app.watcher.schedule = () => (scheduled.push(1), schedule());
  app.feedsUpdated(["home"]);
  await settle();
  assert.equal(reads, 1);
  assert.equal(scheduled.length, 0, "the same feed: nothing to draw");
  app.stop();
});
