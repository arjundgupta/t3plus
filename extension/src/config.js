// DOM hooks and constants that depend on T3 Code's private UI.
//
// T3 Nightly changes often. Every T3 selector t3+ relies on lives in this file.
// Composer/Appearance hooks were verified against pingdotgg/t3code @ 5e6cc2b8
// (2026-09-08); sidebar, workspace and composer-shell hooks against @ 9ef259e5
// (2026-11-11):
//   apps/web/src/components/chat/ChatComposer.tsx        composer surface/body
//   apps/web/src/components/chat/ComposerSurface.tsx     composer-shell glass layer
//   apps/web/src/components/ComposerPromptEditor.tsx     composer editor
//   apps/web/src/components/ChatView.tsx                 conversation area, composer overlay
//   apps/web/src/lib/workspaceFocus.ts                   data-workspace-area
//   apps/web/src/components/ui/sidebar.tsx               sidebar-inner, scroll area
//   apps/web/src/components/sidebar/SidebarThreadRow.tsx data-thread-item, data-sidebar-row/-parent
//   apps/web/src/components/sidebar/SidebarProjectFolderHeader.tsx  folder:<logicalProjectKey>
//   apps/web/src/components/settings/SettingsPanels.tsx  Appearance sections
// When one breaks, update it here and in src/styles/content.css (the CSS file
// repeats the composer/backdrop selectors because manifest CSS cannot import JS).

// Parts more than one selector below is built from, so a rename is one edit.
/** The new-thread headline's classes: it hangs above the composer (ChatView.tsx). */
const HANGING_HEADLINE = ".absolute.bottom-full";
/** The thread breadcrumb in the top bar. */
const THREAD_BREADCRUMB = '[aria-label="Thread breadcrumb"]';
/** T3's letter monogram for a project with no icon. */
const PROJECT_MONOGRAM = '[data-slot="project-monogram"]';
/** A card row's body (its lines), relative to the row, and its first line, relative to the body. */
const CARD_ROW_BODY = ":scope > .relative.z-10";
const ROW_TOP_LINE = ":scope > .h-5";
/** A folder header's data-sidebar-row value starts so (SIDEBAR_ROW_PREFIX.folder). */
const FOLDER_ROW_PREFIX = "folder:";
const SETTINGS_BREADCRUMB = 'nav[aria-label="Settings breadcrumb"]';
const SKY_BACKDROP = ".sidebar-stage-backdrop";

