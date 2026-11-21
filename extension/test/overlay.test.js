// The overlay must stay small: t3+ decorates T3's own rows in place and adds
// nothing else to the sidebar. These tests use T3's current card
// row markup (SidebarThreadRow.tsx, card variant) and check content.css sizes.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { T3PLUS } from "../src/config.js";
import { blocksFor, createApp, createDom, ruleBody } from "./helpers.js";

const css = await readFile(new URL("../src/styles/content.css", import.meta.url), "utf8");
const attr = (v) => String(v).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");

/** One row shaped like T3's card variant: sr-only title first, three lines, visible title on line 2. */
function cardRowHtml({ key, title, project, status = null, time = "5h", branch = "main", pinned = false }) {
  const label = [title, status, project].filter(Boolean).join(", ");
  return `
    <li data-thread-item="${attr(key)}" class="list-none py-0.5">
      <div role="button" tabindex="0" data-sidebar-row="${attr(key)}" aria-label="${attr(label)}" data-testid="sidebar-row-card"
           class="group/sidebar-row relative w-full cursor-pointer overflow-hidden rounded-md">
        <span class="sr-only">${attr(title)}</span>
        <div class="relative z-10 h-[4.875rem]">
          <div class="flex h-5 min-w-0 items-center gap-1.5">
            <img class="size-4 shrink-0" alt="">${pinned ? '<svg role="img" aria-label="Pinned"></svg>' : ""}
            <span class="min-w-0 flex-1 truncate text-xs">${attr(project)}</span>
            <span class="ml-auto flex h-5"><span class="flex items-center">${attr(status ?? time)}</span></span>
          </div>
          <div class="mt-1 flex min-w-0 items-center gap-1.5">
            <span aria-hidden="true" dir="auto" class="min-w-0 flex-1 truncate text-sm font-medium">${attr(title)}</span>
          </div>
          <div class="mt-0.5 flex min-w-0 items-center gap-1.5 text-xs"><span class="flex min-w-0 flex-1">${attr(branch)}</span></div>
        </div>
      </div>
    </li>`;
}

const BOT = { key: "env1:bot1", title: "[[t3plus:bot:v1]] Orchestrator", project: "ops", status: "Working", pinned: true };
const PLAIN = [
  { key: "env1:a1", title: "Fix login redirect", project: "acme-api", pinned: true },
  { key: "env1:w1", title: "Landing page hero", project: "acme-web", status: "Approval" },
  { key: "env2:n1", title: "Weekly notes", project: "notes" },
];

function cardSidebarHtml() {
  return `
  <div data-slot="sidebar-container">
    <div data-sidebar="sidebar" data-slot="sidebar-inner">
      <div class="relative flex h-[var(--workspace-topbar-height)]" id="t3-topbar">T3 Code</div>
      <div class="w-full shrink-0" id="t3-search"><div data-slot="sidebar-group"><input type="search" aria-label="Search threads"></div></div>
      <div data-slot="scroll-area" id="t3-scroll">
        <div data-slot="scroll-area-viewport">
          <div data-sidebar="content" data-slot="sidebar-content">
            <div data-slot="sidebar-group"><ul role="presentation" id="thread-list">${[BOT, ...PLAIN].map(cardRowHtml).join("")}</ul></div>
          </div>
        </div>
      </div>
      <div data-slot="sidebar-footer" id="t3-footer"></div>
    </div>
  </div>`;
}

const rowKeys = (doc) => [...doc.querySelectorAll("#thread-list > li")].map((li) => li.getAttribute("data-thread-item"));

