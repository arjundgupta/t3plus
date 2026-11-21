import assert from "node:assert/strict";
import { test } from "node:test";
import { decorateBotBreadcrumb, decorateBotHoverCards } from "../src/bots.js";
import { STORAGE_KEYS, T3PLUS } from "../src/config.js";
import { createDemoMode } from "../src/demoMode.js";
import { createNameBook, fakeCode, fakeProse, isNeutral, projectInitials } from "../src/demoText.js";
import { stopSprites } from "../src/spriteClock.js";
import { BOT_TITLE, createApp, createDom, createFakeChromeStorage, settle, sidebarHtml } from "./helpers.js";

test("stand-ins are stable, distinct per real name, and keep generic values", () => {
  const book = createNameBook();
  const a = book.fake("project", "acme-internal");
  assert.equal(book.fake("project", "acme-internal"), a, "same real name, same stand-in");
  assert.notEqual(book.fake("project", "side-project"), a, "two projects never share one");
  assert.equal(book.kindOf("acme-internal"), "project");
  assert.ok(book.isFake(a));
  assert.equal(book.fake("branch", "main"), "main");
  assert.match(book.fake("branch", "me/secret-thing"), /^[a-z]+\/[a-z0-9-]+$/);
  assert.equal(projectInitials("atlas-api"), "AA");
  assert.equal(projectInitials("orbit"), "O");
  assert.ok(isNeutral("3:35 AM") && isNeutral("+1,028") && isNeutral("2d") && !isNeutral("hello"));
});

test("message text is replaced by agent prose of about the same length; code keeps its keywords", () => {
  const real = "I checked my bank account and the Chase statement from Tuesday; it's fine.";
  const fake = fakeProse(` ${real} `);
  assert.ok(fake.startsWith(" ") && fake.endsWith(" "), "whitespace kept");
  assert.ok(!fake.includes("Chase") && Math.abs(fake.trim().length - real.length) < 20);
  assert.equal(fakeProse(real), fake.trim(), "deterministic");
  assert.equal(fakeCode("const"), "const");
  assert.equal(fakeCode(" = "), " = ");
  assert.notEqual(fakeCode("myPrivateVar"), "myPrivateVar");
  assert.equal(fakeCode("line one\n  line two").split("\n")[1].startsWith("  "), true, "indent kept");
});

const TIMELINE = `
  <nav aria-label="Thread breadcrumb"><ol>
    <li><button><span data-slot="workspace-breadcrumb-text">notes</span></button></li>
    <li aria-hidden="true"><span data-slot="workspace-breadcrumb-text">/</span></li>
    <li aria-current="page"><h2><span data-slot="workspace-breadcrumb-text">Weekly notes</span></h2></li>
  </ol></nav>
  <div class="messages-timeline-scroll">
    <div data-timeline-row-id="m1" data-timeline-row-kind="message" data-message-role="user"><p id="user">Book my dentist at 3pm please</p></div>
    <div data-timeline-row-id="m2" data-timeline-row-kind="message" data-message-role="assistant">
      <div class="chat-markdown"><p id="prose">Done, I booked Dr. Smith for Friday.</p><p>Edited <code id="code">my-private.md</code></p></div>
    </div>
    <div data-timeline-row-id="f1" data-timeline-row-kind="turn-fold"><span id="fold">Worked for 10m 33s</span></div>
  </div>
  <div data-chat-composer-overlay="true"><div contenteditable="true" id="editor">my draft</div></div>`;

// Folder layout rows get a project name in their top line like card rows.
const cardRow = (key, title, project, branch) => `
  <li data-thread-item="${key}"><div role="button" data-sidebar-row="${key}" aria-label="${title}, ${project}">
    <span class="sr-only">${title}</span>
    <div class="relative z-10">
      <div class="flex h-5"><img class="size-4" src="data:image/svg+xml;base64,${Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><rect fill="#059669"/><text>NO</text></svg>').toString("base64")}"><span class="truncate">${project}</span><span class="group/sidebar-status-slot">2d</span></div>
      <div class="mt-1 flex"><span aria-hidden="true" dir="ltr">${title}</span></div>
      <div class="mt-0.5 flex"><span class="flex"><span class="truncate">${branch}</span></span></div>
    </div>
  </div></li>`;