export const T3_SELECTORS = Object.freeze({
  /** Rounded composer card that wraps the body and footer. */
  composerSurface: '[data-chat-composer-surface="true"]',
  /** Padded body holding the Lexical editor. Its parent is the fallback card. */
  composerBody: '[data-chat-composer-body="true"]',
  /** Lexical contenteditable. Used only to detect a composer, never touched. */
  composerEditor: '[data-testid="composer-editor"]',
  /** T3's composer shell; its ::before is T3's own glass layer, tuned by CSS variables. */
  composerShell: '[data-slot="composer-shell"]',
  /** Conversation pane behind the timeline and composer: hosts the t3+ backdrop layer. */
  conversationArea: '[data-workspace-area="conversation"]',
  /** Composer overlay; its parent is the fallback backdrop host. On the new-thread
   *  page (draft hero) it is centered with `items-center` (ChatView.tsx). */
  composerOverlay: '[data-chat-composer-overlay="true"]',
  /** Where T3's chat composer lives (ChatView.tsx: the overlay is workspace area "composer"). Editors
   *  outside it (e.g. the font preview on Settings > Appearance) are not chat composers. */
  chatComposerArea: '[data-chat-composer-overlay="true"], [data-workspace-area="composer"], [data-workspace-area="conversation"]',
  /** The composer stack inside the overlay; the draft headline hangs above it (bottom-full). */
  composerStack: '[data-chat-composer-stack="true"]',
  /** The composer's lane: T3 pads its right side by --chat-lane-inset-end (room for the details card or a preview). */
  composerLane: ".chat-composer-lane",
  /** The chat canvas: holds the timeline and the composer lane; T3 keeps the lane's room (--chat-lane-inset-end) on it. */
  chatCanvas: "[data-chat-canvas]",
  /** The new-thread headline hanging above the composer (only in the centered hero state). */
  heroHeadline: `[data-chat-composer-stack="true"] > ${HANGING_HEADLINE}`,
  /** The same headline found from the overlay, without the stack hook (the health check
   *  must still see the page when only the stack hook was renamed). */
  overlayHeadline: `[data-chat-composer-overlay="true"] ${HANGING_HEADLINE}`,
  /** T3's banners under the composer (a usage-limit fallback, an upload error). */
  composerBanner: "[data-composer-banner-stack]",
  /** T3's terminal (the drawer and xterm's input): its keys belong to the program running there. */
  terminal: "[data-thread-terminal-drawer], [data-terminal-owner], .xterm",
  /** T3's command palette (⌘K) and its items. */
  commandPalette: '[data-command-palette="true"]',
  commandItem: '[data-slot="command-item"]',
  /** A user message's bubble (its color: --message-surface); used in content.css (chat bubbles). */
  userBubble: '[data-message-role="user"] .bg-message',
  /** T3's own trackpad back/forward swipe arrow: a round bubble in a fixed frame; used in content.css.
   *  The bubble itself (size-14 first: a rare class keys the rule, not a common one). */
  swipeArrow: '.pointer-events-none.fixed.overflow-hidden[aria-hidden="true"] > .size-14.rounded-full',
  /** T3's night sky at the top of the sidebar (nightly builds): its container, and the art in it. */
  skyBackdrop: SKY_BACKDROP,
  nightSky: `${SKY_BACKDROP} svg[data-stage-art="nightly"]`,
  /** Appearance page sections, in render order. t3+ appends after the last one found. */
  appearanceSections: ["section#appearance", "section#appearance-interface"],
  /** T3's thread details panel card (ThreadDetailsPanel) and its usage limits section. */
  threadDetailsCard: "[data-thread-details-card]",
  threadDetailsUsage: 'section[aria-label="Usage limits"]',
  /** Details card, Automations section: a task's schedule line and the panel's error are <p>s; the title is a span. */
  automationScheduleLine: "p",
  /** The Usage page chart (UsageProviderChart): "Daily processed tokens by provider", "Hourly cost by provider".
   *  Builds after 2026-11-16 dropped the label (the svg is aria-hidden); those match by the chart's own viewBox. */
  usageChart: 'svg[role="img"][aria-label$=" by provider"], svg[viewBox="0 0 960 260"][preserveAspectRatio="none"]:has(> path[fill="none"][stroke])',
  /** A provider's line in that chart (relative to the chart's svg). */
  usageChartLine: 'path[fill="none"][stroke]',
  /** The composer's model picker; its aria-label names the model ("Claude Opus 5.5, High"). */
  modelPicker: "[data-chat-provider-model-picker]",
  /** The chat's scrolling message list (MessagesTimeline). Mutations inside it are streaming text. */
  messageList: ".messages-timeline-scroll",

  /** Sidebar panel. Several can exist (left/right); t3+ reads the one with thread rows. In a
   *  narrow window (under 768 px) T3 shows the sidebar as a sheet with the same rows instead. */
  sidebarInner: '[data-slot="sidebar-inner"], [data-slot="sidebar"][data-mobile="true"]',
  /** Every keyboard-navigable sidebar row. Value: thread key, folder:<key>, shelf:<name>, draft:<id>. */
  sidebarRow: "[data-sidebar-row]",
  /** <li> around a thread row. Value: thread key "<environmentId>:<threadId>". */
  threadItem: "[data-thread-item]",
  /** T3's ⌘ jump hint badge on a sidebar row (shown while the jump keys are held). */
  jumpHint: "[data-jump-hint]",
  /** T3's command palette and model picker, open: T3's thread keys do nothing then. */
  commandPaletteOpen: "[data-command-palette]",
  modelPickerOpen: "[data-model-picker-content]",
  /** T3's search results, shown in place of the thread list while searching. */
  threadSearchResults: "#sidebar-thread-search-results",
  /** T3's terminal drawer, open (its keybinding context "terminalOpen"). */
  terminalDrawer: "[data-thread-terminal-drawer]",
  /** What T3 counts as typing (lib/editableFocus.ts, its "editableFocus" context). */
  editable: 'input, textarea, select, [contenteditable=""], [contenteditable="true"], [contenteditable="plaintext-only"], [role="textbox"]',
  /** The right-hand slot of a sidebar row (time, status) where T3 puts its ⌘ jump hint. */
  rowStatusSlot: ".ml-auto.min-w-8.shrink-0",
  /** <li> around a project folder header (Boring/project-grouped sidebar). */
  projectFolderItem: '[data-testid="sidebar-project-folder"]',
  /** A card row's first line (project badge, project name, status), relative to the row. */
  cardRowTopLine: `${CARD_ROW_BODY} > .h-5`,
  /** A card row's body, its lines relative to it (top, then the meta line under the title), and
   *  the top line's project name and badge, relative to the line. Without the body (a row in a
   *  project's folder) the lines are the row's own. */
  cardRowBody: CARD_ROW_BODY,
  rowTopLine: ROW_TOP_LINE,
  rowMetaLine: ":scope > .mt-0\\.5",
  rowLineProject: ":scope > .truncate",
  rowLineBadge: ":scope > img, :scope > span > img",
  /** A slim row's project badge slot (settled and snoozed rows outside a folder), relative to the row. */
  slimRowBadgeSlot: ":scope > * > span.shrink-0.items-center",
  /** A project's badge: its icon, or T3's letter monogram (an svg colored by its text color). */
  projectBadge: `img, ${PROJECT_MONOGRAM} svg, ${PROJECT_MONOGRAM}`,
  projectMonogram: PROJECT_MONOGRAM,
  /** Inside a sidebar row: T3's hidden exact copy of the title (older builds), its visible
   *  title span, and that span without the copy (dir is left off a title with no letter). */
  rowSrOnlyTitle: ".sr-only:not([role])",
  rowVisibleTitle: 'span[aria-hidden="true"]',
  rowDirTitle: "span[dir]",
  /** The visible title span with its dir (rowVisibleTitle alone can be an icon's wrapper). */
  rowVisibleDirTitle: 'span[aria-hidden="true"][dir]',
  /** A thread row's parent (data-sidebar-parent: a folder:<key>, shelf:<name> or a thread key). */
  rowParent: "[data-sidebar-parent]",
  /** A project folder's header row. */
  folderHeader: `[data-sidebar-row^="${FOLDER_ROW_PREFIX}"]`,
  /** A folder header's project name. */
  folderTitle: ".truncate",
  /** The sidebar's scrolling viewport, around the thread list. */
  sidebarScroller: '[data-slot="scroll-area-viewport"]',
  /** The sidebar's footer (the profile dots go at its top). */
  sidebarFooter: '[data-slot="sidebar-footer"], [data-sidebar="footer"]',
  /** Any sidebar at all, and the desktop sidebar's outer wrapper. */
  sidebarAny: '[data-slot="sidebar"]',
  sidebarWrapper: "[data-slot='sidebar-wrapper']",
  /** The open thread's heading in the top bar. */
  breadcrumbHeading: `${THREAD_BREADCRUMB} h2`,
  /** The breadcrumb itself, its items' text (a workspace's name) and the badges in it. */
  breadcrumbNav: `nav${THREAD_BREADCRUMB}`,
  breadcrumbText: '[data-slot="workspace-breadcrumb-text"]',
  badge: '[data-slot="badge"]',
  /** T3's tooltips and popovers (hover cards are ones too), and a thread hover card's title line. */
  tooltipPopup: '[data-slot="tooltip-popup"]',
  hoverCardTitle: '[data-slot="tooltip-popup"] div.truncate:is(.font-medium, .font-semibold)',
  /** A hover card's other lines (project, machine, branch, model), the model's icon in one, and
   *  T3's warning and error lines. */
  hoverCardLine: ".grid > div",
  modelIcon: ".grayscale",
  warningLine: ".text-warning, .text-error, .text-destructive",
  /** A label T3 splits into parts (a project, then a branch): its parts are spans in a titled span. */
  splitLabel: "span[title]:has(> span + span)",
  titledLabel: "span[title]",
  /** The new-thread page's project picker and headline. */
  draftHero: ".group\\/draft-hero [data-draft-project-trigger], .group\\/draft-hero .font-medium",
  /** The composer's context controls (workspace, branch) and the label in each. */
  composerContextControl: "[data-composer-context-control], [aria-label^='Branch: ']",
  composerLabel: "[data-composer-label]",
  /** A row of the chat timeline, a message's markdown, a command run, monospace text. */
  timelineRow: "[data-timeline-row-id]",
  chatMarkdown: ".chat-markdown",
  commandExecution: '[data-v2-item-type="command_execution"]',
  monoText: ".font-mono",
  /** T3's small text (a command palette item's second line). */
  smallText: ".text-xs",
  /** What T3 portals over the page: menus, listboxes, dialogs, popups, toasts and live statuses. */
  portals: '[role="menu"], [role="listbox"], [role="dialog"], [role="alertdialog"], [data-slot$="-popup"], [data-sonner-toast], [role="status"][aria-live], [role="alert"]',
  /** The thread details panel (the floating card's outer element). */
  threadDetailsPanel: "aside[data-thread-details-panel]",
  /** Settings: the Appearance entry in the settings nav, the page's scroller and its sections' column. */
  settingsAppearanceLink: '[data-settings-section="/settings/appearance"]',
  /** The settings nav's entry for the page shown (T3 marks it so; its workspace focus looks for it too). */
  settingsNavCurrent: '[data-settings-section][aria-current="page"]',
  settingsPageScroll: "[data-settings-page-scroll]",
  settingsPage: "[data-settings-page-scroll] > div",
  /** The Settings header's page actions (General's "Restore device defaults", Close). */
  settingsHeaderActions: `${SETTINGS_BREADCRUMB} ~ div`,
  // Used in content.css only (manifest CSS cannot import JS; manifest.test.js checks it
  // still uses them): the Settings breadcrumb and T3's active nav entry (they defer to
  // t3+'s while it is open), the inline details panel (hidden under the home cards), the
  // conversation pane's own background (under the glow) and the Settled shelf's rows.
  settingsBreadcrumb: SETTINGS_BREADCRUMB,
  settingsNavActive: '[data-settings-section][data-active="true"]',
  detailsPanelInline: 'aside[data-thread-details-panel="inline"]',
  conversationBackground: '[data-workspace-area="conversation"] > .bg-background',
  settledShelfRow: '[data-sidebar-parent="shelf:settled"]',
  /** The app's root element: not a popup. */
  appRootId: "root",
});

