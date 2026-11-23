// What may leave the private repository, and the checks all of it passes on the way.
import { inflateSync } from "node:zlib";

// The public mirror has the desktop layout: README, the loader and its scripts at
// the root, and the extension it builds in extension/. Only these paths may leave
// the private repository; anything new stays private until deliberately added here.
const rootFiles = new Set([".gitattributes", ".gitignore", "LICENSE", "README.md", "autostart.mjs", "autostart.sh", "build-desktop.mjs", "build.sh", "platform.mjs", "t3plus.mjs"]);
const rootDirectories = new Set(["inject", "launchd", "media", "windows"]);
const extensionFiles = new Set([".gitignore", "LICENSE", "README.md", "package.json", "package-lock.json"]);
const extensionDirectories = new Set(["assets", "src", "test", "tools"]);

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
  // Windows home folders, also as WSL mounts them (/mnt/c/Users/<name>).
  /(?:\b[a-z]:|\/mnt\/[a-z])[\\/]+users[\\/]+(?!me\b|you\b)[a-z0-9._-]+/i,
  // macOS and Linux home folders name their owner ("/Users/me" and "/home/me" are fine):
  // wherever a path can start (after file://, a tag, a bracket or a comma), but not inside
  // a word or a URL's own path (example.com/home/page, src/home).
  /(?<![a-z0-9._%+-])\/(?:Users|home)\/(?!(?:me|you|dev|runner)\b)[a-z0-9._-]+/i,
  // E-mail addresses, except GitHub's noreply ones and the git@ of an SSH remote.
  /(?<![a-z0-9._%+-])(?!git@)[a-z0-9._%+-]+@(?!users\.noreply\.github\.com)[a-z0-9-]+\.[a-z0-9.-]*[a-z]{2,}/i,
];

/** Report locations only: private values and deny patterns must not enter logs. */
export function privateDetailLocations(where, text, deny) {
  return text.split(/\r?\n/).flatMap((line, i) =>
    [...deny, ...builtIn].some((pattern) => pattern.test(line)) ? [`${where}:${i + 1}`] : []);
}

export const needsVisualReview = (path, blob) => blob.includes(0) || /\.(?:svg|png|jpe?g|gif|webp|avif|ico|pdf)$/i.test(path);

// ---------- What pictures and recordings say besides their pixels ----------
// A binary gets no text scan, but where a picture or a recording records an author, a
// computer or a place is text: PNG text and Exif chunks, GIF comments and application
// data (XMP), JPEG's APPn segments (Exif, XMP, IPTC) and comments, MP4/QuickTime user data
// and metadata boxes. Only these parts are read: compressed pixels look like an e-mail
// address often enough (three of the current pictures do somewhere). Other binaries have
// their visual review only.
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const MP4_FIRST_BOXES = new Set(["ftyp", "moov", "mdat", "wide", "free", "skip"]);
// Boxes on the way to the metadata, and the metadata boxes themselves.
const MP4_PATH = new Set(["moov", "trak"]);
const MP4_METADATA = new Set(["udta", "meta", "uuid", "Xtra"]);

/** Bytes as lines of text: control characters and broken UTF-8 end a line. */
const asText = (bytes) => bytes.toString("utf8").replace(/[\0-\x08\x0b-\x1f\x7f\ufffd]+/g, "\n");
const inflated = (bytes) => {
  try {
    return inflateSync(bytes);
  } catch {
    return Buffer.alloc(0); // not deflate after all: there is no text to read in it
  }
};

function pngParts(blob) {
  const parts = [];
  for (let at = PNG_SIGNATURE.length; at + 12 <= blob.length; ) {
    const length = blob.readUInt32BE(at);
    const type = blob.toString("latin1", at + 4, at + 8);
    if (type === "IEND") break;
    const data = blob.subarray(at + 8, at + 8 + length);
    if (type === "tEXt" || type === "eXIf") {
      parts.push(data);
    } else if (type === "zTXt" || type === "iTXt") {
      // zTXt: a keyword, \0, a method byte, then the deflated text. iTXt: a keyword, \0, a
      // compression flag and method, a language and a translated keyword (each \0-ended),
      // then the text, deflated when the flag says so.
      const keyword = data.indexOf(0);
      const text = type === "zTXt" ? keyword + 2 : data.indexOf(0, data.indexOf(0, keyword + 3) + 1) + 1;
      const deflated = type === "zTXt" || data[keyword + 1] === 1;
      parts.push(data.subarray(0, text), deflated ? inflated(data.subarray(text)) : data.subarray(text));
    }
    at += 12 + length;
  }
  return parts;
}

/** Where a GIF's run of sub-blocks starting at `at` ends (its \0). */
function gifBlocksEnd(blob, at) {
  while (at < blob.length && blob[at] !== 0) at += blob[at] + 1;
  return at;
}

function gifParts(blob) {
  const parts = [];
  const colorTable = (flags) => (flags & 0x80 ? 3 * 2 ** ((flags & 7) + 1) : 0);
  for (let at = 13 + colorTable(blob[10]); at < blob.length; ) {
    if (blob[at] === 0x21) {
      // An extension. A comment's or an application's bytes are kept whole: XMP is raw
      // text that the sub-block lengths cut through.
      const end = gifBlocksEnd(blob, at + 2);
      if (blob[at + 1] === 0xfe || blob[at + 1] === 0xff) parts.push(blob.subarray(at + 2, end));
      at = end + 1;
    } else if (blob[at] === 0x2c) {
      // A frame: its descriptor, colors and compressed pixels, skipped.
      at = gifBlocksEnd(blob, at + 11 + colorTable(blob[at + 9])) + 1;
    } else {
      break; // the trailer
    }
  }
  return parts;
}

function jpegParts(blob) {
  const parts = [];
  for (let at = 2; at + 4 <= blob.length && blob[at] === 0xff; ) {
    const marker = blob[at + 1];
    if (marker === 0xda || marker === 0xd9) break; // the image data, or the end
    const end = at + 2 + blob.readUInt16BE(at + 2);
    if ((marker >= 0xe0 && marker <= 0xef) || marker === 0xfe) parts.push(blob.subarray(at + 4, end));
    at = end;
  }
  return parts;
}

function mp4Parts(blob, from = 0, to = blob.length, parts = []) {
  for (let at = from; at + 8 <= to; ) {
    let size = blob.readUInt32BE(at);
    let header = 8;
    if (size === 1 && at + 16 <= to) {
      size = Number(blob.readBigUInt64BE(at + 8));
      header = 16;
    } else if (size === 0) {
      size = to - at; // runs to the end
    }
    if (size < header || at + size > to) break; // not a box after all
    const type = blob.toString("latin1", at + 4, at + 8);
    if (MP4_PATH.has(type)) mp4Parts(blob, at + header, at + size, parts);
    else if (MP4_METADATA.has(type)) parts.push(blob.subarray(at + header, at + size));
    at += size;
  }
  return parts;
}

/** The metadata text of a PNG, GIF, JPEG or MP4/QuickTime file; "" for anything else. */
export function metadataText(blob) {
  const parts = blob.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE) ? pngParts(blob)
    : /^GIF8[79]a$/.test(blob.toString("latin1", 0, 6)) ? gifParts(blob)
    : blob[0] === 0xff && blob[1] === 0xd8 ? jpegParts(blob)
    : MP4_FIRST_BOXES.has(blob.toString("latin1", 4, 8)) ? mp4Parts(blob)
    : [];
  return parts.map(asText).join("\n");
}
