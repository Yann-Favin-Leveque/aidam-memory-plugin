#!/bin/bash
# AIDAM Memory - SessionEnd Hook
# Signals the orchestrator to shut down gracefully.

PYTHON="C:/Users/user/AppData/Local/Programs/Python/Python312/python.exe"
INPUT=$(cat)
SESSION_ID=$("$PYTHON" -c "import json,sys; print(json.loads(sys.stdin.read()).get('session_id',''))" <<< "$INPUT" 2>/dev/null)

if [ -z "$SESSION_ID" ]; then
  exit 0
fi

PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT}"
if [ -z "$PLUGIN_ROOT" ]; then
  PLUGIN_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
fi
PID_FILE="${PLUGIN_ROOT}/.orchestrator.pid"

# Signal orchestrator to stop via DB
export PGPASSWORD="***REDACTED***"
PSQL="C:/Program Files/PostgreSQL/17/bin/psql.exe"

"$PSQL" -U postgres -h localhost -d claude_memory -t -A -c \
  "UPDATE orchestrator_state SET status='stopping' WHERE session_id='${SESSION_ID}' AND status='running';" \
  2>/dev/null || true

# Also send shutdown event via cognitive_inbox
"$PSQL" -U postgres -h localhost -d claude_memory -t -A -c \
  "INSERT INTO cognitive_inbox (session_id, message_type, payload, status) VALUES ('${SESSION_ID}', 'session_event', '{\"event\":\"session_end\"}', 'pending');" \
  2>/dev/null || true

# Wait briefly for graceful shutdown (max 3s)
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

exit 0