/**
 * The selectors of a T3_SELECTORS list, one by one. A document-wide query of a list tests
 * every element against each part (Blink's slow path, many times slower than the parts
 * queried on their own), so per-check queries take the parts.
 */
export function selectorParts(list) {
  const parts = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < list.length; i += 1) {
    const ch = list[i];
    if (ch === "(" || ch === "[") depth += 1;
    else if (ch === ")" || ch === "]") depth -= 1;
    else if (ch === "," && depth === 0) {
      parts.push(list.slice(start, i).trim());
      start = i + 1;
    }
  }
  parts.push(list.slice(start).trim());
  return parts;
}

/** Path of T3's Usage page (its chart takes the widgets' dither style, usageDither.js). */
export const USAGE_ROUTE = "/usage";

/** Attributes of T3's that t3+ reads (getAttribute / hasAttribute, not selectors). */
export const T3_ATTRS = Object.freeze({
  /** A thread row's <li> (T3_SELECTORS.threadItem): the thread key. */
  threadItem: "data-thread-item",
  sidebarRow: "data-sidebar-row",
  sidebarParent: "data-sidebar-parent",
  /** A timeline row's kind ("turn-fold", "work-toggle", "work", ...) and a message's role. */
  timelineRowKind: "data-timeline-row-kind",
  messageRole: "data-message-role",
  /** A composer control's shortcut ("composer.workspace": the workspace picker). */
  composerShortcut: "data-composer-shortcut",
  /** The thread details card's sections: automations, side chats. */
  automationsPanel: "data-thread-automations-panel",
  sideChatsPanel: "data-thread-side-chats-panel",
});

