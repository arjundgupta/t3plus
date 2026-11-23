// T3's thread shortcuts, kept to the open profile. T3 jumps to the Nth thread
// (thread.jump.1-9, Cmd+1-9) and steps to the next or previous one (thread.previous /
// thread.next, Cmd+Shift+[ and ]) through its whole list, the rows of other profiles that
// t3+ hides included: Cmd+1 could open another profile's thread. With profiles on, t3+
// runs these keys itself over the open profile's threads, and T3, which skips a key
// already handled (defaultPrevented), does nothing. The ⌘ hints T3 shows while the key is
// held are numbered the same way.
//
// Which command a key runs is decided as T3 decides it (packages/shared/src/keybindings.ts,
// keybindingMatching.ts and apps/web/src/keybindings.ts, mirrored here): T3's defaults for
// these commands, the user's keybindings.json over them (any command: a rule for another
// command on the same key wins over the jump, as in T3), the last matching rule wins, and
// `when` clauses count.

const MAX_RULES = 256; // T3's MAX_KEYBINDINGS_COUNT
const MAX_WHEN_DEPTH = 64; // T3's MAX_WHEN_EXPRESSION_DEPTH
const MAX_KEY_LENGTH = 64; // T3's MAX_KEYBINDING_VALUE_LENGTH (after trimming)
const MAX_WHEN_LENGTH = 256; // T3's MAX_KEYBINDING_WHEN_LENGTH

// The commands T3 knows (packages/contracts/src/keybindings.ts): T3 drops a rule for any
// other, so it shadows nothing (else a typo on Cmd+1 would make t3+ let the key go, and T3
// jump over every profile).
const n9 = (prefix) => Array.from({ length: 9 }, (_, i) => `${prefix}.${i + 1}`);
const KNOWN_COMMANDS = new Set([
  "workspace.focusNext", "workspace.focusPrevious", "sidebar.toggle", "navigation.back", "navigation.forward",
  "terminal.toggle", "terminal.split", "terminal.splitVertical", "terminal.new", "terminal.close",
  "rightPanel.toggle", "rightPanel.new", "threadPanel.toggle", "rightPanel.toggleMaximized", "rightPanel.close",
  "view.reopenClosed", "pullRequest.copyNumber", "diff.toggle", "preview.toggle", "preview.refresh", "preview.focusUrl",
  "preview.zoomIn", "preview.zoomOut", "preview.resetZoom", "preview.find", "commandPalette.toggle", "filePicker.toggle",
  "projectSearch.toggle", "usage.open", "theme.select", "appearance.cycle", "themeEditor.toggle", "composer.stash",
  "composer.sendAlternate", "composer.sendBackground", "composer.sendAndNewThread", "composer.dictation", "composer.host",
  "composer.cycleHost", "composer.effort", "composer.increaseEffort", "composer.decreaseEffort", "composer.mode",
  "composer.workspace", "composer.previousWorktree", "composer.branch", "chat.new", "chat.newLocal", "chat.newWithoutProject",
  "chat.find", "editor.openFavorite", "usage.cost", "usage.tokens", "usage.limits", "usage.period.day", "usage.period.week",
  "usage.period.month", "usage.period.quarter", "modelPicker.toggle", "modelPicker.previousProvider", "modelPicker.nextProvider",
  ...n9("modelPicker.jump"), "thread.stop", "thread.steerQueuedMessage", "thread.editQueuedMessage", "thread.previous",
  "thread.next", "thread.copyReference", "thread.settle", "thread.pin", "thread.regenerateTitle", "thread.undo", ...n9("thread.jump"),
]);
const knownCommand = (command) => KNOWN_COMMANDS.has(command) || /^script\.[a-z0-9][a-z0-9-]{0,23}\.run$/.test(command);

