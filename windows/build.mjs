#!/usr/bin/env node
// build.sh for Windows: builds t3+ for the desktop app from extension/ into dist/, after its tests pass.
//   node ~/.t3plus/windows/build.mjs; node ~/.t3plus/t3plus.mjs on
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const extension = join(root, "extension");
const [major, minor] = process.versions.node.split(".").map(Number);
if (major < 22 || (major === 22 && minor < 2)) {
  console.error(`t3+ needs Node 22.2 or newer (this is ${process.version})`);
  process.exit(1);
}
// Local folders the loader and autostart write to (not in git).
for (const dir of ["state", "feeds"]) mkdirSync(join(root, dir), { recursive: true });

// npm is a batch file on Windows, so it needs the shell; it and what it runs use this same Node,
// not an older one that may come first on the PATH.
const pathKey = Object.keys(process.env).find((k) => k.toUpperCase() === "PATH") ?? "PATH";
const env = { ...process.env, [pathKey]: `${dirname(process.execPath)}${delimiter}${process.env[pathKey] ?? ""}` };
const npm = (command, options = {}) => spawnSync(`npm ${command}`, { cwd: extension, env, shell: true, encoding: "utf8", ...options });

if (!existsSync(join(extension, "node_modules"))) {
  const { status } = npm("ci --no-audit --no-fund --loglevel=error", { stdio: "inherit" });
  if (status !== 0) process.exit(status ?? 1);
}
const tests = npm("test", { maxBuffer: 64 << 20 });
if (tests.status !== 0) {
  const out = `${tests.stdout ?? ""}\n${tests.stderr ?? ""}`;
  console.error(out.split(/\r?\n/).filter((l) => /^not ok|^# (pass|fail)|Error|expected|actual/.test(l)).slice(0, 40).join("\n"));
  console.error("t3+ build stopped: the tests failed (run 'npm test' in ~/.t3plus/extension for the full output).");
  process.exit(1);
}
const built = spawnSync(process.execPath, [join(root, "build-desktop.mjs"), extension], { stdio: "inherit" });
process.exit(built.status ?? 1);