/** Class names of T3's that t3+ checks for (classList, not selectors). */
export const T3_CLASSES = Object.freeze({
  /** The status/time slot at the end of a sidebar row's top line. */
  statusSlot: "group/sidebar-status-slot",
  /** The composer's lane (T3 animates its padding when the right side's room changes). */
  composerLane: "chat-composer-lane",
  /** On the composer overlay while it is centered (the new-thread hero). */
  centered: "items-center",
  /** A sidebar title's state classes (SidebarThreadRow.tsx), which a bot's drawn name copies
   *  in content.css: seen, failed, and the slim rows' shades (as CSS escapes them). */
  titleTones: Object.freeze(["font-normal", "text-foreground\\/75", "text-foreground\\/95", "text-muted-foreground", "text-secondary-label", "text-secondary-label\\/70"]),
});

/** Prefixes of data-sidebar-row / data-sidebar-parent values. */
export const SIDEBAR_ROW_PREFIX = Object.freeze({
  folder: FOLDER_ROW_PREFIX,
  shelf: "shelf:",
  draft: "draft:",
});

/** Path of T3's Settings -> Appearance page. */
export const APPEARANCE_ROUTE = /\/settings\/appearance\/?$/;

/** First path segments that are T3 app routes, not "/<environmentId>/<threadId>". */
export const NON_THREAD_ROUTE_SEGMENTS = Object.freeze(["settings", "draft", "new", "pull-requests", "api", "oauth", "projects", "usage", "welcome", "pair"]);

/** Attributes and ids t3+ owns. */
export const T3PLUS = Object.freeze({
  /** On <html>: "half-circle" | "image" while a background is shown. */
  modeAttr: "data-t3plus-backdrop",
  /** On <html>: present while the glass composer is on. */
  glassAttr: "data-t3plus-glass",
  /** Set on fallback composer surfaces that lack T3's surface attribute. */
  surfaceAttr: "data-t3plus-surface",
  /** Set on the composer overlay's parent when T3's conversation-area hook is missing. */
  backdropHostAttr: "data-t3plus-backdrop-host",
  panelId: "t3plus-appearance",
  /** On a bot thread row. Value: status (working | attention | failed | done | waiting | idle). */
  botAttr: "data-t3plus-bot",
  /** On the visible title span inside a bot row. */
  botTitleAttr: "data-t3plus-bot-title",
  /** The home widgets under T3's new-thread composer. */
  homeId: "t3plus-home",
  /** On T3's usage limits section while the t3+ pool replaces its rows. */
  detailsPoolAttr: "data-t3plus-details-pool",
  /** On <html> while screenshot mode covers T3's text. */
  demoAttr: "data-t3plus-demo",
  /** On <html> while the t3+ settings section is open. */
  settingsAttr: "data-t3plus-settings",
  /** On <html> while the home widgets are shown. */
  homeAttr: "data-t3plus-home",
  /** On <html> while the usage widgets are on (any page): the new-thread centering keys on it. */
  widgetsAttr: "data-t3plus-widgets",
  /** On T3's composer overlay t3+ lays out as the new-thread hero (its measured padding). */
  heroAttr: "data-t3plus-hero",
  /** On elements t3+ inserted into T3's DOM (bot avatars). */
  ownedAttr: "data-t3plus-owned",
  /** On a row of the sidebar's Status view (statusView.js): the thread it opens. */
  statusThreadAttr: "data-thread",
});

