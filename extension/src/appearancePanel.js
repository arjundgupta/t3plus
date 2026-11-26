import { botArt, botClipPath, botEdgeColor, botFillUrl, botShapeHasOwnColors, botStill } from "./botArt.js";
import { renderNotes } from "./whatsNew.js";
import { updateCommand } from "./updateNotice.js";
import { PROFILE_COLORS, profileHex } from "./profiles.js";
import { PROFILE_ICONS, profileIconSvg } from "./profileIcons.js";
import { applyAvatarVars, botPaintColor, PROJECT_COLOR, resolveBotPresentation, shownBotPrefs, subagentFace } from "./bots.js";
import { APPEARANCE_ROUTE, BOT_COLORS, BOT_SHAPES, BOT_STYLES, DEFAULT_BOT_MARKER, IMAGE_LIMITS, PICKABLE_BOT_COLORS, SAME_AS_BOT, T3_SELECTORS, T3PLUS } from "./config.js";
import { createBuilder, setAttr, setHidden, setText, uniqueId as id } from "./dom.js";
import { createBadgeSample, createGlowSwatches, createStatusColorsSample, createSubagentSample, drawStyleFace, glowColorCss, glowSwatch, styleFace } from "./settingsPreviews.js";
import { ALL, isBaseScope } from "./settingsScopes.js";

// lucide icons (T3's set) for the scope bar.
const SVG = 'xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"';
const ICONS = {
  layers: `<svg ${SVG}><path d="m12.83 2.18a2 2 0 0 0-1.66 0L2.6 6.08a1 1 0 0 0 0 1.83l8.58 3.91a2 2 0 0 0 1.66 0l8.58-3.9a1 1 0 0 0 0-1.83Z"/><path d="m22 17.65-9.17 4.16a2 2 0 0 1-1.66 0L2 17.65"/><path d="m22 12.65-9.17 4.16a2 2 0 0 1-1.66 0L2 12.65"/></svg>`,
  devices: `<svg ${SVG}><path d="M18 8V6a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h8"/><path d="M10 19v-3.96 3.15"/><path d="M7 19h5"/><rect width="6" height="10" x="16" y="12" rx="2"/></svg>`,
  laptop: `<svg ${SVG}><path d="M20 16V7a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v9m16 0H4m16 0 1.28 2.55a1 1 0 0 1-.9 1.45H3.62a1 1 0 0 1-.9-1.45L4 16"/></svg>`,
  desktop: `<svg ${SVG}><rect width="20" height="14" x="2" y="3" rx="2"/><line x1="8" x2="16" y1="21" y2="21"/><line x1="12" x2="12" y1="17" y2="21"/></svg>`,
  server: `<svg ${SVG}><rect width="20" height="8" x="2" y="2" rx="2" ry="2"/><rect width="20" height="8" x="2" y="14" rx="2" ry="2"/><line x1="6" x2="6.01" y1="6" y2="6"/><line x1="6" x2="6.01" y1="18" y2="18"/></svg>`,
  chevron: `<svg ${SVG}><path d="m6 9 6 6 6-6"/></svg>`,
  check: `<svg ${SVG}><path d="M20 6 9 17l-5-5"/></svg>`,
  same: `<svg ${SVG}><path d="M5 9h14"/><path d="M5 15h14"/></svg>`,
  close: `<svg ${SVG}><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>`,
  reset: `<svg ${SVG}><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/></svg>`,
};
const machineIcon = (kind) => ICONS[kind === "desktop" ? "desktop" : kind === "server" ? "server" : "laptop"];

// Bots A to Z whatever the case. One collator for every sort: localeCompare with options
// builds one per comparison, about 30 times slower.
const BY_NAME = new Intl.Collator(undefined, { sensitivity: "base" });

/** url(#id) in an attribute: what comes before the id ("url(" and a quote), the id, and what closes it. */
const URL_REF = /(url\(\s*['"]?)#([^'")\s]+)(['"]?\s*\))/g;

/** Two pickers' option lists that draw the same menu (a memoized list is the same array). */
const sameOptions = (a, b) =>
  a === b || (a.length === b.length && a.every((o, i) => o.value === b[i].value && o.label === b[i].label && o.icon === b[i].icon && (o.hint ?? "") === (b[i].hint ?? "")));

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
 *   settings, image, imageUrl, message, health,
 *   bots: [{ key, title, titleLabel, prefs: { shape, color }, view, preview }], botMessage, botMarker,
 *   profiles: { list, active, sky } | null, profileAccents: { profileId: accent },
 *   scope: { edit, name, live, profiles, devices, own, elsewhere },
 * }
 */
