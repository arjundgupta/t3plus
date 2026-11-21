import assert from "node:assert/strict";
import { test } from "node:test";
import { botArt, botStops, setBotArtEncoder } from "../src/botArt.js";

// The faces' caches: bounded (a window stays open for days, project colors are any
// #rrggbb), and what every check asks for is worked out once.

test("faces are kept by use within a bound: the least recently used is drawn again, one in use never is", () => {
  let drawn = 0;
  // Each picture 2 MB, far more than a real face's (1-60 KB), so a dozen go past the bound.
  const padding = "A".repeat(2 * 1024 * 1024);
  setBotArtEncoder((pixels, width, height, fills) => {
    drawn += 1;
    return `data:image/png;base64,${fills.join("")}${padding}`;
  });
  try {
    const color = (i) => `#${(0x102030 + i * 0x010101).toString(16)}`;
    const inUse = botArt(color(0), "circle");
    const firstUrl = botArt(color(1), "circle").url;
    for (let i = 2; i < 14; i += 1) {
      botArt(color(i), "circle");
      botArt(color(0), "circle"); // on screen: asked for in every check
    }
    assert.equal(drawn, 14, "each face drawn once so far");
    assert.equal(botArt(color(0), "circle"), inUse, "the face in use is still kept");
    assert.equal(botArt(color(13), "circle").url, botArt(color(13), "circle").url);
    assert.equal(drawn, 14, "and the newest");
    assert.equal(botArt(color(1), "circle").url, firstUrl, "one long unused is drawn again, the same");
    assert.equal(drawn, 15);
  } finally {
    setBotArtEncoder(null);
  }
});

test("a project color's ramp is built once", () => {
  const ramp = botStops("#3366cc");
  assert.equal(botStops("#3366cc"), ramp, "the same ramp each time it is asked for");
  assert.ok(Object.isFrozen(ramp), "shared, so nothing can change it");
  assert.equal(ramp[1], "#3366cc");
  assert.equal(botStops("#3366CC")[1], "#3366cc", "the mid stop is lowercase whatever the case asked for");
});