/** The exact title token that marks a thread as a bot/orchestrator. */
export const DEFAULT_BOT_MARKER = "[[t3plus:bot:v1]]";
/** Shape a configured marker must have: one [[...]] token, no spaces. */
export const BOT_MARKER_PATTERN = /^\[\[[A-Za-z0-9:._-]{1,48}\]\]$/;

// Where each thing is stored (chrome.storage.local). In a module of its own: the background
// worker mirrors the preferences to Chrome Sync (backup.js) without evaluating this file.
export { STORAGE_KEYS } from "./storageKeys.js";

export const GRADIENT_MODES = Object.freeze(["half-circle", "image"]);
export const IMAGE_SOURCES = Object.freeze(["sample", "upload"]);
/** A subagent's shape or color that follows its bot's (settings sidebar.subagentShape/Color). */
export const SAME_AS_BOT = "same";

export const DEFAULT_SETTINGS = Object.freeze({
  version: 2,
  /** The background behind the composer (kept under its v1 name so v1 choices carry over). */
  composerGradient: Object.freeze({
    enabled: true,
    mode: "half-circle",
    /** "theme" follows T3's --primary; otherwise a #rrggbb color. */
    accent: "theme",
    /** 0-100. */
    intensity: 45,
    imageSource: "sample",
    /** Draw the background as a real ordered dither (pixelated), like the bot avatars. */
    dither: true,
    /** Dither cell size: "fine" (the bot avatars' pixel), "medium" or "large". */
    ditherSize: "medium",
    /** Pixel dither style: "bayer" (crosshatch), "grain" (organic noise) or "spectrum" (hue-shifting tones). */
    ditherStyle: "bayer",
  }),
  glass: Object.freeze({
    enabled: true,
    /** 0-100: how see-through the composer card is. */
    strength: 85,
  }),
  sidebar: Object.freeze({
    bots: true,
    /** Every thread is a bot unless turned off (Option-click); off: only the ones turned on. */
    botsDefault: true,
    /** BOT_STYLES name. */
    botStyle: "classic",
    /** Profile dots at the bottom of the sidebar (src/profiles.js). */
    profiles: true,
    /** The Status view (src/statusView.js): each bot wears its status's color, not its own. */
    statusColors: false,
    /** A small tile on each bot's face that shows what its thread is doing (botArt.js botBadge). */
    statusBadges: false,
    /** Subagents' faces under their bot: SAME_AS_BOT (its shape) or a BOT_SHAPES name. */
    subagentShape: SAME_AS_BOT,
    /** SAME_AS_BOT (its color, a status color too) or a pickable BOT_COLORS name. */
    subagentColor: SAME_AS_BOT,
  }),
  chat: Object.freeze({
    /** Your messages' bubbles: "theme" (T3's own) or a #rrggbb color (src/bubbles.js). */
    bubble: "theme",
  }),
  home: Object.freeze({
    /** Activity, limits, spend and automations under the new-thread composer. */
    widgets: true,
  }),
  demo: Object.freeze({
    /** Screenshot mode: stand-in titles, projects and message text (demoMode.js). */
    enabled: false,
  }),
});

/** Packaged sample image, relative to the extension root. */
export const SAMPLE_IMAGE_PATH = "assets/sample-spectrum.svg";
/** The same sample for light pages: its band on a pale field (under the light scrim the dark field read as a grey veil). */
export const SAMPLE_IMAGE_LIGHT_PATH = "assets/sample-spectrum-light.svg";

/**
 * Bot avatar shapes: CSS clip-path for each. The avatar is a square tile
 * clipped to the shape; the status dot sits outside the clip.
 */
// Polygons generated once: a sun with rays, an apple, a lemon, a strawberry.
const polygon = (points) => `polygon(${points.map(([x, y]) => `${x.toFixed(1)}% ${y.toFixed(1)}%`).join(", ")})`;
const radial = (steps, radius) =>
  polygon(Array.from({ length: steps }, (_, i) => {
    const a = (i / steps) * Math.PI * 2 - Math.PI / 2;
    const r = radius(a, i);
    return [50 + r * Math.cos(a), 50 + r * Math.sin(a)];
  }));
const SUN = radial(48, (a, i) => (i % 4 === 0 ? 50 : i % 4 === 2 ? 38 : 41));
const APPLE = radial(48, (a) => {
  const top = Math.exp(-(((a + Math.PI / 2) / 0.35) ** 2)); // the dip at the stem
  const bottom = Math.exp(-(((a - Math.PI / 2) / 0.3) ** 2));
  return 47 - 9 * top - 3 * bottom;
});
const LEMON = radial(48, (a) => {
  const tips = Math.abs(Math.cos(a)) ** 8; // pointed at both ends
  return 37 / Math.sqrt(Math.sin(a) ** 2 + (Math.cos(a) * 0.82) ** 2) * 0.86 + 6 * tips;
});
const STRAWBERRY = radial(48, (a) => {
  const down = (Math.sin(a) + 1) / 2; // 0 at the top, 1 at the bottom
  return 46 - 10 * down ** 3 + 4 * (1 - down) ** 4;
});

