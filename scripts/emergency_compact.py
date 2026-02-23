#!/usr/bin/env python3
"""
Emergency Compact - Quick session state extraction when /clear is called
before the Compactor agent has run. Extracts basic state from the JSONL
transcript without using an AI agent (fast, no API cost).
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

# Setup logging (shared with inject_state.py)
LOG_DIR = os.path.expanduser("~/.claude/logs")
os.makedirs(LOG_DIR, exist_ok=True)
logging.basicConfig(
    filename=os.path.join(LOG_DIR, "aidam_inject.log"), level=logging.INFO,
    format='%(asctime)s %(levelname)s %(message)s'
)
logger = logging.getLogger("emergency_compact")

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


def extract_state_from_transcript(transcript_path):
    """Extract a basic structured state from the JSONL transcript."""
    # Single chronological list: (role_tag, text)
    all_messages = []
    user_messages = []
    tool_calls = []

    try:
        with open(transcript_path, 'r', encoding='utf-8') as f:
            for line in f:
                try:
                    entry = json.loads(line.strip())
                    if entry.get('type') == 'user' and entry.get('message', {}).get('content'):
                        content = entry['message']['content']
                        if isinstance(content, str):
                            text = content[:500]
                            user_messages.append(text)
                            all_messages.append(f"[USER] {text}")
                        elif isinstance(content, list):
                            # Tool results array — lightweight summary only
                            summaries = []
                            for item in content:
                                if isinstance(item, dict) and item.get('type') == 'tool_result':
                                    rc = item.get('content', '')
                                    preview = (rc[:150] if isinstance(rc, str) else '').replace('\n', ' ')
                                    summaries.append(f"{(item.get('tool_use_id','') or '')[-8:]}: {preview}")
                            if summaries:
                                all_messages.append(f"[TOOL_RESULTS] {' | '.join(summaries)[:500]}")
                    elif entry.get('type') == 'assistant' and entry.get('message', {}).get('content'):
                        blocks = entry['message']['content']
                        if isinstance(blocks, list):
                            for b in blocks:
                                if isinstance(b, dict) and b.get('type') == 'text':
                                    all_messages.append(f"[CLAUDE] {b['text'][:500]}")
                                elif isinstance(b, dict) and b.get('type') == 'tool_use':
                                    tool_calls.append(b.get('name', 'unknown'))
                except (json.JSONDecodeError, KeyError):
                    continue
    except Exception as e:
        logger.error(f"Failed to read transcript: {e}")
        return None

    if not user_messages:
        return None

    first_prompt = user_messages[0] if user_messages else "Unknown"
    last_prompt = user_messages[-1] if user_messages else "Unknown"

    # Count unique tools used
    tool_summary = {}
    for t in tool_calls:
        tool_summary[t] = tool_summary.get(t, 0) + 1

    # Build raw tail from chronologically-ordered messages
    tail_messages = []
    total_chars = 0
    max_tail = 80000  # ~20k tokens
    for msg in reversed(all_messages):
        if total_chars + len(msg) > max_tail:
            break
        tail_messages.insert(0, msg)
        total_chars += len(msg)

    assistant_count = sum(1 for m in all_messages if m.startswith("[CLAUDE]"))
    state = f"""=== SESSION STATE v1 (emergency extract) ===

## IDENTITY
- Session goal: {first_prompt[:200]}

## TASK TREE
- [ ] IN PROGRESS: {last_prompt[:200]}

## KEY DECISIONS
- (No decisions extracted - emergency compact)

## WORKING CONTEXT
- Messages: {len(user_messages)} user, {assistant_count} assistant
- Tools used: {', '.join(f'{k}({v})' for k, v in sorted(tool_summary.items(), key=lambda x: -x[1])[:10])}

## CONVERSATION DYNAMICS
- Last user message: {last_prompt[:300]}

=== END STATE ==="""

    logger.info(f"Emergency compact: {len(user_messages)} user msgs, {assistant_count} assistant msgs, {len(tool_calls)} tool calls")
    return state, '\n\n'.join(tail_messages)


def main():
    if len(sys.argv) < 3:
        sys.exit(1)

    session_id = sys.argv[1]
    transcript_path = sys.argv[2]

    if not os.path.exists(transcript_path):
        sys.exit(0)

    result = extract_state_from_transcript(transcript_path)
    if not result:
        sys.exit(0)

    state_text, raw_tail = result

    try:
        conn = psycopg2.connect(**DB_CONFIG)
        cur = conn.cursor()

        # Save raw tail to file
        tail_dir = os.path.join(os.path.dirname(transcript_path), 'compactor_tails')
        os.makedirs(tail_dir, exist_ok=True)
        tail_path = os.path.join(tail_dir, f'{session_id}_emergency.txt')
        with open(tail_path, 'w', encoding='utf-8') as f:
            f.write(raw_tail)

        # Save state to DB
        cur.execute("""
            INSERT INTO session_state (session_id, project_slug, state_text, raw_tail_path, token_estimate, version)
            VALUES (%s, %s, %s, %s, %s, 1)
        """, (session_id, '', state_text, tail_path, len(raw_tail) // 4))
        conn.commit()
        conn.close()
        logger.info(f"Emergency compact saved: session={session_id}, state_len={len(state_text)}, tail_path={tail_path}")
    except Exception as e:
        logger.error(f"Emergency compact DB save failed: {e}")

    sys.exit(0)


if __name__ == '__main__':
    main()
