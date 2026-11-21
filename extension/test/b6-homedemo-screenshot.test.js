import assert from "node:assert/strict";
import { test } from "node:test";
import { createDemoMode } from "../src/demoMode.js";
import { fakeCode, fakeProse } from "../src/demoText.js";
import { createDom } from "./helpers.js";

/** T3 writes a sentence as separate text nodes; in parsed HTML a comment keeps them apart. */
const parts = (texts) => texts.join("<!-- -->");

test("screenshot mode tells an automation's title from its schedule by markup: titles that read like schedules are covered, T3's schedule lines and error stay", () => {
  // The details card's Automations panel as T3 renders it: per task a title span and a
  // schedule <p> built from separate text nodes; the panel's error is a <p> too.
  const TASKS = [
    ["a1", "Daily summary of Priya's clinic emails", ["Daily at 07:30 EST", " · next ", "in 22h"]],
    ["a2", "Every morning: check Sam's 10:30 flight", ["Mon, Wed at 06:00 PT", " · paused"]],
    ["a3", "Weekly payroll report for Acme Corp", ["Once, Nov 21, 2026, 3:00 PM", " · next ", "in under a minute"]],
    ["a4", "Next steps for Dr. Smith referral", ["On webhook"]],
  ];
  const task = ([id, title, schedule]) =>
    `<li class="group flex items-center"><span class="relative inline-flex size-4"><svg></svg><span aria-hidden="true"></span></span>` +
    `<div class="min-w-0 flex-1"><span class="block truncate text-sm font-medium" id="${id}">${title}</span><p class="truncate text-2xs" id="${id}-when">${parts(schedule)}</p></div>` +
    `<button aria-label="Edit ${title}"></button></li>`;
  const dom = createDom(
    "/env1/t1",
    `<div data-thread-details-card=""><section data-thread-automations-panel="true" aria-labelledby="auto-h">` +
      `<div class="mb-1 flex"><h3 id="auto-h">Automations</h3><div><button aria-label="Manage scheduled tasks"></button></div></div>` +
      `<ul>${TASKS.map(task).join("")}</ul><p id="error">${parts(["Could not load automations: ", "timed out"])}</p></section></div>`,
  );
  const doc = dom.window.document;
  const text = (id) => doc.getElementById(id).textContent;
  const demo = createDemoMode(doc);
  demo.apply({});
  const stand = TASKS.map(([id]) => text(id));
  TASKS.forEach(([id, title, schedule], i) => {
    assert.notEqual(stand[i], title, `${id}'s title is covered`);
    assert.equal(text(`${id}-when`), schedule.join(""), `${id}'s schedule line stays T3's`);
  });
  assert.equal(new Set(stand).size, TASKS.length, "each title its own stand-in");
  assert.equal(text("error"), "Could not load automations: timed out");
  assert.equal(text("auto-h"), "Automations");

  // Hovered, T3 shows the title and the schedule again in a tooltip: the same stand-in.
  doc.body.insertAdjacentHTML("beforeend", `<div data-slot="tooltip-popup"><div><p class="font-medium" id="tip">${TASKS[0][1]}</p><p class="text-muted-foreground" id="tip-when">${parts(TASKS[0][2])}</p></div></div>`);
  demo.applyPopups();
  assert.equal(text("tip"), stand[0]);
  assert.equal(text("tip-when"), TASKS[0][2].join(""));

  demo.restore();
  for (const [id, title] of TASKS) assert.equal(text(id), title);
  assert.equal(text("tip"), TASKS[0][1]);
});

