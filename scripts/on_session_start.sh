#!/bin/bash
# AIDAM Memory - SessionStart Hook
# Launches the orchestrator process if enabled and not already running.
# Reads hook JSON from stdin. Outputs JSON additionalContext to stdout.

set -e

PYTHON="C:/Users/user/AppData/Local/Programs/Python/Python312/python.exe"
INPUT=$(cat)
PARSED=$("$PYTHON" -c "
import json, sys
try:
    d = json.loads(sys.stdin.read())
    print(d.get('session_id', ''))
    print(d.get('cwd', ''))
    print(d.get('transcript_path', ''))
    print(d.get('source', ''))
except:
    print('')
    print('')
    print('')
    print('')
" <<< "$INPUT" 2>/dev/null)
SESSION_ID=$(echo "$PARSED" | sed -n '1p')
CWD=$(echo "$PARSED" | sed -n '2p')
TRANSCRIPT_PATH=$(echo "$PARSED" | sed -n '3p')
SOURCE=$(echo "$PARSED" | sed -n '4p')

if [ -z "$SESSION_ID" ]; then
  exit 0
fi

# Check env vars for enable/disable
RETRIEVER_ENABLED="${AIDAM_MEMORY_RETRIEVER:-on}"
LEARNER_ENABLED="${AIDAM_MEMORY_LEARNER:-on}"
COMPACTOR_ENABLED="${AIDAM_MEMORY_COMPACTOR:-on}"

# If all are off, do nothing
if [ "$RETRIEVER_ENABLED" = "off" ] && [ "$LEARNER_ENABLED" = "off" ] && [ "$COMPACTOR_ENABLED" = "off" ]; then
  echo '{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"[AIDAM Memory: disabled]"}}'
  exit 0
fi

PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT}"
if [ -z "$PLUGIN_ROOT" ]; then
  # Fallback to script directory parent
  PLUGIN_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
fi

ORCHESTRATOR_SCRIPT="${PLUGIN_ROOT}/scripts/orchestrator.js"
PID_FILE="${PLUGIN_ROOT}/.orchestrator.pid"
LOG_DIR="$HOME/.claude/logs"
LOG_FILE="${LOG_DIR}/aidam_orchestrator_$(date +%Y%m%d_%H%M%S).log"

mkdir -p "$LOG_DIR"

# Check if orchestrator is already running for any session
if [ -f "$PID_FILE" ]; then
  OLD_PID=$(cat "$PID_FILE")
  if kill -0 "$OLD_PID" 2>/dev/null; then
    echo '{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"[AIDAM Memory: active (existing orchestrator)]"}}'
    exit 0
  fi
  rm -f "$PID_FILE"
fi

# Detect zombie orchestrators in DB
export PGPASSWORD="***REDACTED***"
PSQL="C:/Program Files/PostgreSQL/17/bin/psql.exe"
"$PSQL" -U postgres -h localhost -d claude_memory -t -A -c \
  "UPDATE orchestrator_state SET status='crashed', stopped_at=CURRENT_TIMESTAMP WHERE status IN ('starting','running') AND last_heartbeat_at < CURRENT_TIMESTAMP - INTERVAL '120 seconds';" \
  2>/dev/null || true

# Derive project slug from cwd (same format as Claude Code uses for project dirs)
PROJECT_SLUG=$("$PYTHON" -c "
import sys
cwd = '${CWD:-$(pwd)}'.replace('\\\\', '/').replace(':', '-').replace('/', '-').strip('-')
print(cwd)
" 2>/dev/null)

# Launch orchestrator in background
node "$ORCHESTRATOR_SCRIPT" \
  "--session-id=${SESSION_ID}" \
  "--cwd=${CWD:-$(pwd)}" \
  "--retriever=${RETRIEVER_ENABLED}" \
  "--learner=${LEARNER_ENABLED}" \
  "--compactor=${COMPACTOR_ENABLED}" \
  "--transcript-path=${TRANSCRIPT_PATH}" \
  "--project-slug=${PROJECT_SLUG}" \
  > "$LOG_FILE" 2>&1 &

ORCH_PID=$!
echo "$ORCH_PID" > "$PID_FILE"

# Wait briefly for orchestrator to initialize (up to 3 seconds)
STATUS=""
for i in 1 2 3; do
  sleep 1
  STATUS=$("$PSQL" -U postgres -h localhost -d claude_memory -t -A -c \
    "SELECT status FROM orchestrator_state WHERE session_id='${SESSION_ID}' ORDER BY id DESC LIMIT 1;" \
    2>/dev/null | tr -d ' ' || echo "")
  if [ "$STATUS" = "running" ]; then
    break
  fi
done

CONTEXT="[AIDAM Memory: active"
if [ "$RETRIEVER_ENABLED" = "on" ]; then CONTEXT="${CONTEXT}, retriever=on"; fi
if [ "$LEARNER_ENABLED" = "on" ]; then CONTEXT="${CONTEXT}, learner=on"; fi
if [ "$COMPACTOR_ENABLED" = "on" ]; then CONTEXT="${CONTEXT}, compactor=on"; fi
if [ "$STATUS" != "running" ]; then CONTEXT="${CONTEXT}, initializing..."; fi
CONTEXT="${CONTEXT}]"

# If source is "clear" or "compact", inject previous session state
if [ "$SOURCE" = "clear" ] || [ "$SOURCE" = "compact" ]; then
  INJECT=$("$PYTHON" "$(dirname "$0")/inject_state.py" "$SOURCE" 2>/dev/null || echo "")
  if [ -n "$INJECT" ]; then
    # inject_state.py outputs the full JSON
    echo "$INJECT"
    exit 0
  fi
fi

cat <<EOF
{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"${CONTEXT}"}}
EOF

exit 0
