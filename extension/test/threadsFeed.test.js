import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Worker } from "node:worker_threads";
import { parseThreadsFeedText } from "../src/statusView.js";

// The desktop loader's thread-status feed (inject/feeds-worker.js, op "threads"), run on a
// T3 database made here: each of T3's sidebar status rules, one thread each.
const WORKER = new URL("../../inject/feeds-worker.js", import.meta.url);
const NOW = Date.now();
const at = (minutesAgo) => new Date(NOW - minutesAgo * 60_000).toISOString();
// T3's tables, with the columns the feed reads. OLDER_SCHEMA lacks what "limited" and "waiting"
// are read from (T3's provider tables, a thread's provider instance, a turn item's node and
// order), as an older T3's database, or one not T3's, may; SCHEMA adds them.
const OLDER_SCHEMA = `
    CREATE TABLE orchestration_v2_projection_threads (thread_id TEXT PRIMARY KEY, project_id TEXT, title TEXT, updated_at TEXT, deleted_at TEXT, archived_at TEXT, payload_json TEXT);
    CREATE TABLE orchestration_v2_projection_runs (run_id TEXT PRIMARY KEY, thread_id TEXT, ordinal INTEGER, status TEXT, requested_at TEXT, completed_at TEXT, payload_json TEXT);
    CREATE TABLE orchestration_v2_projection_runtime_requests (runtime_request_id TEXT PRIMARY KEY, thread_id TEXT, kind TEXT, status TEXT, created_at TEXT);
    CREATE TABLE projection_projects (project_id TEXT PRIMARY KEY, title TEXT, workspace_root TEXT, deleted_at TEXT);
    CREATE TABLE orchestration_v2_projection_turn_items (turn_item_id TEXT PRIMARY KEY, thread_id TEXT, run_id TEXT, type TEXT, status TEXT, updated_at TEXT, payload_json TEXT);
    CREATE TABLE orchestration_v2_projection_messages (message_id TEXT PRIMARY KEY, thread_id TEXT, role TEXT, created_at TEXT, updated_at TEXT, payload_json TEXT);`;
const SCHEMA = `${OLDER_SCHEMA}
    ALTER TABLE orchestration_v2_projection_threads ADD COLUMN provider_instance_id TEXT;
    ALTER TABLE orchestration_v2_projection_turn_items ADD COLUMN node_id TEXT;
    ALTER TABLE orchestration_v2_projection_turn_items ADD COLUMN ordinal INTEGER;
    CREATE TABLE orchestration_v2_projection_provider_threads (provider_thread_id TEXT PRIMARY KEY, thread_id TEXT, payload_json TEXT);
    CREATE TABLE orchestration_v2_projection_provider_sessions (provider_session_id TEXT PRIMARY KEY, provider_instance_id TEXT, updated_at TEXT, payload_json TEXT);
    CREATE TABLE orchestration_v2_projection_provider_session_bindings (provider_session_id TEXT, thread_id TEXT);`;

