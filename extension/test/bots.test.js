import assert from "node:assert/strict";
import { test } from "node:test";
import {
  assignBotShapes,
  BOT_GRID,
  botArt,
  botClipPath,
  botEdgeColor,
  botFillUrl,
  botStill,
  defaultBotColor,
  defaultBotShape,
  ditherIndex,
  eyeCells,
  eyeOutline,
  setBotArtEncoder,
  setBotStyle,
  skinMarks,
} from "../src/botArt.js";
import { bayerMatrix, DITHER_STYLES, ditherLevel, ditherRgbInPlace, glowPixelArt, glowStrength, glowTones, grainThreshold, GLOW_SHAPE } from "../src/ditherMath.js";
import { ditherGrid } from "../src/backdropRenderer.js";
import { botPreviewText, createBotFeed, parseBotFeedText, threadIdFromKey } from "../src/botFeed.js";
import {
  classifyBots,
  createBotStore,
  decorateBotRows,
  normalizeBotPrefs,
  normalizeKnownBots,
  parseBotTitle,
  parseRowStatus,
  resolveBotPresentation,
  subagentFace,
} from "../src/bots.js";
import { BOT_COLORS, BOT_SHAPES, BOT_SKINS, BOT_STYLES as STYLES, DEFAULT_BOT_MARKER, PICKABLE_BOT_COLORS, STORAGE_KEYS, T3PLUS } from "../src/config.js";
import { BOT_FEED_ENDPOINT } from "../src/hosts.js";
import { findSidebarInner, scanSidebar } from "../src/sidebar.js";
import { setSprite } from "../src/spriteClock.js";
import {
  BOT_TITLE,
  createApp,
  createDom,
  createFakeChromeStorage,
  createFakeRemote,
  settle,
  sidebarHtml,
  T3_APPEARANCE_HTML,
  threadRowHtml,
  virtualClock,
} from "./helpers.js";

test("parseBotTitle matches the exact marker token only (first or last word)", () => {
  const M = DEFAULT_BOT_MARKER;
  assert.deepEqual(parseBotTitle(`${M} Orchestrator`), { label: "Orchestrator" });
  assert.deepEqual(parseBotTitle(`Release captain ${M}`), { label: "Release captain" });
  assert.deepEqual(parseBotTitle(M), { label: "" });
  assert.deepEqual(parseBotTitle(`  ${M}   Night   shift `), { label: "Night shift" });
  for (const title of [
    "Orchestrator",
    `x${M} Orchestrator`, // glued to another word
    `${M}x Orchestrator`,
    `Talk about ${M} markers`, // middle word: not a marker position
    `​${M} Orchestrator`, // zero-width prefix is not the marker
    `${M.toUpperCase()} Orchestrator`,
    "[[t3plus:bot:v2]] Orchestrator",
    "bot Orchestrator",
  ]) {
    assert.equal(parseBotTitle(title), null, JSON.stringify(title));
  }
  assert.deepEqual(parseBotTitle("[[acme:bot]] Ops", "[[acme:bot]]"), { label: "Ops" });
  assert.equal(parseBotTitle("bot Ops", "bot"), null, "an invalid marker never matches");
});

test("parseRowStatus reads T3's status label from the row's aria-label", () => {
  const t = "[[t3plus:bot:v1]] Ops, with a comma";
  assert.equal(parseRowStatus(`${t}, Working, Ops project`, t), "working");
  assert.equal(parseRowStatus(`${t}, Goal`, t), "working");
  assert.equal(parseRowStatus(`${t}, Approval, P`, t), "attention");
  assert.equal(parseRowStatus(`${t}, Failed`, t), "failed");
  assert.equal(parseRowStatus(`${t}, Done, P`, t), "done");
  assert.equal(parseRowStatus(`${t}, Waiting`, t), "waiting");
  assert.equal(parseRowStatus(`${t}, Ops project`, t), "idle");
  assert.equal(parseRowStatus("something else", t), "idle");
});

test("classifyBots: top-level rows only, with a child count from data-sidebar-parent", () => {
  const html = sidebarHtml().replace(
    "</ul>",
    `${threadRowHtml({ key: "env1:c1", title: "Subtask A", parent: "env1:bot1" })}
     ${threadRowHtml({ key: "env1:c2", title: "Subtask B", parent: "env1:bot1" })}
     ${threadRowHtml({ key: "env1:nested", title: `${DEFAULT_BOT_MARKER} Nested`, parent: "env1:bot1" })}
     ${threadRowHtml({ key: "env1:inf", title: `${DEFAULT_BOT_MARKER} In folder`, parent: "folder:github.com/acme/api" })}</ul>`,
  );
  const dom = createDom("/", html);
  const scan = scanSidebar(findSidebarInner(dom.window.document));
  const bots = classifyBots(scan, DEFAULT_BOT_MARKER);
  assert.deepEqual(bots.map((b) => b.key), ["env1:bot1", "env1:inf"]);
  assert.equal(bots[0].childCount, 3);
  assert.equal(bots[0].status, "working");
  assert.equal(bots[0].titleLabel, "Orchestrator");
});

