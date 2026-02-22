#!/bin/bash
# AIDAM Memory - PreCompact Hook
# Marks orchestrator as 'clearing' before compact, so SessionStart can do session_reset.
# Without this, /compact would leave the old orchestrator orphaned.

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
SESSION_ID=$("$PYTHON" -c "
import json, sys
try:
    d = json.loads(sys.stdin.read())
    print(d.get('session_id', ''))
except:
    print('')
" <<< "$INPUT" 2>/dev/null)

if [ -z "$SESSION_ID" ]; then
  exit 0
fi

export PGPASSWORD="${PGPASSWORD:-}"
PSQL="C:/Program Files/PostgreSQL/17/bin/psql.exe"

# Mark orchestrator as 'clearing' — same as SessionEnd with reason=clear
ROWS_UPDATED=$("$PSQL" -U postgres -h localhost -d claude_memory -t -A -c \
  "UPDATE orchestrator_state SET status='clearing' WHERE session_id='${SESSION_ID}' AND status IN ('running','stopping','starting') RETURNING 1;" \
  2>/dev/null | wc -l | tr -d ' ' || echo "0")

# Fallback: if no row was updated, insert one
if [ "$ROWS_UPDATED" = "0" ]; then
  "$PSQL" -U postgres -h localhost -d claude_memory -t -A -c \
    "INSERT INTO orchestrator_state (session_id, status, started_at) VALUES ('${SESSION_ID}', 'clearing', CURRENT_TIMESTAMP) ON CONFLICT (session_id) DO UPDATE SET status='clearing';" \
    2>/dev/null || true
fi

# Emergency compact if no session_state exists yet
PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT}"
if [ -z "$PLUGIN_ROOT" ]; then
  PLUGIN_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
fi

TRANSCRIPT_PATH=$("$PYTHON" -c "
import json, sys
try:
    d = json.loads(sys.stdin.read())
    print(d.get('transcript_path', ''))
except:
    print('')
" <<< "$INPUT" 2>/dev/null)

HAS_STATE=$("$PSQL" -U postgres -h localhost -d claude_memory -t -A -c \
  "SELECT COUNT(*) FROM session_state WHERE session_id='${SESSION_ID}';" \
  2>/dev/null || echo "0")

if [ "$HAS_STATE" = "0" ] && [ -n "$TRANSCRIPT_PATH" ] && [ -f "$TRANSCRIPT_PATH" ]; then
  "$PYTHON" "$(dirname "$0")/emergency_compact.py" "$SESSION_ID" "$TRANSCRIPT_PATH" 2>/dev/null || true
fi

exit 0
