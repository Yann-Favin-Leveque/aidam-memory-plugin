#!/usr/bin/env python3
"""
AIDAM Memory - Refresh Tail on /clear
Called by on_session_end.sh when reason=clear AND a session_state already exists.
Re-extracts the conversation tail from the FULL transcript (not the stale
compactor-time snapshot) and updates the raw_tail_path in session_state.

This fixes the gap between the last compactor run and the actual end of
conversation. Without this, the tail would be from compactor time, missing
all messages after the last compaction.
"""
import sys
import json
import os
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

LOG_DIR = os.path.expanduser("~/.claude/logs")
os.makedirs(LOG_DIR, exist_ok=True)
logging.basicConfig(
    filename=os.path.join(LOG_DIR, "aidam_inject.log"), level=logging.INFO,
    format='%(asctime)s %(levelname)s %(message)s'
)
logger = logging.getLogger("refresh_tail")

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


def extract_tail_from_transcript(transcript_path, max_tail_chars=80000):
    """Extract conversation chunks from JSONL transcript, return the tail.

    Uses the same logic as orchestrator.ts but in Python:
    - [USER] for real user messages (string content)
    - [TOOL_RESULTS] lightweight summary for tool result arrays
    - [CLAUDE] for assistant text blocks (up to 3000 chars)
    - [TOOLS] for tool_use metadata
    """
    all_chunks = []
    last_plan_chunk_index = -1  # Track index of last plan Write to keep only the most recent

    try:
        with open(transcript_path, 'r', encoding='utf-8') as f:
            for line in f:
                try:
                    entry = json.loads(line.strip())

                    if entry.get('type') == 'user' and entry.get('message', {}).get('content'):
                        content = entry['message']['content']
                        if isinstance(content, str):
                            all_chunks.append(f"[USER] {content[:3000]}")
                        elif isinstance(content, list):
                            # Tool results — lightweight summary
                            summaries = []
                            for item in content:
                                if isinstance(item, dict) and item.get('type') == 'tool_result':
                                    rc = item.get('content', '')
                                    preview = (rc[:150] if isinstance(rc, str) else '').replace('\n', ' ')
                                    tid = (item.get('tool_use_id', '') or '')[-8:]
                                    summaries.append(f"{tid}: {preview}")
                            if summaries:
                                all_chunks.append(f"[TOOL_RESULTS] {' | '.join(summaries)[:500]}")

                    elif entry.get('type') == 'assistant' and entry.get('message', {}).get('content'):
                        blocks = entry['message']['content']
                        if isinstance(blocks, list):
                            # Text blocks
                            texts = []
                            for b in blocks:
                                if isinstance(b, dict) and b.get('type') == 'text':
                                    texts.append(b['text'])
                            if texts:
                                combined = '\n'.join(texts)[:3000]
                                all_chunks.append(f"[CLAUDE] {combined}")

                            # Tool use metadata (lightweight)
                            tool_metas = []
                            for b in blocks:
                                if isinstance(b, dict) and b.get('type') == 'tool_use' and b.get('name'):
                                    inp = b.get('input', {})
                                    # Detect plan Write — keep full plan content
                                    if b['name'] == 'Write' and '.claude/plans/' in (inp.get('file_path', '') or '').replace('\\', '/'):
                                        plan_path = (inp.get('file_path', '') or '').replace('\\', '/').split('/')[-1] or 'plan.md'
                                        plan_content = (inp.get('content', '') or '')[:5000]
                                        if last_plan_chunk_index >= 0:
                                            all_chunks.pop(last_plan_chunk_index)
                                            last_plan_chunk_index = len(all_chunks)
                                        else:
                                            last_plan_chunk_index = len(all_chunks)
                                        all_chunks.append(f"[ACTIVE_PLAN: {plan_path}]\n{plan_content}")
                                        continue
                                    meta = b['name']
                                    if b['name'] in ('Read', 'Write', 'Edit'):
                                        meta += f"({(inp.get('file_path','') or '')[-80:]})"
                                    elif b['name'] == 'Glob':
                                        meta += f"({inp.get('pattern','')})"
                                    elif b['name'] == 'Grep':
                                        meta += f"({(inp.get('pattern','') or '')[:60]})"
                                    elif b['name'] == 'Bash':
                                        meta += f"({(inp.get('command','') or '')[:100]})"
                                    tool_metas.append(meta)
                            if tool_metas:
                                all_chunks.append(f"[TOOLS] {' | '.join(tool_metas)}")

                except (json.JSONDecodeError, KeyError):
                    continue
    except Exception as e:
        logger.error(f"Failed to read transcript: {e}")
        return None

    if not all_chunks:
        return None

    # Take the last N chars (most recent conversation)
    tail_chunks = []
    total_chars = 0
    for chunk in reversed(all_chunks):
        if total_chars + len(chunk) > max_tail_chars:
            break
        tail_chunks.insert(0, chunk)
        total_chars += len(chunk)

    return '\n\n'.join(tail_chunks)


def main():
    if len(sys.argv) < 3:
        logger.error("Usage: refresh_tail.py <session_id> <transcript_path>")
        sys.exit(1)

    session_id = sys.argv[1]
    transcript_path = sys.argv[2]

    if not os.path.exists(transcript_path):
        logger.info(f"Transcript not found: {transcript_path}")
        sys.exit(0)

    # Extract fresh tail
    raw_tail = extract_tail_from_transcript(transcript_path)
    if not raw_tail:
        logger.info(f"No conversation content found in transcript")
        sys.exit(0)

    try:
        conn = psycopg2.connect(**DB_CONFIG)
        cur = conn.cursor()

        # Save fresh tail to file
        tail_dir = os.path.join(os.path.dirname(transcript_path), 'compactor_tails')
        os.makedirs(tail_dir, exist_ok=True)
        tail_path = os.path.join(tail_dir, f'{session_id}_fresh.txt')
        with open(tail_path, 'w', encoding='utf-8') as f:
            f.write(raw_tail)

        # Update the latest session_state row with the fresh tail path
        cur.execute("""
            UPDATE session_state
            SET raw_tail_path = %s
            WHERE session_id = %s
            AND version = (SELECT MAX(version) FROM session_state WHERE session_id = %s)
        """, (tail_path, session_id, session_id))

        rows_updated = cur.rowcount
        conn.commit()
        conn.close()

        logger.info(f"Refresh tail: session={session_id}, tail_len={len(raw_tail)}, "
                     f"tail_path={tail_path}, rows_updated={rows_updated}")
    except Exception as e:
        logger.error(f"Refresh tail DB update failed: {e}")

    sys.exit(0)


if __name__ == '__main__':
    main()
