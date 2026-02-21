#!/usr/bin/env python3
"""
Claude Memory PostgreSQL Utilities
==================================
Core library for interacting with Claude's PostgreSQL memory database.
"""

import json
import os
from datetime import datetime
from typing import Optional, List, Dict, Any, Union
import psycopg2
from psycopg2.extras import RealDictCursor

# Database configuration
DB_CONFIG = {
    'host': 'localhost',
    'database': 'claude_memory',
    'user': 'postgres',
    'password': 'Berenice1995'
}

def get_connection():
    """Get database connection."""
    return psycopg2.connect(**DB_CONFIG)

def execute_query(query: str, params: tuple = None, fetch: bool = True) -> Any:
    """Execute a query and return results."""
    conn = get_connection()
    try:
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            cur.execute(query, params)
            if fetch:
                return [dict(row) for row in cur.fetchall()]
            conn.commit()
            return cur.rowcount
    finally:
        conn.close()

def execute_insert(query: str, params: tuple) -> int:
    """Execute an insert and return the new ID."""
    conn = get_connection()
    try:
        with conn.cursor() as cur:
            cur.execute(query + " RETURNING id", params)
            new_id = cur.fetchone()[0]
            conn.commit()
            return new_id
    finally:
        conn.close()

# ============================================
# PROJECT OPERATIONS
# ============================================

def add_project(name: str, path: str, description: str = None,
                stack: List[str] = None, git_repo: str = None) -> int:
    return execute_insert("""
        INSERT INTO projects (name, path, description, stack, git_repo)
        VALUES (%s, %s, %s, %s, %s)
    """, (name, path, description, json.dumps(stack) if stack else None, git_repo))

def get_project(identifier: Union[int, str]) -> Optional[Dict]:
    if isinstance(identifier, int):
        results = execute_query("SELECT * FROM projects WHERE id = %s", (identifier,))
    else:
        # Case-insensitive search
        results = execute_query("SELECT * FROM projects WHERE LOWER(name) = LOWER(%s)", (identifier,))
    return results[0] if results else None

def list_projects(status: str = 'active') -> List[Dict]:
    if status:
        return execute_query("SELECT * FROM projects WHERE status = %s ORDER BY last_session_at DESC NULLS LAST", (status,))
    return execute_query("SELECT * FROM projects ORDER BY last_session_at DESC NULLS LAST")

def update_project_session(project_id: int):
    execute_query("UPDATE projects SET last_session_at = CURRENT_TIMESTAMP WHERE id = %s", (project_id,), fetch=False)

# ============================================
# TOOL OPERATIONS
# ============================================

def add_tool(name: str, description: str, category: str, language: str,
             file_path: str = None, code: str = None, parameters: Dict = None,
             use_cases: str = None, tags: List[str] = None, project_id: int = None) -> int:
    return execute_insert("""
        INSERT INTO tools (name, description, category, language, file_path, code,
                          parameters, use_cases, tags, project_id)
        VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
    """, (name, description, category, language, file_path, code,
          json.dumps(parameters) if parameters else None,
          use_cases, json.dumps(tags) if tags else None, project_id))

def get_tool(identifier: Union[int, str]) -> Optional[Dict]:
    if isinstance(identifier, int):
        results = execute_query("SELECT * FROM tools WHERE id = %s", (identifier,))
    else:
        results = execute_query("SELECT * FROM tools WHERE name = %s", (identifier,))
    return results[0] if results else None

def search_tools(query: str, limit: int = 10) -> List[Dict]:
    return execute_query("""
        SELECT * FROM tools
        WHERE search_vector @@ plainto_tsquery('english', %s)
        ORDER BY ts_rank(search_vector, plainto_tsquery('english', %s)) DESC
        LIMIT %s
    """, (query, query, limit))

def list_tools(category: str = None, language: str = None, project_id: int = None) -> List[Dict]:
    conditions = ["is_active = true"]
    params = []
    if category:
        conditions.append("category = %s")
        params.append(category)
    if language:
        conditions.append("language = %s")
        params.append(language)
    if project_id is not None:
        conditions.append("(project_id = %s OR project_id IS NULL)")
        params.append(project_id)

    query = f"SELECT * FROM tools WHERE {' AND '.join(conditions)} ORDER BY usage_count DESC"
    return execute_query(query, tuple(params))

def use_tool(tool_id: int):
    execute_query("""
        UPDATE tools SET usage_count = usage_count + 1, last_used_at = CURRENT_TIMESTAMP
        WHERE id = %s
    """, (tool_id,), fetch=False)

# ============================================
# PATTERN OPERATIONS
# ============================================

