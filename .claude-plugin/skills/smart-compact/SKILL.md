---
name: smart-compact
description: Clear session safely with AIDAM state re-injection. Use -forcesummary to trigger compaction first.
disable-model-invocation: true
---

# /smart-compact — AIDAM Smart Clear

This command replaces `/clear` when using the AIDAM Memory Plugin. By default it clears the session and re-injects the **existing** compacted state from the database. The orchestrator's automatic compactor handles periodic summaries — this command just ensures a clean clear/re-inject cycle.

## Usage

- `/smart-compact` — Clear and re-inject existing state (fast, no compactor call)
- `/smart-compact -forcesummary` — Force compactor to run first, then clear and re-inject

## Why use this instead of /clear

- `/clear` works fine with AIDAM but only if the orchestrator is running and detects the clear event
- `/smart-compact` is explicit: you know the state will be re-injected after clearing
- Prevents accidental context loss if the plugin isn't loaded or the orchestrator crashed
- With `-forcesummary`, ensures the very latest conversation is captured before clearing

## Instructions

When the user invokes `/smart-compact`, execute these steps:

### Step 1: Check for `-forcesummary` flag

Parse the user's command. If they typed `/smart-compact -forcesummary`, set FORCE_SUMMARY=true. Otherwise FORCE_SUMMARY=false.

### Step 2: Check orchestrator status
```bash
export PGPASSWORD="${PGPASSWORD:-}"
PSQL="C:/Program Files/PostgreSQL/17/bin/psql.exe"
"$PSQL" -U postgres -h localhost -d claude_memory -t -A -c \
  "SELECT session_id, status, last_heartbeat_at FROM orchestrator_state WHERE status='running' ORDER BY last_heartbeat_at DESC LIMIT 1;"
```

If no running orchestrator is found, warn the user:
> "No AIDAM orchestrator is running. The session state may not be preserved. Proceeding with `/clear` — the SessionStart hook will try to re-inject any existing state."

Then skip to Step 5.

### Step 3: Check existing state
```bash
"$PSQL" -U postgres -h localhost -d claude_memory -t -A -c \
  "SELECT version, length(state_text), updated_at FROM session_state WHERE session_id=(SELECT session_id FROM orchestrator_state WHERE status='running' ORDER BY last_heartbeat_at DESC LIMIT 1) ORDER BY version DESC LIMIT 1;"
```

Report the existing state:
> "Current AIDAM state: version N, X chars (last updated: TIMESTAMP)"

### Step 4: If `-forcesummary`, trigger compaction

**Only if FORCE_SUMMARY=true:**

```bash
"$PSQL" -U postgres -h localhost -d claude_memory -c \
  "INSERT INTO cognitive_inbox (session_id, message_type, payload, status) VALUES ((SELECT session_id FROM orchestrator_state WHERE status='running' ORDER BY last_heartbeat_at DESC LIMIT 1), 'compactor_trigger', '{\"source\":\"smart-compact-forcesummary\"}', 'pending');"
```

Then poll `session_state` for up to 30 seconds to verify the compactor has produced a newer version:
```bash
"$PSQL" -U postgres -h localhost -d claude_memory -t -A -c \
  "SELECT version, length(state_text), updated_at FROM session_state WHERE session_id=(SELECT session_id FROM orchestrator_state WHERE status='running' ORDER BY last_heartbeat_at DESC LIMIT 1) ORDER BY version DESC LIMIT 1;"
```

> "Compactor finished: version N+1, X chars. Proceeding to clear."

**If FORCE_SUMMARY=false**, skip this step entirely:
> "Skipping compaction (use `-forcesummary` to force). Re-injecting existing state."

### Step 5: Clear session

Tell the user what will happen, then invoke `/clear`:
> "Clearing session... The SessionStart hook will automatically re-inject the saved state."

Then use the `/clear` command.

### Step 6: Confirm

After the clear and re-injection, confirm:
> "Session cleared and AIDAM state re-injected. The orchestrator will restart automatically."