test("screenshot mode covers code in any script: a token with a letter gets a stand-in; operators, numbers and keywords stay", () => {
  for (const real of ["// Пароль от базы данных", '"Привет, Иван"', "# 患者の診断メモ", "пароль", "Ελληνικά", "مرحبا", "שלום", "안녕하세요", "नमस्ते"]) {
    assert.notEqual(fakeCode(real), real, real);
  }
  for (const kept of ["+", "42", "=>", "const", "});", "١٢٣", "│", "└──", "…", "0.5"]) assert.equal(fakeCode(kept), kept, kept);

  // A fence as T3 renders it (Shiki): one span per token, its lines apart by "\n".
  const dom = createDom(
    "/env1/t1",
    `<div class="messages-timeline-scroll"><div data-timeline-row-id="m1" data-timeline-row-kind="message" data-message-role="assistant"><div class="chat-markdown"><div class="chat-markdown-shiki"><pre class="shiki"><code>` +
      `<span class="line"><span id="comment">// Пароль от базы данных</span></span>\n` +
      `<span class="line"><span>const</span><span> </span><span id="name">пароль</span><span> </span><span id="eq">=</span><span> </span><span id="str">"Привет, Иван"</span><span id="semi">;</span></span>` +
      `</code></pre></div></div></div></div>`,
  );
  const doc = dom.window.document;
  const text = (id) => doc.getElementById(id).textContent;
  const demo = createDemoMode(doc);
  demo.apply({});
  for (const [id, real] of [["comment", "Пароль"], ["name", "пароль"], ["str", "Иван"]]) assert.ok(!text(id).includes(real), `${id}: ${text(id)}`);
  assert.equal(text("eq"), "=");
  assert.equal(text("semi"), ";");
  demo.restore();
  assert.equal(text("comment"), "// Пароль от базы данных");
  assert.equal(text("str"), '"Привет, Иван"');
});

test("screenshot mode follows a branch React renames in place: a new stand-in each time, and turning it off leaves T3's newest title", () => {
  // The composer's branch picker: T3 keeps one <span title> and updates it in place.
  const dom = createDom(
    "/env1/t1",
    `<div data-chat-composer-overlay="true"><button aria-label="Branch: sam/payroll-fix-2"><span data-composer-label="">` +
      `<span id="b" title="sam/payroll-fix-2" class="inline-flex"><span class="peer min-w-0">sam/</span><span class="shrink-0">payroll-fix-2</span></span>` +
      `</span></button></div>`,
  );
  const doc = dom.window.document;
  const split = doc.getElementById("b");
  const demo = createDemoMode(doc);
  const shown = () => ({ text: split.textContent, title: split.getAttribute("title") });
  const standIn = (real) => ({ text: demo.label("branch", real), title: demo.label("branch", real) });
  /** React's update: the title through setAttribute, only the parts that changed through nodeValue. */
  const rename = (head, tail) => {
    const [h, t] = split.children;
    if (h.firstChild.nodeValue !== head) h.firstChild.nodeValue = head;
    t.firstChild.nodeValue = tail;
    split.setAttribute("title", head + tail);
  };
  /** A change of shape: T3 shows a short name in one span, a long one in a head and a tail. */
  const reshape = (...names) => {
    split.replaceChildren(...names.map((name) => Object.assign(doc.createElement("span"), { textContent: name })));
    split.setAttribute("title", names.join(""));
  };

  demo.apply({});
  const first = shown();
  assert.deepEqual(first, standIn("sam/payroll-fix-2"));
  rename("acme/", "secret-merger");
  demo.apply({});
  assert.deepEqual(shown(), standIn("acme/secret-merger"));
  assert.notEqual(shown().text, first.text, "two branches never look the same");
  rename("acme/", "secret-merger-v2"); // only the tail changes: the head still shows the stand-in
  demo.apply({});
  assert.deepEqual(shown(), standIn("acme/secret-merger-v2"));
  reshape("main");
  demo.apply({});
  assert.deepEqual(shown(), { text: "main", title: "main" }, "a generic branch stays, not the old stand-in over it");
  reshape("dev/", "tax-filing");
  demo.apply({});
  assert.deepEqual(shown(), standIn("dev/tax-filing"));
  rename("dev/", "tax-filing-2026"); // after the last pass, right before the mode turns off
  demo.restore();
  assert.deepEqual(shown(), { text: "dev/tax-filing-2026", title: "dev/tax-filing-2026" });
});