export function createAppearancePanel(doc, actions, { desktop = false, version = null } = {}) {
  // The desktop build keeps everything in T3's own storage on this computer, not a browser's.
  const where = desktop ? "on this computer" : "in this browser";
  const h = createBuilder(doc);
  // A setting's row. `paths`: the settings it shows ("group.name"): in a profile's or a
  // machine's scope it says when that scope sets them itself (and offers to follow the
  // wider one again); `shared`: it is the same everywhere.
  const settingRows = []; // { el, paths, shared, title, note, reset, useAll }
  const row = ({ title, description, control, extra, paths = null, shared = false }) => {
    const titleId = id("row-title");
    const titleEl = h("h3", { class: "t3plus-row-title", id: titleId, text: title });
    const noteText = paths || shared ? h("span", { class: "t3plus-row-scope-text" }) : null;
    // For All profiles: the profiles and machines that keep their own value (so a change
    // here does not show in them), and a way to make this one apply everywhere.
    const useAll = paths ? button("Use for all", () => actions.clearEverywhere?.(paths), "t3plus-button-ghost t3plus-row-use-all") : null;
    if (useAll) useAll.hidden = true;
    const note = noteText ? h("p", { class: "t3plus-row-scope", hidden: "" }, [noteText, useAll]) : null;
    let reset = null;
    if (paths) {
      reset = h("button", { type: "button", class: "t3plus-row-reset", hidden: "" });
      reset.innerHTML = ICONS.reset;
      reset.addEventListener("click", () => actions.clearScope?.(paths));
    }
    const el = h("div", { class: "t3plus-row", role: "group", "aria-labelledby": titleId }, [
      h("div", { class: "t3plus-row-main" }, [
        h("div", { class: "t3plus-row-text" }, [
          h("div", { class: "t3plus-row-head" }, [titleEl, reset]),
          description ? h("p", { class: "t3plus-row-desc", text: description }) : null,
          note,
        ]),
        control ? h("div", { class: "t3plus-row-control" }, control) : null,
      ]),
      extra ?? null,
    ]);
    if (paths || shared) settingRows.push({ el, paths, shared, title, note, noteText, reset, useAll });
    return el;
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
      setText(output, format(Number(input.value)));
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

  // One choice of a few, as radio inputs in labels: `choices` [value, label]; `icon(value)`
  // a picture before a choice's label (a preview of it), or none.
  const segmented = (label, choices, onPick, icon = () => null) => {
    const name = id("choice");
    const inputs = {};
    const group = h("div", { class: "t3plus-segmented", role: "radiogroup", "aria-label": label },
      choices.map(([value, text]) => {
        const input = h("input", { type: "radio", name, value, class: "t3plus-sr-only" });
        input.addEventListener("change", () => input.checked && onPick(value));
        inputs[value] = input;
        return h("label", { class: "t3plus-segment" }, [input, icon(value), h("span", { text })]);
      }));
    return { group, inputs };
  };

  // Arrow keys move and pick within a row of choices; one Tab stop each.
  const rovingRow = (group) =>
    group.addEventListener("keydown", (e) => {
      if (e.altKey || e.ctrlKey || e.metaKey) return; // T3's (and the system's) with a modifier
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
      setAttr(el, "aria-checked", String(picked[i]));
      // One Tab stop: the picked one, or the first when none is (a custom color in use).
      const stop = picked[i] || (i === 0 && !picked.includes(true)) ? 0 : -1;
      if (el.tabIndex !== stop) el.tabIndex = stop;
    }
  };

  // A row of colors: the theme's or T3's own (first), the nine presets, or your own (the
  // last button: a color picker; dragging previews, letting go saves).
  const colorRow = ({ title, description, aria, field, ownName, ownTitle, start, paths, onPick, onPreview }) => {
    const swatches = h("div", { class: "t3plus-pp-swatches", role: "radiogroup", "aria-label": aria, "data-field": field },
      Object.entries(PROFILE_COLORS).map(([value, hex]) => {
        const name = value === "default" ? ownName : value[0].toUpperCase() + value.slice(1);
        const b = h("button", { type: "button", class: "t3plus-pp-swatch", role: "radio", "data-value": value, "aria-label": name, title: value === "default" ? ownTitle : name });
        if (hex) b.style.setProperty("--t3plus-profile-color", hex);
        b.addEventListener("click", () => onPick(hex ?? "theme"));
        return b;
      }));
    rovingRow(swatches);
    const custom = h("input", { type: "color", class: "t3plus-pp-custom", "aria-label": `Custom ${aria.toLowerCase()}`, title: "Your own color" });
    custom.addEventListener("input", () => onPreview(custom.value.toLowerCase()));
    custom.addEventListener("change", () => onPick(custom.value.toLowerCase()));
    const el = row({ title, description, paths, control: h("div", { class: "t3plus-pp-row-picks" }, [swatches, custom]) });
    return {
      row: el,
      /** value: "theme" (the first swatch) or "#rrggbb" (a preset, or the color picker's). */
      update(value) {
        const preset = value === "theme" ? "default" : (Object.entries(PROFILE_COLORS).find(([, hex]) => hex === value)?.[0] ?? null);
        checkIn(swatches, (b) => b.dataset.value === preset);
        custom.toggleAttribute("data-checked", preset === null);
        // The picker starts from the color shown (it cannot show "theme").
        if (doc.activeElement !== custom) custom.value = value === "theme" ? start : value;
      },
    };
  };

  // ---------- Background + glass ----------
  const backgroundToggle = switchButton("Background", (on) => actions.setEnabled(on));

  const { group: modeGroup, inputs: modeInputs } = segmented("Background style", [["half-circle", "Glow"], ["image", "Image"]], (value) => actions.setMode(value));

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
    description: `Saved only ${where}.`,
    control: [thumb, uploadButton, sampleButton, removeButton, fileInput],
    extra: imageCaption,
    paths: ["composerGradient.imageSource"],
  });

  const glow = colorRow({
    title: "Glow color",
    description: "The glow's color. Theme matches your T3 theme.",
    aria: "Glow color",
    field: "glow",
    ownName: "Theme",
    ownTitle: "Your T3 theme's color",
    start: "#6d7cff",
    paths: ["composerGradient.accent"],
    onPick: (value) => actions.setAccent(value),
    onPreview: (value) => actions.previewAccent(value),
  });

  // Each look and each pixel size shows a pinch of the glow drawn that way (settingsPreviews.js).
  const sizeSwatches = new Map();
  const lookSwatches = new Map();
  const swatchIn = (swatches) => (value) => swatches.set(value, glowSwatch(h)).get(value);
  const { group: ditherSizeGroup, inputs: ditherSizeInputs } = segmented("Dither pixel size", [["fine", "Fine"], ["medium", "Medium"], ["large", "Large"]], (value) => actions.setDitherSize(value), swatchIn(sizeSwatches));
  const { group: lookGroup, inputs: lookInputs } = segmented("Look", [["bayer", "Bayer"], ["grain", "Grain"], ["spectrum", "Spectrum"], ["smooth", "Smooth"]], (value) => actions.setLook(value), swatchIn(lookSwatches));
  const paintGlowSwatches = createGlowSwatches(lookSwatches, sizeSwatches);
  const lookRow = row({
    title: "Look",
    description: "The glow's pixel pattern, or a smooth gradient.",
    control: lookGroup,
    paths: ["composerGradient.dither", "composerGradient.ditherStyle"],
  });
  const ditherSizeRow = row({ title: "Pixel size", description: "How big the glow's pixels are.", control: ditherSizeGroup, paths: ["composerGradient.ditherSize"] });
  const intensity = slider("Intensity", (v) => actions.previewIntensity(v), (v) => actions.setIntensity(v));

  const glassToggle = switchButton("Glass composer", (on) => actions.setGlass(on));
  const glassStrength = slider("Glass strength", (v) => actions.previewGlassStrength(v), (v) => actions.setGlassStrength(v));
  const glassStrengthRow = row({ title: "Glass composer", description: "How much background shows through the composer.", control: [glassStrength.output, glassStrength.input], paths: ["glass.strength"] });

  const resetButton = button("Reset", () => actions.reset(), "t3plus-button-ghost");
  const RESET_TEXT = "Restore the default background and glass. Your upload stays.";
  const resetRow = row({ title: "Reset", description: RESET_TEXT, control: resetButton });
  const resetDesc = resetRow.querySelector(".t3plus-row-desc");

  // ---------- Scope: "Applying t3+ for [All profiles ▾] on [All devices ▾]" ----------
  // As in T3's own Settings: which profile and machine the settings below are for.
  // A picker is a button and a listbox under it (arrow keys, type-ahead, Enter, Escape);
  // the Subagents row has two more (the t3plus-scope-* classes are theirs too).
  const picker = (label, onPick) => {
    const win = doc.defaultView;
    const icon = h("span", { class: "t3plus-scope-icon" });
    const text = h("span", { class: "t3plus-scope-text" });
    const chevron = h("span", { class: "t3plus-scope-chevron" });
    chevron.innerHTML = ICONS.chevron;
    const trigger = h("button", { type: "button", class: "t3plus-scope-pick", "aria-haspopup": "listbox", "aria-expanded": "false" }, [icon, text, chevron]);
    const menuId = id("picker");
    const menu = h("div", { class: "t3plus-scope-menu", id: menuId, role: "listbox", "aria-label": label, tabindex: "-1", hidden: "" });
    const wrap = h("span", { class: "t3plus-scope-field" }, [trigger, menu]);
    // [{ value, label, icon, hint }]: icon is markup, or a function that draws it when it is
    // first shown (a face: a closed list of 48 drew them all on every first visit).
    let options = [];
    let value = null; // the one picked
    let shownIcon = "";
    let items = []; // the menu's option elements, one per option
    let stale = true; // items do not show the options and value set last
    let active = null;
    const iconOf = (o) => (typeof o.icon === "function" ? o.icon() : o.icon);
    // Keys and opening scroll it into view, the pointer does not: the list ran away under it.
    const setActive = (el, { scroll = true } = {}) => {
      active?.removeAttribute("data-active");
      active = el ?? null;
      if (!active) {
        menu.removeAttribute("aria-activedescendant");
        return;
      }
      active.setAttribute("data-active", "");
      menu.setAttribute("aria-activedescendant", active.id);
      if (scroll) active.scrollIntoView?.({ block: "nearest" });
    };
    const draw = () => {
      stale = false;
      items = options.map((o) => {
        const mark = h("span", { class: "t3plus-scope-icon" });
        mark.innerHTML = iconOf(o);
        const check = h("span", { class: "t3plus-scope-check" });
        if (o.value === value) check.innerHTML = ICONS.check;
        // Its id follows its value: drawn again, the option active keeps it (and is not announced again).
        return h("div", { class: "t3plus-scope-option", role: "option", id: `${menuId}-${encodeURIComponent(o.value)}`, "data-value": o.value, "aria-selected": String(o.value === value) }, [
          mark,
          h("span", { class: "t3plus-scope-option-text", text: o.label }),
          o.hint ? h("span", { class: "t3plus-scope-hint", text: o.hint }) : null,
          check,
        ]);
      });
      menu.replaceChildren(...items);
    };
    // Type-ahead, as a native select has: what is typed within half a second moves to the
    // next option whose name starts with it (one letter again and again steps through them).
    let typed = "";
    let typedTimer = null;
    const forgetTyped = () => {
      win.clearTimeout(typedTimer);
      typedTimer = null;
      typed = "";
    };
    const typeAhead = (key) => {
      win.clearTimeout(typedTimer);
      typedTimer = win.setTimeout(forgetTyped, 500);
      typed += key.toLowerCase();
      const prefix = [...typed].every((c) => c === typed[0]) ? typed[0] : typed;
      // One letter: from the option after the active one. More: the active one may still match.
      const at = items.indexOf(active);
      const from = prefix.length === 1 ? at + 1 : Math.max(at, 0);
      for (let i = 0; i < items.length; i += 1) {
        const k = (from + i) % items.length;
        if (options[k].label.toLowerCase().startsWith(prefix)) return items[k];
      }
      return null;
    };
    const outside = (event) => {
      if (!wrap.contains(event.target)) close();
    };
    function open() {
      if (stale) draw();
      menu.hidden = false;
      trigger.setAttribute("aria-expanded", "true");
      doc.addEventListener("pointerdown", outside, true);
      setActive(items.find((o) => o.dataset.value === value) ?? items[0]);
      menu.focus();
    }
    function close(refocus = false) {
      if (menu.hidden) return;
      menu.hidden = true;
      trigger.setAttribute("aria-expanded", "false");
      doc.removeEventListener("pointerdown", outside, true);
      forgetTyped();
      if (refocus) trigger.focus();
    }
    const choose = (el) => {
      if (!el) return;
      close(true);
      if (el.dataset.value !== value) onPick(el.dataset.value);
    };
    trigger.addEventListener("click", () => (menu.hidden ? open() : close()));
    trigger.addEventListener("keydown", (event) => {
      if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
      event.preventDefault();
      open();
    });
    menu.addEventListener("keydown", (event) => {
      const at = items.indexOf(active);
      const to = { ArrowDown: at + 1, ArrowUp: at - 1, Home: 0, End: items.length - 1 }[event.key];
      if (to !== undefined) {
        event.preventDefault();
        setActive(items[Math.max(0, Math.min(items.length - 1, to))]);
      } else if (event.key === "Enter" || (event.key === " " && !typed)) {
        event.preventDefault();
        choose(active);
      } else if (event.key === "Escape") {
        // Kept from T3: its Escape leaves Settings.
        event.preventDefault();
        event.stopPropagation();
        close(true);
      } else if (event.key === "Tab") close();
      else if (event.key.length === 1 && !event.altKey && !event.ctrlKey && !event.metaKey && !event.isComposing) {
        // A character (a space too, while a name is being typed).
        event.preventDefault();
        const found = typeAhead(event.key);
        if (found) setActive(found);
      }
    });
    menu.addEventListener("click", (event) => choose(event.target.closest?.("[role=option]")));
    menu.addEventListener("pointermove", (event) => {
      const o = event.target.closest?.("[role=option]");
      if (o && o !== active) setActive(o, { scroll: false });
    });
    return {
      el: wrap,
      close,
      /** options: [{ value, label, icon, hint? }], the first the fallback (All, or the bot's own); value: the one picked. */
      set(nextOptions, nextValue) {
        const picked = nextOptions.find((o) => o.value === nextValue) ?? nextOptions[0];
        // Every update hands the same ones again: an open menu drawn again each time lost
        // its active option's id (announced again) and jumped back to it under the wheel.
        if (picked.value !== value || !sameOptions(nextOptions, options)) stale = true;
        options = nextOptions;
        value = picked.value;
        const shown = iconOf(picked);
        if (shownIcon !== shown) {
          shownIcon = shown;
          icon.innerHTML = shown;
        }
        setText(text, picked.label);
        setAttr(trigger, "aria-label", `${label}: ${picked.label}`);
        // One option only (profiles off, one machine): shown, not offered.
        const alone = options.length < 2;
        if (trigger.disabled !== alone) trigger.disabled = alone;
        if (alone) close();
        else if (stale && !menu.hidden) {
          const was = active?.dataset.value;
          draw();
          setActive(items.find((o) => o.dataset.value === was) ?? null, { scroll: false });
        }
      },
    };
  };
  let scope = null; // the last scope state from the app
  const pickScope = (patch) => actions.setEditScope?.({ ...(scope?.edit ?? { profile: ALL, device: ALL }), ...patch });
  const profilePick = picker("Profile", (value) => pickScope({ profile: value }));
  const devicePick = picker("Device", (value) => pickScope({ device: value }));
  const scopeOwn = h("span", { class: "t3plus-scope-own" });
  const scopeClear = button("Clear", () => actions.clearScope?.(), "t3plus-button-ghost t3plus-scope-clear");
  const scopeBar = h("div", { class: "t3plus-scope", role: "group", "aria-label": "Which settings you change" }, [
    h("span", { class: "t3plus-scope-words", text: "Applying t3+ for" }),
    profilePick.el,
    h("span", { class: "t3plus-scope-words", text: "on" }),
    devicePick.el,
    h("span", { class: "t3plus-scope-summary" }, [scopeOwn, scopeClear]),
  ]);
  const dotIcon = (hex) => `<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="5" fill="${hex ?? "currentColor"}"/></svg>`;
  const listNames = (names) =>
    names.length === 1 ? names[0] : names.length <= 3 ? `${names.slice(0, -1).join(", ")} and ${names.at(-1)}` : `${names.slice(0, 2).join(", ")} and ${names.length - 2} more`;
  /** The scope bar and every setting's row: what the scope edited sets itself, and where else a value differs. */
  function paintScope(next) {
    scope = next;
    const base = isBaseScope(next.edit);
    profilePick.set(
      [
        { value: ALL, label: "All profiles", icon: ICONS.layers },
        ...next.profiles.map((p) => ({ value: p.id, label: p.name, icon: p.icon ? profileIconSvg(p.icon, 14) : dotIcon(p.color), hint: p.id === next.live.profile ? "Open" : "" })),
      ],
      next.edit.profile,
    );
    devicePick.set(
      [
        { value: ALL, label: "All devices", icon: ICONS.devices },
        ...next.devices.map((d) => ({ value: d.id, label: d.label, icon: machineIcon(d.kind), hint: d.id === next.live.device ? "Open" : "" })),
      ],
      next.edit.device,
    );
    const own = Object.keys(next.own).length;
    setText(scopeOwn, base ? "" : own ? `${own} setting${own === 1 ? "" : "s"} of its own` : "No settings of its own yet.");
    setHidden(scopeClear, base || own === 0);
    setAttr(scopeClear, "aria-label", `Clear ${next.name}'s own settings`);
    for (const r of settingRows) {
      let note = "";
      let mine = false;
      let others = false;
      if (r.shared) note = base ? "" : "Same for all profiles and devices.";
      else if (base) {
        const names = [...new Set(r.paths.flatMap((path) => next.elsewhere[path] ?? []))];
        others = names.length > 0;
        if (others) note = names.length === 1 ? `${names[0]} has its own value.` : `${listNames(names)} have their own values.`;
      } else if (r.paths.some((path) => Object.hasOwn(next.own, path))) {
        mine = true;
        note = `Set for ${next.name}.`;
      }
      r.el.toggleAttribute("data-scope-own", mine);
      if (r.note) {
        setText(r.noteText, note);
        setHidden(r.note, !note);
      }
      if (r.useAll) {
        setHidden(r.useAll, !others);
        // Its words first (voice control says them), and none that depend on the title's
        // number ("Use this subagents").
        setAttr(r.useAll, "aria-label", `Use for all: ${r.title}, for every profile and device`);
      }
      if (r.reset) {
        setHidden(r.reset, !mine);
        const label = `Clear ${next.name}'s own ${r.title.toLowerCase()}`;
        if (r.reset.getAttribute("aria-label") !== label) {
          r.reset.setAttribute("aria-label", label);
          r.reset.title = label;
        }
      }
    }
    setText(resetDesc, base ? RESET_TEXT : `Clear ${next.name}'s own background and glass.`);
  }
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
  // What the preview's faces show. Forgotten when Settings is left (leave()): the
  // sprite clock lets go of a face taken off the page, so the working one stood still on
  // its last frame when Settings was opened again. Drawn anew, it is stepped again.
  let previewBotsSignature = "";
  function updatePreviewBots(bots, sidebar) {
    const list = (bots.length ? bots : SAMPLE_PREVIEW_BOTS).slice(0, 2);
    // The bot style and the project color change a face too: switching to Sports
    // left the preview on the old shapes, and preview bots ignored their project.
    // Status badges too, the tile on each face. Not Status colors: the preview is T3's
    // list, where bots wear their own colors (they paint the Status view only).
    const signature = JSON.stringify([sidebar.statusBadges, list.map((b) => [b.key, b.titleLabel, b.preview, b.prefs, b.projectColor ?? null, b.view?.shape ?? null])]);
    if (signature === previewBotsSignature) return;
    previewBotsSignature = signature;
    previewBots.replaceChildren(
      ...list.map((bot, index) => {
        // First bot: open and working (animated, full-strength name). Second: idle and receded.
        const status = index === 0 ? "working" : "idle";
        const prefs = shownBotPrefs(bot.prefs, { badges: sidebar.statusBadges });
        const view = resolveBotPresentation({ key: bot.key, titleLabel: bot.titleLabel, status, projectColor: bot.projectColor ?? null }, prefs);
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

  // Your messages' bubbles: T3's, one of the nine, or your own.
  const bubbles = colorRow({
    title: "Chat bubbles",
    description: "The color of your messages.",
    aria: "Chat bubble color",
    field: "bubble",
    ownName: "T3's",
    ownTitle: "T3's own",
    start: "#3b82f6",
    paths: ["chat.bubble"],
    onPick: (value) => actions.setBubble(value),
    onPreview: (value) => actions.previewBubble(value),
  });

  const lookCard = h("div", { class: "t3plus-card" }, [
    row({
      title: "Background",
      description: "A glow or image behind the chat.",
      control: backgroundToggle,
      extra: preview,
      paths: ["composerGradient.enabled"],
    }),
    row({ title: "Style", description: "A pixel glow, or your own image.", control: modeGroup, paths: ["composerGradient.mode"] }),
    imageRow,
    lookRow,
    glow.row,
    row({ title: "Intensity", description: "How strongly the background shows.", control: [intensity.output, intensity.input], paths: ["composerGradient.intensity"] }),
    glassStrengthRow,
    bubbles.row,
    status,
  ]);

  // ---------- Features ----------
  const botsToggle = switchButton("Bot rows", (on) => actions.setSidebarFeature("bots", on));
  const botsDefaultToggle = switchButton("Every thread is a bot", (on) => actions.setSidebarFeature("botsDefault", on));
  const profilesToggle = switchButton("Profiles", (on) => actions.setSidebarFeature("profiles", on));
  // Each style with a face of its own, drawn on the first update (the panel is made at start,
  // and Settings may never be opened).
  const styleFaces = new Map();
  const { group: botStyleGroup, inputs: botStyleInputs } = segmented("Bot style", Object.entries(BOT_STYLES).map(([value, style]) => [value, style.label]), (value) => actions.setSidebarFeature("botStyle", value), (value) => styleFaces.set(value, styleFace(h)).get(value));
  let styleFacesDrawn = false;
  const drawStyleFaces = () => {
    if (styleFacesDrawn) return;
    styleFacesDrawn = true;
    for (const [value, el] of styleFaces) drawStyleFace(el, BOT_STYLES[value]);
  };
  const homeToggle = switchButton("Usage widgets", (on) => actions.setHomeWidgets(on));
  const statusColorsToggle = switchButton("Status colors", (on) => actions.setSidebarFeature("statusColors", on));
  const statusBadgesToggle = switchButton("Status badges", (on) => actions.setSidebarFeature("statusBadges", on));
  const statusColorsSample = createStatusColorsSample(h);
  const badgeSample = createBadgeSample(h);
  const subagentSample = createSubagentSample(h);
  // Subagents' faces: their bot's shape and color unless picked here.
  const subagentShapePick = picker("Subagent shape", (value) => actions.setSidebarFeature("subagentShape", value));
  const subagentColorPick = picker("Subagent color", (value) => actions.setSidebarFeature("subagentColor", value));
  const demoToggle = switchButton("Screenshot mode", (on) => actions.setDemo(on));
  // What t3+ could not find in this T3 version (src/health.js).
  const healthText = h("p", { class: "t3plus-row-desc t3plus-health", role: "status", "aria-live": "polite" });
  const featuresCard = h("div", { class: "t3plus-card" }, [
    row({ title: "Status", extra: healthText }),
    row({ title: "Bot rows", description: "Bots get a face and show their latest message.", control: botsToggle, paths: ["sidebar.bots"] }),
    row({ title: "Every thread is a bot", description: `When off, only titles starting with ${DEFAULT_BOT_MARKER} are bots.`, control: botsDefaultToggle, paths: ["sidebar.botsDefault"] }),
    row({ title: "Profiles", description: "Switch with a dot, a two-finger swipe, or Ctrl+Shift+1–9. Right-click a dot to rename it.", control: profilesToggle, shared: true }),
    row({ title: "Bot style", description: "How bots look until you pick a shape.", control: botStyleGroup, paths: ["sidebar.botStyle"] }),
    row({ title: "Status colors", description: "In the Status view, bots wear their status's color.", control: statusColorsToggle, extra: statusColorsSample.element, paths: ["sidebar.statusColors"] }),
    row({ title: "Status badges", description: "A tile on each face that shows its status.", control: [badgeSample.element, statusBadgesToggle], paths: ["sidebar.statusBadges"] }),
    row({
      title: "Subagents",
      description: "Small faces under a bot, one per subagent.",
      control: [subagentSample.element, h("div", { class: "t3plus-subagent-picks" }, [subagentShapePick.el, subagentColorPick.el])],
      paths: ["sidebar.subagentShape", "sidebar.subagentColor"],
    }),
    row({ title: "Usage widgets", description: "Usage and limits under the new-thread composer.", control: homeToggle, paths: ["home.widgets"] }),
  ]);

  // ---------- Changelog ----------
  // Every version's notes (newest first, the installed one marked), opened in place
  // under a disclosure button. Built on the first open, then kept: the panel is made at
  // start, and Settings may never be opened.
  const changelogToggle = h("button", { type: "button", class: "t3plus-changelog-toggle", id: id("changelog-toggle"), "aria-expanded": "false", text: "Changelog" });
  const changelogNotes = h("div", { class: "t3plus-card t3plus-changelog-notes", id: id("changelog"), role: "region", "aria-labelledby": changelogToggle.id, hidden: "" });
  changelogToggle.setAttribute("aria-controls", changelogNotes.id);
  // At the end of the notes too, so a long read can be folded without scrolling back
  // up; the focus goes back to the toggle, not to the page with the button gone.
  const changelogHide = button("Hide changelog", () => {
    showChangelog(false);
    changelogToggle.focus();
  }, "t3plus-button-ghost t3plus-changelog-hide");
  function showChangelog(open) {
    if (open && !changelogNotes.firstChild) changelogNotes.append(renderNotes(doc, { version }), changelogHide);
    setAttr(changelogToggle, "aria-expanded", String(open));
    setHidden(changelogNotes, !open);
  }
  changelogToggle.addEventListener("click", () => showChangelog(changelogToggle.getAttribute("aria-expanded") !== "true"));
  const changelog = h("div", { class: "t3plus-changelog" }, [changelogToggle, changelogNotes]);

  const advanced = h("details", { class: "t3plus-advanced" }, [
    h("summary", { class: "t3plus-advanced-summary", text: "Advanced" }),
    h("div", { class: "t3plus-card" }, [
      ditherSizeRow,
      row({ title: "Glass", description: "A see-through composer card.", control: glassToggle, paths: ["glass.enabled"] }),
      row({ title: "Backup", description: "Save all of t3+ to a file, or load one.", control: [exportButton, importButton, importFile] }),
      resetRow,
    ]),
  ]);

  // For making screenshots and recordings of t3+; closed by default, like Advanced.
  const developer = h("details", { class: "t3plus-advanced t3plus-developer" }, [
    h("summary", { class: "t3plus-advanced-summary", text: "Developer" }),
    h("div", { class: "t3plus-card" }, [
      row({ title: "Screenshot mode", description: "Swaps names and messages for stand-ins. Terminals, diffs and files stay real.", control: demoToggle, shared: true }),
    ]),
  ]);

  // ---------- Bots ----------
  // A list and the one picked: the bots on the left (face, name, latest message, A to Z,
  // with a search), and on the right the one picked, big, with its shapes in their sets
  // (Classic, Sports, Space, Fruit) and its colors. The card keeps its height however
  // many bots there are.
  const botsSearch = h("input", { type: "search", class: "t3plus-bots-search", placeholder: "Search bots", "aria-label": "Search bots" });
  const botsList = h("div", { class: "t3plus-bots", role: "listbox", "aria-label": "Bots" });
  const botsNone = h("p", { class: "t3plus-bots-none", text: "No bot matches." });
  // Not a live region: the picked bot is announced as its option is, and a working bot's
  // streaming message would be read out again and again.
  const botSlot = h("div", { class: "t3plus-bot-slot", id: id("bot-editor"), role: "region", "aria-label": "Bot picked" });
  const botsEmpty = h("p", { class: "t3plus-row-desc t3plus-bots-empty" });
  const botStatus = h("p", { class: "t3plus-status", role: "status", "aria-live": "polite" });
  const botsBoth = h("div", { class: "t3plus-bots-both" }, [h("div", { class: "t3plus-bots-side" }, [botsSearch, botsList, botsNone]), botSlot]);
  const botsCard = h("div", { class: "t3plus-card" }, [
    row({ title: "Bots", description: "Pick one to change its shape or color.", extra: h("div", { class: "t3plus-bots-body" }, [botsEmpty, botsBoth, botStatus]), shared: true }),
  ]);

  const botEntries = new Map(); // key -> { chip, avatar, name, line, bot }
  let botOrder = []; // keys, A to Z
  let openBot = null; // the bot picked (shown on the right)
  let botEditor = null; // made when a bot is first picked
  let botsWearStatus = false; // Status colors, in the scope edited

  // Shapes in their sets: Sports, Space and Fruit as Bot style has them, Classic the rest.
  const SHAPE_SETS = (() => {
    const themed = Object.entries(BOT_STYLES).filter(([, s]) => s.shapes);
    const inSet = new Set(themed.flatMap(([, s]) => s.shapes));
    return [["Classic", Object.keys(BOT_SHAPES).filter((k) => !inSet.has(k))], ...themed.map(([, s]) => [s.label, s.shapes.filter((k) => Object.hasOwn(BOT_SHAPES, k))])];
  })();

  // The Subagents row's pickers: the bot's own first, in words of its own for each (two
  // "Same as bot" buttons side by side read the same), then each shape (its set as the
  // hint) or each color.
  const cap = (w) => w[0].toUpperCase() + w.slice(1);
  const attr = (text) => text.replaceAll("&", "&amp;").replaceAll('"', "&quot;");
  /** `draw()` the first time it is asked for, the same markup after that. */
  const once = (draw) => {
    let markup = null;
    return () => (markup ??= draw());
  };
  // A shape as the sidebar draws a subagent under a bot of that shape (bots.js subagentFace):
  // in the color picked for subagents (gray for the bot's own), a ball, a planet or a fruit
  // in its own colors.
  const faceIcon = (color, shape) => {
    const face = subagentFace({ shape, paint: "gray" }, { shape, color });
    return `<i class="t3plus-face-icon" style="${attr(`--t3plus-bot-fill: ${botStill(face.color, face.shape).url}; --t3plus-bot-clip: ${face.clip}`)}"></i>`;
  };
  const SAME_SHAPE = Object.freeze({ value: SAME_AS_BOT, label: "Bot's shape", icon: ICONS.same });
  const SAME_COLOR = Object.freeze({ value: SAME_AS_BOT, label: "Bot's color", icon: ICONS.same });
  const SUBAGENT_COLOR_OPTIONS = Object.freeze([SAME_COLOR, ...PICKABLE_BOT_COLORS.map((name) => ({ value: name, label: BOT_COLORS[name].label, icon: dotIcon(BOT_COLORS[name].stops[1]) }))]);
  // One list per subagent color (the bot's own, or a pickable one), its faces drawn when
  // first shown: the picked one on the button, the rest once the list is opened.
  const shapeOptionsByColor = new Map();
  const subagentShapeOptions = (color) => {
    if (!shapeOptionsByColor.has(color)) {
      shapeOptionsByColor.set(color, [SAME_SHAPE, ...SHAPE_SETS.flatMap(([set, shapes]) => shapes.map((shape) => ({ value: shape, label: cap(shape), icon: once(() => faceIcon(color, shape)), hint: set })))]);
    }
    return shapeOptionsByColor.get(color);
  };

  // The one picked, on the right: one editor, shown for whichever bot is picked.
  function createBotEditor() {
    let bot = null; // the bot shown
    const forget = button("Forget", () => actions.forgetBot(bot.key), "t3plus-button-ghost");
    forget.title = "Forget this bot's shape and color";

    // A toolbar of swatches with one Tab stop (the pressed one, else the first): arrow
    // keys, Home and End move within it, Enter or Space picks. Each a stop, the editor's
    // 58 swatches were 58 Tab presses to get past.
    const swatchGroup = (label, entries, field, paint) => {
      const buttons = new Map();
      const group = h("div", { class: "t3plus-swatches", role: "toolbar", "aria-label": label, "data-field": field },
        entries.map(([value, text]) => {
          const mark = h("span", { class: "t3plus-swatch-mark", "aria-hidden": "true" });
          paint(mark, value);
          const el = h("button", { type: "button", class: "t3plus-swatch", title: text, "aria-label": text, "data-value": value }, [mark]);
          el.addEventListener("click", () => actions.updateBot(bot.key, { [field]: value }));
          buttons.set(value, el);
          return el;
        }));
      const all = [...buttons.values()];
      const stopAt = (stop) => {
        for (const el of all) {
          const index = el === stop ? 0 : -1;
          if (el.tabIndex !== index) el.tabIndex = index;
        }
        return stop;
      };
      stopAt(all[0]);
      group.addEventListener("keydown", (e) => {
        if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return; // T3's (and the system's) with a modifier
        const at = all.indexOf(doc.activeElement);
        const to = at < 0 ? undefined : { ArrowLeft: at - 1, ArrowUp: at - 1, ArrowRight: at + 1, ArrowDown: at + 1, Home: 0, End: all.length - 1 }[e.key];
        if (to === undefined) return;
        e.preventDefault();
        stopAt(all[(to + all.length) % all.length]).focus();
      });
      let pressed = null; // the value shown pressed
      return {
        group,
        buttons,
        name(botName) {
          setAttr(group, "aria-label", `${label} for ${botName}`);
        },
        set(value) {
          if (value === pressed) return;
          pressed = value;
          for (const [v, el] of buttons) setAttr(el, "aria-pressed", String(v === value));
          stopAt(buttons.get(value) ?? all[0]);
        },
      };
    };
    const shapeSets = SHAPE_SETS.map(([label, keys]) => ({
      label,
      group: swatchGroup(`${label} shapes`, keys.map((k) => [k, cap(k)]), "shape", (mark, shape) => mark.style.setProperty("--t3plus-bot-clip", botClipPath(shape))),
    }));
    // "Project" first: the bot follows its project's badge color.
    const colors = swatchGroup("Color", [[PROJECT_COLOR, "Project color"], ...PICKABLE_BOT_COLORS.map((k) => [k, BOT_COLORS[k].label])], "color", (mark, color) => {
      mark.style.setProperty("--t3plus-bot-edge", botEdgeColor(color));
    });
    // Status colors on (the switch above, in the scope edited): bots wear their status's
    // color, and the one picked here shows once it is off.
    const colorNote = h("p", { class: "t3plus-row-desc", id: id("bot-color-note"), hidden: "", text: "Status colors is on: this color shows outside the Status view." });
    const colorField = h("div", { class: "t3plus-bot-set", "data-set": "color" }, [h("span", { class: "t3plus-bot-set-label", text: "Color" }), colors.group, colorNote]);
    const face = h("span", { class: "t3plus-bot-swatch t3plus-bot-hero-face", "aria-hidden": "true" });
    const title = h("h4", { class: "t3plus-bot-hero-name" });
    // Its latest message: tells two bots with the same name apart.
    const message = h("p", { class: "t3plus-bot-message" });
    const meta = h("p", { class: "t3plus-bot-meta" });

    const element = h("div", { class: "t3plus-bot-editor" }, [
      h("div", { class: "t3plus-bot-hero" }, [face, h("div", { class: "t3plus-bot-hero-text" }, [title, message, meta]), forget]),
      ...shapeSets.map((s) => h("div", { class: "t3plus-bot-set", "data-set": s.label }, [h("span", { class: "t3plus-bot-set-label", text: s.label }), s.group.group])),
      colorField,
    ]);

    // Each swatch is the bot's face as it would look: shape buttons in the bot's color,
    // color buttons in the bot's shape (eyes follow the shape). Drawn again only when that
    // changes: every update (each step of a slider drag) re-sent 58 faces to be parsed.
    let shapesDrawn = null; // the color the shape swatches show
    let colorsDrawn = null; // the shape (and project color) the color swatches show
    function drawSwatches(next) {
      const { paint, shape, clip } = next.view;
      if (paint !== shapesDrawn) {
        shapesDrawn = paint;
        for (const s of shapeSets) {
          for (const [value, el] of s.group.buttons) {
            const mark = el.firstElementChild;
            mark.style.setProperty("--t3plus-bot-fill", botFillUrl(paint, value));
            mark.style.setProperty("--t3plus-bot-edge", botEdgeColor(paint, value));
          }
        }
      }
      // The "Project" swatch shows what the project gives this bot.
      const project = botPaintColor(next, { color: PROJECT_COLOR });
      const drawn = `${shape}\n${clip}\n${project}`;
      if (drawn === colorsDrawn) return;
      colorsDrawn = drawn;
      for (const [value, el] of colors.buttons) {
        const mark = el.firstElementChild;
        const shown = value === PROJECT_COLOR ? project : value;
        mark.style.setProperty("--t3plus-bot-fill", botFillUrl(shown, shape));
        mark.style.setProperty("--t3plus-bot-edge", botEdgeColor(shown, shape));
        mark.style.setProperty("--t3plus-bot-clip", clip);
      }
    }
    return {
      element,
      update(next) {
        bot = next;
        const { view } = next;
        setAttr(element, "data-bot-key", next.key);
        setText(title, view.label);
        setText(message, next.preview || "No messages yet");
        message.classList.toggle("is-empty", !next.preview);
        setText(meta, next.meta ?? "");
        setHidden(meta, !next.meta);
        // 48px: a blob from its SVG sheet (the drawn ones are made for faces up to 32px).
        applyAvatarVars(face, { ...view, fill: botArt(view.paint, view.shape, view.mood, { vector: true }).url });
        for (const s of shapeSets) s.group.name(view.label);
        colors.name(view.label);
        const shape = view.shape; // the bot's own pick, or the one it was given
        for (const s of shapeSets) s.group.set(shape);
        colors.set(next.prefs.color);
        // Ball shapes (football, basketball) bring their own colors: no color to pick.
        colorField.style.display = botShapeHasOwnColors(shape) ? "none" : "";
        setHidden(colorNote, !botsWearStatus);
        if (botsWearStatus) setAttr(colors.group, "aria-describedby", colorNote.id);
        else colors.group.removeAttribute("aria-describedby");
        drawSwatches(next);
      },
    };
  }

  function createBotEntry(bot) {
    const avatar = h("span", { class: "t3plus-bot-swatch", "aria-hidden": "true" });
    const name = h("span", { class: "t3plus-bot-name" });
    const line = h("span", { class: "t3plus-bot-line" });
    const chip = h("button", { type: "button", class: "t3plus-bot-pick", role: "option", "data-bot-key": bot.key, "aria-selected": "false", "aria-controls": botSlot.id, tabindex: "-1" }, [
      avatar,
      h("span", { class: "t3plus-bot-pick-text" }, [name, line]),
    ]);
    const entry = { chip, avatar, name, line, bot };
    chip.addEventListener("click", () => setOpenBot(bot.key));
    return entry;
  }

  const focusQuietly = (el) => el?.focus({ preventScroll: true });
  // Up and down the list (the ones the search shows), Home and End: picks as it moves.
  botsList.addEventListener("keydown", (e) => {
    if (e.altKey || e.ctrlKey || e.metaKey) return; // T3's (and the system's) with a modifier
    const shown = [...botsList.querySelectorAll(".t3plus-bot-pick:not([hidden])")];
    const at = shown.indexOf(doc.activeElement);
    const to = { ArrowDown: at + 1, ArrowUp: at - 1, Home: 0, End: shown.length - 1 }[e.key];
    if (to === undefined || !shown.length) return;
    e.preventDefault();
    const next = shown[Math.max(0, Math.min(shown.length - 1, to))];
    setOpenBot(next.dataset.botKey);
    focusQuietly(next);
    next.scrollIntoView?.({ block: "nearest" });
  });
  botsSearch.addEventListener("input", () => filterBots());
  botsSearch.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && botsSearch.value) {
      e.preventDefault(); // clears the search, Settings stays open
      botsSearch.value = "";
      filterBots();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      // Into the list: the bot picked, when it shows; else the first that does.
      const first = botsList.querySelector('.t3plus-bot-pick[aria-selected="true"]:not([hidden])') ?? botsList.querySelector(".t3plus-bot-pick:not([hidden])");
      if (first) {
        setOpenBot(first.dataset.botKey);
        focusQuietly(first);
      }
    }
  });
  function filterBots() {
    const q = botsSearch.value.trim().toLowerCase();
    let any = false;
    for (const e of botEntries.values()) {
      const hide = Boolean(q) && !e.bot.view.label.toLowerCase().includes(q);
      setHidden(e.chip, hide);
      any ||= !hide;
    }
    setHidden(botsNone, any || !botEntries.size);
    // The Tab stop is the picked bot; searched out, the first one shown (else none to reach).
    const pickedChip = openBot ? botEntries.get(openBot)?.chip : null;
    const stop = pickedChip && !pickedChip.hidden ? pickedChip : botsList.querySelector(".t3plus-bot-pick:not([hidden])");
    for (const e of botEntries.values()) {
      const want = e.chip === stop ? 0 : -1;
      if (e.chip.tabIndex !== want) e.chip.tabIndex = want;
    }
  }

  function setOpenBot(key) {
    const entry = key ? botEntries.get(key) : null;
    openBot = entry ? key : null;
    for (const [k, e] of botEntries) setAttr(e.chip, "aria-selected", String(k === openBot));
    filterBots(); // the Tab stop (the one picked, unless the search hides it)
    if (!entry) {
      botSlot.replaceChildren();
      return;
    }
    // One for them all: kept per bot ever picked, they held ~145 elements each.
    botEditor ??= createBotEditor();
    botEditor.update(entry.bot);
    if (botSlot.firstElementChild !== botEditor.element) botSlot.replaceChildren(botEditor.element);
  }

  function updateBots(list) {
    const bots = [...list].sort((a, b) => BY_NAME.compare(a.view.label, b.view.label) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    const order = bots.map((b) => b.key);
    setHidden(botsBoth, !bots.length);
    if (order.join("\n") !== botOrder.join("\n")) {
      // Moving an item (a rename re-sorts them) would drop its focus: put it back.
      const focused = botsList.contains(doc.activeElement) ? doc.activeElement : null;
      const focusedKey = focused?.dataset.botKey ?? null;
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
        // Forgotten (or gone): the one now in its place is picked, among those the search
        // shows, and focused if it (or its own item) had the focus.
        const hadFocus = botSlot.contains(doc.activeElement) || (focusedKey !== null && !botEntries.has(focusedKey));
        openBot = null;
        const q = botsSearch.value.trim().toLowerCase();
        const shown = order.filter((k) => !q || botEntries.get(k).bot.view.label.toLowerCase().includes(q));
        const pool = shown.length ? shown : order;
        const next = pool[Math.min(Math.max(pool.indexOf(order[Math.min(Math.max(openIndex, 0), order.length - 1)]), 0), pool.length - 1)] ?? null;
        setOpenBot(next);
        if (hadFocus) focusQuietly(botEntries.get(next)?.chip);
      }
    }
    for (const bot of bots) {
      const entry = botEntries.get(bot.key);
      entry.bot = bot;
      setText(entry.name, bot.view.label);
      setText(entry.line, bot.preview || "");
      // Hover: the name in full, its latest message, and its model and computer.
      const tip = [bot.view.label, bot.preview, bot.meta].filter(Boolean).join("\n");
      if (entry.chip.title !== tip) entry.chip.title = tip;
      applyAvatarVars(entry.avatar, bot.view);
    }
    // Always one picked: the first, until another is.
    if (!openBot && order.length) setOpenBot(order[0]);
    else if (openBot) {
      botEditor?.update(botEntries.get(openBot).bot); // the picked one's details, up to date
      filterBots();
    } else filterBots();
  }

  // ---------- Profiles: an icon and three colors each ----------
  // Pick a profile, then its icon and the colors of its dot and the sidebar's sky: one of
  // the nine (as in the sidebar), or a color of your own. The preview shows them with the
  // profile's own glow (its glow color is a setting: the scope bar above picks the profile).
  const PROFILE_FIELDS = [
    ["color", "Dot", "The dot and its name."],
    ["sky", "Sky", "The sky at the top of the sidebar."],
  ];
  let profiles = null; // { list, active, sky }
  let editing = null; // the profile shown
  let draft = {}; // { field: "#rrggbb" } while a custom color is dragged
  let profilesSignature = "";
  let ppNameShown = ""; // the preview's name as last built (icon and text)
  let ppDotsShown = ""; // and its dots
  let demoNames = false;
  let profileAccents = {}; // each profile's glow color ("theme" or "#rrggbb"), from the app
  let glowOn = true; // the background is the glow (not off, not an image): the preview shows it
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
        const title = value !== "default" ? name : field === "sky" ? "Default (T3's sky)" : name;
        const b = h("button", { type: "button", class: "t3plus-pp-swatch", role: "radio", "data-value": value, "aria-label": name, title });
        if (hex) b.style.setProperty("--t3plus-profile-color", hex);
        b.addEventListener("click", () => setProfile({ [field]: value }));
        return b;
      }));
    rovingRow(swatches);
    // A color of your own: the preview follows while you drag, and it is kept on letting go.
    // Only this card's preview shows a draft (painted here): the app has nothing to redraw
    // for it, and asking it to ran a whole page check on every step of the drag.
    const custom = h("input", { type: "color", class: "t3plus-pp-custom", "aria-label": `Custom ${label.toLowerCase()} color`, title: "Your own color" });
    custom.addEventListener("input", () => {
      draft = { ...draft, [field]: custom.value.toLowerCase() };
      paintProfiles();
    });
    custom.addEventListener("blur", () => {
      if (!(field in draft)) return; // saved by "change" already
      const { [field]: _dropped, ...rest } = draft;
      draft = rest;
      paintProfiles();
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
      description: "Pick an icon and colors for each profile.",
      shared: true,
      extra: h("div", { class: "t3plus-pp-body" }, [
        ppChips,
        ppPreview,
        h("div", { class: "t3plus-pp-row", "data-field": "icon" }, [
          h("div", { class: "t3plus-pp-row-text" }, [h("span", { class: "t3plus-pp-row-title", text: "Icon" }), h("span", { class: "t3plus-pp-row-hint", text: "Shown before its name." })]),
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
    const art = doc.querySelector(T3_SELECTORS.nightSky);
    if (!art) return;
    const copy = art.cloneNode(true);
    copy.removeAttribute("data-stage-art");
    const renamed = new Map(); // T3's id -> the copy's
    for (const el of copy.querySelectorAll("[id]")) {
      renamed.set(el.id, `t3plus-pp-${el.id}`);
      el.id = renamed.get(el.id);
    }
    // Only what points at an id: url(#id) (a gradient, a filter, a clip) and an href of
    // "#id". Replaced as text in anything with a "#", an id like "a" also rewrote a color
    // ("#abcdef" became "#t3plus-pp-abcdef").
    const pointer = (ref) => (renamed.has(ref) ? `#${renamed.get(ref)}` : null);
    const retarget = (attr) => {
      if (attr.localName === "href") return (attr.value.startsWith("#") && pointer(attr.value.slice(1))) || attr.value;
      return attr.value.replace(URL_REF, (whole, open, ref, close) => {
        const to = pointer(ref);
        return to ? `${open}${to}${close}` : whole;
      });
    };
    for (const el of [copy, ...copy.querySelectorAll("*")]) {
      for (const attr of el.attributes) {
        if (!attr.value.includes("#")) continue;
        const value = retarget(attr);
        if (value !== attr.value) attr.value = value;
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
    setHidden(ppRows.sky.row, !profiles.sky);
    for (const [field] of PROFILE_FIELDS) {
      const v = value(field);
      const custom = /^#/.test(v);
      checkIn(ppRows[field].swatches, (el) => !custom && el.dataset.value === v);
      ppRows[field].custom.toggleAttribute("data-checked", custom);
      // Seeded with the color shown, so a custom one starts from it.
      if (doc.activeElement !== ppRows[field].custom) ppRows[field].custom.value = profileHex(v) ?? "#6d7cff";
    }
    // The preview: the name and dots, the sky, the glow. The name and dots are built again
    // only when what they show changes: every update rebuilt them (the icon parsed again).
    const dot = profileHex(value("color"));
    const nameText = demoNames ? `Profile ${index + 1}` : p.name;
    const nameShown = `${p.icon ?? ""}|${nameText}`;
    if (nameShown !== ppNameShown) {
      ppNameShown = nameShown;
      ppName.replaceChildren(h("span", { class: "t3plus-profiles-name-text", text: nameText }));
      if (p.icon) ppName.insertAdjacentHTML("afterbegin", profileIconSvg(p.icon, 11));
    }
    if (dot) ppName.style.setProperty("--t3plus-profile-color", dot);
    else ppName.style.removeProperty("--t3plus-profile-color");
    const dots = profiles.list.map((q) => (q.id === editing ? { hex: dot, on: true } : { hex: profileHex(q.color), on: false }));
    const dotsShown = JSON.stringify(dots);
    if (dotsShown !== ppDotsShown) {
      ppDotsShown = dotsShown;
      ppDots.replaceChildren(
        ...dots.map(({ hex, on }) => {
          const d = h("span", { class: "t3plus-pp-dot", "data-on": on });
          if (hex) d.style.setProperty("--t3plus-profile-color", hex);
          return d;
        }),
      );
    }
    setHidden(ppSky, !profiles.sky);
    if (profiles.sky) {
      ensureSkyArt();
      const turn = actions.profileSkyTurn?.(value("sky")) ?? null;
      ppSky.toggleAttribute("data-tint", turn !== null);
      ppSky.style.setProperty("--t3plus-sky-turn", (turn ?? 0).toFixed(1));
      ppSky.style.setProperty("--t3plus-sky-mix", turn === null ? "0" : "1");
    }
    // The profile's own glow color (with the background off or an image, none shows).
    ppPane.toggleAttribute("data-glow-off", !glowOn);
    const accent = profileAccents[editing] ?? "theme";
    ppPane.style.setProperty("--t3plus-accent", glowColorCss(accent));
  }

  function updateProfiles(next, demo) {
    profiles = next;
    setHidden(profilesCard, !next);
    if (!next) return;
    if (editing !== next.active && !next.list.some((p) => p.id === editing)) {
      // Another profile shown (the first time, or the one shown was deleted): its glow.
      editing = next.active;
      actions.previewProfile?.();
    }
    const signature = JSON.stringify([next.list.map((p) => [p.id, p.name, p.icon ?? null, p.color]), demo]);
    if (signature !== profilesSignature) {
      profilesSignature = signature;
      demoNames = demo;
      // Rebuilt (a name, an icon or a color changed): the focus stays on its chip.
      const focused = ppChips.contains(doc.activeElement) ? doc.activeElement.dataset.profile : null;
      ppChips.replaceChildren(...next.list.map((p, i) => chipFor(p, i)));
      if (focused) ppChips.querySelector(`[data-profile="${focused}"]`)?.focus();
    }
    paintProfiles();
  }

  // ---------- Update ----------
  // A newer t3+ release (updateNotice.js): what is out, the command that updates it (with
  // a Copy button), its notes on GitHub, and a way to hide the card until the next one.
  const updateTitle = h("h3", { class: "t3plus-row-title", id: id("update-title") });
  const updateDesc = h("p", { class: "t3plus-row-desc" });
  const updateNotes = h("a", { class: "t3plus-button t3plus-button-ghost", target: "_blank", rel: "noopener noreferrer", text: "Release notes" });
  let updateShown = null; // the release the card is for
  const updateHide = h("button", { type: "button", class: "t3plus-row-reset t3plus-update-hide", "aria-label": "Hide until the next release", title: "Hide until the next release" });
  updateHide.innerHTML = ICONS.close;
  updateHide.addEventListener("click", () => updateShown && actions.dismissUpdate?.(updateShown));
  const updateCopy = h("button", { type: "button", class: "t3plus-button t3plus-update-copy", text: "Copy" });
  let copiedTimer = null;
  updateCopy.addEventListener("click", () => {
    const win = doc.defaultView;
    Promise.resolve(win?.navigator?.clipboard?.writeText(updateCommand(win)))
      .then(() => {
        setText(updateCopy, "Copied");
        win?.clearTimeout(copiedTimer);
        copiedTimer = win?.setTimeout(() => setText(updateCopy, "Copy"), 1500);
      })
      .catch(() => {});
  });
  const updateCard = h("div", { class: "t3plus-card t3plus-update", role: "region", "aria-labelledby": updateTitle.id, hidden: "" }, [
    h("div", { class: "t3plus-row" }, [
      h("div", { class: "t3plus-row-main" }, [
        h("div", { class: "t3plus-row-text" }, [h("div", { class: "t3plus-row-head" }, [updateTitle]), updateDesc]),
        h("div", { class: "t3plus-row-control" }, [updateNotes, updateHide]),
      ]),
      h("div", { class: "t3plus-update-command" }, [h("code", { text: updateCommand(doc.defaultView) }), updateCopy]),
    ]),
  ]);
  function updateUpdateCard(update) {
    updateShown = update?.latest ?? null;
    setHidden(updateCard, !update);
    if (!update) return;
    setText(updateTitle, `t3+ ${update.latest} is out`);
    setText(updateDesc, update.current ? `You have ${update.current}. Run this in Terminal to update.` : "Run this in Terminal to update.");
    if (update.url) setAttr(updateNotes, "href", update.url);
    setHidden(updateNotes, !update.url);
  }

  const titleId = id("title");
  const section = h("section", { id: T3PLUS.panelId, class: "t3plus-section", "aria-labelledby": titleId }, [
    h("div", { class: "t3plus-section-header" }, [
      h("h2", { class: "t3plus-section-title", id: titleId }, ["t3+", h("span", { class: "t3plus-badge", text: desktop ? "Desktop" : "Extension" })]),
    ]),
    updateCard,
    scopeBar,
    lookCard,
    h("h3", { class: "t3plus-subsection-title", text: "Features" }),
    featuresCard,
    botsCard,
    profilesCard,
    advanced,
    developer,
    changelog,
  ]);

  function update(state) {
    const { settings, image, imageUrl, message } = state;
    updateUpdateCard(state.update ?? null);
    const g = settings.composerGradient;
    setAttr(backgroundToggle, "aria-checked", String(g.enabled));
    for (const [value, input] of Object.entries(modeInputs)) input.checked = g.mode === value;
    setHidden(imageRow, g.mode !== "image");
    // The glow's color has nothing to color under an image.
    setHidden(glow.row, g.mode === "image");
    glow.update(g.accent);
    bubbles.update(settings.chat.bubble);
    profileAccents = state.profileAccents ?? {};
    glowOn = g.enabled && g.mode !== "image";
    updateProfiles(state.profiles ?? null, Boolean(settings.demo?.enabled));
    if (state.scope) paintScope(state.scope);

    const usingUpload = g.imageSource === "upload" && image;
    thumb.style.backgroundImage = imageUrl ? `url("${imageUrl.replace(/"/g, '\\"')}")` : "";
    // The sample's light version, shown by content.css on a light page (an upload has none).
    const lightUrl = !usingUpload && state.imageLightUrl ? `url("${state.imageLightUrl.replace(/"/g, '\\"')}")` : "";
    if (thumb.style.getPropertyValue("--t3plus-thumb-light") !== lightUrl) {
      if (lightUrl) thumb.style.setProperty("--t3plus-thumb-light", lightUrl);
      else thumb.style.removeProperty("--t3plus-thumb-light");
    }
    thumb.toggleAttribute("data-sample-light", Boolean(lightUrl));
    setAttr(sampleButton, "aria-pressed", String(!usingUpload));
    if (removeButton.disabled !== !image) removeButton.disabled = !image;
    // Screenshot mode: a file name can be personal ("passport-scan.png").
    const fileName = settings.demo.enabled ? "your image" : image?.name;
    setText(imageCaption, usingUpload
      ? `Using ${fileName} (${image.width}×${image.height}).`
      : image
        ? `Using the sample; ${fileName} is still saved.`
        : "Using the sample image.");

    intensity.set(g.intensity);
    const look = g.dither ? g.ditherStyle : "smooth";
    for (const [value, input] of Object.entries(lookInputs)) input.checked = look === value;
    for (const [value, input] of Object.entries(ditherSizeInputs)) input.checked = g.ditherSize === value;
    setHidden(ditherSizeRow, !g.dither);
    paintGlowSwatches({ look, size: g.ditherSize, accent: g.accent });

    setAttr(glassToggle, "aria-checked", String(settings.glass.enabled));
    glassStrength.set(settings.glass.strength);
    setHidden(glassStrengthRow, !settings.glass.enabled);

    setAttr(preview, "data-backdrop", g.enabled ? g.mode : "off");
    updatePreviewBots(state.bots ?? [], settings.sidebar);
    setAttr(preview, "data-glass", String(settings.glass.enabled));
    setText(status, settings.demo.enabled && image?.name && message ? message.split(image.name).join("your image") : message);

    // Sidebar
    const problems = state.health ?? [];
    setText(healthText, problems.length ? `Off until t3+ updates: ${problems.map((p) => p.feature).join("; ")}.` : "Everything works with this T3 version.");
    // The parts not found, for a bug report: on hover, not in the words.
    setAttr(healthText, "title", problems.length ? problems.map((p) => `${p.feature}: ${p.missing.join(", ")}`).join("\n") : null);
    healthText.toggleAttribute("data-problem", problems.length > 0);
    setAttr(botsToggle, "aria-checked", String(settings.sidebar.bots));
    setAttr(botsDefaultToggle, "aria-checked", String(settings.sidebar.botsDefault));
    setAttr(profilesToggle, "aria-checked", String(settings.sidebar.profiles));
    for (const [value, input] of Object.entries(botStyleInputs)) input.checked = settings.sidebar.botStyle === value;
    drawStyleFaces();
    setAttr(homeToggle, "aria-checked", String(settings.home.widgets));
    setAttr(statusColorsToggle, "aria-checked", String(settings.sidebar.statusColors));
    setAttr(statusBadgesToggle, "aria-checked", String(settings.sidebar.statusBadges));
    statusColorsSample.update(settings.sidebar.statusColors);
    badgeSample.update(settings.sidebar.statusBadges);
    subagentSample.update({ shape: settings.sidebar.subagentShape, color: settings.sidebar.subagentColor });
    subagentShapePick.set(subagentShapeOptions(settings.sidebar.subagentColor), settings.sidebar.subagentShape);
    subagentColorPick.set(SUBAGENT_COLOR_OPTIONS, settings.sidebar.subagentColor);
    setAttr(demoToggle, "aria-checked", String(settings.demo.enabled));
    // Bots
    const bots = state.bots ?? [];
    const marker = state.botMarker;
    setText(botsEmpty, bots.length
      ? ""
      : `No bots yet. Start a thread's title with ${marker}.`);
    setHidden(botsEmpty, bots.length > 0);
    botsWearStatus = settings.sidebar.statusColors;
    updateBots(bots);
    setText(botStatus, state.botMessage);
  }

  return {
    element: section,
    update,
    /** The glow color of the profile the Profiles card shows ("theme" or "#rrggbb"), or null. */
    profilePreviewAccent: () => (profiles && !profilesCard.hidden ? (profileAccents[editing] ?? null) : null),
    /**
     * Leaving Settings (or t3+ stopping): an open menu closes, with its listener on the
     * document; the search is cleared (it opens on the whole list next time), and the
     * preview's faces are drawn anew on the way back (the sprite clock let go of them).
     */
    leave: () => {
      for (const pick of [profilePick, devicePick, subagentShapePick, subagentColorPick]) pick.close();
      previewBotsSignature = "";
      if (!botsSearch.value) return;
      botsSearch.value = "";
      filterBots();
    },
  };
}