test("bot prefs are a shape and a color from fixed lists; unknown values fall back safely", () => {
  assert.deepEqual(normalizeBotPrefs({ shape: "triangle", color: "orange" }), { shape: "triangle", color: "orange" });
  const odd = normalizeBotPrefs({ shape: "blob", color: "#ff0000", accent: "#ff0000", iconDataUrl: "javascript:alert(1)" }, "env1:bot1");
  assert.deepEqual(Object.keys(odd), ["shape", "color"], "no free-form color, icon or label fields");
  assert.equal(odd.shape, "auto", "nothing valid picked: the bot gets its own shape when drawn");
  assert.equal(odd.color, "project", "nothing valid picked: the bot follows its project's color");
  const auto = resolveBotPresentation({ key: "env1:bot1", titleLabel: "Orchestrator" }, odd);
  assert.ok(Object.hasOwn(BOT_SHAPES, auto.shape) && !Object.hasOwn(BOT_SKINS, auto.shape), "a real shape, never a ball");
  assert.equal(auto.shape, resolveBotPresentation({ key: "env1:bot1" }, null).shape, "stable per bot");
  assert.equal(auto.paint, defaultBotColor("env1:bot1"), "no project color known: a stable named color");
  const shapesSeen = new Set(["env1:a", "env1:b", "env1:c", "env1:d", "env1:e", "env1:f", "env1:g", "env1:h"].map((key) => resolveBotPresentation({ key }, null).shape));
  assert.ok(shapesSeen.size >= 4, "different bots get different shapes");

  const view = resolveBotPresentation({ key: "env1:bot1", titleLabel: "Orchestrator" }, { shape: "star", color: "green" });
  assert.equal(view.label, "Orchestrator");
  assert.equal(view.clip, BOT_SHAPES.star);
  assert.equal(view.edge, BOT_COLORS.green.stops[1]);
  assert.match(view.fill, /^url\("data:image\/svg\+xml,/);
  assert.equal(resolveBotPresentation({ key: "k:1", titleLabel: "" }, {}).label, "Bot");
});

test("every color is a fixed three-stop ordered-dither gradient with white pixel eyes", () => {
  for (const [name, color] of Object.entries(BOT_COLORS)) {
    for (const shape of Object.keys(BOT_SHAPES).filter((s) => !Object.hasOwn(BOT_SKINS, s) && !STYLES.blobs.shapes.includes(s))) {
      const svg = decodeURIComponent(botFillUrl(name, shape).slice('url("data:image/svg+xml,'.length, -2));
      const fills = [...svg.matchAll(/fill="(#[0-9a-f]{6})"/g)].map((m) => m[1]);
      assert.deepEqual(fills, [...color.stops, "#ffffff"], `${name}/${shape}: three stops, then the eyes`);
      assert.match(svg, /shape-rendering="crispEdges"/);
    }
  }
  // Light at the top-left highlight, dark at the far corner, dithered in between.
  assert.equal(ditherIndex(5, 4), 0);
  assert.equal(ditherIndex(BOT_GRID - 1, BOT_GRID - 1), 2);
  const row = Array.from({ length: BOT_GRID }, (_, x) => ditherIndex(x, 12));
  assert.ok(new Set(row).size >= 2, "a middle row mixes stops");
  let drawn = 0;
  setBotArtEncoder(() => ((drawn += 1), "data:image/png;base64,AAAA"));
  try {
    botFillUrl("blue", "star");
    botFillUrl("blue", "star");
    assert.equal(drawn, 1, "drawn once, then cached");
  } finally {
    setBotArtEncoder(null);
  }
  assert.equal(botFillUrl("nope", "nope"), botFillUrl("blue", "circle"));
});

test("Saturn's sky stays see-through: nothing is painted behind it, so it is no square", () => {
  assert.equal(botEdgeColor("blue", "saturn"), "transparent");
  assert.equal(resolveBotPresentation({ key: "k:1", titleLabel: "Ring" }, { shape: "saturn" }).edge, "transparent");
  const shapesWithSky = Object.keys(BOT_SHAPES).filter((shape) => [...skinMarks(shape).values()].includes("t"));
  assert.deepEqual(shapesWithSky, ["saturn"]);
  // (and the blobs, which keep to their own outline)
  for (const shape of Object.keys(BOT_SHAPES).filter((s) => s !== "saturn" && !STYLES.blobs.shapes.includes(s))) assert.notEqual(botEdgeColor("blue", shape), "transparent", shape);
  // Its square clip is what lets the ring reach the tile's edges.
  assert.equal(BOT_SHAPES.saturn, "inset(0)");
});

test("ball shapes: football and basketball bring their own ramp and markings in every mood", () => {
  const svgOf = (art) => decodeURIComponent(art.url.slice('url("data:image/svg+xml,'.length, -2));
  const moods = ["awake", "idle", "waiting", "done", "failed", "working", "attention"];
  for (const shape of ["football", "basketball"]) {
    assert.ok(Object.hasOwn(BOT_SHAPES, shape) && Object.hasOwn(BOT_SKINS, shape), shape);
    const stops = BOT_SKINS[shape].stops;
    assert.equal(stops.length, 3);
    for (const mood of moods) {
      const art = botArt("blue", shape, mood);
      const fills = [...svgOf(art).matchAll(/fill="(#[0-9a-f]{6})"/g)].map((m) => m[1]);
      assert.deepEqual(fills, [...stops, "#ffffff"], `${shape}/${mood}: own three stops, then white eyes and marks`);
      assert.equal(art.frames, botArt("blue", "circle", mood).frames, `${shape}/${mood}: same frame count`);
      assert.equal(art.duration, botArt("blue", "circle", mood).duration);
      assert.match(svgOf(art), new RegExp(`viewBox="0 0 ${24 * art.frames} 24"`));
      // The bot's color is ignored: every color gives the same ball.
      for (const color of Object.keys(BOT_COLORS)) assert.equal(botArt(color, shape, mood).url, art.url);
    }
    assert.equal(botEdgeColor("purple", shape), stops[1]);
    assert.equal(resolveBotPresentation({ key: "k:1", titleLabel: "Goat" }, { shape, color: "green" }).edge, stops[1]);
  }
  // Football laces are white, basketball seams are the dark stop.
  const laces = [...skinMarks("football").values()];
  assert.ok(laces.length >= 12 && laces.every((layer) => layer === 3), "white laces");
  const seams = [...skinMarks("basketball").values()];
  assert.ok(seams.length >= 40 && seams.every((layer) => layer === 2), "dark seams");
  // Laces never touch the eyes or their outline, in any frame of any mood.
  const glyphs = ["open", "closed", "lidded", "wide", "happy", "x"];
  for (const eyes of glyphs) {
    for (const dx of [-1, 0, 1]) {
      for (const dy of [-1, 0]) {
        if (dx && dy) continue; // working moves sideways, attention hops: never both
        const cells = eyeCells("football", { eyes, dx, dy });
        const around = eyeOutline(cells);
        for (const lace of skinMarks("football").keys()) assert.ok(!cells.has(lace) && !around.has(lace), `${eyes} ${dx},${dy}: lace ${lace}`);
      }
    }
  }
  // Even hopping wide eyes stay below the laces.
  for (const cell of eyeCells("football", { eyes: "wide", dy: -1 })) assert.ok(Number(cell.split(",")[1]) >= 9);
});

test("eyes: two separate eyes per shape, inside the shape's clip, mirrored around its middle", () => {
  for (const shape of Object.keys(BOT_SHAPES)) {
    const cells = [...eyeCells(shape)].map((c) => c.split(",").map(Number));
    assert.ok(cells.length >= 12, shape);
    const xs = cells.map(([x]) => x);
    const mid = (Math.min(...xs) + Math.max(...xs)) / 2; // the football's pair sits off-center, on its open side
    const left = xs.filter((x) => x < mid).length;
    assert.equal(left, cells.length - left, `${shape}: two equal eyes`);
    for (const [x, y] of cells) assert.ok(x >= 4 && x <= 19 && y >= 6 && y <= 19, `${shape}: eye cell ${x},${y} near the center`);
  }
  assert.notDeepEqual([...eyeCells("triangle")], [...eyeCells("circle")], "triangle eyes sit lower");
});

test("background dither: pixel-art glow made of a few far-apart tones, never a flat fill", () => {
  const m = bayerMatrix(16);
  assert.equal(new Set(m.flat()).size, 256, "every threshold used once");
  assert.equal(ditherLevel(0, 7, 0.5), 0);
  assert.equal(ditherLevel(1, 7, 0.5), 6);

  const width = 96;
  const height = 48;
  const rgb = [59, 130, 246];
  for (const style of DITHER_STYLES) {
    const px = glowPixelArt({ width, height, cx: 0.5, rgb, intensity: 0.55, style });
    const colors = new Set();
    for (let i = 0; i < px.length; i += 4) if (px[i + 3]) colors.add(`${px[i]},${px[i + 1]},${px[i + 2]}`);
    assert.ok(colors.size >= 3 && colors.size <= 4, `${style}: only its few tones (${colors.size})`);
    // The tones are far apart in lightness: that is what keeps the pattern visible.
    const lum = [...colors].map((c) => c.split(",").map(Number)).map(([r, g, b]) => 0.2126 * r + 0.7152 * g + 0.0722 * b);
    assert.ok(Math.max(...lum) - Math.min(...lum) > 90, `${style}: tones far apart`);
    // Even the core keeps mixing two tones: no flat, smooth-looking area.
    const core = new Set();
    for (let y = 40; y < 48; y += 1) for (let x = 40; x < 56; x += 1) { const i = (y * width + x) * 4; core.add(`${px[i]},${px[i + 1]},${px[i + 2]},${px[i + 3]}`); }
    assert.ok(core.size >= 2, `${style}: the core is dithered, not flat`);
    assert.equal(px[3], 0, `${style}: top-left corner is clear`);
  }
  // Spectrum drifts in hue; bayer and grain keep one hue.
  const hueSpread = (style) => {
    const tones = glowTones(rgb, style).slice(1).map(([c]) => c);
    return Math.max(...tones.map((c) => c[1] - c[2])) - Math.min(...tones.map((c) => c[1] - c[2]));
  };
  assert.ok(hueSpread("spectrum") > hueSpread("bayer"));
  // Grain is not Bayer's grid: its thresholds do not repeat every 16 cells.
  let repeats = 0;
  for (let x = 0; x < 64; x += 1) repeats += grainThreshold(x, 3) === grainThreshold(x + 16, 3) ? 1 : 0;
  assert.ok(repeats < 4);

  const data = new Uint8ClampedArray([100, 150, 200, 255, 100, 150, 200, 255]);
  ditherRgbInPlace(data, 2, 1, 4);
  for (const v of data) assert.ok([0, 85, 170, 255].includes(v), `quantized ${v}`);

  // Cells are whole device pixels; huge panes get coarser cells instead of huge canvases.
  assert.deepEqual(ditherGrid(1500, 900, 1.5), { cell: 2, cols: 750, rows: 450 });
  const big = ditherGrid(3840, 2160, 2);
  assert.ok(big.cols * big.rows <= 1_200_000);
  assert.equal(Number.isInteger(big.cell * 2), true);
});

test("the glow stays near the composer: compact enough not to reach the top half or the far sides", () => {
  assert.ok(GLOW_SHAPE.haloRy < 0.5, "never reaches the middle of the pane");
  assert.equal(glowStrength(0.5, 0.45, 0.5, 1), 0, "nothing above ~55% height");
  assert.equal(glowStrength(0, 0.98, 0.5, 1), 0, "the far left edge is clear at the bottom");
  assert.ok(glowStrength(0.5, 0.97, 0.5, 0.55) > 0.4, "strong behind the composer");
});

test("bot store keeps shape/color per thread key and drops bad keys", async () => {
  const storage = createFakeChromeStorage();
  const store = createBotStore(storage.area, storage.onChanged);
  await store.update("env1:bot1", { shape: "hexagon" });
  await store.update("env1:bot1", { color: "pink" });
  assert.deepEqual((await store.load())["env1:bot1"], { shape: "hexagon", color: "pink" });
  storage.area.data.set(STORAGE_KEYS.bots, { "env1:bot1": { shape: "x", color: "teal", iconDataUrl: "data:text/html,<b>" }, "bad key": {} });
  assert.deepEqual(await store.load(), { "env1:bot1": { shape: "auto", color: "teal" } });
});

test("bot feed: parses t3plus-bots.json by thread id and builds the preview line", async () => {
  const text = JSON.stringify({
    version: 1,
    generatedAt: "2026-11-11T00:00:00Z",
    bots: {
      "thread:mcp:abc:1": { text: "  Ran   the nightly sync.\nAll green. ", role: "assistant", at: "2026-11-11T00:00:00Z" },
      bot1: { text: "check the deploy", role: "user" },
      "bad id": { text: "x" },
      empty: { text: "   " },
    },
  });
  const feed = parseBotFeedText(text);
  assert.deepEqual([...feed.entries.keys()], ["thread:mcp:abc:1", "bot1", "empty"]);
  assert.equal(threadIdFromKey("env-9:thread:mcp:abc:1"), "thread:mcp:abc:1", "thread ids may contain colons");
  assert.equal(botPreviewText(feed, "env-9:thread:mcp:abc:1"), "Ran the nightly sync. All green.");
  assert.equal(botPreviewText(feed, "env1:bot1"), "You: check the deploy");
  assert.equal(botPreviewText(feed, "env1:empty"), "No messages yet", "in the feed, without a message");
  assert.equal(botPreviewText(feed, "env1:other"), "", "not in the feed at all: no claim about its messages");
  assert.equal(botPreviewText(null, "env1:bot1"), "", "no feed yet: no text rather than a wrong claim");
  for (const bad of ["", "nope", "{}", JSON.stringify({ version: 2, bots: {} })]) assert.equal(parseBotFeedText(bad), null);

  // Loads through the background fetcher, caches, and falls back to the cache.
  const storage = createFakeChromeStorage();
  const remote = createFakeRemote({ ok: true, status: 200, text });
  const loader = createBotFeed({ area: storage.area, fetchRemote: remote });
  assert.equal((await loader.load()).entries.size, 3);
  assert.deepEqual(remote.calls, [BOT_FEED_ENDPOINT]);
  remote.response = { ok: false, status: 0, error: "offline" };
  assert.equal((await loader.load()).entries.size, 3, "cached copy");
});

test("decorateBotRows lays out name, preview and avatar on T3's row in place; idempotent and reversible", () => {
  const dom = createDom("/", sidebarHtml());
  const doc = dom.window.document;
  const inner = findSidebarInner(doc);
  const scan = scanSidebar(inner);
  const bots = classifyBots(scan, DEFAULT_BOT_MARKER);
  const li = doc.querySelector('[data-thread-item="env1:bot1"]');
  const row = li.querySelector("[data-sidebar-row]");
  const before = { parent: li.parentElement, index: [...li.parentElement.children].indexOf(li), aria: row.getAttribute("aria-label") };
  const prefs = { "env1:bot1": { shape: "triangle", color: "red" } };
  const preview = (key) => (key === "env1:bot1" ? "Synced 3 repos." : "");

  decorateBotRows(doc, scan, bots, prefs, preview);
  assert.equal(row.getAttribute(T3PLUS.botAttr), "working");
  assert.equal(row.getAttribute("aria-description"), "t3+ bot: Orchestrator. Synced 3 repos.");
  const title = row.querySelector(`[${T3PLUS.botTitleAttr}]`);
  assert.equal(title.getAttribute(T3PLUS.botTitleAttr), "Synced 3 repos.");
  assert.equal(title.textContent, BOT_TITLE, "T3's title text is untouched");
  assert.equal(row.querySelector(".sr-only").textContent, BOT_TITLE);
  const avatar = row.querySelector(".t3plus-bot-avatar");
  assert.equal(avatar.parentElement, row);
  assert.equal(avatar.getAttribute("data-t3plus-shape"), "triangle");
  assert.equal(avatar.style.getPropertyValue("--t3plus-bot-clip"), BOT_SHAPES.triangle);
  assert.equal(avatar.style.getPropertyValue("--t3plus-bot-edge"), BOT_COLORS.red.stops[1]);
  assert.equal(avatar.getAttribute("data-status"), "working");
  // Not moved, not re-parented, aria-label untouched.
  assert.equal(li.parentElement, before.parent);
  assert.equal([...li.parentElement.children].indexOf(li), before.index);
  assert.equal(row.getAttribute("aria-label"), before.aria);

  // Second run adds nothing.
  decorateBotRows(doc, scanSidebar(inner), bots, prefs, preview);
  assert.equal(row.querySelectorAll(`[${T3PLUS.ownedAttr}]`).length, 1);

  // The title loses its marker (renamed in T3): decoration is removed.
  row.querySelector(".sr-only").textContent = "Orchestrator";
  title.textContent = "Orchestrator";
  const rescanned = scanSidebar(inner);
  decorateBotRows(doc, rescanned, classifyBots(rescanned, DEFAULT_BOT_MARKER), {});
  assert.equal(row.hasAttribute(T3PLUS.botAttr), false);
  assert.equal(row.hasAttribute("aria-description"), false);
  assert.equal(row.querySelectorAll(`[${T3PLUS.ownedAttr}], [${T3PLUS.botTitleAttr}]`).length, 0);
  assert.equal(row.getAttribute("style"), null);
});

test("app: bot rows show the feed preview, and Settings edits shape and color", async () => {
  const storage = createFakeChromeStorage();
  const feedText = JSON.stringify({ version: 1, bots: { bot1: { text: "Nightly run done.", role: "assistant" } } });
  const botFeed = createBotFeed({ area: storage.area, fetchRemote: createFakeRemote({ ok: true, status: 200, text: feedText }) });
  const sidebar = createDom("/env1/a1", sidebarHtml({ currentKey: "env1:a1" }));
  const sdoc = sidebar.window.document;
  const sideApp = createApp(sidebar, storage, { botFeed }).app;
  await sideApp.start();
  await settle();
  sideApp.watcher.flush();

  const row = sdoc.querySelector('[data-sidebar-row="env1:bot1"]');
  assert.equal(row.getAttribute(T3PLUS.botAttr), "working");
  assert.equal(row.querySelector(`[${T3PLUS.botTitleAttr}]`).getAttribute(T3PLUS.botTitleAttr), "Nightly run done.");
  assert.equal(sdoc.querySelectorAll('[data-sidebar-row="env1:bot1"]').length, 1);
  const plain = sdoc.querySelector('[data-sidebar-row="env1:a1"]');
  assert.equal(plain.hasAttribute(T3PLUS.botAttr), false);
  assert.equal(plain.querySelectorAll(`[${T3PLUS.ownedAttr}]`).length, 0);
  assert.equal(storage.area.data.get(STORAGE_KEYS.knownBots)["env1:bot1"].title, BOT_TITLE);

  // Settings tab lists the known bot with shape and color pickers, and nothing else to edit.
  const settings = createDom("/settings/appearance", T3_APPEARANCE_HTML);
  const settingsApp = createApp(settings, storage, { botFeed }).app;
  await settingsApp.start();
  await settle();
  const sdocSettings = settings.window.document;
  const chip = sdocSettings.querySelector('.t3plus-bot-pick[data-bot-key="env1:bot1"]');
  assert.ok(chip, "a bot in the list");
  // The first bot (A to Z) is the one picked: shown on the right.
  assert.equal(chip.getAttribute("aria-selected"), "true");
  const editor = sdocSettings.querySelector('.t3plus-bot-editor[data-bot-key="env1:bot1"]');
  assert.ok(editor);
  chip.click();
  assert.equal(sdocSettings.querySelectorAll(".t3plus-bot-editor").length, 1, "one at a time");
  assert.equal(chip.querySelector(".t3plus-bot-name").textContent, "Orchestrator");
  assert.equal(chip.querySelector(".t3plus-bot-line").textContent, "Nightly run done.", "its latest message, under its name");
  assert.equal(editor.querySelector(".t3plus-bot-hero-name").textContent, "Orchestrator");
  assert.equal(editor.querySelectorAll("input, select").length, 0, "no free text, color picker or upload");
  assert.equal(editor.querySelector('[data-field="shape"]').getAttribute("aria-label"), "Classic shapes for Orchestrator", "named for the bot, not its thread id");
  assert.equal(editor.querySelector(".t3plus-bot-message").textContent, "Nightly run done.", "its latest message tells same-named bots apart");
  assert.deepEqual([...editor.querySelectorAll(".t3plus-bot-set-label")].map((l) => l.textContent), ["Classic", "Sports", "Space", "Fruit", "Blobs", "Color"], "shapes in their sets");
  const shapeButtons = editor.querySelectorAll('[data-field="shape"] button');
  const colorButtons = editor.querySelectorAll('[data-field="color"] button');
  assert.equal(shapeButtons.length, Object.keys(BOT_SHAPES).length, "every shape, once");
  assert.equal(colorButtons.length, PICKABLE_BOT_COLORS.length + 1, "the named colors plus Project (not Status colors' own)");
  assert.equal(editor.querySelector('[data-field="color"] button[data-value="project"]').getAttribute("aria-pressed"), "true", "a new bot follows its project");

  editor.querySelector('[data-field="shape"] button[data-value="diamond"]').click();
  await settle();
  editor.querySelector('[data-field="color"] button[data-value="purple"]').click();
  await settle();
  await settle();
  assert.deepEqual(storage.area.data.get(STORAGE_KEYS.bots)["env1:bot1"], { shape: "diamond", color: "purple" });
  assert.equal(editor.querySelector('button[data-value="diamond"]').getAttribute("aria-pressed"), "true");
  assert.equal(editor.querySelector('button[data-value="purple"]').getAttribute("aria-pressed"), "true");

  // The sidebar tab picks the change up live.
  sideApp.watcher.flush();
  const avatar = row.querySelector(".t3plus-bot-avatar");
  assert.equal(avatar.getAttribute("data-t3plus-shape"), "diamond");
  assert.equal(avatar.style.getPropertyValue("--t3plus-bot-edge"), BOT_COLORS.purple.stops[1]);

  // A ball shape brings its own colors: the Color picker hides, the saved color stays.
  const colorField = editor.querySelector('[data-field="color"]').parentElement;
  assert.equal(colorField.style.display, "");
  editor.querySelector('[data-field="shape"] button[data-value="football"]').click();
  await settle();
  await settle();
  assert.deepEqual(storage.area.data.get(STORAGE_KEYS.bots)["env1:bot1"], { shape: "football", color: "purple" });
  assert.equal(colorField.style.display, "none");
  sideApp.watcher.flush();
  assert.equal(avatar.style.getPropertyValue("--t3plus-bot-edge"), BOT_SKINS.football.stops[1]);

  // Leaving Settings with a search typed: the whole list again next time.
  const search = sdocSettings.querySelector(".t3plus-bots-search");
  search.value = "zzz";
  search.dispatchEvent(new settings.window.Event("input", { bubbles: true }));
  assert.equal(chip.hidden, true, "searched out");
  sdocSettings.getElementById(T3PLUS.panelId).parentElement.remove(); // T3 takes the page down
  settings.window.history.pushState({}, "", "/env1/a1");
  settingsApp.watcher.flush();
  assert.equal(search.value, "");
  assert.equal(chip.hidden, false);

  await settingsApp.actions.forgetBot("env1:bot1");
  assert.equal(storage.area.data.get(STORAGE_KEYS.bots)["env1:bot1"], undefined);
  for (const app of [sideApp, settingsApp]) app.stop();
});

test("Forget on a bot in the sidebar resets its look and keeps its name and place in Settings", async () => {
  const storage = createFakeChromeStorage();
  await storage.area.set({ [STORAGE_KEYS.bots]: { "env1:bot1": { shape: "diamond", color: "purple" } } });
  // Settings opened over a thread page: the sidebar is still there.
  const dom = createDom("/settings/appearance", sidebarHtml() + T3_APPEARANCE_HTML);
  const doc = dom.window.document;
  const { app } = createApp(dom, storage);
  await app.start();
  await settle();
  app.watcher.flush();
  const chip = () => doc.querySelector('.t3plus-bot-pick[data-bot-key="env1:bot1"]');
  assert.equal(chip().querySelector(".t3plus-bot-name").textContent, "Orchestrator");
  const before = [...doc.querySelectorAll(".t3plus-bot-pick")].map((c) => c.dataset.botKey);
  await app.actions.forgetBot("env1:bot1");
  // At once, not only after the next sidebar scan stores the title again.
  assert.equal(chip().textContent, "Orchestrator", "not renamed \"Bot\"");
  assert.deepEqual([...doc.querySelectorAll(".t3plus-bot-pick")].map((c) => c.dataset.botKey), before, "no jump");
  await settle();
  app.watcher.flush();
  assert.equal(chip().querySelector(".t3plus-bot-name").textContent, "Orchestrator");
  assert.equal(storage.area.data.get(STORAGE_KEYS.bots)?.["env1:bot1"], undefined, "its look was reset");
  app.stop();
});

test("bots feature off removes every bot decoration", async () => {
  const dom = createDom("/", sidebarHtml());
  const doc = dom.window.document;
  const { app } = createApp(dom);
  await app.start();
  app.watcher.flush();
  assert.ok(doc.querySelector(`[${T3PLUS.botAttr}]`));
  await app.actions.setSidebarFeature("bots", false);
  app.watcher.flush();
  // (In the page: t3+'s look stylesheet in <head> is no decoration.)
  assert.equal(doc.body.querySelectorAll(`[${T3PLUS.botAttr}], [${T3PLUS.ownedAttr}], [${T3PLUS.botTitleAttr}]`).length, 0);
  app.stop();
});

test("bot moods: closed eyes when idle, animated sprites when working or needing you", async () => {
  const { botArt, MOOD_BY_STATUS } = await import("../src/botArt.js");
  const idle = botArt("blue", "circle", MOOD_BY_STATUS.idle);
  const working = botArt("blue", "circle", MOOD_BY_STATUS.working);
  const attention = botArt("blue", "circle", MOOD_BY_STATUS.attention);
  assert.equal(idle.frames, 1);
  assert.equal(idle.duration, 0);
  assert.ok(working.frames >= 6 && working.duration > 0, "working animates");
  assert.ok(attention.frames >= 6 && attention.duration > 0, "needs-you animates");
  const svgWidth = (art) => Number(decodeURIComponent(art.url).match(/viewBox="0 0 (\d+) 24"/)[1]);
  assert.equal(svgWidth(working), 24 * working.frames, "one 24x24 frame per step, side by side");
  // Eyes differ per mood: idle is a single closed line, attention is taller than open.
  const rows = (cells) => new Set([...cells].map((c) => c.split(",")[1])).size;
  assert.equal(rows(eyeCells("circle", { eyes: "closed" })), 1);
  assert.ok(rows(eyeCells("circle", { eyes: "wide" })) > rows(eyeCells("circle", { eyes: "open" })));
  assert.notDeepEqual([...eyeCells("circle", { eyes: "x" })], [...eyeCells("circle", { eyes: "happy" })]);
  // Unknown status -> the neutral face; the row decoration marks animated avatars.
  const view = resolveBotPresentation({ key: "env1:bot1", titleLabel: "Ops", status: "working" }, { color: "red" });
  assert.equal(view.mood, "working");
  assert.ok(view.frames > 1, "a working bot's row animates");
  assert.equal(view.frames, botArt(view.paint, view.shape, "working").frames, "its face's own sprite sheet");
  assert.equal(resolveBotPresentation({ key: "k:1", titleLabel: "x" }, {}).mood, "awake");
});

test("decorated bot rows: animated avatar while working, static closed eyes when idle, two lines only", () => {
  // T3's card row: the body (relative z-10) holds the top, title and branch lines.
  const card = `<li data-thread-item="env1:bot1"><div role="button" data-sidebar-row="env1:bot1" aria-label="${BOT_TITLE}, Working, ops">
    <span class="sr-only">${BOT_TITLE}</span>
    <div class="relative z-10"><div class="flex"><span>ops</span><span class="group/sidebar-status-slot">4m</span></div>
      <div class="flex"><span aria-hidden="true">${BOT_TITLE}</span></div><div class="flex"><span>main</span></div></div></div></li>`;
  const dom = createDom("/", sidebarHtml().replace("</ul>", `${card}</ul>`).replace(/<li data-thread-item="env1:bot1"[\s\S]*?<\/li>/, ""));
  const doc = dom.window.document;
  const inner = findSidebarInner(doc);
  const scan = scanSidebar(inner);
  const bots = classifyBots(scan, DEFAULT_BOT_MARKER);
  const branchLine = doc.querySelector('[data-sidebar-row="env1:bot1"] .relative.z-10').children[2];
  branchLine.insertAdjacentHTML("afterend", '<div class="t3plus-bot-metaline" data-t3plus-owned>v0.5 line</div>');
  decorateBotRows(doc, scan, bots, {}, () => "Ran.");
  const row = doc.querySelector('[data-sidebar-row="env1:bot1"]');
  const avatar = row.querySelector(".t3plus-bot-avatar");
  assert.equal(avatar.getAttribute("data-t3plus-mood"), "working");
  assert.ok(avatar.hasAttribute("data-animated"));
  assert.ok(Number(avatar.style.getPropertyValue("--t3plus-bot-frames")) > 1);
  assert.equal(row.querySelector(".t3plus-bot-metaline"), null, "no model/computer line (and a v0.5 one is removed)");
  assert.ok(branchLine.hasAttribute("data-t3plus-bot-hide"), "T3's branch line is hidden");
  assert.equal(row.querySelector(`[${T3PLUS.botTitleAttr}]`).getAttribute(T3PLUS.botTitleAttr), "Ran.");

  decorateBotRows(doc, scan, [{ ...bots[0], status: "idle" }], {}, () => "Ran.");
  assert.equal(avatar.getAttribute("data-t3plus-mood"), "idle");
  assert.equal(avatar.hasAttribute("data-animated"), false);
  assert.equal(avatar.style.getPropertyValue("--t3plus-bot-frames"), "");
});

test("bot feed carries model and computer (in the bot's tooltip in Settings)", async () => {
  const { botMetaText } = await import("../src/botFeed.js");
  const feed = parseBotFeedText(JSON.stringify({ version: 1, bots: { b1: { text: "", model: "GPT-6.1 Sol", computer: "Studio" }, b2: { text: "hi" } } }));
  assert.equal(botMetaText(feed, "env:b1"), "GPT-6.1 Sol · Studio");
  assert.equal(botPreviewText(feed, "env:b1"), "No messages yet");
  assert.equal(botMetaText(feed, "env:b2"), "");
  assert.equal(botMetaText(null, "env:b1"), "");
});

test("background dither cells are the same CSS size on every screen", () => {
  assert.equal(ditherGrid(1000, 800, 2).cell, 2, "2x Retina (default Medium): 4 device px per cell");
  assert.equal(ditherGrid(1000, 800, 2, 4 / 3).cell, 1.5, "Fine on Retina: about one bot-avatar pixel");
  assert.equal(ditherGrid(1000, 800, 3, 3).cell, 3);
  for (const dpr of [1, 1.25, 1.5, 2, 3]) {
    const { cell } = ditherGrid(1000, 800, dpr);
    assert.ok(Math.abs(cell * dpr - Math.round(cell * dpr)) < 1e-9, `whole device pixels at ${dpr}x`);
    assert.ok(cell >= 1.5, `visible at ${dpr}x`);
  }
});

test("the three styles are all pixel variants: bayer, grain, spectrum", async () => {
  const { DITHER_STYLES: fromRenderer } = await import("../src/backdropRenderer.js");
  assert.deepEqual([...fromRenderer], ["bayer", "grain", "spectrum"]);
  const a = glowPixelArt({ width: 64, height: 32, cx: 0.5, rgb: [59, 130, 246], intensity: 0.6, style: "bayer" });
  const b = glowPixelArt({ width: 64, height: 32, cx: 0.5, rgb: [59, 130, 246], intensity: 0.6, style: "grain" });
  let diff = 0;
  for (let i = 3; i < a.length; i += 4) diff += a[i] !== b[i] ? 1 : 0;
  assert.ok(diff > 50, "grain scatters pixels differently from bayer");
});

test("T3's thread hover card shows the bot's face and clean name instead of the raw marker title", async () => {
  const dom = createDom("/", sidebarHtml());
  const doc = dom.window.document;
  const { app } = createApp(dom);
  try {
    await app.start();
    app.watcher.flush();
    // ThreadHoverCard.tsx inside T3's tooltip popup, portaled to <body>.
    doc.body.insertAdjacentHTML("beforeend", `<div data-slot="tooltip-positioner"><div data-slot="tooltip-popup"><div data-slot="tooltip-viewport">
      <div class="flex flex-col"><div class="min-w-0 truncate text-xs leading-tight font-medium text-foreground">${BOT_TITLE}</div><div class="grid">Save draft</div></div></div></div></div>`);
    await new Promise((r) => setTimeout(r, 0)); // the popup observer runs in a microtask, before paint
    const title = doc.querySelector('[data-slot="tooltip-popup"] .truncate');
    assert.ok(title.hasAttribute("data-t3plus-bot-hover"));
    assert.equal(title.getAttribute("data-t3plus-bot-hover-label"), "Orchestrator");
    assert.match(title.style.getPropertyValue("--t3plus-bot-fill"), /^url\("data:image\/svg\+xml,/);
    assert.equal(title.textContent, BOT_TITLE, "T3's text is untouched (hidden by CSS)");

    // T3 reuses the card for an ordinary thread: the decoration goes away.
    title.textContent = "Fix login redirect";
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(title.hasAttribute("data-t3plus-bot-hover"), false);
  } finally {
    app.stop();
  }
});

test("idle bots keep their eyes open", async () => {
  const { botArt } = await import("../src/botArt.js");
  assert.equal(botArt("blue", "circle", "idle").url === botArt("blue", "circle", "awake").url, false, "idle is dimmer than awake");
  const svg = decodeURIComponent(botArt("blue", "circle", "idle").url);
  const awake = decodeURIComponent(botArt("blue", "circle", "awake").url);
  const eyes = (s) => s.match(/fill="#ffffff" d="([^"]*)"/)[1];
  assert.equal(eyes(svg), eyes(awake), "same open eyes as the neutral face");
});

test("bot faces use a registered pixel encoder (PNG in the browser) and fall back to SVG", async () => {
  const { botArt, setBotArtEncoder } = await import("../src/botArt.js");
  const calls = [];
  setBotArtEncoder((pixels, width, height, fills) => {
    calls.push({ width, height, fills, max: Math.max(...pixels) });
    return "data:image/png;base64,AAAA";
  });
  try {
    const art = botArt("blue", "circle", "working");
    assert.equal(art.url, 'url("data:image/png;base64,AAAA")');
    assert.equal(calls[0].width, 24 * art.frames);
    assert.equal(calls[0].height, 24);
    assert.equal(calls[0].fills.length, 4);
    assert.ok(calls[0].max <= 3, "palette indices");
  } finally {
    setBotArtEncoder(null);
  }
  assert.match(botArt("blue", "circle", "working").url, /^url\("data:image\/svg\+xml,/);
});

test("classifyBots: a thread picked by hand is a bot under its whole title, with no marker", () => {
  const thread = (key, title) => ({ key, title, parent: null, ariaLabel: `${title}, Working, acme`, row: null });
  const scan = { threads: [thread("env1:a", "Nightly sync"), thread("env1:b", "Plain thread")] };
  assert.deepEqual(classifyBots(scan, DEFAULT_BOT_MARKER).map((b) => b.key), []);
  const bots = classifyBots(scan, DEFAULT_BOT_MARKER, { "env1:a": true });
  assert.deepEqual(bots.map((b) => [b.key, b.titleLabel, b.status]), [["env1:a", "Nightly sync", "working"]]);
});

test("a bot wears its project's color unless one was picked for it", async () => {
  const { botPaintColor, normalizeBotPrefs, PROJECT_COLOR, resolveBotPresentation } = await import("../src/bots.js");
  const { botStops } = await import("../src/botArt.js");
  const { svgTileColor, threadProjectColor } = await import("../src/projectColor.js");
  assert.equal(normalizeBotPrefs(null).color, PROJECT_COLOR, "nothing picked: follow the project");
  const bot = { key: "env1:a", titleLabel: "Sync", projectColor: "#ea580c" };
  assert.equal(botPaintColor(bot, null), "#ea580c");
  assert.equal(resolveBotPresentation(bot, null).edge, "#ea580c", "the face is drawn around the project color");
  assert.equal(botPaintColor(bot, { color: "teal" }), "teal", "an explicit pick wins");
  assert.ok(Object.hasOwn(BOT_COLORS, botPaintColor({ key: "env1:b" }, null)), "no project color: a stable named color");
  const [light, mid, dark] = botStops("#ea580c");
  assert.equal(mid, "#ea580c");
  assert.match(light, /^#[0-9a-f]{6}$/);
  assert.notEqual(light, dark);
  assert.equal(svgTileColor('<svg><rect width="64" height="64" rx="14" fill="#EA580C"/><text>F</text></svg>'), "#ea580c");
  assert.equal(svgTileColor("<svg><circle/></svg>"), null);
  // from a scan: the folder's badge in the grouped sidebar
  const dom = createDom("/", "<div></div>");
  const doc = dom.window.document;
  const folder = doc.createElement("button");
  folder.innerHTML = `<img src="data:image/svg+xml;base64,${Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><rect fill="#2563eb"/></svg>').toString("base64")}">`;
  const scan = { folders: new Map([["github.com/acme/api", { row: folder }]]) };
  assert.equal(threadProjectColor(scan, { folderKey: "github.com/acme/api", row: doc.createElement("div") }), "#2563eb");
  assert.equal(threadProjectColor(scan, { folderKey: "other", row: doc.createElement("div") }), null);
});

test("status badge: one glyph per state, a question differs from an approval, and only two states move", async () => {
  const { badgeFrames, badgePixels, botBadge, BADGE_W, BADGE_H } = await import("../src/botArt.js");
  const { classifyBots, parseRowStatusLabel, resolveBotPresentation } = await import("../src/bots.js");
  const glyphs = Object.fromEntries(["working", "waiting", "done", "failed", "idle"].map((s) => [s, badgeFrames(s).frames[0].glyph ?? "dots"]));
  assert.deepEqual(glyphs, { working: "dots", waiting: "pause", done: "check", failed: "cross", idle: "sleep" });
  assert.equal(badgeFrames("attention", "Input").frames[0].glyph, "question");
  assert.equal(badgeFrames("attention", "Request").frames[0].glyph, "question");
  assert.equal(badgeFrames("attention", "Approval").frames[0].glyph, "exclaim");
  assert.ok(badgeFrames("attention", "Input").frames.some((f) => f.hop), "needs-you hops");
  assert.deepEqual(["attention", "working", "waiting", "done", "failed", "idle"].filter((s) => botBadge(s).frames > 1), ["attention", "working"]);
  // the tile: clear corners, a rim, white glyph pixels, and the hop moves it up one row
  const rest = badgePixels({ glyph: "check" });
  assert.equal(rest.length, BADGE_W * BADGE_H);
  assert.equal(rest[1 * BADGE_W + 0], 0, "cut corner");
  assert.equal(rest[1 * BADGE_W + 4], 1, "rim");
  assert.ok(rest.includes(4), "glyph");
  assert.ok(rest.subarray(0, BADGE_W).every((v) => v === 0), "the spare row is clear at rest");
  assert.ok(badgePixels({ glyph: "check", hop: true }).subarray(0, BADGE_W).some((v) => v !== 0), "and used by the hop");
  assert.match(botBadge("done").url, /^url\("data:image\/svg\+xml,/);
  // from a row: T3's own word picks the glyph
  assert.equal(parseRowStatusLabel("Sync, Input, acme", "Sync"), "Input");
  assert.equal(parseRowStatusLabel("Sync, acme", "Sync"), "");
  const [bot] = classifyBots({ threads: [{ key: "env1:a", title: "Sync", parent: null, ariaLabel: "Sync, Input, acme" }] }, DEFAULT_BOT_MARKER, { "env1:a": true });
  assert.deepEqual([bot.status, bot.statusLabel], ["attention", "Input"]);
  assert.equal(resolveBotPresentation(bot, { badges: true }).badge.frames, 4);
  assert.equal(resolveBotPresentation(bot, null).badge, null, "Status badges off (the default): no badge");
  assert.equal(resolveBotPresentation({ key: "env1:a" }, { badges: true }).badge, null, "no status (a Settings swatch): no badge");
});

test("sprite clock: steps a face and its badge only when a frame is due, and sleeps when nothing moves", async () => {
  const { setSprite, spriteCount, stopSprites } = await import("../src/spriteClock.js");
  let now = 0;
  const timers = [];
  const el = (connected = true) => {
    const props = new Map();
    return { isConnected: connected, props, style: { setProperty: (k, v) => props.set(k, v), removeProperty: (k) => props.delete(k) }, ownerDocument: { defaultView: win } };
  };
  const win = { performance: { now: () => now }, setTimeout: (fn, ms) => timers.push({ fn, ms }) && timers.length, clearTimeout: () => {}, matchMedia: () => ({ matches: false }), document: { visibilityState: "visible" } };
  const run = () => timers.shift().fn();
  const face = el();
  setSprite(face, { frames: 8, duration: 1.6 }, { frames: 4, duration: 1.2 });
  assert.equal(spriteCount(), 1);
  run();
  assert.equal(face.props.get("--t3plus-bot-x"), "0.000%");
  assert.equal(face.props.get("--t3plus-badge-x"), "0.000%");
  assert.ok(timers[0].ms > 190 && timers[0].ms <= 201, `next wake at the first frame boundary, not every display frame (${timers[0].ms})`);
  now = 200;
  run();
  assert.equal(face.props.get("--t3plus-bot-x"), "14.286%", "face moved one frame");
  assert.equal(face.props.get("--t3plus-badge-x"), "0.000%", "badge (300 ms frames) not yet");
  now = 300;
  run();
  assert.equal(face.props.get("--t3plus-badge-x"), "33.333%");
  // a still sprite is not tracked; dropping the last one stops the clock
  const still = el();
  setSprite(still, { frames: 1, duration: 0 }, null);
  assert.equal(spriteCount(), 1);
  setSprite(face, null, null);
  assert.equal(spriteCount(), 0);
  assert.equal(face.props.has("--t3plus-bot-x"), false);
  while (timers.length) run(); // the pending wake finds nothing to step and does not reschedule
  const gone = el(false);
  setSprite(gone, { frames: 8, duration: 1.6 }, null);
  run();
  assert.equal(spriteCount(), 0, "an element T3 removed is forgotten");
  assert.equal(timers.length, 0, "and nothing is scheduled");
  stopSprites();
});

test("quick successive bot toggles all land (no lost update)", async () => {
  const storage = createFakeChromeStorage();
  const store = createBotStore(storage.area, storage.onChanged);
  const a = "env1:thread-a";
  const b = "env1:thread-b";
  await Promise.all([store.toggleManual(a), store.toggleManual(b)]);
  assert.deepEqual(Object.keys(await store.loadManual()).sort(), [a, b]);
  // a is a bot: off, then on again. Run together they used to both read "on" and both write "off".
  await Promise.all([store.toggleManual(a), store.toggleManual(a)]);
  assert.deepEqual(Object.keys(await store.loadManual()).sort(), [a, b], "off and back on, in order");
});

test("every thread is a bot by default; Option-click turns one off and on, and only the exception is stored", async () => {
  const scan = { threads: [{ key: "env1:a", title: "Fix login", parent: null, ariaLabel: "Fix login" }, { key: "env1:b", title: "Docs", parent: null, ariaLabel: "Docs" }] };
  assert.deepEqual(classifyBots(scan, DEFAULT_BOT_MARKER, {}, true).map((b) => b.key), ["env1:a", "env1:b"]);
  assert.deepEqual(classifyBots(scan, DEFAULT_BOT_MARKER, {}, false).map((b) => b.key), []);
  const storage = createFakeChromeStorage();
  const store = createBotStore(storage.area, storage.onChanged);
  let manual = await store.toggleManual("env1:a", undefined, true); // off
  assert.deepEqual(manual, { "env1:a": false });
  assert.deepEqual(classifyBots(scan, DEFAULT_BOT_MARKER, manual, true).map((b) => b.key), ["env1:b"]);
  manual = await store.toggleManual("env1:a", undefined, true); // on again: back to the default, nothing stored
  assert.deepEqual(manual, {});
});

test("bot styles: every style's shapes exist and draw, and unpicked bots take the current style", () => {
  try {
    for (const [name, style] of Object.entries(STYLES)) {
      for (const shape of style.shapes ?? []) {
        assert.ok(Object.hasOwn(BOT_SHAPES, shape), `${name}: ${shape}`);
        assert.match(botArt("blue", shape, "working").url, /^url\(/);
      }
      setBotStyle(name);
      const picked = defaultBotShape("env1:some-thread");
      if (style.shapes) assert.ok(style.shapes.includes(picked), `${name} picks from its set (${picked})`);
    }
  } finally {
    setBotStyle("classic"); // the style is the module's: the tests after this one draw Classic faces
  }
});

test("bots on screen get different shapes while the style has enough; each keeps its own as others come, go and come back", () => {
  // Two bots whose own (hashed) shape is the same: dealt together, the second gets another.
  const own = new Map();
  let pair = null;
  for (let i = 0; !pair; i += 1) {
    const key = `env1:deal-${i}`;
    const shape = defaultBotShape(key);
    if (own.has(shape)) pair = [own.get(shape), key].sort();
    else own.set(shape, key);
  }
  const [a, b] = pair;
  const others = ["env1:deal-x", "env1:deal-y", "env1:deal-z"];
  try {
    assignBotShapes([a, b, ...others]);
    const dealt = [a, b, ...others].map(defaultBotShape);
    assert.equal(new Set(dealt).size, dealt.length, `all different: ${dealt}`);
    assignBotShapes([a, b, ...others, "env1:deal-new"]);
    assert.deepEqual([a, b, ...others].map(defaultBotShape), dealt, "another bot came: no one else's face changed");
    assignBotShapes([a, ...others]); // b's row goes (its folder closed)...
    assignBotShapes(others); // ...and a's
    assignBotShapes([b, ...others]);
    assert.equal(defaultBotShape(b), dealt[1], "back, b has its shape again, not its own hashed one (free now)");
    // More bots than shapes (named to sort before b): faces repeat, b's among them.
    const crowd = Array.from({ length: 80 }, (_, i) => `env1:crowd-${i}`);
    assignBotShapes([b, ...others, ...crowd]);
    assert.deepEqual([b, ...others].map(defaultBotShape), dealt.slice(1), "in a crowd, those that had a shape keep it");
    assert.ok(crowd.some((key) => defaultBotShape(key) === dealt[1]), "b's face repeats in the crowd");
    assignBotShapes([b, ...others, ...crowd, "env1:deal-new"]);
    assert.equal(defaultBotShape(b), dealt[1], "and keeps it when the crowd is dealt again, shared or not");
    setBotStyle("fruit");
    assignBotShapes(others);
    assert.ok(others.every((key) => STYLES.fruit.shapes.includes(defaultBotShape(key))), "another style: dealt from its set");
    assert.equal(new Set(others.map(defaultBotShape)).size, others.length, "different again");
  } finally {
    setBotStyle("classic");
  }
});

test("project color: T3's monogram badge (an svg colored by a class, no filled rect) gives its computed color", async () => {
  const { threadProjectColor, cssColorToHex } = await import("../src/projectColor.js");
  const { JSDOM } = await import("jsdom");
  const dom = new JSDOM(`<div id="row"><span data-slot="project-monogram"><svg style="color: rgb(101, 163, 13)" viewBox="0 0 16 16"><text>AP</text></svg></span></div>`);
  const doc = dom.window.document;
  const scan = { folders: new Map([["k", { row: doc.getElementById("row") }]]) };
  assert.equal(threadProjectColor(scan, { folderKey: "k" }), "#65a30d");
  assert.equal(cssColorToHex(doc, "#ABC"), "#aabbcc");
  assert.equal(cssColorToHex(doc, "rgba(1, 2, 3, 0.5)"), "#010203");
});

test("remembered bots from another window or an import are normalized: a null entry cannot break Settings", async () => {
  assert.deepEqual(normalizeKnownBots({ "env:a": null, "env:b": { title: "B", seenAt: "5", projectColor: "red" }, "env:c": 3 }), { "env:b": { title: "B", seenAt: 5 } });
  assert.deepEqual(normalizeKnownBots([1, 2]), {});
  const storage = createFakeChromeStorage();
  const store = createBotStore(storage.area, storage.onChanged);
  const seen = [];
  store.subscribeKnown((v) => seen.push(v));
  await storage.area.set({ [STORAGE_KEYS.knownBots]: { "env:a": null, "env:b": { title: "B", seenAt: 1 } } });
  assert.deepEqual(seen.at(-1), { "env:b": { title: "B", seenAt: 1 } });
});

test("project color: a transparent computed color is no color (not black)", async () => {
  const { cssColorToHex } = await import("../src/projectColor.js");
  const { JSDOM } = await import("jsdom");
  const doc = new JSDOM("").window.document;
  assert.equal(cssColorToHex(doc, "rgba(0, 0, 0, 0)"), null);
  assert.equal(cssColorToHex(doc, "rgb(0 0 0 / 0%)"), null);
  assert.equal(cssColorToHex(doc, "rgb(10 20 30 / 50%)"), "#0a141e");
});

test("a title with no letters (T3 leaves dir off it) is still read, so such a thread can be a bot", () => {
  const row = (key, title, dir) => `<li data-thread-item="${key}"><div role="button" data-sidebar-row="${key}" aria-label="${title}, Done">
    <div class="contents"><span class="min-w-0 flex-1 truncate"${dir ? ` dir="${dir}"` : ""}>${title}</span><span class="relative ml-auto flex h-6">1h</span></div></div></li>`;
  const dom = createDom("/", `<div data-slot="sidebar-inner"><ul>${row("e:a", "Fix login", "ltr")}${row("e:b", "2025", null)}${row("e:c", "🚀🚀", null)}</ul></div>`);
  const scan = scanSidebar(findSidebarInner(dom.window.document));
  assert.deepEqual(scan.threads.map((t) => t.title), ["Fix login", "2025", "🚀🚀"]);
  assert.ok(scan.threads.every((t) => t.titleEl?.classList.contains("truncate")));
  assert.deepEqual(classifyBots(scan, DEFAULT_BOT_MARKER, { "e:b": true }, false).map((b) => b.key), ["e:b"]);
});

test("breadcrumb: T3's actions button and tooltip read the bot's name instead of its marked title, and get T3's text back after", async () => {
  const { decorateBotBreadcrumb, relabelBotTooltips } = await import("../src/bots.js");
  const { stopSprites } = await import("../src/spriteClock.js");
  const title = "[[t3plus:bot:v1]] Orchestrator";
  const dom = createDom("/", `<nav aria-label="Thread breadcrumb"><button type="button" aria-label="Thread actions for ${title}"><h2>${title}</h2></button></nav>
    <div data-slot="tooltip-popup"><span>${title}</span></div>`);
  const doc = dom.window.document;
  const button = doc.querySelector("button");
  const bot = { key: "env1:bot1", titleLabel: "Orchestrator", status: "idle", thread: { title } };
  decorateBotBreadcrumb(doc, { ...bot, prefs: {} });
  assert.equal(button.getAttribute("aria-label"), "Thread actions for Orchestrator");
  relabelBotTooltips(doc, new Map([[title, bot]]));
  assert.equal(doc.querySelector('[data-slot="tooltip-popup"] span').textContent, "Orchestrator");
  decorateBotBreadcrumb(doc, null);
  assert.equal(button.getAttribute("aria-label"), `Thread actions for ${title}`, "T3's label is back");
  assert.equal(button.hasAttribute("data-t3plus-raw-label"), false);
  stopSprites();
});

test("glow tones: a white, grey or black accent stays grey (not red); a light page runs pale at the edge to the accent at the core", () => {
  for (const neutral of [[255, 255, 255], [128, 128, 128], [0, 0, 0]]) {
    for (const style of ["bayer", "grain", "spectrum"]) {
      for (const [c] of glowTones(neutral, style).slice(1)) assert.ok(Math.max(...c) - Math.min(...c) <= 2, `${neutral} ${style}: ${c}`);
    }
  }
  const lum = ([r, g, b]) => 0.2126 * r + 0.7152 * g + 0.0722 * b;
  const blue = [59, 130, 246];
  const dark = glowTones(blue, "bayer").slice(1).map(([c]) => lum(c));
  assert.ok(dark[0] < dark[3], "dark page: deep edge, bright core");
  // A light page: one ink (the accent at a mid lightness), laid on at rising alpha, so each
  // level lands a little deeper and even the core stays light: colored light, not a blot.
  for (const style of ["bayer", "grain", "spectrum"]) {
    const tones = glowTones(blue, style, true).slice(1);
    for (let i = 1; i < tones.length; i += 1) assert.ok(tones[i][1] > tones[i - 1][1], `${style}: alpha rises toward the core`);
    const scale = 0.6 + 0.4 * 0.45; // the default intensity
    const landed = tones.map(([c, a]) => lum(c.map((v) => v * a * scale + 255 * (1 - a * scale))));
    assert.ok(landed[0] > 225, `${style}: the edge is a pale tint, near the page (${landed[0]})`);
    for (let i = 1; i < landed.length; i += 1) assert.ok(landed[i] < landed[i - 1], `${style}: each level a step deeper`);
    assert.ok(landed.at(-1) > 120, `${style}: the core stays light (${landed.at(-1)})`);
  }
  const [ink] = glowTones(blue, "bayer", true)[1];
  for (const [c] of glowTones(blue, "bayer", true).slice(2)) assert.deepEqual(c, ink, "one ink on a light page");
});

test("glow tones on a light page: the ink is the accent at OKLab lightness 0.60-0.68, in its hue, with a clear chroma (a grey stays grey)", async () => {
  const { rgbToOklch } = await import("../src/ditherMath.js");
  for (const accent of [[27, 78, 216], [219, 39, 119], [27, 125, 80], [38, 114, 175], [174, 85, 42], [114, 83, 185], [250, 240, 120], [20, 20, 30], [128, 128, 128]]) {
    const [, C, H] = rgbToOklch(accent);
    const [ink] = glowTones(accent, "bayer", true)[1];
    const [l, c, h] = rgbToOklch(ink);
    const warm = C >= 0.03 && H > 60 && H < 115; // a yellow or amber keeps more lightness (else mustard)
    assert.ok(l >= 0.595 && l <= (warm ? 0.805 : 0.685), `${accent}: L ${l.toFixed(3)}`);
    if (C < 0.03) assert.ok(c <= C + 0.005, `${accent}: a grey stays grey`);
    else {
      assert.ok(c <= Math.max(C, 0.15) + 0.005, `${accent}: chroma at most the floor or its own`);
      assert.ok(c >= Math.min(C, 0.1) - 0.005, `${accent}: never paler than its own (or a clear 0.1, where sRGB allows): ${c.toFixed(3)}`);
      if (c > 0.04) assert.ok(Math.abs(((h - H + 540) % 360) - 180) < 4, `${accent}: hue kept (${H.toFixed(1)} -> ${h.toFixed(1)})`);
    }
  }
  // A muted accent (Grove's green, Ocean's blue) is lifted to a clear chroma: no grey dust at the halo's edge.
  const [, groveC] = rgbToOklch([27, 125, 80]);
  const [, inkC] = rgbToOklch(glowTones([27, 125, 80], "bayer", true)[1][0]);
  assert.ok(inkC > groveC + 0.02, `lifted: ${groveC.toFixed(3)} -> ${inkC.toFixed(3)}`);
  // Spectrum never turns a green or yellow accent's edge into the olive band.
  for (const accent of [[27, 125, 80], [250, 240, 120], [174, 85, 42], [249, 115, 22]]) { // Grove, yellow, Ember, orange
    for (const [c] of glowTones(accent, "spectrum", true).slice(1)) {
      const [, cc, hh] = rgbToOklch(c);
      if (cc > 0.04) assert.ok(!(hh > 57 && hh < 113) || Math.abs(hh - rgbToOklch(accent)[2]) < 4, `${accent}: no khaki edge (${hh.toFixed(1)})`);
    }
  }
});

test("blobs: a flat fill in the bot's color and black capsule eyes, a frame per mood, nothing behind them", async () => {
  const { botArt } = await import("../src/botArt.js");
  const svgOf = (art) => decodeURIComponent(art.url.slice('url("data:image/svg+xml,'.length, -2));
  for (const shape of STYLES.blobs.shapes) {
    assert.equal(BOT_SHAPES[shape], "inset(0)", `${shape}: unclipped`);
    assert.equal(botEdgeColor("blue", shape), "transparent", `${shape}: no square behind it`);
    const svg = svgOf(botArt("purple", shape, "awake"));
    assert.ok(svg.includes(`fill="${BOT_COLORS.purple.stops[1]}"`), `${shape}: the color's middle stop`);
    assert.equal((svg.match(/<rect /g) ?? []).length, 1, `${shape}: one capsule eye, drawn once`);
    assert.equal((svg.match(/<use href="#e"/g) ?? []).length, 2 * botArt("purple", shape, "awake").frames, `${shape}: two eyes a frame`);
    assert.ok(!svg.includes("crispEdges"), "vector, not pixels");
    // Every mood is a loop at 12 frames a second (the eyes glance, blink, the body breathes).
    for (const [mood, seconds] of [["awake", 6], ["idle", 7.5], ["waiting", 6], ["done", 4.8], ["failed", 6], ["working", 2], ["attention", 1.5]]) {
      const art = botArt("purple", shape, mood);
      assert.equal(art.duration, seconds, `${shape}/${mood}`);
      assert.equal(art.frames, Math.round(seconds * 12), `${shape}/${mood}`);
    }
  }
  // Not every frame alike: the eyes move.
  const frameTransforms = svgOf(botArt("blue", "drop", "awake")).match(/<use href="#e" transform="[^"]+"/g);
  assert.ok(new Set(frameTransforms).size > 20, "the eyes move between frames");
  // Two blobs of one shape but different colors start their loops at different frames.
  const first = (c) => svgOf(botArt(c, "drop", "awake")).match(/<use href="#e" transform="[^"]+"/)[0];
  assert.ok(["pink", "green", "orange", "red"].some((c) => first(c) !== first("blue")), "not all in step");
  assert.notEqual(botArt("blue", "drop", "done").url, botArt("blue", "drop", "awake").url, "the mood shows");
  assert.notEqual(botArt("blue", "drop").url, botArt("pink", "drop").url, "the color shows");
});

test("subagents under a bot: its shape and color by default, still; Settings can give them their own", () => {
  const dom = createDom("/", sidebarHtml());
  const doc = dom.window.document;
  const scan = scanSidebar(findSidebarInner(doc));
  const bots = classifyBots(scan, DEFAULT_BOT_MARKER);
  const prefs = { "env1:bot1": { shape: "drop", color: "teal" } };
  const subs = [{ title: "Search", status: "running" }, { title: "Lint", status: "completed" }];
  const strip = () => doc.querySelector('[data-sidebar-row="env1:bot1"] .t3plus-bot-subs');
  const minis = () => [...strip().querySelectorAll(".t3plus-bot-sub")];

  decorateBotRows(doc, scan, bots, prefs, () => "", () => subs);
  const [working, done] = minis();
  assert.equal(working.style.getPropertyValue("--t3plus-bot-fill"), botStill("teal", "drop", "awake").url, "its bot's blob, in its bot's teal");
  assert.equal(working.style.getPropertyValue("--t3plus-bot-clip"), botClipPath("drop"));
  assert.equal(done.style.getPropertyValue("--t3plus-bot-fill"), botStill("teal", "drop", "done").url, "a finished one: happy eyes, same color");
  assert.ok(done.hasAttribute("data-done"), "and dimmed");
  for (const mini of minis()) {
    assert.equal(mini.style.getPropertyValue("--t3plus-bot-frames"), "", "one frame: no sprite sheet");
    assert.equal(mini.hasAttribute("data-animated"), false, "not stepped by the sprite clock");
  }
  assert.equal(strip().title, "1 of 2 subagents working\n• Search\n✓ Lint");

  // Settings: robots in purple for every bot's subagents.
  decorateBotRows(doc, scan, bots, prefs, () => "", () => subs, { shape: "robot", color: "purple" });
  assert.equal(minis()[0].style.getPropertyValue("--t3plus-bot-fill"), botStill("purple", "robot", "awake").url);
  assert.equal(minis()[0].style.getPropertyValue("--t3plus-bot-clip"), botClipPath("robot"));
  // Only the color set: the bot's shape, the color picked.
  decorateBotRows(doc, scan, bots, prefs, () => "", () => subs, { shape: "same", color: "red" });
  assert.equal(minis()[0].style.getPropertyValue("--t3plus-bot-fill"), botStill("red", "drop", "awake").url);
  // The bot changes: its subagents follow.
  decorateBotRows(doc, scan, bots, { "env1:bot1": { shape: "hexagon", color: "green" } }, () => "", () => subs);
  assert.equal(minis()[0].style.getPropertyValue("--t3plus-bot-fill"), botStill("green", "hexagon", "awake").url);
  // No subagents left: the strip goes.
  decorateBotRows(doc, scan, bots, prefs, () => "", () => []);
  assert.equal(strip(), null);

  // A face's look: the bot's unless set; an unknown value is the bot's too.
  const view = { shape: "pebble", paint: "#123456" };
  assert.deepEqual(subagentFace(view), { shape: "pebble", color: "#123456", clip: botClipPath("pebble") }, "a project color follows too");
  assert.deepEqual(subagentFace(view, { shape: "nope", color: "nope" }), subagentFace(view));

  // Balls, planets and fruit keep their own colors, under a ball or in a color picked: no ring, their own clip.
  const ball = { shape: "soccer", paint: "blue" };
  assert.deepEqual(subagentFace(ball), { shape: "soccer", color: BOT_SKINS.soccer.stops[1], clip: botClipPath("soccer") }, "under a ball: the same ball");
  assert.deepEqual(subagentFace(ball, { shape: "saturn", color: "red" }), { shape: "saturn", color: "red", clip: botClipPath("saturn") }, "a planet with sky in its own clip");
  decorateBotRows(doc, scan, bots, { "env1:bot1": { shape: "soccer", color: "teal" } }, () => "", () => subs, { shape: "same", color: "purple" });
  const mini = minis()[0];
  assert.equal(mini.style.getPropertyValue("--t3plus-bot-fill"), botStill("purple", "soccer", "awake").url, "the ball as it is");
  assert.equal(mini.hasAttribute("data-t3plus-ring"), false, "no ring in the color picked");
  assert.equal(mini.style.getPropertyValue("--t3plus-bot-edge"), "");
});

// The test above ends with a working face on its window, so the sprite clock waits on that
// window when it closes: closed under the clock, it wedged it for every test after.
test("the sprite clock still steps faces once a window with working faces on it has closed", async () => {
  const dom = createDom("/", "<span></span>");
  const clock = virtualClock(dom.window);
  const face = dom.window.document.querySelector("span");
  setSprite(face, { frames: 8, duration: 1.6 }, null); // a frame every 200 ms
  await clock.advance(16);
  assert.equal(face.style.getPropertyValue("--t3plus-bot-x"), "0.000%", "drawn");
  await clock.advance(200);
  assert.equal(face.style.getPropertyValue("--t3plus-bot-x"), "14.286%", "and stepped");
});

test("a still face is one frame, for every shape and mood; a blob at rest in its color", () => {
  for (const shape of Object.keys(BOT_SHAPES)) {
    for (const mood of ["awake", "done", "working", "idle"]) {
      const svg = decodeURIComponent(botStill("orange", shape, mood).url);
      assert.match(svg, /^url\("data:/);
      assert.match(svg, /viewBox="0 0 24 24"/, `${shape} ${mood}: one 24px frame, not a sprite sheet`);
    }
  }
  const blob = decodeURIComponent(botStill("orange", "drop").url);
  assert.ok(blob.includes(`fill="${BOT_COLORS.orange.stops[1]}"`), "the color's middle stop");
  assert.equal(botStill("orange", "drop"), botStill("orange", "drop"), "cached");
  // The mood shows (a finished subagent's happy eyes); a moving one stands still with open eyes.
  for (const shape of ["drop", "circle"]) assert.notEqual(botStill("orange", shape, "done").url, botStill("orange", shape, "awake").url, shape);
  assert.equal(botStill("orange", "circle", "done").url, botArt("orange", "circle", "done").url);
  assert.equal(botStill("orange", "circle", "working").url, botArt("orange", "circle", "awake").url);
});