/** T3's own rules for these commands. */
export const DEFAULT_THREAD_RULES = Object.freeze([
  { key: "mod+shift+[", command: "thread.previous" },
  { key: "mod+shift+]", command: "thread.next" },
  ...Array.from({ length: 9 }, (_, i) => ({ key: `mod+${i + 1}`, command: `thread.jump.${i + 1}`, when: "!modelPickerOpen && isDesktop" })),
]);

export const isThreadCommand = (command) => /^thread\.(jump\.[1-9]|previous|next)$/.test(command ?? "");

// ---------- Parsing (T3's parseKeybindingShortcut, parseKeybindingWhenExpression) ----------

/** "mod+shift+[" -> { key: "[", metaKey, ctrlKey, shiftKey, altKey, modKey }, or null as T3 rejects it. */
export function parseShortcut(value) {
  const tokens = String(value).toLowerCase().split("+").map((t) => t.trim());
  let trailing = 0;
  while (tokens[tokens.length - 1] === "") {
    trailing += 1;
    tokens.pop();
  }
  if (trailing > 0) tokens.push("+"); // "mod+" and "mod++" both mean Cmd and the + key
  if (!tokens.length || tokens.some((t) => t.length === 0)) return null;
  const s = { key: null, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, modKey: false };
  for (const token of tokens) {
    if (token === "cmd" || token === "meta") s.metaKey = true;
    else if (token === "ctrl" || token === "control") s.ctrlKey = true;
    else if (token === "shift") s.shiftKey = true;
    else if (token === "alt" || token === "option") s.altKey = true;
    else if (token === "mod") s.modKey = true;
    else {
      if (s.key !== null) return null;
      s.key = token === "space" ? " " : token === "esc" ? "escape" : token;
    }
  }
  return s.key === null ? null : s;
}

/** A `when` expression as a tree, or null when T3 would reject it. */
export function parseWhen(expression) {
  const tokens = [];
  const text = String(expression);
  for (let i = 0; i < text.length; ) {
    const c = text[i];
    if (/\s/.test(c)) i += 1;
    else if (text.startsWith("&&", i)) (tokens.push({ type: "and" }), (i += 2));
    else if (text.startsWith("||", i)) (tokens.push({ type: "or" }), (i += 2));
    else if (c === "!") (tokens.push({ type: "not" }), (i += 1));
    else if (c === "(") (tokens.push({ type: "lparen" }), (i += 1));
    else if (c === ")") (tokens.push({ type: "rparen" }), (i += 1));
    else {
      const id = /^[A-Za-z_][A-Za-z0-9_.-]*/.exec(text.slice(i));
      if (!id) return null;
      tokens.push({ type: "identifier", value: id[0] });
      i += id[0].length;
    }
  }
  if (!tokens.length) return null;
  let at = 0;
  const primary = (depth) => {
    if (depth > MAX_WHEN_DEPTH) return null;
    const t = tokens[at];
    if (!t) return null;
    if (t.type === "identifier") {
      at += 1;
      return { type: "identifier", name: t.value };
    }
    if (t.type === "lparen") {
      at += 1;
      const node = or(depth + 1);
      if (!node || tokens[at]?.type !== "rparen") return null;
      at += 1;
      return node;
    }
    return null;
  };
  const unary = (depth) => {
    let nots = 0;
    while (tokens[at]?.type === "not") {
      at += 1;
      if (++nots > MAX_WHEN_DEPTH) return null;
    }
    let node = primary(depth);
    if (!node) return null;
    while (nots-- > 0) node = { type: "not", node };
    return node;
  };
  const and = (depth) => {
    let left = unary(depth);
    while (left && tokens[at]?.type === "and") {
      at += 1;
      const right = unary(depth);
      left = right ? { type: "and", left, right } : null;
    }
    return left;
  };
  const or = (depth) => {
    let left = and(depth);
    while (left && tokens[at]?.type === "or") {
      at += 1;
      const right = and(depth);
      left = right ? { type: "or", left, right } : null;
    }
    return left;
  };
  const tree = or(0);
  return tree && at === tokens.length ? tree : null;
}