/** The Blobs set's shapes (blobAvatars.js draws them). Their names are no other shape's. */
const BLOB_SHAPES = Object.freeze(["drop", "pebble", "squircle", "bean", "trefoil", "cloud", "egg", "mochi", "wobble", "lean", "tilt", "pudding"]);

export const BOT_SHAPES = Object.freeze({
  circle: "circle(50% at 50% 50%)",
  square: "inset(4% round 26%)",
  triangle: "polygon(50% 4%, 97% 92%, 3% 92%)",
  diamond: "polygon(50% 0, 100% 50%, 50% 100%, 0 50%)",
  hexagon: "polygon(25% 4%, 75% 4%, 100% 50%, 75% 96%, 25% 96%, 0 50%)",
  star: "polygon(50% 0, 62% 35%, 99% 36%, 69% 58%, 80% 95%, 50% 73%, 20% 95%, 31% 58%, 1% 36%, 38% 35%)",
  // Characters: a silhouette with a little more personality (some carry markings, botArt.js shapeMarks).
  ghost: "polygon(4% 48%, 5.2% 37.8%, 8.6% 28%, 14% 19.3%, 21.3% 12%, 30% 6.6%, 39.8% 3.2%, 50% 2%, 60.2% 3.2%, 70% 6.6%, 78.7% 12%, 86% 19.3%, 91.4% 28%, 94.8% 37.8%, 96% 48%, 96% 97%, 81% 86%, 66% 97%, 50% 86%, 34% 97%, 19% 86%, 4% 97%)",
  cat: "polygon(88% 3%, 86.5% 34.2%, 90.2% 41.7%, 92.4% 49.7%, 93% 58%, 92% 66.2%, 89.4% 74.1%, 85.4% 81.4%, 80.1% 87.7%, 73.6% 93%, 66.2% 96.8%, 58.3% 99.2%, 50% 100%, 41.7% 99.2%, 33.8% 96.8%, 26.4% 93%, 19.9% 87.7%, 14.6% 81.4%, 10.6% 74.1%, 8% 66.2%, 7% 58%, 7.6% 49.7%, 9.8% 41.7%, 13.5% 34.2%, 12% 3%, 40% 15.2%, 60% 15.2%)",
  robot: "polygon(14% 22%, 46% 22%, 46% 10%, 41% 10%, 41% 0%, 59% 0%, 59% 10%, 54% 10%, 54% 22%, 86% 22%, 92% 28%, 92% 46%, 100% 46%, 100% 70%, 92% 70%, 92% 90%, 86% 96%, 14% 96%, 8% 90%, 8% 70%, 0% 70%, 0% 46%, 8% 46%, 8% 28%)",
  heart: "polygon(50% 26%, 50.3% 24%, 51.9% 18.9%, 56% 12.4%, 62.7% 6.8%, 71.6% 4%, 81.2% 5.3%, 89.8% 10.6%, 95.8% 19%, 98% 29.1%, 95.8% 39.7%, 89.8% 49.9%, 81.2% 59.4%, 71.6% 68.2%, 62.7% 76.5%, 56% 84.1%, 51.9% 90.3%, 50.3% 94.5%, 50% 96%, 49.7% 94.5%, 48.1% 90.3%, 44% 84.1%, 37.3% 76.5%, 28.4% 68.2%, 18.8% 59.4%, 10.2% 49.9%, 4.2% 39.7%, 2% 29.1%, 4.2% 19%, 10.2% 10.6%, 18.8% 5.3%, 28.4% 4%, 37.3% 6.8%, 44% 12.4%, 48.1% 18.9%, 49.7% 24%)",
  shield: "polygon(6% 6%, 94% 6%, 94% 48%, 88% 66%, 74% 82%, 50% 97%, 26% 82%, 12% 66%, 6% 48%)",
  // "teardrop": the blob set took the name "drop" (0.22.3), which hid this one.
  teardrop: "polygon(50% 2%, 78.4% 39.8%, 82.6% 46.7%, 85.2% 54.3%, 86% 62.3%, 85% 70.2%, 82.4% 77.8%, 78.1% 84.6%, 72.4% 90.2%, 65.6% 94.5%, 58% 97.1%, 50% 98%, 42% 97.1%, 34.4% 94.5%, 27.6% 90.2%, 21.9% 84.6%, 17.6% 77.8%, 15% 70.2%, 14% 62.3%, 14.8% 54.3%, 17.4% 46.7%, 21.6% 39.8%)",
  octagon: "polygon(30% 2%, 70% 2%, 98% 30%, 98% 70%, 70% 98%, 30% 98%, 2% 70%, 2% 30%)",
  pentagon: "polygon(50% 2%, 98% 38%, 80% 96%, 20% 96%, 2% 38%)",
  pill: "inset(16% 2% round 34%)",
  // Balls (BOT_SKINS): the shape brings its own colors and markings.
  // A fat football on the diagonal (tips at the bottom-left and top-right corners), so it fills the tile.
  football: "polygon(4.7% 95.3%, 20.1% 97.7%, 31.8% 96.4%, 42.0% 93.7%, 51.3% 90.0%, 59.6% 85.5%, 67.2% 80.1%, 74.0% 74.0%, 80.1% 67.2%, 85.5% 59.6%, 90.0% 51.3%, 93.7% 42.0%, 96.4% 31.8%, 97.7% 20.1%, 95.3% 4.7%, 79.9% 2.3%, 68.2% 3.6%, 58.0% 6.3%, 48.7% 10.0%, 40.4% 14.5%, 32.8% 19.9%, 26.0% 26.0%, 19.9% 32.8%, 14.5% 40.4%, 10.0% 48.7%, 6.3% 58.0%, 3.6% 68.2%, 2.3% 79.9%)",
  basketball: "circle(50% at 50% 50%)",
  soccer: "circle(50% at 50% 50%)",
  baseball: "circle(50% at 50% 50%)",
  tennis: "circle(50% at 50% 50%)",
  volleyball: "circle(50% at 50% 50%)",
  eightball: "circle(50% at 50% 50%)",
  bowling: "circle(50% at 50% 50%)",
  golf: "circle(50% at 50% 50%)",
  beachball: "circle(50% at 50% 50%)",
  // Space.
  earth: "circle(50% at 50% 50%)",
  moon: "circle(50% at 50% 50%)",
  mars: "circle(50% at 50% 50%)",
  jupiter: "circle(50% at 50% 50%)",
  saturn: "inset(0)", // the ring reaches the tile's edges; its sky is transparent pixels
  sun: SUN,
  // Fruit.
  orange: "circle(48% at 50% 52%)",
  apple: APPLE,
  lemon: LEMON,
  watermelon: "circle(50% at 50% 50%)",
  lime: "circle(46% at 50% 52%)",
  strawberry: STRAWBERRY,
  // Blobs (blobAvatars.js): vector blobs that keep inside their own outline, unclipped.
  ...Object.fromEntries(BLOB_SHAPES.map((k) => [k, "inset(0)"])),
});

