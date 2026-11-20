import { botClipPath, botEdgeColor, botFillUrl, botShapeHasOwnColors } from "./botArt.js";
import { WHATS_NEW, renderNotes } from "./whatsNew.js";
import { PROFILE_COLORS, profileHex } from "./profiles.js";
import { PROFILE_ICONS, profileIconSvg } from "./profileIcons.js";
import { applyAvatarVars, botPaintColor, PROJECT_COLOR, resolveBotPresentation } from "./bots.js";
import { APPEARANCE_ROUTE, BOT_COLORS, BOT_SHAPES, BOT_STYLES, DEFAULT_BOT_MARKER, IMAGE_LIMITS, T3_SELECTORS, T3PLUS } from "./config.js";
import { createBuilder, setText, uniqueId as id } from "./dom.js";

/**
 * Finds where the t3+ section goes on Settings -> Appearance: the container of
 * T3's appearance sections. Returns null on any other page, or when the hooks
 * are missing, so t3+ never inserts itself somewhere unexpected.
 */
export function findAppearanceContainer(doc, pathname) {
  if (!APPEARANCE_ROUTE.test(pathname)) return null;
  let last = null;
  for (const selector of T3_SELECTORS.appearanceSections) {
    const found = doc.querySelector(selector);
    if (found) last = found;
  }
  return last?.parentElement ?? null;
}

/** Inserts or moves the panel to the end of the container. Returns true when the DOM changed. */
export function ensurePanelMounted(container, panel) {
  if (panel.parentElement === container && container.lastElementChild === panel) return false;
  container.appendChild(panel);
  return true;
}

/**
 * Builds the t3+ Appearance section once; `update(state)` syncs values in place
 * so focus and an in-progress slider drag survive re-renders.
 *
 * state: {
 *   settings, image, imageUrl, message,
 *   bots: [{ key, title, titleLabel, prefs: { shape, color }, view, preview }], botMessage,
 * }
 */
