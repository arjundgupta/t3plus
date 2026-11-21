// Whether a module is the script node was started with. process.argv[1] is the path as
// typed, which may run through a symlink (macOS's /tmp is one), while a module's URL is
// its real path: compared as typed, a build or release started through a symlinked
// folder did nothing and still exited 0.
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** True when `moduleUrl` (import.meta.url) is the file `script` (process.argv[1]) names. */
export function isMain(moduleUrl, script = process.argv[1]) {
  if (!script) return false;
  try {
    return realpathSync(script) === realpathSync(fileURLToPath(moduleUrl));
  } catch {
    return false; // a script path that no longer resolves names no file of ours
  }
}
