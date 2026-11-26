// What t3+'s launcher needs from the system, for macOS and Windows: finding T3 Code's main
// process, asking it to open its inspector, and telling the user something went wrong.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

export const WINDOWS = process.platform === "win32";

// ---------- Windows ----------
// By its full path: a "powershell.exe" earlier on the PATH is not run.
const POWERSHELL = join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
/** Runs a PowerShell script with nothing of the user's profile in it, and no window. */
export function powershell(script, { env = {}, timeout = 15_000 } = {}) {
  return execFileSync(POWERSHELL, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script], { encoding: "utf8", timeout, windowsHide: true, env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "ignore"] });
}
// This session's T3 Code processes only (another signed-in user's T3 is not ours), a line each:
// pid|parent|1 for one of Chromium's own (--type=...)|start time|program.
const LIST_T3 = `$s = (Get-Process -Id $PID).SessionId
Get-CimInstance Win32_Process -Filter "Name LIKE 'T3 Code%' AND SessionId = $s" | ForEach-Object {
  $c = [int]($_.CommandLine -match '\\s--type='); $t = if ($_.CreationDate) { $_.CreationDate.Ticks } else { 0 }
  "$($_.ProcessId)|$($_.ParentProcessId)|$c|$t|$($_.ExecutablePath)" }`;
/** T3 Code's processes, from such lines: { pid, ppid, chromium, started }. */
export function parseWindowsProcesses(text) {
  return String(text).split(/\r?\n/).map((l) => l.trim().match(/^(\d+)\|(\d+)\|([01])\|(\d+)\|(.*)$/)).filter((m) => m && /\\T3 Code[^\\]*\.exe$/i.test(m[5]))
    .map((m) => ({ pid: Number(m[1]), ppid: Number(m[2]), chromium: m[3] === "1", started: m[4] }));
}
/** The main processes among them: those with Chromium's (its GPU, its windows) as children.
 *  T3's server, its `t3` command and whatever else runs on T3's binary as Node have none. */
export function windowsMainProcesses(processes) {
  const parents = new Set(processes.filter((p) => p.chromium).map((p) => p.ppid));
  return processes.filter((p) => !p.chromium && parents.has(p.pid));
}
function windowsProcesses() {
  // T3PLUS_PROCESS_LIST: the tests' stand-in for the list, as a fake `ps` is elsewhere.
  const standIn = process.env.T3PLUS_PROCESS_LIST;
  return parseWindowsProcesses(standIn ? readFileSync(standIn, "utf8") : powershell(LIST_T3));
}

// ---------- macOS ----------
const ps = (...args) => { try { return execFileSync("ps", args, { encoding: "utf8" }); } catch { return ""; } };
function macMainPids() {
  // This user's processes only: with fast user switching another user's T3 is not ours.
  // T3's main process is launched by launchd (ppid 1) and is the app's own binary.
  return execFileSync("ps", ["-U", String(process.getuid()), "-o", "pid=,ppid=,comm="], { encoding: "utf8" }).split("\n")
    .map((l) => l.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/))
    .filter((m) => m && m[2] === "1" && /\/T3 Code[^/]*\.app\/Contents\/MacOS\/T3 Code[^/]*$/.test(m[3])).map((m) => Number(m[1]));
}

// ---------- Both ----------
/** This user's T3 Code main processes (one, unless several T3 apps run). Not this script nor
 *  the one that ran it: both may run on the app's own binary (ELECTRON_RUN_AS_NODE). */
export function mainPids() {
  const self = new Set([process.pid, process.ppid]);
  const pids = WINDOWS ? windowsMainProcesses(windowsProcesses()).map((p) => p.pid) : macMainPids();
  return pids.filter((pid) => !self.has(pid));
}
/** A process's parent, or null. */
export function parentPid(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  if (!WINDOWS) return Number(ps("-o", "ppid=", "-p", String(pid)).trim()) || null;
  try { return Number(powershell(`(Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}").ParentProcessId`).trim()) || null; } catch { return null; }
}
/** One launch of the app: its pid and when it started (a pid alone is used again in time). */
export function identity(pid) {
  if (!WINDOWS) return `${pid}@${ps("-o", "lstart=", "-p", String(pid)).trim()}`;
  let started = "";
  try { started = windowsProcesses().find((p) => p.pid === pid)?.started ?? ""; } catch {}
  return `${pid}@${started}`;
}
/** Asks a process to open its inspector: SIGUSR1, or Node's own stand-in for it on Windows (as
 *  `node inspect -p` does there), which throws when the process does not take such requests. */
export function openInspector(pid) {
  if (!WINDOWS) return void process.kill(pid, "SIGUSR1");
  try { process._debugProcess(pid); } catch (error) { throw new Error(`the app's inspector did not open (${String(error.message).trim()})`); }
}
// Under PowerShell's own app id: a toast needs one that is registered.
const TOAST = `$null = [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime]
$x = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)
$t = $x.GetElementsByTagName('text'); $null = $t.Item(0).AppendChild($x.CreateTextNode('t3+')); $null = $t.Item(1).AppendChild($x.CreateTextNode($env:T3PLUS_MESSAGE))
$id = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe'
[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($id).Show([Windows.UI.Notifications.ToastNotification]::new($x))`;
/** A system notification, so a launch where t3+ could not load does not just look like plain T3. */
export function notify(message) {
  try {
    if (WINDOWS) powershell(TOAST, { env: { T3PLUS_MESSAGE: String(message) } }); // in the environment, never part of the script
    else {
      const quote = (s) => JSON.stringify(String(s)); // AppleScript strings use the same \" and \\ escapes
      execFileSync("osascript", ["-e", `display notification ${quote(message)} with title "t3+"`], { timeout: 10_000 });
    }
  } catch {}
}