def add_pattern(name: str, category: str, problem: str, solution: str,
                context: str = None, code_example: str = None, language: str = None,
                tags: List[str] = None, source: str = None, confidence: str = 'proven') -> int:
    return execute_insert("""
        INSERT INTO patterns (name, category, problem, solution, context,
                             code_example, language, tags, source, confidence)
        VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
    """, (name, category, problem, solution, context, code_example, language,
          json.dumps(tags) if tags else None, source, confidence))

def search_patterns(query: str, limit: int = 10) -> List[Dict]:
    return execute_query("""
        SELECT * FROM patterns
        WHERE search_vector @@ plainto_tsquery('english', %s)
        ORDER BY ts_rank(search_vector, plainto_tsquery('english', %s)) DESC
        LIMIT %s
    """, (query, query, limit))

def get_patterns_by_category(category: str) -> List[Dict]:
    return execute_query("SELECT * FROM patterns WHERE category = %s ORDER BY usage_count DESC", (category,))

# ============================================
# LEARNING OPERATIONS
# ============================================

def add_learning(topic: str, insight: str, category: str = None, context: str = None,
                 tags: List[str] = None, source: str = None,
                 project_id: int = None, confidence: str = 'confirmed') -> int:
    return execute_insert("""
        INSERT INTO learnings (topic, insight, category, context, tags, source,
                              related_project_id, confidence)
        VALUES (%s, %s, %s, %s, %s, %s, %s, %s)
    """, (topic, insight, category, context, json.dumps(tags) if tags else None,
          source, project_id, confidence))

def search_learnings(query: str, limit: int = 10) -> List[Dict]:
    return execute_query("""
        SELECT * FROM learnings
        WHERE search_vector @@ plainto_tsquery('english', %s)
        ORDER BY ts_rank(search_vector, plainto_tsquery('english', %s)) DESC
        LIMIT %s
    """, (query, query, limit))

def get_recent_learnings(limit: int = 20) -> List[Dict]:
    return execute_query("SELECT * FROM v_recent_learnings LIMIT %s", (limit,))

# ============================================
# ERROR/SOLUTION OPERATIONS
# ============================================

def add_error_solution(error_signature: str, solution: str, error_message: str = None,
                       root_cause: str = None, prevention: str = None,
                       tags: List[str] = None, project_id: int = None) -> int:
    return execute_insert("""
        INSERT INTO errors_solutions (error_signature, error_message, root_cause,
                                     solution, prevention, tags, related_project_id)
        VALUES (%s, %s, %s, %s, %s, %s, %s)
    """, (error_signature, error_message, root_cause, solution, prevention,
          json.dumps(tags) if tags else None, project_id))

def search_errors(query: str, limit: int = 10) -> List[Dict]:
    return execute_query("""
        SELECT * FROM errors_solutions
        WHERE search_vector @@ plainto_tsquery('english', %s)
        ORDER BY ts_rank(search_vector, plainto_tsquery('english', %s)) DESC
        LIMIT %s
    """, (query, query, limit))

# ============================================
# USER PREFERENCES
# ============================================

def set_preference(category: str, key: str, value: str, notes: str = None, project_id: int = None):
    conn = get_connection()
    try:
        with conn.cursor() as cur:
            cur.execute("""
                INSERT INTO user_preferences (category, key, value, notes, project_id)
                VALUES (%s, %s, %s, %s, %s)
                ON CONFLICT (category, key, project_id) WHERE project_id IS NOT NULL
                DO UPDATE SET value = EXCLUDED.value, notes = EXCLUDED.notes, updated_at = CURRENT_TIMESTAMP
            """, (category, key, value, notes, project_id))
            conn.commit()
    finally:
        conn.close()

def get_preference(category: str, key: str, project_id: int = None) -> Optional[str]:
    results = execute_query("""
        SELECT value FROM user_preferences
        WHERE category = %s AND key = %s AND (project_id = %s OR project_id IS NULL)
        ORDER BY project_id DESC NULLS LAST
        LIMIT 1
    """, (category, key, project_id))
    return results[0]['value'] if results else None

def get_preferences_by_category(category: str, project_id: int = None) -> Dict[str, str]:
    if project_id:
        results = execute_query("""
            SELECT key, value FROM user_preferences
            WHERE category = %s AND (project_id = %s OR project_id IS NULL)
        """, (category, project_id))
    else:
        results = execute_query("""
            SELECT key, value FROM user_preferences
            WHERE category = %s AND project_id IS NULL
        """, (category,))
    return {r['key']: r['value'] for r in results}

# ============================================
# COMMAND OPERATIONS
# ============================================

