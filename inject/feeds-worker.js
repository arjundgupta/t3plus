// t3+ data feeds, worker side (started by inject/feeds.js inside T3 Code's main
// process). Everything that reads files, T3's database or T3's API, and every
// feed write, happens here, so T3's main thread only passes two small messages
// per publish. T3's database is opened read-only. The one thing t3+ makes in T3 is
// the read-only API session for the home feed (T3's CLI issues it; it is reused for
// a quarter of an hour, then revoked), which T3 records like any session.
"use strict";
const { parentPort, workerData, threadId } = require("worker_threads");
const fs = require("fs");
const path = require("path");
const os = require("os");
const cp = require("child_process");
const { DatabaseSync } = require("node:sqlite");
const cfg = workerData; // { t3Home, home, t3Cli, timeZone }
const log = (...a) => parentPort.postMessage({ log: a.map(String) });
const HOME = os.homedir();
const MARKER = "[[t3plus:bot:v1]]";
const MAX_TEXT = 280;
const MAX_BOTS = 64;
const MAX_SUBAGENTS = 12;
const DONE = new Set(["completed", "failed", "interrupted", "cancelled", "canceled"]);
let computer = "";
try { computer = cp.execFileSync("scutil", ["--get", "ComputerName"], { encoding: "utf8", timeout: 5000 }).trim(); } catch {}
computer = (process.env.T3PLUS_COMPUTER || computer || os.hostname() || "").slice(0, 32);
computer = computer.slice(0, 1).toUpperCase() + computer.slice(1);
cfg.computer = computer;

function db() {
  return new DatabaseSync(path.join(cfg.t3Home, "userdata", "statev2.sqlite"), { readOnly: true });
}
const json = (s) => { try { return JSON.parse(s); } catch { return null; } };

