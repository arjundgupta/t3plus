import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { crc32, deflateSync } from "node:zlib";
import { isPublicPath, metadataText, privateDetailLocations } from "../tools/publish-policy.mjs";
import { publishPublic } from "../tools/publish-public.mjs";

// The machine's own git setup (signing, hooks, templates) must not change these tests.
process.env.GIT_CONFIG_GLOBAL = "/dev/null";
process.env.GIT_CONFIG_NOSYSTEM = "1";

const bytes = (...parts) => Buffer.concat(parts.map((p) => (typeof p === "string" ? Buffer.from(p, "latin1") : Buffer.from(p))));
const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b; };
const pngChunk = (type, data) => bytes(u32(data.length), type, data, u32(crc32(bytes(type, data))));
const png = (...chunks) => bytes([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], pngChunk("IHDR", bytes(u32(1), u32(1), [8, 6, 0, 0, 0])), ...chunks, pngChunk("IDAT", deflateSync(Buffer.alloc(5))), pngChunk("IEND", Buffer.alloc(0)));
const box = (type, ...payload) => { const body = bytes(...payload); return bytes(u32(body.length + 8), type, body); };
// This file is published too: what the checks must catch is put together when it runs.
const at = (...parts) => parts.join("@");
const users = ["Users", "alice"].join("/");
const home = ["home", "alice"].join("/");

test("home folders are caught wherever a path can start, and WSL's too; URL paths and relative ones are not", () => {
  for (const text of [`file:///${users}/notes.md`, `<code>/${users}/x</code>`, `[/${home}/x]`, `{/${users}}`, `path,/${users}/x`, `/mnt/c/${users}/x`, `cd /${users}/code`]) {
    assert.deepEqual(privateDetailLocations("doc", text, []), ["doc:1"], text);
  }
  for (const text of ["/Users/me", "/home/runner", "https://example.com/home/page", "src/home/x", "../home/x", "/mnt/c/Users/me/x", "git@github.com:Acme/api.git", "123+a@users.noreply.github.com"]) {
    assert.deepEqual(privateDetailLocations("doc", text, []), [], text);
  }
  assert.deepEqual(privateDetailLocations("doc", `mail ${at("person", "example.com")}`, []), ["doc:1"]);
});

