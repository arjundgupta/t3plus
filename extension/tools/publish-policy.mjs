// The public mirror has the desktop layout: README, the loader and its scripts at
// the root, and the extension it builds in extension/. Only these paths may leave
// the private repository; anything new stays private until deliberately added here.
const rootFiles = new Set([".gitignore", "LICENSE", "README.md", "autostart.mjs", "autostart.sh", "build-desktop.mjs", "build.sh", "t3plus.mjs"]);
const rootDirectories = new Set(["inject", "launchd", "media"]);
const extensionFiles = new Set([".gitignore", "LICENSE", "README.md", "build.mjs", "manifest.base.json", "package.json", "package-lock.json"]);
const extensionDirectories = new Set(["assets", "icons", "src", "test", "tools"]);

export function isPublicPath(path) {
  const parts = path.split("/");
  if (parts.some((p) => /^(?:private|\.git|\.env(?:\..*)?|\.publish-deny|.*\.local\.json)$/i.test(p))) return false;
  if (/\.(?:pem|key|p12|pfx)$/i.test(path)) return false;
  if (parts[0] === "extension") {
    const rest = parts.slice(1);
    return extensionFiles.has(rest.join("/")) || (rest.length > 1 && extensionDirectories.has(rest[0]));
  }
  return rootFiles.has(path) || (parts.length > 1 && rootDirectories.has(parts[0]));
}

export function parseDenyPatterns(text) {
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter((line) => line && !line.startsWith("#"));
  if (!lines.length) throw new Error("Publishing needs at least one private-detail pattern in PUBLISH_DENY or .publish-deny.");
  return lines.map((line, i) => {
    try { return new RegExp(line, "i"); }
    catch { throw new Error(`Invalid private-detail pattern on entry ${i + 1}.`); }
  });
}

const builtIn = [
  /\b[a-z]:[\\/]+users[\\/]+(?!me\b|you\b)[a-z0-9._-]+/i,
  // macOS and Linux home folders name their owner ("/Users/me" and "/home/me" are fine).
  /(?:^|[\s"'`(=:])\/(?:Users|home)\/(?!me\b|you\b|dev\b|runner\b)[a-z0-9._-]+/i,
  /[a-z0-9._%+-]+@(?!users\.noreply\.github\.com)[a-z0-9-]+\.[a-z0-9.-]*[a-z]{2,}/i,
];

/** Report locations only: private values and deny patterns must not enter logs. */
export function privateDetailLocations(where, text, deny) {
  return text.split(/\r?\n/).flatMap((line, i) =>
    [...deny, ...builtIn].some((pattern) => pattern.test(line)) ? [`${where}:${i + 1}`] : []);
}

export const needsVisualReview = (path, blob) => blob.includes(0) || /\.(?:svg|png|jpe?g|gif|webp|avif|ico|pdf)$/i.test(path);
