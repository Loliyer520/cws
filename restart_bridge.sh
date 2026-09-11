#!/bin/bash
# cc-bridge delayed restart (safe to run detached via setsid/nohup).
# Usage: restart_bridge.sh [delay_seconds]
#   delay 0 (default) = restart immediately.
# Stops the running bridge, waits for the port to free, then starts a fresh
# detached instance logging to /my/run/cws/bridge.log.
DELAY="${1:-0}"
PORT=8642
DIR=/my/run/cws
PY="$DIR/venv/bin/python"
LOG="$DIR/bridge.log"
PAT="$PY $DIR/bridge.py"   # must match the spawned cmdline exactly (pgrep -f)

log() { echo "$(date '+%F %T') [restart_bridge] $*"; }

[ "$DELAY" -gt 0 ] && { log "waiting ${DELAY}s before restart"; sleep "$DELAY"; }

# ---- stop existing bridge (SIGTERM, escalate to SIGKILL) ----
pids=$(pgrep -f "$PAT")
if [ -n "$pids" ]; then
    log "stopping bridge pid(s): $(echo $pids | tr ' ' ',')"
    kill $pids 2>/dev/null
    for i in $(seq 1 50); do
        pgrep -f "$PAT" >/dev/null || break
        sleep 0.1
    done
    pkill -9 -f "$PAT" 2>/dev/null
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
setsid nohup "$PY" "$DIR/bridge.py" >> "$LOG" 2>&1 < /dev/null &

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