test("screenshot mode covers sidebar, breadcrumb and messages, and restores every real text", async () => {
  const storage = createFakeChromeStorage();
  await storage.area.set({ [STORAGE_KEYS.settings]: { demo: { enabled: true } } });
  const html = sidebarHtml().replace("</ul>", `${cardRow("env1:x1", "Pay rent to landlord", "notes", "me/rent")}</ul>`);
  const dom = createDom("/env1/x1", html + TIMELINE);
  const doc = dom.window.document;
  const { app } = createApp(dom, storage);
  await app.start();
  app.watcher.flush();
  assert.ok(doc.documentElement.hasAttribute(T3PLUS.demoAttr));

  const row = doc.querySelector('[data-sidebar-row="env1:x1"]');
  const title = row.querySelector("[dir]").textContent;
  const project = row.querySelector(".truncate").textContent;
  assert.notEqual(title, "Pay rent to landlord");
  assert.notEqual(project, "notes");
  assert.notEqual(row.querySelector(".mt-0\\.5 .truncate").textContent, "me/rent");
  assert.equal(row.querySelector(".sr-only").textContent, "Pay rent to landlord", "hidden title untouched (scans stay real)");
  assert.equal(row.querySelector("img").getAttribute("data-t3plus-demo-badge"), "");
  assert.equal(doc.querySelectorAll('[data-slot="workspace-breadcrumb-text"]')[0].textContent, project, "breadcrumb project matches the row");
  assert.notEqual(doc.getElementById("user").textContent, "Book my dentist at 3pm please");
  assert.ok(!doc.getElementById("prose").textContent.includes("Smith"));
  assert.notEqual(doc.getElementById("code").textContent, "my-private.md");
  assert.equal(doc.getElementById("fold").textContent, "Worked for 10m 33s", "T3's own labels stay");
  assert.equal(doc.getElementById("editor").textContent, "my draft", "the composer is never touched");
  // The bot row keeps working: still recognized, and its name is a stand-in.
  const bot = doc.querySelector('[data-sidebar-row="env1:bot1"]');
  assert.ok(bot.hasAttribute(T3PLUS.botAttr));
  assert.match(bot.getAttribute("aria-description"), /^t3\+ bot: /);
  assert.ok(!bot.getAttribute("aria-description").includes("Orchestrator"), "bot name is a stand-in");
  assert.ok(BOT_TITLE.includes("Orchestrator"));

  // T3 re-renders a message: the new text is covered on the next pass.
  doc.getElementById("prose").firstChild.nodeValue = "New private reply from Dr. Smith.";
  app.watcher.flush();
  assert.ok(!doc.getElementById("prose").textContent.includes("Smith"));

  // Off: every real text and badge comes back.
  app.actions.setDemo(false);
  await settle();
  app.watcher.flush();
  assert.ok(!doc.documentElement.hasAttribute(T3PLUS.demoAttr));
  assert.equal(row.querySelector("[dir]").textContent, "Pay rent to landlord");
  assert.equal(row.querySelector(".truncate").textContent, "notes");
  assert.equal(doc.getElementById("user").textContent, "Book my dentist at 3pm please");
  assert.equal(doc.getElementById("prose").textContent, "New private reply from Dr. Smith.");
  assert.equal(doc.getElementById("code").textContent, "my-private.md");
  assert.ok(!row.querySelector("img").hasAttribute("data-t3plus-demo-badge"));
  app.stop();
});

