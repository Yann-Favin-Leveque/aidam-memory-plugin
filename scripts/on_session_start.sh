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
CURATOR_ENABLED="${AIDAM_MEMORY_CURATOR:-off}"

# Budget env vars
RETRIEVER_A_BUDGET="${AIDAM_RETRIEVER_A_BUDGET:-0.50}"
RETRIEVER_B_BUDGET="${AIDAM_RETRIEVER_B_BUDGET:-0.50}"
LEARNER_BUDGET="${AIDAM_LEARNER_BUDGET:-0.50}"
COMPACTOR_BUDGET="${AIDAM_COMPACTOR_BUDGET:-0.30}"
CURATOR_BUDGET="${AIDAM_CURATOR_BUDGET:-0.30}"
SESSION_BUDGET="${AIDAM_SESSION_BUDGET:-5.00}"

# If all are off, do nothing
if [ "$RETRIEVER_ENABLED" = "off" ] && [ "$LEARNER_ENABLED" = "off" ] && [ "$COMPACTOR_ENABLED" = "off" ] && [ "$CURATOR_ENABLED" = "off" ]; then
  echo '{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"[AIDAM Memory: disabled]"}}'
  exit 0
fi

PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT}"
if [ -z "$PLUGIN_ROOT" ]; then
  # Fallback to script directory parent
  PLUGIN_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
fi

ORCHESTRATOR_SCRIPT="${PLUGIN_ROOT}/scripts/orchestrator.js"
# PID file scoped by session_id (parallel-safe: each session has its own orchestrator)
PID_FILE="${PLUGIN_ROOT}/.orchestrator_${SESSION_ID}.pid"
LOG_DIR="$HOME/.claude/logs"
LOG_FILE="${LOG_DIR}/aidam_orchestrator_$(date +%Y%m%d_%H%M%S).log"

mkdir -p "$LOG_DIR"

# Detect zombie orchestrators in DB — only mark as crashed if heartbeat is stale
# (parallel-safe: each row is scoped by session_id, we don't kill other sessions' orchestrators)
# PGPASSWORD should be set in .env (loaded by plugin or parent shell)
export PGPASSWORD="${PGPASSWORD:-}"
PSQL="C:/Program Files/PostgreSQL/17/bin/psql.exe"
"$PSQL" -U postgres -h localhost -d claude_memory -t -A -c \
  "UPDATE orchestrator_state SET status='crashed', stopped_at=CURRENT_TIMESTAMP WHERE status IN ('starting','running') AND last_heartbeat_at < CURRENT_TIMESTAMP - INTERVAL '120 seconds';" \
  2>/dev/null || true

# ------------------------------------------------------------------
# PHASE 1: Handle /clear or /compact — inject previous session state
# ------------------------------------------------------------------
LAST_COMPACT_SIZE=0
INJECT=""

if [ "$SOURCE" = "clear" ] || [ "$SOURCE" = "compact" ]; then
  # Pass the new session_id so inject_state.py can find the previous one from DB
  INJECT=$("$PYTHON" "$(dirname "$0")/inject_state.py" "$SOURCE" "$SESSION_ID" 2>/dev/null || echo "")
  if [ -n "$INJECT" ]; then
    # Estimate the token size of the injected context for the Compactor
    # so it doesn't re-trigger immediately on the injected content
    INJECT_CHARS=$(echo "$INJECT" | wc -c | tr -d ' ')
    LAST_COMPACT_SIZE=$(( INJECT_CHARS / 4 ))  # ~4 chars per token
  fi

  # Kill previous orchestrator for THIS session if still running
  if [ -f "$PID_FILE" ]; then
    OLD_PID=$(cat "$PID_FILE")
    kill "$OLD_PID" 2>/dev/null || true
    rm -f "$PID_FILE"
  fi
