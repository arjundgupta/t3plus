import assert from "node:assert/strict";
import { test } from "node:test";
import { setAttr, setHidden, setVar } from "../src/dom.js";
import { createDom } from "./helpers.js";

// The shared write-if-changed helpers (dom.js): a write of the same value still restyles
// an element, so none is made.

test("dom: setAttr, setVar and setHidden write only what changes, and null removes", () => {
  const { document: doc, MutationObserver } = createDom("/", "").window;
  const el = doc.createElement("span");
  doc.body.append(el);
  const observer = new MutationObserver(() => {});
  observer.observe(el, { attributes: true });
  const writes = () => observer.takeRecords().length;

  setAttr(el, "aria-label", "Ops");
  setVar(el, "--t3plus-bot-fill", "red");
  setHidden(el, true);
  assert.equal(writes(), 3);
  assert.equal(el.getAttribute("aria-label"), "Ops");
  assert.equal(el.style.getPropertyValue("--t3plus-bot-fill"), "red");
  assert.equal(el.hidden, true);

  setAttr(el, "aria-label", "Ops");
  setVar(el, "--t3plus-bot-fill", "red");
  setHidden(el, true);
  setAttr(el, "data-missing", null);
  setAttr(el, "data-missing", undefined);
  setVar(el, "--t3plus-missing", null);
  assert.equal(writes(), 0, "the same values: nothing written");

  setAttr(el, "aria-label", null);
  setVar(el, "--t3plus-bot-fill", null);
  setHidden(el, false);
  assert.equal(writes(), 3);
  assert.equal(el.hasAttribute("aria-label"), false);
  assert.equal(el.getAttribute("style"), "");
  assert.equal(el.hidden, false);
});
