#!/usr/bin/env python3
"""
AIDAM Memory - PostToolUse Hook (async)
Pushes tool call data to cognitive_inbox for the Learner to process.
Non-blocking: all exceptions are silently caught.
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

# Tools to skip (noisy, low-value for learning)
SKIP_TOOLS = {
    'Read', 'Glob', 'Grep', 'WebSearch', 'WebFetch',
    'TaskCreate', 'TaskUpdate', 'TaskList', 'TaskGet',
    'AskUserQuestion', 'EnterPlanMode', 'ExitPlanMode',
    'NotebookEdit', 'TaskOutput', 'TaskStop',
    'EnterWorktree', 'Skill',
    'mcp__memory__memory_search',
    'mcp__memory__memory_get_project',
    'mcp__memory__memory_list_projects',
    'mcp__memory__memory_get_preferences',
    'mcp__memory__memory_search_errors',
    'mcp__memory__memory_search_patterns',
    'mcp__memory__memory_get_recent_learnings',
    'mcp__memory__memory_get_stats',
    'mcp__memory__memory_get_project_learnings',
    'mcp__memory__memory_get_sessions',
    'mcp__memory__memory_drilldown_list',
    'mcp__memory__memory_drilldown_get',
    'mcp__memory__memory_drilldown_search',
    'mcp__memory__db_describe_schema',
    'mcp__memory__db_select',
}

MAX_RESPONSE_CHARS = 4000


def main():
    # Check if learner is enabled
    if os.environ.get('AIDAM_MEMORY_LEARNER', 'on') == 'off':
        sys.exit(0)

    raw = sys.stdin.read()
    try:
        data = json.loads(raw)
    except (json.JSONDecodeError, ValueError):
        sys.exit(0)

    tool_name = data.get('tool_name', '')
    session_id = data.get('session_id', '')

    if not tool_name or not session_id:
        sys.exit(0)

    # Skip noisy tools
    if tool_name in SKIP_TOOLS:
        sys.exit(0)

    # Build payload with truncation
    tool_input = data.get('tool_input', {})
    tool_response = data.get('tool_response', {})

    response_str = json.dumps(tool_response)
    if len(response_str) > MAX_RESPONSE_CHARS:
        tool_response = {
            '_truncated': True,
            '_preview': response_str[:MAX_RESPONSE_CHARS // 2],
            '_length': len(response_str)
        }

    input_str = json.dumps(tool_input)
    if len(input_str) > MAX_RESPONSE_CHARS:
        tool_input = {
            '_truncated': True,
            '_preview': input_str[:MAX_RESPONSE_CHARS // 2],
            '_length': len(input_str)
        }

    payload = {
        'tool_name': tool_name,
        'tool_input': tool_input,
        'tool_response': tool_response
    }

    try:
        conn = psycopg2.connect(**DB_CONFIG)
        cur = conn.cursor()
        cur.execute("""
            INSERT INTO cognitive_inbox (session_id, message_type, payload, status)
            VALUES (%s, 'tool_use', %s, 'pending')
        """, (session_id, json.dumps(payload)))
        conn.commit()
        conn.close()
    except Exception:
        pass  # Async hook: never block

    sys.exit(0)


if __name__ == '__main__':
    main()