test("screenshot mode is off by default, has no shortcut (Settings only), and covers the window title the way it covers the breadcrumb", async () => {
  const storage = createFakeChromeStorage();
  const dom = createDom("/env1/x1", sidebarHtml() + TIMELINE);
  const doc = dom.window.document;
  doc.title = "notes / Weekly notes";
  const { app } = createApp(dom, storage);
  await app.start();
  app.watcher.flush();
  assert.equal(app.state.settings.demo.enabled, false, "off by default");
  doc.dispatchEvent(new dom.window.KeyboardEvent("keydown", { code: "KeyD", altKey: true, shiftKey: true, bubbles: true, cancelable: true }));
  await settle();
  assert.equal(app.state.settings.demo.enabled, false, "Option+Shift+D does nothing: Settings only");
  await app.actions.setDemo(true);
  await settle();
  app.watcher.flush();
  const crumbs = [...doc.querySelectorAll('nav[aria-label="Thread breadcrumb"] li:not([aria-hidden]) [data-slot="workspace-breadcrumb-text"]')].map((el) => el.textContent);
  assert.notEqual(doc.title, "notes / Weekly notes");
  assert.equal(doc.title, crumbs.join(" / "), "the title shows the same stand-ins as the breadcrumb");
  // T3 renames the window while the mode is on: covered again.
  doc.title = "notes / Rent and bills";
  app.watcher.flush();
  assert.ok(!doc.title.includes("Rent"), doc.title);
  doc.title = "Settings";
  app.watcher.flush();
  assert.equal(doc.title, "Settings", "T3's own one-word titles stay");
  doc.title = "notes / Rent and bills";
  app.watcher.flush();
  await app.actions.setDemo(false);
  await settle();
  app.watcher.flush();
  assert.equal(doc.title, "notes / Rent and bills", "off: the real title is back");
  app.stop();
});

test("screenshot mode covers the command palette: thread results, the open thread's name, projects; T3's commands and the typed match stay", async () => {
  const storage = createFakeChromeStorage();
  await storage.area.set({ [STORAGE_KEYS.settings]: { demo: { enabled: true } } });
  const item = (inner) => `<div role="option" data-slot="command-item">${inner}</div>`;
  // As T3 renders ⌘K (CommandPalette): actions, a settings result, thread results.
  const PALETTE = `<div role="dialog" data-command-palette="true" data-slot="command-dialog-popup"><input value="git">
    ${item('<span class="truncate">Copy thread</span><span class="min-w-0 truncate text-muted-foreground">Weekly notes</span><kbd>⇧⌘C</kbd>')}
    ${item('<span class="truncate">New thread in <b>notes</b></span>')}
    ${item('<span class="truncate">Git fetch interval</span><span class="min-w-0 text-muted-foreground">Settings · Maintenance</span>')}
    ${item('<span class="truncate" id="t1">Tax return 2025</span><span class="max-w-[45%] shrink-0 truncate text-xs" id="p1">acme-secret · Local</span><span class="text-muted-foreground">·</span><span class="shrink-0" id="env1">studio-mac</span><span class="text-xs"><span class="shrink-0" id="env2">Local</span></span><span class="text-info-foreground">You:</span><span class="truncate text-xs text-muted-foreground" id="s1">…the IRS letter about my </span><mark>git</mark><span class="truncate text-xs text-muted-foreground">hub account</span><span class="min-w-12 shrink-0 text-right">13h ago</span>')}
  </div>`;
  const dom = createDom("/env1/x1", sidebarHtml() + TIMELINE + PALETTE);
  const doc = dom.window.document;
  const { app } = createApp(dom, storage);
  await app.start();
  app.watcher.flush();
  const text = (sel) => doc.querySelector(sel).textContent;
  const crumbs = [...doc.querySelectorAll('nav[aria-label="Thread breadcrumb"] li:not([aria-hidden]) [data-slot="workspace-breadcrumb-text"]')].map((el) => el.textContent);
  const palette = doc.querySelector('[data-command-palette="true"]');
  const options = [...palette.querySelectorAll('[data-slot="command-item"]')];
  assert.equal(options[0].querySelector(".text-muted-foreground").textContent, crumbs[1], "Copy thread names the open thread's stand-in");
  assert.equal(options[0].querySelector(".truncate").textContent, "Copy thread", "the command itself stays");
  assert.equal(options[1].querySelector("b").textContent, crumbs[0], "New thread in <the project's stand-in>");
  assert.equal(options[2].textContent.includes("Git fetch interval"), true, "settings results are T3's words");
  assert.notEqual(text("#t1"), "Tax return 2025");
  assert.ok(!text("#p1").includes("acme-secret") && text("#p1").endsWith(" · Local"), text("#p1"));
  assert.ok(!text("#s1").includes("IRS"), "the snippet is covered");
  assert.notEqual(text("#env1"), "studio-mac", "a machine name is covered");
  assert.equal(text("#env2"), "Local", "T3's 'Local' stays, even inside small text");
  assert.equal(palette.querySelector("mark").textContent, "git", "the typed match stays");
  assert.equal(options[3].querySelector(".text-right").textContent, "13h ago");
  app.actions.setDemo(false);
  await settle();
  app.watcher.flush();
  assert.equal(text("#t1"), "Tax return 2025");
  assert.equal(text("#p1"), "acme-secret · Local");
  assert.equal(options[0].querySelector(".text-muted-foreground").textContent, "Weekly notes");
  app.stop();
});

