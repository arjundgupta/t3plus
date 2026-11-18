// t3+ data feeds, worker side (started by inject/feeds.js inside T3 Code's main
// process). Everything that reads files, T3's database or T3's API, and every
// feed write, happens here, so T3's main thread only passes two small messages
// per publish. T3's database is opened read-only. The one thing t3+ makes in T3 is
// the read-only API session for the home feed (T3's CLI issues it; it is reused for
// a quarter of an hour, then revoked), which T3 records like any session.
"use strict";
const { parentPort, workerData } = require("worker_threads");
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
  let t = String(text ?? "");
  t = t.replace(/```[\s\S]*?```/g, " ");
  t = t.replace(/!\[[^\]]*\]\([^)]*\)/g, " ");
  t = t.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1");
  t = t.replace(/`([^`]*)`/g, "$1");
  t = t.replace(/(\*\*|__|\*|_|~~)(?=\S)(.+?)(?<=\S)\1/g, "$2");
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
    if (!p || (entry.seenSet ||= new Set(entry.seen || [])).has(p.key) || pending.has(p.key)) continue;
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
let spendText = null; // the cache as last written: an unchanged cache is not written again
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
function firstTime(entry, key) {
  entry.seenSet ||= new Set(entry.seen || []);
  if (entry.seenSet.has(key)) return false;
  entry.seenSet.add(key);
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
function sessionFiles(driver, nativeId) {
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
    for (const root of logRoots("codex")) {
      for (const y of listDir(root)) for (const m of listDir(path.join(root, y))) for (const d of listDir(path.join(root, y, m))) {
        for (const f of listDir(path.join(root, y, m, d))) if (f.startsWith("rollout-") && f.endsWith("-" + nativeId + ".jsonl")) found.push(["codex", path.join(root, y, m, d, f)]);
      }
    }
  }
  return found;
}
// "driver:nativeId" -> { files, at }: main session files (they do not move). One not
// found (a remote machine's thread, a log elsewhere) is looked for again only now and
// then: for Codex that is a walk of every day folder.
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
      spendText = fs.readFileSync(SPEND_CACHE, "utf8");
      const cached = JSON.parse(spendText);
      spendCache = cached && cached.v === SPEND_CACHE_VERSION && cached.files && typeof cached.files === "object" ? cached.files : {};
    } catch {
      spendCache = {};
    }
  }
  const now = Date.now();
  const out = {};
  const sessions = conn.prepare("SELECT payload_json FROM orchestration_v2_projection_provider_threads WHERE thread_id = ?");
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
      if (!known || (!known.files.length && now - known.at > MISSING_RETRY_MS)) fileIndex.set(ref, { files: sessionFiles(driver, nativeId), at: now });
      files.push(...withSubagents(fileIndex.get(ref).files, nativeId));
    }
    // Oldest log first: a resumed session's copies are then the ones skipped.
    const sized = files.map(([kind, file]) => { try { const st = fs.statSync(file); return { kind, file, size: st.size, born: st.birthtimeMs || st.mtimeMs }; } catch { return null; } }).filter(Boolean).sort((a, b) => a.born - b.born);
    // A log that shrank (rewritten) means reading this thread again from the start.
    if (sized.some(({ file, size }) => (entry.files[file]?.offset || 0) > size)) entry = { files: {}, agg: {} };
    for (const { kind, file, size } of sized) {
      const f = (entry.files[file] ||= {});
      try { (kind === "claude" ? readClaude : readCodex)(file, entry, f, size); } catch { continue; }
    }
    if (now - (entry.seenAt || 0) > 86400000) entry.seenAt = now; // daily: the cache is not rewritten for this alone
    spendCache[threadId] = entry;
    [usd, tokens] = entrySpend(entry);
    if (tokens) out[threadId] = { usd: Math.round(usd * 1e4) / 1e4, tokens };
  }
  // Logs of threads not looked at in a month are forgotten (read again if they come back).
  for (const [id, entry] of Object.entries(spendCache)) if (!entry || now - (entry.seenAt || 0) > SPEND_KEEP_MS) delete spendCache[id];
  for (const entry of Object.values(spendCache)) if (entry.seenSet) entry.seen = [...entry.seenSet];
  const text = JSON.stringify({ v: SPEND_CACHE_VERSION, files: spendCache }, (k, v) => (k === "seenSet" ? undefined : v));
  if (text !== spendText) {
    try {
      fs.mkdirSync(path.dirname(SPEND_CACHE), { recursive: true });
      fs.writeFileSync(SPEND_CACHE + ".tmp", text, { mode: 0o600 });
      fs.renameSync(SPEND_CACHE + ".tmp", SPEND_CACHE);
      spendText = text;
    } catch {}
  }
  return out;
}

function subagents(conn, threadId) {
  const latest = conn.prepare("SELECT run_id FROM orchestration_v2_projection_subagents WHERE thread_id = ? ORDER BY started_at DESC LIMIT 1").get(threadId);
  if (!latest) return [];
  const rows = conn.prepare("SELECT status, payload_json FROM orchestration_v2_projection_subagents WHERE thread_id = ? AND run_id = ? ORDER BY started_at").all(threadId, latest.run_id);
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
    const messages = conn.prepare("SELECT role, created_at, payload_json FROM orchestration_v2_projection_messages WHERE thread_id = ? AND role IN ('assistant', 'user') ORDER BY created_at DESC LIMIT 6");
    rows.sort((a, b) => (rank.get(a.thread_id) ?? Infinity) - (rank.get(b.thread_id) ?? Infinity));
    const out = {};
    for (const row of rows.slice(0, MAX_BOTS)) {
      if (!isBot(row.title) && !manual.includes(row.thread_id)) continue;
      const selection = json(row.payload_json)?.modelSelection || {};
      const effort = (selection.options || []).find((o) => o?.id === "reasoningEffort")?.value;
      const entry = { text: "", role: "assistant", at: null, model: modelLabel(String(selection.model || "")), effort: String(effort || "").slice(0, 16), computer: cfg.computer };
      for (const m of messages.all(row.thread_id)) {
        const text = plain(String(json(m.payload_json)?.text || ""));
        if (text) { Object.assign(entry, { text, role: m.role, at: m.created_at }); break; }
      }
      const subs = subagents(conn, row.thread_id);
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
function homeDatabase(envId, activityDays) {
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
const HOUR = 3600000;

const { home, t3Home, t3Cli, timeZone } = cfg;
const feedDir = path.join(home, "feeds");
const stateDir = path.join(home, "state");
function writeAtomic(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file + ".tmp", text, { mode: 0o600 });
  fs.renameSync(file + ".tmp", file);
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
const run = (args) => new Promise((resolve, reject) => cp.execFile(t3Cli, args, { timeout: 30000, encoding: "utf8" }, (e, out) => (e ? reject(e) : resolve(out))));
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
  try {
    const { base, proto } = await looking;
    const today = new Date();
    const since = new Date(today.getTime() - USAGE_DAYS * 86400000).toLocaleDateString("en-CA");
    return await new Promise((resolve, reject) => {
      const ws = new WebSocket("ws://" + base + "/ws?orchestrationProtocol=" + proto, { headers: { Authorization: "Bearer " + session.token } });
      let summary = null;
      let summaryOk = false;
      let providers = null;
      let sources = null;
      const finish = () => {
        if (summary === null || sources === null) return;
        clearTimeout(timer);
        try { ws.close(); } catch {}
        resolve({ summary: summary || {}, summaryOk, providers: providers || [], sources: sources || [] });
      };
      const timer = setTimeout(() => { try { ws.close(); } catch {} reject(new Error("T3 API timed out")); }, 45000);
      ws.onerror = () => { clearTimeout(timer); reject(new Error("T3 API connection failed")); };
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
  } catch (e) {
    // A failed read may be the session (expired early, revoked by the user): the next
    // publish starts with a new one.
    dropSession();
    throw e;
  }
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
function limits(providers, sources) {
  const claude = [];
  for (const p of providers) {
    const driver = p.driver || p.provider || "";
    if (driver !== "claudeAgent" || !p.usageLimits || p.enabled === false) continue;
    const windows = (p.usageLimits.windows || []).map(cleanWindow).filter(Boolean);
    if (!windows.length) continue;
    claude.push({ id: p.instanceId, label: safeLabel(p.displayName || p.label || p.instanceId, "Claude"), plan: String(p.auth?.type || "").slice(0, 40), windows, checkedAt: p.usageLimits.checkedAt });
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
        if (windows.length) claude.push({ id: String(s.id + ":" + a.id).slice(0, 80), label: safeLabel(a.email, "Claude " + (claude.length + 1)), plan: String(a.plan || "").slice(0, 40), windows, checkedAt: a.usageLimits.checkedAt });
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
    if (weekly) (entry.claudeWeekUsed ||= {})[c.id] = weekly.usedPercent;
  }
  history = [...history.filter((h) => (h.t || "") >= cutoff), entry];
  writeAtomic(file, JSON.stringify(history));
  // At most one point per 10 minutes in the published copy keeps it small.
  const thinned = [];
  let last = null;
  for (const h of history) {
    const t = Date.parse(h.t);
    if (last === null || t - last >= 10 * 60000 || h === history[history.length - 1]) { thinned.push(h); last = t; }
  }
  return thinned;
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

async function publishHome() {
  const envId = environmentId();
  const api = readT3();
  let dbPart;
  try { dbPart = homeDatabase(envId, ACTIVITY_DAYS); } catch (e) { api.catch(() => {}); throw e; }
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
    limits: { ...lim, pool },
    codexSeries: codexSeries(history),
    claudeSeries: claudeSeries(history),
    aiActivity: usage.activity,
  };
  writeAtomic(path.join(feedDir, "t3plus-home.json"), JSON.stringify(data));
  return true;
}

parentPort.on("message", ({ id, op, args }) => {
  // Calls run one at a time per kind (the loader queues them); a bot refresh may run while the home feed waits on T3's API.
  Promise.resolve()
    .then(() => (op === "bots" ? publishBots(args.ids) : op === "home" ? publishHome() : op === "dispose" ? (dropSession(), null) : null))
    .then((result) => parentPort.postMessage({ id, result }), (error) => parentPort.postMessage({ id, error: String((error && error.message) || error) }));
});
