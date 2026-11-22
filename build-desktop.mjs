// Builds the desktop bundle (minified) from extension/ into ~/.t3plus/dist.
//   node ~/.t3plus/build-desktop.mjs <path to the extension folder, with `npm ci` done>
// Written into a scratch folder first and moved into place file by file, so a
// window reload during a build never loads half-written files.
import { copyFileSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
const src = resolve(process.argv[2] ?? ".");
const out = join(homedir(), ".t3plus", "dist");
const work = `${out}.building`;
const esbuild = createRequire(join(src, "package.json"))("esbuild");
rmSync(work, { recursive: true, force: true });
mkdirSync(work, { recursive: true });
mkdirSync(out, { recursive: true });
await esbuild.build({ entryPoints: [join(src, "src/content/index.js")], outfile: join(work, "content.js"), bundle: true, format: "iife", target: "chrome120", minify: true, legalComments: "eof", define: { __T3PLUS_FEED_BASE__: '""' }, logLevel: "warning" });
await esbuild.build({ entryPoints: [join(src, "src/styles/content.css")], outfile: join(work, "content.css"), minify: true, logLevel: "warning" });
for (const sample of ["sample-spectrum.svg", "sample-spectrum-light.svg"]) copyFileSync(join(src, `assets/${sample}`), join(work, sample));
for (const file of ["sample-spectrum.svg", "sample-spectrum-light.svg", "content.css", "content.js"]) renameSync(join(work, file), join(out, file));
rmSync(work, { recursive: true, force: true });
console.log("built", out);
