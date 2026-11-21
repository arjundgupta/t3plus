import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { BLOB_RASTER_PX } from "../src/blobAvatars.js";
import { botArt, botFillUrl, botStill, setBlobRasterizer } from "../src/botArt.js";

// Blob sheets drawn once into a picture where the page has a canvas (content/index.js),
// SVG elsewhere. A recording 2D context stands in for the canvas here.
function recorder() {
  const calls = [];
  const sizes = [];
  class Path2D {
    constructor(d) {
      this.d = d;
    }
  }
  const ctx = {
    canvas: { ownerDocument: { defaultView: { Path2D } } },
    set fillStyle(v) { calls.push(["fillStyle", v]); },
    set strokeStyle(v) {},
    set lineCap(v) {},
    set lineWidth(v) { calls.push(["lineWidth", v]); },
  };
  for (const name of ["setTransform", "translate", "scale", "rotate", "save", "restore", "beginPath", "roundRect", "fill", "stroke"]) ctx[name] = (...args) => calls.push([name, ...args]);
  let result = "data:image/png;base64,AAAA";
  const rasterize = (width, height, draw) => {
    sizes.push([width, height]);
    draw(ctx);
    return result;
  };
  return { rasterize, calls, sizes, fail: () => (result = null) };
}
const count = (calls, name, pred = () => true) => calls.filter((c) => c[0] === name && pred(c)).length;

afterEach(() => setBlobRasterizer(null));

test("a blob sheet is drawn once into a picture: every frame's body and both eyes, at 64px a frame", () => {
  const r = recorder();
  setBlobRasterizer(r.rasterize);
  const idle = botArt("teal", "drop", "idle");
  assert.equal(idle.url, 'url("data:image/png;base64,AAAA")');
  assert.equal(idle.frames, 90, "7.5s at 12 frames a second");
  assert.deepEqual(r.sizes, [[BLOB_RASTER_PX * 90, BLOB_RASTER_PX]]);
  assert.equal(count(r.calls, "fill", (c) => c[1]?.d?.startsWith("M")), 90, "each frame's body");
  assert.equal(count(r.calls, "roundRect"), 180, "two capsule eyes a frame");
  // setTransform(a, b, c, d, e, f): each frame scaled from 24 units to 64px, in its own cell.
  const cells = r.calls.filter((c) => c[0] === "setTransform" && c[1] === BLOB_RASTER_PX / 24 && c[4] === BLOB_RASTER_PX / 24 && c[6] === 0).map((c) => c[5]);
  assert.deepEqual(cells, Array.from({ length: 90 }, (_, i) => i * BLOB_RASTER_PX));
  assert.equal(botArt("teal", "drop", "idle"), idle, "cached: drawn once");
  assert.equal(r.sizes.length, 1);
  // Happy eyes are strokes; an X too.
  const done = recorder();
  setBlobRasterizer(done.rasterize);
  const art = botArt("green", "pebble", "done");
  assert.equal(count(done.calls, "stroke"), art.frames * 2);
  assert.equal(count(done.calls, "roundRect"), 0);
});

test("SVG where there is no picture: no rasterizer, one that cannot draw, or a face shown large", () => {
  assert.match(botArt("teal", "drop", "idle").url, /^url\("data:image\/svg\+xml,/, "no rasterizer (tests, a page without a canvas)");
  const r = recorder();
  r.fail();
  setBlobRasterizer(r.rasterize);
  assert.match(botArt("teal", "egg", "idle").url, /^url\("data:image\/svg\+xml,/, "it gave nothing back");
  const ok = recorder();
  setBlobRasterizer(ok.rasterize);
  assert.match(botArt("teal", "egg", "idle", { vector: true }).url, /^url\("data:image\/svg\+xml,/, "asked for vectors (Settings' 48px face)");
  assert.equal(botArt("teal", "egg", "idle").url, 'url("data:image/png;base64,AAAA")');
  // Pixel faces are untouched by it.
  assert.equal(botArt("teal", "circle", "idle", { vector: true }).url, botArt("teal", "circle", "idle").url);
});

test("a swatch's face is one frame (an animated blob sheet squeezed the whole strip into it)", () => {
  for (const shape of ["drop", "circle", "soccer"]) {
    assert.equal(botFillUrl("purple", shape), botStill("purple", shape, "awake").url, shape);
  }
  assert.ok(decodeURIComponent(botFillUrl("purple", "drop")).includes('viewBox="0 0 24 24"'), "a blob swatch: a single 24-unit frame");
  const r = recorder();
  setBlobRasterizer(r.rasterize);
  botFillUrl("purple", "drop");
  assert.deepEqual(r.sizes, [[BLOB_RASTER_PX, BLOB_RASTER_PX]], "a still face: one 64px frame");
});