test("a marked bot row is decorated in place; untagged rows and row order are untouched", async () => {
  const dom = createDom("/env1/a1", cardSidebarHtml());
  const doc = dom.window.document;
  const before = Object.fromEntries(PLAIN.map((t) => [t.key, doc.querySelector(`[data-thread-item="${t.key}"]`).outerHTML]));
  const botLi = doc.querySelector('[data-thread-item="env1:bot1"]');
  const botRow = botLi.querySelector("[data-sidebar-row]");
  const order = rowKeys(doc);
  let clicks = 0;
  botRow.addEventListener("click", () => (clicks += 1));

  const { app } = createApp(dom);
  await app.start();
  app.watcher.flush();

  // Untagged rows: byte-for-byte the same.
  for (const t of PLAIN) assert.equal(doc.querySelector(`[data-thread-item="${t.key}"]`).outerHTML, before[t.key], t.key);
  // Same nodes, same order, nothing cloned or re-parented.
  assert.deepEqual(rowKeys(doc), order);
  assert.equal(doc.querySelector('[data-thread-item="env1:bot1"]'), botLi);
  assert.equal(doc.querySelectorAll('[data-thread-item="env1:bot1"]').length, 1);

  // The bot row keeps T3's role, focus order, label, title text and click handler.
  assert.equal(botRow.getAttribute("role"), "button");
  assert.equal(botRow.getAttribute("tabindex"), "0");
  assert.equal(botRow.getAttribute("aria-label"), "[[t3plus:bot:v1]] Orchestrator, Working, ops");
  assert.equal(botRow.querySelector(".sr-only").textContent, BOT.title);
  const title = botRow.querySelector(`[${T3PLUS.botTitleAttr}]`);
  assert.equal(title.textContent, BOT.title, "T3's visible title text is not rewritten");
  assert.equal(title.getAttribute(T3PLUS.botTitleAttr), "", "no feed loaded: no preview text");
  assert.equal(botRow.querySelector("[data-t3plus-bot-top]").getAttribute("data-t3plus-bot-name"), "Orchestrator");
  botRow.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
  assert.equal(clicks, 1);

  // The row itself remains T3-owned; t3+ adds only the avatar, no BOT pill or shortcut.
  const owned = botRow.querySelectorAll(`[${T3PLUS.ownedAttr}]`);
  assert.deepEqual([...owned].map((el) => el.className), ["t3plus-bot-avatar"]);
  for (const el of owned) assert.equal(el.getAttribute("aria-hidden"), "true");
  assert.equal(botRow.querySelector(".t3plus-bot-chip"), null);
  app.stop();
});

test("the bot avatar is the only element t3+ adds to the sidebar's rows (and the Status view's button, in its footer)", async () => {
  const dom = createDom("/env1/a1", cardSidebarHtml());
  const doc = dom.window.document;
  const { app } = createApp(dom);
  await app.start();
  app.watcher.flush();

  const inner = doc.querySelector('[data-slot="sidebar-inner"]');
  assert.deepEqual([...inner.children].map((el) => el.id), ["t3-topbar", "t3-search", "t3-scroll", "t3-footer"], "T3's own layout, untouched");
  const extras = [...inner.querySelectorAll(`[${T3PLUS.ownedAttr}], [id^="t3plus"], [class*="t3plus"]`)];
  const footer = doc.getElementById("t3-footer");
  assert.deepEqual(extras.filter((el) => !footer.contains(el)).map((el) => el.className), ["t3plus-bot-avatar", "t3plus-bot-face"], "the avatar and its face inside it (no badge: Status badges is off)");
  assert.deepEqual(extras.filter((el) => footer.contains(el)).map((el) => el.className), ["t3plus-status-toggle-row", "t3plus-status-toggle"], "the view's button: no profile dots to sit beside");
  for (const el of extras.filter((x) => !footer.contains(x))) assert.equal(el.closest("[data-sidebar-row]").getAttribute("data-sidebar-row"), "env1:bot1");
  assert.equal(inner.querySelectorAll("[hidden]").length, 0, "no row is hidden");
  app.stop();
});

// ---------- content.css sizes ----------

const rem = (body, prop) => {
  const match = body.match(new RegExp(`(?:^|[;\\s])${prop}:\\s*([\\d.]+)rem`));
  assert.ok(match, `${prop} in rem`);
  return Number(match[1]);
};

test("bot rows: a 1.875rem avatar, name + a one-line truncated preview, same compact height for every bot", () => {
  const avatar = ruleBody(".t3plus-bot-avatar");
  assert.equal(rem(avatar, "width"), 1.875);
  assert.equal(rem(avatar, "height"), 1.875);
  assert.match(avatar, /pointer-events:\s*none/);
  const preview = ruleBody("[data-t3plus-bot-title]::after");
  assert.match(preview, /white-space:\s*nowrap/);
  assert.match(preview, /text-overflow:\s*ellipsis/);
  assert.equal(rem(preview, "line-height"), 1.25, "same height as T3's title line");
  assert.ok(blocksFor("[data-t3plus-bot").every(({ body }) => !/line-clamp:\s*2/.test(body)), "no two-line previews");
  assert.doesNotMatch(css, /\.t3plus-bot-metaline\s*\{/, "no model/computer line");
  assert.match(ruleBody("[data-t3plus-bot-body]"), /height:\s*auto !important/, "branch or not, bot rows are the same height");
  assert.doesNotMatch(css, /\.t3plus-bot-(chip|shelf)/);
});

test("bot rows show one status signal: the face, plus T3's colored label (its status icon and t3+'s dot are gone)", () => {
  assert.match(css, /\[data-t3plus-bot-status\] svg:not\(button svg\)\s*\{\s*display:\s*none !important;/);
  assert.match(css, /\.t3plus-bot-badge\s*\{[^}]*image-rendering:\s*pixelated/, "the status badge is a pixel sprite on the avatar's corner");
});