function evaluate(node, context) {
  if (node.type === "identifier") return node.name === "true" ? true : node.name === "false" ? false : Boolean(context[node.name]);
  if (node.type === "not") return !evaluate(node.node, context);
  if (node.type === "and") return evaluate(node.left, context) && evaluate(node.right, context);
  return evaluate(node.left, context) || evaluate(node.right, context);
}

function compile(rule) {
  if (!rule || typeof rule.key !== "string" || typeof rule.command !== "string" || !knownCommand(rule.command)) return null;
  const key = rule.key.trim();
  if (!key || key.length > MAX_KEY_LENGTH) return null;
  const shortcut = parseShortcut(key);
  if (!shortcut) return null;
  let when = null;
  if (rule.when !== undefined && rule.when !== null) {
    if (typeof rule.when !== "string") return null;
    const text = rule.when.trim();
    if (!text || text.length > MAX_WHEN_LENGTH) return null;
    when = parseWhen(text);
    if (!when) return null;
  }
  return { command: rule.command, shortcut, when };
}

/**
 * The rules in force, as T3 merges them: its defaults (here, those of the thread
 * commands) for every command the user's file has no valid rule for, then the user's.
 * `fromFile`: the file's rules (any command), or null without a file.
 */
export function resolveRules(fromFile) {
  const custom = Array.isArray(fromFile) ? fromFile.map(compile).filter(Boolean).slice(-MAX_RULES) : [];
  const defaults = DEFAULT_THREAD_RULES.map(compile);
  if (!custom.length) return defaults;
  const overridden = new Set(custom.map((r) => r.command));
  return [...defaults.filter((r) => !overridden.has(r.command)), ...custom].slice(-MAX_RULES);
}

// ---------- Matching (T3's matchesKeybindingShortcut) ----------

const CODE_KEYS = {
  Backquote: "`", Backslash: "\\", BracketLeft: "[", BracketRight: "]", Comma: ",", Equal: "=", Minus: "-", Period: ".", Quote: "'", Semicolon: ";", Slash: "/",
  ...Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`Digit${i}`, String(i)])),
};
// macOS US layout Option+letter glyphs (Option+P types "π").
const MAC_OPTION_LETTERS = new Map(Object.entries({ "å": "a", "∫": "b", "ç": "c", "∂": "d", "ƒ": "f", "©": "g", "˙": "h", "∆": "j", "˚": "k", "¬": "l", "µ": "m", "ø": "o", "π": "p", "œ": "q", "®": "r", "ß": "s", "†": "t", "√": "v", "∑": "w", "≈": "x", "¥": "y", "Ω": "z" }));
const normalizeKey = (key) => {
  const k = String(key ?? "").toLowerCase();
  return k === "esc" ? "escape" : k;
};
function shortcutKey(event) {
  const layoutKey = normalizeKey(event.key);
  if (/^[a-z]$/.test(layoutKey)) return layoutKey;
  const optionLetter = event.altKey ? MAC_OPTION_LETTERS.get(event.key) : undefined;
  if (optionLetter && event.code === `Key${optionLetter.toUpperCase()}`) return optionLetter;
  if (layoutKey === "+" && !event.shiftKey && !event.altKey && !String(event.code ?? "").startsWith("Digit")) return layoutKey;
  return (event.code && CODE_KEYS[event.code]) ?? layoutKey;
}
function eventKeys(event) {
  const keys = new Set([normalizeKey(event.key)]);
  const letter = /^Key([A-Z])$/.exec(String(event.code ?? ""))?.[1];
  const key = shortcutKey(event);
  if (letter && !/^[a-z]$/.test(key)) keys.add(letter.toLowerCase());
  keys.add(key);
  return keys;
}
export const isMac = (platform) => /mac|iphone|ipad|ipod/i.test(String(platform ?? ""));
function matches(event, s, mac) {
  if (!mac && event.getModifierState?.("AltGraph") && !/^[a-z0-9]$/i.test(event.key)) return false;
  const meta = s.metaKey || (s.modKey && mac);
  const ctrl = s.ctrlKey || (s.modKey && !mac);
  if (Boolean(event.metaKey) !== meta || Boolean(event.ctrlKey) !== ctrl) return false;
  if (Boolean(event.shiftKey) !== s.shiftKey || Boolean(event.altKey) !== s.altKey) return false;
  return eventKeys(event).has(s.key);
}

