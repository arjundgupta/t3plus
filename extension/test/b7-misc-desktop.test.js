import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import * as esbuild from "esbuild";
import { JSDOM, VirtualConsole } from "jsdom";
import { PAGE_BACKUP_KEY } from "../src/backup.js";
import { STORAGE_KEYS } from "../src/config.js";
import { virtualClock } from "./helpers.js";

// The content script as the desktop app runs it: bundled as build-desktop.mjs bundles it, on the
// loader's stand-in for the extension APIs (inject/page-stub.js), whose storage is T3's own
// localStorage.

/** A T3 window with t3+ started in it, and `seed` in its localStorage before. Stopped and closed when the test ends. */
async function startDesktop(t, seed = {}) {
  // build-desktop.mjs's options (unminified here, for readable failures).
  const { outputFiles } = await esbuild.build({
    entryPoints: { content: new URL("../src/content/index.js", import.meta.url).pathname },
    outdir: "out",
    bundle: true,
    format: "iife",
    target: "chrome120",
    define: { __T3PLUS_FEED_BASE__: '""' },
    write: false,
    logLevel: "silent",
  });
  const virtualConsole = new VirtualConsole();
  const errors = [];
  virtualConsole.on("jsdomError", (error) => errors.push(error));
  // t3+ tells the loader it has started (its health): one-way notes as console lines.
  const started = new Promise((resolve) => virtualConsole.on("debug", (line) => String(line).includes('"what":"health"') && resolve()));
  const dom = new JSDOM("<!doctype html><html><head></head><body></body></html>", { url: "https://app.t3.codes/", runScripts: "outside-only", pretendToBeVisual: true, virtualConsole });
  const win = dom.window;
  t.after(() => {
    win.__t3plusApp?.stop();
    win.close();
  });
  for (const [key, value] of Object.entries(seed)) win.localStorage.setItem(key, value);
  win.eval(readFileSync(new URL("../../inject/page-stub.js", import.meta.url), "utf8"));
  win.eval(outputFiles.find((file) => file.path.endsWith("content.js")).text);
  await started;
  assert.deepEqual(errors, []);
  return win;
}

test("desktop: t3+'s storage is T3's localStorage, so no second copy of its settings is kept there, and an old one goes", async (t) => {
  const win = await startDesktop(t, { [PAGE_BACKUP_KEY]: JSON.stringify({ app: "t3plus", savedAt: "2026-11-01T00:00:00.000Z", data: {} }) });
  assert.equal(win.localStorage.getItem(PAGE_BACKUP_KEY), null, "the copy an earlier build kept is gone");
  const clock = virtualClock(win);
  await win.chrome.storage.local.set({ [STORAGE_KEYS.settings]: { glass: { enabled: false } } });
  await clock.advance(2000); // past the copy's 1.5 s wait (backup.js mirrorToSync)
  assert.equal(win.localStorage.getItem(PAGE_BACKUP_KEY), null, "a change is not copied");
  assert.ok(Object.keys(win.localStorage).every((key) => key.startsWith("t3plus-ext:")), "only the stand-in's own keys");
  assert.ok(win.localStorage.getItem(`t3plus-ext:${STORAGE_KEYS.settings}`), "the setting itself is saved");
});
