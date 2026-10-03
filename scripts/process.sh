#!/bin/bash
# Shared by the three service launchers. Callers set ROOT and SERVICE.

release_lock() {
    if [ -n "${CONTROL_LOCK:-}" ]; then
        rmdir "$CONTROL_LOCK"
        CONTROL_LOCK=''
    fi
}

acquire_lock() {
    CONTROL_LOCK="$ROOT/$SERVICE-control.lock"
    if ! mkdir "$CONTROL_LOCK" 2>/dev/null; then
        CONTROL_LOCK=''
        echo "Another $SERVICE control command is running; inspect its lock before retrying." >&2
        exit 1
    fi
    trap release_lock EXIT
}

process_running() {
    local state
    state="$(ps -p "$PID" -o stat= 2>/dev/null)" || return 1
    case "$state" in ''|*Z*) return 1;; esac
    kill -0 "$PID" 2>/dev/null
}

check_owner() {
    local command
    command="$(ps -p "$PID" -o command=)"
    case "$SERVICE:$command" in
        "web:node $ROOT/web/server.js --port 5173" | \
        "web:$(command -v node) $ROOT/web/server.js --port 5173" | \
        "server:$ROOT/runtime/bin/mac/llama-server "* | \
        "tunnel:$ROOT/bin/cloudflared tunnel "*) return 0;;
        *) echo "PID $PID belongs to another process; inspect $SERVICE.pid." >&2; exit 1;;
    esac
}

read_pid() {
    PID=''
    PID_FILE="$ROOT/$SERVICE.pid"
    if [ ! -f "$PID_FILE" ]; then return; fi
    PID="$(cat "$PID_FILE")"
    case "$PID" in ''|*[!0-9]*|0*|1) echo "Invalid $SERVICE PID file." >&2; exit 1;; esac
    if ! process_running; then
        rm -f "$PID_FILE"
        PID=''
        return
    fi
    check_owner
}

stop_service() {
    local seconds="$1"
    acquire_lock
    read_pid
    if [ -z "$PID" ]; then echo "$SERVICE is already stopped."; return; fi
    if ! kill -TERM "$PID" 2>/dev/null && process_running; then
        echo "Could not stop PID $PID; inspect it before retrying." >&2
        exit 1
    fi
    for ((i=0; i<seconds; i++)); do
        if ! process_running; then
            rm -f "$PID_FILE"
            echo "$SERVICE stopped."
            return
        fi
        sleep 1
    done
    echo "PID $PID has not exited; retaining $SERVICE.pid." >&2
    exit 1
}

start_detached() {
    local log="$1"
    shift
    PID="$(python3 - "$ROOT" "$log" "$@" <<'PYTHON'
import pathlib
import subprocess
import sys
root = pathlib.Path(sys.argv[1])
with pathlib.Path(sys.argv[2]).open('w') as log:
    process = subprocess.Popen(sys.argv[3:], cwd=root, stdin=subprocess.DEVNULL,
                               stdout=log, stderr=log, start_new_session=True)
print(process.pid)
PYTHON
)"
}

publish_pid() {
    if ! echo "$PID" > "$PID_FILE"; then
        kill -TERM "$PID" 2>/dev/null || true
        for ((i=0; i<10; i++)); do
            if ! process_running; then break; fi
            sleep 1
        done
        if ! process_running; then wait "$PID" 2>/dev/null || true; fi
        echo "Could not record PID $PID; startup was cancelled. Inspect the process if it remains alive." >&2
        return 1
    fi
}

wait_foreground() {
    local result=0
    release_lock
    trap 'kill -TERM "$PID" 2>/dev/null || true' INT TERM
    # A signal can interrupt wait before the child exits; wait again in that case.
    wait "$PID" || result=$?
    if process_running; then wait "$PID" || result=$?; fi
    trap - INT TERM
    if mkdir "$ROOT/$SERVICE-control.lock" 2>/dev/null; then
        CONTROL_LOCK="$ROOT/$SERVICE-control.lock"
        if [ -f "$PID_FILE" ] && [ "$(cat "$PID_FILE")" = "$PID" ] && ! process_running; then
            rm -f "$PID_FILE"
        fi
    fi
    return "$result"
}