test("screenshot mode covers text React changes in place (a streaming reply), not only new nodes", async () => {
  const storage = createFakeChromeStorage();
  await storage.area.set({ [STORAGE_KEYS.settings]: { demo: { enabled: true } } });
  const dom = createDom("/env1/x1", sidebarHtml() + TIMELINE);
  const doc = dom.window.document;
  const { app } = createApp(dom, storage, { throttleMs: 0 });
  await app.start();
  app.watcher.flush();
  const prose = doc.getElementById("prose").firstChild;
  assert.ok(!prose.nodeValue.includes("Smith"));
  prose.nodeValue = "Streaming now: Dr. Smith confirmed the biopsy results";
  await new Promise((r) => setTimeout(r, 30));
  assert.ok(!doc.getElementById("prose").textContent.includes("Smith"), doc.getElementById("prose").textContent);
  app.actions.setDemo(false);
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(doc.getElementById("prose").textContent, "Streaming now: Dr. Smith confirmed the biopsy results");
  app.stop();
});

test("screenshot mode covers T3's thread hover card by what each line is: project, machine, branch (and its tooltip), PR titles; the model and T3's sentences stay", () => {
  // ThreadHoverCard's lines, in T3's order; any of them can be missing.
  const line = (inner, cls = "") => `<div class="flex min-w-0 items-center gap-2 ${cls}">${inner}</div>`;
  const dom = createDom("/", `<div data-slot="tooltip-popup"><div data-slot="tooltip-viewport"><div class="flex min-w-0 max-w-80 flex-col gap-2 px-1 py-2">
    <div class="min-w-0 truncate text-xs leading-tight font-medium text-foreground">Rotate the payroll keys</div>
    <div class="grid gap-1.5 pl-0.5 text-xs text-muted-foreground">
      ${line('<span data-slot="project-monogram"><svg><text>AP</text></svg></span><div class="min-w-0 truncate" id="project">acme-payroll</div>')}
      ${line('<svg class="size-3"></svg><div class="min-w-0 truncate" id="env">Sam\'s MacBook Pro</div>')}
      ${line('<svg class="size-3"></svg><span id="branch" title="sam/payroll-fix-2" class="inline-flex min-w-0"><span class="peer min-w-0">sam/</span><span class="shrink-0">payroll-fix-2</span></span>')}
      ${line('<svg class="size-3"></svg><div id="warn">You\'re currently checked out on another branch.</div>', "text-warning")}
      ${line('<img class="size-3 grayscale"><div class="min-w-0 truncate" id="model">GPT-5.5 · Acme work</div>')}
      ${line('<svg class="size-3"></svg><div class="min-w-0 truncate" id="term">2 terminal processes running</div>')}
    </div>
    <div class="border-t"><ul class="flex flex-col gap-1"><li><span class="shrink-0 font-mono" id="num">#412</span><span class="min-w-0 truncate" id="pr">Fix Acme Corp payroll export</span></li></ul></div>
  </div></div></div>`);
  const doc = dom.window.document;
  const demo = createDemoMode(doc);
  demo.apply({});
  const text = (id) => doc.getElementById(id).textContent;
  const branch = () => doc.getElementById("branch");
  assert.notEqual(text("project"), "acme-payroll", "the first line is the project");
  assert.notEqual(text("env"), "Sam's MacBook Pro", "a machine name with spaces is covered");
  assert.ok(!text("branch").includes("payroll") && !branch().getAttribute("title").includes("payroll"), "branch and its native tooltip");
  const first = { text: text("branch"), title: branch().getAttribute("title") };
  for (let i = 0; i < 3; i += 1) demo.apply({});
  assert.deepEqual({ text: text("branch"), title: branch().getAttribute("title") }, first, "stable over later passes (no stand-in of a stand-in)");
  assert.equal(first.text, first.title, "the tooltip matches the text");
  assert.equal(text("warn"), "You're currently checked out on another branch.", "T3's warning stays");
  assert.ok(text("model").startsWith("GPT-5.5 · ") && !text("model").includes("Acme"), text("model"));
  assert.equal(text("term"), "2 terminal processes running");
  assert.equal(text("num"), "#412");
  assert.ok(!text("pr").includes("Acme"), text("pr"));
  demo.restore();
  assert.equal(text("project"), "acme-payroll");
  assert.equal(text("env"), "Sam's MacBook Pro");
  assert.equal(text("branch"), "sam/payroll-fix-2");
  assert.equal(branch().getAttribute("title"), "sam/payroll-fix-2");
  assert.equal(text("model"), "GPT-5.5 · Acme work");
  assert.equal(text("pr"), "Fix Acme Corp payroll export");
});

