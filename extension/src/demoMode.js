import { HOVER_CARD_TITLE, parseRowProject } from "./bots.js";
import { T3PLUS, T3_SELECTORS } from "./config.js";
import { createNameBook, fakeCode, fakeCommand, fakeIdentifier, fakeProse, isNeutral, isPlainBranch, projectInitials } from "./demoText.js";

// Screenshot mode: a read-only cover over T3's visible text. Thread titles,
// project names, branches, machine names and message text are swapped for
// believable stand-ins (demoText.js) by rewriting the visible text nodes only.
// T3's data, React state, aria labels and the composer are never touched; each
// swapped node remembers its real text, and turning the mode off puts it back.
// When React updates a node (new message text, a renamed thread), the next
// pass covers the new text. Project letter badges are redrawn with the stand-in
// project's initials through CSS `content` on the <img>, never its src.

const SHOW_TEXT = 4;
const SCHEDULE = /^(daily|weekly|hourly|monthly|every|weekdays|weekends|runs|next|last|paused|at )/i;

export function createDemoMode(doc) {
  const book = createNameBook();
  const memo = new WeakMap(); // text node -> { real, fake }
  const touched = new Set();
  const badges = new Set();
  const badgeCache = new Map(); // img src -> { color } | null
  let active = false;

  function swap(node, make) {
    const value = node.nodeValue ?? "";
    const known = memo.get(node);
    if (known && value === known.fake) return;
    const fake = make(value);
    if (typeof fake !== "string" || fake === value) {
      if (known) memo.delete(node);
      return;
    }
    memo.set(node, { real: value, fake });
    touched.add(node);
    node.nodeValue = fake;
  }

  /** Visible text nodes under `root`, skipping t3+'s own nodes and editable text. */
  function eachText(root, fn) {
    if (!root) return;
    const walker = doc.createTreeWalker(root, SHOW_TEXT);
    const nodes = [];
    for (let n = walker.nextNode(); n; n = walker.nextNode()) nodes.push(n);
    for (const n of nodes) {
      const parent = n.parentElement;
      // Editable text is the user's own typing (the composer); a contenteditable="false"
      // chip (a citation in a message) is not, and is covered like the text around it.
      if (!parent || parent.closest(`[${T3PLUS.ownedAttr}], [contenteditable]:not([contenteditable="false"]), .sr-only, script, style, textarea`)) continue;
      if (!n.nodeValue?.trim()) continue;
      fn(n, parent);
    }
  }

  /** An element's text as T3 wrote it: stand-ins read back as the real text they cover. */
  function realText(el) {
    if (!el) return "";
    let out = "";
    const walker = doc.createTreeWalker(el, SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const known = memo.get(n);
      out += known && known.fake === n.nodeValue ? known.real : (n.nodeValue ?? "");
    }
    return out;
  }

  /** Puts `fake` on a node, keeping the real text it covers (already covered or not). */
  function setFake(node, fake) {
    const known = memo.get(node);
    const real = known && node.nodeValue === known.fake ? known.real : (node.nodeValue ?? "");
    if (fake === real) {
      if (known) {
        node.nodeValue = real;
        memo.delete(node);
      }
      return;
    }
    memo.set(node, { real, fake });
    touched.add(node);
    if (node.nodeValue !== fake) node.nodeValue = fake;
  }

  /**
   * One name over several text nodes (T3 cuts a long name into a head and a tail
   * span): one stand-in for the whole, in the first node, the others emptied.
   * Swapped node by node, "maple-crm" + "orbit-sdk" came out glued together. When
   * React changes only one part, the whole gets its new stand-in (the head kept the
   * old one, and two branches looked the same).
   */
  function swapWhole(el, make) {
    if (!el) return;
    const nodes = [];
    eachText(el, (n) => nodes.push(n));
    if (nodes.length <= 1) {
      for (const n of nodes) swap(n, make);
      return;
    }
    const real = nodes.map((n) => (memo.get(n)?.fake === n.nodeValue ? memo.get(n).real : n.nodeValue)).join("");
    const fake = make(real);
    if (typeof fake !== "string" || fake === real) return;
    setFake(nodes[0], fake);
    for (const n of nodes.slice(1)) setFake(n, "");
  }

  // T3's own words where a name usually is: they stay (and do not use up a pool).
  const T3_WORDS = new Set(["Current checkout", "Local checkout", "New worktree", "Auto balance", "Local", "No project", "Choose a project", "New thread", "Settings", "T3 Code"]);
  const named = (kind) => (value) => {
    const core = value.trim();
    // A stand-in already (T3's exit animation clones a covered row): faked again, it
    // flickered to another name and was taken for a real one.
    if (!core || isNeutral(core) || T3_WORDS.has(core) || book.isFake(core)) return value;
    return value.replace(core, book.fake(kind, core));
  };
  /** A label already seen elsewhere (a project in the sidebar, say) gets the same stand-in. */
  const knownOr = (fallbackKind) => (value) => {
    const core = value.trim();
    const kind = book.kindOf(core) ?? (book.isFake(core) ? null : fallbackKind);
    return kind ? named(kind)(value) : value;
  };

  // ---- Project letter badges ----
  function badgeInfo(src) {
    if (badgeCache.has(src)) return badgeCache.get(src);
    let info = null;
    try {
      if (src.startsWith("data:image/svg+xml;base64,")) {
        const svg = atob(src.slice("data:image/svg+xml;base64,".length));
        if (/<text[\s>]/.test(svg)) info = { color: svg.match(/<rect[^>]*fill="([^"]+)"/)?.[1] ?? "#525252" };
      }
    } catch {
      info = null;
    }
    badgeCache.set(src, info);
    return info;
  }
  function coverBadge(img, project) {
    const info = img?.src ? badgeInfo(img.src) : null;
    if (!info) return;
    const letters = projectInitials(project);
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="${info.color}"/><text x="32" y="32" dy="0.35em" text-anchor="middle" font-family="ui-sans-serif, system-ui, -apple-system, sans-serif" font-size="26" font-weight="600" fill="#ffffff">${letters}</text></svg>`;
    const value = `url("data:image/svg+xml;base64,${btoa(svg)}")`;
    if (img.style.getPropertyValue("--t3plus-demo-badge") !== value) img.style.setProperty("--t3plus-demo-badge", value);
    if (!img.hasAttribute("data-t3plus-demo-badge")) img.setAttribute("data-t3plus-demo-badge", "");
    badges.add(img);
  }

  /** T3's inline letter badges (an <svg> with a <text>): the stand-in's initials. */
  function coverSvgBadge(container, project) {
    if (!container || !project) return;
    for (const text of container.querySelectorAll("svg text")) {
      eachText(text, (n) => swap(n, () => projectInitials(project)));
    }
  }

  // title attributes (native tooltips) swapped while covered: element -> real title.
  const titles = new Map();
  function coverTitleAttr(el, fake) {
    if (!el.hasAttribute("title")) return;
    if (!titles.has(el)) titles.set(el, el.getAttribute("title"));
    if (el.getAttribute("title") !== fake) el.setAttribute("title", fake);
  }
  // Paths and e-mail addresses inside T3's own sentences (an error line): the
  // sentence stays readable, the personal part does not.
  const redact = (v) => v.replace(/\/(Users|home)\/[^/\s]+/g, "/$1/me").replace(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g, "[email]");

  /**
   * T3's split names (a long branch: a head and a tail span, the whole in a native
   * tooltip, ThreadHoverCard, the composer's branch picker, the details card): one
   * stand-in for the whole, the tooltip too. The real name comes from the tooltip
   * the first time, from memory after that (the tooltip holds the stand-in by then).
   */
  function coverSplit(split, kind = "branch") {
    const real = (titles.get(split) ?? split.getAttribute("title") ?? realText(split)).trim();
    const fake = !real || (kind === "branch" && isPlainBranch(real)) || book.isFake(real) || T3_WORDS.has(real) ? real : book.fake(kind, real);
    swapWhole(split, () => fake);
    if (fake) coverTitleAttr(split, fake);
  }
  const SPLIT = "span[title]:has(> span + span)";

  /** A name inside one of T3's sentences: the stand-in it already has, or one of `kind`. */
  const coverName = (name, kind) => named(book.kindOf(name.trim()) ?? kind)(name);
  /**
   * T3's sentences that carry a name ("New thread in acme", "From Sam's Mac", a
   * worktree tooltip): the name gets its stand-in, T3's words stay.
   */
  const PHRASES = [
    (v) => v.replace(/^(\s*(?:New thread in|Project settings for|Cloned|Created) )(.+?)(\s*)$/, (_, a, name, z) => a + coverName(name, "project") + z),
    (v) => v.replace(/^(\s*From )(.+?)(\s*)$/, (_, a, name, z) => a + coverName(name, "machine") + z),
    (v) => v.replace(/^(\s*Started by an agent on )(.+?)( through a linked environment\.?\s*)$/, (_, a, name, z) => a + coverName(name, "machine") + z),
    (v) => v.replace(/^(\s*Worktree: )(.+?)(?: \((.+)\))?(\s*)$/, (_, a, tree, branch, z) => a + coverName(tree, "branch") + (branch ? ` (${coverName(branch, "branch")})` : "") + z),
  ];
  function phrase(value) {
    for (const cover of PHRASES) {
      const out = cover(value);
      if (out !== value) return out;
    }
    return null;
  }
  /** One text: a name t3+ has seen, one of T3's name sentences, or paths and e-mail addresses. */
  const generic = (value) => {
    const known = knownOr(null)(value);
    if (known !== value) return known;
    return redact(phrase(value) ?? value);
  };
  /**
   * Text in a T3 popup, toast or panel t3+ has no specific rule for. T3 often writes
   * a sentence as several text nodes ("From ", the name): an element holding only
   * text is read whole, so its sentence is still recognized.
   */
  function coverGeneric(root) {
    if (!root) return;
    const parents = new Set();
    eachText(root, (n, parent) => parents.add(parent));
    for (const el of parents) {
      const nodes = [...el.childNodes];
      if (nodes.length > 1 && nodes.every((c) => c.nodeType === 3 || c.nodeType === 8)) {
        const texts = nodes.filter((c) => c.nodeType === 3);
        const real = texts.map((n) => (memo.get(n)?.fake === n.nodeValue ? memo.get(n).real : n.nodeValue)).join("");
        const out = phrase(real);
        if (out !== null) {
          setFake(texts[0], redact(out));
          for (const n of texts.slice(1)) setFake(n, "");
          continue;
        }
      }
      for (const n of el.childNodes) if (n.nodeType === 3 && n.nodeValue?.trim()) swap(n, generic);
    }
  }

  // ---- Regions ----
  function sidebar(inner) {
    if (!inner) return;
    for (const row of inner.querySelectorAll("[data-sidebar-row]")) {
      const key = row.getAttribute("data-sidebar-row") ?? "";
      if (key.startsWith("folder:")) {
        // The name, as one; the monogram's letters are the badge's (initials), not a name.
        const nameEl = row.querySelector("span.truncate");
        let project = "";
        if (nameEl) {
          swapWhole(nameEl, named("project"));
          project = nameEl.textContent.trim();
        } else {
          eachText(row, (n, parent) => {
            if (parent.closest("svg")) return;
            swap(n, named("project"));
            project ||= n.nodeValue.trim();
          });
        }
        coverBadge(row.querySelector("img"), project);
        coverSvgBadge(row, project);
        continue;
      }
      if (row.getAttribute("role") !== "button") continue;
      // Every row shape (card, slim, folder) shows its title in an aria-hidden [dir] span.
      if (!row.hasAttribute(T3PLUS.botAttr)) eachText(row.querySelector('span[aria-hidden="true"][dir]') ?? row.querySelector("span[dir]"), (n) => swap(n, named("title")));
      // Card rows keep their lines in a body; project-grouped rows hold them directly.
      const body = row.querySelector(":scope > .relative.z-10") ?? row;
      const top = body.querySelector(":scope > .h-5");
      const projectEl = top?.querySelector(":scope > .truncate");
      eachText(projectEl, (n) => swap(n, named("project")));
      const project = projectEl?.textContent ?? "";
      coverBadge(top?.querySelector(":scope > img, :scope > span > img"), project);
      // Any letter badge on the line (a draft's icon can come first).
      coverSvgBadge(top, project);
      // A slim row (settled, snoozed) carries its project's badge in its one line;
      // its project is named only in the row's label, after the title and status.
      const slot = top ? null : row.querySelector(T3_SELECTORS.slimRowBadgeSlot);
      if (slot?.querySelector("svg text, img")) {
        const titleEl = row.querySelector('span[aria-hidden="true"][dir]') ?? row.querySelector("span[dir]");
        const real = parseRowProject(row.getAttribute("aria-label"), realText(titleEl).trim());
        if (real) {
          const stand = book.fake("project", real);
          coverSvgBadge(slot, stand);
          coverBadge(slot.querySelector("img"), stand);
        }
      }
      const meta = body.querySelector(":scope > .mt-0\\.5");
      if (meta) {
        // A leading icon means an environment (machine); otherwise a branch.
        const kind = meta.firstElementChild?.tagName?.toLowerCase() === "svg" ? "machine" : "branch";
        for (const child of meta.childNodes) {
          // A draft row puts the start of the unsent prompt here as bare text.
          if (child.nodeType === 3) {
            if (child.nodeValue?.trim()) swap(child, (v) => fakeProse(v, "user"));
            continue;
          }
          if (child.nodeType !== 1 || child.getAttribute("aria-hidden") === "true" || child.tagName.toLowerCase() === "svg") continue;
          swapWhole(child, named(kind));
        }
      }
    }
  }

  function header() {
    const nav = doc.querySelector('nav[aria-label="Thread breadcrumb"]');
    if (!nav) return;
    const items = [...nav.querySelectorAll("li")].filter((li) => li.getAttribute("aria-hidden") !== "true");
    items.forEach((li, index) => {
      // "From <machine>": a linked environment's label, next to the title.
      for (const badge of li.querySelectorAll('[data-slot="badge"]')) coverGeneric(badge);
      if (li.querySelector("[data-t3plus-bot-breadcrumb]")) return;
      const label = li.querySelector('[data-slot="workspace-breadcrumb-text"]');
      // The open thread is the current crumb (a thread without a project has no
      // project crumb); the first one before it is the project, any other a parent thread.
      const isProject = index === 0 && !li.hasAttribute("aria-current");
      if (label) swapWhole(label, named(isProject ? "project" : "title"));
      else eachText(li, (n, parent) => !parent.closest('[data-slot="badge"], svg') && swap(n, named(isProject ? "project" : "title")));
      if (isProject) {
        coverSvgBadge(li, label?.textContent ?? "");
        coverBadge(li.querySelector("img"), label?.textContent ?? "");
      }
    });
  }

  function hero() {
    for (const el of doc.querySelectorAll(".group\\/draft-hero [data-draft-project-trigger], .group\\/draft-hero .font-medium")) {
      eachText(el, (n) => swap(n, named("project")));
    }
  }

  /**
   * T3's thread hover card (ThreadHoverCard): the title, then one optional line
   * each, in this order, for the project (its badge), the machine, the branch (a
   * head and a tail span, the full name in a native tooltip), a "checked out on
   * another branch" warning, the model (a provider icon), "Handed off from …", the
   * terminal, the last error; then any pull requests ("#412 <its title>"). The
   * lines are optional, so each is told by its markup, never by its position.
   */
  function popups() {
    for (const popup of doc.querySelectorAll(T3_SELECTORS.tooltipPopup)) {
      const title = popup.querySelector(HOVER_CARD_TITLE);
      if (!title) {
        // Any other tooltip: a thread title, "New thread in <project>", a worktree
        // path, a PR's title and branches. Names seen elsewhere get their stand-ins.
        for (const split of popup.querySelectorAll(SPLIT)) coverSplit(split);
        coverGeneric(popup);
        continue;
      }
      if (!title.hasAttribute("data-t3plus-bot-hover")) eachText(title, (n) => swap(n, named("title")));
      let project = "";
      for (const line of popup.querySelectorAll(".grid > div")) {
        const split = line.querySelector("span[title]");
        if (split) {
          coverSplit(split);
          continue;
        }
        // The model ("Opus 5.5", "GPT-5.5 · Work"): its provider icon is grayscale. The
        // model stays; an instance name after " · " is the user's own label.
        if (line.querySelector(".grayscale")) {
          eachText(line, (n) => swap(n, (v) => (v.includes(" · ") ? v.replace(/ · (.+)$/, (_, name) => ` · ${book.fake("machine", name.trim())}`) : v)));
          continue;
        }
        if (line.querySelector('img, [data-slot="project-monogram"], svg text')) {
          eachText(line, (n, parent) => {
            if (parent.closest("svg")) return;
            swap(n, named("project"));
            project ||= n.nodeValue.trim();
          });
          coverBadge(line.querySelector("img"), project);
          coverSvgBadge(line, project);
          continue;
        }
        // T3's own sentences: the warning, "Handed off from …", the terminal, the error.
        const text = line.textContent.trim();
        if (line.matches(".text-warning, .text-error, .text-destructive") || /^(Handed off from|You're currently)|terminal process(es)? running/i.test(text)) {
          eachText(line, (n) => swap(n, redact));
          continue;
        }
        // What is left is the machine (any words: "Sam's MacBook Pro"), unless T3's "Local".
        eachText(line, (n) => {
          swap(n, (v) => {
            const core = v.trim();
            if (!core || isNeutral(core) || core === "Local" || book.isFake(core)) return v;
            return book.kindOf(core) ? knownOr(null)(v) : named("machine")(v);
          });
        });
      }
      // Pull requests: keep the number, cover the title.
      for (const item of popup.querySelectorAll("li")) {
        eachText(item, (n) => swap(n, (v) => (/^\s*#\d+\s*$/.test(v) || isNeutral(v.trim()) ? v : named("title")(v))));
      }
    }
  }

  /**
   * T3's command palette (⌘K). Its actions name the open thread ("Copy thread")
   * and projects ("New thread in …"), and its search lists threads with their
   * project, machine and a message snippet. Labels already seen in the sidebar
   * or header get the same stand-in; a thread result (it ends in "… ago") has its
   * title, project and snippet covered. T3's own command words stay, and so does
   * the part of the snippet that matches what was typed (<mark>).
   */
  const AGO = /^(\d+\s*(s|m|h|d|w|mo|y|sec|min|hr|day|week|month|year)s?\s+ago|just now|now)$/i;
  function palette() {
    for (const dialog of doc.querySelectorAll(T3_SELECTORS.commandPalette)) {
      for (const item of dialog.querySelectorAll(T3_SELECTORS.commandItem)) {
        const leaves = [...item.querySelectorAll("span, b, strong")].filter((el) => !el.querySelector("span, b, strong"));
        const thread = leaves.some((el) => AGO.test(el.textContent.trim()));
        const title = thread ? leaves.find((el) => el.textContent.trim() && !el.closest("kbd")) : null;
        // A project item ("New thread in…" lists them with their badge).
        const projectItem = !thread && Boolean(item.querySelector('[data-slot="project-monogram"], svg text'));
        eachText(item, (n, parent) => {
          swap(n, (v) => {
            const core = v.trim();
            if (!core || isNeutral(core) || AGO.test(core) || core === "You:" || parent.closest("mark, kbd")) return v;
            if (book.isFake(core)) return v;
            const kind = book.kindOf(core);
            if (kind) return named(kind)(v);
            // An action names a project in bold ("New thread in <b>project</b>"), or the
            // item is a project; anything else is T3's own words (a command, a setting).
            if (!thread) return parent.closest("b, strong") || (projectItem && !parent.closest("svg")) ? named("project")(v) : v;
            if (title?.contains(n)) return named("title")(v);
            // The message snippet: its own small spans ("project · machine" is small text too).
            if (parent.matches(".text-xs") && !core.includes(" · ")) return fakeProse(v);
            if (core === "Local") return v; // T3's word for this machine
            // "project · machine" in one span, or each in its own span after a "·".
            const afterDot = parent.previousElementSibling?.textContent.trim() === "·";
            return v
              .split(" · ")
              .map((part, i) => {
                const p = part.trim();
                if (!p || p === "Local" || isNeutral(p) || book.isFake(p)) return part;
                return part.replace(p, book.fake(book.kindOf(p) ?? (i === 0 && !afterDot ? "project" : "machine"), p));
              })
              .join(" · ");
          });
        });
      }
    }
  }

  /**
   * T3's composer controls: the machine it runs on ("Run on", "Run context: studio-mac,
   * Local checkout"), the workspace ("Current checkout", "New worktree", or a worktree's
   * name) and the branch (a split name). T3's own words stay (named()).
   */
  function runContexts(root) {
    for (const control of root.querySelectorAll("[data-composer-context-control], [aria-label^='Branch: ']")) {
      const label = control.querySelector("[data-composer-label]");
      if (!label) continue;
      const aria = control.getAttribute("aria-label") ?? "";
      const shortcut = control.getAttribute("data-composer-shortcut") ?? "";
      if (aria.startsWith("Branch: ")) {
        const split = label.querySelector(SPLIT) ?? label.querySelector("span[title]");
        if (split) coverSplit(split);
        else swapWhole(label, named("branch"));
      } else if (shortcut === "composer.workspace") {
        swapWhole(label, named("branch"));
      } else {
        swapWhole(label, named("machine"));
      }
    }
  }

  // The window title ("Project / Thread") is what the Dock, Mission Control, the
  // Window menu and screen-share pickers show: covered with the same stand-ins
  // as the breadcrumb. One-part titles ("T3 Code", "Settings") are T3's own words.
  // T3's formats: "project / thread", the screen-reader setting's "Working: thread -
  // project", the web build's "… - T3 Code (Nightly)" suffix, and a thread alone.
  let title = null; // { real, fake }
  function windowTitle() {
    const value = doc.title ?? "";
    if (title && value === title.fake) return;
    const suffix = / [-—] T3 Code(?: \([^)]*\))?$/.exec(value)?.[0] ?? "";
    let rest = value.slice(0, value.length - suffix.length);
    const status = /^[A-Z][a-z]+(?: [a-z]+)*: /.exec(rest)?.[0] ?? "";
    rest = rest.slice(status.length);
    const slash = rest.includes(" / ");
    const parts = rest.split(slash ? " / " : " - ");
    const fake = parts
      .map((part, i) => {
        const core = part.trim();
        if (!core || isNeutral(core) || T3_WORDS.has(core) || book.isFake(core)) return part;
        // A name seen in the sidebar or header keeps its kind; otherwise by place:
        // "project / thread", "thread - project", or a thread alone.
        const kind = book.kindOf(core) ?? (parts.length === 1 ? null : (slash ? i === 0 : i > 0) ? "project" : "title");
        return kind ? part.replace(core, book.fake(kind, core)) : part;
      })
      .join(slash ? " / " : " - ");
    const next = status + fake + suffix;
    title = next === value ? null : { real: value, fake: next };
    if (title) doc.title = next;
  }
  function restoreTitle() {
    if (title && doc.title === title.fake) doc.title = title.real;
    title = null;
  }
  // T3 writes the real title back whenever it changes anything (a status update):
  // covered again right then, in the same task, not a frame later when the next
  // check runs (long enough for the Window menu or a share picker to show it).
  let titleWatch = null; // { el, observer }
  function watchTitle(on) {
    const el = on ? doc.querySelector("title") : null;
    if (titleWatch && titleWatch.el === el) return;
    titleWatch?.observer.disconnect();
    titleWatch = null;
    const MO = doc.defaultView?.MutationObserver;
    if (!el || !MO) return;
    const observer = new MO(() => {
      if (active) windowTitle();
    });
    observer.observe(el, { childList: true, characterData: true, subtree: true });
    titleWatch = { el, observer };
  }

  function details() {
    const card = doc.querySelector(T3_SELECTORS.threadDetailsCard);
    if (!card) return;
    for (const section of card.querySelectorAll("section")) {
      // Named by aria-label, or (a section that shows its heading) by aria-labelledby.
      const heading = section.getAttribute("aria-labelledby");
      const label = section.getAttribute("aria-label") ?? (heading ? doc.getElementById(heading)?.textContent.trim() : "") ?? "";
      const isHeading = (parent) => Boolean(parent.closest("h2, h3"));
      if (label === "Workspace") {
        runContexts(section);
        coverGeneric(section);
      } else if (label === "Automations" || section.hasAttribute("data-thread-automations-panel")) {
        eachText(section, (n, parent) => {
          const core = n.nodeValue.trim();
          if (SCHEDULE.test(core) || /\d:\d/.test(core) || isHeading(parent)) return;
          swap(n, named("automation"));
        });
      } else if (label === "Side chats" || label === "Lineage" || section.hasAttribute("data-thread-side-chats-panel")) {
        // Other threads' titles.
        eachText(section, (n, parent) => !isHeading(parent) && swap(n, (v) => (AGO.test(v.trim()) ? v : named(book.kindOf(v.trim()) ?? "title")(v))));
      } else {
        // Version Control and the rest: branches (split names), "#412: <PR title>".
        for (const split of section.querySelectorAll(SPLIT)) coverSplit(split);
        eachText(section, (n, parent) => {
          if (isHeading(parent)) return;
          swap(n, (v) => {
            const pr = /^(\s*#\d+:\s*)(.+?)(\s*)$/.exec(v);
            return pr ? pr[1] + named("title")(pr[2]) + pr[3] : generic(v);
          });
        });
      }
    }
  }

  function composer() {
    for (const area of doc.querySelectorAll(T3_SELECTORS.composerOverlay)) {
      runContexts(area);
      coverGeneric(area);
    }
  }

  function timeline() {
    // Every timeline: a side chat in the right panel has its own.
    for (const list of doc.querySelectorAll(T3_SELECTORS.messageList)) timelineRows(list);
  }
  function timelineRows(list) {
    for (const row of list.querySelectorAll("[data-timeline-row-id]")) {
      const kind = row.getAttribute("data-timeline-row-kind") ?? "";
      if (kind === "turn-fold" || kind === "work-toggle") continue;
      const role = row.getAttribute("data-message-role");
      if (role === "user") {
        eachText(row, (n, parent) => swap(n, (v) => (parent.closest("pre") ? fakeCode(v) : parent.closest("code") ? fakeIdentifier(v) : fakeProse(v, "user"))));
        continue;
      }
      eachText(row, (n, parent) => {
        swap(n, (v) => {
          if (parent.closest("pre")) return fakeCode(v);
          if (parent.closest("code")) return fakeIdentifier(v);
          if (parent.closest(".chat-markdown")) return fakeProse(v);
          const core = v.trim();
          if (isNeutral(core)) return v;
          if (parent.closest('[data-v2-item-type="command_execution"]')) return fakeCommand(v);
          // File and folder names (file lists, work rows).
          if (!/\s/.test(core)) return /[./_-]/.test(core) || parent.closest(".font-mono") ? fakeIdentifier(v) : v;
          // Longer text in a work row is the agent's own (a tool summary, a search);
          // short phrases elsewhere are T3's labels ("10 changed files", "Open diff").
          if (kind === "work" && core.split(/\s+/).length > 3) return fakeProse(v);
          return v;
        });
      });
    }
  }

  /**
   * T3's other popups, portaled to <body>: menus and pickers (projects, branches,
   * machines), toasts ("Cloned …"), dialogs ("Project settings for …"). Names seen
   * elsewhere get their stand-ins; paths and e-mail addresses are hidden.
   */
  const PORTALS = '[role="menu"], [role="listbox"], [role="dialog"], [role="alertdialog"], [data-slot$="-popup"], [data-sonner-toast], [role="status"][aria-live], [role="alert"]';
  function portals() {
    const body = doc.body;
    if (!body) return;
    for (const el of body.querySelectorAll(PORTALS)) {
      if (el.closest(`#${T3_SELECTORS.appRootId}, [${T3PLUS.ownedAttr}], ${T3_SELECTORS.tooltipPopup}, ${T3_SELECTORS.commandPalette}`)) continue;
      if (el.querySelector(T3_SELECTORS.commandPalette)) continue; // ⌘K has its own rules (palette)
      for (const split of el.querySelectorAll(SPLIT)) coverSplit(split);
      coverGeneric(el);
    }
  }

  return {
    book,
    realText,
    get active() {
      return active;
    },
    /** Covers every region. Cheap when nothing changed: covered nodes are skipped. */
    apply({ sidebarInner = null } = {}) {
      active = true;
      sidebar(sidebarInner);
      header();
      hero();
      popups();
      details();
      composer();
      timeline();
      palette();
      portals();
      windowTitle();
      watchTitle(true);
    },
    /** Just the popups: hover cards, tooltips, the command palette, menus (called before paint when one opens). */
    applyPopups() {
      if (!active) return;
      popups();
      palette();
      portals();
    },
    /** A stand-in for labels t3+ draws itself (bots). */
    label(kind, real) {
      return book.fake(kind, real);
    },
    /** Puts every real text and badge back. */
    restore() {
      active = false;
      watchTitle(false);
      restoreTitle();
      for (const [el, real] of titles) if (el.isConnected) el.setAttribute("title", real);
      titles.clear();
      for (const node of touched) {
        const known = memo.get(node);
        if (known && node.nodeValue === known.fake) node.nodeValue = known.real;
        memo.delete(node);
      }
      touched.clear();
      for (const img of badges) {
        img.removeAttribute("data-t3plus-demo-badge");
        img.style.removeProperty("--t3plus-demo-badge");
        if (img.getAttribute("style") === "") img.removeAttribute("style");
      }
      badges.clear();
    },
    /** Drops references to nodes T3 removed (keeps the sets small on long sessions). */
    prune() {
      for (const node of touched) if (!node.isConnected) touched.delete(node);
      for (const img of badges) if (!img.isConnected) badges.delete(img);
      // Hover cards come and go: forget the tooltips of ones T3 removed.
      for (const el of titles.keys()) if (!el.isConnected) titles.delete(el);
    },
  };
}