test("prose stand-ins are pinned: short, long, lowercase, unfinished and colon-ended text, in both voices", () => {
  const PINS = [
    ["Priya aske", "agent", "I left a short"],
    ["the payroll export for March still has the old bank details for two people, so hold it until Monday.", "agent", "it replays the original body after the stream has already been read, so the second attempt sends an empty payload."],
    ["Then check whether the invoice from Acme Corp went out and", "agent", "I traced the failing request to the retry middleware"],
    ["Here is what I found in the payroll export for March:", "agent", "Summary: three files changed, one new test, no breaking."],
    [
      " Can you also look at why my tax return draft keeps failing to upload: it says the file is too large? Then tell Sam his flight to Lisbon is at 10:30 on Friday, and move the clinic appointments to Thursday. ",
      "agent",
      " The migration is reversible: it adds the new column, backfills it in batches, and only then switches reads over. I left a short note in the pull request that explains the rollout order and what to watch in the logs. ",
    ],
    ["Priya aske", "user", "Please make"],
    ["and email Dr. Okafor about the referral. ", "user", "write a short changelog entry for this release. "],
    ["Then check whether the invoice from Acme Corp went out, and tell Sam his flight to Lisbon is at 10:30 on Friday", "user", "Write a short changelog entry for this release and open a pull request when you're done"],
    [
      "Priya asked me to move the clinic appointments to Thursday and email Dr. Okafor about the referral. Then check whether the invoice from Acme Corp went out, and tell Sam his flight to Lisbon is at 10:30 on Friday. the payroll export for March still has the old bank details for two people, so hold it until Monday.",
      "user",
      "Can you add a dark mode toggle to the settings page and make it follow the system theme by default? The login redirect sometimes loops after a password reset, can you find out why and fix it? Please make the CSV export work for large accounts without timing out.",
    ],
  ];
  for (const [real, voice, fake] of PINS) assert.equal(fakeProse(real, voice), fake, `${voice}: ${real}`);
});

test("screenshot mode: a project named only by a dash or a bracket keeps its badge letter, and the rest of the page is still covered", () => {
  const badge = `data:image/svg+xml;base64,${Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><rect fill="#059669"/><text>NO</text></svg>').toString("base64")}`;
  const folder = (key, name) => `<li><div role="button" data-sidebar-row="folder:${key}"><img id="${key}" src="${badge}"><span class="truncate">${name}</span></div></li>`;
  const dom = createDom(
    "/env1/t1",
    `<div data-slot="sidebar-inner"><ul>${folder("dash", "–")}${folder("bracket", "&lt;&gt;")}</ul></div>` +
      `<nav aria-label="Thread breadcrumb"><ol><li><button><span data-slot="workspace-breadcrumb-text">notes</span></button></li><li aria-hidden="true">/</li>` +
      `<li aria-current="page"><h2><span data-slot="workspace-breadcrumb-text" id="crumb">Secret thread title</span></h2></li></ol></nav>`,
  );
  const doc = dom.window.document;
  doc.title = "notes / Secret thread title";
  const errors = [];
  dom.window.console.error = (...args) => errors.push(args);
  const demo = createDemoMode(doc);
  demo.apply({ sidebarInner: doc.querySelector('[data-slot="sidebar-inner"]') });
  assert.deepEqual(errors, []);
  /** The SVG the badge shows (its CSS url), parsed as an image would be. */
  const badgeSvg = (id) => {
    const url = doc.getElementById(id).style.getPropertyValue("--t3plus-demo-badge");
    return new dom.window.DOMParser().parseFromString(decodeURIComponent(url.slice('url("data:image/svg+xml,'.length, -'")'.length)), "image/svg+xml");
  };
  for (const [id, letter] of [["dash", "–"], ["bracket", "<"]]) {
    const svg = badgeSvg(id);
    assert.equal(svg.querySelector("parsererror"), null, `${id}: well-formed`);
    assert.equal(svg.querySelector("text").textContent, letter);
  }
  assert.notEqual(doc.getElementById("crumb").textContent, "Secret thread title", "the breadcrumb, after the sidebar");
  assert.ok(!doc.title.includes("Secret"), doc.title);
  demo.restore();
  assert.equal(doc.getElementById("dash").style.getPropertyValue("--t3plus-demo-badge"), "");
  assert.equal(doc.title, "notes / Secret thread title");
});

