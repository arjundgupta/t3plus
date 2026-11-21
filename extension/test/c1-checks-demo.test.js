import assert from "node:assert/strict";
import { test } from "node:test";
import { STORAGE_KEYS } from "../src/config.js";
import { createDemoMode } from "../src/demoMode.js";
import { createApp, createDom, createFakeChromeStorage, sidebarHtml } from "./helpers.js";

const TIMELINE = `<div class="messages-timeline-scroll"><div id="list" style="position:relative">
  <div data-timeline-row-id="a1" data-timeline-row-kind="message" data-message-role="assistant"><div class="chat-markdown"><p id="p1">Private reply about the Acme merger.</p></div></div>
  <div data-timeline-row-id="w1" data-timeline-row-kind="work-live"><div><span id="w">Searched the payroll ledger for Priya</span></div></div>
</div></div>`;
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

async function demoApp(body) {
  const storage = createFakeChromeStorage();
  storage.area.data.set(STORAGE_KEYS.settings, { demo: { enabled: true } });
  const dom = createDom("/env1/x1", body);
  const { app } = createApp(dom, storage, { throttleMs: 0 });
  await app.start();
  app.watcher.flush();
  await tick();
  return { app, doc: dom.window.document };
}

test("screenshot mode: a streamed token and a row mounted as the list scrolls are covered before paint, with no full check for them", async () => {
  const { app, doc } = await demoApp(sidebarHtml() + TIMELINE);
  assert.ok(!doc.getElementById("p1").textContent.includes("Acme"), "covered by the first pass");
  const checks = app.perf.checks;
  doc.getElementById("p1").firstChild.nodeValue = "Streaming: the Acme merger closes Friday";
  await tick();
  assert.ok(!doc.getElementById("p1").textContent.includes("Acme"), doc.getElementById("p1").textContent);
  const row = doc.createElement("div");
  row.setAttribute("data-timeline-row-id", "u9");
  row.setAttribute("data-timeline-row-kind", "message");
  row.setAttribute("data-message-role", "user");
  row.innerHTML = `<p id="u9">Book my dentist for Tuesday</p>`;
  doc.getElementById("list").append(row);
  await tick();
  assert.ok(!doc.getElementById("u9").textContent.includes("dentist"), doc.getElementById("u9").textContent);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(app.perf.checks, checks, "the timeline alone changed: no full check");
  // A row that turns into a finished work row with the same text: the next full pass applies its rules.
  doc.querySelector('[data-timeline-row-id="w1"]').setAttribute("data-timeline-row-kind", "work");
  app.watcher.flush();
  assert.ok(!doc.getElementById("w").textContent.includes("Priya"), doc.getElementById("w").textContent);
  // Off: every real text back.
  await app.actions.setDemo(false);
  app.watcher.flush();
  assert.equal(doc.getElementById("p1").textContent, "Streaming: the Acme merger closes Friday");
  assert.equal(doc.getElementById("u9").textContent, "Book my dentist for Tuesday");
  assert.equal(doc.getElementById("w").textContent, "Searched the payroll ledger for Priya");
  app.stop();
});

test("screenshot mode: a full pass reads an unchanged timeline row whole and walks none of it; a changed one alone is walked", () => {
  const rows = Array.from({ length: 60 }, (_, i) => `<div data-timeline-row-id="m${i}" data-timeline-row-kind="message" data-message-role="${i % 2 ? "assistant" : "user"}"><div class="chat-markdown"><p id="p${i}">Private text ${i} about my bank</p><pre><code>const secretValue${i} = 1;</code></pre></div></div>`).join("");
  const dom = createDom("/", `<div class="messages-timeline-scroll">${rows}</div>`);
  const doc = dom.window.document;
  const demo = createDemoMode(doc);
  demo.apply({});
  let walks = 0;
  const real = doc.createTreeWalker.bind(doc);
  doc.createTreeWalker = (root, ...rest) => {
    if (root.closest?.("[data-timeline-row-id]")) walks += 1;
    return real(root, ...rest);
  };
  demo.apply({});
  assert.equal(walks, 0, "nothing changed: no row walked");
  doc.getElementById("p7").firstChild.nodeValue = "New private text from the bank";
  demo.apply({});
  assert.equal(walks, 1, "one row changed: that row walked");
  assert.ok(!doc.getElementById("p7").textContent.includes("bank"));
  demo.restore();
  assert.equal(doc.getElementById("p7").textContent, "New private text from the bank");
  demo.apply({});
  assert.ok(!doc.getElementById("p3").textContent.includes("bank"), "on again after restore: covered again");
});

test("screenshot mode: a menu portaled to <body> is covered, and the app's root is not searched for portals", () => {
  // Put together here: a home folder written out would stop the public mirror's privacy check.
  const homePath = ["", "Users", "sam", "work"].join("/");
  const dom = createDom("/", `<div id="root"><div role="menu"><span>Moved to github.com/acme/secret-repo</span></div></div><div role="menu"><div><span>From ${homePath}</span></div></div>`);
  const doc = dom.window.document;
  const demo = createDemoMode(doc);
  const searched = [];
  const real = dom.window.Element.prototype.querySelectorAll;
  dom.window.Element.prototype.querySelectorAll = function (...args) {
    if (String(args[0]).includes('[role="menu"]')) searched.push(this);
    return real.apply(this, args);
  };
  try {
    demo.apply({});
  } finally {
    dom.window.Element.prototype.querySelectorAll = real;
  }
  assert.equal(searched.includes(doc.body) || searched.includes(doc.getElementById("root")), false, "only <body>'s own children other than the root");
  assert.ok(!doc.body.lastElementChild.textContent.includes(homePath), doc.body.lastElementChild.textContent);
});

test("text streaming into a side chat's timeline (a second message list) runs no check, while a list put in or taken out does", async () => {
  const lists = `<div class="messages-timeline-scroll" id="main"><div id="m"></div></div><aside><div class="messages-timeline-scroll" id="side"><div id="s"></div></div></aside>`;
  const dom = createDom("/env1/x1", sidebarHtml() + lists);
  const doc = dom.window.document;
  const { app } = createApp(dom, createFakeChromeStorage(), { throttleMs: 0 });
  await app.start();
  app.watcher.flush();
  await new Promise((resolve) => setTimeout(resolve, 20));
  const checks = app.perf.checks;
  for (const id of ["m", "s"]) {
    for (let i = 0; i < 5; i += 1) doc.getElementById(id).append(doc.createTextNode(`chunk ${i} `));
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(app.perf.checks, checks, "streaming in either list: no check");
  doc.querySelector("aside").append(Object.assign(doc.createElement("div"), { className: "messages-timeline-scroll" }));
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.ok(app.perf.checks > checks, "a list mounted: checked");
  app.stop();
});
