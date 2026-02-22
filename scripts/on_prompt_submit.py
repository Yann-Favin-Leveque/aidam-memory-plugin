#!/usr/bin/env python3
"""
AIDAM Memory - UserPromptSubmit Hook
Pushes user prompt to the Retriever queue, then polls retrieval_inbox
for results and injects them via additionalContext.
"""
import sys
import json
import hashlib
import time
import os

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


def get_conn():
    return psycopg2.connect(**DB_CONFIG)


def _merge_results(results):
    """Merge context blocks from dual retrievers, avoiding header duplication."""
    if len(results) == 1:
        return results[0]
    merged = results[0]
    for extra in results[1:]:
        # Replace the header to mark it as additional context
        extra_clean = extra.replace("=== MEMORY CONTEXT ===", "=== ADDITIONAL CONTEXT ===")
        merged += "\n\n" + extra_clean
    return merged


def main():
    # Check if retriever is enabled
    if os.environ.get('AIDAM_MEMORY_RETRIEVER', 'on') == 'off':
        sys.exit(0)

    # Read hook input from stdin
    raw = sys.stdin.read()
    try:
        data = json.loads(raw)
    except (json.JSONDecodeError, ValueError):
        sys.exit(0)

    session_id = data.get('session_id', '')
    prompt = data.get('prompt', '')

    if not prompt or not session_id:
        sys.exit(0)

    # Compute prompt hash for correlation
    prompt_hash = hashlib.sha256(prompt.encode('utf-8')).hexdigest()[:16]

    try:
        conn = get_conn()
    except Exception:
        sys.exit(0)

    try:
        cur = conn.cursor()

        # 1. Push prompt to cognitive_inbox for the Retriever
        cur.execute("""
            INSERT INTO cognitive_inbox (session_id, message_type, payload, status)
            VALUES (%s, 'prompt_context', %s, 'pending')
        """, (session_id, json.dumps({
            'prompt': prompt,
            'prompt_hash': prompt_hash,
            'timestamp': time.time()
        })))
        conn.commit()

        # 2. Expire old retrieval results
        cur.execute("SELECT cleanup_expired_retrieval()")
        conn.commit()

        # 2b. Check for any undelivered result from a PREVIOUS prompt (late arrival)
        result_text = None
        cur.execute("""
            SELECT id, context_type, context_text
            FROM retrieval_inbox
            WHERE session_id = %s
              AND status = 'pending'
              AND context_type != 'none'
              AND context_text IS NOT NULL
              AND context_text != ''
              AND expires_at > CURRENT_TIMESTAMP
            ORDER BY created_at DESC
            LIMIT 1
        """, (session_id,))
        late_row = cur.fetchone()
        if late_row:
            late_id, late_type, late_text = late_row
            cur.execute("UPDATE retrieval_inbox SET status='delivered', delivered_at=CURRENT_TIMESTAMP WHERE id=%s", (late_id,))
            conn.commit()
            result_text = late_text

        # 3. Poll retrieval_inbox for results from THIS prompt (up to ~7s)
        #    With dual retrievers, we may get 2 results. Take the first immediately,
        #    then wait briefly for the second to merge.
        if not result_text:
            results_collected = []
            none_count = 0
            second_chance = False
            remaining_polls = 0
            poll_intervals = [0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5]

            for wait in poll_intervals:
                time.sleep(wait)
                # Fetch ALL pending results for this prompt (both retrievers)
                cur.execute("""
                    SELECT id, context_type, context_text, relevance_score
                    FROM retrieval_inbox
                    WHERE session_id = %s
                      AND prompt_hash = %s
                      AND status = 'pending'
                      AND expires_at > CURRENT_TIMESTAMP
                    ORDER BY created_at ASC
                """, (session_id, prompt_hash))
                rows = cur.fetchall()

                for row in rows:
                    row_id, ctx_type, ctx_text, relevance = row
                    # Mark as delivered
                    cur.execute("""
                        UPDATE retrieval_inbox
                        SET status = 'delivered', delivered_at = CURRENT_TIMESTAMP
                        WHERE id = %s
                    """, (row_id,))
                    conn.commit()

                    if ctx_type == 'none' or not ctx_text:
                        none_count += 1
                    else:
                        results_collected.append(ctx_text)

                # Both retrievers returned 'none' — nothing relevant
                if none_count >= 2:
                    break

                # Got first real result — give 1.5s more for the second
                if results_collected and not second_chance:
                    second_chance = True
                    remaining_polls = 3

                if second_chance:
                    remaining_polls -= 1
                    if remaining_polls <= 0 or len(results_collected) >= 2:
                        break

            if results_collected:
                result_text = _merge_results(results_collected)

        # 4. Output context if found
        if result_text:
            output = {
                "hookSpecificOutput": {
                    "hookEventName": "UserPromptSubmit",
                    "additionalContext": result_text
                }
            }
            print(json.dumps(output))

    except Exception:
        pass  # Never block the user session
    finally:
        try:
            conn.close()
        except Exception:
            pass

    sys.exit(0)


if __name__ == '__main__':
    main()
