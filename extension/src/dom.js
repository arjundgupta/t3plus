/** Tiny element builder shared by the t3+ UI. `text` sets textContent; true/false toggle boolean attributes. */
export function createBuilder(doc) {
  return function h(tag, attrs = {}, children = []) {
    const el = doc.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (v === false || v === null || v === undefined) continue;
      if (k === "text") el.textContent = v;
      else el.setAttribute(k, v === true ? "" : v);
    }
    for (const child of [].concat(children)) if (child) el.append(child);
    return el;
  };
}

let uid = 0;
/** Unique ids for label/aria wiring. */
export const uniqueId = (name) => `t3plus-${name}-${(uid += 1)}`;

/** Sets textContent only when it differs, so updates do not churn the DOM. */
export function setText(el, value) {
  const next = value ?? "";
  if (el.textContent !== next) el.textContent = next;
}

// The writes below happen only when they change something: t3+'s updates run in every
// check, slider step and feed read, and a write of the same value still restyles the
// element (and tells a screen reader about an aria-* change).

/** Sets (or, for null/undefined, removes) an attribute only when that changes it. */
export function setAttr(el, name, value) {
  if (value === null || value === undefined) {
    if (el.hasAttribute(name)) el.removeAttribute(name);
  } else if (el.getAttribute(name) !== value) {
    el.setAttribute(name, value);
  }
}

/** Sets (or, for null, removes) an inline custom property only when that changes it. */
export function setVar(el, name, value) {
  if (value === null) {
    if (el.style.getPropertyValue(name)) el.style.removeProperty(name);
  } else if (el.style.getPropertyValue(name) !== value) {
    el.style.setProperty(name, value);
  }
}

/** Shows or hides an element only when that changes it. */
export function setHidden(el, hidden) {
  if (el.hidden !== hidden) el.hidden = hidden;
}
