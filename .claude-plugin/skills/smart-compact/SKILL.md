---
name: smart-compact
description: Intelligently compact and clear session with AIDAM memory state preservation
disable-model-invocation: true
---

# /smart-compact — AIDAM Smart Compaction

This command replaces `/clear` when using the AIDAM Memory Plugin. It ensures the Compactor agent has saved the current session state before clearing, then re-injects that state into the new session.

## What it does

1. **Triggers the Compactor** to save the current session state (if not already saved recently)
2. **Waits** for the compactor to finish (up to 30s)
3. **Clears** the session context
4. **Re-injects** the compacted state from the database into the new session

## Why use this instead of /clear

- `/clear` works fine with AIDAM but only if the orchestrator is running and detects the clear event
- `/smart-compact` is explicit: you know the state was saved before clearing
- Prevents accidental context loss if the plugin isn't loaded or the orchestrator crashed

## Instructions

When the user invokes `/smart-compact`, execute these steps:

### Step 1: Check orchestrator status
```bash
export PGPASSWORD="${PGPASSWORD:-}"
PSQL="C:/Program Files/PostgreSQL/17/bin/psql.exe"
"$PSQL" -U postgres -h localhost -d claude_memory -t -A -c \
  "SELECT session_id, status, last_heartbeat_at FROM orchestrator_state WHERE status='running' ORDER BY last_heartbeat_at DESC LIMIT 1;"
```

If no running orchestrator is found, warn the user:
> "No AIDAM orchestrator is running. The session state may not be preserved. Use `/clear` directly if you want to clear without state preservation."

### Step 2: Trigger compaction
Insert a compactor trigger message into the cognitive inbox for the current session:
```bash
"$PSQL" -U postgres -h localhost -d claude_memory -c \
  "INSERT INTO cognitive_inbox (session_id, message_type, payload, status) VALUES ((SELECT session_id FROM orchestrator_state WHERE status='running' ORDER BY last_heartbeat_at DESC LIMIT 1), 'compactor_trigger', '{\"source\":\"smart-compact\"}', 'pending');"
```

### Step 3: Wait for compaction
Poll `session_state` for up to 30 seconds to verify the compactor has produced a recent state:
```bash
"$PSQL" -U postgres -h localhost -d claude_memory -t -A -c \
  "SELECT version, length(state_text), updated_at FROM session_state WHERE session_id=(SELECT session_id FROM orchestrator_state WHERE status='running' ORDER BY last_heartbeat_at DESC LIMIT 1) ORDER BY version DESC LIMIT 1;"
```

### Step 4: Report and clear
Tell the user what was saved, then invoke `/clear`:
> "AIDAM state saved (version N, X chars). Clearing session..."

Then use the `/clear` command. The SessionStart hook will automatically re-inject the saved state.

### Step 5: Confirm
After the clear and re-injection, confirm:
> "Session cleared and AIDAM state re-injected. The orchestrator will restart automatically."
