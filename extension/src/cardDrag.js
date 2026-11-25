// Drag-to-reorder for a grid of cards (the home widgets, and their preview in Settings).
// Pointer events, not HTML drag and drop: T3 listens for drops on its composer (files),
// and a native drag over it showed T3's drop overlay. The dragged card follows the
// pointer; the others make room as it passes over them (a short slide), and the order is
// reported once it is let go.

const MOVE_PX = 5; // a press that moves less is a click, not a drag
const SLIDE_MS = 160;

/**
 * @param {HTMLElement} container  the grid; its direct children matching `item` are the cards
 * @param {{ item: string, handle: string, keyOf: (el: HTMLElement) => string,
 *   onOrder: (keys: string[]) => void, onLive?: (container: HTMLElement) => void }} options
 *   handle: where a card can be picked up (inside the card, or the card itself)
 *   onLive: after each live move (the grid's own layout fixes, like a wide last card)
 * @returns {{ dragging: () => boolean, cancel: () => void }}
 */
export function enableCardDrag(container, { item, handle, keyOf, onOrder, onLive }) {
  let drag = null; // { el, id, x, y, on, start }
  const sliding = new Set(); // cards still sliding into place: not a drop target until settled
  const cards = () => [...container.children].filter((el) => el.matches(item));
  // Where a card sits in the grid, without the translate the drag gives it.
  const placeOf = (el, dx, dy) => {
    const r = el.getBoundingClientRect();
    return { left: r.left - dx, top: r.top - dy };
  };

  function end(commit) {
    if (!drag) return;
    const { el, on, start } = drag;
    drag = null;
    if (!on) return;
    el.style.translate = "";
    el.removeAttribute("data-t3plus-dragging");
    container.removeAttribute("data-t3plus-sorting");
    const keys = cards().map(keyOf);
    if (!commit) {
      // Put the cards back as they were.
      for (const key of start) {
        const card = cards().find((c) => keyOf(c) === key);
        if (card) container.append(card);
      }
      onLive?.(container);
      return;
    }
    if (keys.join() !== start.join()) onOrder(keys);
  }

  container.addEventListener("pointerdown", (event) => {
    if (event.button !== 0 || drag) return;
    const grip = event.target?.closest?.(handle);
    const el = grip?.closest?.(item);
    if (!el || el.parentElement !== container) return;
    drag = { el, id: event.pointerId, x: event.clientX, y: event.clientY, on: false, start: cards().map(keyOf) };
  });

  container.addEventListener("pointermove", (event) => {
    if (!drag || event.pointerId !== drag.id) return;
    let dx = event.clientX - drag.x;
    let dy = event.clientY - drag.y;
    if (!drag.on) {
      if (Math.hypot(dx, dy) < MOVE_PX) return;
      drag.on = true;
      try {
        drag.el.setPointerCapture?.(event.pointerId);
      } catch {}
      drag.el.setAttribute("data-t3plus-dragging", "");
      container.setAttribute("data-t3plus-sorting", "");
    }
    event.preventDefault();
    const { el } = drag;
    const others = cards().filter((c) => c !== el);
    const over = others.find((c) => {
      if (sliding.has(c)) return false;
      const r = c.getBoundingClientRect();
      return event.clientX >= r.left && event.clientX <= r.right && event.clientY >= r.top && event.clientY <= r.bottom;
    });
    if (over) {
      const before = placeOf(el, dx, dy);
      const was = new Map(others.map((c) => [c, c.getBoundingClientRect()]));
      // Moving back: in front of the card; moving on: after it.
      const forward = cards().indexOf(over) > cards().indexOf(el);
      container.insertBefore(el, forward ? over.nextSibling : over);
      onLive?.(container);
      // Keep the card under the pointer: its grid place moved, so does where it started.
      const after = placeOf(el, dx, dy);
      drag.x += after.left - before.left;
      drag.y += after.top - before.top;
      dx = event.clientX - drag.x;
      dy = event.clientY - drag.y;
      // The others slide from where they were to their new places.
      for (const [c, r] of was) {
        const n = c.getBoundingClientRect();
        const sx = r.left - n.left;
        const sy = r.top - n.top;
        if (!sx && !sy) continue;
        const anim = c.animate?.([{ translate: `${sx}px ${sy}px` }, { translate: "0 0" }], { duration: SLIDE_MS, easing: "ease-out" });
        if (anim) {
          sliding.add(c);
          anim.onfinish = anim.oncancel = () => sliding.delete(c);
        }
      }
    }
    el.style.translate = `${dx}px ${dy}px`;
  });

  container.addEventListener("pointerup", (event) => {
    if (drag && event.pointerId === drag.id) end(true);
  });
  container.addEventListener("pointercancel", () => end(false));
  container.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && drag?.on) end(false);
  });
  // No text selected or image dragged by a press on a handle.
  container.addEventListener("dragstart", (event) => {
    if (event.target?.closest?.(handle)) event.preventDefault();
  });

  return { dragging: () => Boolean(drag?.on), cancel: () => end(false) };
}
