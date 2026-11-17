import { STORAGE_KEYS, T3PLUS, T3_SELECTORS } from "./config.js";

// Profiles, like Dia's (or Arc's spaces): each one shows a set of the sidebar's
// project folders. A row of small dots at the bottom of the sidebar says which
// one is open: click a dot, or swipe sideways with two fingers on the sidebar,
// to switch. Drag a project folder's header and the dots open into named
// chips: drop it on one to move the project there, or on "New" to start a new
// profile with it. Right-click (or double-click) a dot to rename or delete it.
// Everything is local to t3+: T3's projects and folders are only hidden or shown.
//
// Ctrl+Shift+1..9 opens profile 1..9. Each profile has a color, shown on its dot only.
//
// Stored (STORAGE_KEYS.profiles): { active, list: [{ id, name, color }], projects: { projectKey: profileId } }.
// A project nobody moved belongs to the first profile.

const FOLDER_PREFIX = "folder:";
const MAX_PROFILES = 9;
const SWIPE_PX = 70;
/** Dot colors. "default" is T3's foreground (the dots' plain white/gray). */
export const PROFILE_COLORS = Object.freeze({
  default: null,
  blue: "#3b82f6",
  purple: "#8b5cf6",
  pink: "#ec4899",
  red: "#ef4444",
  orange: "#f97316",
  yellow: "#eab308",
  green: "#22c55e",
  teal: "#14b8a6",
});
const COLOR_ORDER = ["default", "blue", "purple", "green", "orange", "pink", "teal", "yellow", "red"];

export function normalizeProfiles(raw) {
  const value = raw && typeof raw === "object" ? raw : {};
  const list = (Array.isArray(value.list) ? value.list : [])
    .filter((p) => p && typeof p.id === "string" && /^[a-z0-9-]{1,40}$/i.test(p.id))
    .slice(0, MAX_PROFILES)
    .map((p, i) => ({
      id: p.id,
      name: String(p.name ?? "").replace(/\s+/g, " ").trim().slice(0, 32) || "Profile",
      color: Object.hasOwn(PROFILE_COLORS, p.color ?? "") ? p.color : COLOR_ORDER[i % COLOR_ORDER.length],
    }));
  if (!list.length) list.push({ id: "main", name: "Main", color: "default" });
  const ids = new Set(list.map((p) => p.id));
  const projects = {};
  for (const [key, id] of Object.entries(value.projects && typeof value.projects === "object" ? value.projects : {}).slice(0, 500)) {
    if (typeof key === "string" && key.length <= 400 && ids.has(id) && id !== list[0].id) projects[key] = id;
  }
  return { active: ids.has(value.active) ? value.active : list[0].id, list, projects };
}

/** The profile a project folder belongs to. */
export function profileOf(state, projectKey) {
  return state.projects[projectKey] ?? state.list[0].id;
}