test("an open bot hover card follows screenshot mode: its name switches to the stand-in and back", () => {
  const dom = createDom("/", `<div data-slot="tooltip-popup"><div class="min-w-0 truncate text-xs font-medium" id="t">Night Shift</div></div>`);
  const doc = dom.window.document;
  const bot = (label) => ({ key: "env1:b1", titleLabel: label, status: "working", thread: { title: "Night Shift" } });
  decorateBotHoverCards(doc, new Map([["Night Shift", bot("Night Shift")]]), {});
  assert.equal(doc.getElementById("t").getAttribute("data-t3plus-bot-hover-label"), "Night Shift");
  decorateBotHoverCards(doc, new Map([["Night Shift", bot("Inbox Zero")]]), {}); // screenshot mode on
  assert.equal(doc.getElementById("t").getAttribute("data-t3plus-bot-hover-label"), "Inbox Zero");
  stopSprites(); // a working bot's face animates; stop its clock
});

test("screenshot mode: a name T3 splits in two spans gets one stand-in; a draft row's unsent words are covered; the breadcrumb is clean after a bot thread", () => {
  const dom = createDom("/", `
    <nav aria-label="Thread breadcrumb"><ol>
      <li><button><span data-slot="workspace-breadcrumb-text" id="crumb"><span class="min-w-0 truncate">acme-payroll-</span><span class="shrink-0">service</span></span></button></li>
      <li aria-hidden="true">/</li>
      <li aria-current="page"><h2 id="h"><span data-slot="workspace-breadcrumb-text">Weekly notes</span></h2></li>
    </ol></nav>
    <div data-slot="sidebar-inner"><ul>
      <li><div role="button" data-sidebar-row="draft:d1"><div class="relative z-10"><div class="h-5"><span class="truncate">acme-payroll-service</span></div><div class="mt-0.5 truncate" id="draft">Priya salary review</div></div></div></li>
    </ul></div>`);
  const doc = dom.window.document;
  const demo = createDemoMode(doc);
  demo.apply({ sidebarInner: doc.querySelector('[data-slot="sidebar-inner"]') });
  const crumb = doc.getElementById("crumb").textContent;
  assert.ok(!crumb.includes("acme") && !/[a-z]-[a-z]+-[a-z]+-[a-z]/.test(crumb), `one stand-in, not two glued: ${crumb}`);
  assert.equal(doc.getElementById("crumb").lastElementChild.textContent, "", "the tail is emptied");
  assert.ok(!doc.getElementById("draft").textContent.includes("Priya"), doc.getElementById("draft").textContent);
  demo.restore();
  assert.equal(doc.getElementById("crumb").textContent, "acme-payroll-service");
  assert.equal(doc.getElementById("draft").textContent, "Priya salary review");
  // A bot thread's breadcrumb face, then a plain thread: nothing of the bot is left on T3's heading.
  decorateBotBreadcrumb(doc, { key: "env1:b", titleLabel: "Night Shift", status: "working", prefs: {} });
  assert.ok(doc.getElementById("h").hasAttribute("data-t3plus-mood"));
  decorateBotBreadcrumb(doc, null);
  const h = doc.getElementById("h");
  assert.deepEqual([...h.attributes].map((a) => a.name), ["id"], [...h.attributes].map((a) => a.name).join(","));
  stopSprites();
});