/** A T3 home whose database (SCHEMA, or OLDER_SCHEMA) has the rows build() adds with the helpers. */
function makeT3Home(build, { older = false } = {}) {
  const home = mkdtempSync(join(tmpdir(), "t3plus-feed-"));
  mkdirSync(join(home, "t3", "userdata"), { recursive: true });
  writeFileSync(join(home, "t3", "userdata", "environment-id"), "env-test\n");
  const db = new DatabaseSync(join(home, "t3", "userdata", "statev2.sqlite"));
  db.exec(older ? OLDER_SCHEMA : SCHEMA);
  const repo = join(home, "repo");
  mkdirSync(join(repo, ".git"), { recursive: true });
  writeFileSync(join(repo, ".git", "config"), '[core]\n\tbare = false\n[remote "origin"]\n\turl = git@github.com:Acme/api.git\n');
  db.prepare("INSERT INTO projection_projects VALUES (?, ?, ?, NULL)").run("p1", "API", repo);
  db.prepare("INSERT INTO projection_projects VALUES (?, ?, ?, NULL)").run("p2", "Scratch", join(home, "t3", "scratch"));
  const insert = (table, row) => db.prepare(`INSERT INTO orchestration_v2_projection_${table} (${Object.keys(row).join(", ")}) VALUES (${Object.keys(row).map(() => "?").join(", ")})`).run(...Object.values(row));
  const thread = (id, payload = {}, extra = {}) =>
    insert("threads", { thread_id: id, project_id: extra.project ?? "p1", title: extra.title ?? `Thread ${id}`, updated_at: at(60), archived_at: extra.archived ?? null, deleted_at: extra.deleted ?? null, payload_json: JSON.stringify({ lastVisitedAt: at(30), ...payload }), ...(older ? {} : { provider_instance_id: "claude" }) });
  let n = 0;
  const run = (thread_, status, requested, completed = null, payload = {}) => {
    const id = `r${(n += 1)}`;
    insert("runs", { run_id: id, thread_id: thread_, ordinal: n, status, requested_at: at(requested), completed_at: completed === null ? null : at(completed), payload_json: JSON.stringify({ rootNodeId: `${id}:root`, ...payload }) });
    return id;
  };
  const request = (thread_, kind, status = "pending", minutesAgo = 5) => insert("runtime_requests", { runtime_request_id: `q${(n += 1)}`, thread_id: thread_, kind, status, created_at: at(minutesAgo) });
  const card = (thread_, type, minutesAgo, runId = null) => insert("turn_items", { turn_item_id: `i${(n += 1)}`, thread_id: thread_, run_id: runId, type, status: "waiting", updated_at: at(minutesAgo), payload_json: "{}" });
  const wrote = (thread_, minutesAgo, payload = { createdBy: "user", text: "ok" }) => {
    const id = `m${(n += 1)}`;
    insert("messages", { message_id: id, thread_id: thread_, role: "user", created_at: at(minutesAgo), updated_at: at(minutesAgo), payload_json: JSON.stringify(payload) });
    return id;
  };
  // With T3's provider tables: a run's turn item at a node (its root's by default), a failure,
  // the provider's session (its last error) and provider thread (the tasks it reports).
  const item = (thread_, runId, type, status, payload = {}, { node = `${runId}:root`, minutesAgo = 1 } = {}) =>
    insert("turn_items", { turn_item_id: `i${(n += 1)}`, thread_id: thread_, run_id: runId, type, status, updated_at: at(minutesAgo), payload_json: JSON.stringify(payload), node_id: node, ordinal: n });
  const failure = (thread_, runId, failureClass, { status = "failed", message = "You've hit your limit", ...where } = {}) =>
    item(thread_, runId, "error", status, { failure: { class: failureClass, message, code: null, retryable: null } }, where);
  const session = (thread_, lastError) => {
    const id = `s${(n += 1)}`;
    insert("provider_sessions", { provider_session_id: id, provider_instance_id: "claude", updated_at: at(5), payload_json: JSON.stringify({ lastError }) });
    insert("provider_session_bindings", { provider_session_id: id, thread_id: thread_ });
  };
  const providerThread = (thread_, tasks, { id = `pt${(n += 1)}`, goal } = {}) =>
    insert("provider_threads", { provider_thread_id: id, thread_id: thread_, payload_json: JSON.stringify({ id, pendingBackgroundTasks: tasks, ...(goal ? { goal: { objective: "Ship it", status: goal } } : {}) }) });
  build({ thread, run, request, card, wrote, item, failure, session, providerThread });
  db.close();
  return home;
}