/** Markdown to one plain line: drop code fences, links, emphasis and headings. */
function plain(text) {
  let t = String(text ?? "").replace(/```[\s\S]*?```/g, " ");
  // A preview's worth of what is left: the rules below scan ahead from each mark, which
  // over a 60 KB line took seconds, and only MAX_TEXT characters are kept in the end.
  t = t.trimStart().slice(0, 16 * MAX_TEXT);
  t = t.replace(/!\[[^\]]*\]\([^)]*\)/g, " ");
  t = t.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1");
  t = t.replace(/`([^`]*)`/g, "$1");
  // Emphasis within a line, and not too long; "_" only at a word's edges, as in CommonMark
  // (user_id and snake_case_name keep theirs).
  t = t.replace(/(\*\*|\*|~~)(?=\S)([^\n]{1,200}?)(?<=\S)\1/g, "$2");
  t = t.replace(/(?<![\p{L}\p{N}_])(__|_)(?=\S)([^\n]{1,200}?)(?<=\S)\1(?![\p{L}\p{N}_])/gu, "$2");
  t = t.replace(/^\s{0,3}(#{1,6}\s+|>\s?|[-*+]\s+|\d+\.\s+)/gm, "");
  t = t.replace(/\s+/g, " ").trim();
  const chars = [...t];
  return chars.length > MAX_TEXT ? chars.slice(0, MAX_TEXT - 1).join("") + "…" : t;
}

function modelLabel(model) {
  let m = /^claude-([a-z]+)-(\d+)-(\d+)(?:-.*)?$/.exec(model || "");
  if (m) return m[1][0].toUpperCase() + m[1].slice(1) + " " + m[2] + "." + m[3];
  m = /^gpt-([\d.]+)(?:-(.+))?$/.exec(model || "");
  if (m) return "GPT-" + m[1] + (m[2] ? " " + m[2].replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()) : "");
  return (model || "").slice(0, 32);
}

// ---------- Spend per thread (provider session logs, priced like T3's Usage page) ----------
// The same rules as T3's usage pricing (server: usagePricing, priceUsage): T3's rate
// file read the way T3 reads it (long-context tiers, fast and ultrafast prices, model
// aliases), each request priced on its own (a prompt over a tier's threshold takes
// that tier's rates), and a cost the log reports itself taken as it is. Tokens are
// kept per model, speed and tier, and priced when a feed is published, with the rates
// T3 has then.
const RATES_FILE = path.join(cfg.t3Home, "userdata", "usage-model-rates.json");
let rateTable = new Map();
let ratesStamp = null;
const finite = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);
function readTokenRates(entry, suffix, standard, outputFallback) {
  const input = finite(entry["input_cost_per_token" + suffix]);
  const output = finite(entry["output_cost_per_token" + suffix]) ?? outputFallback ?? null;
  if (input === null || output === null) return null;
  const cacheRate = (name, field, fallback = input) => finite(entry[name + suffix]) ?? (standard && standard.input > 0 ? (standard[field] / standard.input) * input : fallback);
  const write = cacheRate("cache_creation_input_token_cost", "write");
  return { input, output, read: cacheRate("cache_read_input_token_cost", "read"), write, write1h: cacheRate("cache_creation_input_token_cost_above_1hr", "write1h", write) };
}
const scaleRates = (r, k) => ({ input: r.input * k, output: r.output * k, read: r.read * k, write: r.write * k, write1h: r.write1h * k });
function readSpeedRates(entry, standard, suffix = "") {
  const fastMultiple = finite(entry.provider_specific_entry && entry.provider_specific_entry.fast);
  return { ...standard, fast: fastMultiple && fastMultiple > 0 ? scaleRates(standard, fastMultiple) : readTokenRates(entry, suffix + "_priority", standard), ultrafast: readTokenRates(entry, suffix + "_ultrafast", standard) };
}
function readContextTiers(entry, base) {
  const thresholds = new Set();
  for (const key of Object.keys(entry)) { const m = /^input_cost_per_token_above_(\d{1,7})k_tokens(?:_priority|_ultrafast)?$/.exec(key); if (m) thresholds.add(m[1]); }
  return [...thresholds].map((t) => {
    const suffix = "_above_" + t + "k_tokens";
    const standard = readTokenRates(entry, suffix, base, base.output) ?? base;
    return { threshold: Number(t) * 1000, rate: readSpeedRates(entry, standard, suffix) };
  }).sort((a, b) => b.threshold - a.threshold);
}
const rateKey = (model) => String(model || "").trim().toLowerCase();
const bareName = (key) => key.slice(key.lastIndexOf("/") + 1);
const UNPRICEABLE = new Set(["<synthetic>", "synthetic", "opus", "sonnet", "haiku", "fable"]);
const FIRST_PARTY = new Set(["anthropic", "deepseek", "gemini", "meta", "mistral", "openai", "xai"]);
function parseRateTable(document) {
  const table = new Map();
  if (!document || typeof document !== "object") return table;
  for (const [name, raw] of Object.entries(document)) {
    if (!raw || typeof raw !== "object") continue;
    const standard = readTokenRates(raw, "");
    const key = rateKey(name);
    if (standard && key) table.set(key, { ...readSpeedRates(raw, standard), tiers: readContextTiers(raw, standard) });
  }
  // "provider/model" and Bedrock's "anthropic.model" also answer to the bare name
  // (a first-party provider's rate wins), as in T3.
  const aliases = new Map();
  for (const [key, rate] of table) {
    const slash = key.indexOf("/");
    const alias = slash === -1 ? (key.startsWith("anthropic.") ? key.slice(10) : key) : bareName(key);
    if (!alias || alias === key || table.has(alias)) continue;
    const firstParty = slash !== -1 && FIRST_PARTY.has(key.slice(0, slash));
    const held = aliases.get(alias);
    if (!held || (firstParty && !held.firstParty)) aliases.set(alias, { rate, firstParty });
  }
  for (const [alias, { rate }] of aliases) table.set(alias, rate);
  return table;
}
function loadRates() {
  let stamp = null;
  try { const st = fs.statSync(RATES_FILE); stamp = st.mtimeMs + ":" + st.size; } catch {}
  if (stamp === ratesStamp) return;
  ratesStamp = stamp;
  try { rateTable = parseRateTable(JSON.parse(fs.readFileSync(RATES_FILE, "utf8")).document); } catch { rateTable = new Map(); }
}
function rateFor(model) {
  const key = rateKey(model).replace(/\[.*$/, ""); // "model[1m]": the variant is priced as the model
  if (!key || UNPRICEABLE.has(bareName(key))) return null;
  return rateTable.get(key) ?? null;
}
// [uncached input, cache read, 5-minute cache write, 1-hour cache write, output]
const promptOf = (p) => p[0] + p[1] + p[2] + p[3];
const addParts = (a, b) => a.map((v, i) => v + (Number(b[i]) || 0));
/** The tier a request falls in, with today's rates: its threshold, or, with no rate known yet, its prompt in thousands (exact later). */
function tierOf(model, parts) {
  const rate = rateFor(model);
  const prompt = promptOf(parts);
  if (!rate) return "k" + Math.ceil(prompt / 1000);
  return String(rate.tiers.find((t) => prompt > t.threshold)?.threshold ?? 0);
}
function ratesAt(rate, speed, tier) {
  const t = tier.startsWith("k") ? rate.tiers.find((x) => Number(tier.slice(1)) * 1000 > x.threshold) : rate.tiers.find((x) => String(x.threshold) === tier);
  const base = t ? t.rate : rate;
  if (speed === "standard") return base;
  return base[speed] ?? rate[speed] ?? base;
}
/** One request into a log's tally: { "model|speed|tier": parts } plus costs the log reported itself. */
function tally(entry, model, speed, parts, reported) {
  if (reported !== null) { entry.reported = (entry.reported || 0) + reported; entry.reportedTokens = (entry.reportedTokens || 0) + parts.reduce((n, v) => n + v, 0); return; }
  const key = model + "|" + speed + "|" + tierOf(model, parts);
  entry.agg[key] = addParts(entry.agg[key] || [0, 0, 0, 0, 0], parts);
}
function entrySpend(entry) {
  let usd = entry.reported || 0;
  let tokens = entry.reportedTokens || 0;
  const all = Object.entries(entry.agg || {});
  // Each log's message still being written (counted once, if no other log has it).
  const pending = new Set();
  for (const f of Object.values(entry.files || {})) {
    const p = f.pending;
    if (!p || seenOf(entry).has(p.key) || pending.has(p.key)) continue;
    pending.add(p.key);
    all.push([p.model + "|" + p.speed + "|" + tierOf(p.model, p.parts), p.parts, p.reported]);
    for (const a of Object.values(p.advisors || {})) all.push([a.model + "|" + p.speed + "|" + tierOf(a.model, a.parts), a.parts]);
  }
  for (const [key, p, reported] of all) {
    tokens += p.reduce((n, v) => n + v, 0);
    if (typeof reported === "number") { usd += reported; continue; }
    const [model, speed, tier] = key.split("|");
    const rate = rateFor(model);
    if (!rate) continue;
    const r = ratesAt(rate, speed, tier);
    usd += p[0] * r.input + p[1] * r.read + p[2] * r.write + p[3] * r.write1h + p[4] * r.output;
  }
  return [usd, tokens];
}
const SPEND_CACHE = path.join(cfg.home, "state", "spend-cache.json");
let spendCache = null;
// Written once it changed (a log read further, an entry new, renewed or forgotten), at most
// every SPEND_WRITE_MS and on dispose: written whole on every publish while a bot worked, it
// was megabytes every few seconds. A copy a little behind only means a little log read again.
const SPEND_WRITE_MS = 30 * 1000;
let spendDirty = false;
let spendWrittenAt = 0;
let spendWriteTimer = null;
/** Writes the cache now, if it changed. */
function writeSpendCache() {
  clearTimeout(spendWriteTimer);
  spendWriteTimer = null;
  if (!spendDirty || !spendCache) return;
  const files = {};
  for (const [id, entry] of Object.entries(spendCache)) {
    const { seenSet, ...kept } = entry;
    files[id] = seenSet ? { ...kept, seen: [...seenSet] } : kept;
  }
  try {
    writeAtomic(SPEND_CACHE, JSON.stringify({ v: SPEND_CACHE_VERSION, files }));
    spendDirty = false;
    spendWrittenAt = Date.now();
  } catch {}
}
/** Writes a changed cache now, or once SPEND_WRITE_MS have passed since the last write. */
function saveSpendCache() {
  if (!spendDirty || spendWriteTimer) return;
  const wait = spendWrittenAt + SPEND_WRITE_MS - Date.now();
  if (wait <= 0) writeSpendCache();
  else spendWriteTimer = setTimeout(writeSpendCache, wait);
}
// New whole lines of a log since entry.offset that contain one of `needles`, in file
// order, read in 8 MB chunks. Only those lines are decoded: a session log can be far
// larger than a string may be (one here is 700 MB), and most of its bytes are text
// t3+ never looks at. ASCII needles match in UTF-8 bytes exactly as in the decoded text.
const CHUNK = 8 << 20;
function* newLines(file, entry, size, needles) {
  let from = entry.offset || 0;
  if (size <= from) return;
  const keys = needles.map((n) => Buffer.from(n));
  const fd = fs.openSync(file, "r");
  try {
    let carry = null; // a line cut by the chunk edge
    let pos = from;
    while (pos < size) {
      const buf = Buffer.allocUnsafe(Math.min(CHUNK, size - pos));
      const got = fs.readSync(fd, buf, 0, buf.length, pos);
      if (got <= 0) break;
      pos += got;
      const data = carry ? Buffer.concat([carry, buf.subarray(0, got)]) : buf.subarray(0, got);
      const end = data.lastIndexOf(10); // "\n": only whole lines
      if (end < 0) { carry = data; continue; }
      carry = end + 1 < data.length ? Buffer.from(data.subarray(end + 1)) : null;
      const lines = [];
      const next = keys.map((k) => data.indexOf(k));
      let at = 0;
      for (;;) {
        let hit = -1;
        for (let i = 0; i < keys.length; i += 1) {
          if (next[i] >= 0 && next[i] < at) next[i] = data.indexOf(keys[i], at);
          if (next[i] >= 0 && next[i] <= end && (hit < 0 || next[i] < hit)) hit = next[i];
        }
        if (hit < 0) break;
        const lineStart = data.lastIndexOf(10, hit) + 1;
        const lineEnd = data.indexOf(10, hit);
        lines.push(data.toString("utf8", lineStart, lineEnd));
        at = lineEnd + 1;
      }
      from += end + 1;
      entry.offset = from;
      yield lines;
    }
  } finally {
    fs.closeSync(fd);
  }
}
const tokenCount = (v) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.floor(v) : 0);
// A thread's logs repeat each other (a resumed Claude session copies the earlier
// messages into its new log; a forked Codex session its earlier requests): each is
// counted once per thread, by a short hash of its id, as T3 counts it once overall.
function shortHash(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) { h ^= text.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(36) + text.length.toString(36);
}
/** The ids a thread's logs have counted, as a Set (the cache file keeps a list, dropped once it is one). */
function seenOf(entry) {
  if (!entry.seenSet) {
    entry.seenSet = new Set(entry.seen || []);
    delete entry.seen;
  }
  return entry.seenSet;
}
function firstTime(entry, key) {
  const seen = seenOf(entry);
  if (seen.has(key)) return false;
  seen.add(key);
  return true;
}
function claudeRequestParts(u) {
  const write = tokenCount(u.cache_creation_input_tokens);
  const oneHour = Math.min(tokenCount(u.cache_creation && u.cache_creation.ephemeral_1h_input_tokens), write);
  return [tokenCount(u.input_tokens), tokenCount(u.cache_read_input_tokens), write - oneHour, oneHour, tokenCount(u.output_tokens)];
}
function readClaude(file, entry, f, size) {
  entry.agg ||= {};
  // Claude Code writes a message once per content block, its usage growing: each
  // message counts once, at the largest of each count (as T3 merges the copies).
  const commit = () => {
    const p = f.pending;
    f.pending = null;
    if (!p || !firstTime(entry, p.key)) return;
    tally(entry, p.model, p.speed, p.parts, p.reported);
    for (const a of Object.values(p.advisors || {})) tally(entry, a.model, p.speed, a.parts, null);
  };
  for (const lines of newLines(file, f, size, ['"usage"'])) {
    for (const line of lines) {
      if (!line.includes('"usage"')) continue;
      const d = json(line);
      const m = d && d.type === "assistant" ? d.message : null;
      const u = m && m.usage;
      if (!u || typeof u !== "object" || !m.model || m.model === "<synthetic>") continue;
      const id = m.id || d.requestId ? (m.id || "") + ":" + (d.requestId || "") : null;
      const speed = u.speed === "fast" ? "fast" : "standard";
      const parts = claudeRequestParts(u);
      const reported = typeof d.costUSD === "number" && Number.isFinite(d.costUSD) ? d.costUSD : null;
      if (f.pending && id !== null && f.pending.id === id) {
        f.pending.parts = f.pending.parts.map((v, i) => Math.max(v, parts[i]));
        if (reported !== null) f.pending.reported = Math.max(f.pending.reported ?? 0, reported);
      } else {
        commit();
        f.pending = { id, key: "c" + shortHash(id ?? line), model: m.model, speed, parts, reported };
      }
      // An advisor model's turns inside the message are their own requests (merged
      // across the message's copies like the message itself).
      for (const [i, it] of (Array.isArray(u.iterations) ? u.iterations : []).entries()) {
        if (!it || it.type !== "advisor_message" || !it.model || it.model === "<synthetic>") continue;
        const advisors = (f.pending.advisors ||= {});
        const next = claudeRequestParts(it);
        advisors[i] = { model: it.model, parts: advisors[i] ? advisors[i].parts.map((v, k) => Math.max(v, next[k])) : next };
      }
    }
  }
}
const CODEX_FIELDS = ["input_tokens", "cached_input_tokens", "output_tokens", "reasoning_output_tokens", "total_tokens"];
function readCodex(file, entry, f, size) {
  entry.agg ||= {};
  for (const lines of newLines(file, f, size, ['"turn_context"', '"thread_settings_applied"', '"token_count"'])) {
    for (const line of lines) {
      const d = json(line);
      const p = d && d.payload;
      if (!p) continue;
      if (d.type === "turn_context" && p.model) { f.model = p.model; continue; }
      if (p.type === "thread_settings_applied") {
        const tier = p.thread_settings && p.thread_settings.service_tier;
        f.speed = tier === "priority" || tier === "fast" ? "fast" : tier === "ultrafast" ? "ultrafast" : "standard";
        continue;
      }
      if (p.type !== "token_count" || !p.info || !f.model) continue;
      // Each request's own usage (last_token_usage), priced at its model and speed;
      // a repeat (the running total unchanged) is not counted again.
      const last = p.info.last_token_usage;
      const total = p.info.total_token_usage;
      if (!last || typeof last !== "object") continue;
      if (total && f.total && CODEX_FIELDS.every((k) => total[k] === f.total[k])) continue;
      if (total) f.total = Object.fromEntries(CODEX_FIELDS.map((k) => [k, total[k]]));
      const input = tokenCount(last.input_tokens);
      const cached = tokenCount(last.cached_input_tokens);
      const write = tokenCount(last.cache_write_input_tokens);
      const output = tokenCount(last.output_tokens);
      if (input + output === 0) continue;
      if (!firstTime(entry, "x" + shortHash(String(d.timestamp) + JSON.stringify(last)))) continue; // a fork's copy
      tally(entry, f.model, f.speed || "standard", [Math.max(0, input - cached - write), cached, write, 0, output], null);
    }
  }
}
function listDir(dir) { try { return fs.readdirSync(dir); } catch { return []; } }
// Where the logs are: the default homes, the ones the environment names, and every
// home T3's own usage scan reads (a provider instance with its own home), as T3's
// last usage answer listed them (state/usage-homes.json).
const HOMES_FILE = path.join(cfg.home, "state", "usage-homes.json");
/** Transcript folders: Claude's <home>/projects, Codex's <home>/sessions (T3 lists the same). */
function logRoots(provider) {
  const sub = provider === "claude" ? "projects" : "sessions";
  const env = (provider === "claude" ? process.env.CLAUDE_CONFIG_DIR : process.env.CODEX_HOME) || "";
  const roots = new Set([path.join(HOME, provider === "claude" ? ".claude" : ".codex", sub), ...(env.trim() ? [path.join(env.trim(), sub)] : [])]);
  try { for (const dir of JSON.parse(fs.readFileSync(HOMES_FILE, "utf8"))[provider] || []) if (typeof dir === "string" && dir) roots.add(dir); } catch {}
  return [...roots];
}
/** Every Codex session log: [name, file], from its <root>/<year>/<month>/<day> folders. */
function codexLogs() {
  const logs = [];
  for (const root of logRoots("codex")) {
    for (const y of listDir(root)) for (const m of listDir(path.join(root, y))) for (const d of listDir(path.join(root, y, m))) {
      for (const f of listDir(path.join(root, y, m, d))) if (f.startsWith("rollout-") && f.endsWith(".jsonl")) logs.push([f, path.join(root, y, m, d, f)]);
    }
  }
  return logs;
}
/** A session's main log files. `codex()` lists the Codex logs (one walk of their folders, shared by the sessions looked up together). */
function sessionFiles(driver, nativeId, codex) {
  const found = [];
  if (driver === "claudeAgent") {
    for (const root of logRoots("claude")) {
      for (const project of listDir(root)) {
        const main = path.join(root, project, nativeId + ".jsonl");
        if (!fs.existsSync(main) || found.some(([, f]) => f === main)) continue;
        found.push(["claude", main]); // its subagents' logs are listed on every pass (withSubagents): new ones keep appearing
      }
    }
  } else if (driver === "codex") {
    const tail = "-" + nativeId + ".jsonl"; // rollout-<time>-<id>.jsonl
    for (const [name, file] of codex()) if (name.endsWith(tail)) found.push(["codex", file]);
  }
  return found;
}
// "driver:nativeId" -> { files, at }: main session files (they do not move). One not
// found (a remote machine's thread, a log elsewhere) is looked for again only now and
// then: for Codex that takes a walk of every day folder (one for all the sessions looked
// for in a publish: one each took a second for 64 of a remote machine's threads).
const fileIndex = new Map();
const MISSING_RETRY_MS = 10 * 60 * 1000;
function withSubagents(files, nativeId) {
  const out = [];
  for (const entry of files) {
    out.push(entry);
    if (entry[0] !== "claude") continue;
    const subs = path.join(path.dirname(entry[1]), nativeId, "subagents");
    for (const f of listDir(subs)) if (f.endsWith(".jsonl")) out.push(["claude", path.join(subs, f)]);
  }
  return out;
}
// The cache is per thread (v4: its logs' read positions, tokens per model, speed and
// tier, the ids counted); a cache from before is read again from the logs once.
const SPEND_CACHE_VERSION = 4;
const SPEND_KEEP_MS = 30 * 86400000;
function spendFor(conn, threadIds) {
  loadRates();
  if (!spendCache) {
    try {
      const cached = JSON.parse(fs.readFileSync(SPEND_CACHE, "utf8"));
      spendCache = cached && cached.v === SPEND_CACHE_VERSION && cached.files && typeof cached.files === "object" ? cached.files : {};
    } catch {
      spendCache = {};
    }
  }
  const now = Date.now();
  const out = {};
  const sessions = conn.prepare("SELECT payload_json FROM orchestration_v2_projection_provider_threads WHERE thread_id = ?");
  // The Codex logs, listed once for every session looked up in this publish.
  let codexListed = null;
  const codex = () => (codexListed ??= codexLogs());
  for (const threadId of threadIds) {
    let usd = 0;
    let tokens = 0;
    const refs = new Set();
    for (const row of sessions.all(threadId)) {
      const ref = json(row.payload_json)?.nativeThreadRef;
      if (ref?.nativeId && ref?.driver) refs.add(ref.driver + ":" + ref.nativeId);
    }
    let entry = spendCache[threadId] || { files: {}, agg: {} };
    const files = [];
    for (const ref of refs) {
      const [driver, nativeId] = [ref.slice(0, ref.indexOf(":")), ref.slice(ref.indexOf(":") + 1)];
      const known = fileIndex.get(ref);
      if (!known || (!known.files.length && now - known.at > MISSING_RETRY_MS)) fileIndex.set(ref, { files: sessionFiles(driver, nativeId, codex), at: now });
      files.push(...withSubagents(fileIndex.get(ref).files, nativeId));
    }
    // Oldest log first: a resumed session's copies are then the ones skipped.
    const sized = files.map(([kind, file]) => { try { const st = fs.statSync(file); return { kind, file, size: st.size, born: st.birthtimeMs || st.mtimeMs }; } catch { return null; } }).filter(Boolean).sort((a, b) => a.born - b.born);
    // A log that shrank (rewritten) means reading this thread again from the start.
    if (sized.some(({ file, size }) => (entry.files[file]?.offset || 0) > size)) entry = { files: {}, agg: {} };
    for (const { kind, file, size } of sized) {
      const f = (entry.files[file] ||= {});
      const from = f.offset;
      try { (kind === "claude" ? readClaude : readCodex)(file, entry, f, size); } catch {}
      if (f.offset !== from) spendDirty = true;
    }
    // Daily, so this alone rewrites the cache once a day at most.
    if (now - (entry.seenAt || 0) > 86400000) {
      entry.seenAt = now;
      spendDirty = true;
    }
    spendCache[threadId] = entry;
    [usd, tokens] = entrySpend(entry);
    if (tokens) out[threadId] = { usd: Math.round(usd * 1e4) / 1e4, tokens };
  }
  // Logs of threads not looked at in a month are forgotten (read again if they come back).
  for (const [id, entry] of Object.entries(spendCache)) {
    if (entry && now - (entry.seenAt || 0) <= SPEND_KEEP_MS) continue;
    delete spendCache[id];
    spendDirty = true;
  }
  saveSpendCache();
  return out;
}

/** The statements subagents() runs for each bot, prepared once per publish. */
const subagentQueries = (conn) => ({
  latest: conn.prepare("SELECT run_id FROM orchestration_v2_projection_subagents WHERE thread_id = ? ORDER BY started_at DESC LIMIT 1"),
  run: conn.prepare("SELECT status, payload_json FROM orchestration_v2_projection_subagents WHERE thread_id = ? AND run_id = ? ORDER BY started_at"),
});
function subagents(queries, threadId) {
  const latest = queries.latest.get(threadId);
  if (!latest) return [];
  const rows = queries.run.all(threadId, latest.run_id);
  if (rows.every((r) => DONE.has(String(r.status || "")))) return [];
  return rows.slice(0, MAX_SUBAGENTS).map((r) => ({ title: plain(json(r.payload_json)?.title || "").slice(0, 60), status: String(r.status || "").slice(0, 16) }));
}

function bots(ids) {
  const conn = db();
  try {
    // ids come most wanted first (each window's open thread, then its bots top
    // down): with more than MAX_BOTS on screen, the cap drops the ones further down,
    // not an arbitrary set.
    const manual = ids.slice(0, MAX_BOTS);
    const rank = new Map(manual.map((id, i) => [id, i]));
    const rows = conn.prepare("SELECT thread_id, title, payload_json FROM orchestration_v2_projection_threads WHERE deleted_at IS NULL AND archived_at IS NULL AND (title LIKE ? OR thread_id IN (" + manual.map(() => "?").join(",") + "))").all("%" + MARKER + "%", ...manual);
    const isBot = (title) => { const w = String(title || "").split(/\s+/).filter(Boolean); return w.length > 0 && (w[0] === MARKER || w[w.length - 1] === MARKER); };
    // Read one at a time, newest first, until one has text (most often the first).
    const messages = conn.prepare("SELECT role, created_at, payload_json FROM orchestration_v2_projection_messages WHERE thread_id = ? AND role IN ('assistant', 'user') ORDER BY created_at DESC LIMIT 6");
    const subagentRuns = subagentQueries(conn);
    rows.sort((a, b) => (rank.get(a.thread_id) ?? Infinity) - (rank.get(b.thread_id) ?? Infinity));
    // Filtered before the cap: LIKE also matches a marker mid-title, and such a thread
    // took one of the MAX_BOTS places only to be dropped.
    const wanted = rows.filter((row) => isBot(row.title) || rank.has(row.thread_id));
    const out = {};
    for (const row of wanted.slice(0, MAX_BOTS)) {
      const selection = json(row.payload_json)?.modelSelection || {};
      const entry = { text: "", role: "assistant", at: null, model: modelLabel(String(selection.model || "")), computer: cfg.computer };
      for (const m of messages.iterate(row.thread_id)) {
        const text = plain(String(json(m.payload_json)?.text || ""));
        if (text) { Object.assign(entry, { text, role: m.role, at: m.created_at }); break; }
      }
      const subs = subagents(subagentRuns, row.thread_id);
      if (subs.length) entry.subagents = subs;
      out[row.thread_id] = entry;
    }
    try { for (const [id, spend] of Object.entries(spendFor(conn, Object.keys(out)))) out[id].spend = spend; } catch {}
    return out;
  } finally {
    conn.close();
  }
}

// ---------- Home: what only the database knows (projects, runs per day) ----------
const localDay = (iso) => {
  const d = new Date(iso || "");
  return Number.isFinite(d.getTime()) ? d.toLocaleDateString("en-CA") : null; // YYYY-MM-DD, machine time zone
};
function homeDatabase(activityDays) {
  const conn = db();
  try {
    // Only each project's place in the list: the page counts activity per project,
    // never by its name or folder.
    const projects = [];
    const index = new Map();
    for (const r of conn.prepare("SELECT project_id FROM projection_projects WHERE deleted_at IS NULL").all()) {
      index.set(r.project_id, projects.length);
      projects.push({});
    }
    const since = new Date(Date.now() - (activityDays + 1) * 86400000).toISOString().slice(0, 19);
    const cells = new Map(); // "day|project" -> [threads, runs]
    const threadProject = new Map();
    const cell = (day, pi) => { const k = day + "|" + pi; if (!cells.has(k)) cells.set(k, [0, 0]); return cells.get(k); };
    for (const r of conn.prepare("SELECT thread_id, project_id, created_at FROM orchestration_v2_projection_threads WHERE deleted_at IS NULL").all()) {
      threadProject.set(r.thread_id, r.project_id);
      const day = r.created_at && r.created_at >= since && index.has(r.project_id) ? localDay(r.created_at) : null;
      if (day) cell(day, index.get(r.project_id))[0] += 1;
    }
    for (const r of conn.prepare("SELECT thread_id, requested_at FROM orchestration_v2_projection_runs WHERE requested_at >= ?").all(since)) {
      const pid = threadProject.get(r.thread_id);
      const day = localDay(r.requested_at);
      if (index.has(pid) && day) cell(day, index.get(pid))[1] += 1;
    }
    const activity = {};
    const sorted = [...cells.entries()].map(([k, v]) => [k.split("|")[0], Number(k.split("|")[1]), v]).sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] - b[1]));
    for (const [day, pi, [threads, runs]] of sorted) (activity[day] ||= []).push([pi, threads, runs]);
    return { projects, activity };
  } finally {
    conn.close();
  }
}

// ---------- Feed shaping and writing (formerly on T3's main thread) ----------
const ACTIVITY_DAYS = 26 * 7;
// What T3 is asked for. Its usage scan keeps a cache of about 92 days: asked for
// more, it read every older transcript again on every publish (hundreds of MB for a
// heavy user, every five minutes). Older days are kept here instead (usageKept).
const USAGE_DAYS = 90;
const SPEND_DAYS = 62;
const HISTORY_DAYS = 8;
/** One stored limits-history sample per this long (the published series' step). */
const HISTORY_STEP_MS = 10 * 60000;
const HOUR = 3600000;

const { home, t3Home, t3Cli, timeZone } = cfg;
const feedDir = path.join(home, "feeds");
const stateDir = path.join(home, "state");
// The temporary copy is this worker's own: a worker being disposed writes its spend cache
// while the next loader's worker may already write the same files.
function writeAtomic(file, text) {
  const tmp = `${file}.${process.pid}-${threadId}.tmp`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  try {
    fs.writeFileSync(tmp, text, { mode: 0o600 });
    fs.renameSync(tmp, file);
  } catch (error) {
    try { fs.rmSync(tmp, { force: true }); } catch {}
    throw error;
  }
}
const environmentId = () => { try { return fs.readFileSync(path.join(t3Home, "userdata", "environment-id"), "utf8").trim() || null; } catch { return null; } };
const nowIso = () => new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
// Same content twice in a row keeps the file (and its time) as it is, so the page is not handed a copy that says nothing new.
const stable = (v) => JSON.stringify(v, (k, x) => (x && typeof x === "object" && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) : x));

// ---------- Bot feed ----------
let lastBots = null; // stable() of the bots last written
function publishBots(ids) {
  const next = bots(ids);
  const file = path.join(feedDir, "t3plus-bots.json");
  if (lastBots === null) { try { lastBots = stable(JSON.parse(fs.readFileSync(file, "utf8")).bots); } catch {} }
  const nextStable = stable(next);
  if (nextStable === lastBots) return false;
  writeAtomic(file, JSON.stringify({ version: 1, generatedAt: nowIso(), environmentId: environmentId(), bots: next }, null, 1));
  lastBots = nextStable;
  return true;
}

// ---------- T3's API (limits, usage summary) ----------
// On Windows T3's launcher is a batch file (t3.cmd), which only cmd.exe runs. Every word is
// quoted for it; one with a character it would still read in quotes is refused.
function cliCommand(args) {
  if (process.platform !== "win32") return [t3Cli, args, {}];
  const words = [t3Cli, ...args].map(String);
  if (words.some((w) => /["%!\r\n]/.test(w))) throw new Error("T3's CLI cannot be given these words on Windows");
  return [process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", `"${words.map((w) => `"${w}"`).join(" ")}"`], { windowsVerbatimArguments: true, windowsHide: true }];
}
const run = (args) => new Promise((resolve, reject) => {
  const [file, words, options] = cliCommand(args); // thrown here, it rejects
  cp.execFile(file, words, { ...options, timeout: 30000, encoding: "utf8" }, (e, out) => (e ? reject(e) : resolve(out)));
});
// One read-only session for several publishes, not one per publish: T3 keeps a row
// for every session it ever issued (revoked ones too), so a fresh one every five
// minutes left a trail in T3's database. It is held in this worker only, never
// written or logged, and revoked when a new one replaces it or the worker is disposed.
const SESSION_TTL_MIN = 15;
let held = null; // { token, sessionId, until }
const revoke = (id) => run(["auth", "session", "revoke", "--base-dir", t3Home, id]).catch((e) => log("session revoke failed:", e && e.message));
async function sessionNow() {
  if (held && held.until - Date.now() > 90 * 1000) return held;
  if (held) revoke(held.sessionId);
  held = null;
  const issued = await run(["auth", "session", "issue", "--base-dir", t3Home, "--ttl", SESSION_TTL_MIN + "m", "--label", "t3plus home feed", "--json", "--scope", "orchestration:read", "--scope", "diagnostics:read"]);
  let session;
  try {
    // Only the JSON object: a notice the CLI prints around it must not leave the session unrevoked.
    session = JSON.parse(issued.slice(issued.indexOf("{"), issued.lastIndexOf("}") + 1));
  } catch (e) {
    const id = (/"sessionId"\s*:\s*"([^"]+)"/.exec(issued) || [])[1];
    if (id) revoke(id);
    else log("session revoke skipped: no session id in the CLI's answer");
    throw e;
  }
  if (!session.token || !session.sessionId) throw new Error("T3 issued no session");
  held = { token: session.token, sessionId: session.sessionId, until: Date.now() + (SESSION_TTL_MIN * 60 - 30) * 1000 };
  return held;
}
function dropSession() {
  if (held) revoke(held.sessionId);
  held = null;
}

async function readT3() {
  // The protocol version is looked up while the CLI issues the session (the CLI takes ~0.4 s).
  const issuing = sessionNow();
  const looking = (async () => {
    const runtime = JSON.parse(fs.readFileSync(path.join(t3Home, "userdata", "server-runtime.json"), "utf8"));
    const base = "127.0.0.1:" + (runtime.port || 3773);
    const env = await (await fetch("http://" + base + "/.well-known/t3/environment", { signal: AbortSignal.timeout(10000) })).json();
    return { base, proto: env.orchestrationProtocolVersion || 1 };
  })();
  looking.catch(() => {}); // a failed lookup is reported below
  const session = await issuing;
  const { base, proto } = await looking;
  const today = new Date();
  const since = new Date(today.getTime() - USAGE_DAYS * 86400000).toLocaleDateString("en-CA");
  return await new Promise((resolve, reject) => {
    const ws = new WebSocket("ws://" + base + "/ws?orchestrationProtocol=" + proto, { headers: { Authorization: "Bearer " + session.token } });
    let summary = null;
    let summaryOk = false;
    let providers = null;
    let sources = null;
    const answer = () => ({ summary: summary || {}, summaryOk, providers: providers || [], sources: sources || [] });
    const finish = () => {
      if (summary === null || sources === null) return;
      clearTimeout(timer);
      try { ws.close(); } catch {}
      resolve(answer());
    };
    // What came in time, once the summary has: T3 may send no usage-limit sources at all
    // (none set up), or only when they change (as the Python publisher, it publishes without).
    const timer = setTimeout(() => {
      try { ws.close(); } catch {}
      if (summary === null) reject(new Error("T3 API timed out"));
      else resolve(answer());
    }, 45000);
    // Turned away (the session expired early, or the user revoked it): the next publish
    // starts with a new one. Any other failure keeps it, for the next publish to reuse.
    ws.onerror = () => {
      clearTimeout(timer);
      dropSession();
      reject(new Error("T3 API connection failed"));
    };
    ws.onopen = () => {
      ws.send(JSON.stringify({ _tag: "Request", id: "summary", tag: "server.getUsageSummary", headers: [], payload: { sinceDay: since, untilDay: today.toLocaleDateString("en-CA"), timeZone, awaitRefresh: false } }));
      ws.send(JSON.stringify({ _tag: "Request", id: "config", tag: "subscribeServerConfig", headers: [], payload: { usageLimitSources: true } }));
    };
    ws.onmessage = (event) => {
      let frame;
      try { frame = JSON.parse(String(event.data)); } catch { return; }
      if (!frame || typeof frame !== "object") return;
      // An odd frame fails this read only, never the worker.
      try {
        if (frame._tag === "Ping") ws.send('{"_tag":"Pong"}');
        else if (frame._tag === "Exit" && String(frame.requestId) === "summary") {
          summaryOk = frame.exit?._tag === "Success";
          summary = summaryOk ? frame.exit.value : {};
        }
        else if (frame._tag === "Chunk" && String(frame.requestId) === "config") {
          ws.send(JSON.stringify({ _tag: "Ack", requestId: frame.requestId }));
          for (const item of frame.values || []) {
            if (!item || typeof item !== "object") continue;
            const payload = item.payload || item.config || {};
            if (item.type === "usageLimitSourcesUpdated") sources = payload.sources || [];
            else if (item.type === "snapshot") providers = payload.config?.providers || payload.providers || [];
          }
        }
        finish();
      } catch (e) {
        clearTimeout(timer);
        try { ws.close(); } catch {}
        reject(e);
      }
    };
  });
}

// ---------- Shaping (same as the Python publisher) ----------
const cleanWindow = (w) => {
  const used = w?.usedPercent;
  if (typeof used !== "number") return null;
  return {
    label: String(w.label || "").slice(0, 40),
    kind: String(w.kind || "").slice(0, 24),
    durationMins: typeof w.windowDurationMins === "number" ? w.windowDurationMins : null,
    usedPercent: Math.max(0, Math.min(100, Math.round(used * 10) / 10)),
    resetsAt: typeof w.resetsAt === "string" ? w.resetsAt : null,
  };
};
const safeLabel = (text, fallback) => { const t = String(text || "").trim(); return !t || t.includes("@") ? fallback : t.slice(0, 32); };
// A Claude account's key in the limit history (state/limits-history.json): a hash of its
// id, which a usage-limit hub takes from the account's auth file, an e-mail address often.
// Kept in the worker: the feed, which the page copies into T3's storage, has no use for it.
const accountKey = (id) => "a" + shortHash(String(id));
function limits(providers, sources) {
  const claude = [];
  for (const p of providers) {
    const driver = p.driver || p.provider || "";
    if (driver !== "claudeAgent" || !p.usageLimits || p.enabled === false) continue;
    const windows = (p.usageLimits.windows || []).map(cleanWindow).filter(Boolean);
    if (!windows.length) continue;
    claude.push({ key: accountKey(p.instanceId), label: safeLabel(p.displayName || p.label || p.instanceId, "Claude"), plan: String(p.auth?.type || "").slice(0, 40), windows, checkedAt: p.usageLimits.checkedAt });
  }
  // Usage-limit hubs (Settings -> Providers; T3 names them "cliproxy-<host>", older
  // setups "codex_gateway"): every Codex account in any of them. A hub holds other
  // providers' accounts too (Claude, Grok, ...), which are no part of the Codex pool.
  const seen = new Set();
  const hubAccounts = [];
  let hub = null;
  for (const s of sources) {
    for (const a of s.accounts || []) {
      if ((a.driver || "codex") !== "codex") continue;
      const id = a.workspaceId || a.email || s.id + ":" + a.id;
      if (seen.has(id)) continue;
      seen.add(id);
      hubAccounts.push({ label: safeLabel(a.email, "Account " + (hubAccounts.length + 1)), plan: String(a.plan || "").slice(0, 40), windows: (a.usageLimits?.windows || []).map(cleanWindow).filter(Boolean) });
      hub ||= s;
    }
  }
  let codex = hubAccounts.length ? { label: safeLabel(hub.label, "Codex"), checkedAt: hub.checkedAt, accounts: hubAccounts } : null;
  // Claude accounts a hub holds, when T3's own Claude reports no limits (the same
  // account in both would be counted twice).
  if (!claude.length) {
    for (const s of sources) {
      for (const a of s.accounts || []) {
        if (a.driver !== "claudeAgent") continue;
        const windows = (a.usageLimits?.windows || []).map(cleanWindow).filter(Boolean);
        if (windows.length) claude.push({ key: accountKey(s.id + ":" + a.id), label: safeLabel(a.email, "Claude " + (claude.length + 1)), plan: String(a.plan || "").slice(0, 40), windows, checkedAt: a.usageLimits.checkedAt });
      }
    }
  }
  if (!codex) {
    // No hub: the Codex accounts T3 itself is signed in to (every instance, not the last one).
    const accounts = [];
    let checkedAt = null;
    for (const p of providers) {
      if ((p.driver || p.provider) !== "codex" || !p.usageLimits || p.enabled === false) continue;
      const windows = (p.usageLimits.windows || []).map(cleanWindow).filter(Boolean);
      if (!windows.length) continue;
      accounts.push({ label: safeLabel(p.displayName, "Codex"), plan: String(p.auth?.label || "").slice(0, 40), windows });
      checkedAt ||= p.usageLimits.checkedAt;
    }
    if (accounts.length) codex = { label: "Codex", checkedAt, accounts };
  }
  return { claude, codex };
}
// The same rules as the page (extension/src/homeData.js) and T3's own usage view:
// a window is what T3 calls it (kind; a monthly window is no week), its length only
// when it has no kind. Different rules here and there made the recorded line and the
// current value disagree.
const isWeekly = (w) => (w.kind ? w.kind === "weekly" : (w.durationMins || 0) >= 6 * 1440 && (w.durationMins || 0) <= 8 * 1440);
const isFiveHour = (w) => (w.kind ? w.kind === "session" : (w.durationMins || 0) > 0 && (w.durationMins || 0) < 1440);
// T3's weights: Codex Plus 1x, Pro 100 5x, Pro 200 20x; all equal when a plan is unknown.
const CODEX_PLAN_WEIGHTS = { "ChatGPT Plus Subscription": 1, "ChatGPT Pro 100 Subscription": 5, "ChatGPT Pro 200 Subscription": 20 };
const poolWeights = (plans, table) => {
  const weights = plans.map((plan) => table[plan]);
  return weights.every((w) => typeof w === "number") ? weights : plans.map(() => 1);
};
function codexPool(codex) {
  if (!codex) return null;
  // Only accounts that report a week: one whose limits failed to load counted as 100% left.
  const accounts = codex.accounts.filter((a) => a.windows.some(isWeekly));
  if (!accounts.length) return null;
  let cap = 0, weekLeft = 0, fiveLeft = 0, fiveCap = 0;
  const weights = accounts.length === 1 ? [1] : poolWeights(accounts.map((a) => a.plan), CODEX_PLAN_WEIGHTS);
  for (const [i, a] of accounts.entries()) {
    const weight = weights[i] * 100;
    const weekly = a.windows.find(isWeekly);
    const five = a.windows.find(isFiveHour);
    cap += weight;
    weekLeft += weight * (1 - (weekly ? weekly.usedPercent : 0) / 100);
    if (five) { fiveCap += weight; fiveLeft += weight * (1 - five.usedPercent / 100); }
  }
  return { weekLeft: Math.round(weekLeft), weekCap: Math.round(cap), fiveLeft: Math.round(fiveLeft), fiveCap: Math.round(fiveCap) };
}
// A usage bucket's token count, as T3's Usage page totals it: input (uncached, cache
// reads, cache writes) plus output. Reasoning tokens are part of output already
// (T3's schema says so), so adding them counted them twice.
function bucketTokens(totals) {
  const t = totals || {};
  return ["uncachedInputTokens", "cachedInputTokens", "cacheCreationTokens", "outputTokens"].reduce((n, k) => n + (Number(t[k]) || 0), 0);
}
function spend(summary) {
  const first = new Date(Date.now() - SPEND_DAYS * 86400000).toLocaleDateString("en-CA");
  const byDay = {};
  for (const b of summary.buckets || []) {
    if (!b.day || !b.provider || b.day < first) continue;
    const cell = ((byDay[b.day] ||= {})[b.provider] ||= [0, 0]);
    cell[0] += Number(b.costUsd) || 0;
    cell[1] += bucketTokens(b.totals);
  }
  const out = {};
  for (const day of Object.keys(byDay).sort()) out[day] = Object.fromEntries(Object.entries(byDay[day]).map(([p, [c, t]]) => [p, [Math.round(c * 1e4) / 1e4, t]]));
  return out;
}
function usageActivity(summary) {
  const days = {};
  for (const b of summary.buckets || []) {
    if (!b.day || !b.provider) continue;
    const p = ((days[b.day] ||= {})[String(b.provider).slice(0, 24)] ||= 0);
    days[b.day][String(b.provider).slice(0, 24)] = p + bucketTokens(b.totals);
  }
  const out = {};
  for (const day of Object.keys(days).sort()) {
    const total = Object.values(days[day]).reduce((n, v) => n + v, 0);
    if (total > 0) out[day] = [total, days[day]];
  }
  return out;
}
function updateHistory(pool, claude, at) {
  const file = path.join(stateDir, "limits-history.json");
  let history = [];
  try { history = JSON.parse(fs.readFileSync(file, "utf8")); } catch {}
  const cutoff = new Date(Date.now() - HISTORY_DAYS * 86400000).toISOString();
  const entry = { t: at, ...(pool || {}) };
  for (const c of claude) {
    const weekly = c.windows.find(isWeekly);
    if (weekly) (entry.claudeWeekUsed ||= {})[c.key] = weekly.usedPercent;
  }
  // At most one sample per HISTORY_STEP_MS is stored, and the file is written only when
  // that changes: it kept every run's sample (every 2 minutes) and was rewritten whole on
  // each run. The pool fields stay in each sample: codexSeries reads them.
  const kept = [];
  let last = null;
  for (const h of Array.isArray(history) ? history : []) {
    if (!h || typeof h !== "object" || (h.t || "") < cutoff) continue;
    const t = Date.parse(h.t);
    if (!Number.isFinite(t)) continue; // a sample with no time would hold back every later one
    if (last === null || t - last >= HISTORY_STEP_MS) { kept.push(h); last = t; }
  }
  if (last === null || Date.parse(at) - last >= HISTORY_STEP_MS) kept.push(entry);
  if (JSON.stringify(kept) !== JSON.stringify(history)) writeAtomic(file, JSON.stringify(kept));
  // This run's sample is the newest point, stored or not.
  return kept[kept.length - 1] === entry ? kept : [...kept, entry];
}
function claudeSeries(history) {
  // Each account's week counts the same (T3 weighs Claude plans only in the five-hour window).
  const points = [];
  for (const h of history) {
    if (!h.claudeWeekUsed || !Object.keys(h.claudeWeekUsed).length) continue;
    let cap = 0, left = 0;
    for (const v of Object.values(h.claudeWeekUsed)) { cap += 100; left += 100 * (1 - v / 100); }
    points.push([Math.floor(Date.parse(h.t) / 1000), Math.round(left), cap]);
  }
  return points;
}
const codexSeries = (history) => history.filter((h) => h.weekCap).map((h) => [Math.floor(Date.parse(h.t) / 1000), h.weekLeft || 0, h.weekCap]);

/**
 * Usage per day (spend, tokens) as published, with the days T3 is no longer asked
 * for kept from before (state/usage-kept.json). A failed usage read publishes what
 * there was, not nothing ("No usage recorded" for a cycle, the Activity card
 * switching from tokens to turns).
 */
function usageKept(summary, ok) {
  const file = path.join(stateDir, "usage-kept.json");
  let kept = {};
  try { kept = JSON.parse(fs.readFileSync(file, "utf8")) || {}; } catch {}
  const before = { activity: kept.activity && typeof kept.activity === "object" ? kept.activity : {}, spend: kept.spend && typeof kept.spend === "object" ? kept.spend : {} };
  if (!ok) return before;
  const asked = new Date(Date.now() - USAGE_DAYS * 86400000).toLocaleDateString("en-CA");
  const oldest = new Date(Date.now() - ACTIVITY_DAYS * 86400000).toLocaleDateString("en-CA");
  const activity = {};
  for (const day of Object.keys(before.activity).sort()) if (day >= oldest && day < asked) activity[day] = before.activity[day];
  Object.assign(activity, usageActivity(summary));
  const next = { activity, spend: spend(summary) };
  try { writeAtomic(file, JSON.stringify(next)); } catch (e) { log("usage copy not kept:", e && e.message); }
  return next;
}

// ---------- Thread status feed (the Status view) ----------
// Every thread's status as T3's sidebar would show it, for the threads its list does not
// show (a collapsed folder's). T3's rules (Sidebar.logic: thread status, unread; threadSettled;
// its server's thread state), the first that holds:
// - "approval": a pending approval. T3 keeps one request a thread (any that is not a question
//   first, the newest first), so a sign-in to renew, which has no word, hides an older one.
// - "input": a question, or a secret or link card only you can answer.
// - "request": a guest's message waiting.
// - "waiting": no run is setting up, starting or running, the latest run is over (completed,
//   interrupted, cancelled, or still taking its checkpoint), and work T3 waits on is still
//   open: a subagent or tool call (not a command, not a persistent tool), a task the provider
//   reports that is awaited or more than a command or monitor, or a watched pull request whose
//   checks may still run (that one before any run too). Or a running run waits on another
//   thread (T3's t3_thread_wait, or delegate_task waiting) with nothing else in flight but
//   subagents T3 runs itself.
// - "preparing": a run setting up; "working": a run under way, or the latest run queued, with
//   goal: true (T3's label "Goal") while the provider thread it runs on pursues an active goal.
// - "limited": the latest run failed on a usage limit (its own error, not a subagent's), unless
//   the thread's provider session (the newest on its provider) reports another error. Seeing
//   it does not clear it.
// - "failed": the latest run failed otherwise, after you last looked.
// - Else a woken snooze is "woke", a run finished since you last looked "done".
// The latest run is the newest one not held in the queue, not cancelled before it started
// while an earlier one ran on, and not T3's own idle "/compact". But while the run that ran
// last (the one still going, if one is; a "/compact" counts) failed on a usage limit, that one
// is the latest: runs queued after it, or cancelled before they started, do not change that.
// A side chat's requests and a running subagent's approvals and cards count for the thread
// they belong to (as T3 passes them up). Settled and snoozed threads are left out, and the
// subagents and side chats that are part of another thread (forks are listed). Not read here
// (T3's own row, when it shows the thread, has them): a run status this T3 does not know
// ("Failed" there), and two things this machine's T3 server does not have either:
// - "Setting up" for a thread with no run yet. The server makes a launched thread's first run
//   in the same command as the thread, so what it has is read here ("preparing"); T3's client
//   shows "Setting up" a moment longer for a draft of its own it is promoting, from its
//   composer drafts store in the page (Sidebar.logic R, on the drafts marked promotedTo).
// - A request from a thread T3 runs on another machine for one of these (a task delegated
//   there): it is in that machine's database, which T3's client reads over its own connection
//   to that machine; the server here records only the task and, at its end, its result.
const MAX_THREADS = 400;
// T3's own SQL (its server's thread state), as fragments over an alias:
// a "/compact" T3 sends an idle thread by itself (not a message you wrote),
const IDLE_COMPACTION = (m) => `(${m}.role = 'user'
  AND lower(trim(json_extract(${m}.payload_json, '$.text'), char(9, 10, 11, 12, 13, 32, 160, 5760, 8192, 8193, 8194, 8195, 8196, 8197, 8198, 8199, 8200, 8201, 8202, 8232, 8233, 8239, 8287, 12288, 65279))) = '/compact'
  AND coalesce(json_array_length(${m}.payload_json, '$.attachments'), 0) = 0
  AND (json_extract(${m}.payload_json, '$.idleCompaction') IS NOT NULL
    OR (json_extract(${m}.payload_json, '$.createdBy') = 'agent' AND json_extract(${m}.payload_json, '$.creationSource') = 'server')))`;
// the run it answers, kept out of sight (unless its compaction failed),
const SILENT_RUN = (r) => `(${r}.status <> 'failed'
  AND EXISTS (SELECT 1 FROM orchestration_v2_projection_messages prompt
    WHERE prompt.message_id = json_extract(${r}.payload_json, '$.userMessageId') AND ${IDLE_COMPACTION("prompt")})
  AND NOT EXISTS (SELECT 1 FROM orchestration_v2_projection_turn_items compaction
    WHERE compaction.thread_id = ${r}.thread_id AND compaction.run_id = ${r}.run_id AND compaction.type = 'compaction' AND compaction.status = 'failed'))`;
// and the run T3 presents as the latest: not a held queued one, not one cancelled before it
// started that an earlier run outlived, not a silent one.
const PRESENTED_RUN = (threadId) => `(SELECT candidate.run_id FROM orchestration_v2_projection_runs candidate
  WHERE candidate.thread_id = ${threadId}
    AND NOT (candidate.status = 'queued' AND json_extract(candidate.payload_json, '$.queueHeld') IS 1)
    AND NOT (candidate.status = 'cancelled' AND json_extract(candidate.payload_json, '$.startedAt') IS NULL AND candidate.completed_at IS NOT NULL
      AND EXISTS (SELECT 1 FROM orchestration_v2_projection_runs earlier
        WHERE earlier.thread_id = candidate.thread_id AND earlier.ordinal < candidate.ordinal AND earlier.status <> 'queued'
          AND NOT ${SILENT_RUN("earlier")}
          AND (earlier.completed_at IS NULL OR julianday(earlier.completed_at) >= julianday(candidate.completed_at))))
    AND NOT ${SILENT_RUN("candidate")}
  ORDER BY candidate.ordinal DESC, candidate.run_id DESC LIMIT 1)`;
// The run that ended last (one not ended counts as last; a queued one, or one cancelled
// before it started, does not count; a silent one does): while a usage limit failed it, T3
// presents it as the latest. Written as T3 writes it: T3's partial index for it
// (runs_last_executed_idx) serves exactly this filter and order.
const LAST_EXECUTED_RUN = (threadId) => `(SELECT x.run_id FROM orchestration_v2_projection_runs x
  WHERE x.thread_id = ${threadId} AND x.status <> 'queued'
    AND NOT (x.status = 'cancelled' AND json_extract(x.payload_json, '$.startedAt') IS NULL)
  ORDER BY x.completed_at IS NULL DESC, x.completed_at DESC, x.ordinal DESC, x.run_id DESC LIMIT 1)`;
// A run's own failure: the newest failed error item at its root node (one at a subagent's
// node is the subagent's; each attempt of a retried provider turn has a row of its own).
const ROOT_FAILURE = (r) => `(SELECT json_extract(e.payload_json, '$.failure') FROM orchestration_v2_projection_turn_items e
  WHERE e.thread_id = ${r}.thread_id AND e.run_id = ${r}.run_id AND e.type = 'error' AND e.status = 'failed'
    AND e.node_id IS json_extract(${r}.payload_json, '$.rootNodeId')
  ORDER BY e.updated_at DESC, e.ordinal DESC, e.turn_item_id DESC LIMIT 1)`;
// The last error of the provider session bound to the thread on its current provider instance
// (the newest such session; bindings first, as T3 reads them): a failure whose message differs
// is no longer the thread's error (T3's threadErrorSummary).
const SESSION_ERROR = (t) => `(SELECT json_extract(s.payload_json, '$.lastError')
  FROM orchestration_v2_projection_provider_session_bindings bnd
  CROSS JOIN orchestration_v2_projection_provider_sessions s ON s.provider_session_id = bnd.provider_session_id
  WHERE bnd.thread_id = ${t}.thread_id AND s.provider_instance_id = ${t}.provider_instance_id
  ORDER BY s.updated_at DESC, s.provider_session_id DESC LIMIT 1)`;
// A run under way: setting up, starting, running or taking its checkpoint. Written with the
// statuses of T3's partial index of runs not over (runs_recovery_idx), queued left out: SQLite
// takes a partial index only for a query that repeats its condition.
const UNDER_WAY = (r) => `${r}.status IN ('queued', 'preparing', 'starting', 'running', 'waiting') AND ${r}.status <> 'queued'`;
// Each thread's run under way, the newest first (T3's activity run: not a silent one), and when
// its work started (T3's activity_run_started_at).
const ACTIVE_RUNS = `SELECT a.thread_id AS thread, a.run_id AS run, a.status AS status,
    COALESCE(json_extract(a.payload_json, '$.workStartedAt'), json_extract(a.payload_json, '$.startedAt'), a.requested_at) AS at
  FROM orchestration_v2_projection_runs a
  WHERE ${UNDER_WAY("a")} AND NOT ${SILENT_RUN("a")}
  ORDER BY a.thread_id, a.ordinal DESC`;
// The work in flight in a running one ([type, tool, mode, origin] each): all T3 reads to tell a
// run that only waits on other threads (deriveBlockedOnThreadWait).
const IN_FLIGHT = `SELECT json_group_array(json_array(i.type, json_extract(i.payload_json, '$.toolName'),
    json_extract(i.payload_json, '$.input.mode'), json_extract(i.payload_json, '$.origin'))) AS items
  FROM orchestration_v2_projection_turn_items i
  WHERE i.thread_id = ? AND i.run_id = ? AND i.status IN ('running', 'waiting')
    AND i.type IN ('command_execution', 'dynamic_tool', 'subagent', 'file_change', 'file_search', 'web_search', 'compaction')`;
// Work T3 waits on before it calls a thread's run done (derivePendingBackgroundWork). None
// while a run is setting up, starting or running;
const INTERRUPTIBLE_RUN = (threadId) => `EXISTS (SELECT 1 FROM orchestration_v2_projection_runs a
  WHERE a.thread_id = ${threadId} AND a.status IN ('preparing', 'starting', 'running') AND NOT ${SILENT_RUN("a")})`;
// else a watched pull request whose checks may still run,
const PR_WATCH_AWAITED = (t) => `EXISTS (SELECT 1 FROM json_each(${t}.payload_json, '$.pullRequests') pr
  WHERE json_type(pr.value, '$.watch') = 'object' AND json_extract(pr.value, '$.source') IS NOT 'stack-dismissed'
    AND json_extract(pr.value, '$.snapshot.state') IS NOT 'merged' AND json_type(pr.value, '$.watch.checksPending') IS NOT 'false')`;
// a task the provider reports for the thread (on its active provider thread, if it names one)
// that is awaited or more than a command or monitor (one of a kind T3 does not know holds),
const CONSIDERED_PT = (p, t) => `${p}.thread_id = ${t}.thread_id
    AND (json_extract(${t}.payload_json, '$.activeProviderThreadId') IS NULL
      OR ${p}.provider_thread_id = json_extract(${t}.payload_json, '$.activeProviderThreadId'))`;
const PROVIDER_TASK_HOLDS = (t) => `EXISTS (SELECT 1 FROM orchestration_v2_projection_provider_threads p
    CROSS JOIN json_each(p.payload_json, '$.pendingBackgroundTasks') task
  WHERE ${CONSIDERED_PT("p", t)} AND json_extract(task.value, '$.taskId') <> ''
    AND (json_type(task.value, '$.awaited') = 'true' OR json_extract(task.value, '$.kind') IS NULL
      OR json_extract(task.value, '$.kind') NOT IN ('command', 'monitor')))`;
// or a subagent or tool still open (not a persistent tool; not in a rolled-back run, or one
// gone), unless a task the provider reports has its id: T3 lists that task in its place.
const ITEM_HOLDS = (t) => `EXISTS (SELECT 1 FROM orchestration_v2_projection_turn_items i
    LEFT JOIN orchestration_v2_projection_runs ir ON ir.run_id = i.run_id
  WHERE i.thread_id = ${t}.thread_id AND i.type IN ('dynamic_tool', 'subagent') AND i.status IN ('pending', 'running', 'waiting')
    AND (i.run_id IS NULL OR ir.status <> 'rolled_back')
    AND NOT (i.type = 'dynamic_tool' AND json_type(i.payload_json, '$.input.persistent') IS 'true')
    AND NOT EXISTS (SELECT 1 FROM orchestration_v2_projection_provider_threads p2
        CROSS JOIN json_each(p2.payload_json, '$.pendingBackgroundTasks') task2
      WHERE ${CONSIDERED_PT("p2", t)}
        AND json_extract(task2.value, '$.taskId') = COALESCE(NULLIF(json_extract(i.payload_json, '$.nativeItemRef.nativeId'), ''), i.turn_item_id)))`;
// Whether such work holds the thread: while no run is setting up, starting or running, after
// a run that ended ('waiting': its turn is over, its checkpoint still being taken), and before
// any run for a pull request's watch. Not after a failed run: T3 shows the failure.
const ENDED = "('cancelled', 'completed', 'interrupted', 'waiting')";
const BACKGROUND_HOLD = (t, r) => `CASE WHEN ${INTERRUPTIBLE_RUN(`${t}.thread_id`)} THEN 0
    WHEN ${r}.run_id IS NULL THEN ${PR_WATCH_AWAITED(t)}
    WHEN ${r}.status IN ${ENDED} THEN ${PR_WATCH_AWAITED(t)} OR ${PROVIDER_TASK_HOLDS(t)} OR ${ITEM_HOLDS(t)}
    ELSE 0 END`;
// Whether the goal of the thread's active provider thread is active: T3 then labels "Working"
// "Goal". Only that provider thread's goal (T3's activeProviderGoalForShell): none without
// one, unlike the tasks above. Looked up by its key, so it costs little on every thread.
const ACTIVE_GOAL = (t) => `EXISTS (SELECT 1 FROM orchestration_v2_projection_provider_threads g
  WHERE g.provider_thread_id = json_extract(${t}.payload_json, '$.activeProviderThreadId') AND g.thread_id = ${t}.thread_id
    AND json_extract(g.payload_json, '$.goal.status') = 'active')`;
// T3's two tools that wait on another thread, by the names providers give tools
// ("mcp__t3-code__t3_thread_wait", Codex's "t3-code-direct.delegate_task", a label ending in
// " completed"): T3's resolveT3McpToolId for these two (no other tool of T3's ends in either).
const T3_SERVERS = new Set(["t3-code", "t3_code", "t3code", "t3-code-direct", "t3_code_direct"]);
const WAIT_TOOLS = ["t3_thread_wait", "delegate_task"];
function waitTool(name) {
  if (typeof name !== "string") return null;
  const label = name.replace(/\s+(?:complete|completed)\s*$/i, "").trim();
  const wait = (tool) => (WAIT_TOOLS.includes(tool) ? tool : null);
  const mcp = /^mcp__(.+?)__(.+)$/i.exec(label);
  if (mcp) return T3_SERVERS.has(mcp[1].toLowerCase()) ? wait(mcp[2]) : null;
  const namespaced = /^(?:t3[-_]code[-_]direct|t3-code|t3_code|t3code)(?:[.:/]|\s*·\s*)(.+)$/i.exec(label);
  if (namespaced) return wait(namespaced[1]);
  const bare = wait(/^(?:mcp[-_]{1,2})?t3[-_ ]?code(?:__|[-_.:/ ])(.+)$/i.exec(label)?.[1] ?? label);
  if (bare || !/^t3-code-/i.test(label)) return bare;
  return WAIT_TOOLS.find((tool) => label.endsWith(`_${tool}`)) ?? null; // a "t3-code-…_<tool>" label
}
/** T3's blockedOnThreadWait over IN_FLIGHT: waits on other threads are all that is in flight. */
function waitsOnThread(inFlight) {
  let waits = false;
  for (const [type, toolName, mode, origin] of json(inFlight) ?? []) {
    if (type === "subagent" && origin === "app_owned") continue; // a thread T3 runs for it reports back
    const tool = type === "dynamic_tool" ? waitTool(toolName) : null;
    if (tool !== "t3_thread_wait" && !(tool === "delegate_task" && mode === "wait")) return false;
    waits = true;
  }
  return waits;
}
// A git remote as T3's sidebar folder key: "github.com/owner/repo". Kept per folder until
// its .git/config changes (the feed is read every couple of seconds while shown).
const repoKeys = new Map(); // root -> { mtime, key }
function repoKey(root) {
  const file = path.join(root, ".git", "config");
  let mtime;
  try { mtime = fs.statSync(file).mtimeMs; } catch { repoKeys.delete(root); return null; }
  const known = repoKeys.get(root);
  if (known && known.mtime === mtime) return known.key;
  const key = readRepoKey(file);
  repoKeys.set(root, { mtime, key });
  return key;
}
function readRepoKey(file) {
  let config;
  try { config = fs.readFileSync(file, "utf8"); } catch { return null; }
  const url = (/\[remote "origin"\][^[]*?\burl\s*=\s*(\S+)/.exec(config) || [])[1];
  if (!url) return null;
  const m = /^(?:[a-z+]+:\/\/)?(?:[^@/\s]+@)?([^/:\s]+)(?::\d+)?[:/](.+?)(?:\.git)?\/?$/i.exec(url.trim());
  return m ? `${m[1].toLowerCase()}/${m[2]}` : null;
}
// The rows the statuses are read from, a thread each. Not the subagents and side chats that
// are part of another thread (their requests count for that one): T3's own filter for its
// list, which also keeps the cost to the threads listed (subagents are most of a database).
// Forks are threads of their own, listed though T3 nests them. "limited", "waiting" and a goal
// come from T3's provider tables (provider threads and sessions, their bindings, a turn item's
// node and order): without them (exact false: an older T3's database, or not T3's) their
// columns are NULL, and the statuses are read without those rather than not at all.
function threadRowsSql(exact) {
  const needs = (sql) => (exact ? sql : "NULL");
  return `SELECT t.thread_id AS id, t.project_id AS project, t.title AS title, t.updated_at AS updated,
        json_extract(t.payload_json, '$.lastVisitedAt') AS visited,
        json_extract(t.payload_json, '$.settledOverride') AS settled,
        json_extract(t.payload_json, '$.settledAt') AS settledAt,
        json_extract(t.payload_json, '$.snoozedUntil') AS snoozedUntil,
        json_extract(t.payload_json, '$.snoozedAt') AS snoozedAt,
        (SELECT COUNT(*) FROM json_each(t.payload_json, '$.guestShare.messages') m WHERE json_extract(m.value, '$.status') = 'pending') AS guests,
        r.status AS run, r.requested_at AS runAt, json_extract(r.payload_json, '$.startedAt') AS runStart, r.completed_at AS runDone,
        ${needs(`CASE WHEN r.status = 'failed' THEN ${ROOT_FAILURE("r")} END`)} AS runFailure,
        -- The run that ended last, when it failed: the latest run instead, if a usage limit did it.
        lim.requested_at AS limitAt, json_extract(lim.payload_json, '$.startedAt') AS limitStart, lim.completed_at AS limitDone,
        ${needs(`CASE WHEN lim.run_id IS NOT NULL THEN ${ROOT_FAILURE("lim")} END`)} AS limitFailure,
        ${needs(`CASE WHEN r.status = 'failed' OR lim.run_id IS NOT NULL THEN ${SESSION_ERROR("t")} END`)} AS sessionError,
        ${needs(BACKGROUND_HOLD("t", "r"))} AS held,
        ${needs(ACTIVE_GOAL("t"))} AS goal
      FROM orchestration_v2_projection_threads t
      LEFT JOIN orchestration_v2_projection_runs r ON r.run_id = ${PRESENTED_RUN("t.thread_id")}
      LEFT JOIN orchestration_v2_projection_runs lim ON lim.run_id = ${LAST_EXECUTED_RUN("t.thread_id")} AND lim.status = 'failed'
      WHERE t.deleted_at IS NULL AND t.archived_at IS NULL
        AND json_extract(t.payload_json, '$.lineage.relationshipToParent') IS NOT 'subagent'
        AND json_extract(t.payload_json, '$.lineage.sideChat') IS NOT 1`;
}
let exactRead = true; // whether the last read was threadRowsSql(true) (falling back is logged once)
function threadStatuses(envId) {
  const conn = db();
  try {
    const now = Date.now();
    const time = (iso) => { const t = Date.parse(iso || ""); return Number.isNaN(t) ? null : t; };
    // What is rare is read as a set of its own, through T3's indexes for it, and matched to the
    // threads here (asked of every thread, one at a time, it was most of a publish): the runs under
    // way; per thread what T3 itself picks (its server's thread state): one pending request
    // (approvals before questions, the newest first), its newest waiting secret card on a run
    // under way and its newest waiting link card.
    const first = (sql) => {
      const byThread = new Map();
      for (const row of conn.prepare(sql).all()) if (!byThread.has(row.thread)) byThread.set(row.thread, row);
      return byThread;
    };
    const active = first(ACTIVE_RUNS);
    const requests = first(`SELECT thread_id AS thread, kind || '|' || created_at AS request FROM orchestration_v2_projection_runtime_requests
      WHERE status = 'pending' ORDER BY thread_id, (kind = 'user_input') ASC, created_at DESC, runtime_request_id DESC`);
    const secrets = first(`SELECT s.thread_id AS thread, max(s.updated_at) AS at FROM orchestration_v2_projection_runs r
        CROSS JOIN orchestration_v2_projection_turn_items s ON s.thread_id = r.thread_id AND s.run_id = r.run_id
      WHERE ${UNDER_WAY("r")} AND s.type = 'secret_request' AND s.status = 'waiting' GROUP BY s.thread_id`);
    const links = first(`SELECT thread_id AS thread, updated_at || '|' || coalesce(json_extract(payload_json, '$.startedAt'), updated_at) AS link
      FROM orchestration_v2_projection_turn_items WHERE type = 'link_request' AND status = 'waiting'
      ORDER BY thread_id, updated_at DESC, turn_item_id DESC`);
    // Read for those threads only: when you last wrote in one with a link card, and the lineage of
    // the threads that ask something (and of those they pass it up to). T3 walks up through the
    // subagents and side chats to the first thread of its own (a fork copies its source's root
    // id, so the root is not that thread).
    const wrote = conn.prepare(`SELECT m.updated_at AS at FROM orchestration_v2_projection_messages m
      WHERE m.thread_id = ? AND m.role = 'user' AND json_extract(m.payload_json, '$.createdBy') = 'user' AND NOT ${IDLE_COMPACTION("m")}
      ORDER BY m.updated_at DESC LIMIT 1`);
    const lineageOf = conn.prepare(`SELECT json_extract(payload_json, '$.lineage.parentThreadId') AS parent,
        json_extract(payload_json, '$.lineage.relationshipToParent') AS relation,
        json_extract(payload_json, '$.lineage.sideChat') AS sideChat,
        json_extract(payload_json, '$.creationSource') AS source
      FROM orchestration_v2_projection_threads WHERE thread_id = ? AND deleted_at IS NULL`);
    const lineages = new Map();
    const lineage = (id) => {
      if (!lineages.has(id)) lineages.set(id, lineageOf.get(id) ?? null);
      return lineages.get(id); // null: no such thread, or a deleted one
    };
    const isSideChat = (r) => Boolean(r && r.parent && (r.sideChat === 1 || r.sideChat === true));
    const isSubagent = (r) => Boolean(r && r.parent && r.relation === "subagent");
    /** What a thread asks of you itself: { what: "approval" | "input" | null, at, userOnly, refresh }. */
    function asks(id) {
      const request = requests.get(id)?.request ?? null;
      const [kind, at] = request ? [request.slice(0, request.indexOf("|")), request.slice(request.indexOf("|") + 1)] : [null, null];
      // A secret or link card only you can answer (a link one until you have written since it
      // started: a message of yours, not T3's own or another agent's).
      const linkCard = links.get(id)?.link ?? null;
      const [linkAt, linkStart] = linkCard ? linkCard.split("|") : [null, null];
      const wroteAt = linkAt ? (wrote.get(id)?.at ?? null) : null;
      const link = linkAt && !(wroteAt && time(wroteAt) > time(linkStart)) ? linkAt : null;
      const card = [secrets.get(id)?.at ?? null, link].filter(Boolean).sort().at(-1) ?? null;
      if (card && (!kind || kind === "user_input") && (!at || card >= at)) return { what: "input", at: card, userOnly: true, refresh: false };
      if (!kind) return null;
      if (kind === "auth_refresh") return { what: null, at, userOnly: false, refresh: true }; // a sign-in to renew: no word, but it wakes
      return { what: kind === "user_input" ? "input" : "approval", at, userOnly: false, refresh: false };
    }
    // thread -> { what, at, wakes (shows a snoozed thread again whenever it came), askedAt
    // (its own latest question: wakes it only if asked after the snooze) }
    const pending = new Map();
    const note = (id, what, at, wakes, asked) => {
      const had = pending.get(id) ?? { what: null, at: null, wakes: false, askedAt: null };
      // An approval outranks a question (T3 checks it first); of the same kind, the earliest.
      if (what && (!had.what || (had.what === "input" && what === "approval"))) [had.what, had.at] = [what, at];
      else if (what && had.what === what && at < had.at) had.at = at;
      if (wakes) had.wakes = true;
      if (asked && (!had.askedAt || at > had.askedAt)) had.askedAt = at;
      pending.set(id, had);
    };
    for (const id of new Set([...requests.keys(), ...secrets.keys(), ...links.keys()])) {
      const f = lineage(id);
      if (!f) continue;
      const a = asks(id);
      if (!a) continue;
      note(id, a.what, a.at, a.what !== "input", a.what === "input");
      if (a.refresh) continue;
      // T3 shows on its thread: a side chat's request (its direct parent only), and a
      // running subagent's approval or card only you can answer, unless the provider made
      // it (its own Task tool), on every thread up the chain of subagents and side chats.
      if (isSideChat(f)) note(f.parent, a.what, a.at, true, false);
      else if (isSubagent(f) && f.source !== "provider" && active.has(id) && (a.what === "approval" || a.userOnly)) {
        const seen = new Set([id]);
        let up = f.parent;
        while (up && !seen.has(up)) {
          seen.add(up);
          note(up, a.what, a.at, true, false);
          const g = lineage(up);
          up = g && (isSubagent(g) || isSideChat(g)) ? g.parent : null;
        }
      }
    }
    // SQLite names a missing table or column when it prepares the query (threadRowsSql), and
    // stops at JSON not shaped as T3 writes it (a task that is no object) when it runs it.
    let rows;
    // The running ones' work in flight, a part of the exact read (from T3's provider work too).
    let inFlight = new Map();
    try {
      rows = conn.prepare(threadRowsSql(true)).all();
      const flight = conn.prepare(IN_FLIGHT);
      for (const t of rows) {
        const run = active.get(t.id);
        if (run?.status === "running") inFlight.set(t.id, flight.get(t.id, run.run).items);
      }
      exactRead = true;
    } catch (e) {
      if (exactRead) log("thread statuses read without limits and background work:", e && e.message);
      exactRead = false;
      rows = conn.prepare(threadRowsSql(false)).all();
      inFlight = new Map();
    }
    const threads = [];
    const used = new Set();
    for (const t of rows) {
      // Settled by hand, or by T3 itself (settledAt), unless made active again (T3's rule).
      if (t.settled === "settled" || (t.settledAt && t.settled !== "active")) continue;
      const snoozedUntil = time(t.snoozedUntil);
      const visited = time(t.visited);
      const req = pending.get(t.id);
      // The latest run as T3 has it: the one it presents, unless a usage limit failed the run
      // that ended last. A failure counts as a usage limit while the provider's session reports
      // no other error.
      const limitHit = (failure) => { const f = json(failure); return f?.class === "usage_limit" && (t.sessionError === null || t.sessionError === f.message); };
      const blocked = limitHit(t.limitFailure);
      const [run, runAt, runStart, runDone] = blocked ? ["failed", t.limitAt, t.limitStart, t.limitDone] : [t.run, t.runAt, t.runStart, t.runDone];
      const limited = blocked || (run === "failed" && limitHit(t.runFailure));
      // Snoozed: out of sight until it wakes, unless it needs you meanwhile (T3's rule): an
      // approval, a subagent's request or a guest's message at once; its own question or a
      // failure only if it came after the snooze (one from before is what you put off).
      if (snoozedUntil !== null && snoozedUntil > now) {
        const since = time(t.snoozedAt);
        const after = (iso) => iso && (since === null || time(iso) > since);
        const failedSince = run === "failed" && (since === null || (runDone && time(runDone) > since));
        if (!(req?.wakes || t.guests > 0 || after(req?.askedAt) || failedSince)) continue;
      }
      // Failed: if the failure came after you last looked (T3: when the run ended, else when it
      // started, else when it was asked for); else it is just finished. Limited either way.
      const failedAt = time(runDone ?? runStart ?? runAt);
      const failed = run === "failed" && !limited && (visited === null || failedAt === null || failedAt > visited);
      // When it woke (T3's threadSettled): while it needs you, the failure, else the question,
      // after the snooze, else its last change (or the snooze if it never ran); else the
      // snooze's end, once that came.
      let wokeAt = null;
      if (snoozedUntil !== null) {
        const since = time(t.snoozedAt);
        const afterSnooze = (iso) => (iso && (since === null || time(iso) > since) ? time(iso) : null);
        if (req || t.guests > 0 || failed) wokeAt = (failed && afterSnooze(runDone)) || afterSnooze(req?.askedAt) || (run ? time(t.updated) : since);
        else if (snoozedUntil <= now) wokeAt = snoozedUntil;
      }
      // Waiting (T3): on work that holds the thread (BACKGROUND_HOLD; not after a failure), or in
      // a running run, on other threads only.
      const underWay = active.get(t.id);
      const waiting = (t.held === 1 && run !== "failed") || (underWay?.status === "running" && waitsOnThread(inFlight.get(t.id) ?? null));
      let status;
      let at = t.updated;
      if (req?.what) [status, at] = [req.what, req.at];
      else if (t.guests > 0) status = "request"; // a guest's message waits for you
      else if (waiting) [status, at] = ["waiting", underWay ? underWay.at : runDone || runAt];
      else if (underWay?.status === "preparing") [status, at] = ["preparing", underWay.at];
      else if (underWay) [status, at] = ["working", underWay.at];
      else if (run === "queued") [status, at] = ["working", runAt]; // the latest run queued (not held): Working in T3
      else if (limited) [status, at] = ["limited", runDone || runAt];
      else if (failed) [status, at] = ["failed", runDone || runAt];
      else if (wokeAt !== null && (visited === null || visited < wokeAt)) [status, at] = ["woke", new Date(wokeAt).toISOString()];
      else if (runDone && run !== "interrupted" && run !== "cancelled" && visited !== null && time(runDone) > visited) [status, at] = ["done", runDone];
      else status = "idle";
      // The title as T3 shows it (only spaces folded: plain() would drop "_" and "*" from it).
      const row = { id: t.id, project: t.project || null, title: String(t.title || "").replace(/\s+/g, " ").trim().slice(0, 120), status, at: at || t.updated || null };
      // "Goal" is T3's label for "working" alone (not "Setting up", not "Waiting"). Only when it
      // holds, so a feed without goals reads as before.
      if (status === "working" && t.goal === 1) row.goal = true;
      threads.push(row);
      if (t.project) used.add(t.project);
    }
    // Most recent first, the busy ones before the idle ones if there are too many.
    const rank = (s) => (s === "idle" ? 1 : 0);
    threads.sort((a, b) => rank(a.status) - rank(b.status) || String(b.at).localeCompare(String(a.at)));
    threads.length = Math.min(threads.length, MAX_THREADS);
    // Each project's possible sidebar folder keys, the likeliest first: its repository,
    // its folder on this machine (T3's key for a folder that is no repository), T3's
    // scratch folder ("No project").
    const projects = {};
    const scratch = path.join(cfg.t3Home, "scratch");
    for (const p of conn.prepare("SELECT project_id AS id, title, workspace_root AS root FROM projection_projects WHERE deleted_at IS NULL").all()) {
      if (!used.has(p.id)) continue;
      const keys = [repoKey(p.root), envId && `${envId}:${p.root}`, p.root === scratch || p.root.startsWith(scratch + path.sep) ? "\u0000no-project" : null].filter(Boolean);
      projects[p.id] = { title: String(p.title || "").replace(/\s+/g, " ").trim().slice(0, 60), keys };
    }
    return { threads, projects };
  } finally {
    conn.close();
  }
}
let lastThreads = null; // stable() of the statuses last written
function publishThreads() {
  const envId = environmentId();
  const next = threadStatuses(envId);
  const file = path.join(feedDir, "t3plus-threads.json");
  // A worker started since (t3+ re-run): the copy on disk is what was last written.
  // The machine too: a file written while its id was unreadable is written again once it is.
  if (lastThreads === null) { try { const { environmentId, threads, projects } = JSON.parse(fs.readFileSync(file, "utf8")); lastThreads = stable({ envId: environmentId, threads, projects }); } catch {} }
  const nextStable = stable({ envId, ...next });
  if (nextStable === lastThreads) return false;
  writeAtomic(file, JSON.stringify({ version: 1, generatedAt: nowIso(), environmentId: envId, ...next }));
  lastThreads = nextStable;
  return true;
}

async function publishHome() {
  const api = readT3();
  let dbPart;
  try { dbPart = homeDatabase(ACTIVITY_DAYS); } catch (e) { api.catch(() => {}); throw e; }
  const t3 = await api;
  const lim = limits(t3.providers, t3.sources);
  const pool = codexPool(lim.codex);
  const at = new Date().toISOString().replace(/\.\d{3}Z$/, "+00:00");
  const history = updateHistory(pool, lim.claude, at);
  const usage = usageKept(t3.summary, t3.summaryOk);
  // The transcript folders T3's usage scan reads, for finding a thread's logs (logRoots).
  if (t3.summaryOk) {
    const homes = { claude: [], codex: [] };
    for (const src of t3.summary.sources || []) {
      const f = src && src.fingerprint;
      if (f && homes[f.provider] && typeof f.resolvedHomePath === "string" && !homes[f.provider].includes(f.resolvedHomePath)) homes[f.provider].push(f.resolvedHomePath);
    }
    try { writeAtomic(HOMES_FILE, JSON.stringify(homes)); } catch {}
  }
  // Only what the page shows. Project folders (paths with the user's name), titles,
  // automations and the raw limit history went into the feed and its browser-storage
  // copy unused; the activity cells only need each project's place in the list.
  const data = {
    version: 1,
    generatedAt: nowIso(),
    timeZone,
    projects: dbPart.projects,
    activity: dbPart.activity,
    spend: usage.spend,
    limits: { ...lim, claude: lim.claude.map(({ key, ...account }) => account), pool },
    codexSeries: codexSeries(history),
    claudeSeries: claudeSeries(history),
    aiActivity: usage.activity,
  };
  writeAtomic(path.join(feedDir, "t3plus-home.json"), JSON.stringify(data));
  return true;
}

const OPS = {
  bots: (args) => publishBots(args.ids),
  threads: () => publishThreads(),
  home: () => publishHome(),
  // t3+ turned off or replaced: the T3 session revoked, the spend cache written as it is.
  dispose: () => {
    dropSession();
    writeSpendCache();
    return null;
  },
};
parentPort.on("message", ({ id, op, args }) => {
  // Calls run one at a time per kind (the loader queues them); a bot refresh may run while the home feed waits on T3's API.
  Promise.resolve()
    .then(() => (Object.hasOwn(OPS, op) ? OPS[op](args) : null))
    .then((result) => parentPort.postMessage({ id, result }), (error) => parentPort.postMessage({ id, error: String((error && error.message) || error) }));
});
