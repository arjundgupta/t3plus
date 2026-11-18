#!/bin/sh
# Runs autostart.mjs with a Node new enough for it (22+, built-in WebSocket and fetch):
# an installed Node if there is one, else T3 Code's own runtime (its app can run as Node).
for n in "$HOME/.local/share/fnm/aliases/default/bin/node" /opt/homebrew/bin/node /usr/local/bin/node "$(/bin/zsh -lc 'command -v node' 2>/dev/null)"; do
  if [ -x "$n" ] && [ "$("$n" -e 'console.log(typeof WebSocket)' 2>/dev/null)" = "function" ]; then
    exec "$n" "$HOME/.t3plus/autostart.mjs" "$@"
  fi
done
for app in "/Applications/T3 Code (Nightly).app" "/Applications/T3 Code (Beta).app" "/Applications/T3 Code.app" "$HOME/Applications/T3 Code (Nightly).app" "$HOME/Applications/T3 Code (Beta).app" "$HOME/Applications/T3 Code.app"; do
  bin="$app/Contents/MacOS/$(basename "$app" .app)"
  if [ -x "$bin" ] && [ "$(ELECTRON_RUN_AS_NODE=1 "$bin" -e 'console.log(typeof WebSocket)' 2>/dev/null)" = "function" ]; then
    ELECTRON_RUN_AS_NODE=1 exec "$bin" "$HOME/.t3plus/autostart.mjs" "$@"
  fi
done
mkdir -p "$HOME/.t3plus/state"
echo "$(date -u +%FT%TZ) no Node 22+ found for t3+ autostart (neither installed nor T3's own)" >> "$HOME/.t3plus/state/autostart.log"
osascript -e 'display notification "t3+ did not load: no Node 22+ was found." with title "t3+"' 2>/dev/null
exit 1
