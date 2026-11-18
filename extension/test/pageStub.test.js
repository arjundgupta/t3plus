import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { JSDOM } from "jsdom";

// The desktop build's stand-in for chrome.storage (inject/page-stub.js), in T3's own localStorage.
function loadStub() {
  const dom = new JSDOM("<!doctype html><body></body>", { url: "https://app.t3.codes/", runScripts: "outside-only" });
  dom.window.eval(readFileSync(new URL("../../inject/page-stub.js", import.meta.url), "utf8"));
  return dom.window;
}

test("desktop storage stub: like chrome.storage, only changed keys are reported, and a write that does not fit is undone", async () => {
  const win = loadStub();
  const local = win.chrome.storage.local;
  const events = [];
  win.chrome.storage.onChanged.addListener((changes) => events.push(changes));
  await local.set({ a: 1, b: { x: 1 } });
  await local.set({ a: 1 });
  await local.set({ a: 2, b: { x: 1 } });
  await local.remove("missing");
  assert.deepEqual(events.map((c) => Object.keys(c)), [["a", "b"], ["a"]]);
  assert.equal(JSON.stringify(events[1].a), '{"oldValue":1,"newValue":2}'); // objects of the page's realm

  const setItem = win.Storage.prototype.setItem;
  win.Storage.prototype.setItem = function (key, value) {
    if (key.endsWith(":big")) throw new win.DOMException("full", "QuotaExceededError");
    return setItem.call(this, key, value);
  };
  await assert.rejects(local.set({ b: { x: 2 }, big: "x" }), /Not enough room/);
  assert.equal(JSON.stringify((await local.get("b")).b), '{"x":1}', "the part that fitted was undone");
  assert.equal(events.length, 2, "and nothing was reported");
});
