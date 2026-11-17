// t3+ data feeds inside T3 Code's main process. Two feeds, written to ~/.t3plus/feeds:
//   t3plus-bots.json  latest message, subagents and spend of each bot thread
//   t3plus-home.json  pools, recorded pool history, activity, usage and automations
//
// All the work (T3's database, session logs, T3's API, shaping, writing) runs in
// one worker thread (inject/feeds-worker.js): T3's main thread only sends a
// request and gets back whether the feed changed.
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { Worker } = require("worker_threads");

/** @param {{ home: string, log: (...a: unknown[]) => void }} o */
module.exports = function createFeeds({ home, log }) {
  let config = {};
  for (const file of ["config.json", "server/config.local.json"]) {
    try { config = { ...JSON.parse(fs.readFileSync(path.join(home, file), "utf8")), ...config }; } catch {}
  }
  const t3Home = config.t3Home || path.join(os.homedir(), ".t3");
  const t3Cli = [config.t3Cli, "/opt/homebrew/bin/t3", "/usr/local/bin/t3", path.join(os.homedir(), ".local/bin/t3")].find((p) => p && fs.existsSync(p)) || "t3";
  const timeZone = config.timeZone || Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  const source = path.join(__dirname, "feeds-worker.js");

  let worker = null;
  let seq = 0;
  const waiting = new Map();
  function failAll(error) {
    for (const w of waiting.values()) w.reject(error);
    waiting.clear();
  }
  function call(op, args) {
    if (!worker) {
      const w = new Worker(source, { workerData: { t3Home, home, t3Cli, timeZone } });
      worker = w;
      w.unref(); // never keeps the app alive
      w.on("message", (m) => {
        if (m && m.log) { log(...m.log); return; }
        const p = waiting.get(m.id);
        waiting.delete(m.id);
        if (p) m.error ? p.reject(new Error(m.error)) : p.resolve(m.result);
      });
      w.on("error", (e) => log("feeds worker failed:", e && e.message));
      // However it ends (error, crash, dispose), nothing is left waiting on it, so a
      // publish can never stay "running" forever; the next call starts a new one.
      w.on("exit", () => {
        if (worker === w) worker = null;
        failAll(new Error("feeds worker stopped"));
      });
    }
    return new Promise((resolve, reject) => {
      const id = (seq += 1);
      waiting.set(id, { resolve, reject });
      worker.postMessage({ id, op, args });
    });
  }

  return {
    publishBots: (ids) => call("bots", { ids }),
    publishHome: () => call("home", {}),
    config: { t3Home, t3Cli, timeZone },
    dispose() {
      const w = worker;
      worker = null;
      if (w) w.terminate().catch(() => {});
    },
  };
};