def add_command(name: str, command: str, description: str = None,
                category: str = None, tags: List[str] = None, project_id: int = None) -> int:
    return execute_insert("""
        INSERT INTO commands (name, command, description, category, tags, project_id)
        VALUES (%s, %s, %s, %s, %s, %s)
    """, (name, command, description, category, json.dumps(tags) if tags else None, project_id))

def get_commands(category: str = None, project_id: int = None) -> List[Dict]:
    conditions = []
    params = []
    if category:
        conditions.append("category = %s")
        params.append(category)
    if project_id:
        conditions.append("(project_id = %s OR project_id IS NULL)")
        params.append(project_id)

    where_clause = f"WHERE {' AND '.join(conditions)}" if conditions else ""
    return execute_query(f"SELECT * FROM commands {where_clause} ORDER BY usage_count DESC", tuple(params))

# ============================================
# SESSION OPERATIONS
# ============================================

def start_session(project_id: int = None, session_type: str = 'standard', worker_params: str = None) -> int:
    session_id = execute_insert("""
        INSERT INTO sessions (project_id, session_type, worker_params)
        VALUES (%s, %s, %s)
    """, (project_id, session_type, worker_params))

    if project_id:
        update_project_session(project_id)

    return session_id

def end_session(session_id: int, summary: str = None,
                tasks_completed: List[str] = None, tasks_remaining: List[str] = None):
    execute_query("""
        UPDATE sessions
        SET ended_at = CURRENT_TIMESTAMP, summary = %s,
            tasks_completed = %s, tasks_remaining = %s
        WHERE id = %s
    """, (summary, json.dumps(tasks_completed) if tasks_completed else None,
          json.dumps(tasks_remaining) if tasks_remaining else None, session_id), fetch=False)

# ============================================
# INTELLIGENT SEARCH
# ============================================

def smart_search(query: str, limit_per_table: int = 5) -> Dict[str, List[Dict]]:
    """Search across all knowledge tables."""
    return {
        'tools': search_tools(query, limit_per_table),
        'patterns': search_patterns(query, limit_per_table),
        'learnings': search_learnings(query, limit_per_table),
        'errors': search_errors(query, limit_per_table)
    }

def get_context_for_project(project_id: int) -> Dict[str, Any]:
    """Get all relevant context for a project."""
    return {
        'project': get_project(project_id),
        'tools': list_tools(project_id=project_id),
        'learnings': execute_query("SELECT * FROM learnings WHERE related_project_id = %s ORDER BY created_at DESC LIMIT 20", (project_id,)),
        'commands': get_commands(project_id=project_id),
        'sessions': execute_query("SELECT * FROM sessions WHERE project_id = %s ORDER BY started_at DESC LIMIT 5", (project_id,))
    }

# ============================================
# KNOWLEDGE DETAILS (DRILL-DOWN)
# ============================================

def add_knowledge_detail(parent_type: str, parent_id: int, topic: str, details: str,
                         code_snippets: Dict[str, str] = None, file_paths: List[str] = None,
                         tags: List[str] = None) -> int:
    """Add detailed knowledge linked to a parent (learning, pattern, project)."""
    return execute_insert("""
        INSERT INTO knowledge_details (parent_type, parent_id, topic, details, code_snippets, file_paths, tags)
        VALUES (%s, %s, %s, %s, %s, %s, %s)
    """, (parent_type, parent_id, topic, details,
          json.dumps(code_snippets) if code_snippets else None,
          json.dumps(file_paths) if file_paths else None,
          json.dumps(tags) if tags else None))

def get_knowledge_details(parent_type: str, parent_id: int) -> List[Dict]:
    """Get all knowledge details for a parent item."""
    return execute_query("""
        SELECT * FROM knowledge_details
        WHERE parent_type = %s AND parent_id = %s
        ORDER BY created_at
    """, (parent_type, parent_id))

def search_knowledge_details(query: str, limit: int = 10) -> List[Dict]:
    """Search in knowledge details using full-text search."""
    return execute_query("""
        SELECT * FROM knowledge_details
        WHERE search_vector @@ plainto_tsquery('english', %s)
        ORDER BY ts_rank(search_vector, plainto_tsquery('english', %s)) DESC
        LIMIT %s
    """, (query, query, limit))

def list_topics_for_parent(parent_type: str, parent_id: int) -> List[Dict]:
    """List available topics (drill-down options) for a parent."""
    return execute_query("""
        SELECT id, topic, LEFT(details, 100) as preview, tags
        FROM knowledge_details
        WHERE parent_type = %s AND parent_id = %s
        ORDER BY topic
    """, (parent_type, parent_id))


# ============================================
# PROJECT-SPECIFIC QUERIES
# ============================================

