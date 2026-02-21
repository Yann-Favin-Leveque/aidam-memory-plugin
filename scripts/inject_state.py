#!/usr/bin/env python3
"""
AIDAM Memory - State Injection (parallel-safe)
Called by on_session_start.sh when source is "clear" or "compact".
Reads the previous session state from DB and raw tail from file,
combines them, and outputs JSON for additionalContext injection.

Finding the previous session:
  1. Primary: look for the most recent 'cleared' orchestrator in the DB
     (set by on_session_end.sh when reason=clear)
  2. Fallback: legacy marker file ~/.claude/aidam/last_cleared_session
"""
import sys
import json
import os

try:
    import psycopg2
except ImportError:
    sys.exit(0)

DB_CONFIG = {
    'host': 'localhost',
    'database': 'claude_memory',
    'user': 'postgres',
    'password': os.environ.get('PGPASSWORD', '')
}

# additionalContext limit is 10000 chars in Claude Code
MAX_CONTEXT_CHARS = 9500


def find_previous_session_id(conn, new_session_id):
    """Find the session_id of the most recently cleared session.

    Strategy: find the most recent orchestrator_state row with status='cleared'.
    This is parallel-safe because each /clear sets its own row to 'cleared'.
    After we consume it, we mark it 'injected' so it's not reused.
    """
    cur = conn.cursor()

    # Find the most recent cleared session (exclude the new session itself)
    cur.execute("""
        SELECT session_id FROM orchestrator_state
        WHERE status = 'cleared' AND session_id != %s
        ORDER BY started_at DESC
        LIMIT 1
    """, (new_session_id,))
    row = cur.fetchone()

    if row:
        previous_session_id = row[0]
        # Mark as consumed so another parallel /clear doesn't pick it up
        cur.execute("""
            UPDATE orchestrator_state SET status = 'injected'
            WHERE session_id = %s AND status = 'cleared'
        """, (previous_session_id,))
        conn.commit()
        return previous_session_id

    return None


def find_previous_session_id_legacy():
    """Fallback: read from legacy marker file (pre-parallel-safe)."""
    marker_path = os.path.expanduser("~/.claude/aidam/last_cleared_session")
    if not os.path.exists(marker_path):
        return None
    try:
        with open(marker_path, 'r') as f:
            session_id = f.read().strip()
        # Clean up marker (one-shot)
        os.remove(marker_path)
        return session_id if session_id else None
    except Exception:
        return None


def main():
    source = sys.argv[1] if len(sys.argv) > 1 else "clear"
    new_session_id = sys.argv[2] if len(sys.argv) > 2 else ""

    try:
        conn = psycopg2.connect(**DB_CONFIG)

        # Try DB-based lookup first (parallel-safe), fallback to legacy marker
        previous_session_id = None
        if new_session_id:
            previous_session_id = find_previous_session_id(conn, new_session_id)
        if not previous_session_id:
            previous_session_id = find_previous_session_id_legacy()

        if not previous_session_id:
            conn.close()
            sys.exit(0)

        cur = conn.cursor()

        # Get the latest session state for the previous session
        cur.execute("""
            SELECT state_text, raw_tail_path, version
            FROM session_state
            WHERE session_id = %s
            ORDER BY version DESC
            LIMIT 1
        """, (previous_session_id,))
        row = cur.fetchone()
        conn.close()

        if not row:
            sys.exit(0)

        state_text, raw_tail_path, version = row

        # Build the injection context
        parts = []

        # 1. Session state (structured summary)
        if state_text:
            parts.append(state_text)

        # 2. Raw conversation tail (if fits within budget)
        remaining = MAX_CONTEXT_CHARS - len('\n\n'.join(parts)) - 200  # margin
        if raw_tail_path and os.path.exists(raw_tail_path) and remaining > 1000:
            try:
                with open(raw_tail_path, 'r', encoding='utf-8') as f:
                    raw_tail = f.read()
                if raw_tail:
                    # Truncate from the beginning to keep the most recent
                    if len(raw_tail) > remaining:
                        raw_tail = "...(truncated)...\n\n" + raw_tail[-remaining:]
                    parts.append(f"## RECENT CONVERSATION TAIL\n{raw_tail}")
            except Exception:
                pass

        context = '\n\n'.join(parts)

        # Truncate if still too long
        if len(context) > MAX_CONTEXT_CHARS:
            context = context[:MAX_CONTEXT_CHARS] + "\n...(truncated)"

        # Build output JSON
        output = {
            "hookSpecificOutput": {
                "hookEventName": "SessionStart",
                "additionalContext": f"[AIDAM Memory: context restored from previous session (v{version})]\n\n{context}"
            }
        }
        print(json.dumps(output))

    except Exception:
        sys.exit(0)


if __name__ == '__main__':
    main()
