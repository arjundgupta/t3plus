// Builds the desktop bundle (minified) from a patched t3+ checkout into ~/.t3plus/dist.
//   node ~/.t3plus/build-desktop.mjs <path to t3plus checkout with desktop.patch applied and `npm ci` done>
import { copyFileSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
const src = resolve(process.argv[2] ?? ".");
const out = join(homedir(), ".t3plus", "dist");
const esbuild = createRequire(join(src, "package.json"))("esbuild");
mkdirSync(out, { recursive: true });
await esbuild.build({ entryPoints: [join(src, "src/content/index.js")], outfile: join(out, "content.js"), bundle: true, format: "iife", target: "chrome120", minify: true, legalComments: "none", define: { __T3PLUS_FEED_BASE__: '""' }, logLevel: "warning" });
await esbuild.build({ entryPoints: [join(src, "src/styles/content.css")], outfile: join(out, "content.css"), minify: true, logLevel: "warning" });
copyFileSync(join(src, "assets/sample-spectrum.svg"), join(out, "sample-spectrum.svg"));
console.log("built", out);