test("screenshot mode: when T3 writes the real window title back, it is covered again at once; palette actions name projects by stand-in", async () => {
  const dom = createDom("/", `<div data-command-palette="true"><div data-slot="command-item" id="act"><span class="truncate">New thread in <b>secret-client</b></span></div><div data-slot="command-item" id="proj"><span data-slot="project-monogram"><svg><text>SC</text></svg></span><span class="truncate">secret-client</span></div><div data-slot="command-item" id="cmd"><span class="truncate">Change theme</span></div></div>`);
  const doc = dom.window.document;
  doc.title = "secret-client / Payroll fix";
  const demo = createDemoMode(doc);
  demo.apply({});
  const fake = doc.title;
  assert.ok(!fake.includes("secret") && !fake.includes("Payroll"), fake);
  doc.title = "secret-client / Payroll fix"; // T3 resets it
  await new Promise((r) => setTimeout(r, 0)); // the observer's microtask
  assert.equal(doc.title, fake, "covered again before the next check");
  assert.ok(!doc.getElementById("act").textContent.includes("secret"), doc.getElementById("act").textContent);
  assert.ok(doc.getElementById("act").textContent.startsWith("New thread in "), "the command stays");
  assert.ok(!doc.getElementById("proj").textContent.includes("secret-client"));
  assert.equal(doc.getElementById("cmd").textContent, "Change theme");
  demo.restore();
  assert.equal(doc.title, "secret-client / Payroll fix");
  assert.equal(doc.getElementById("act").textContent, "New thread in secret-client");
  doc.title = "Other / Thread";
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(doc.title, "Other / Thread", "after restore the title is left alone");
});

test("screenshot mode: a thread made a bot while it is on is read by its real title (status, remembered title), not the stand-in", async () => {
  // T3's current rows have no sr-only copy: the [dir] span (which screenshot mode covers) is the title.
  const dom = createDom("/", sidebarHtml().replace(/<span class="sr-only">[^<]*<\/span>/g, ""));
  const doc = dom.window.document;
  const storage = createFakeChromeStorage();
  const { app } = createApp(dom, storage);
  await app.start();
  await app.actions.setDemo(true);
  await settle();
  app.watcher.flush();
  const span = doc.querySelector('[data-sidebar-row="env1:a1"] span[dir]');
  assert.notEqual(span.textContent, "Fix login", "covered on screen");
  await app.actions.toggleBot("env1:a1");
  await settle();
  app.watcher.flush();
  const bot = app.state.bots.find((b) => b.key === "env1:a1");
  assert.equal(bot.thread.title, "Fix login");
  assert.equal(bot.status, "done", "the status is read from T3's label with the real title");
  assert.equal(storage.area.data.get(STORAGE_KEYS.knownBots)["env1:a1"].title, "Fix login");
  app.stop();
  stopSprites();
});

