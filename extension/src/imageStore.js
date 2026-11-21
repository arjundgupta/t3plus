import { IMAGE_LIMITS, STORAGE_KEYS } from "./config.js";
import { subscribeKey } from "./settings.js";

/** Returns an error message for a file t3+ should not accept, or null. */
export function validateImageFile(file, limits = IMAGE_LIMITS) {
  if (!file) return "No file selected.";
  if (!limits.acceptedTypes.includes(file.type)) {
    return "Use a PNG, JPEG, WebP, AVIF, or GIF image.";
  }
  if (file.size > limits.maxInputBytes) {
    return `Image is larger than ${Math.round(limits.maxInputBytes / 1024 / 1024)} MB.`;
  }
  return null;
}

/** Scales (width, height) down so the longest edge is at most `maxEdge`. Never upscales. */
export function fitWithin(width, height, maxEdge) {
  const longest = Math.max(width, height);
  if (!(longest > 0)) return { width: 0, height: 0 };
  const scale = Math.min(1, maxEdge / longest);
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

/** Decodes a base64 data URL into a Blob without fetch(), so page CSP cannot block it. */
export function dataUrlToBlob(dataUrl) {
  const match = /^data:([^;,]+)(;base64)?,(.*)$/s.exec(dataUrl);
  if (!match) throw new Error("Not a data URL");
  const [, type, isBase64, payload] = match;
  if (!isBase64) return new Blob([decodeURIComponent(payload)], { type });
  const binary = atob(payload);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type });
}

/**
 * A stored image record as the store keeps it, or null when it is not one or is larger
 * than `limits` allows (an import into the desktop app, whose cap is smaller).
 */
export function normalizeImageRecord(record, limits = IMAGE_LIMITS) {
  if (!isValidRecord(record, limits)) return null;
  return {
    dataUrl: record.dataUrl,
    name: String(record.name ?? "image").slice(0, 120),
    width: Number(record.width) || 0,
    height: Number(record.height) || 0,
    savedAt: Number(record.savedAt) || Date.now(),
  };
}

// The store itself checks the largest cap: an image stored under it (one imported before
// the desktop's smaller cap applied to imports) is still shown, never dropped.
function isValidRecord(record, limits = IMAGE_LIMITS) {
  return Boolean(
    record &&
      typeof record.dataUrl === "string" &&
      record.dataUrl.startsWith("data:image/") &&
      record.dataUrl.length <= limits.maxStoredChars,
  );
}

/**
 * Stores one user-chosen composer image in extension-local storage.
 * The image never leaves the browser.
 *
 * Record shape: { dataUrl, name, width, height, savedAt }.
 */
export function createImageStore(area, changedEvent) {
  const key = STORAGE_KEYS.image;
  return {
    async load() {
      const result = await area.get(key);
      const record = result?.[key];
      return isValidRecord(record) ? record : null;
    },
    async save(record) {
      if (!isValidRecord(record)) {
        throw new Error(
          typeof record?.dataUrl === "string" && record.dataUrl.startsWith("data:image/")
            ? "Image is too large to store after compression. Try a smaller image."
            : "That file is not an image t3+ can store.",
        );
      }
      const stored = normalizeImageRecord(record);
      await area.set({ [key]: stored });
      return stored;
    },
    async remove() {
      await area.remove(key);
    },
    subscribe(listener) {
      return subscribeKey(changedEvent, key, (next) => listener(isValidRecord(next) ? next : null));
    },
  };
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error("Could not read image"));
    reader.readAsDataURL(blob);
  });
}

/**
 * Decodes, downscales, and re-encodes an uploaded image so it fits the storage
 * cap. Animated GIFs keep only their first frame, which keeps the page static.
 * Browser-only (needs createImageBitmap and OffscreenCanvas).
 * `limits` defaults to the background image limits; the desktop build passes
 * DESKTOP_IMAGE_LIMITS (its images go into T3's own localStorage).
 */
export async function prepareImageFile(file, limits = IMAGE_LIMITS) {
  const problem = validateImageFile(file, limits);
  if (problem) throw new Error(problem);

  const bitmap = await createImageBitmap(file);
  try {
    // Try progressively smaller encodes until one fits under the cap.
    const attempts = [
      { edge: limits.maxEdgePx, quality: 0.85 },
      { edge: Math.round(limits.maxEdgePx * 0.8), quality: 0.75 },
      { edge: Math.round(limits.maxEdgePx * 0.6), quality: 0.7 },
    ];
    for (const { edge, quality } of attempts) {
      const size = fitWithin(bitmap.width, bitmap.height, edge);
      const canvas = new OffscreenCanvas(size.width, size.height);
      canvas.getContext("2d").drawImage(bitmap, 0, 0, size.width, size.height);
      const blob = await canvas.convertToBlob({ type: "image/webp", quality });
      const dataUrl = await blobToDataUrl(blob);
      if (dataUrl.length <= limits.maxStoredChars) {
        return { dataUrl, name: file.name, width: size.width, height: size.height, savedAt: Date.now() };
      }
    }
  } finally {
    bitmap.close();
  }
  throw new Error("Image is too large to store after compression. Try a smaller image.");
}
