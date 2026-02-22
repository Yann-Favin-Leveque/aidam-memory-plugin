#!/bin/bash
# AIDAM Memory - SessionEnd Hook
# On /clear: marks orchestrator as 'clearing' (orchestrator stays alive for session_reset)
# On normal end: signals orchestrator to shut down gracefully.

# Load .env from plugin root (provides PGPASSWORD and other config)
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ENV_FILE="${SCRIPT_DIR}/../.env"
if [ -f "$ENV_FILE" ]; then
  set -a
  source "$ENV_FILE"
  set +a
fi

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
export PGPASSWORD="${PGPASSWORD:-}"
PSQL="C:/Program Files/PostgreSQL/17/bin/psql.exe"

if [ "$REASON" = "clear" ]; then
  # ── /clear path: mark as 'clearing', keep orchestrator alive ──
  # The orchestrator will receive a session_reset message from SessionStart
  # and swap to the new session_id.
  ROWS_UPDATED=$("$PSQL" -U postgres -h localhost -d claude_memory -t -A -c \
    "UPDATE orchestrator_state SET status='clearing' WHERE session_id='${SESSION_ID}' AND status IN ('running','stopping','starting') RETURNING 1;" \
    2>/dev/null | wc -l | tr -d ' ' || echo "0")

  # Fallback: if no row was updated (orchestrator never registered), insert one
  if [ "$ROWS_UPDATED" = "0" ]; then
    "$PSQL" -U postgres -h localhost -d claude_memory -t -A -c \
      "INSERT INTO orchestrator_state (session_id, status, started_at) VALUES ('${SESSION_ID}', 'clearing', CURRENT_TIMESTAMP) ON CONFLICT (session_id) DO UPDATE SET status='clearing';" \
      2>/dev/null || true
  fi

  # Emergency compact if no session_state exists yet
  HAS_STATE=$("$PSQL" -U postgres -h localhost -d claude_memory -t -A -c \
    "SELECT COUNT(*) FROM session_state WHERE session_id='${SESSION_ID}';" \
    2>/dev/null || echo "0")

  if [ "$HAS_STATE" = "0" ] && [ -n "$TRANSCRIPT_PATH" ] && [ -f "$TRANSCRIPT_PATH" ]; then
    "$PYTHON" "$(dirname "$0")/emergency_compact.py" "$SESSION_ID" "$TRANSCRIPT_PATH" 2>/dev/null || true
  fi

  # Do NOT kill the orchestrator — it will be reused via session_reset
  exit 0
fi

# ── Normal session end (not /clear): shut down orchestrator ──
"$PSQL" -U postgres -h localhost -d claude_memory -t -A -c \
  "UPDATE orchestrator_state SET status='stopping' WHERE session_id='${SESSION_ID}' AND status='running';" \
  2>/dev/null || true

# Send shutdown event via cognitive_inbox
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