test("screenshot mode covers the rest of T3's chrome: branch pickers (split names and their tooltip), Run on, the From badge, details sections, side chats, tooltips, the screen-reader window title", () => {
  const split = (id, head, tail) => `<span id="${id}" title="${head}${tail}" class="inline-flex"><span class="peer min-w-0">${head}</span><span class="shrink-0">${tail}</span></span>`;
  const html = `
  <div data-slot="sidebar-inner"><ul><li data-thread-item="env1:t1"><div role="button" data-sidebar-row="env1:t1" aria-label="Pay rent to landlord, acme-payroll"><div class="relative z-10">
    <div class="flex h-5"><span class="truncate">acme-payroll</span></div><div class="mt-1 flex"><span dir="auto">Pay rent to landlord</span></div></div></div></li></ul></div>
  <nav aria-label="Thread breadcrumb"><ol><li><button><span data-slot="workspace-breadcrumb-text">acme-payroll</span></button></li><li aria-hidden="true">/</li>
    <li aria-current="page"><h2><span data-slot="workspace-breadcrumb-text">Pay rent to landlord</span></h2><span id="origin" data-slot="badge">From <!-- -->Sam's MacBook Pro</span></li></ol></nav>
  <div data-chat-composer-overlay="true">
    <button id="ctx" data-composer-context-control="" data-composer-shortcut="composer.workspace"><span data-composer-label="">Current checkout</span></button>
    <button id="runon" aria-label="Run on" data-composer-context-control="" data-composer-shortcut="composer.host"><span data-composer-label="">Sam's Mac Studio</span></button>
    <button id="branch" aria-label="Branch: sam/payroll-fix-2"><span data-composer-label="">${split("bs", "sam/", "payroll-fix-2")}</span></button>
  </div>
  <div data-thread-details-card="">
    <section aria-label="Version Control"><span id="pr">#412: Fix Acme Corp payroll export</span>${split("vs", "sam/", "payroll-fix-2")}</section>
    <section aria-labelledby="auto-h" data-thread-automations-panel=""><h3 id="auto-h">Automations</h3><span id="auto">Remind me to pay Priya's invoice</span><p>Daily at 9:00 AM</p></section>
    <section aria-labelledby="side-h" data-thread-side-chats-panel=""><h3 id="side-h">Side chats</h3><span id="side">Draft the divorce settlement email</span></section>
  </div>
  <div class="messages-timeline-scroll"><div data-timeline-row-id="m" data-timeline-row-kind="message" data-message-role="user"><p id="main">Book my dentist at 3pm please</p></div></div>
  <aside><div data-side-chat-pane="s"><div class="messages-timeline-scroll"><div data-timeline-row-id="s1" data-timeline-row-kind="message" data-message-role="user"><p id="sidechat">Reply to my landlord about the rent</p></div></div></div></aside>
  <div data-slot="tooltip-popup"><div data-slot="tooltip-viewport" id="tip1">Pay rent to landlord</div></div>
  <div data-slot="tooltip-popup"><div data-slot="tooltip-viewport" id="tip2">New thread in <!-- -->acme-payroll</div></div>`;
  const dom = createDom("/env1/t1", html);
  const doc = dom.window.document;
  doc.title = "Working: Pay rent to landlord - acme-payroll";
  const demo = createDemoMode(doc);
  demo.apply({ sidebarInner: doc.querySelector('[data-slot="sidebar-inner"]') });
  const t = (id) => doc.getElementById(id).textContent.replace(/\s+/g, " ").trim();
  for (const [id, real] of [["bs", "payroll"], ["vs", "payroll"], ["runon", "Sam"], ["origin", "Sam"], ["pr", "Acme"], ["auto", "Priya"], ["side", "divorce"], ["main", "dentist"], ["sidechat", "landlord"], ["tip1", "rent"], ["tip2", "acme"]]) {
    assert.ok(!t(id).includes(real), `${id}: ${t(id)}`);
  }
  assert.equal(doc.getElementById("bs").getAttribute("title"), t("bs"), "the split name's tooltip says the stand-in");
  assert.equal(t("ctx"), "Current checkout", "T3's own words stay");
  assert.ok(t("pr").startsWith("#412: "), "the PR number stays");
  assert.ok(t("origin").startsWith("From "));
  assert.ok(doc.title.startsWith("Working: ") && !doc.title.includes("rent") && !doc.title.includes("acme"), doc.title);
  demo.restore();
  assert.equal(t("bs"), "sam/payroll-fix-2");
  assert.equal(doc.getElementById("bs").getAttribute("title"), "sam/payroll-fix-2");
  assert.equal(t("origin"), "From Sam's MacBook Pro");
  assert.equal(doc.title, "Working: Pay rent to landlord - acme-payroll");
});