export function createProfiles({ win, doc, area, changedEvent, isEnabled = () => true }) {
  let state = normalizeProfiles(null);
  let loaded = false;
  const key = STORAGE_KEYS.profiles;

  async function load() {
    state = normalizeProfiles((await area.get(key))?.[key]);
    loaded = true;
    sync();
  }
  let saving = Promise.resolve();
  function save(next) {
    state = normalizeProfiles(next);
    sync();
    saving = saving.catch(() => {}).then(() => area.set({ [key]: state }));
    return saving;
  }
  const onChanged = (changes, areaName) => {
    if (areaName && areaName !== "local") return;
    if (!changes?.[key]) return;
    state = normalizeProfiles(changes[key].newValue);
    sync();
  };

  // ---------- The dots ----------
  const bar = doc.createElement("div");
  bar.className = "t3plus-profiles";
  bar.setAttribute(T3PLUS.ownedAttr, "");
  bar.setAttribute("role", "tablist");
  bar.setAttribute("aria-label", "t3+ profiles");
  const name = doc.createElement("div");
  name.className = "t3plus-profiles-name";
  name.setAttribute(T3PLUS.ownedAttr, "");
  name.setAttribute("aria-hidden", "true");
  const dots = doc.createElement("div");
  dots.className = "t3plus-profiles-dots";
  bar.append(name, dots);
  let dotsSignature = "";

  function renderDots() {
    const signature = JSON.stringify([state.list, state.active, dragging ? 1 : 0]);
    if (signature === dotsSignature) return;
    dotsSignature = signature;
    dots.replaceChildren();
    for (const [i, p] of state.list.entries()) {
      const dot = doc.createElement("button");
      dot.type = "button";
      dot.className = "t3plus-profile-dot";
      dot.setAttribute(T3PLUS.ownedAttr, "");
      dot.setAttribute("role", "tab");
      dot.setAttribute("aria-selected", String(p.id === state.active));
      dot.setAttribute("aria-label", `${p.name} (profile ${i + 1})`);
      dot.title = i < 9 ? `${p.name}  ⌃⇧${i + 1}` : p.name;
      dot.dataset.profile = p.id;
      if (PROFILE_COLORS[p.color]) dot.style.setProperty("--t3plus-profile-color", PROFILE_COLORS[p.color]);
      const label = doc.createElement("span");
      label.className = "t3plus-profile-chip";
      label.textContent = p.name;
      dot.append(label);
      dots.append(dot);
    }
    if (state.list.length < MAX_PROFILES) {
      const add = doc.createElement("button");
      add.type = "button";
      add.className = "t3plus-profile-dot t3plus-profile-add";
      add.setAttribute(T3PLUS.ownedAttr, "");
      add.setAttribute("aria-label", "New profile");
      add.title = "New profile";
      add.dataset.profile = "+new";
      const label = doc.createElement("span");
      label.className = "t3plus-profile-chip";
      label.textContent = "New";
      add.append(label);
      dots.append(add);
    }
  }

  let nameTimer = null;
  function flashName() {
    name.textContent = state.list.find((p) => p.id === state.active)?.name ?? "";
    name.setAttribute("data-show", "");
    win.clearTimeout(nameTimer);
    nameTimer = win.setTimeout(() => name.removeAttribute("data-show"), 900);
  }

  function nextColor(list) {
    const used = new Set(list.map((p) => p.color));
    return COLOR_ORDER.find((c) => !used.has(c)) ?? COLOR_ORDER[list.length % COLOR_ORDER.length];
  }

  function newProfileId() {
    let id;
    do id = `p${Math.random().toString(36).slice(2, 8)}`;
    while (state.list.some((p) => p.id === id));
    return id;
  }

  function switchTo(id, direction = 0) {
    if (id === state.active || !state.list.some((p) => p.id === id)) return;
    const from = state.list.findIndex((p) => p.id === state.active);
    const to = state.list.findIndex((p) => p.id === id);
    transition(direction || Math.sign(to - from), () => {
      save({ ...state, active: id });
      flashName();
    });
  }

  function step(delta) {
    const i = state.list.findIndex((p) => p.id === state.active);
    const next = state.list[i + delta];
    if (next) switchTo(next.id, delta);
  }

  // The folder list slides in from the side it came from (compositor only).
  // Switching: the folder list slides out toward the side it is leaving and
  // fades, the folders swap while it is invisible, then the new set slides in
  // from the other side. Transform and opacity only (compositor), so it stays
  // smooth; a switch during one finishes it at once and starts its own.
  let swapping = null; // { out, done }
  function transition(direction, apply) {
    const list = folderList();
    if (swapping) swapping.done(false); // a switch during one: finish that one now
    if (!list?.animate || !direction || win.matchMedia?.("(prefers-reduced-motion: reduce)").matches) {
      apply();
      return;
    }
    const shift = 12;
    const out = list.animate(
      [
        { transform: "none", opacity: 1 },
        { transform: `translateX(${-direction * shift}px)`, opacity: 0 },
      ],
      { duration: 110, easing: "cubic-bezier(0.4, 0, 1, 1)", fill: "forwards" },
    );
    let timer = null;
    const current = {
      out,
      done(animateIn = true) {
        if (swapping !== current) return;
        swapping = null;
        win.clearTimeout(timer);
        apply();
        out.cancel();
        if (animateIn) {
          list.animate(
            [
              { transform: `translateX(${direction * shift}px)`, opacity: 0 },
              { transform: "none", opacity: 1 },
            ],
            { duration: 200, easing: "cubic-bezier(0.22, 1, 0.36, 1)" },
          );
        }
      },
    };
    swapping = current;
    out.onfinish = () => current.done();
    // The finish event needs the page to be painting; the switch must happen regardless.
    timer = win.setTimeout(() => current.done(), 160);
  }

  // ---------- Rename / delete (right-click or double-click a dot) ----------
  let editor = null;
  function closeEditor() {
    editor?.remove();
    editor = null;
  }
  function openEditor(id) {
    closeEditor();
    const profile = state.list.find((p) => p.id === id);
    if (!profile) return;
    editor = doc.createElement("div");
    editor.className = "t3plus-profile-editor";
    editor.setAttribute(T3PLUS.ownedAttr, "");
    const input = doc.createElement("input");
    input.type = "text";
    input.value = profile.name;
    input.maxLength = 32;
    input.setAttribute("aria-label", "Profile name");
    const remove = doc.createElement("button");
    remove.type = "button";
    remove.className = "t3plus-profile-delete";
    remove.setAttribute("aria-label", "Delete profile");
    // lucide "trash-2", T3's icon set.
    remove.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/><line x1="10" x2="10" y1="11" y2="17"/><line x1="14" x2="14" y1="11" y2="17"/></svg>';
    // The first profile holds every project nobody moved: it cannot be deleted.
    const isFirst = state.list[0].id === id;
    remove.title = `Delete (its projects move to ${state.list[0].name})`;
    const commit = () => {
      const value = input.value.trim();
      if (value && value !== profile.name) save({ ...state, list: state.list.map((p) => (p.id === id ? { ...p, name: value } : p)) });
      closeEditor();
    };
    input.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Enter") commit();
      if (e.key === "Escape") closeEditor();
    });
    input.addEventListener("blur", () => win.setTimeout(() => editor && !editor.contains(doc.activeElement) && commit(), 0));
    remove.addEventListener("click", () => {
      if (state.list[0].id === id) return;
      const list = state.list.filter((p) => p.id !== id);
      // Its projects go back to the first profile.
      const projects = Object.fromEntries(Object.entries(state.projects).filter(([, pid]) => pid !== id));
      save({ list, projects, active: state.active === id ? list[0].id : state.active });
      closeEditor();
    });
    const swatches = doc.createElement("div");
    swatches.className = "t3plus-profile-colors";
    swatches.setAttribute("role", "radiogroup");
    swatches.setAttribute("aria-label", "Dot color");
    for (const [color, hex] of Object.entries(PROFILE_COLORS)) {
      const swatch = doc.createElement("button");
      swatch.type = "button";
      swatch.className = "t3plus-profile-swatch";
      swatch.setAttribute("role", "radio");
      swatch.setAttribute("aria-checked", String(profile.color === color));
      swatch.setAttribute("aria-label", color === "default" ? "Default" : color[0].toUpperCase() + color.slice(1));
      swatch.title = swatch.getAttribute("aria-label");
      if (hex) swatch.style.setProperty("--t3plus-profile-color", hex);
      // Keep the name field's focus (and its pending rename) while picking a color.
      swatch.addEventListener("pointerdown", (e) => e.preventDefault());
      swatch.addEventListener("click", () => {
        profile.color = color;
        save({ ...state, list: state.list.map((p) => (p.id === id ? { ...p, color } : p)) });
        for (const el of swatches.children) el.setAttribute("aria-checked", String(el === swatch));
        input.focus();
      });
      swatches.append(swatch);
    }
    const row = doc.createElement("div");
    row.className = "t3plus-profile-editor-row";
    row.append(input);
    if (!isFirst) row.append(remove);
    editor.append(row, swatches);
    bar.append(editor);
    input.focus();
    input.select();
  }
  dots.addEventListener("click", (event) => {
    const dot = event.target.closest?.(".t3plus-profile-dot");
    if (!dot) return;
    if (dot.dataset.profile === "+new") {
      const id = newProfileId();
      const list = [...state.list, { id, name: String(state.list.length + 1), color: nextColor(state.list) }];
      transition(1, () => {
        save({ ...state, list, active: id });
        flashName();
        openEditor(id);
      });
      return;
    }
    switchTo(dot.dataset.profile);
  });
  dots.addEventListener("dblclick", (event) => {
    const dot = event.target.closest?.(".t3plus-profile-dot");
    if (dot && dot.dataset.profile !== "+new") openEditor(dot.dataset.profile);
  });
  dots.addEventListener("contextmenu", (event) => {
    const dot = event.target.closest?.(".t3plus-profile-dot");
    if (!dot || dot.dataset.profile === "+new") return;
    event.preventDefault();
    openEditor(dot.dataset.profile);
  });

  // ---------- Swipe (two-finger horizontal scroll on the sidebar) ----------
  let swipeX = 0;
  let swipeLock = false;
  let swipeTimer = null;
  function onWheel(event) {
    if (!isEnabled() || state.list.length < 2) return;
    const inner = event.target.closest?.(T3_SELECTORS.sidebarInner);
    if (!inner) return;
    if (Math.abs(event.deltaX) <= Math.abs(event.deltaY) * 1.2) return;
    event.preventDefault();
    win.clearTimeout(swipeTimer);
    // One switch per gesture: the lock lasts until the fingers (and the momentum) stop.
    swipeTimer = win.setTimeout(() => {
      swipeX = 0;
      swipeLock = false;
    }, 220);
    if (swipeLock) return;
    swipeX += event.deltaX;
    if (Math.abs(swipeX) >= SWIPE_PX) {
      swipeLock = true;
      step(swipeX > 0 ? 1 : -1);
      swipeX = 0;
    }
  }

  // ---------- Drag a folder onto a profile ----------
  let pending = null; // { x, y, project, title, header }
  let dragging = null; // { project, ghost }
  let swallowClick = false;
  function onPointerDown(event) {
    if (!isEnabled() || event.button !== 0 || event.altKey || event.metaKey || event.ctrlKey) return;
    const header = event.target.closest?.(`[data-sidebar-row^="${FOLDER_PREFIX}"]`);
    if (!header || header.closest(`[${T3PLUS.ownedAttr}]`)) return;
    const project = header.getAttribute("data-sidebar-row").slice(FOLDER_PREFIX.length);
    const title = (header.querySelector(".truncate")?.textContent || header.textContent || "Project").trim().slice(0, 40);
    pending = { x: event.clientX, y: event.clientY, project, title };
  }
  function onPointerMove(event) {
    if (dragging) {
      dragging.ghost.style.transform = `translate(${event.clientX + 12}px, ${event.clientY + 10}px)`;
      const over = doc.elementFromPoint(event.clientX, event.clientY)?.closest?.(".t3plus-profile-dot");
      for (const dot of dots.children) dot.toggleAttribute("data-over", dot === over);
      return;
    }
    if (!pending || (event.buttons & 1) === 0) {
      pending = null;
      return;
    }
    if (Math.hypot(event.clientX - pending.x, event.clientY - pending.y) < 6) return;
    const ghost = doc.createElement("div");
    ghost.className = "t3plus-profile-ghost";
    ghost.setAttribute(T3PLUS.ownedAttr, "");
    ghost.textContent = pending.title;
    ghost.style.transform = `translate(${event.clientX + 12}px, ${event.clientY + 10}px)`;
    doc.body.append(ghost);
    dragging = { project: pending.project, ghost };
    pending = null;
    doc.documentElement.setAttribute("data-t3plus-profile-drag", "");
    dotsSignature = "";
    renderDots();
  }
  function endDrag(event, drop) {
    if (!dragging) {
      pending = null;
      return;
    }
    const { project, ghost } = dragging;
    dragging = null;
    ghost.remove();
    doc.documentElement.removeAttribute("data-t3plus-profile-drag");
    // The pointerup ends T3's click on the header: keep it from toggling the folder.
    swallowClick = true;
    win.setTimeout(() => (swallowClick = false), 0);
    const target = drop ? doc.elementFromPoint(event.clientX, event.clientY)?.closest?.(".t3plus-profile-dot") : null;
    dotsSignature = "";
    if (!target) {
      renderDots();
      return;
    }
    let id = target.dataset.profile;
    let list = state.list;
    if (id === "+new") {
      id = newProfileId();
      list = [...list, { id, name: String(list.length + 1), color: nextColor(list) }];
    }
    const projects = { ...state.projects };
    if (id === list[0].id) delete projects[project];
    else projects[project] = id;
    save({ ...state, list, projects });
    if (target.dataset.profile === "+new") openEditor(id);
  }
  const onPointerUp = (event) => endDrag(event, true);
  const onKeyDown = (event) => {
    if (event.key === "Escape" && dragging) endDrag(event, false);
    // Ctrl+Shift+1..9: open that profile. Cmd+digit stays T3's.
    if (!isEnabled() || !event.ctrlKey || !event.shiftKey || event.metaKey || event.altKey) return;
    const n = /^Digit([1-9])$/.exec(event.code)?.[1];
    const target = n && state.list[Number(n) - 1];
    if (!target) return;
    event.preventDefault();
    event.stopPropagation();
    const from = state.list.findIndex((p) => p.id === state.active);
    switchTo(target.id, Math.sign(Number(n) - 1 - from));
  };
  const onClick = (event) => {
    if (!swallowClick) return;
    swallowClick = false;
    event.preventDefault();
    event.stopPropagation();
  };

  // ---------- Applying it to T3's sidebar ----------
  function folderList() {
    const inner = doc.querySelector(T3_SELECTORS.sidebarInner);
    return inner?.querySelector(T3_SELECTORS.projectFolderItem)?.parentElement ?? null;
  }

  function sync() {
    const on = isEnabled() && loaded;
    const inner = doc.querySelector(T3_SELECTORS.sidebarInner);
    const footer = inner?.querySelector('[data-slot="sidebar-footer"]') ?? inner?.querySelector('[data-sidebar="footer"]');
    if (!on || !footer) {
      if (bar.isConnected) bar.remove();
      for (const el of doc.querySelectorAll("[data-t3plus-profile-off]")) el.removeAttribute("data-t3plus-profile-off");
      return;
    }
    if (bar.parentElement !== footer || footer.firstElementChild !== bar) footer.prepend(bar);
    renderDots();
    const hide = (el, off) => {
      if (el.hasAttribute("data-t3plus-profile-off") !== off) el.toggleAttribute("data-t3plus-profile-off", off);
    };
    for (const folder of inner.querySelectorAll(T3_SELECTORS.projectFolderItem)) {
      const header = folder.querySelector(`[data-sidebar-row^="${FOLDER_PREFIX}"]`);
      if (header) hide(folder, profileOf(state, header.getAttribute("data-sidebar-row").slice(FOLDER_PREFIX.length)) !== state.active);
    }
    // A folder's threads are its next siblings, not its children: each row names
    // its folder in data-sidebar-parent. Pinned and settled threads stay everywhere.
    for (const item of inner.querySelectorAll(T3_SELECTORS.threadItem)) {
      const parent = item.querySelector("[data-sidebar-parent]")?.getAttribute("data-sidebar-parent") ?? "";
      hide(item, parent.startsWith(FOLDER_PREFIX) && profileOf(state, parent.slice(FOLDER_PREFIX.length)) !== state.active);
    }
  }

  return {
    sync,
    get state() {
      return state;
    },
    start() {
      changedEvent?.addListener?.(onChanged);
      doc.addEventListener("wheel", onWheel, { capture: true, passive: false });
      doc.addEventListener("pointerdown", onPointerDown, true);
      doc.addEventListener("pointermove", onPointerMove, true);
      doc.addEventListener("pointerup", onPointerUp, true);
      doc.addEventListener("pointercancel", onPointerUp, true);
      doc.addEventListener("keydown", onKeyDown, true);
      doc.addEventListener("click", onClick, true);
      return load();
    },
    stop() {
      changedEvent?.removeListener?.(onChanged);
      doc.removeEventListener("wheel", onWheel, { capture: true });
      doc.removeEventListener("pointerdown", onPointerDown, true);
      doc.removeEventListener("pointermove", onPointerMove, true);
      doc.removeEventListener("pointerup", onPointerUp, true);
      doc.removeEventListener("pointercancel", onPointerUp, true);
      doc.removeEventListener("keydown", onKeyDown, true);
      doc.removeEventListener("click", onClick, true);
      win.clearTimeout(nameTimer);
      win.clearTimeout(swipeTimer);
      dragging?.ghost.remove();
      dragging = null;
      closeEditor();
      loaded = false;
      sync();
    },
    /** For tests and the settings panel. */
    switchTo,
    save,
  };
}