function sidebarRules({ thread, run, request, card, wrote, item, failure, session, providerThread }) {
  thread("approval"); run("approval", "running", 10); request("approval", "command");
  thread("input"); run("input", "running", 10); request("input", "user_input");
  thread("both"); request("both", "user_input"); request("both", "file-change"); // an approval outranks a question
  thread("parent"); run("parent", "running", 10);
  thread("sub", { lineage: { relationshipToParent: "subagent", parentThreadId: "parent", rootThreadId: "parent" } }); run("sub", "running", 3); request("sub", "command"); // a running subagent's approval: the parent's
  thread("idleparent"); run("idleparent", "running", 10);
  thread("idlesub", { lineage: { relationshipToParent: "subagent", parentThreadId: "idleparent" } }); run("idlesub", "completed", 9, 8); request("idlesub", "command"); // not running: not passed up
  thread("toolparent"); run("toolparent", "running", 10);
  thread("toolsub", { creationSource: "provider", lineage: { relationshipToParent: "subagent", parentThreadId: "toolparent" } }); run("toolsub", "running", 3); request("toolsub", "command"); // the provider's own: not passed up
  thread("chatparent");
  thread("chat", { lineage: { sideChat: true, parentThreadId: "chatparent", rootThreadId: "chatparent" } }); request("chat", "user_input"); // a side chat's question: its parent's
  thread("refresh"); request("refresh", "auth_refresh"); // no word of its own (T3)
  // T3 picks one request a thread: an approval with a newer sign-in refresh shows no word.
  thread("approvalrefresh"); request("approvalrefresh", "command", "pending", 9); request("approvalrefresh", "auth_refresh", "pending", 2);
  // Cards only you can answer: a secret on a running subagent is its parent's question too.
  thread("secretparent"); run("secretparent", "running", 10);
  thread("secretsub", { lineage: { relationshipToParent: "subagent", parentThreadId: "secretparent" } });
  card("secretsub", "secret_request", 2, run("secretsub", "running", 3));
  thread("linkopen"); card("linkopen", "link_request", 4); // a link to open: input
  thread("linkdone"); card("linkdone", "link_request", 4); wrote("linkdone", 2); // written since: no longer
  thread("linkagent"); card("linkagent", "link_request", 4); wrote("linkagent", 2, { createdBy: "agent", text: "status" }); // not by you: still asks
  // T3's own idle "/compact" run: out of sight (not working, not done); the run before it is the one shown.
  thread("compacting"); run("compacting", "completed", 90, 80);
  run("compacting", "running", 1, null, { userMessageId: wrote("compacting", 1, { createdBy: "agent", creationSource: "server", text: " /compact " }) });
  // A queued run held back: not the one shown either; a plain queued one is the latest run, working (T3).
  thread("held"); run("held", "completed", 90, 80); run("held", "queued", 1, null, { queueHeld: true });
  thread("queuedparent"); run("queuedparent", "running", 10);
  thread("queuedsub", { lineage: { relationshipToParent: "subagent", parentThreadId: "queuedparent" } }); run("queuedsub", "queued", 1); request("queuedsub", "command"); // queued: not active
  thread("failedseen", { lastVisitedAt: at(5) }); run("failedseen", "failed", 20, 10); // failed before you last looked
  // Snoozed, a sign-in refresh woke it after you looked: "woke".
  thread("refreshwoke", { lastVisitedAt: at(90), snoozedUntil: new Date(NOW + 3600_000).toISOString(), snoozedAt: at(60) }); request("refreshwoke", "auth_refresh");
  thread("refreshsnoozed", { snoozedUntil: new Date(NOW + 3600_000).toISOString(), snoozedAt: at(60) }); request("refreshsnoozed", "auth_refresh"); // but it wakes
  thread("side", { lineage: { sideChat: true, rootThreadId: "parent" } });
  thread("fork", { lineage: { relationshipToParent: "fork", parentThreadId: "parent", rootThreadId: "parent" } }); run("fork", "preparing", 1);
  thread("working"); run("working", "completed", 50, 45); run("working", "running", 2); // the latest run counts
  thread("queued"); run("queued", "queued", 1);
  thread("failed"); run("failed", "failed", 20, 19);
  thread("done"); run("done", "completed", 20, 10); // finished after the last visit (30 min ago)
  thread("seen"); run("seen", "completed", 50, 40); // finished before it
  thread("never", { lastVisitedAt: null }); run("never", "completed", 20, 10); // never opened: not "done" (T3's rule)
  thread("stopped"); run("stopped", "interrupted", 20, 10);
  thread("resolved"); request("resolved", "command", "resolved");
  thread("woke", { snoozedUntil: at(5), snoozedAt: at(120) });
  thread("snoozed", { snoozedUntil: new Date(NOW + 3600_000).toISOString() });
  thread("snoozedasks", { snoozedUntil: new Date(NOW + 3600_000).toISOString() }); request("snoozedasks", "command"); // an approval: back in sight
  // T3 shows a snoozed thread again for its own question or a failure only if it came after the snooze.
  const later = new Date(NOW + 3600_000).toISOString();
  thread("failedthensnoozed", { snoozedUntil: later, snoozedAt: at(5) }); run("failedthensnoozed", "failed", 20, 10);
  thread("snoozedthenfailed", { snoozedUntil: later, snoozedAt: at(20) }); run("snoozedthenfailed", "failed", 15, 10);
  thread("askedthensnoozed", { snoozedUntil: later, snoozedAt: at(2) }); request("askedthensnoozed", "user_input"); // asked 5 min ago
  thread("snoozedthenasked", { snoozedUntil: later, snoozedAt: at(9) }); request("snoozedthenasked", "user_input");
  // A guest's message waiting (thread's own guest share): a request, which wakes a snoozed thread too.
  thread("guest", { guestShare: { messages: [{ id: "m1", status: "pending" }, { id: "m0", status: "answered" }] } });
  thread("guestsnoozed", { snoozedUntil: later, snoozedAt: at(60), guestShare: { messages: [{ id: "m1", status: "pending" }] } });
  thread("settled", { settledOverride: "settled", settledAt: at(5) });
  thread("autosettled", { settledAt: at(5) }); // settled by T3 itself
  thread("reopened", { settledAt: at(50), settledOverride: "active" }); // made active again
  // A fork carries its source's root id; its running subagent's approval is the fork's, not the source's.
  thread("src");
  thread("fork2", { lineage: { relationshipToParent: "fork", parentThreadId: "src", rootThreadId: "src" } });
  thread("forksub", { lineage: { relationshipToParent: "subagent", parentThreadId: "fork2", rootThreadId: "src" } }); run("forksub", "running", 2); request("forksub", "command");
  thread("forksubq", { lineage: { relationshipToParent: "subagent", parentThreadId: "src", rootThreadId: "src" } }); run("forksubq", "running", 2); request("forksubq", "user_input"); // a subagent's question: not passed up
  thread("archived", {}, { archived: at(1) });
  thread("scratch", {}, { project: "p2", title: "Rename  user_id to account_id in *all* tables" });

  // A usage limit (T3's "Limited"): the run that failed on it, failed 19 minutes ago, whether or
  // not you have looked since.
  const limit = (id, payload = {}) => { thread(id, payload); const r = run(id, "failed", 20, 19); failure(id, r, "usage_limit"); return r; };
  limit("limited");
  limit("limitedseen", { lastVisitedAt: at(5) });
  // Messages queued, or cancelled before they started, after it: the limited run is still the latest.
  limit("limitedqueued"); run("limitedqueued", "queued", 3);
  limit("limitedcancelled"); run("limitedcancelled", "cancelled", 3, 2);
  limit("limitedrunning"); run("limitedrunning", "running", 3); // a run under way again
  // The provider's session: the same error is the limit; another one since makes it a failure like
  // any (seen since: no word; with a queued message after it, that run is the latest).
  limit("limitedsession"); session("limitedsession", "You've hit your limit");
  limit("limitedother"); session("limitedother", "Provider runtime failed.");
  limit("limitedotherseen", { lastVisitedAt: at(5) }); session("limitedotherseen", "Provider runtime failed.");
  limit("limitedotherqueued"); session("limitedotherqueued", "Provider runtime failed."); run("limitedotherqueued", "queued", 3);
  // Only a subagent's node hit it: the run failed, not on a limit.
  thread("limitedsub"); failure("limitedsub", run("limitedsub", "failed", 20, 19), "usage_limit", { node: "subagent:node" });
  // Each attempt of a provider turn is an item: the newest failed one counts, not a later retry that went through.
  thread("limitretried"); const retried = run("limitretried", "failed", 20, 19);
  failure("limitretried", retried, "usage_limit", { minutesAgo: 19.5 }); failure("limitretried", retried, "transport_error", { status: "completed", message: "Provider recovered", minutesAgo: 19.2 });
  thread("limitthenerror"); const errored = run("limitthenerror", "failed", 20, 19);
  failure("limitthenerror", errored, "usage_limit", { minutesAgo: 19.5 }); failure("limitthenerror", errored, "provider_error", { message: "Provider error", minutesAgo: 19.2 });
  limit("limitedrefresh"); request("limitedrefresh", "auth_refresh"); // a sign-in to renew: no word of its own
  // Snoozed till the limit resets, after it hit: out of sight. Snoozed before it hit: back, even with a message queued.
  limit("limitsnoozed", { snoozedUntil: later, snoozedAt: at(10) });
  limit("limitwoke", { snoozedUntil: later, snoozedAt: at(25) }); run("limitwoke", "queued", 3);

  // Waiting (T3's "Waiting"): a running run with nothing in flight but a wait on another thread
  // (T3's t3_thread_wait, or delegate_task waiting, here by the name Codex gives it), not with a
  // command too.
  const wait = { toolName: "mcp__t3-code__t3_thread_wait", input: { threadId: "src" } };
  thread("threadwait"); item("threadwait", run("threadwait", "running", 5), "dynamic_tool", "running", wait);
  thread("delegatewait"); item("delegatewait", run("delegatewait", "running", 5), "dynamic_tool", "running", { toolName: "t3-code-direct.delegate_task", input: { mode: "wait" } });
  thread("waitandwork"); const busy = run("waitandwork", "running", 5);
  item("waitandwork", busy, "dynamic_tool", "running", wait); item("waitandwork", busy, "command_execution", "running", { input: "npm test" });
  // Or, once the run has ended, work T3 waits on: a subagent still running, a task the provider
  // reports (a plain command does not hold), a pull request's checks it watches (not once done).
  thread("subagentopen"); item("subagentopen", run("subagentopen", "completed", 50, 40), "subagent", "running", { origin: "provider_native" });
  thread("providertask"); run("providertask", "completed", 50, 40); providerThread("providertask", [{ taskId: "t1", kind: "subagent" }]);
  thread("providercommand"); run("providercommand", "completed", 50, 40); providerThread("providercommand", [{ taskId: "t2", kind: "command" }]);
  const pr = (number, watch = {}) => ({ host: "github.com", repository: "Acme/api", number, url: `https://github.com/Acme/api/pull/${number}`, source: "agent", snapshot: null, watch: { startedAt: at(45), ...watch } });
  thread("prwatch", { pullRequests: [pr(12)] }); run("prwatch", "completed", 50, 40);
  thread("prwatchdone", { pullRequests: [pr(13, { checksPending: false })] }); run("prwatchdone", "completed", 50, 40);
  // A task the provider reports with an open item's id stands for it: here a command, which does not hold.
  thread("dedup"); const deduped = run("dedup", "completed", 50, 40);
  item("dedup", deduped, "subagent", "running", { origin: "provider_native", nativeItemRef: { nativeId: "task-9" } }); providerThread("dedup", [{ taskId: "task-9", kind: "command" }]);
  // Not after a failure: T3 shows that.
  thread("failedhold"); const failedRun = run("failedhold", "failed", 20, 19);
  failure("failedhold", failedRun, "provider_error", { message: "Provider error" }); item("failedhold", failedRun, "subagent", "running", { origin: "provider_native" });

  // Two runs under way: the newer one is the thread's (here still setting up).
  thread("tworuns"); run("tworuns", "running", 8); run("tworuns", "preparing", 1);
  // A link card you wrote before: it still waits for you.
  thread("linkolder"); wrote("linkolder", 6); card("linkolder", "link_request", 4);
  // A deleted subagent's approval is no one's.
  thread("delparent"); run("delparent", "running", 10);
  thread("delsub", { lineage: { relationshipToParent: "subagent", parentThreadId: "delparent" } }, { deleted: at(1) }); run("delsub", "running", 3); request("delsub", "command");

  // "Goal" (T3's label for Working): the thread's active provider thread pursues an active goal,
  // running or queued. Not a paused goal, not another provider thread's (nor one when the thread
  // names none), not while setting up or once the run is over.
  const goal = (id, status, goalStatus, { active = `${id}-pt`, other = false } = {}) => {
    thread(id, { activeProviderThreadId: other ? null : active });
    if (status) run(id, status, 5, status === "completed" ? 2 : null);
    providerThread(id, [], { id: active, goal: goalStatus });
  };
  goal("goalrunning", "running", "active");
  goal("goalqueued", "queued", "active");
  goal("goalpaused", "running", "paused");
  goal("goalprep", "preparing", "active");
  goal("goalover", "completed", "active");
  goal("goalnone", "running", "active", { other: true });
  goal("goalelsewhere", "running", null); providerThread("goalelsewhere", [], { goal: "active" });
}

