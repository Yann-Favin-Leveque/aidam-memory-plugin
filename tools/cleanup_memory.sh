#!/bin/bash
# AIDAM Memory Cleanup Script
# Usage: bash cleanup_memory.sh [--dry-run] [--days N]
#
# Cleans up queue tables and zombie orchestrators.

set -e

export PGPASSWORD="***REDACTED***"
PSQL="C:/Program Files/PostgreSQL/17/bin/psql.exe"
DB_ARGS="-U postgres -h localhost -d claude_memory"

DRY_RUN=false
DAYS=7

while [[ "$#" -gt 0 ]]; do
  case $1 in
    --dry-run) DRY_RUN=true ;;
    --days) DAYS="$2"; shift ;;
    *) echo "Unknown parameter: $1"; exit 1 ;;
  esac
  shift
done

echo "=== AIDAM Memory Cleanup ==="
echo "Mode: $([ "$DRY_RUN" = true ] && echo 'DRY RUN' || echo 'LIVE')"
echo "Retention: ${DAYS} days"
echo ""

# 1. Expire pending retrieval_inbox entries
COUNT=$("$PSQL" $DB_ARGS -t -A -c "SELECT COUNT(*) FROM retrieval_inbox WHERE status = 'pending' AND expires_at < CURRENT_TIMESTAMP;")
echo "[retrieval_inbox] Expired pending: $COUNT"
if [ "$DRY_RUN" = false ] && [ "$COUNT" -gt 0 ]; then
  "$PSQL" $DB_ARGS -c "SELECT cleanup_expired_retrieval();"
fi

# 2. Delete old retrieval_inbox (delivered/expired/skipped > N days)
COUNT=$("$PSQL" $DB_ARGS -t -A -c "SELECT COUNT(*) FROM retrieval_inbox WHERE status IN ('delivered','expired','skipped') AND created_at < CURRENT_TIMESTAMP - INTERVAL '${DAYS} days';")
echo "[retrieval_inbox] Old entries to delete: $COUNT"
if [ "$DRY_RUN" = false ] && [ "$COUNT" -gt 0 ]; then
  "$PSQL" $DB_ARGS -c "DELETE FROM retrieval_inbox WHERE status IN ('delivered','expired','skipped') AND created_at < CURRENT_TIMESTAMP - INTERVAL '${DAYS} days';"
fi

# 3. Delete old cognitive_inbox (completed/failed > N days)
COUNT=$("$PSQL" $DB_ARGS -t -A -c "SELECT COUNT(*) FROM cognitive_inbox WHERE status IN ('completed','failed') AND created_at < CURRENT_TIMESTAMP - INTERVAL '${DAYS} days';")
echo "[cognitive_inbox] Old entries to delete: $COUNT"
if [ "$DRY_RUN" = false ] && [ "$COUNT" -gt 0 ]; then
  "$PSQL" $DB_ARGS -c "DELETE FROM cognitive_inbox WHERE status IN ('completed','failed') AND created_at < CURRENT_TIMESTAMP - INTERVAL '${DAYS} days';"
fi

# 4. Mark zombie orchestrators (no heartbeat > 5min)
COUNT=$("$PSQL" $DB_ARGS -t -A -c "SELECT COUNT(*) FROM orchestrator_state WHERE status IN ('starting','running') AND last_heartbeat_at < CURRENT_TIMESTAMP - INTERVAL '5 minutes';")
echo "[orchestrator_state] Zombies: $COUNT"
if [ "$DRY_RUN" = false ] && [ "$COUNT" -gt 0 ]; then
  "$PSQL" $DB_ARGS -c "UPDATE orchestrator_state SET status='crashed', stopped_at=CURRENT_TIMESTAMP WHERE status IN ('starting','running') AND last_heartbeat_at < CURRENT_TIMESTAMP - INTERVAL '5 minutes';"
fi

# 5. Delete old orchestrator_state (stopped/crashed > N days)
COUNT=$("$PSQL" $DB_ARGS -t -A -c "SELECT COUNT(*) FROM orchestrator_state WHERE status IN ('stopped','crashed') AND started_at < CURRENT_TIMESTAMP - INTERVAL '${DAYS} days';")
echo "[orchestrator_state] Old entries to delete: $COUNT"
if [ "$DRY_RUN" = false ] && [ "$COUNT" -gt 0 ]; then
  "$PSQL" $DB_ARGS -c "DELETE FROM orchestrator_state WHERE status IN ('stopped','crashed') AND started_at < CURRENT_TIMESTAMP - INTERVAL '${DAYS} days';"
fi

echo ""
echo "=== Table Sizes ==="
"$PSQL" $DB_ARGS -t -A -c "
  SELECT 'cognitive_inbox: ' || COUNT(*) FROM cognitive_inbox
  UNION ALL SELECT 'retrieval_inbox: ' || COUNT(*) FROM retrieval_inbox
  UNION ALL SELECT 'orchestrator_state: ' || COUNT(*) FROM orchestrator_state
  UNION ALL SELECT 'generated_tools: ' || COUNT(*) FROM generated_tools;
"

echo ""
echo "Done."
