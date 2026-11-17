/** fetchRemote for the extension: asks the background worker, which holds the host permission.
 *  (In the desktop app the loader's stand-in answers the same message.) */
export function createRuntimeFetcher(runtime) {
  return (url) =>
    new Promise((resolve) => {
      try {
        runtime.sendMessage({ type: "t3plus/fetch-config", url }, (response) => {
          const lastError = runtime.lastError;
          resolve(lastError ? { ok: false, status: 0, error: lastError.message } : response);
        });
      } catch (error) {
        resolve({ ok: false, status: 0, error: error instanceof Error ? error.message : String(error) });
      }
    });
}
