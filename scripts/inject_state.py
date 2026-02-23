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
import time
import logging

# Load .env from plugin root if env vars are missing
def _load_env():
    env_file = os.path.join(os.path.dirname(__file__), '..', '.env')
    if os.path.isfile(env_file):
        with open(env_file) as f:
            for line in f:
                line = line.strip()
                if line and not line.startswith('#') and '=' in line:
                    key, _, val = line.partition('=')
                    os.environ.setdefault(key.strip(), val.strip())

if not os.environ.get('PGPASSWORD'):
    _load_env()

# Setup logging
LOG_DIR = os.path.expanduser("~/.claude/logs")
os.makedirs(LOG_DIR, exist_ok=True)
LOG_PATH = os.path.join(LOG_DIR, "aidam_inject.log")
logging.basicConfig(
    filename=LOG_PATH, level=logging.INFO,
    format='%(asctime)s %(levelname)s %(message)s'
)
logger = logging.getLogger("inject_state")

try:
    import psycopg2
except ImportError:
    logger.error("psycopg2 not installed")
    sys.exit(0)

DB_CONFIG = {
    'host': 'localhost',
    'database': 'claude_memory',
    'user': 'postgres',
    'password': os.environ.get('PGPASSWORD', '')
}

# additionalContext limit is 40000 chars in Claude Code (silently dropped above)
MAX_CONTEXT_CHARS = 38000


def find_previous_session_id(conn, new_session_id):
    """Find the session_id of the most recently cleared session.

    Strategy: find the most recent orchestrator_state row with status='cleared'.
    This is parallel-safe because each /clear sets its own row to 'cleared'.
    After we consume it, we mark it 'injected' so it's not reused.
    """
    cur = conn.cursor()

    # Find the most recent cleared/clearing session (exclude the new session itself)
    cur.execute("""
        SELECT session_id FROM orchestrator_state
        WHERE status IN ('cleared', 'clearing') AND session_id != %s
        ORDER BY started_at DESC
        LIMIT 1
    """, (new_session_id,))
    row = cur.fetchone()

    if row:
        previous_session_id = row[0]
        # Mark as consumed so another parallel /clear doesn't pick it up
        cur.execute("""
            UPDATE orchestrator_state SET status = 'injected'
            WHERE session_id = %s AND status IN ('cleared', 'clearing')
        """, (previous_session_id,))
        conn.commit()
        logger.info(f"Found previous session: {previous_session_id}")
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


def find_with_retry(conn, new_session_id, retries=3, delay=0.5):
    """Retry finding the previous session to handle race conditions."""
    for attempt in range(retries):
        prev = find_previous_session_id(conn, new_session_id)
        if prev:
            return prev
        if attempt < retries - 1:
            logger.info(f"No cleared/clearing session found, retry {attempt+1}/{retries}")
            time.sleep(delay)
    return find_previous_session_id_legacy()


def main():
    source = sys.argv[1] if len(sys.argv) > 1 else "clear"
    new_session_id = sys.argv[2] if len(sys.argv) > 2 else ""
    logger.info(f"inject_state called: source={source}, new_session_id={new_session_id}")

    try:
        conn = psycopg2.connect(**DB_CONFIG)

        # Try DB-based lookup with retries (parallel-safe), fallback to legacy marker
        previous_session_id = None
        if new_session_id:
            previous_session_id = find_with_retry(conn, new_session_id)
        if not previous_session_id:
            previous_session_id = find_previous_session_id_legacy()

        if not previous_session_id:
            logger.info("No previous session found")
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
            logger.info(f"No session_state found for {previous_session_id}")
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
                    # Filter out tool metadata lines to maximize user/claude content
                    lines = raw_tail.split('\n')
                    lines = [l for l in lines if not l.startswith('[TOOLS]') and not l.startswith('[TOOL_RESULTS]')]
                    raw_tail = '\n'.join(lines)
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
        output_json = json.dumps(output)
        logger.info(f"Outputting JSON: {len(output_json)} chars, context_len={len(context)}")
        print(output_json)

    except Exception as e:
        logger.error(f"inject_state failed: {e}", exc_info=True)
        sys.exit(0)


if __name__ == '__main__':
    main()
