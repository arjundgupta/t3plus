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
  heroHeadline: '[data-chat-composer-stack="true"] > .absolute.bottom-full',
  /** T3's banners under the composer (a usage-limit fallback, an upload error). */
  composerBanner: "[data-composer-banner-stack]",
  /** T3's terminal (the drawer and xterm's input): its keys belong to the program running there. */
  terminal: "[data-thread-terminal-drawer], [data-terminal-owner], .xterm",
  /** T3's command palette (⌘K) and its items. */
  commandPalette: '[data-command-palette="true"]',
  commandItem: '[data-slot="command-item"]',
  /**
   * Things T3 floats over the chat that the composer must not run under: the
   * details card, the floating preview window (browser or device mini player),
   * and a preview's webview.
   */
  rightOverlays: 'aside[data-thread-details-panel], section[data-preview-mini-player], [data-preview-viewport]',
  /** Appearance page sections, in render order. t3+ appends after the last one found. */
  appearanceSections: ["section#appearance", "section#appearance-interface"],
  /** T3's thread details panel card (ThreadDetailsPanel) and its usage limits section. */
  threadDetailsCard: "[data-thread-details-card]",
  threadDetailsUsage: 'section[aria-label="Usage limits"]',
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
  /** <li> around a project folder header (Boring/project-grouped sidebar). */
  projectFolderItem: '[data-testid="sidebar-project-folder"]',
  /** A card row's first line (project badge, project name, status), relative to the row. */
  cardRowTopLine: ":scope > .relative.z-10 > .h-5",
  /** A slim row's project badge slot (settled and snoozed rows outside a folder), relative to the row. */
  slimRowBadgeSlot: ":scope > * > span.shrink-0.items-center",
  /** A project's badge: its icon, or T3's letter monogram (an svg colored by its text color). */
  projectBadge: 'img, [data-slot="project-monogram"] svg, [data-slot="project-monogram"]',
  /** Inside a sidebar row: T3's hidden exact copy of the title (older builds), its visible
   *  title span, and that span without the copy (dir is left off a title with no letter). */
  rowSrOnlyTitle: ".sr-only:not([role])",
  rowVisibleTitle: 'span[aria-hidden="true"]',
  rowDirTitle: "span[dir]",
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
  breadcrumbHeading: '[aria-label="Thread breadcrumb"] h2',
  /** T3's tooltips and popovers (hover cards are ones too), and a thread hover card's title line. */
  tooltipPopup: '[data-slot="tooltip-popup"]',
  hoverCardTitle: '[data-slot="tooltip-popup"] div.truncate:is(.font-medium, .font-semibold)',
  /** The thread details panel (the floating card's outer element). */
  threadDetailsPanel: "aside[data-thread-details-panel]",
  /** Settings: the Appearance entry in the settings nav, the page's scroller and its sections' column. */
  settingsAppearanceLink: '[data-settings-section="/settings/appearance"]',
  settingsPageScroll: "[data-settings-page-scroll]",
  settingsPage: "[data-settings-page-scroll] > div",
  /** The app's root element: not a popup. */
  appRootId: "root",
});

/** Class names of T3's that t3+ checks for (classList, not selectors). */
export const T3_CLASSES = Object.freeze({
  /** The status/time slot at the end of a sidebar row's top line. */
  statusSlot: "group/sidebar-status-slot",
  /** The composer's lane (T3 animates its padding when the right side's room changes). */
  composerLane: "chat-composer-lane",
  /** On the composer overlay while it is centered (the new-thread hero). */
  centered: "items-center",
});

/** Prefixes of data-sidebar-row / data-sidebar-parent values. */
export const SIDEBAR_ROW_PREFIX = Object.freeze({
  folder: "folder:",
  shelf: "shelf:",
  draft: "draft:",
});

/** Path of T3's Settings -> Appearance page. */
export const APPEARANCE_ROUTE = /\/settings\/appearance\/?$/;

/** First path segments that are T3 app routes, not "/<environmentId>/<threadId>". */
export const NON_THREAD_ROUTE_SEGMENTS = Object.freeze(["settings", "draft", "new", "pull-requests", "api", "oauth"]);

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
  /** On elements t3+ inserted into T3's DOM (bot avatars). */
  ownedAttr: "data-t3plus-owned",
});

/** The exact title token that marks a thread as a bot/orchestrator. */
export const DEFAULT_BOT_MARKER = "[[t3plus:bot:v1]]";
/** Shape a configured marker must have: one [[...]] token, no spaces. */
export const BOT_MARKER_PATTERN = /^\[\[[A-Za-z0-9:._-]{1,48}\]\]$/;

export const STORAGE_KEYS = Object.freeze({
  settings: "t3plus.settings.v1",
  image: "t3plus.image.v1",
  /** Per-bot presentation: shape and color. */
  bots: "t3plus.bots.v1",
  /** Threads made bots by Option-click (no title marker): { "<environmentId>:<threadId>": true }. */
  manualBots: "t3plus.botKeys.v1",
  /** Bot threads seen in the sidebar, so Settings can list them. */
  knownBots: "t3plus.knownBots.v1",
  /** Last good copy of t3plus-bots.json (latest message per bot). */
  botFeedCache: "t3plus.botFeed.cache.v1",
  /** Last good copy of t3plus-home.json (home widget data). */
  homeFeedCache: "t3plus.homeFeed.cache.v1",
  /** Profiles (src/profiles.js): { active, list: [{ id, name }], projects: { projectKey: profileId } }. */
  profiles: "t3plus.profiles.v2",
  /** The last t3+ version whose What's New was shown (whatsNew.js). */
  whatsNew: "t3plus.whatsNew.v1",
  /** Which window opens it, when several start at once (whatsNew.js). */
  whatsNewClaim: "t3plus.whatsNew.claim.v1",
});

export const GRADIENT_MODES = Object.freeze(["half-circle", "image"]);
export const IMAGE_SOURCES = Object.freeze(["sample", "upload"]);

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
  drop: "polygon(50% 2%, 78.4% 39.8%, 82.6% 46.7%, 85.2% 54.3%, 86% 62.3%, 85% 70.2%, 82.4% 77.8%, 78.1% 84.6%, 72.4% 90.2%, 65.6% 94.5%, 58% 97.1%, 50% 98%, 42% 97.1%, 34.4% 94.5%, 27.6% 90.2%, 21.9% 84.6%, 17.6% 77.8%, 15% 70.2%, 14% 62.3%, 14.8% 54.3%, 17.4% 46.7%, 21.6% 39.8%)",
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
});

/**
 * Bot avatar colors. Each is a fixed light -> mid -> dark ramp, rendered as an
 * ordered-dither gradient (src/botArt.js). Users pick the color, never the stops.
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

/** Largest feed accepted, in characters (the home feed allows four times this). */
export const CONFIG_LIMITS = Object.freeze({ maxChars: 256 * 1024 });

/** Minimum gap between DOM checks triggered by mutations, in ms. */
export const DOM_CHECK_THROTTLE_MS = 200;