else
  # Normal startup: check if orchestrator for THIS session is already running
  if [ -f "$PID_FILE" ]; then
    OLD_PID=$(cat "$PID_FILE")
    if kill -0 "$OLD_PID" 2>/dev/null; then
      # PID is alive — verify via DB that it's running for THIS specific session
      DB_STATUS=$("$PSQL" -U postgres -h localhost -d claude_memory -t -A -c \
        "SELECT status FROM orchestrator_state WHERE session_id='${SESSION_ID}' AND status='running' AND last_heartbeat_at > CURRENT_TIMESTAMP - INTERVAL '60 seconds' LIMIT 1;" \
        2>/dev/null | tr -d ' ' || echo "")
      if [ "$DB_STATUS" = "running" ]; then
        echo '{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"[AIDAM Memory: active (existing orchestrator)]"}}'
        exit 0
      fi
      # PID alive but DB says not running for this session — kill the zombie
      kill "$OLD_PID" 2>/dev/null || true
    fi
    rm -f "$PID_FILE"
  fi
fi

# ------------------------------------------------------------------
# PHASE 2: Launch orchestrator
# ------------------------------------------------------------------

# Derive project slug from cwd (pass via stdin to avoid backslash issues on Windows)
PROJECT_SLUG=$(echo "${CWD:-$(pwd)}" | "$PYTHON" -c "
import sys
cwd = sys.stdin.read().strip().replace('\\\\', '/').replace(':', '-').replace('/', '-').strip('-')
print(cwd)
" 2>/dev/null || echo "unknown")

# Launch orchestrator in background
node "$ORCHESTRATOR_SCRIPT" \
  "--session-id=${SESSION_ID}" \
  "--cwd=${CWD:-$(pwd)}" \
  "--retriever=${RETRIEVER_ENABLED}" \
  "--learner=${LEARNER_ENABLED}" \
  "--compactor=${COMPACTOR_ENABLED}" \
  "--curator=${CURATOR_ENABLED}" \
  "--transcript-path=${TRANSCRIPT_PATH}" \
  "--project-slug=${PROJECT_SLUG}" \
  "--last-compact-size=${LAST_COMPACT_SIZE}" \
  "--retriever-a-budget=${RETRIEVER_A_BUDGET}" \
  "--retriever-b-budget=${RETRIEVER_B_BUDGET}" \
  "--learner-budget=${LEARNER_BUDGET}" \
  "--compactor-budget=${COMPACTOR_BUDGET}" \
  "--curator-budget=${CURATOR_BUDGET}" \
  "--session-budget=${SESSION_BUDGET}" \
  > "$LOG_FILE" 2>&1 &

ORCH_PID=$!
echo "$ORCH_PID" > "$PID_FILE"
# Clean up legacy global PID file (from pre-parallel-safe versions)
rm -f "${PLUGIN_ROOT}/.orchestrator.pid"

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

# ------------------------------------------------------------------
# PHASE 3: Output — inject state (if /clear) or normal status
# ------------------------------------------------------------------

if [ -n "$INJECT" ]; then
  # inject_state.py already outputs the full hookSpecificOutput JSON
  echo "$INJECT"
else
  CONTEXT="[AIDAM Memory: active"
  if [ "$RETRIEVER_ENABLED" = "on" ]; then CONTEXT="${CONTEXT}, retriever=on"; fi
  if [ "$LEARNER_ENABLED" = "on" ]; then CONTEXT="${CONTEXT}, learner=on"; fi
  if [ "$COMPACTOR_ENABLED" = "on" ]; then CONTEXT="${CONTEXT}, compactor=on"; fi
  if [ "$CURATOR_ENABLED" = "on" ]; then CONTEXT="${CONTEXT}, curator=on"; fi
  if [ "$STATUS" != "running" ]; then CONTEXT="${CONTEXT}, initializing..."; fi
  CONTEXT="${CONTEXT}]"
  cat <<EOF
{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"${CONTEXT}"}}
EOF
fi

exit 0