function publish(home) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(WORKER, { workerData: { t3Home: join(home, "t3"), home, t3Cli: "t3-not-installed", timeZone: "UTC" } });
    // A worker that exits or hangs without answering fails the test, instead of leaving it
    // (and npm test, and build.sh) waiting forever.
    const timer = setTimeout(() => {
      worker.terminate();
      reject(new Error("the worker gave no answer in 30 s"));
    }, 30_000);
    worker.on("message", (m) => {
      if (m.log) return;
      clearTimeout(timer);
      worker.terminate();
      m.error ? reject(new Error(m.error)) : resolve(m.result);
    });
    worker.on("error", reject);
    worker.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`the worker exited (${code}) without answering`));
    });
    worker.postMessage({ id: 1, op: "threads", args: {} });
  });
}
const statuses = (home) => {
  const feed = parseThreadsFeedText(readFileSync(join(home, "feeds", "t3plus-threads.json"), "utf8"));
  assert.ok(feed, "a feed the page reads");
  return [feed, Object.fromEntries(feed.threads.map((t) => [t.key.slice("env-test:".length), t.status]))];
};

test("each thread's status by T3's sidebar rules, from T3's database", async () => {
  const home = makeT3Home(sidebarRules);
  try {
    assert.equal(await publish(home), true);
    const [feed, status] = statuses(home);
    assert.deepEqual(status, {
      approval: "approval",
      input: "input",
      both: "approval",
      parent: "approval",
      idleparent: "working",
      toolparent: "working",
      chatparent: "input",
      refresh: "idle",
      refreshsnoozed: "idle",
      approvalrefresh: "idle",
      secretparent: "input",
      linkopen: "input",
      linkdone: "idle",
      linkagent: "input",
      compacting: "idle",
      held: "idle",
      queuedparent: "working",
      failedseen: "idle",
      refreshwoke: "woke",
      fork: "preparing",
      working: "working",
      queued: "working",
      failed: "failed",
      done: "done",
      seen: "idle",
      never: "idle",
      stopped: "idle",
      resolved: "idle",
      woke: "woke",
      snoozedasks: "approval",
      snoozedthenfailed: "failed",
      snoozedthenasked: "input",
      guest: "request",
      guestsnoozed: "request",
      scratch: "idle",
      reopened: "idle",
      src: "idle",
      fork2: "approval",
      limited: "limited",
      limitedseen: "limited",
      limitedqueued: "limited",
      limitedcancelled: "limited",
      limitedrunning: "working",
      limitedsession: "limited",
      limitedother: "failed",
      limitedotherseen: "idle",
      limitedotherqueued: "working",
      limitedsub: "failed",
      limitretried: "limited",
      limitthenerror: "failed",
      limitedrefresh: "limited",
      limitwoke: "limited",
      threadwait: "waiting",
      delegatewait: "waiting",
      waitandwork: "working",
      subagentopen: "waiting",
      providertask: "waiting",
      providercommand: "idle",
      prwatch: "waiting",
      prwatchdone: "idle",
      dedup: "idle",
      failedhold: "failed",
      tworuns: "preparing",
      linkolder: "input",
      delparent: "working",
      goalrunning: "goal",
      goalqueued: "goal",
      goalpaused: "working",
      goalprep: "preparing",
      goalover: "done",
      goalnone: "working",
      goalelsewhere: "working",
    }, "subagents and side chats are their thread's; snoozed, settled and archived ones are left out");
    const written = JSON.parse(readFileSync(join(home, "feeds", "t3plus-threads.json"), "utf8")).threads;
    assert.deepEqual(written.filter((t) => "goal" in t).map((t) => [t.id, t.status, t.goal]).sort(), [["goalqueued", "working", true], ["goalrunning", "working", true]], "written as T3's word, working, with its label's flag");
    assert.equal(feed.threads.find((t) => t.key.endsWith(":scratch")).title, "Rename user_id to account_id in *all* tables", "the title as T3 shows it (spaces folded only)");
    assert.deepEqual(feed.projects.get("p1").keys, ["github.com/Acme/api", `env-test:${join(home, "repo")}`], "its repository as T3's folder key, then its folder");
    assert.equal(feed.projects.get("p2").keys.at(-1), "\u0000no-project", "T3's scratch folder: No project");
    assert.equal(await publish(home), false, "nothing changed: the file is not written again");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("an older T3 database, before its provider tables: the statuses without limits or background work", async () => {
  const home = makeT3Home(({ thread, run, request }) => {
    thread("approval"); run("approval", "running", 10); request("approval", "command");
    thread("working"); run("working", "running", 2);
    thread("queued"); run("queued", "queued", 1);
    thread("failed"); run("failed", "failed", 20, 19);
    thread("done"); run("done", "completed", 20, 10);
  }, { older: true });
  try {
    assert.equal(await publish(home), true);
    assert.deepEqual(statuses(home)[1], { approval: "approval", working: "working", queued: "working", failed: "failed", done: "done" });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
