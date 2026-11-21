import { createBuilder } from "./dom.js";

// One tooltip for the home cards, in T3's own tooltip language:
//   look   T3's chart tooltip (UsageProviderChart.tsx UsageChartTooltip):
//          surface-glass, rounded-xl, border-border/50, px-2.5 py-2, text-xs,
//          shadow-lg; a muted label, one row per series, a bordered Total row.
//   motion T3's tooltip popup (ui/tooltip.tsx): fades and scales from 98% in
//          and out, and its positioner glides between targets.
// It lives on <body> (so the scrolling card grid never clips it), is
// pointer-events: none and aria-hidden (keyboard users step through each chart with
// the arrow keys and hear the same numbers in the view's status line; the cards'
// aria-labels carry only totals), and is driven by t3+'s own cards only.

export const TOOLTIP_ID = "t3plus-tip";
const GAP = 6;
const EDGE = 8;

const sameRow = (a, b) => a === b || (Boolean(a) && Boolean(b) && a.name === b.name && a.value === b.value && a.color === b.color);
/** Whether two contents read the same (each pointer move over a point makes its content anew). */
const sameContent = (a, b) =>
  a === b || (a !== null && b !== null && a.label === b.label && sameRow(a.total, b.total) && (a.rows ?? []).length === (b.rows ?? []).length && (a.rows ?? []).every((row, i) => sameRow(row, b.rows[i])));

/** `id`: each view gets its own tooltip element, so ids stay unique (the home cards and the details pool can both exist). */
export function createTooltip(doc, id = TOOLTIP_ID) {
  const h = createBuilder(doc);
  const el = h("div", { id, class: "t3plus-tip", "aria-hidden": "true", "data-t3plus-owned": "" });
  let open = false;
  // What it shows: built again only for another content. Rebuilt on every pointer move over
  // the same point, placing it then read back a layout of the page each time.
  let shown = null;
  // Where it was placed for (the anchor and the window's width): placing it reads its size
  // back, a layout of the page, and most moves over a day or a cell keep the same anchor.
  let placedFor = null;
  const placedAt = (anchor) =>
    placedFor !== null && placedFor.x === anchor.x && placedFor.top === anchor.top && placedFor.bottom === anchor.bottom && placedFor.width === doc.defaultView.innerWidth;

  function place(anchor) {
    const view = doc.defaultView;
    placedFor = { x: anchor.x, top: anchor.top, bottom: anchor.bottom, width: view.innerWidth };
    const w = el.offsetWidth;
    const hgt = el.offsetHeight;
    let x = anchor.x - w / 2;
    x = Math.max(EDGE, Math.min(view.innerWidth - w - EDGE, x));
    let y = anchor.top - hgt - GAP;
    if (y < EDGE) y = anchor.bottom + GAP;
    el.style.setProperty("--tip-x", `${Math.round(x)}px`);
    el.style.setProperty("--tip-y", `${Math.round(y)}px`);
  }

  return {
    element: el,
    /**
     * @param {{ x: number, top: number, bottom: number }} anchor  viewport coordinates
     * @param {{ label: string, rows?: { name: string, value: string, color?: string }[], total?: { name: string, value: string } }} content
     */
    show(anchor, content) {
      if (!el.isConnected) doc.body.append(el);
      if (!sameContent(shown, content)) {
        shown = content;
        placedFor = null; // another size

        const rows = (content.rows ?? [])
          .filter((r) => r && r.name != null && r.value != null && r.name !== "null" && r.value !== "null")
          .map((r) =>
            h("div", { class: "t3plus-tip-row" }, [
              h("span", { class: "t3plus-tip-name" }, [r.color ? h("span", { class: "t3plus-tip-swatch", style: `background:${r.color}` }) : null, r.name]),
              h("span", { class: "t3plus-tip-value", text: r.value }),
            ]));
        const total = content.total && content.total.name != null && content.total.value != null && content.total.name !== "null" && content.total.value !== "null" ? content.total : null;
        const children = [h("div", { class: "t3plus-tip-label", text: content.label }), ...rows];
        if (total) children.push(h("div", { class: "t3plus-tip-row t3plus-tip-total" }, [h("span", { class: "t3plus-tip-name", text: total.name }), h("span", { class: "t3plus-tip-value", text: total.value })]));
        el.replaceChildren(...children);
      }
      if (!open) {
        // First show: appear in place (no glide from the last spot), then animate in.
        el.setAttribute("data-instant", "");
        place(anchor);
        void el.offsetWidth;
        el.setAttribute("data-open", "");
        el.removeAttribute("data-instant");
        open = true;
      } else if (!placedAt(anchor)) {
        place(anchor);
      }
    },
    hide() {
      if (!open) return;
      open = false;
      el.removeAttribute("data-open");
    },
    remove() {
      open = false;
      shown = null;
      placedFor = null;
      el.remove();
    },
  };
}