/**
 * Shapes with a fixed look of their own: the bot's color is ignored and this
 * light -> mid -> dark ramp is used instead; src/botArt.js draws the markings
 * (football laces in white, basketball seams in the dark stop).
 */
export const BOT_SKINS = Object.freeze({
  football: Object.freeze({ stops: ["#d9915a", "#94491f", "#3f1a08"] }),
  // lift brightens the body so the dark seams stand out from the dither.
  basketball: Object.freeze({ stops: ["#ffc38a", "#f26f1d", "#4a1c06"], lift: 0.16 }),
  // extra: more colors for markings (layers 4, 5, ... in botArt.js skinMarks).
  // outline: the layer the eyes' rim uses (default 2, the dark stop); white balls rim them in ink.
  soccer: Object.freeze({ stops: ["#ffffff", "#dcdce0", "#8b8b94"], extra: ["#18181b"], lift: 0.1, outline: 4 }),
  baseball: Object.freeze({ stops: ["#ffffff", "#ece8e4", "#a8a29e"], extra: ["#dc2626", "#3f3a36"], lift: 0.12, outline: 5 }),
  tennis: Object.freeze({ stops: ["#f4ff8a", "#c8e532", "#6b7f12"], lift: 0.08 }),
  volleyball: Object.freeze({ stops: ["#ffffff", "#eef2f7", "#94a3b8"], extra: ["#2563eb", "#facc15", "#334155"], lift: 0.1, outline: 6 }),
  eightball: Object.freeze({ stops: ["#5b5b66", "#1c1c22", "#050507"] }),
  bowling: Object.freeze({ stops: ["#c4b5fd", "#7c3aed", "#2e1065"] }),
  golf: Object.freeze({ stops: ["#ffffff", "#f1f1f3", "#a1a1aa"], extra: ["#3f3f46"], lift: 0.12, outline: 4 }),
  beachball: Object.freeze({ stops: ["#ffffff", "#f5f7fa", "#94a3b8"], extra: ["#ef4444", "#3b82f6", "#facc15", "#334155"], lift: 0.1, outline: 7 }),
  earth: Object.freeze({ stops: ["#7dd3fc", "#2563eb", "#172554"], extra: ["#4ade80", "#15803d"] }),
  moon: Object.freeze({ stops: ["#f4f4f5", "#a1a1aa", "#3f3f46"], lift: 0.06 }),
  mars: Object.freeze({ stops: ["#fdba74", "#ea580c", "#431407"] }),
  jupiter: Object.freeze({ stops: ["#fef3c7", "#e0a35a", "#7c4a1c"], extra: ["#b45309", "#dc2626"], lift: 0.08 }),
  saturn: Object.freeze({ stops: ["#fde68a", "#eab308", "#713f12"], extra: ["#f3dfb0", "#a8823f"] }),
  sun: Object.freeze({ stops: ["#fffbe6", "#facc15", "#ea580c"], lift: 0.12 }),
  orange: Object.freeze({ stops: ["#fed7aa", "#fb923c", "#9a3412"], extra: ["#16a34a", "#78350f"] }),
  apple: Object.freeze({ stops: ["#fca5a5", "#dc2626", "#7f1d1d"], extra: ["#78350f", "#22c55e"] }),
  lemon: Object.freeze({ stops: ["#fef9c3", "#facc15", "#a16207"], lift: 0.06 }),
  watermelon: Object.freeze({ stops: ["#bbf7d0", "#22c55e", "#14532d"] }),
  lime: Object.freeze({ stops: ["#ecfccb", "#84cc16", "#365314"], lift: 0.04 }),
  strawberry: Object.freeze({ stops: ["#fda4af", "#e11d48", "#881337"], extra: ["#fde047", "#16a34a"] }),
});