export function createAppearancePanel(doc, actions, { desktop = false, version = null, whatsNew = false } = {}) {
  // The desktop build keeps everything in T3's own storage on this computer, not a browser's.
  const where = desktop ? "on this computer" : "in this browser";
  const h = createBuilder(doc);
  const row = ({ title, description, control, extra }) => {
    const titleId = id("row-title");
    return h("div", { class: "t3plus-row", role: "group", "aria-labelledby": titleId }, [
      h("div", { class: "t3plus-row-main" }, [
        h("div", { class: "t3plus-row-text" }, [
          h("h3", { class: "t3plus-row-title", id: titleId, text: title }),
          description ? h("p", { class: "t3plus-row-desc", text: description }) : null,
        ]),
        control ? h("div", { class: "t3plus-row-control" }, control) : null,
      ]),
      extra ?? null,
    ]);
  };
  const switchButton = (label, onToggle) => {
    const el = h("button", { type: "button", role: "switch", class: "t3plus-switch", "aria-label": label }, [
      h("span", { class: "t3plus-switch-thumb", "aria-hidden": "true" }),
    ]);
    el.addEventListener("click", () => onToggle(el.getAttribute("aria-checked") !== "true"));
    return el;
  };
  const button = (text, onClick, extraClass = "") => {
    const el = h("button", { type: "button", class: `t3plus-button ${extraClass}`.trim(), text });
    el.addEventListener("click", onClick);
    return el;
  };
  const slider = (label, onPreview, onCommit, { min = 0, max = 100, step = 5, format = (v) => `${v}%` } = {}) => {
    const inputId = id("slider");
    const output = h("output", { class: "t3plus-output", for: inputId });
    const input = h("input", { type: "range", min: String(min), max: String(max), step: String(step), id: inputId, class: "t3plus-slider", "aria-label": label });
    const paint = () => {
      output.textContent = format(Number(input.value));
      input.style.setProperty("--t3plus-slider-progress", `${((Number(input.value) - min) / (max - min)) * 100}%`);
    };
    input.addEventListener("input", () => {
      paint();
      onPreview(Number(input.value));
    });
    input.addEventListener("change", () => onCommit(Number(input.value)));
    return {
      input,
      output,
      set(value) {
        if (doc.activeElement !== input) input.value = String(value);
        paint();
      },
    };
  };

  // ---------- Background + glass ----------
  const backgroundToggle = switchButton("Background", (on) => actions.setEnabled(on));

  const modeName = id("mode");
  const modeInputs = {};
  const modeGroup = h("div", { class: "t3plus-segmented", role: "radiogroup", "aria-label": "Background style" },
    [["half-circle", "Glow"], ["image", "Image"]].map(([value, label]) => {
      const input = h("input", { type: "radio", name: modeName, value, class: "t3plus-sr-only" });
      input.addEventListener("change", () => input.checked && actions.setMode(value));
      modeInputs[value] = input;
      return h("label", { class: "t3plus-segment" }, [input, h("span", { text: label })]);
    }),
  );

  const fileInput = h("input", { type: "file", accept: IMAGE_LIMITS.acceptedTypes.join(","), class: "t3plus-sr-only", tabindex: "-1", "aria-hidden": "true" });
  fileInput.addEventListener("change", () => {
    const file = fileInput.files?.[0];
    fileInput.value = "";
    if (file) actions.chooseImage(file);
  });
  const thumb = h("span", { class: "t3plus-thumb", "aria-hidden": "true" });
  const uploadButton = button("Upload…", () => fileInput.click());
  const sampleButton = button("Sample", () => actions.useSample());
  const removeButton = button("Remove upload", () => actions.removeImage(), "t3plus-button-ghost");
  const imageCaption = h("p", { class: "t3plus-row-desc" });
  const imageRow = row({
    title: "Image",
    description: `Stored only ${where}. Large images are resized and saved as WebP.`,
    control: [thumb, uploadButton, sampleButton, removeButton, fileInput],
    extra: imageCaption,
  });

  const colorInput = h("input", { type: "color", class: "t3plus-color", "aria-label": "Accent color" });
  colorInput.addEventListener("input", () => actions.previewAccent(colorInput.value));
  colorInput.addEventListener("change", () => actions.setAccent(colorInput.value));
  const themeButton = button("Theme", () => actions.setAccent("theme"));
  const ACCENT_TEXT = "Color of the glow. Theme follows your T3 theme's primary color.";
  const accentRow = row({ title: "Accent", description: ACCENT_TEXT, control: [colorInput, themeButton] });
  const accentDesc = accentRow.querySelector(".t3plus-row-desc");

  const ditherSizeName = id("dither-size");
  const ditherSizeInputs = {};
  const ditherSizeGroup = h("div", { class: "t3plus-segmented", role: "radiogroup", "aria-label": "Dither pixel size" },
    [["fine", "Fine"], ["medium", "Medium"], ["large", "Large"]].map(([value, label]) => {
      const input = h("input", { type: "radio", name: ditherSizeName, value, class: "t3plus-sr-only" });
      input.addEventListener("change", () => input.checked && actions.setDitherSize(value));
      ditherSizeInputs[value] = input;
      return h("label", { class: "t3plus-segment" }, [input, h("span", { text: label })]);
    }),
  );
  const lookName = id("look");
  const lookInputs = {};
  const lookGroup = h("div", { class: "t3plus-segmented", role: "radiogroup", "aria-label": "Look" },
    [["bayer", "Bayer"], ["grain", "Grain"], ["spectrum", "Spectrum"], ["smooth", "Smooth"]].map(([value, label]) => {
      const input = h("input", { type: "radio", name: lookName, value, class: "t3plus-sr-only" });
      input.addEventListener("change", () => input.checked && actions.setLook(value));
      lookInputs[value] = input;
      return h("label", { class: "t3plus-segment" }, [input, h("span", { text: label })]);
    }),
  );
  const lookRow = row({
    title: "Look",
    description: "Pixel art like the bot avatars: Bayer crosshatch, scattered Grain, or hue-drifting Spectrum. Smooth is a plain gradient.",
    control: lookGroup,
  });
  const ditherSizeRow = row({ title: "Pixel size", description: "Size of each dither dot, the same on every screen.", control: ditherSizeGroup });
  const intensity = slider("Intensity", (v) => actions.previewIntensity(v), (v) => actions.setIntensity(v));

  const glassToggle = switchButton("Glass composer", (on) => actions.setGlass(on));
  const glassStrength = slider("Glass strength", (v) => actions.previewGlassStrength(v), (v) => actions.setGlassStrength(v));
  const glassStrengthRow = row({ title: "Glass composer", description: "How much of the background shows through the composer card.", control: [glassStrength.output, glassStrength.input] });

  const resetButton = button("Reset", () => actions.reset(), "t3plus-button-ghost");
  const exportButton = button("Export…", () => actions.exportSettings());
  const importFile = h("input", { type: "file", accept: "application/json,.json", class: "t3plus-sr-only", tabindex: "-1", "aria-hidden": "true" });
  importFile.addEventListener("change", () => {
    const file = importFile.files?.[0];
    importFile.value = "";
    if (file) actions.importSettings(file);
  });
  const importButton = button("Import…", () => importFile.click());

  // Live preview: a miniature T3 window. The sidebar shows your bots with
  // their real faces (the first one working and animated, the second idle and
  // receded, as T3 grays seen threads), and the conversation pane gets the
  // real dithered background (backdropRenderer renders into it on this page)
  // under a glass composer, at the real pixel size.
  const previewRow = (fav, favColor, project, title, time) =>
    h("div", { class: "t3plus-preview-row" }, [
      h("div", { class: "t3plus-preview-row-top" }, [
        h("span", { class: "t3plus-preview-fav", style: `--fav:${favColor}`, text: fav }),
        h("span", { class: "t3plus-preview-project", text: project }),
        h("span", { class: "t3plus-preview-time", text: time }),
      ]),
      h("div", { class: "t3plus-preview-row-title", text: title }),
    ]);
  const previewBots = h("div", { class: "t3plus-preview-bots" });
  const preview = h("div", { class: "t3plus-preview", "aria-hidden": "true" }, [
    h("div", { class: "t3plus-preview-sidebar" }, [
      h("div", { class: "t3plus-preview-search", text: "Search" }),
      previewBots,
      previewRow("AA", "#0e9f6e", "acme-api", "Fix login redirect", "5h"),
      previewRow("N", "#16a34a", "notes", "Weekly notes and reading list", "58m"),
    ]),
    h("div", { class: "t3plus-preview-pane" }, [
      h("div", { class: "t3plus-preview-header" }, [
        h("span", { class: "t3plus-preview-crumb", text: "acme-api" }),
        h("span", { class: "t3plus-preview-sep", text: "/" }),
        h("span", { text: "Fix login redirect" }),
      ]),
      h("div", { class: "t3plus-preview-thread" }, [
        h("div", { class: "t3plus-preview-user", text: "Can you make the login redirect keep the original page?" }),
        h("p", { class: "t3plus-preview-assistant", text: "Done. The original path now rides along in the state parameter and is restored after sign-in. All 48 auth tests pass." }),
      ]),
      h("div", { class: "t3plus-preview-card" }, [
        h("span", { class: "t3plus-preview-placeholder", text: "Ask anything..." }),
        h("span", { class: "t3plus-preview-toolbar" }, [
          h("span", { class: "t3plus-preview-chip" }),
          h("span", { class: "t3plus-preview-model", text: "Opus 5.5" }),
          h("span", { class: "t3plus-preview-send" }),
        ]),
      ]),
    ]),
  ]);

  const SAMPLE_PREVIEW_BOTS = [
    { key: "sample:orchestrator", titleLabel: "Orchestrator", preview: "Spawned 3 sub-threads for tonight's sync.", prefs: { shape: "circle", color: "blue" } },
    { key: "sample:inbox", titleLabel: "Inbox triage", preview: "Archived 14 threads older than a week.", prefs: { shape: "hexagon", color: "purple" } },
  ];
  let previewBotsSignature = "";
  function updatePreviewBots(bots) {
    const list = (bots.length ? bots : SAMPLE_PREVIEW_BOTS).slice(0, 2);
    // The bot style and the project color change a face too: switching to Sports
    // left the preview on the old shapes, and preview bots ignored their project.
    const signature = JSON.stringify(list.map((b) => [b.key, b.titleLabel, b.preview, b.prefs, b.projectColor ?? null, b.view?.shape ?? null]));
    if (signature === previewBotsSignature) return;
    previewBotsSignature = signature;
    previewBots.replaceChildren(
      ...list.map((bot, index) => {
        // First bot: open and working (animated, full-strength name). Second: idle and receded.
        const status = index === 0 ? "working" : "idle";
        const view = resolveBotPresentation({ key: bot.key, titleLabel: bot.titleLabel, status, projectColor: bot.projectColor ?? null }, bot.prefs);
        const avatar = h("span", { class: "t3plus-bot-avatar t3plus-preview-avatar", "data-status": status });
        applyAvatarVars(avatar, view);
        return h("div", { class: `t3plus-preview-bot${index === 0 ? " is-active" : ""}` }, [
          avatar,
          h("div", { class: "t3plus-preview-bot-text" }, [
            h("div", { class: "t3plus-preview-bot-top" }, [
              h("span", { class: "t3plus-preview-bot-name", text: view.label }),
              h("span", { class: "t3plus-preview-time", text: index === 0 ? "Working" : "2h" }),
            ]),
            h("div", { class: "t3plus-preview-bot-message", text: bot.preview || "No messages yet" }),
          ]),
        ]);
      }),
    );
  }

  const status = h("p", { class: "t3plus-status", role: "status", "aria-live": "polite" });

  const lookCard = h("div", { class: "t3plus-card" }, [
    row({
      title: "Background",
      description: "A pixel-art glow (or your own image) behind the conversation and composer.",
      control: backgroundToggle,
      extra: preview,
    }),
    row({ title: "Style", description: "A glow rising behind the composer, or an image.", control: modeGroup }),
    imageRow,
    lookRow,
    row({ title: "Intensity", description: "How strongly the background shows.", control: [intensity.output, intensity.input] }),
    glassStrengthRow,
    status,
  ]);

  // ---------- Features ----------
  const botsToggle = switchButton("Bot rows", (on) => actions.setSidebarFeature("bots", on));
  const botsDefaultToggle = switchButton("Every thread is a bot", (on) => actions.setSidebarFeature("botsDefault", on));
  const profilesToggle = switchButton("Profiles", (on) => actions.setSidebarFeature("profiles", on));
  const botStyleName = id("bot-style");
  const botStyleInputs = {};
  const botStyleGroup = h("div", { class: "t3plus-segmented", role: "radiogroup", "aria-label": "Bot style" },
    Object.entries(BOT_STYLES).map(([value, style]) => {
      const input = h("input", { type: "radio", name: botStyleName, value, class: "t3plus-sr-only" });
      input.addEventListener("change", () => input.checked && actions.setSidebarFeature("botStyle", value));
      botStyleInputs[value] = input;
      return h("label", { class: "t3plus-segment" }, [input, h("span", { text: style.label })]);
    }),
  );
  const homeToggle = switchButton("Usage widgets", (on) => actions.setHomeWidgets(on));
  const demoToggle = switchButton("Screenshot mode", (on) => actions.setDemo(on));
  // What t3+ could not find in this T3 version (src/health.js).
  const healthText = h("p", { class: "t3plus-row-desc t3plus-health", role: "status", "aria-live": "polite" });
  const featuresCard = h("div", { class: "t3plus-card" }, [
    row({ title: "Status", extra: healthText }),
    row({ title: "Bot rows", description: "Bots get a face, their name, their latest message, and mini robots while they run subagents.", control: botsToggle }),
    row({ title: "Every thread is a bot", description: `On: every thread is a bot. Off: only threads whose title starts with ${DEFAULT_BOT_MARKER}.`, control: botsDefaultToggle }),
    row({ title: "Profiles", description: "Dots at the bottom of the sidebar, like Dia's profiles: each shows its own projects. Swipe sideways with two fingers on the sidebar, click a dot, or press Ctrl+Shift+1–9 to switch; drag a project folder onto a profile to move it; right-click a dot to rename or delete it.", control: profilesToggle }),
    row({ title: "Bot style", description: "What bots look like when you have not picked a shape for one: Classic shapes in the project's color, or Sports balls, Space planets, or Fruit.", control: botStyleGroup }),
    row({
      title: "Screenshot mode",
      description:
        "Swap thread titles, projects, branches, machine names and message text for believable stand-ins: in the sidebar, the header, the chat, the composer, hover cards, menus and ⌘K. Terminals, diffs, file views and Settings pages still show real content, so keep them out of the shot. Widgets stay real. Nothing in T3 changes.",
      control: demoToggle,
    }),
    row({ title: "Usage widgets", description: "Pools, activity and usage under the new-thread composer, and the current provider's pool in thread details (Usage limits).", control: homeToggle }),
  ]);

  // What changed in the installed version (the notes of the latest one, in a build
  // newer than any), and every version in the What's New sheet.
  const notesEntry = WHATS_NEW.find((e) => e.version === version) ?? WHATS_NEW[0];
  const whatsNewCard = whatsNew && notesEntry
    ? h("div", { class: "t3plus-card" }, [
      row({
        title: notesEntry.version === "Unreleased" ? "What's new in the next update" : `What's new in ${notesEntry.version}`,
        control: button("All versions", () => actions.openWhatsNew?.()),
        extra: renderNotes(doc, { version, entries: [notesEntry], titles: false }),
      }),
    ])
    : null;

  const advanced = h("details", { class: "t3plus-advanced" }, [
    h("summary", { class: "t3plus-advanced-summary", text: "Advanced" }),
    h("div", { class: "t3plus-card" }, [
      accentRow,
      ditherSizeRow,
      row({ title: "Glass", description: "Turn the translucent composer card off. Falls back to a solid card when the browser cannot blur.", control: glassToggle }),
      row({ title: "Backup", description: "Save your t3+ settings, profiles, bots and uploaded image to a file, to keep a copy or move them to another computer.", control: [exportButton, importButton, importFile] }),
      row({ title: "Reset", description: "Restore appearance defaults. A stored upload is kept until you remove it.", control: resetButton }),
    ]),
  ]);

  // ---------- Bots ----------
  // A chip per bot (its face and name), A to Z; clicking one opens its shape and
  // color picker under the chips, one bot at a time.
  const botsList = h("div", { class: "t3plus-bots" });
  const botSlot = h("div", { class: "t3plus-bot-slot", id: id("bot-editor") });
  const botsEmpty = h("p", { class: "t3plus-row-desc t3plus-bots-empty" });
  const botStatus = h("p", { class: "t3plus-status", role: "status", "aria-live": "polite" });
  const botsCard = h("div", { class: "t3plus-card" }, [
    row({ title: "Bots", description: "Click one to change its shape or color.", extra: h("div", { class: "t3plus-bots-body" }, [botsEmpty, botsList, botSlot, botStatus]) }),
  ]);

  const botEntries = new Map(); // key -> { chip, avatar, name, editor, bot }
  let botOrder = []; // keys, as the chips are laid out
  let openBot = null;

  function createBotEditor(bot) {
    const forget = button("Forget", () => actions.forgetBot(bot.key), "t3plus-button-ghost");

    const swatchGroup = (label, entries, field, paint) => {
      const buttons = new Map();
      const group = h("div", { class: "t3plus-swatches", role: "group", "aria-label": label, "data-field": field },
        entries.map(([value, text]) => {
          const mark = h("span", { class: "t3plus-swatch-mark", "aria-hidden": "true" });
          paint(mark, value);
          const el = h("button", { type: "button", class: "t3plus-swatch", title: text, "aria-label": text, "data-value": value }, [mark]);
          el.addEventListener("click", () => actions.updateBot(bot.key, { [field]: value }));
          buttons.set(value, el);
          return el;
        }));
      return {
        group,
        name(botName) {
          group.setAttribute("aria-label", `${label} for ${botName}`);
        },
        set(value) {
          for (const [v, el] of buttons) el.setAttribute("aria-pressed", String(v === value));
        },
      };
    };
    const cap = (w) => w[0].toUpperCase() + w.slice(1);
    const shapes = swatchGroup("Shape", Object.keys(BOT_SHAPES).map((k) => [k, cap(k)]), "shape", (mark, shape) => {
      mark.style.setProperty("--t3plus-bot-clip", botClipPath(shape));
    });
    // "Project" first: the bot follows its project's badge color.
    const colors = swatchGroup("Color", [[PROJECT_COLOR, "Project color"], ...Object.entries(BOT_COLORS).map(([k, v]) => [k, v.label])], "color", (mark, color) => {
      mark.style.setProperty("--t3plus-bot-edge", botEdgeColor(color));
    });
    const colorField = h("div", { class: "t3plus-field" }, [h("span", { text: "Color" }), colors.group]);
    // Its latest message: tells two bots with the same name apart.
    const message = h("p", { class: "t3plus-bot-message" });

    const element = h("div", { class: "t3plus-bot-editor", "data-bot-key": bot.key }, [
      message,
      h("div", { class: "t3plus-field" }, [h("span", { text: "Shape" }), shapes.group]),
      h("div", { class: "t3plus-bot-editor-foot" }, [colorField, forget]),
    ]);
    element.addEventListener("keydown", (event) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      setOpenBot(null, { focus: true });
    });
    return {
      element,
      update(next) {
        const current = next.prefs;
        setText(message, next.preview);
        message.hidden = !next.preview;
        shapes.name(next.view.label);
        colors.name(next.view.label);
        const shape = next.view.shape; // the bot's own pick, or the one it was given
        shapes.set(shape);
        colors.set(current.color);
        // Ball shapes (football, basketball) bring their own colors: no color to pick.
        colorField.style.display = botShapeHasOwnColors(shape) ? "none" : "";
        // Each swatch is the bot's face as it would look: shape buttons in the
        // bot's color, color buttons in the bot's shape (eyes follow the shape).
        const paint = next.view.paint;
        for (const button of shapes.group.querySelectorAll(".t3plus-swatch")) {
          const mark = button.firstElementChild;
          mark.style.setProperty("--t3plus-bot-fill", botFillUrl(paint, button.dataset.value));
          mark.style.setProperty("--t3plus-bot-edge", botEdgeColor(paint, button.dataset.value));
        }
        for (const button of colors.group.querySelectorAll(".t3plus-swatch")) {
          const mark = button.firstElementChild;
          // The "Project" swatch shows what the project gives this bot.
          const shown = button.dataset.value === PROJECT_COLOR ? botPaintColor(next, { color: PROJECT_COLOR }) : button.dataset.value;
          mark.style.setProperty("--t3plus-bot-fill", botFillUrl(shown, shape));
          mark.style.setProperty("--t3plus-bot-edge", botEdgeColor(shown, shape));
          mark.style.setProperty("--t3plus-bot-clip", next.view.clip);
        }
      },
    };
  }

  function createBotEntry(bot) {
    const avatar = h("span", { class: "t3plus-bot-swatch", "aria-hidden": "true" });
    const name = h("span", { class: "t3plus-bot-name" });
    const chip = h("button", { type: "button", class: "t3plus-bot-pick", "data-bot-key": bot.key, "aria-expanded": "false", "aria-controls": botSlot.id }, [avatar, name]);
    const entry = { chip, avatar, name, editor: null, bot };
    // Opening moves focus into the picker (from the keyboard it would otherwise
    // be every chip after this one away); Escape brings it back.
    chip.addEventListener("click", () => setOpenBot(openBot === bot.key ? null : bot.key, { focus: true }));
    return entry;
  }

  const focusQuietly = (el) => el?.focus({ preventScroll: true });

  function setOpenBot(key, { focus = false } = {}) {
    const entry = key ? botEntries.get(key) : null;
    const closing = openBot ? botEntries.get(openBot) : null;
    openBot = entry ? key : null;
    for (const [k, e] of botEntries) e.chip.setAttribute("aria-expanded", String(k === openBot));
    if (!entry) {
      botSlot.replaceChildren();
      if (focus) focusQuietly(closing?.chip);
      return;
    }
    entry.editor ??= createBotEditor(entry.bot);
    entry.editor.update(entry.bot);
    botSlot.replaceChildren(entry.editor.element);
    entry.editor.element.scrollIntoView?.({ block: "nearest" });
    if (focus) focusQuietly(entry.editor.element.querySelector('.t3plus-swatch[aria-pressed="true"]') ?? entry.editor.element.querySelector(".t3plus-swatch"));
  }

  function updateBots(list) {
    const bots = [...list].sort((a, b) => a.view.label.localeCompare(b.view.label, undefined, { sensitivity: "base" }) || a.key.localeCompare(b.key));
    const order = bots.map((b) => b.key);
    if (order.join("\n") !== botOrder.join("\n")) {
      // Moving a chip (a rename re-sorts them) would drop its focus: put it back.
      const focused = botsList.contains(doc.activeElement) ? doc.activeElement : null;
      const openIndex = botOrder.indexOf(openBot);
      botOrder = order;
      for (const key of [...botEntries.keys()]) if (!order.includes(key)) botEntries.delete(key);
      botsList.replaceChildren(
        ...bots.map((bot) => {
          if (!botEntries.has(bot.key)) botEntries.set(bot.key, createBotEntry(bot));
          return botEntries.get(bot.key).chip;
        }),
      );
      if (focused?.isConnected && doc.activeElement !== focused) focusQuietly(focused);
      if (openBot && !botEntries.has(openBot)) {
        // Forgotten (or gone) while open: focus goes to the chip now in its place.
        const hadFocus = botSlot.contains(doc.activeElement);
        setOpenBot(null);
        if (hadFocus) focusQuietly(botEntries.get(order[Math.min(openIndex, order.length - 1)])?.chip);
      }
    }
    for (const bot of bots) {
      const entry = botEntries.get(bot.key);
      entry.bot = bot;
      setText(entry.name, bot.view.label);
      // Hover: the name in full, its latest message, and its model and computer.
      const tip = [bot.view.label, bot.preview, bot.meta].filter(Boolean).join("\n");
      if (entry.chip.title !== tip) entry.chip.title = tip;
      applyAvatarVars(entry.avatar, bot.view);
      if (bot.key === openBot) entry.editor?.update(bot);
    }
  }

  // ---------- Profiles: an icon and three colors each ----------
  // Pick a profile, then its icon and the colors of its dot, the sidebar's sky and the
  // dither glow: one of the nine (as in the sidebar), or a color of your own. The
  // preview shows them together, as you pick (a custom color while you drag it).
  const PROFILE_FIELDS = [
    ["color", "Dot", "The dot and the name beside it."],
    ["sky", "Sky", "The night sky at the top of the sidebar."],
    ["dither", "Dither", "The dithered glow behind the chat."],
  ];
  let profiles = null; // { list, active, sky }
  let editing = null; // the profile shown
  let draft = {}; // { field: "#rrggbb" } while a custom color is dragged
  let profilesSignature = "";
  let demoNames = false;
  let globalAccent = "theme";
  let glowOn = true; // the background is the glow (not off, not an image): a dither color shows
  const ppChips = h("div", { class: "t3plus-pp-chips", role: "radiogroup", "aria-label": "Profile" });
  const ppSky = h("div", { class: "t3plus-pp-sky" });
  const ppName = h("span", { class: "t3plus-profiles-name t3plus-pp-name" });
  const ppDots = h("span", { class: "t3plus-pp-dots" });
  const ppPane = h("div", { class: "t3plus-pp-pane" }, [h("div", { class: "t3plus-pp-card" })]);
  const ppPreview = h("div", { class: "t3plus-pp", "aria-hidden": "true" }, [
    h("div", { class: "t3plus-pp-side" }, [
      ppSky,
      h("div", { class: "t3plus-pp-rows" }, [h("span"), h("span"), h("span")]),
      h("div", { class: "t3plus-pp-foot" }, [ppName, ppDots]),
    ]),
    ppPane,
  ]);
  // Arrow keys move and pick within a row of choices; one Tab stop each.
  const rovingRow = (group) =>
    group.addEventListener("keydown", (e) => {
      const step = { ArrowLeft: -1, ArrowUp: -1, ArrowRight: 1, ArrowDown: 1 }[e.key];
      if (!step) return;
      e.preventDefault();
      const all = [...group.querySelectorAll("[role=radio]")];
      const next = all[(all.indexOf(doc.activeElement) + step + all.length) % all.length];
      next.focus();
      next.click();
    });
  const checkIn = (group, isOn) => {
    const all = [...group.querySelectorAll("[role=radio]")];
    const picked = all.map(isOn);
    for (const [i, el] of all.entries()) {
      if (el.getAttribute("aria-checked") !== String(picked[i])) el.setAttribute("aria-checked", String(picked[i]));
      // One Tab stop: the picked one, or the first when none is (a custom color in use).
      el.tabIndex = picked[i] || (i === 0 && !picked.includes(true)) ? 0 : -1;
    }
  };
  function setProfile(patch) {
    if (!profiles || !editing) return;
    profiles = { ...profiles, list: profiles.list.map((p) => (p.id === editing ? { ...p, ...patch } : p)) };
    paintProfiles();
    actions.updateProfile?.(editing, patch);
  }
  const ppIcons = h("div", { class: "t3plus-pp-icons", role: "radiogroup", "aria-label": "Icon" },
    [null, ...Object.keys(PROFILE_ICONS)].map((key) => {
      const b = h("button", { type: "button", class: "t3plus-pp-icon", role: "radio", "data-icon": key ?? "", "aria-label": key ? PROFILE_ICONS[key].label : "No icon", title: key ? PROFILE_ICONS[key].label : "No icon" });
      if (key) b.innerHTML = profileIconSvg(key, 15);
      b.addEventListener("click", () => setProfile({ icon: key }));
      return b;
    }));
  rovingRow(ppIcons);
  const ppRows = {};
  for (const [field, label, hint] of PROFILE_FIELDS) {
    const swatches = h("div", { class: "t3plus-pp-swatches", role: "radiogroup", "aria-label": `${label} color`, "data-field": field },
      Object.entries(PROFILE_COLORS).map(([value, hex]) => {
        const name = value === "default" ? "Default" : value[0].toUpperCase() + value.slice(1);
        const title = value !== "default" ? name : field === "sky" ? "Default (T3's sky)" : field === "dither" ? "Default (the glow's color above)" : name;
        const b = h("button", { type: "button", class: "t3plus-pp-swatch", role: "radio", "data-value": value, "aria-label": name, title });
        if (hex) b.style.setProperty("--t3plus-profile-color", hex);
        b.addEventListener("click", () => setProfile({ [field]: value }));
        return b;
      }));
    rovingRow(swatches);
    // A color of your own: the preview follows while you drag, and it is kept on letting go.
    const custom = h("input", { type: "color", class: "t3plus-pp-custom", "aria-label": `Custom ${label.toLowerCase()} color`, title: "A color of your own" });
    custom.addEventListener("input", () => {
      draft = { ...draft, [field]: custom.value.toLowerCase() };
      paintProfiles();
      actions.previewProfile?.();
    });
    custom.addEventListener("blur", () => {
      if (!(field in draft)) return; // saved by "change" already
      const { [field]: _dropped, ...rest } = draft;
      draft = rest;
      paintProfiles();
      actions.previewProfile?.();
    });
    custom.addEventListener("change", () => {
      const value = custom.value.toLowerCase();
      const { [field]: _dropped, ...rest } = draft;
      draft = rest;
      setProfile({ [field]: value });
    });
    const rowEl = h("div", { class: "t3plus-pp-row", "data-field": field }, [
      h("div", { class: "t3plus-pp-row-text" }, [h("span", { class: "t3plus-pp-row-title", text: label }), h("span", { class: "t3plus-pp-row-hint", text: hint })]),
      h("div", { class: "t3plus-pp-row-picks" }, [swatches, custom]),
    ]);
    ppRows[field] = { row: rowEl, swatches, custom };
  }
  const profilesCard = h("div", { class: "t3plus-card", hidden: "" }, [
    row({
      title: "Profiles",
      description: "Each profile's icon, and the colors of its dot, the sidebar's sky and the dither glow: one of these, or your own (the last button in a row). Right-click a dot in the sidebar for the same.",
      extra: h("div", { class: "t3plus-pp-body" }, [
        ppChips,
        ppPreview,
        h("div", { class: "t3plus-pp-row", "data-field": "icon" }, [
          h("div", { class: "t3plus-pp-row-text" }, [h("span", { class: "t3plus-pp-row-title", text: "Icon" }), h("span", { class: "t3plus-pp-row-hint", text: "Before its name, beside the dots." })]),
          ppIcons,
        ]),
        ...PROFILE_FIELDS.map(([field]) => ppRows[field].row),
      ]),
    }),
  ]);
  rovingRow(ppChips);

  /** The sidebar's night art, copied for the preview (its gradients given ids of their own). */
  function ensureSkyArt() {
    if (ppSky.querySelector("svg")) return;
    const art = doc.querySelector('.sidebar-stage-backdrop svg[data-stage-art="nightly"]');
    if (!art) return;
    const copy = art.cloneNode(true);
    copy.removeAttribute("data-stage-art");
    const renamed = [];
    for (const el of copy.querySelectorAll("[id]")) {
      renamed.push([el.id, `t3plus-pp-${el.id}`]);
      el.id = `t3plus-pp-${el.id}`;
    }
    renamed.sort((a, b) => b[0].length - a[0].length); // the longest first: one id can start another
    for (const el of [copy, ...copy.querySelectorAll("*")]) {
      for (const attr of [...el.attributes]) {
        if (!attr.value.includes("#")) continue;
        let value = attr.value;
        for (const [from, to] of renamed) value = value.split(`#${from}`).join(`#${to}`);
        if (value !== attr.value) el.setAttribute(attr.name, value);
      }
    }
    ppSky.append(copy);
  }

  function chipFor(p, i) {
    const chip = h("button", { type: "button", class: "t3plus-pp-chip", role: "radio", "data-profile": p.id });
    if (p.icon) chip.insertAdjacentHTML("afterbegin", profileIconSvg(p.icon, 12));
    chip.append(h("span", { text: demoNames ? `Profile ${i + 1}` : p.name }));
    const hex = profileHex(p.color);
    if (hex) chip.style.setProperty("--t3plus-profile-color", hex);
    chip.addEventListener("click", () => {
      editing = p.id;
      draft = {};
      paintProfiles();
      actions.previewProfile?.();
    });
    return chip;
  }

  function paintProfiles() {
    if (!profiles) return;
    const index = profiles.list.findIndex((p) => p.id === editing);
    const p = profiles.list[index];
    if (!p) return;
    const value = (field) => draft[field] ?? p[field] ?? "default";
    checkIn(ppChips, (el) => el.dataset.profile === editing);
    checkIn(ppIcons, (el) => el.dataset.icon === (p.icon ?? ""));
    ppRows.sky.row.hidden = !profiles.sky;
    for (const [field] of PROFILE_FIELDS) {
      const v = value(field);
      const custom = /^#/.test(v);
      checkIn(ppRows[field].swatches, (el) => !custom && el.dataset.value === v);
      ppRows[field].custom.toggleAttribute("data-checked", custom);
      // Seeded with the color shown, so a custom one starts from it.
      if (doc.activeElement !== ppRows[field].custom) ppRows[field].custom.value = profileHex(v) ?? "#6d7cff";
    }
    // The preview: the name and dots, the sky, the glow.
    const dot = profileHex(value("color"));
    const nameText = demoNames ? `Profile ${index + 1}` : p.name;
    ppName.replaceChildren(h("span", { class: "t3plus-profiles-name-text", text: nameText }));
    if (p.icon) ppName.insertAdjacentHTML("afterbegin", profileIconSvg(p.icon, 11));
    if (dot) ppName.style.setProperty("--t3plus-profile-color", dot);
    else ppName.style.removeProperty("--t3plus-profile-color");
    ppDots.replaceChildren(
      ...profiles.list.map((q) => {
        const d = h("span", { class: "t3plus-pp-dot" });
        const hex = q.id === editing ? dot : profileHex(q.color);
        if (hex) d.style.setProperty("--t3plus-profile-color", hex);
        if (q.id === editing) d.setAttribute("data-on", "");
        return d;
      }),
    );
    ppSky.hidden = !profiles.sky;
    if (profiles.sky) {
      ensureSkyArt();
      const turn = actions.profileSkyTurn?.(value("sky")) ?? null;
      ppSky.toggleAttribute("data-tint", turn !== null);
      ppSky.style.setProperty("--t3plus-sky-turn", (turn ?? 0).toFixed(1));
      ppSky.style.setProperty("--t3plus-sky-mix", turn === null ? "0" : "1");
    }
    // With the background off or an image, a dither color has nothing to color.
    ppPane.toggleAttribute("data-glow-off", !glowOn);
    ppRows.dither.row.querySelector(".t3plus-pp-row-hint").textContent = glowOn ? "The dithered glow behind the chat." : "The glow behind the chat (shown when Background is on and is the glow).";
    const dither = profileHex(value("dither"));
    ppPane.style.setProperty("--t3plus-accent", dither ?? (globalAccent === "theme" ? "var(--primary, #6d7cff)" : globalAccent));
  }

  function updateProfiles(next, demo) {
    profiles = next;
    profilesCard.hidden = !next;
    if (!next) return;
    if (!next.list.some((p) => p.id === editing)) editing = next.active;
    const signature = JSON.stringify([next.list.map((p) => [p.id, p.name, p.icon ?? null, p.color]), demo]);
    if (signature !== profilesSignature || demo !== demoNames) {
      profilesSignature = signature;
      demoNames = demo;
      // Rebuilt (a name, an icon or a color changed): the focus stays on its chip.
      const focused = ppChips.contains(doc.activeElement) ? doc.activeElement.dataset.profile : null;
      ppChips.replaceChildren(...next.list.map((p, i) => chipFor(p, i)));
      if (focused) ppChips.querySelector(`[data-profile="${focused}"]`)?.focus();
    }
    paintProfiles();
  }

  const titleId = id("title");
  const section = h("section", { id: T3PLUS.panelId, class: "t3plus-section", "aria-labelledby": titleId }, [
    h("div", { class: "t3plus-section-header" }, [
      h("h2", { class: "t3plus-section-title", id: titleId }, ["t3+", h("span", { class: "t3plus-badge", text: desktop ? "Desktop" : "Extension" })]),
    ]),
    lookCard,
    h("h3", { class: "t3plus-subsection-title", text: "Features" }),
    featuresCard,
    botsCard,
    profilesCard,
    whatsNewCard,
    advanced,
  ]);

  function update(state) {
    const { settings, image, imageUrl, message } = state;
    const g = settings.composerGradient;
    backgroundToggle.setAttribute("aria-checked", String(g.enabled));
    for (const [value, input] of Object.entries(modeInputs)) input.checked = g.mode === value;
    imageRow.hidden = g.mode !== "image";
    accentRow.hidden = g.mode === "image";
    globalAccent = g.accent;
    glowOn = g.enabled && g.mode !== "image";
    // The open profile may have its own dither color: then that one shows, not this.
    setText(accentDesc, state.ditherAccent ? `${ACCENT_TEXT} The open profile has its own dither color (Profiles, below).` : ACCENT_TEXT);
    updateProfiles(state.profiles ?? null, Boolean(settings.demo?.enabled));

    const usingUpload = g.imageSource === "upload" && image;
    thumb.style.backgroundImage = imageUrl ? `url("${imageUrl.replace(/"/g, '\\"')}")` : "";
    sampleButton.setAttribute("aria-pressed", String(!usingUpload));
    removeButton.disabled = !image;
    // Screenshot mode: a file name can be personal ("passport-scan.png").
    const fileName = settings.demo.enabled ? "your image" : image?.name;
    setText(imageCaption, usingUpload
      ? `Using ${fileName} (${image.width}×${image.height}).`
      : image
        ? `Using the packaged sample. Your upload ${fileName} is still stored.`
        : "Using the packaged sample image.");

    themeButton.setAttribute("aria-pressed", String(g.accent === "theme"));
    // A color input cannot show "theme"; seed it with a neutral blue to pick from.
    if (doc.activeElement !== colorInput) colorInput.value = g.accent === "theme" ? "#6d7cff" : g.accent;
    intensity.set(g.intensity);
    const look = g.dither ? g.ditherStyle : "smooth";
    for (const [value, input] of Object.entries(lookInputs)) input.checked = look === value;
    for (const [value, input] of Object.entries(ditherSizeInputs)) input.checked = g.ditherSize === value;
    ditherSizeRow.hidden = !g.dither;

    glassToggle.setAttribute("aria-checked", String(settings.glass.enabled));
    glassStrength.set(settings.glass.strength);
    glassStrengthRow.hidden = !settings.glass.enabled;

    preview.dataset.backdrop = g.enabled ? g.mode : "off";
    updatePreviewBots(state.bots ?? []);
    preview.dataset.glass = String(settings.glass.enabled);
    setText(status, settings.demo.enabled && image?.name && message ? message.split(image.name).join("your image") : message);

    // Sidebar
    const problems = state.health ?? [];
    setText(healthText, problems.length
      ? `Not found in this T3 version, so these are off until t3+ is updated: ${problems.map((p) => `${p.feature} (${p.missing.join(", ")})`).join("; ")}.`
      : "Everything t3+ needs was found in this T3 version.");
    healthText.toggleAttribute("data-problem", problems.length > 0);
    botsToggle.setAttribute("aria-checked", String(settings.sidebar.bots));
    botsDefaultToggle.setAttribute("aria-checked", String(settings.sidebar.botsDefault));
    profilesToggle.setAttribute("aria-checked", String(settings.sidebar.profiles));
    for (const [value, input] of Object.entries(botStyleInputs)) input.checked = settings.sidebar.botStyle === value;
    homeToggle.setAttribute("aria-checked", String(settings.home.widgets));
    demoToggle.setAttribute("aria-checked", String(settings.demo.enabled));
    // Bots
    const bots = state.bots ?? [];
    const marker = state.botMarker;
    setText(botsEmpty, bots.length
      ? ""
      : `No bots yet. Turn on "Every thread is a bot", or put ${marker} at the start of a thread's title.`);
    botsEmpty.hidden = bots.length > 0;
    updateBots(bots);
    setText(botStatus, state.botMessage);
  }

  return {
    element: section,
    update,
    /** The dither color the Profiles preview shows ("#rrggbb"), or null for the glow's own. */
    profilePreviewAccent: () => {
      if (!profiles || profilesCard.hidden) return null;
      const p = profiles.list.find((q) => q.id === editing);
      return profileHex(draft.dither ?? p?.dither ?? "default");
    },
    /** Closes the open bot's picker (leaving Settings: it opens closed next time). */
    closeBotEditor: () => openBot !== null && setOpenBot(null),
  };
}