test("settings flows keep screenshot mode honest: an import leaves it on, a failed save says so, Reset is queued with other changes", async () => {
  const storage = createFakeChromeStorage();
  await storage.area.set({ [STORAGE_KEYS.settings]: { demo: { enabled: true } } });
  const dom = createDom("/", sidebarHtml());
  const backup = { import: async (data) => (await storage.area.set({ [STORAGE_KEYS.settings]: data.data[STORAGE_KEYS.settings] }), { keys: [STORAGE_KEYS.settings], skipped: [] }) };
  const { app } = createApp(dom, storage, { backup });
  await app.start();
  const file = { name: "acme-client-backup.json", text: async () => JSON.stringify({ app: "t3plus", data: { [STORAGE_KEYS.settings]: { demo: { enabled: false }, glass: { enabled: false } } } }) };
  await app.actions.importSettings(file);
  await settle();
  assert.equal(app.state.settings.demo.enabled, true, "still on after importing a backup made with it off");
  assert.equal(storage.area.data.get(STORAGE_KEYS.settings).demo.enabled, true);
  assert.ok(!app.state.message.includes("acme"), app.state.message);

  const set = storage.area.set;
  storage.area.set = async () => {
    throw new Error("Not enough room");
  };
  await app.actions.setGlass(true);
  assert.match(app.state.message, /Could not save that change: Not enough room/);
  storage.area.set = set;

  const reset = app.actions.reset();
  const toggle = app.actions.setGlass(false); // made while Reset is still saving
  await Promise.all([reset, toggle]);
  await settle();
  assert.equal(app.state.settings.glass.enabled, false, "the change made during Reset is kept");
  assert.equal(storage.area.data.get(STORAGE_KEYS.settings).glass.enabled, false, "and saved");
  assert.equal(app.state.settings.demo.enabled, true, "Reset keeps screenshot mode");
  app.stop();
});

test("screenshot mode's prune() lets go of what T3 removed: a restore then writes only on what is still on the page", () => {
  const card = (id, project, branch) => `<div data-slot="tooltip-popup" id="${id}"><div data-slot="tooltip-viewport"><div class="flex min-w-0 max-w-80 flex-col gap-2 px-1 py-2">
    <div class="min-w-0 truncate text-xs leading-tight font-medium text-foreground">Rotate the keys</div>
    <div class="grid gap-1.5 pl-0.5 text-xs text-muted-foreground">
      <div class="flex min-w-0 items-center gap-2"><span data-slot="project-monogram"><svg><text>AP</text></svg></span><div class="min-w-0 truncate" id="${id}-project">${project}</div></div>
      <div class="flex min-w-0 items-center gap-2"><svg class="size-3"></svg><span id="${id}-branch" title="${branch}" class="inline-flex min-w-0"><span class="peer min-w-0">${branch}</span></span></div>
    </div></div></div></div>`;
  const doc = createDom("/", card("gone", "acme-billing", "sam/billing-fix")).window.document;
  const demo = createDemoMode(doc);
  demo.apply({});
  const goneProject = doc.getElementById("gone-project");
  const goneBranch = doc.getElementById("gone-branch");
  const covered = { project: goneProject.textContent, title: goneBranch.getAttribute("title") };
  assert.notEqual(covered.project, "acme-billing");
  assert.notEqual(covered.title, "sam/billing-fix");

  // T3 closes that hover card and opens another.
  doc.getElementById("gone").remove();
  doc.body.insertAdjacentHTML("beforeend", card("kept", "acme-payroll", "sam/payroll-fix"));
  demo.apply({});
  assert.notEqual(doc.getElementById("kept-project").textContent, "acme-payroll");
  demo.prune();
  demo.restore();
  assert.equal(doc.getElementById("kept-project").textContent, "acme-payroll", "what is on the page is restored");
  assert.equal(doc.getElementById("kept-branch").getAttribute("title"), "sam/payroll-fix");
  assert.equal(goneProject.textContent, covered.project, "a node T3 removed is forgotten, not written on");
  assert.equal(goneBranch.getAttribute("title"), covered.title);
});