/**
 * Bot styles: which shapes bots get when none was picked for them. Classic is
 * the original mix of shapes in each bot's project color; the others are sets
 * with their own colors.
 */
export const BOT_STYLES = Object.freeze({
  classic: Object.freeze({ label: "Classic", shapes: null }),
  sports: Object.freeze({ label: "Sports", shapes: ["football", "basketball", "soccer", "baseball", "tennis", "volleyball", "eightball", "bowling", "golf", "beachball"] }),
  space: Object.freeze({ label: "Space", shapes: ["earth", "moon", "mars", "jupiter", "saturn", "sun"] }),
  fruit: Object.freeze({ label: "Fruit", shapes: ["orange", "apple", "lemon", "watermelon", "lime", "strawberry"] }),
  blobs: Object.freeze({ label: "Blobs", shapes: BLOB_SHAPES }),
});

/**
 * Bot avatar colors. Each is a fixed light -> mid -> dark ramp, rendered as an
 * ordered-dither gradient (src/botArt.js). Users pick the color, never the stops.
 * A `status` color is only for Status colors (an idle bot): no picker offers it.
 */
export const BOT_COLORS = Object.freeze({
  blue: Object.freeze({ label: "Blue", stops: ["#a8d1ff", "#3b82f6", "#1e2f8a"] }),
  red: Object.freeze({ label: "Red", stops: ["#ffb4a8", "#ef4444", "#7f1d1d"] }),
  orange: Object.freeze({ label: "Orange", stops: ["#ffd59e", "#f97316", "#7c2d12"] }),
  yellow: Object.freeze({ label: "Yellow", stops: ["#fff4a8", "#eab308", "#6b3a0f"] }),
  green: Object.freeze({ label: "Green", stops: ["#bff7cb", "#22c55e", "#14532d"] }),
  teal: Object.freeze({ label: "Teal", stops: ["#aaf5ec", "#14b8a6", "#123f45"] }),
  purple: Object.freeze({ label: "Purple", stops: ["#ddd0ff", "#8b5cf6", "#3b0a64"] }),
  pink: Object.freeze({ label: "Pink", stops: ["#ffc6e4", "#ec4899", "#831843"] }),
  gray: Object.freeze({ label: "Gray", stops: ["#ececf0", "#7a7a85", "#26262c"] }),
});

/** BOT_COLORS names a bot or a subagent can be given. */
export const PICKABLE_BOT_COLORS = Object.freeze(Object.keys(BOT_COLORS));

export const IMAGE_LIMITS = Object.freeze({
  /** Files above this are rejected before decoding. */
  maxInputBytes: 15 * 1024 * 1024,
  /** Longest edge after downscaling. */
  maxEdgePx: 1600,
  /** Hard cap on the stored data URL (chrome.storage.local quota is 10 MB). */
  maxStoredChars: 3 * 1024 * 1024,
  acceptedTypes: Object.freeze(["image/png", "image/jpeg", "image/webp", "image/avif", "image/gif"]),
});

/**
 * The desktop build keeps t3+'s storage in T3's own localStorage (page-stub.js):
 * one budget of a few million characters shared with T3's drafts and settings. An
 * image there is held to about a megabyte, so it never leaves T3 short of room.
 */
export const DESKTOP_IMAGE_LIMITS = Object.freeze({ ...IMAGE_LIMITS, maxStoredChars: 1024 * 1024 });

export const BOT_LIMITS = Object.freeze({
  /** Most bots t3+ keeps presentation for. */
  maxBots: 24,
  /** Longest preview text kept from the bot feed. */
  maxPreviewChars: 280,
});

/** How often the bot feed (latest message per bot) is re-read while the tab is visible. */
export const BOT_FEED_POLL_MS = 60 * 1000;
/** How often the home feed is re-read while the tab is visible. */
export const HOME_FEED_POLL_MS = 2 * 60 * 1000;

/** Minimum gap between DOM checks triggered by mutations, in ms. */
export const DOM_CHECK_THROTTLE_MS = 200;
