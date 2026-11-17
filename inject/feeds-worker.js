// t3+ data feeds, worker side (started by inject/feeds.js inside T3 Code's main
// process). Everything that reads files, T3's database or T3's API, and every
// feed write, happens here, so T3's main thread only passes two small messages
// per publish. T3's database is opened read-only; nothing in T3 is ever written.
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
let rates = null;
function rateFor(model) {
  if (!rates) {
    try { rates = JSON.parse(fs.readFileSync(path.join(cfg.t3Home, "userdata", "usage-model-rates.json"), "utf8")).document || {}; } catch { rates = {}; }
  }
  const m = String(model || "");
  for (const key of [m, m.split("@")[0], /\d{8}$/.test(m) ? m.replace(/-\d{8}$/, "") : null]) {
    if (key && rates[key] && typeof rates[key] === "object" && "input_cost_per_token" in rates[key]) return rates[key];
  }
  return null;
}
function claudeCost(model, u) {
  const r = rateFor(model);
  const oneHour = Number(u.cache_creation?.ephemeral_1h_input_tokens) || 0;
  const write = Number(u.cache_creation_input_tokens) || 0;
  const fiveMin = Math.max(0, write - oneHour);
  const input = Number(u.input_tokens) || 0;
  const read = Number(u.cache_read_input_tokens) || 0;
  const out = Number(u.output_tokens) || 0;
  const tokens = input + read + write + out;
  if (!r) return [0, tokens];
  const inRate = r.input_cost_per_token || 0;
  const cc = r.cache_creation_input_token_cost ?? inRate;
  return [input * inRate + read * (r.cache_read_input_token_cost ?? inRate) + fiveMin * cc + oneHour * (r.cache_creation_input_token_cost_above_1hr ?? cc) + out * (r.output_cost_per_token || 0), tokens];
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
function readClaude(file, entry, size) {
  for (const lines of newLines(file, entry, size, ['"usage"'])) {
    for (const line of lines) {
      if (!line.includes('"usage"')) continue;
      const d = json(line);
      const m = d?.message;
      const u = m?.usage;
      if (!u || typeof u !== "object" || !m.model || m.model === "<synthetic>") continue;
      const [usd, tokens] = claudeCost(m.model, u);
      // A message's lines repeat its usage (the last one is final): count each id once.
      if (m.id && m.id === entry.pending_id) entry.pending = [usd, tokens];
      else {
        const p = entry.pending || [0, 0];
        entry.usd = (entry.usd || 0) + p[0];
        entry.tokens = (entry.tokens || 0) + p[1];
        entry.pending_id = m.id || "";
        entry.pending = [usd, tokens];
      }
    }
  }
}
function readCodex(file, entry, size) {
  for (const lines of newLines(file, entry, size, ['"turn_context"', '"token_count"'])) {
    for (const line of lines) {
      if (line.includes('"turn_context"') && line.includes('"model"')) {
        const d = json(line);
        if (d?.payload?.model) entry.model = d.payload.model;
      }
      if (!line.includes('"token_count"')) continue;
      const total = json(line)?.payload?.info?.total_token_usage;
      if (total) entry.total = total;
    }
  }
  const t = entry.total || {};
  const r = rateFor(entry.model) || {};
  const cached = Number(t.cached_input_tokens) || 0;
  const fresh = Math.max(0, (Number(t.input_tokens) || 0) - cached);
  const out = Number(t.output_tokens) || 0;
  entry.tokens = Number(t.total_tokens) || 0;
  entry.usd = fresh * (r.input_cost_per_token || 0) + cached * (r.cache_read_input_token_cost ?? r.input_cost_per_token ?? 0) + out * (r.output_cost_per_token || 0);
}
function listDir(dir) { try { return fs.readdirSync(dir); } catch { return []; } }
function sessionFiles(driver, nativeId) {
  const found = [];
  if (driver === "claudeAgent") {
    const root = path.join(HOME, ".claude", "projects");
    for (const project of listDir(root)) {
      const main = path.join(root, project, nativeId + ".jsonl");
      if (!fs.existsSync(main)) continue;
      found.push(["claude", main]); // its subagents' logs are listed on every pass (withSubagents): new ones keep appearing
    }
  } else if (driver === "codex") {
    const root = path.join(HOME, ".codex", "sessions");
    for (const y of listDir(root)) for (const m of listDir(path.join(root, y))) for (const d of listDir(path.join(root, y, m))) {
      for (const f of listDir(path.join(root, y, m, d))) if (f.startsWith("rollout-") && f.endsWith("-" + nativeId + ".jsonl")) found.push(["codex", path.join(root, y, m, d, f)]);
    }
  }
  return found;
}
const fileIndex = new Map(); // "driver:nativeId" -> main session files (they do not move)
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
function spendFor(conn, threadIds) {
  if (!spendCache) { try { spendText = fs.readFileSync(SPEND_CACHE, "utf8"); spendCache = JSON.parse(spendText); } catch { spendCache = {}; } }
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
    for (const ref of refs) {
      const [driver, nativeId] = [ref.slice(0, ref.indexOf(":")), ref.slice(ref.indexOf(":") + 1)];
      if (!fileIndex.has(ref) || !fileIndex.get(ref).length) fileIndex.set(ref, sessionFiles(driver, nativeId));
      for (const [kind, file] of withSubagents(fileIndex.get(ref), nativeId)) {
        let entry = spendCache[file];
        let size = 0;
        try { size = fs.statSync(file).size; } catch { continue; }
        if (!entry || (entry.offset || 0) > size) entry = {};
        try { (kind === "claude" ? readClaude : readCodex)(file, entry, size); } catch { continue; }
        spendCache[file] = entry;
        const p = kind === "claude" ? entry.pending || [0, 0] : [0, 0];
        usd += (entry.usd || 0) + p[0];
        tokens += (entry.tokens || 0) + p[1];
      }
    }
    if (tokens) out[threadId] = { usd: Math.round(usd * 1e4) / 1e4, tokens };
  }
  const text = JSON.stringify(spendCache);
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
    const manual = ids.slice(0, MAX_BOTS);
    const rows = conn.prepare("SELECT thread_id, title, payload_json FROM orchestration_v2_projection_threads WHERE deleted_at IS NULL AND archived_at IS NULL AND (title LIKE ? OR thread_id IN (" + manual.map(() => "?").join(",") + "))").all("%" + MARKER + "%", ...manual);
    const isBot = (title) => { const w = String(title || "").split(/\s+/).filter(Boolean); return w.length > 0 && (w[0] === MARKER || w[w.length - 1] === MARKER); };
    const messages = conn.prepare("SELECT role, created_at, payload_json FROM orchestration_v2_projection_messages WHERE thread_id = ? AND role IN ('assistant', 'user') ORDER BY created_at DESC LIMIT 6");
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

// ---------- Home: what only the database knows (projects, runs per day, automations) ----------
const localDay = (iso) => {
  const d = new Date(iso || "");
  return Number.isFinite(d.getTime()) ? d.toLocaleDateString("en-CA") : null; // YYYY-MM-DD, machine time zone
};
function homeDatabase(envId, activityDays) {
  const conn = db();
  try {
    const projects = [];
    const index = new Map();
    for (const r of conn.prepare("SELECT project_id, title, workspace_root FROM projection_projects WHERE deleted_at IS NULL").all()) {
      index.set(r.project_id, projects.length);
      projects.push({ title: String(r.title || "").slice(0, 60), root: String(r.workspace_root || "").slice(0, 260) });
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
    const automations = conn.prepare("SELECT title, enabled, project_id, thread_id, next_run_at, last_run_at, last_run_status, run_count FROM scheduled_tasks WHERE enabled = 1 ORDER BY next_run_at IS NULL, next_run_at LIMIT 60").all().map((r) => ({
      title: String(r.title || "").slice(0, 80),
      project: index.has(r.project_id) ? index.get(r.project_id) : null,
      threadKey: envId && r.thread_id ? envId + ":" + r.thread_id : null,
      nextRunAt: r.next_run_at, lastRunAt: r.last_run_at,
      lastStatus: String(r.last_run_status || "").slice(0, 20), runCount: Number(r.run_count) || 0,
    }));
    return { projects, activity, automations };
  } finally {
    conn.close();
  }
}

// ---------- Feed shaping and writing (formerly on T3's main thread) ----------
const ACTIVITY_DAYS = 26 * 7;
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
async function readT3() {
  // The protocol version is looked up while the CLI issues the session (the CLI takes ~0.4 s).
  const issuing = run(["auth", "session", "issue", "--base-dir", t3Home, "--ttl", "5m", "--label", "t3plus home feed", "--json", "--scope", "orchestration:read", "--scope", "diagnostics:read"]);
  const looking = (async () => {
    const runtime = JSON.parse(fs.readFileSync(path.join(t3Home, "userdata", "server-runtime.json"), "utf8"));
    const base = "127.0.0.1:" + (runtime.port || 3773);
    const env = await (await fetch("http://" + base + "/.well-known/t3/environment", { signal: AbortSignal.timeout(10000) })).json();
    return { base, proto: env.orchestrationProtocolVersion || 1 };
  })();
  looking.catch(() => {}); // a failed lookup is reported below, after the session is safely revoked
  const issued = await issuing;
  let session = null;
  try {
    // Only the JSON object: a notice the CLI prints around it must not leave the session unrevoked.
    session = JSON.parse(issued.slice(issued.indexOf("{"), issued.lastIndexOf("}") + 1));
    const { base, proto } = await looking;
    const today = new Date();
    const since = new Date(today.getTime() - Math.max(SPEND_DAYS, ACTIVITY_DAYS) * 86400000).toLocaleDateString("en-CA");
    return await new Promise((resolve, reject) => {
      const ws = new WebSocket("ws://" + base + "/ws?orchestrationProtocol=" + proto, { headers: { Authorization: "Bearer " + session.token } });
      let summary = null;
      let providers = null;
      let sources = null;
      const finish = () => {
        if (summary === null || sources === null) return;
        clearTimeout(timer);
        try { ws.close(); } catch {}
        resolve({ summary: summary || {}, providers: providers || [], sources: sources || [] });
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
          else if (frame._tag === "Exit" && String(frame.requestId) === "summary") summary = frame.exit?._tag === "Success" ? frame.exit.value : {};
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
  } finally {
    const id = session ? session.sessionId : (/"sessionId"\s*:\s*"([^"]+)"/.exec(issued) || [])[1];
    if (id) run(["auth", "session", "revoke", "--base-dir", t3Home, id]).catch((e) => log("session revoke failed:", e && e.message));
    else log("session revoke skipped: no session id in the CLI's answer");
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
    if (driver !== "claudeAgent" || !p.usageLimits) continue;
    const windows = (p.usageLimits.windows || []).map(cleanWindow).filter(Boolean);
    if (!windows.length) continue;
    claude.push({ id: p.instanceId, label: safeLabel(p.displayName || p.label || p.instanceId, "Claude"), plan: String(p.auth?.type || "").slice(0, 40), windows, checkedAt: p.usageLimits.checkedAt });
  }
  let codex = null;
  for (const s of sources) {
    if (s.id !== "codex_gateway") continue;
    const accounts = (s.accounts || []).map((a, i) => ({ label: safeLabel(a.email, "Account " + (i + 1)), plan: String(a.plan || "").slice(0, 40), windows: (a.usageLimits?.windows || []).map(cleanWindow).filter(Boolean) }));
    codex = { label: safeLabel(s.label, "Codex"), checkedAt: s.checkedAt, accounts };
  }
  if (!codex) {
    // No Codex Gateway: the Codex account T3 itself is signed in to.
    for (const p of providers) {
      if ((p.driver || p.provider) !== "codex" || !p.usageLimits) continue;
      const windows = (p.usageLimits.windows || []).map(cleanWindow).filter(Boolean);
      if (windows.length) codex = { label: "Codex", checkedAt: p.usageLimits.checkedAt, accounts: [{ label: "Codex", plan: String(p.auth?.label || "").slice(0, 40), windows }] };
    }
  }
  return { claude, codex };
}
const planWeight = (plan) => (/pro/i.test(plan || "") ? 10 : 1);
const claudeWeight = (plan) => (/max/i.test(plan || "") ? 5 : 1);
function codexPool(codex) {
  if (!codex) return null;
  let cap = 0, weekLeft = 0, fiveLeft = 0, fiveCap = 0;
  const single = codex.accounts.length === 1;
  for (const a of codex.accounts) {
    const weight = single ? 100 : planWeight(a.plan) * 100;
    const weekly = a.windows.find((w) => (w.durationMins || 0) >= 1440);
    const five = a.windows.find((w) => (w.durationMins || 0) > 0 && (w.durationMins || 0) < 1440);
    cap += weight;
    weekLeft += weight * (1 - (weekly ? weekly.usedPercent : 0) / 100);
    if (five) { fiveCap += weight; fiveLeft += weight * (1 - five.usedPercent / 100); }
  }
  return { weekLeft: Math.round(weekLeft), weekCap: Math.round(cap), fiveLeft: Math.round(fiveLeft), fiveCap: Math.round(fiveCap) };
}
function spend(summary) {
  const first = new Date(Date.now() - SPEND_DAYS * 86400000).toLocaleDateString("en-CA");
  const byDay = {};
  for (const b of summary.buckets || []) {
    if (!b.day || !b.provider || b.day < first) continue;
    const cell = ((byDay[b.day] ||= {})[b.provider] ||= [0, 0]);
    cell[0] += Number(b.costUsd) || 0;
    cell[1] += Object.values(b.totals || {}).reduce((n, v) => n + (Number(v) || 0), 0);
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
    days[b.day][String(b.provider).slice(0, 24)] = p + Object.values(b.totals || {}).reduce((n, v) => n + (Number(v) || 0), 0);
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
    const weekly = c.windows.find((w) => (w.durationMins || 0) >= 1440);
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
function claudeSeries(history, claude) {
  const weights = Object.fromEntries(claude.map((c) => [c.id, claude.length === 1 ? 100 : claudeWeight(c.plan) * 100]));
  const points = [];
  for (const h of history) {
    if (!h.claudeWeekUsed || !Object.keys(h.claudeWeekUsed).length) continue;
    let cap = 0, left = 0;
    for (const [k, v] of Object.entries(h.claudeWeekUsed)) { const w = weights[k] ?? 100; cap += w; left += w * (1 - v / 100); }
    points.push([Math.floor(Date.parse(h.t) / 1000), Math.round(left), cap]);
  }
  return points;
}
const codexSeries = (history) => history.filter((h) => h.weekCap).map((h) => [Math.floor(Date.parse(h.t) / 1000), h.weekLeft || 0, h.weekCap]);

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
  const data = {
    version: 1,
    generatedAt: nowIso(),
    timeZone,
    projects: dbPart.projects,
    activity: dbPart.activity,
    spend: spend(t3.summary),
    limits: { ...lim, pool },
    limitHistory: history,
    codexSeries: codexSeries(history),
    claudeSeries: claudeSeries(history, lim.claude),
    aiActivity: usageActivity(t3.summary),
    automations: dbPart.automations,
  };
  writeAtomic(path.join(feedDir, "t3plus-home.json"), JSON.stringify(data));
  return true;
}

parentPort.on("message", ({ id, op, args }) => {
  // Calls run one at a time per kind (the loader queues them); a bot refresh may run while the home feed waits on T3's API.
  Promise.resolve()
    .then(() => (op === "bots" ? publishBots(args.ids) : op === "home" ? publishHome() : null))
    .then((result) => parentPort.postMessage({ id, result }), (error) => parentPort.postMessage({ id, error: String((error && error.message) || error) }));
});
