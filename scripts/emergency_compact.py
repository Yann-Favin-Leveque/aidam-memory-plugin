#!/usr/bin/env python3
"""
Emergency Compact - Quick session state extraction when /clear is called
before the Compactor agent has run. Extracts basic state from the JSONL
transcript without using an AI agent (fast, no API cost).
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


def extract_state_from_transcript(transcript_path):
    """Extract a basic structured state from the JSONL transcript."""
    user_messages = []
    assistant_texts = []
    tool_calls = []

    try:
        with open(transcript_path, 'r', encoding='utf-8') as f:
            for line in f:
                try:
                    entry = json.loads(line.strip())
                    if entry.get('type') == 'user' and entry.get('message', {}).get('content'):
                        content = entry['message']['content']
                        if isinstance(content, str):
                            user_messages.append(content[:500])
                    elif entry.get('type') == 'assistant' and entry.get('message', {}).get('content'):
                        blocks = entry['message']['content']
                        if isinstance(blocks, list):
                            for b in blocks:
                                if isinstance(b, dict) and b.get('type') == 'text':
                                    assistant_texts.append(b['text'][:500])
                                elif isinstance(b, dict) and b.get('type') == 'tool_use':
                                    tool_calls.append(b.get('name', 'unknown'))
                except (json.JSONDecodeError, KeyError):
                    continue
    except Exception:
        return None

    if not user_messages:
        return None

    # Build a basic state from what we have
    # First user message often contains the session goal
    first_prompt = user_messages[0] if user_messages else "Unknown"
    last_prompt = user_messages[-1] if user_messages else "Unknown"

    # Count unique tools used
    tool_summary = {}
    for t in tool_calls:
        tool_summary[t] = tool_summary.get(t, 0) + 1

    # Build raw tail (last N messages)
    tail_messages = []
    total_chars = 0
    max_tail = 80000  # ~20k tokens
    for msg in reversed(user_messages + assistant_texts):
        if total_chars + len(msg) > max_tail:
            break
        tail_messages.insert(0, msg)
        total_chars += len(msg)

    state = f"""=== SESSION STATE v1 (emergency extract) ===

## IDENTITY
- Session goal: {first_prompt[:200]}

## TASK TREE
- [ ] IN PROGRESS: {last_prompt[:200]}

## KEY DECISIONS
- (No decisions extracted - emergency compact)

## WORKING CONTEXT
- Messages: {len(user_messages)} user, {len(assistant_texts)} assistant
- Tools used: {', '.join(f'{k}({v})' for k, v in sorted(tool_summary.items(), key=lambda x: -x[1])[:10])}

## CONVERSATION DYNAMICS
- Last user message: {last_prompt[:300]}

=== END STATE ==="""

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
    except Exception:
        pass

    sys.exit(0)


if __name__ == '__main__':
    main()
