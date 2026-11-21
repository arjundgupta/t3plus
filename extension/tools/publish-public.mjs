// Export a filtered snapshot with public/main as its only parent. Never push
// private branches or private commit subjects to the public repository.
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isMain } from "./isMain.mjs";
import { isPublicPath, metadataText, needsVisualReview, parseDenyPatterns, privateDetailLocations } from "./publish-policy.mjs";

// The repository root (the desktop layout keeps the extension in extension/).
const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

function git(cwd, args, { input, env, raw = false, maxBuffer = 64 << 20 } = {}) {
  const result = spawnSync("git", args, { cwd, input, env: { ...process.env, ...env }, encoding: raw ? "buffer" : "utf8", maxBuffer });
  // stderr may contain remote URLs or private values. Keep failures bounded.
  if (result.status !== 0) throw new Error(`git ${args[0]} failed (exit ${result.status ?? "spawn"}).`);
  return raw ? result.stdout : result.stdout.trim();
}

/** Create a Git tree containing only public paths, without changing the checkout. */
export async function publicSnapshot(cwd, ref) {
  const entries = git(cwd, ["ls-tree", "-rz", "--full-tree", ref], { raw: true }).toString("utf8").split("\0").filter(Boolean)
    .map((entry) => {
      const tab = entry.indexOf("\t");
      const [mode, type, hash] = entry.slice(0, tab).split(" ");
      return { mode, type, hash, path: entry.slice(tab + 1) };
    }).filter((entry) => isPublicPath(entry.path));
  if (!entries.length) throw new Error("Public snapshot would be empty.");
  if (entries.some((entry) => entry.type !== "blob" || !["100644", "100755"].includes(entry.mode))) {
    throw new Error("Public paths must be regular files; symlinks and submodules are not exported.");
  }
  const work = await mkdtemp(join(tmpdir(), "t3plus-index-"));
  try {
    const env = { GIT_INDEX_FILE: join(work, "index") };
    git(cwd, ["read-tree", "--empty"], { env });
    const input = entries.map(({ mode, type, hash, path }) => `${mode} ${type} ${hash}\t${path}\0`).join("");
    git(cwd, ["update-index", "-z", "--index-info"], { env, input });
    return { tree: git(cwd, ["write-tree"], { env }), entries };
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

/** The blobs' contents, in order, from one git process (one each took about 7 times as long). */
function readBlobs(cwd, hashes) {
  // A Buffer: with raw output, a string input would be read in the "buffer" encoding.
  const out = git(cwd, ["cat-file", "--batch"], { input: Buffer.from(hashes.map((hash) => `${hash}\n`).join("")), raw: true, maxBuffer: 1 << 30 });
  const blobs = [];
  let at = 0;
  for (let i = 0; i < hashes.length; i += 1) {
    // "<hash> blob <size>\n", the content, "\n".
    const eol = out.indexOf(10, at);
    const [, type, size] = out.toString("latin1", at, eol).split(" ");
    if (type !== "blob") throw new Error("git cat-file returned something other than a file.");
    blobs.push(out.subarray(eol + 1, eol + 1 + Number(size)));
    at = eol + 2 + Number(size);
  }
  return blobs;
}

/**
 * What every public file, its name, its text or a picture's metadata, would make public,
 * as locations only; and the paths of pictures and binaries, for the visual review. The
 * contents are released when it returns.
 */
function scanFiles(cwd, entries, deny) {
  const problems = [];
  const visual = new Set();
  readBlobs(cwd, entries.map((entry) => entry.hash)).forEach((blob, i) => {
    const { path } = entries[i];
    const pathProblems = privateDetailLocations("(path)", path, deny);
    problems.push(...pathProblems);
    const where = pathProblems.length ? "(private path)" : path;
    if (!blob.includes(0)) problems.push(...privateDetailLocations(where, blob.toString("utf8"), deny));
    else problems.push(...privateDetailLocations(`${where} (metadata)`, metadataText(blob), deny));
    if (needsVisualReview(path, blob)) visual.add(path);
  });
  return { problems, visual };
}

export async function publishPublic({ cwd = root, ref, push = false, imagesChecked = false, message, denyText, log = console.log } = {}) {
  // An explicit ref names a commit already here: do not fetch a newer main and
  // accidentally publish a different commit.
  if (!ref) git(cwd, ["fetch", "-q", "origin"]);
  const src = git(cwd, ["rev-parse", "--verify", `${ref ?? "origin/main"}^{commit}`]);
  const { tree, entries } = await publicSnapshot(cwd, src);
  const version = JSON.parse(git(cwd, ["show", `${src}:extension/package.json`])).version;
  const commitMessage = message ?? `t3+ ${version}`;
  const deny = parseDenyPatterns(denyText ?? process.env.PUBLISH_DENY ?? await readFile(join(cwd, ".publish-deny"), "utf8"));
  const problems = privateDetailLocations("(commit message)", commitMessage, deny);
  // The mirror commit carries this machine's git identity: it must pass the same check.
  for (const ident of ["GIT_AUTHOR_IDENT", "GIT_COMMITTER_IDENT"]) problems.push(...privateDetailLocations(`(${ident.toLowerCase()})`, git(cwd, ["var", ident]).replace(/\s+\d+\s+[+-]\d{4}$/, ""), deny));
  const scan = scanFiles(cwd, entries, deny);
  problems.push(...scan.problems);
  if (problems.length) throw new Error(`Private details found; nothing was pushed. Review: ${problems.join(", ")}`);

  git(cwd, ["fetch", "-q", "public"]);
  const previous = git(cwd, ["rev-parse", "--verify", "public/main^{commit}"]);
  const changed = git(cwd, ["diff", "--name-only", "--no-renames", "-z", `${previous}^{tree}`, tree], { raw: true })
    .toString("utf8").split("\0").filter(Boolean);
  const unreviewed = changed.filter((path) => scan.visual.has(path));
  if (unreviewed.length && !imagesChecked) throw new Error(`Changed images/binaries need visual review, then --images-checked: ${unreviewed.join(", ")}`);
  log(`${entries.length} public files checked; ${changed.length} changed file(s). Private paths and history are excluded.`);
  if (!push || !changed.length) {
    log(push ? "Public main already matches." : "Dry run. Add --push to publish.");
    return { tree, changed, head: previous };
  }
  const head = git(cwd, ["commit-tree", tree, "-p", previous, "-F", "-"], { input: commitMessage });
  // A normal push rejects races with another publisher; never force the mirror.
  git(cwd, ["push", "-q", "public", `${head}:refs/heads/main`]);
  log(`Public snapshot pushed (${head}).`);
  return { tree, changed, head };
}

if (isMain(import.meta.url)) {
  const args = process.argv.slice(2);
  const option = (name) => args.includes(name) ? args[args.indexOf(name) + 1] : undefined;
  try {
    await publishPublic({ ref: option("--ref"), push: args.includes("--push"), imagesChecked: args.includes("--images-checked"), message: option("-m") });
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
