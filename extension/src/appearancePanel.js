import { botClipPath, botEdgeColor, botFillUrl, botShapeHasOwnColors } from "./botArt.js";
import { applyAvatarVars, botPaintColor, PROJECT_COLOR, resolveBotPresentation } from "./bots.js";
import { APPEARANCE_ROUTE, BOT_COLORS, BOT_SHAPES, BOT_STYLES, IMAGE_LIMITS, T3_SELECTORS, T3PLUS } from "./config.js";
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
export function createAppearancePanel(doc, actions) {
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
    description: "Stored only in this browser. Large images are resized and saved as WebP.",
    control: [thumb, uploadButton, sampleButton, removeButton, fileInput],
    extra: imageCaption,
  });

  const colorInput = h("input", { type: "color", class: "t3plus-color", "aria-label": "Accent color" });
  colorInput.addEventListener("input", () => actions.previewAccent(colorInput.value));
  colorInput.addEventListener("change", () => actions.setAccent(colorInput.value));
  const themeButton = button("Theme", () => actions.setAccent("theme"));
  const accentRow = row({ title: "Accent", description: "Color of the glow. Theme follows your T3 theme's primary color.", control: [colorInput, themeButton] });

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
    const signature = JSON.stringify(list.map((b) => [b.key, b.titleLabel, b.preview, b.prefs]));
    if (signature === previewBotsSignature) return;
    previewBotsSignature = signature;
    previewBots.replaceChildren(
      ...list.map((bot, index) => {
        // First bot: open and working (animated, full-strength name). Second: idle and receded.
        const status = index === 0 ? "working" : "idle";
        const view = resolveBotPresentation({ key: bot.key, titleLabel: bot.titleLabel, status }, bot.prefs);
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
    row({ title: "Every thread is a bot", description: "On: all threads are bots; Option-click a thread to turn its bot off (and on again). Off: only threads you Option-click are bots.", control: botsDefaultToggle }),
    row({ title: "Profiles", description: "Dots at the bottom of the sidebar, like Dia's profiles: each shows its own projects. Swipe sideways with two fingers on the sidebar, click a dot, or press Ctrl+Shift+1–9 to switch; drag a project folder onto a profile to move it; right-click a dot to rename or delete it.", control: profilesToggle }),
    row({ title: "Bot style", description: "What bots look like when you have not picked a shape for one: Classic shapes in the project's color, or Sports balls, Space planets, or Fruit.", control: botStyleGroup }),
    row({ title: "Screenshot mode", description: "Swap thread titles, projects, branches and message text for believable stand-ins, to share the UI without personal details. Widgets stay real. Nothing in T3 changes. Shortcut: Alt+Shift+D.", control: demoToggle }),
    row({ title: "Usage widgets", description: "Pools, activity and usage under the new-thread composer, and the current provider's pool in thread details (Usage limits).", control: homeToggle }),
  ]);

  const advanced = h("details", { class: "t3plus-advanced" }, [
    h("summary", { class: "t3plus-advanced-summary", text: "Advanced" }),
    h("div", { class: "t3plus-card" }, [
      accentRow,
      ditherSizeRow,
      row({ title: "Glass", description: "Turn the translucent composer card off. Falls back to a solid card when the browser cannot blur.", control: glassToggle }),
      row({ title: "Backup", description: "Settings already carry over between versions (fixed extension ID, Chrome Sync). Export a file to also keep an uploaded image.", control: [exportButton, importButton, importFile] }),
      row({ title: "Reset", description: "Restore appearance defaults. A stored upload is kept until you remove it.", control: resetButton }),
    ]),
  ]);

  // ---------- Bots ----------
  const botsList = h("div", { class: "t3plus-bots" });
  const botsEmpty = h("p", { class: "t3plus-row-desc t3plus-bots-empty" });
  const botStatus = h("p", { class: "t3plus-status", role: "status", "aria-live": "polite" });
  const botsCard = h("div", { class: "t3plus-card" }, [
    row({ title: "Bots", description: "A shape and a color for each bot. Unpicked, each bot gets a shape from the bot style and takes its project's color. Option-click a thread in the sidebar to turn its bot on or off.", extra: h("div", {}, [botsEmpty, botsList, botStatus]) }),
  ]);

  const botEditors = new Map();
  let botSignature = "";

  function createBotEditor(bot) {
    const avatar = h("span", { class: "t3plus-bot-swatch", "aria-hidden": "true" });
    const name = h("strong", { class: "t3plus-bot-name" });
    const subtitle = h("span", { class: "t3plus-bot-key" });
    const forget = button("Forget", () => actions.forgetBot(bot.key), "t3plus-button-ghost");

    const swatchGroup = (label, entries, field, paint) => {
      const buttons = new Map();
      const group = h("div", { class: "t3plus-swatches", role: "group", "aria-label": `${label} for ${bot.key}` },
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
    const preview = h("p", { class: "t3plus-bot-preview" });
    const colorField = h("div", { class: "t3plus-field" }, [h("span", { text: "Color" }), colors.group]);

    const element = h("div", { class: "t3plus-bot-editor", "data-bot-key": bot.key }, [
      h("div", { class: "t3plus-bot-editor-head" }, [avatar, h("div", { class: "t3plus-bot-editor-names" }, [name, subtitle]), forget]),
      preview,
      h("div", { class: "t3plus-bot-editor-grid" }, [
        h("div", { class: "t3plus-field" }, [h("span", { text: "Shape" }), shapes.group]),
        colorField,
      ]),
    ]);
    return {
      element,
      update(next) {
        const current = next.prefs;
        setText(name, next.view.label);
        setText(subtitle, next.meta ? `${next.meta} · ${next.key}` : next.key);
        setText(preview, next.preview);
        preview.hidden = !next.preview;
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
        applyAvatarVars(avatar, next.view);
      },
    };
  }

  function updateBots(bots) {
    const signature = bots.map((b) => b.key).join("|");
    if (signature !== botSignature) {
      botSignature = signature;
      for (const key of [...botEditors.keys()]) if (!bots.some((b) => b.key === key)) botEditors.delete(key);
      botsList.replaceChildren(
        ...bots.map((bot) => {
          if (!botEditors.has(bot.key)) botEditors.set(bot.key, createBotEditor(bot));
          return botEditors.get(bot.key).element;
        }),
      );
    }
    for (const bot of bots) botEditors.get(bot.key).update(bot);
  }

  const titleId = id("title");
  const section = h("section", { id: T3PLUS.panelId, class: "t3plus-section", "aria-labelledby": titleId }, [
    h("div", { class: "t3plus-section-header" }, [
      h("h2", { class: "t3plus-section-title", id: titleId }, ["t3+", h("span", { class: "t3plus-badge", text: "Extension" })]),
    ]),
    lookCard,
    h("h3", { class: "t3plus-subsection-title", text: "Features" }),
    featuresCard,
    botsCard,
    advanced,
  ]);

  function update(state) {
    const { settings, image, imageUrl, message } = state;
    const g = settings.composerGradient;
    backgroundToggle.setAttribute("aria-checked", String(g.enabled));
    for (const [value, input] of Object.entries(modeInputs)) input.checked = g.mode === value;
    imageRow.hidden = g.mode !== "image";
    accentRow.hidden = g.mode === "image";

    const usingUpload = g.imageSource === "upload" && image;
    thumb.style.backgroundImage = imageUrl ? `url("${imageUrl.replace(/"/g, '\\"')}")` : "";
    sampleButton.setAttribute("aria-pressed", String(!usingUpload));
    removeButton.disabled = !image;
    setText(imageCaption, usingUpload
      ? `Using ${image.name} (${image.width}×${image.height}).`
      : image
        ? `Using the packaged sample. Your upload ${image.name} is still stored.`
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
    setText(status, message);

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
      : `No bots yet. Option-click a thread in the sidebar to make it a bot (Option-click again to undo), turn on "Every thread is a bot", or put ${marker} at the start of its title.`);
    botsEmpty.hidden = bots.length > 0;
    updateBots(bots);
    setText(botStatus, state.botMessage);
  }

  return { element: section, update };
}