test("pictures and recordings are read for their metadata, never their pixels", () => {
  const xmp = "<x:xmpmeta><dc:creator>Person Name</dc:creator></x:xmpmeta>";
  const pictures = {
    "PNG tEXt": png(pngChunk("tEXt", bytes("Author\0Person Name"))),
    "PNG zTXt": png(pngChunk("zTXt", bytes("Comment\0", [0], deflateSync("Person Name")))),
    "PNG iTXt": png(pngChunk("iTXt", bytes("XML:com.adobe.xmp\0", [0, 0], "\0\0", xmp))),
    "PNG iTXt, deflated": png(pngChunk("iTXt", bytes("XML:com.adobe.xmp\0", [1, 0], "en\0\0", deflateSync(xmp)))),
    "PNG eXIf": png(pngChunk("eXIf", bytes("MM\0*\0\0\0\x08", [0, 1], "Person Name"))),
    // GIF: header, a 2-color table, one frame, XMP (raw text, then its 258-byte "magic
    // trailer" that ends any walk through it), a comment, the end.
    "GIF XMP and comment": bytes("GIF89a", [1, 0, 1, 0, 0x80, 0, 0], [0, 0, 0, 255, 255, 255], [0x2c, 0, 0, 0, 0, 1, 0, 1, 0, 0, 2, 2, 0x4c, 0x01, 0],
      [0x21, 0xff, 11], "XMP DataXMP", xmp, [1, ...Array.from({ length: 256 }, (_, i) => 255 - i), 0], [0x21, 0xfe, 10], "Other Name", [0], [0x3b]),
    "JPEG comment": bytes([0xff, 0xd8, 0xff, 0xfe, 0, 13], "Person Name", [0xff, 0xda, 0, 2], "pixels", [0xff, 0xd9]),
    "JPEG Exif": bytes([0xff, 0xd8, 0xff, 0xe1, 0, 19], "Exif\0\0Person Name", [0xff, 0xd9]),
    "MP4 user data": bytes(box("ftyp", "isom", u32(0)), box("moov", box("udta", box("\xa9ART", box("data", u32(1), u32(0), "Person Name"))))),
  };
  for (const [kind, blob] of Object.entries(pictures)) {
    assert.ok(blob.includes(0), `${kind} is binary`);
    assert.ok(privateDetailLocations("x", metadataText(blob), [/person name/i]).length > 0, kind);
  }
  assert.match(metadataText(pictures["GIF XMP and comment"]), /Other Name/, "the blocks after XMP are found too");
  // Compressed pixels read as text match an e-mail address often enough: three of the
  // current pictures did. Only the metadata is read.
  const media = bytes(box("ftyp", "isom", u32(0)), box("mdat", [0, 1], `${at("rB", "s.OFP")} ${at("person", "example.com")}`, [0]), box("moov", box("udta", "Lavf61")));
  assert.deepEqual(privateDetailLocations("x", metadataText(media), []), []);
  assert.equal(metadataText(bytes([0, 1, 2], "Person Name")), "", "unknown binaries: their visual review only");
});

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "t3plus-publish-a3-"));
  const cwd = join(directory, "source");
  const remote = join(directory, "public.git");
  const git = (dir, ...args) => {
    const result = spawnSync("git", args, { cwd: dir, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  await mkdir(join(cwd, "extension"), { recursive: true });
  git(cwd, "init", "-q", "-b", "main");
  git(cwd, "config", "user.name", "Test Maintainer");
  git(cwd, "config", "user.email", "test@users.noreply.github.com");
  await writeFile(join(cwd, "extension", "package.json"), '{"version":"1.0.0"}');
  await writeFile(join(cwd, "README.md"), "Public extension");
  git(cwd, "add", ".");
  git(cwd, "commit", "-q", "-m", "Initial public snapshot");
  git(cwd, "clone", "-q", "--bare", cwd, remote);
  git(cwd, "remote", "add", "public", remote);
  const commit = async (files) => {
    for (const [path, content] of Object.entries(files)) {
      await mkdir(join(cwd, path, ".."), { recursive: true });
      await writeFile(join(cwd, path), content);
    }
    git(cwd, "add", ".");
    git(cwd, "commit", "-q", "-m", "Change");
  };
  return { cwd, remoteHead: () => git(remote, "rev-parse", "main"), commit, clean: () => rm(directory, { recursive: true, force: true }) };
}

test("a picture whose metadata names someone stops the push, even after its visual review", async () => {
  const f = await fixture();
  try {
    const before = f.remoteHead();
    const options = { cwd: f.cwd, ref: "HEAD", push: true, imagesChecked: true, denyText: "internal-host", log() {} };
    await f.commit({ "media/shot.png": png(pngChunk("tEXt", bytes("Author\0someone@internal-host"))), "inject/empty.js": "" });
    await assert.rejects(publishPublic(options), (error) => error.message.includes("media/shot.png (metadata):") && !error.message.includes("internal-host"));
    assert.equal(f.remoteHead(), before);
    await f.commit({ "media/shot.png": png(pngChunk("tEXt", bytes("Software\0an editor"))) });
    const result = await publishPublic(options);
    assert.deepEqual(result.changed.sort(), ["inject/empty.js", "media/shot.png"], "every file read in one batch, an empty one too");
    assert.notEqual(f.remoteHead(), before);
  } finally {
    await f.clean();
  }
});

test("the private-detail list and the workflows stay private", { skip: spawnSync("git", ["rev-parse", "--git-dir"], { cwd: fileURLToPath(new URL("..", import.meta.url)) }).status !== 0 && "not a git checkout" }, () => {
  const top = spawnSync("git", ["rev-parse", "--show-toplevel"], { cwd: fileURLToPath(new URL("..", import.meta.url)), encoding: "utf8" }).stdout.trim();
  // publish-public reads .publish-deny at the repository root: a list of private names.
  assert.equal(spawnSync("git", ["check-ignore", "-q", "--no-index", ".publish-deny"], { cwd: top }).status, 0, ".publish-deny is ignored at the root");
  assert.equal(isPublicPath(".publish-deny"), false);
  for (const path of [".github/workflows/ci.yml", ".github/workflows/release.yml"]) assert.equal(isPublicPath(path), false, path);
});

const GUIDE = new URL("../docs/publishing.md", import.meta.url);

test("the publishing guide names only workflows that exist", { skip: !existsSync(GUIDE) && "docs/ is not in this checkout" }, () => {
  const guide = readFileSync(GUIDE, "utf8");
  const named = [...guide.matchAll(/\.github\/workflows\/[\w.-]+\.ya?ml/g)].map(([path]) => path);
  assert.ok(named.length > 0);
  for (const path of named) {
    const workflow = new URL(`../../${path}`, import.meta.url);
    assert.ok(existsSync(workflow), `${path}, at the repository root: GitHub runs no other`);
    // The repository root is the desktop layout: the package and its lockfile are in extension/.
    assert.match(readFileSync(workflow, "utf8"), /working-directory: extension\n[\s\S]*cache-dependency-path: extension\/package-lock\.json/, path);
  }
  assert.doesNotMatch(guide, /Actions →|Run workflow/, "every other step runs locally");
});
