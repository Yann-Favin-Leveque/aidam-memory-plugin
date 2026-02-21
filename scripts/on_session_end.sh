#!/bin/bash
# AIDAM Memory - SessionEnd Hook
# Signals the orchestrator to shut down gracefully.

PYTHON="C:/Users/user/AppData/Local/Programs/Python/Python312/python.exe"
INPUT=$(cat)
PARSED=$("$PYTHON" -c "
import json, sys
try:
    d = json.loads(sys.stdin.read())
    print(d.get('session_id', ''))
    print(d.get('reason', ''))
    print(d.get('transcript_path', ''))
except:
    print('')
    print('')
    print('')
" <<< "$INPUT" 2>/dev/null)
SESSION_ID=$(echo "$PARSED" | sed -n '1p')
REASON=$(echo "$PARSED" | sed -n '2p')
TRANSCRIPT_PATH=$(echo "$PARSED" | sed -n '3p')

if [ -z "$SESSION_ID" ]; then
  exit 0
fi

PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT}"
if [ -z "$PLUGIN_ROOT" ]; then
  PLUGIN_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
fi
# PID file scoped by session_id (parallel-safe)
PID_FILE="${PLUGIN_ROOT}/.orchestrator_${SESSION_ID}.pid"

# Signal orchestrator to stop via DB
export PGPASSWORD="***REDACTED***"
PSQL="C:/Program Files/PostgreSQL/17/bin/psql.exe"

# If reason is "clear" -> save marker in DB so SessionStart can find the previous state
if [ "$REASON" = "clear" ]; then
  # Store the cleared session_id in orchestrator_state (parallel-safe, scoped by session_id)
  "$PSQL" -U postgres -h localhost -d claude_memory -t -A -c \
    "UPDATE orchestrator_state SET status='cleared' WHERE session_id='${SESSION_ID}' AND status IN ('running','stopping');" \
    2>/dev/null || true

  # Force a final compactor run before we lose the context
  # (Only if there's a transcript and no session_state yet)
  HAS_STATE=$("$PSQL" -U postgres -h localhost -d claude_memory -t -A -c \
    "SELECT COUNT(*) FROM session_state WHERE session_id='${SESSION_ID}';" \
    2>/dev/null || echo "0")

  if [ "$HAS_STATE" = "0" ] && [ -n "$TRANSCRIPT_PATH" ] && [ -f "$TRANSCRIPT_PATH" ]; then
    # No compactor state yet - do a quick summary via Python
    "$PYTHON" "$(dirname "$0")/emergency_compact.py" "$SESSION_ID" "$TRANSCRIPT_PATH" 2>/dev/null || true
  fi
fi

"$PSQL" -U postgres -h localhost -d claude_memory -t -A -c \
  "UPDATE orchestrator_state SET status='stopping' WHERE session_id='${SESSION_ID}' AND status='running';" \
  2>/dev/null || true

# Also send shutdown event via cognitive_inbox
"$PSQL" -U postgres -h localhost -d claude_memory -t -A -c \
  "INSERT INTO cognitive_inbox (session_id, message_type, payload, status) VALUES ('${SESSION_ID}', 'session_event', '{\"event\":\"session_end\"}', 'pending');" \
  2>/dev/null || true

# Wait briefly for graceful shutdown (max 3s) — only kill OUR orchestrator
if [ -f "$PID_FILE" ]; then
  PID=$(cat "$PID_FILE")
  for i in 1 2 3; do
    if ! kill -0 "$PID" 2>/dev/null; then
      break
    fi
    sleep 1
  done
  # Force kill if still alive
  if kill -0 "$PID" 2>/dev/null; then
    kill "$PID" 2>/dev/null || true
  fi
  rm -f "$PID_FILE"
fi
# Also clean up legacy global PID file if it points to the same PID
LEGACY_PID_FILE="${PLUGIN_ROOT}/.orchestrator.pid"
if [ -f "$LEGACY_PID_FILE" ]; then
  LEGACY_PID=$(cat "$LEGACY_PID_FILE")
  if [ "$LEGACY_PID" = "$PID" ] 2>/dev/null; then
    rm -f "$LEGACY_PID_FILE"
  fi
fi

exit 0