/** The command T3 runs for `event` (the last matching rule whose `when` holds), or null. */
export function commandFor(event, rules, mac, context) {
  for (let i = rules.length - 1; i >= 0; i -= 1) {
    const r = rules[i];
    if (r.when && !evaluate(r.when, context)) continue;
    if (matches(event, r.shortcut, mac)) return r.command;
  }
  return null;
}

// ---------- Labels (T3's formatShortcutLabel, the hint on each row) ----------

function keyLabel(key) {
  if (key === " ") return "Space";
  if (key.length === 1) return key.toUpperCase();
  const named = { escape: "Esc", arrowup: "Up", arrowdown: "Down", arrowleft: "Left", arrowright: "Right", pageup: "PageUp", pagedown: "PageDown" };
  return named[key] ?? key.slice(0, 1).toUpperCase() + key.slice(1);
}
export function formatShortcut(s, mac) {
  const meta = s.metaKey || (s.modKey && mac);
  const ctrl = s.ctrlKey || (s.modKey && !mac);
  if (mac) return `${ctrl ? "⌃" : ""}${s.altKey ? "⌥" : ""}${s.shiftKey ? "⇧" : ""}${meta ? "⌘" : ""}${keyLabel(s.key)}`;
  return [ctrl && "Ctrl", s.altKey && "Alt", s.shiftKey && "Shift", meta && "Meta", keyLabel(s.key)].filter(Boolean).join("+");
}
/**
 * The label T3 would give `command` (its effective shortcut: the last rule whose `when`
 * holds and whose key no later rule in force claims), or null when it has none.
 */
export function labelFor(command, rules, mac, context) {
  const claimed = new Set();
  for (let i = rules.length - 1; i >= 0; i -= 1) {
    const r = rules[i];
    if (r.when && !evaluate(r.when, context)) continue;
    const s = r.shortcut;
    const conflict = [s.key, s.metaKey || (s.modKey && mac), s.ctrlKey || (s.modKey && !mac), s.shiftKey, s.altKey].join("|");
    if (claimed.has(conflict)) continue;
    claimed.add(conflict);
    if (r.command === command) return formatShortcut(s, mac);
  }
  return null;
}

// ---------- Where a key goes ----------

/**
 * The thread `command` goes to among the profile's threads (their keys, in list order),
 * from `current` (the open thread's key, or null). T3's rules: a jump past the end goes
 * nowhere; a step from nothing open goes to the first (next) or last (previous) thread; a
 * step from a thread not in the list goes nowhere; no wrapping at either end.
 */
export function threadTarget(command, keys, current) {
  const jump = /^thread\.jump\.([1-9])$/.exec(command)?.[1];
  if (jump) return keys[Number(jump) - 1] ?? null;
  if (command !== "thread.previous" && command !== "thread.next") return null;
  if (!keys.length) return null;
  if (current === null) return command === "thread.previous" ? keys.at(-1) : keys[0];
  const at = keys.indexOf(current);
  if (at === -1) return null;
  return (command === "thread.previous" ? keys[at - 1] : keys[at + 1]) ?? null;
}

/** keybindings.json as T3 reads it: JSON with comments and trailing commas allowed. */
export function parseLenientJson(text) {
  let stripped = String(text).replace(/("(?:[^"\\]|\\.)*")|\/\/[^\r\n]*|\/\*[\s\S]*?\*\//g, (m, str) => (str ? m : " "));
  stripped = stripped.replace(/("(?:[^"\\]|\\.)*")|,(\s*[}\]])/g, (m, str, bracket) => (str ? m : (bracket ?? "")));
  return JSON.parse(stripped);
}
