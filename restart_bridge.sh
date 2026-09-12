#!/bin/bash
# cws (Node) delayed restart — safe to run detached via setsid/nohup.
# Usage: restart_bridge.sh [delay_seconds]   (0 = immediate)
# Stops the running bridge, waits for the port, starts a fresh detached
# instance logging to /my/run/cws/bridge.log.
DELAY="${1:-0}"
PORT=8642
DIR=/my/run/cws
NODE="$(command -v node)"
LOG="$DIR/bridge.log"
PAT='node src/server[.]js'   # [.] prevents self-match of this script's own cmdline

log() { echo "$(date '+%F %T') [restart_bridge] $*"; }

[ "$DELAY" -gt 0 ] && { log "waiting ${DELAY}s before restart"; sleep "$DELAY"; }

# ---- stop existing bridge (list PIDs first, exclude self) ----
pids=$(pgrep -f "$PAT" | grep -v "^$$$")
if [ -n "$pids" ]; then
    log "stopping bridge pid(s): $(echo $pids | tr '\n' ' ')"
    for pid in $pids; do kill "$pid" 2>/dev/null; done
    for i in $(seq 1 50); do
        pgrep -f "$PAT" | grep -v "^$$$" | grep -q . || break
        sleep 0.1
    done
    for pid in $(pgrep -f "$PAT" | grep -v "^$$$"); do kill -9 "$pid" 2>/dev/null; done
else
    log "no running bridge found"
fi

# ---- wait for the port to be released ----
for i in $(seq 1 50); do
    ss -tln 2>/dev/null | grep -q ":$PORT " || break
    sleep 0.2
done

# ---- start detached ----
cd "$DIR" || exit 1
setsid nohup "$NODE" "$DIR/src/server.js" >> "$LOG" 2>&1 < /dev/null &

# ---- verify listener ----
for i in $(seq 1 50); do
    if ss -tln 2>/dev/null | grep -q ":$PORT "; then
        newpid=$(pgrep -f "$PAT" | head -1)
        log "bridge restarted OK, pid=$newpid, log=$LOG"
        exit 0
    fi
    sleep 0.2
done
log "ERROR: bridge failed to listen on $PORT — check $LOG"
exit 1
