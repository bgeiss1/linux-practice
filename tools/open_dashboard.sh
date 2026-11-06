#!/usr/bin/env bash
# Opens the instructor dashboard. Starts the local server first if it isn't running, using
# VS Code's Node (or node, if installed). The "Linux Practice Dashboard" app on the Desktop
# runs this. Same shape as the GROMACS and RFD4 visualizers' tools/open_dashboard.sh.
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"   # apps start with a short PATH, and Publish needs git
site=$(cd "$(dirname "$0")/.." && pwd)
log="$HOME/Library/Logs/linux-practice.log"
mkdir -p "$(dirname "$log")" 2>/dev/null || log="/tmp/linux-practice.log"

alert() { osascript -e "display alert \"Linux Practice Dashboard\" message \"$1\"" >/dev/null 2>&1; }

# Port 8000 first. If something else already holds a port, try the next one, so an old
# server from another folder can't stand in for this one.
for port in ${PORT:-8000} 8001 8002 8003; do
  info=$(curl -s "http://localhost:$port/__local" 2>/dev/null)
  if [ -n "$info" ]; then
    case "$info" in *"\"root\":\"$site\""*) open "http://localhost:$port/admin.html"; exit 0 ;; esac
    continue
  fi
  lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1 && continue

  cd "$site"
  vscode="/Applications/Visual Studio Code.app/Contents/MacOS/Code"
  if command -v node >/dev/null; then run=(node serve.mjs)
  elif [ -x "$vscode" ]; then export ELECTRON_RUN_AS_NODE=1; run=("$vscode" serve.mjs)
  else
    alert "No Node found. Install Node, or install Visual Studio Code, which ships one."
    exit 1
  fi
  PORT=$port nohup "${run[@]}" > "$log" 2>&1 < /dev/null &
  url="http://localhost:$port/admin.html"
  for _ in $(seq 1 50); do curl -s -o /dev/null "$url" && break; sleep 0.2; done
  if ! curl -s -o /dev/null "$url"; then
    alert "The server did not start. The log is at $log"
    exit 1
  fi
  open "$url"
  exit 0
done
alert "Ports 8000 to 8003 are all in use by other programs. Close one and try again."
exit 1