def get_project_learnings(project_name: str, limit: int = 20) -> List[Dict]:
    """Get all learnings linked to a specific project."""
    project = get_project(project_name)
    if not project:
        return []
    return execute_query("""
        SELECT * FROM learnings
        WHERE related_project_id = %s
        ORDER BY created_at DESC
        LIMIT %s
    """, (project['id'], limit))

def get_project_sessions(project_name: str, limit: int = 10) -> List[Dict]:
    """Get session history for a project."""
    project = get_project(project_name)
    if not project:
        return []
    return execute_query("""
        SELECT * FROM sessions
        WHERE project_id = %s
        ORDER BY started_at DESC
        LIMIT %s
    """, (project['id'], limit))


# ============================================
# STATS
# ============================================

def get_memory_stats() -> Dict[str, int]:
    """Get overview statistics."""
    result = execute_query("SELECT * FROM v_memory_stats")
    return result[0] if result else {}


# ============================================
# DB MCP UTILITIES (INTROSPECTION & MIGRATIONS)
# ============================================

def describe_schema() -> Dict[str, Any]:
    """Return tables, columns, and indexes for the public schema."""
    tables = execute_query("""
        SELECT table_name
        FROM information_schema.tables
        WHERE table_schema = 'public'
        ORDER BY table_name
    """)

    schema: Dict[str, Any] = {}
    for t in tables:
        name = t['table_name']
        columns = execute_query("""
            SELECT column_name, data_type, is_nullable
            FROM information_schema.columns
            WHERE table_schema = 'public' AND table_name = %s
            ORDER BY ordinal_position
        """, (name,))
        schema[name] = {
            'columns': columns
        }
    return schema


def select_query(sql: str, params: tuple = None) -> Any:
    """Execute a read-only SELECT query."""
    sql_lower = sql.strip().lower()
    if not sql_lower.startswith('select'):
        raise ValueError('Only SELECT queries are allowed')
    return execute_query(sql, params)


def execute_write(sql: str, params: tuple = None) -> int:
    """Execute an UPDATE, INSERT, or DELETE query. Returns affected row count."""
    sql_upper = sql.strip().upper()
    if not (sql_upper.startswith('UPDATE') or sql_upper.startswith('INSERT') or sql_upper.startswith('DELETE')):
        raise ValueError('Only UPDATE, INSERT, DELETE queries are allowed')

    conn = get_connection()
    try:
        with conn.cursor() as cur:
            cur.execute(sql, params)
            affected = cur.rowcount
            conn.commit()
            return affected
    finally:
        conn.close()


# ============================================
# SCOPED MIGRATIONS (WHITELISTED TABLES ONLY)
# ============================================

ALLOWED_MIGRATION_TABLES = {
    "learnings",
    "patterns",
    "errors_solutions",
    "knowledge_details",
    "tools",
    "commands",
    "projects",
    "sessions",
    "user_preferences",
    "memory_meta",
    "memory_associations",
}


def _assert_scoped_tables(tables: list[str], sql: str):
    if not tables:
        raise ValueError("At least one table must be declared for scoped migration")

    for t in tables:
        if t not in ALLOWED_MIGRATION_TABLES:
            raise ValueError(f"Table '{t}' is not allowed for migrations")

    sql_lower = sql.lower()
    forbidden = [
        'drop database',
        'truncate',
        'alter system',
        'create extension',
        'drop extension',
    ]
    for word in forbidden:
        if word in sql_lower:
            raise ValueError(f"Forbidden statement detected: {word}")

    # naive but effective guard: ensure SQL mentions only declared tables
    for token in ["alter table", "create table", "drop table"]:
        if token in sql_lower:
            for part in sql_lower.split(token)[1:]:
                name = part.strip().split()[0]
                if name not in tables:
                    raise ValueError(f"SQL touches undeclared table: {name}")


def execute_scoped_migration(name: str, tables: list[str], sql: str) -> Dict[str, Any]:
    """Execute a migration restricted to an explicit whitelist of tables."""
    _assert_scoped_tables(tables, sql)

    conn = get_connection()
    try:
        with conn.cursor() as cur:
            cur.execute(sql)
            conn.commit()
        return {
            'migration': name,
            'tables': tables,
            'status': 'applied'
        }
    finally:
        conn.close()


if __name__ == '__main__':
    print("Claude Memory PostgreSQL - Connection Test")
    print("=" * 45)
    try:
        stats = get_memory_stats()
        print("Memory contents:")
        for table, count in stats.items():
            print(f"  {table:20} : {count:>5}")
        print("\nConnection OK!")
    except Exception as e:
        print(f"Error: {e}")