test("screenshot mode: a region that breaks on new T3 markup leaves the others covered, and is reported once", () => {
  const dom = createDom(
    "/env1/t1",
    `<nav aria-label="Thread breadcrumb"><ol><li aria-current="page"><h2><span data-slot="workspace-breadcrumb-text">Weekly notes</span></h2></li></ol></nav>` +
      `<div class="messages-timeline-scroll"><div data-timeline-row-id="m1" data-timeline-row-kind="message" data-message-role="assistant">` +
      `<div class="chat-markdown"><p id="prose">Done, I booked Dr. Smith for Friday.</p></div></div></div>`,
  );
  const doc = dom.window.document;
  doc.title = "notes / Weekly notes";
  const errors = [];
  dom.window.console.error = (...args) => errors.push(args);
  const query = doc.querySelector.bind(doc);
  doc.querySelector = (selector) => {
    if (selector.includes("Thread breadcrumb")) throw new Error("T3 changed its breadcrumb");
    return query(selector);
  };
  const demo = createDemoMode(doc);
  demo.apply({});
  demo.apply({});
  assert.ok(!doc.getElementById("prose").textContent.includes("Smith"), "the chat is covered");
  assert.ok(!doc.title.includes("Weekly notes"), doc.title);
  assert.equal(errors.length, 1, "reported once, not on every check");
  assert.match(String(errors[0][0]), /breadcrumb/);
});

test("screenshot mode: a pass over a thread it already covered walks up no ancestors (one runs every frame while T3 streams), and still sees React's changes", () => {
  // A long thread: prose, inline code, Shiki tokens (names, and ones that need no
  // stand-in), and the whitespace between elements.
  const turn = (i) => `
    <div data-timeline-row-id="u${i}" data-timeline-row-kind="message" data-message-role="user">
      <p>Can you move the dentist appointment for client ${i} to Friday?</p>
    </div>
    <div data-timeline-row-id="a${i}" data-timeline-row-kind="message" data-message-role="assistant">
      <div class="chat-markdown">
        <p>I moved it in <code>calendar.ts</code> and told the clinic.</p>
        <pre class="shiki"><code><span class="line"><span>const</span><span> </span><span>clinic</span><span> </span><span class="eq">=</span><span> </span><span>"Dr. Smith"</span><span>;</span></span></code></pre>
      </div>
    </div>`;
  const dom = createDom("/env1/t1", `<div class="messages-timeline-scroll">${Array.from({ length: 30 }, (_, i) => turn(i)).join("")}</div>`);
  const doc = dom.window.document;
  const demo = createDemoMode(doc);
  demo.apply({});
  const covered = doc.body.textContent;
  assert.ok(!covered.includes("Smith") && !covered.includes("dentist"));

  const proto = dom.window.Element.prototype;
  const closest = proto.closest;
  let walks = 0;
  proto.closest = function (selector) {
    walks += 1;
    return closest.call(this, selector);
  };
  try {
    demo.apply({});
  } finally {
    proto.closest = closest;
  }
  assert.equal(walks, 0);
  assert.equal(doc.body.textContent, covered, "and nothing changed");

  // React writes into a covered node and into one that needed no stand-in: both are looked at again.
  const prose = doc.querySelector('[data-timeline-row-id="a0"] .chat-markdown p').firstChild;
  const token = doc.querySelector('[data-timeline-row-id="a0"] .eq').firstChild;
  prose.nodeValue = "Streaming: Dr. Smith confirmed ";
  token.nodeValue = "smithClinic";
  demo.apply({});
  assert.ok(!prose.nodeValue.includes("Smith"), prose.nodeValue);
  assert.notEqual(token.nodeValue, "smithClinic");
  demo.restore();
  assert.equal(prose.nodeValue, "Streaming: Dr. Smith confirmed ");
  assert.equal(token.nodeValue, "smithClinic");
  assert.ok(doc.body.textContent.includes("dentist"));
});
