import assert from "node:assert/strict";
import { test } from "node:test";
import { createHealth, GRACE_MS } from "../src/health.js";
import { createDom } from "./helpers.js";

test("health: a renamed composer stack on the new-thread page is still reported (the page is found without it)", () => {
  const dom = createDom(
    "/draft/abc",
    `<div data-chat-composer-overlay="true" class="flex items-center"><div data-chat-composer-stack-v2="true"><div class="absolute bottom-full">Let's build</div></div></div>`,
  );
  let t = 0;
  const win = { performance: { now: () => t }, setTimeout: () => 1, clearTimeout: () => {} };
  const health = createHealth({ win, doc: dom.window.document, routePath: () => "/draft/abc" });
  health.check();
  t = GRACE_MS + 1;
  const home = health.check().find((p) => p.feature === "New-thread page widgets");
  assert.deepEqual(home?.missing, ["composer stack"]);
});

test("the bot breadcrumb heading is named by the bot, not its marker read out with the name twice; undecorated, it is T3's again", async () => {
  const { decorateBotBreadcrumb } = await import("../src/bots.js");
  const dom = createDom("/", `<nav aria-label="Thread breadcrumb"><h2>[[t3plus:bot:v1]] Orchestrator</h2></nav><nav aria-label="Thread breadcrumb" id="other"><h2 aria-label="T3's own">x</h2></nav>`);
  const doc = dom.window.document;
  const [heading, labelled] = doc.querySelectorAll("h2");
  const bot = { key: "env1:b", titleLabel: "Orchestrator", status: "idle", thread: { title: "[[t3plus:bot:v1]] Orchestrator" }, prefs: { color: "blue" } };
  decorateBotBreadcrumb(doc, bot);
  assert.equal(heading.getAttribute("aria-label"), "Orchestrator");
  decorateBotBreadcrumb(doc, null);
  assert.equal(heading.hasAttribute("aria-label"), false);
  heading.remove();
  decorateBotBreadcrumb(doc, bot); // the other heading now: its own label stays
  assert.equal(labelled.getAttribute("aria-label"), "T3's own");
});

test("screenshot mode and profiles take T3's hooks from config.js (a rename there reaches them)", async () => {
  const { readFileSync } = await import("node:fs");
  const hook = /data-(sidebar|thread|timeline|slot|composer|message|chat|settings|workspace|draft|v2|stage)[a-z-]*|aria-label[\^$*]?=|\.(truncate|relative|grid|grayscale|text-xs|font-mono|chat-markdown)\b/;
  for (const file of ["demoMode.js", "profiles.js"]) {
    const source = readFileSync(new URL(`../src/${file}`, import.meta.url), "utf8");
    const literals = [...source.matchAll(/(["'`])((?:\\.|(?!\1).)*?)\1/g)].map((m) => m[2]).filter((text) => hook.test(text));
    assert.deepEqual(literals, [], file);
  }
});

test("a profile's most recent thread: a comma in a title hides no Working, and a title like '3m' is no age", async () => {
  const { createProfiles } = await import("../src/profiles.js");
  const { STORAGE_KEYS } = await import("../src/config.js");
  const { createFakeChromeStorage } = await import("./helpers.js");
  const folder = (key) => `<li data-testid="sidebar-project-folder"><button data-sidebar-row="folder:${key}" aria-expanded="true"><span class="truncate">${key}</span></button></li>`;
  const thread = (key, title, status, age) =>
    `<li data-thread-item="${key}"><div role="button" data-sidebar-row="${key}" data-sidebar-parent="folder:p/b" aria-label="${[title, status, "b"].filter(Boolean).join(", ")}"><span dir="auto">${title}</span><span>${age}</span></div></li>`;
  const run = async (rows) => {
    const dom = createDom("/env/a1", `<div data-slot="sidebar-inner"><ul>${folder("p/a")}<li data-thread-item="env:a1"><div role="button" data-sidebar-row="env:a1" data-sidebar-parent="folder:p/a" aria-label="a1"><span dir="auto">a1</span></div></li>${folder("p/b")}${rows}</ul><div data-slot="sidebar-footer"></div></div>`);
    const win = dom.window;
    win.document.addEventListener("click", (e) => {
      const row = e.target.closest?.("[data-thread-item] [data-sidebar-row]");
      if (row) win.history.pushState({}, "", `/${row.getAttribute("data-sidebar-row").replace(":", "/")}`);
    });
    const storage = createFakeChromeStorage();
    storage.area.data.set(STORAGE_KEYS.profiles, { active: "main", list: [{ id: "main", name: "Main" }, { id: "work", name: "Work" }], projects: { "p/a": "main", "p/b": "work" }, adopted: true });
    const profiles = createProfiles({ win, doc: win.document, area: storage.area, changedEvent: storage.onChanged });
    await profiles.start();
    profiles.switchTo("work");
    const route = win.location.pathname;
    profiles.stop();
    return route;
  };
  assert.equal(await run(thread("env:b1", "Fix login, add tests", "Working", "") + thread("env:b2", "Idle one", "", "5m")), "/env/b1", "the Working thread");
  assert.equal(await run(thread("env:b1", "3m", "", "2w") + thread("env:b2", "Recent", "", "1h")), "/env/b2", "1h beats a two-week-old thread titled 3m");
});

test("the CSS dither tile and the chart fills share one 8x8 Bayer table, in the phase both were drawn in", async () => {
  const { BAYER_8 } = await import("../src/ditherMath.js");
  assert.deepEqual(BAYER_8[0], [0, 48, 12, 60, 3, 51, 15, 63]);
  assert.deepEqual(BAYER_8[7], [42, 26, 38, 22, 41, 25, 37, 21]);
  const { createHash } = await import("node:crypto");
  const { BAYER_DITHER_DATA_URL } = await import("../src/dither.js");
  assert.equal(createHash("sha256").update(BAYER_DITHER_DATA_URL).digest("hex"), "2f3e5717210b5e0a23b477f782f56597da565ee1260025d152325cec8292018f", "the tile byte for byte");
});
