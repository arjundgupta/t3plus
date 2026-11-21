import assert from "node:assert/strict";
import { test } from "node:test";
import { IMAGE_LIMITS, STORAGE_KEYS } from "../src/config.js";
import { createImageStore, dataUrlToBlob, fitWithin, validateImageFile } from "../src/imageStore.js";
import { createFakeChromeStorage, fakeImageRecord } from "./helpers.js";

test("validateImageFile accepts supported images and rejects others", () => {
  assert.equal(validateImageFile({ type: "image/png", size: 1000 }), null);
  assert.match(validateImageFile({ type: "image/svg+xml", size: 10 }), /PNG, JPEG/);
  assert.match(validateImageFile({ type: "image/jpeg", size: IMAGE_LIMITS.maxInputBytes + 1 }), /larger/);
  assert.match(validateImageFile(null), /No file/);
});

test("fitWithin downscales the longest edge and never upscales", () => {
  assert.deepEqual(fitWithin(4000, 2000, 1600), { width: 1600, height: 800 });
  assert.deepEqual(fitWithin(1000, 3000, 1600), { width: 533, height: 1600 });
  assert.deepEqual(fitWithin(800, 600, 1600), { width: 800, height: 600 });
});

test("dataUrlToBlob decodes base64 payloads", async () => {
  const blob = dataUrlToBlob(fakeImageRecord().dataUrl);
  assert.equal(blob.type, "image/webp");
  assert.equal(await blob.text(), "fake-webp-bytes");
});

test("image store saves, loads, and removes one local image", async () => {
  const storage = createFakeChromeStorage();
  const store = createImageStore(storage.area, storage.onChanged);
  assert.equal(await store.load(), null);

  await store.save(fakeImageRecord("sky.png"));
  const loaded = await store.load();
  assert.equal(loaded.name, "sky.png");
  assert.ok(storage.area.data.has(STORAGE_KEYS.image));

  await store.remove();
  assert.equal(await store.load(), null);
});

test("image store refuses oversized or non-image data", async () => {
  const storage = createFakeChromeStorage();
  const store = createImageStore(storage.area, storage.onChanged);
  const huge = { ...fakeImageRecord(), dataUrl: `data:image/webp;base64,${"A".repeat(IMAGE_LIMITS.maxStoredChars)}` };
  await assert.rejects(store.save(huge), /too large/);
  await assert.rejects(store.save({ ...fakeImageRecord(), dataUrl: "data:text/html,<script>" }), /not an image/);
  assert.equal(storage.area.data.size, 0);

  // A bad value written by something else is ignored on load.
  storage.area.data.set(STORAGE_KEYS.image, { dataUrl: "javascript:alert(1)" });
  assert.equal(await store.load(), null);
});

test("an imported image record (a backup file) is checked and cleaned as a saved one is", async () => {
  const { normalizeImageRecord } = await import("../src/imageStore.js");
  const oversized = `data:image/webp;base64,${"A".repeat(IMAGE_LIMITS.maxStoredChars)}`;
  for (const bad of [null, "data:image/png;base64,AAAA", {}, { dataUrl: "javascript:alert(1)" }, { dataUrl: "data:text/html,<script>" }, { dataUrl: oversized }]) {
    assert.equal(normalizeImageRecord(bad), null, JSON.stringify(bad)?.slice(0, 60));
  }
  const record = normalizeImageRecord({ dataUrl: "data:image/png;base64,AAAA", name: "n".repeat(200), width: "1600", height: "tall", savedAt: 5, script: "dropped" });
  assert.deepEqual(record, { dataUrl: "data:image/png;base64,AAAA", name: "n".repeat(120), width: 1600, height: 0, savedAt: 5 });
  const before = Date.now();
  const bare = normalizeImageRecord({ dataUrl: "data:image/png;base64,AAAA" });
  assert.equal(bare.name, "image");
  assert.ok(bare.savedAt >= before, "given a time when it has none");
});

test("an upload is made smaller step by step until it fits the store, and its bitmap is always closed", async () => {
  const { prepareImageFile } = await import("../src/imageStore.js");
  const { DESKTOP_IMAGE_LIMITS } = await import("../src/config.js");
  // The browser's image APIs (Node has none of them): a 4000x2000 photo, each encode a
  // picture whose data URL fits the cap only at attempt `fitsAt` (0: none does).
  const globals = ["createImageBitmap", "OffscreenCanvas", "FileReader"];
  const saved = Object.fromEntries(globals.map((name) => [name, globalThis[name]]));
  let run;
  globalThis.createImageBitmap = async () => {
    run.decoded += 1;
    return { width: 4000, height: 2000, close: () => (run.closed += 1) };
  };
  globalThis.OffscreenCanvas = class {
    constructor(width, height) {
      Object.assign(this, { width, height });
    }
    getContext() {
      return { drawImage() {} };
    }
    async convertToBlob({ type, quality }) {
      run.attempts.push(`${this.width}x${this.height} ${type} ${quality}`);
      if (run.encodeFails) throw new Error("encoding failed");
      return { attempt: run.attempts.length };
    }
  };
  globalThis.FileReader = class {
    readAsDataURL(blob) {
      this.result = "data:image/webp;base64,".padEnd(blob.attempt === run.fitsAt ? run.cap : run.cap + 1, "A");
      queueMicrotask(() => this.onload());
    }
  };
  const photo = { type: "image/png", size: 4_000_000, name: "photo.png" };
  const prepare = (limits, options) => {
    run = { decoded: 0, closed: 0, attempts: [], cap: limits.maxStoredChars, fitsAt: 1, encodeFails: false, ...options };
    return prepareImageFile(options.file ?? photo, limits);
  };
  const LADDER = ["1600x800 image/webp 0.85", "1280x640 image/webp 0.75", "960x480 image/webp 0.7"];
  try {
    for (const limits of [IMAGE_LIMITS, DESKTOP_IMAGE_LIMITS]) {
      const first = await prepare(limits, { fitsAt: 1 });
      assert.deepEqual([first.name, first.width, first.height, first.dataUrl.length], ["photo.png", 1600, 800, limits.maxStoredChars]);
      assert.deepEqual([run.attempts, run.closed], [LADDER.slice(0, 1), 1], "the first that fits is kept");
      const last = await prepare(limits, { fitsAt: 3 });
      assert.deepEqual([last.width, last.height, run.attempts, run.closed], [960, 480, LADDER, 1]);
      await assert.rejects(prepare(limits, { fitsAt: 0 }), /too large to store/);
      assert.deepEqual([run.attempts, run.closed], [LADDER, 1], "none fits: an error, the bitmap closed");
      await assert.rejects(prepare(limits, { encodeFails: true }), /encoding failed/);
      assert.equal(run.closed, 1, "closed when encoding fails too");
      await assert.rejects(prepare(limits, { file: { type: "image/svg+xml", size: 100, name: "x.svg" } }), /PNG, JPEG/);
      assert.equal(run.decoded, 0, "an SVG is refused before it is decoded");
    }
  } finally {
    for (const name of globals) {
      if (saved[name] === undefined) delete globalThis[name];
      else globalThis[name] = saved[name];
    }
  }
});
