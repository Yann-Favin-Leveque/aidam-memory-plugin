#!/usr/bin/env python3
"""
AIDAM Memory - State Injection
Called by on_session_start.sh when source is "clear" or "compact".
Reads the previous session state from DB and raw tail from file,
combines them, and outputs JSON for additionalContext injection.
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
    'password': '***REDACTED***'
}

# additionalContext limit is 10000 chars in Claude Code
MAX_CONTEXT_CHARS = 9500


def main():
    source = sys.argv[1] if len(sys.argv) > 1 else "clear"

    # Read the marker file to find which session was cleared
    marker_path = os.path.expanduser("~/.claude/aidam/last_cleared_session")
    if not os.path.exists(marker_path):
        sys.exit(0)

    try:
        with open(marker_path, 'r') as f:
            previous_session_id = f.read().strip()
    except Exception:
        sys.exit(0)

    if not previous_session_id:
        sys.exit(0)

    try:
        conn = psycopg2.connect(**DB_CONFIG)
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
        # Escape for JSON embedding
        output = {
            "hookSpecificOutput": {
                "hookEventName": "SessionStart",
                "additionalContext": f"[AIDAM Memory: context restored from previous session (v{version})]\n\n{context}"
            }
        }
        print(json.dumps(output))

        # Clean up marker (one-shot)
        try:
            os.remove(marker_path)
        except Exception:
            pass

    except Exception:
        sys.exit(0)


if __name__ == '__main__':
    main()
