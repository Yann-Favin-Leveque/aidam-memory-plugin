#!/usr/bin/env python3
"""
Claude Memory MCP Server
========================
MCP (Model Context Protocol) server exposing Claude's PostgreSQL memory system.

All read tools support automatic response truncation to save context window:
- max_chars: Max response chars (default: 4000, 0=unlimited)
- offset: Character offset for pagination
- filter: Only keep items containing this text (case-insensitive)
"""

import json
import asyncio
import hashlib
import os
import subprocess
import time
from typing import Any
from mcp.server import Server
from mcp.server.stdio import stdio_server
from mcp.types import Tool, TextContent

# Import existing memory functions
import memory_pg as mem

# Create server instance
server = Server("claude-memory")

# ============================================
# RESPONSE FORMATTING WITH TRUNCATION
# ============================================

DEFAULT_MAX_CHARS = 4000  # Default truncation limit for responses


def json_serializer(obj: Any) -> Any:
    """Custom JSON serializer for datetime and other types."""
    from datetime import datetime, date
    if isinstance(obj, (datetime, date)):
        return obj.isoformat()
    if isinstance(obj, dict):
        return {k: json_serializer(v) for k, v in obj.items()}
    if isinstance(obj, list):
        return [json_serializer(i) for i in obj]
    return obj


def format_result(data: Any, max_chars: int = None, offset: int = 0, filter_text: str = None) -> str:
    """Format data as JSON string for MCP response with optional truncation.

    Args:
        data: The data to format
        max_chars: Max characters to return (0=unlimited, None=use DEFAULT_MAX_CHARS)
        offset: Character offset to start from (for pagination)
        filter_text: If set, only include items containing this text
    """
    if max_chars is None:
        max_chars = DEFAULT_MAX_CHARS

    # Apply filter if provided - filter list values in the data dict
    if filter_text and isinstance(data, dict):
        data = _apply_filter(data, filter_text)

    full_json = json.dumps(json_serializer(data), indent=2, ensure_ascii=False)
    total_chars = len(full_json)

    # No truncation needed
    if max_chars == 0 or total_chars <= max_chars:
        return full_json

    # Apply offset + truncation
    if offset > 0:
        sliced = full_json[offset:offset + max_chars]
        return (
            f"[PAGINATED: showing chars {offset}-{offset + len(sliced)} of {total_chars}. "
            f"Use offset={offset + max_chars} for next page]\n"
            f"{sliced}"
        )
    else:
        sliced = full_json[:max_chars]
        return (
            f"{sliced}\n\n"
            f"[TRUNCATED: showing {max_chars}/{total_chars} chars. "
            f"Use max_chars=0 for full, or offset={max_chars} for next page, "
            f"or filter=\"keyword\" to narrow results]"
        )


def _apply_filter(data: dict, filter_text: str) -> dict:
    """Filter list values in a dict, keeping only items that contain filter_text."""
    ft = filter_text.lower()
    filtered = {}
    for key, value in data.items():
        if isinstance(value, list):
            filtered[key] = [
                item for item in value
                if ft in json.dumps(json_serializer(item), ensure_ascii=False).lower()
            ]
        else:
            filtered[key] = value
    # Update count fields if present
    if "count" in filtered:
        for key, value in filtered.items():
            if isinstance(value, list) and key != "count":
                filtered["count"] = len(value)
                break
    if "total_found" in filtered:
        filtered["total_found"] = sum(
            len(v) for v in filtered.values() if isinstance(v, list)
        )
    return filtered


def _extract_pagination(args: dict) -> tuple:
    """Extract and remove pagination params from args dict. Returns (max_chars, offset, filter_text)."""
    max_chars = args.pop("max_chars", None)
    offset = args.pop("offset", 0)
    filter_text = args.pop("filter", None)
    return max_chars, offset, filter_text


def _find_deepenable(context: str) -> list[dict]:
    """Find knowledge_details parents that have drill-downs and are related to the context.

    Does a quick FTS query on knowledge_details to find parents with available
    detailed information. Returns a list of {parent_type, parent_id, parent_name, topics}
    for items that can be deepened.
    """
    # Build search terms from context (take first 5 meaningful words)
    words = [w for w in context.split() if len(w) > 3][:8]
    if not words:
        return []

    search_query = " | ".join(words)

    try:
        rows = mem.select_query("""
            SELECT DISTINCT kd.parent_type, kd.parent_id,
                   CASE
                     WHEN kd.parent_type = 'learning' THEN (SELECT topic FROM learnings WHERE id = kd.parent_id)
                     WHEN kd.parent_type = 'pattern' THEN (SELECT name FROM patterns WHERE id = kd.parent_id)
                     WHEN kd.parent_type = 'project' THEN (SELECT name FROM projects WHERE id = kd.parent_id)
                   END as parent_name,
                   array_agg(DISTINCT kd.topic) as topics
            FROM knowledge_details kd
            WHERE kd.search_vector @@ to_tsquery('english', %s)
            GROUP BY kd.parent_type, kd.parent_id
            LIMIT 5
        """, (search_query,))
    except Exception:
        # FTS query might fail with special chars, try simpler approach
        try:
            rows = mem.select_query("""
                SELECT DISTINCT kd.parent_type, kd.parent_id,
                       CASE
                         WHEN kd.parent_type = 'learning' THEN (SELECT topic FROM learnings WHERE id = kd.parent_id)
                         WHEN kd.parent_type = 'pattern' THEN (SELECT name FROM patterns WHERE id = kd.parent_id)
                         WHEN kd.parent_type = 'project' THEN (SELECT name FROM projects WHERE id = kd.parent_id)
                       END as parent_name,
                       array_agg(DISTINCT kd.topic) as topics
                FROM knowledge_details kd
                WHERE kd.details ILIKE %s OR kd.topic ILIKE %s
                GROUP BY kd.parent_type, kd.parent_id
                LIMIT 5
            """, (f"%{words[0]}%", f"%{words[0]}%"))
        except Exception:
            return []

    return [
        {
            "parent_type": r["parent_type"],
            "parent_id": r["parent_id"],
            "parent_name": r.get("parent_name", ""),
            "topics": r.get("topics", [])
        }
        for r in rows if r.get("parent_name")
    ]


# ============================================
# COMMON PAGINATION PROPERTIES (added to read tools)
# ============================================

PAGINATION_PROPERTIES = {
    "max_chars": {
        "type": "integer",
        "description": "Max response chars (default: 4000, 0=unlimited). Truncates large responses to save context.",
        "default": 4000
    },
    "offset": {
        "type": "integer",
        "description": "Character offset for pagination (use with max_chars to page through results).",
        "default": 0
    },
    "filter": {
        "type": "string",
        "description": "Filter results: only keep items containing this text (case-insensitive)."
    }
}


def _with_pagination(properties: dict) -> dict:
    """Merge pagination properties into a tool's properties."""
    return {**properties, **PAGINATION_PROPERTIES}


# ============================================
# TOOL DEFINITIONS
# ============================================

# Set of tools that are "write" operations (no pagination needed)
WRITE_TOOLS = {
    "memory_save_learning", "memory_save_error", "memory_save_pattern",
    "memory_log_session", "memory_add_project", "memory_drilldown_save",
    "memory_index_upsert",
    "db.execute_migration_scoped", "db_execute",
    "aidam_use_tool", "aidam_retrieve", "aidam_learn", "aidam_smart_compact", "aidam_create_tool"
}


@server.list_tools()
async def list_tools() -> list[Tool]:
    """List available memory tools."""
    return [
        Tool(
            name="memory_search",
            description="Search across all memory tables (tools, patterns, learnings, errors). Uses PostgreSQL full-text search.",
            inputSchema={
                "type": "object",
                "properties": _with_pagination({
                    "query": {
                        "type": "string",
                        "description": "Search query (keywords, error message, topic, etc.)"
                    },
                    "limit": {
                        "type": "integer",
                        "description": "Max results per table (default: 5)",
                        "default": 5
                    }
                }),
                "required": ["query"]
            }
        ),
        Tool(
            name="memory_get_project",
            description="Get project details and full context (tools, learnings, commands, recent sessions).",
            inputSchema={
                "type": "object",
                "properties": _with_pagination({
                    "project": {
                        "type": "string",
                        "description": "Project name or ID"
                    }
                }),
                "required": ["project"]
            }
        ),
        Tool(
            name="memory_list_projects",
            description="List all projects in memory.",
            inputSchema={
                "type": "object",
                "properties": _with_pagination({
                    "status": {
                        "type": "string",
                        "description": "Filter by status (active, paused, completed, archived). Empty for all.",
                        "enum": ["active", "paused", "completed", "archived", ""]
                    }
                })
            }
        ),
        Tool(
            name="memory_save_learning",
            description="Save a new learning/insight to memory.",
            inputSchema={
                "type": "object",
                "properties": {
                    "topic": {
                        "type": "string",
                        "description": "Short topic title"
                    },
                    "insight": {
                        "type": "string",
                        "description": "The learning/insight content"
                    },
                    "category": {
                        "type": "string",
                        "description": "Category: bug-fix, performance, security, config, api, gotcha",
                        "enum": ["bug-fix", "performance", "security", "config", "api", "gotcha", "architecture", "tooling"]
                    },
                    "context": {
                        "type": "string",
                        "description": "Additional context (when this applies, etc.)"
                    },
                    "tags": {
                        "type": "array",
                        "items": {"type": "string"},
                        "description": "Tags for categorization"
                    },
                    "project_name": {
                        "type": "string",
                        "description": "Related project name (optional)"
                    },
                    "confidence": {
                        "type": "string",
                        "description": "Confidence level",
                        "enum": ["confirmed", "likely", "uncertain"],
                        "default": "confirmed"
                    }
                },
                "required": ["topic", "insight"]
            }
        ),
        Tool(
            name="memory_save_error",
            description="Save an error and its solution to memory.",
            inputSchema={
                "type": "object",
                "properties": {
                    "error_signature": {
                        "type": "string",
                        "description": "Unique error identifier (e.g., 'NullPointerException in UserService.save')"
                    },
                    "solution": {
                        "type": "string",
                        "description": "How to fix this error"
                    },
                    "error_message": {
                        "type": "string",
                        "description": "Full error message"
                    },
                    "root_cause": {
                        "type": "string",
                        "description": "Why this error occurs"
                    },
                    "prevention": {
                        "type": "string",
                        "description": "How to prevent this error"
                    },
                    "tags": {
                        "type": "array",
                        "items": {"type": "string"},
                        "description": "Tags for categorization"
                    },
                    "project_name": {
                        "type": "string",
                        "description": "Related project name (optional)"
                    }
                },
                "required": ["error_signature", "solution"]
            }
        ),
        Tool(
            name="memory_save_pattern",
            description="Save a reusable code pattern to memory.",
            inputSchema={
                "type": "object",
                "properties": {
                    "name": {
                        "type": "string",
                        "description": "Pattern name"
                    },
                    "category": {
                        "type": "string",
                        "description": "Category",
                        "enum": ["architecture", "algorithm", "design-pattern", "workaround", "config", "testing"]
                    },
                    "problem": {
                        "type": "string",
                        "description": "What problem does this pattern solve"
                    },
                    "solution": {
                        "type": "string",
                        "description": "How the pattern solves it"
                    },
                    "context": {
                        "type": "string",
                        "description": "When to apply this pattern"
                    },
                    "code_example": {
                        "type": "string",
                        "description": "Example code"
                    },
                    "language": {
                        "type": "string",
                        "description": "Programming language"
                    },
                    "tags": {
                        "type": "array",
                        "items": {"type": "string"},
                        "description": "Tags"
                    },
                    "confidence": {
                        "type": "string",
                        "enum": ["proven", "tested", "theoretical"],
                        "default": "proven"
                    }
                },
                "required": ["name", "category", "problem", "solution"]
            }
        ),
        Tool(
            name="memory_log_session",
            description="Log a work session to memory.",
            inputSchema={
                "type": "object",
                "properties": {
                    "project_name": {
                        "type": "string",
                        "description": "Project name (optional)"
                    },
                    "session_type": {
                        "type": "string",
                        "description": "Session type",
                        "enum": ["standard", "orchestrator", "worker"],
                        "default": "standard"
                    },
                    "summary": {
                        "type": "string",
                        "description": "What was done in this session"
                    },
                    "tasks_completed": {
                        "type": "array",
                        "items": {"type": "string"},
                        "description": "List of completed tasks"
                    },
                    "tasks_remaining": {
                        "type": "array",
                        "items": {"type": "string"},
                        "description": "List of remaining tasks"
                    }
                },
                "required": ["summary"]
            }
        ),
        Tool(
            name="memory_get_stats",
            description="Get memory statistics (count of items per table).",
            inputSchema={
                "type": "object",
                "properties": {}
            }
        ),
        Tool(
            name="memory_get_preferences",
            description="Get user preferences by category.",
            inputSchema={
                "type": "object",
                "properties": _with_pagination({
                    "category": {
                        "type": "string",
                        "description": "Preference category",
                        "enum": ["coding-style", "naming", "architecture", "workflow", "environment", "personal"]
                    },
                    "project_name": {
                        "type": "string",
                        "description": "Project name for project-specific preferences (optional)"
                    }
                }),
                "required": ["category"]
            }
        ),
        Tool(
            name="memory_search_errors",
            description="Search specifically in errors/solutions table.",
            inputSchema={
                "type": "object",
                "properties": _with_pagination({
                    "query": {
                        "type": "string",
                        "description": "Error message or keywords to search"
                    },
                    "limit": {
                        "type": "integer",
                        "description": "Max results (default: 10)",
                        "default": 10
                    }
                }),
                "required": ["query"]
            }
        ),
        Tool(
            name="memory_search_patterns",
            description="Search specifically in patterns table.",
            inputSchema={
                "type": "object",
                "properties": _with_pagination({
                    "query": {
                        "type": "string",
                        "description": "Pattern name or problem to search"
                    },
                    "limit": {
                        "type": "integer",
                        "description": "Max results (default: 10)",
                        "default": 10
                    }
                }),
                "required": ["query"]
            }
        ),
        Tool(
            name="memory_add_project",
            description="Add a new project to memory.",
            inputSchema={
                "type": "object",
                "properties": {
                    "name": {
                        "type": "string",
                        "description": "Project name (unique)"
                    },
                    "path": {
                        "type": "string",
                        "description": "Project path on filesystem"
                    },
                    "description": {
                        "type": "string",
                        "description": "Project description"
                    },
                    "stack": {
                        "type": "array",
                        "items": {"type": "string"},
                        "description": "Technology stack (e.g., ['spring-boot', 'postgresql', 'react'])"
                    },
                    "git_repo": {
                        "type": "string",
                        "description": "Git repository URL"
                    }
                },
                "required": ["name", "path"]
            }
        ),
        Tool(
            name="memory_get_recent_learnings",
            description="Get the most recent learnings.",
            inputSchema={
                "type": "object",
                "properties": _with_pagination({
                    "limit": {
                        "type": "integer",
                        "description": "Max results (default: 20)",
                        "default": 20
                    }
                })
            }
        ),
        # ============================================
        # DRILL-DOWN TOOLS
        # ============================================
        Tool(
            name="memory_drilldown_list",
            description="List available drill-down topics for a parent item (learning, pattern, or project). Use this to see what detailed information is available.",
            inputSchema={
                "type": "object",
                "properties": _with_pagination({
                    "parent_type": {
                        "type": "string",
                        "description": "Type of parent item",
                        "enum": ["learning", "pattern", "project"]
                    },
                    "parent_id": {
                        "type": "integer",
                        "description": "ID of the parent item"
                    }
                }),
                "required": ["parent_type", "parent_id"]
            }
        ),
        Tool(
            name="memory_drilldown_get",
            description="Get detailed knowledge for a parent item. Returns full details, code snippets, and file paths.",
            inputSchema={
                "type": "object",
                "properties": _with_pagination({
                    "parent_type": {
                        "type": "string",
                        "description": "Type of parent item",
                        "enum": ["learning", "pattern", "project"]
                    },
                    "parent_id": {
                        "type": "integer",
                        "description": "ID of the parent item"
                    }
                }),
                "required": ["parent_type", "parent_id"]
            }
        ),
        Tool(
            name="memory_drilldown_save",
            description="Save detailed knowledge linked to a parent item (learning, pattern, or project). Use for architecture details, code snippets, file paths, complex workflows.",
            inputSchema={
                "type": "object",
                "properties": {
                    "parent_type": {
                        "type": "string",
                        "description": "Type of parent item",
                        "enum": ["learning", "pattern", "project"]
                    },
                    "parent_id": {
                        "type": "integer",
                        "description": "ID of the parent item"
                    },
                    "topic": {
                        "type": "string",
                        "description": "Sub-topic title for this detail"
                    },
                    "details": {
                        "type": "string",
                        "description": "Detailed content"
                    },
                    "code_snippets": {
                        "type": "object",
                        "description": "Code snippets as key-value pairs (name: code)"
                    },
                    "file_paths": {
                        "type": "array",
                        "items": {"type": "string"},
                        "description": "Related file paths"
                    },
                    "tags": {
                        "type": "array",
                        "items": {"type": "string"},
                        "description": "Tags for categorization"
                    }
                },
                "required": ["parent_type", "parent_id", "topic", "details"]
            }
        ),
        Tool(
            name="memory_drilldown_search",
            description="Search in knowledge details across all parents. Returns detailed information matching the query.",
            inputSchema={
                "type": "object",
                "properties": _with_pagination({
                    "query": {
                        "type": "string",
                        "description": "Search query"
                    },
                    "limit": {
                        "type": "integer",
                        "description": "Max results (default: 10)",
                        "default": 10
                    }
                }),
                "required": ["query"]
            }
        ),
        # ============================================
        # KNOWLEDGE INDEX TOOLS
        # ============================================
        Tool(
            name="memory_index_search",
            description="Full-text search in the knowledge index. Returns matching entries with domain, title, summary, and relevance rank.",
            inputSchema={
                "type": "object",
                "properties": _with_pagination({
                    "query": {
                        "type": "string",
                        "description": "Search query (keywords)"
                    },
                    "limit": {
                        "type": "integer",
                        "description": "Max results (default: 20)",
                        "default": 20
                    }
                }),
                "required": ["query"]
            }
        ),
        Tool(
            name="memory_index_domains",
            description="List knowledge domains with entry counts and sample titles. Optionally filter by a search query.",
            inputSchema={
                "type": "object",
                "properties": _with_pagination({
                    "query": {
                        "type": "string",
                        "description": "Optional search query to filter domains"
                    }
                })
            }
        ),
        Tool(
            name="memory_index_upsert",
            description="Upsert an entry in the knowledge index. Creates or updates based on (source_table, source_id) unique constraint.",
            inputSchema={
                "type": "object",
                "properties": {
                    "source_table": {
                        "type": "string",
                        "description": "Source table name (e.g., 'learnings', 'patterns')"
                    },
                    "source_id": {
                        "type": "integer",
                        "description": "ID of the source row"
                    },
                    "domain": {
                        "type": "string",
                        "description": "Knowledge domain (e.g., 'physics', 'programming', 'architecture')"
                    },
                    "title": {
                        "type": "string",
                        "description": "Short title for the index entry"
                    },
                    "summary": {
                        "type": "string",
                        "description": "Summary text (used for full-text search)"
                    },
                    "tags": {
                        "type": "array",
                        "items": {"type": "string"},
                        "description": "Tags for categorization (optional)"
                    }
                },
                "required": ["source_table", "source_id", "domain", "title", "summary"]
            }
        ),
        # ============================================
        # PROJECT-SPECIFIC TOOLS
        # ============================================
        Tool(
            name="memory_get_project_learnings",
            description="Get all learnings linked to a specific project. Use this to see what was learned while working on a project.",
            inputSchema={
                "type": "object",
                "properties": _with_pagination({
                    "project_name": {
                        "type": "string",
                        "description": "Project name (case-insensitive)"
                    },
                    "limit": {
                        "type": "integer",
                        "description": "Max results (default: 20)",
                        "default": 20
                    }
                }),
                "required": ["project_name"]
            }
        ),
        Tool(
            name="memory_get_sessions",
            description="Get session history for a project. Shows past work sessions with summaries and tasks.",
            inputSchema={
                "type": "object",
                "properties": _with_pagination({
                    "project_name": {
                        "type": "string",
                        "description": "Project name (case-insensitive)"
                    },
                    "limit": {
                        "type": "integer",
                        "description": "Max sessions to return (default: 10)",
                        "default": 10
                    }
                }),
                "required": ["project_name"]
            }
        ),
        # ============================================
        # AIDAM ORCHESTRATOR TOOLS
        # ============================================
        Tool(
            name="aidam_use_tool",
            description="Execute a generated tool (script) by name. Scripts are stored in ~/.claude/generated_tools/. "
                        "To discover available tools, use aidam_retrieve — it searches generated tools alongside learnings/patterns.",
            inputSchema={
                "type": "object",
                "properties": {
                    "name": {
                        "type": "string",
                        "description": "Tool name (must match a generated_tools entry)"
                    },
                    "args": {
                        "type": "string",
                        "description": "Arguments to pass to the script (optional)"
                    }
                },
                "required": ["name"]
            }
        ),
        Tool(
            name="aidam_retrieve",
            description="Trigger memory retrieval for a given context. Sends context to the dual Retriever agents (keyword + project) and returns merged results. Use when you need to search memory for relevant knowledge.",
            inputSchema={
                "type": "object",
                "properties": {
                    "context": {
                        "type": "string",
                        "description": "The context/question to search memory for (recent conversation, question, task description)"
                    }
                },
                "required": ["context"]
            }
        ),
        Tool(
            name="aidam_learn",
            description="Trigger the Learner agent to process observations. Fire-and-forget: sends context to the Learner for async knowledge extraction. Returns immediately.",
            inputSchema={
                "type": "object",
                "properties": {
                    "context": {
                        "type": "string",
                        "description": "Observations, reasoning, tool results to learn from"
                    }
                },
                "required": ["context"]
            }
        ),
        Tool(
            name="aidam_smart_compact",
            description="Check compaction status or force a new compaction. Returns latest session state info. Use force_summary=true to trigger immediate compaction (takes ~10-30s).",
            inputSchema={
                "type": "object",
                "properties": {
                    "force_summary": {
                        "type": "boolean",
                        "description": "If true, trigger immediate compaction and wait for result (default: false)",
                        "default": False
                    }
                }
            }
        ),
        Tool(
            name="aidam_usage",
            description="Get AIDAM agent usage and cost breakdown for the current session. Shows per-agent invocation counts, costs, and session budget.",
            inputSchema={
                "type": "object",
                "properties": _with_pagination({})
            }
        ),
        Tool(
            name="aidam_deepen",
            description="Retrieve detailed knowledge (drill-downs) for specific learnings, patterns, or projects. Use after aidam_retrieve when the results mention topics with available details. Returns code snippets, file paths, and implementation details.",
            inputSchema={
                "type": "object",
                "properties": {
                    "items": {
                        "type": "array",
                        "items": {
                            "type": "object",
                            "properties": {
                                "parent_type": {
                                    "type": "string",
                                    "enum": ["learning", "pattern", "project"],
                                    "description": "Type of the parent item"
                                },
                                "parent_id": {
                                    "type": "integer",
                                    "description": "ID of the parent item"
                                }
                            },
                            "required": ["parent_type", "parent_id"]
                        },
                        "description": "List of items to deepen (max 5)"
                    }
                },
                "required": ["items"]
            }
        ),
        Tool(
            name="aidam_create_tool",
            description="Register a generated tool (script) in the database and index it for retrieval. "
                        "The script file must already exist at the given path under ~/.claude/generated_tools/. "
                        "After registration, the tool is discoverable via aidam_retrieve and executable via aidam_use_tool.",
            inputSchema={
                "type": "object",
                "properties": {
                    "name": {
                        "type": "string",
                        "description": "Unique tool name (lowercase, hyphens ok, e.g. 'maven-compile-trade-bot')"
                    },
                    "description": {
                        "type": "string",
                        "description": "What the tool does (1-2 sentences)"
                    },
                    "file_path": {
                        "type": "string",
                        "description": "Path to the script file (relative to ~/.claude/generated_tools/ or absolute)"
                    },
                    "language": {
                        "type": "string",
                        "enum": ["bash", "python", "javascript"],
                        "description": "Script language (default: bash)",
                        "default": "bash"
                    },
                    "tags": {
                        "type": "array",
                        "items": {"type": "string"},
                        "description": "Searchable tags (e.g. ['maven', 'spring-boot', 'trade-bot'])"
                    }
                },
                "required": ["name", "description", "file_path"]
            }
        ),
        # ============================================
        # DB MCP TOOLS
        # ============================================
        Tool(
            name="db.describe_schema",
            description="Describe PostgreSQL public schema (tables and columns).",
            inputSchema={
                "type": "object",
                "properties": _with_pagination({})
            }
        ),
        Tool(
            name="db.select",
            description="Execute a read-only SELECT query on the memory database.",
            inputSchema={
                "type": "object",
                "properties": _with_pagination({
                    "sql": {"type": "string"},
                    "params": {"type": "array"}
                }),
                "required": ["sql"]
            }
        ),
        Tool(
            name="db.execute_migration_scoped",
            description="Execute a migration restricted to an explicit whitelist of tables.",
            inputSchema={
                "type": "object",
                "properties": {
                    "name": {"type": "string"},
                    "tables": {"type": "array", "items": {"type": "string"}},
                    "sql": {"type": "string"}
                },
                "required": ["name", "tables", "sql"]
            }
        ),
        Tool(
            name="db_execute",
            description="Execute UPDATE, INSERT, or DELETE on memory tables. Restricted to safe tables: projects, learnings, errors_solutions, patterns, sessions, user_preferences, knowledge_details, knowledge_index, memory_meta. Returns affected row count.",
            inputSchema={
                "type": "object",
                "properties": {
                    "sql": {
                        "type": "string",
                        "description": "SQL statement (UPDATE/INSERT/DELETE only)"
                    },
                    "params": {
                        "type": "array",
                        "description": "Query parameters (optional)"
                    }
                },
                "required": ["sql"]
            }
        )
    ]


# ============================================
# TOOL HANDLERS
# ============================================

def get_project_id(project_name: str) -> int | None:
    """Get project ID from name."""
    if not project_name:
        return None
    project = mem.get_project(project_name)
    return project['id'] if project else None


@server.call_tool()
async def call_tool(name: str, arguments: dict) -> list[TextContent]:
    """Handle tool calls."""
    try:
        result = await handle_tool(name, arguments)
        return [TextContent(type="text", text=result)]
    except Exception as e:
        return [TextContent(type="text", text=f"Error: {str(e)}")]


async def handle_tool(name: str, args: dict) -> str:
    """Route tool calls to appropriate handlers."""

    # Extract pagination params for read tools (mutates args dict to remove them)
    if name not in WRITE_TOOLS:
        max_chars, offset, filter_text = _extract_pagination(args)
    else:
        max_chars, offset, filter_text = 0, 0, None  # No truncation for writes

    if name == "memory_search":
        query = args["query"]
        limit = args.get("limit", 5)
        results = mem.smart_search(query, limit)
        return format_result({
            "query": query,
            "results": results,
            "total_found": sum(len(v) for v in results.values())
        }, max_chars, offset, filter_text)

    elif name == "memory_get_project":
        project = args["project"]
        if project.isdigit():
            proj = mem.get_project(int(project))
        else:
            proj = mem.get_project(project)

        if not proj:
            return format_result({"error": f"Project '{project}' not found"})

        context = mem.get_context_for_project(proj['id'])
        return format_result(context, max_chars, offset, filter_text)

    elif name == "memory_list_projects":
        status = args.get("status", "active")
        if status == "":
            status = None
        projects = mem.list_projects(status)
        return format_result({"projects": projects, "count": len(projects)}, max_chars, offset, filter_text)

    elif name == "memory_save_learning":
        project_id = get_project_id(args.get("project_name"))
        new_id = mem.add_learning(
            topic=args["topic"],
            insight=args["insight"],
            category=args.get("category"),
            context=args.get("context"),
            tags=args.get("tags"),
            source="mcp-session",
            project_id=project_id,
            confidence=args.get("confidence", "confirmed")
        )
        return format_result({"success": True, "id": new_id, "message": f"Learning saved with ID {new_id}"})

    elif name == "memory_save_error":
        project_id = get_project_id(args.get("project_name"))
        new_id = mem.add_error_solution(
            error_signature=args["error_signature"],
            solution=args["solution"],
            error_message=args.get("error_message"),
            root_cause=args.get("root_cause"),
            prevention=args.get("prevention"),
            tags=args.get("tags"),
            project_id=project_id
        )
        return format_result({"success": True, "id": new_id, "message": f"Error/solution saved with ID {new_id}"})

    elif name == "memory_save_pattern":
        new_id = mem.add_pattern(
            name=args["name"],
            category=args["category"],
            problem=args["problem"],
            solution=args["solution"],
            context=args.get("context"),
            code_example=args.get("code_example"),
            language=args.get("language"),
            tags=args.get("tags"),
            source="mcp-session",
            confidence=args.get("confidence", "proven")
        )
        return format_result({"success": True, "id": new_id, "message": f"Pattern saved with ID {new_id}"})

    elif name == "memory_log_session":
        project_id = get_project_id(args.get("project_name"))
        session_id = mem.start_session(
            project_id=project_id,
            session_type=args.get("session_type", "standard")
        )
        mem.end_session(
            session_id=session_id,
            summary=args["summary"],
            tasks_completed=args.get("tasks_completed"),
            tasks_remaining=args.get("tasks_remaining")
        )
        return format_result({"success": True, "session_id": session_id, "message": f"Session logged with ID {session_id}"})

    elif name == "memory_get_stats":
        stats = mem.get_memory_stats()
        return format_result({"stats": stats}, max_chars, offset, filter_text)

    elif name == "memory_get_preferences":
        category = args["category"]
        project_id = get_project_id(args.get("project_name"))
        prefs = mem.get_preferences_by_category(category, project_id)
        return format_result({"category": category, "preferences": prefs}, max_chars, offset, filter_text)

    elif name == "memory_search_errors":
        query = args["query"]
        limit = args.get("limit", 10)
        results = mem.search_errors(query, limit)
        return format_result({"query": query, "errors": results, "count": len(results)}, max_chars, offset, filter_text)

    elif name == "memory_search_patterns":
        query = args["query"]
        limit = args.get("limit", 10)
        results = mem.search_patterns(query, limit)
        return format_result({"query": query, "patterns": results, "count": len(results)}, max_chars, offset, filter_text)

    elif name == "memory_add_project":
        new_id = mem.add_project(
            name=args["name"],
            path=args["path"],
            description=args.get("description"),
            stack=args.get("stack"),
            git_repo=args.get("git_repo")
        )
        return format_result({"success": True, "id": new_id, "message": f"Project '{args['name']}' created with ID {new_id}"})

    elif name == "memory_get_recent_learnings":
        limit = args.get("limit", 20)
        learnings = mem.get_recent_learnings(limit)
        return format_result({"learnings": learnings, "count": len(learnings)}, max_chars, offset, filter_text)

    # ============================================
    # DRILL-DOWN HANDLERS
    # ============================================
    elif name == "memory_drilldown_list":
        parent_type = args["parent_type"]
        parent_id = args["parent_id"]
        topics = mem.list_topics_for_parent(parent_type, parent_id)
        return format_result({
            "parent_type": parent_type,
            "parent_id": parent_id,
            "topics": topics,
            "count": len(topics)
        }, max_chars, offset, filter_text)

    elif name == "memory_drilldown_get":
        parent_type = args["parent_type"]
        parent_id = args["parent_id"]
        details = mem.get_knowledge_details(parent_type, parent_id)
        return format_result({
            "parent_type": parent_type,
            "parent_id": parent_id,
            "details": details,
            "count": len(details)
        }, max_chars, offset, filter_text)

    elif name == "memory_drilldown_save":
        new_id = mem.add_knowledge_detail(
            parent_type=args["parent_type"],
            parent_id=args["parent_id"],
            topic=args["topic"],
            details=args["details"],
            code_snippets=args.get("code_snippets"),
            file_paths=args.get("file_paths"),
            tags=args.get("tags")
        )
        return format_result({
            "success": True,
            "id": new_id,
            "message": f"Knowledge detail saved with ID {new_id}"
        })

    elif name == "memory_drilldown_search":
        query = args["query"]
        limit = args.get("limit", 10)
        results = mem.search_knowledge_details(query, limit)
        return format_result({
            "query": query,
            "details": results,
            "count": len(results)
        }, max_chars, offset, filter_text)

    # ============================================
    # KNOWLEDGE INDEX HANDLERS
    # ============================================
    elif name == "memory_index_search":
        query = args["query"]
        limit = args.get("limit", 20)
        results = mem.search_knowledge_index(query, limit)
        return format_result({
            "query": query,
            "results": results,
            "count": len(results)
        }, max_chars, offset, filter_text)

    elif name == "memory_index_domains":
        query = args.get("query")
        domains = mem.get_knowledge_domains(query)
        return format_result({
            "query": query,
            "domains": domains,
            "count": len(domains)
        }, max_chars, offset, filter_text)

    elif name == "memory_index_upsert":
        mem.upsert_knowledge_index(
            source_table=args["source_table"],
            source_id=args["source_id"],
            domain=args["domain"],
            title=args["title"],
            summary=args["summary"],
            tags=args.get("tags")
        )
        return format_result({
            "success": True,
            "message": f"Knowledge index entry upserted for {args['source_table']}#{args['source_id']}"
        })

    # ============================================
    # PROJECT-SPECIFIC HANDLERS
    # ============================================
    elif name == "memory_get_project_learnings":
        project_name = args["project_name"]
        limit = args.get("limit", 20)
        learnings = mem.get_project_learnings(project_name, limit)
        return format_result({
            "project": project_name,
            "learnings": learnings,
            "count": len(learnings)
        }, max_chars, offset, filter_text)

    elif name == "memory_get_sessions":
        project_name = args["project_name"]
        limit = args.get("limit", 10)
        sessions = mem.get_project_sessions(project_name, limit)
        return format_result({
            "project": project_name,
            "sessions": sessions,
            "count": len(sessions)
        }, max_chars, offset, filter_text)

    # ============================================
    # AIDAM ORCHESTRATOR HANDLERS
    # ============================================
    elif name == "aidam_use_tool":
        tool_name = args["name"]
        tool_args = args.get("args", "")

        # Look up tool in DB
        rows = mem.select_query(
            "SELECT file_path, language FROM generated_tools WHERE name = %s AND is_active = TRUE",
            (tool_name,)
        )
        if not rows:
            return format_result({"error": f"Tool '{tool_name}' not found or inactive"})

        file_path = rows[0].get("file_path", "")
        language = rows[0].get("language", "bash")

        # Resolve path: relative paths are under ~/.claude/generated_tools/
        if not os.path.isabs(file_path):
            file_path = os.path.join(os.path.expanduser("~/.claude/generated_tools"), file_path)

        if not os.path.exists(file_path):
            return format_result({"error": f"Script not found: {file_path}"})

        # Security: only allow scripts under ~/.claude/generated_tools/
        allowed_dir = os.path.realpath(os.path.expanduser("~/.claude/generated_tools"))
        real_path = os.path.realpath(file_path)
        if not real_path.startswith(allowed_dir):
            return format_result({"error": f"Security: script must be under {allowed_dir}"})

        # Execute
        try:
            if language == "python":
                cmd = ["C:/Users/user/AppData/Local/Programs/Python/Python312/python.exe", real_path]
            else:
                cmd = ["bash", real_path]
            if tool_args:
                cmd.extend(tool_args.split())

            result = subprocess.run(
                cmd, capture_output=True, text=True, timeout=30,
                cwd=os.path.expanduser("~")
            )

            # Update usage stats
            mem.execute_write(
                "UPDATE generated_tools SET usage_count = usage_count + 1, last_used_at = CURRENT_TIMESTAMP WHERE name = %s",
                (tool_name,)
            )

            return format_result({
                "tool": tool_name,
                "exit_code": result.returncode,
                "stdout": result.stdout[:4000] if result.stdout else "",
                "stderr": result.stderr[:2000] if result.stderr else ""
            })
        except subprocess.TimeoutExpired:
            return format_result({"error": f"Tool '{tool_name}' timed out after 30s"})
        except Exception as e:
            return format_result({"error": f"Execution failed: {str(e)}"})

    elif name == "aidam_retrieve":
        context = args["context"]
        prompt_hash = hashlib.sha256(context.encode('utf-8')).hexdigest()[:16]

        # Find running orchestrator session_id
        rows = mem.select_query(
            "SELECT session_id FROM orchestrator_state WHERE status = 'running' "
            "ORDER BY last_heartbeat_at DESC NULLS LAST LIMIT 1"
        )
        if not rows:
            return format_result({"error": "No running AIDAM orchestrator found. Memory retrieval unavailable."})

        session_id = rows[0]["session_id"]

        # Insert into cognitive_inbox for the Retriever agents
        mem.execute_write(
            "INSERT INTO cognitive_inbox (session_id, message_type, payload, status) "
            "VALUES (%s, 'prompt_context', %s, 'pending')",
            (session_id, json.dumps({
                'prompt': context,
                'prompt_hash': prompt_hash,
                'timestamp': time.time()
            }))
        )

        # Expire old retrieval results
        mem.select_query("SELECT cleanup_expired_retrieval()")

        # Poll retrieval_inbox (up to ~7s, same dual-retriever merge logic as on_prompt_submit.py)
        results_collected = []
        none_count = 0
        second_chance = False
        remaining_polls = 0

        for _ in range(14):
            await asyncio.sleep(0.5)
            rows = mem.select_query(
                "SELECT id, context_type, context_text, relevance_score FROM retrieval_inbox "
                "WHERE session_id = %s AND prompt_hash = %s AND status = 'pending' "
                "AND expires_at > CURRENT_TIMESTAMP ORDER BY created_at ASC",
                (session_id, prompt_hash)
            )

            for row in rows:
                row_id = row["id"]
                ctx_type = row.get("context_type", "")
                ctx_text = row.get("context_text", "")
                mem.execute_write(
                    "UPDATE retrieval_inbox SET status = 'delivered', delivered_at = CURRENT_TIMESTAMP WHERE id = %s",
                    (row_id,)
                )
                if ctx_type == 'none' or not ctx_text:
                    none_count += 1
                else:
                    results_collected.append(ctx_text)

            if none_count >= 2:
                break
            if results_collected and not second_chance:
                second_chance = True
                remaining_polls = 3
            if second_chance:
                remaining_polls -= 1
                if remaining_polls <= 0 or len(results_collected) >= 2:
                    break

        if not results_collected:
            return format_result({"status": "no_results", "message": "No relevant memory found for this context."})

        # Merge results
        if len(results_collected) == 1:
            merged = results_collected[0]
        else:
            merged = results_collected[0]
            for extra in results_collected[1:]:
                extra_clean = extra.replace("=== MEMORY CONTEXT ===", "=== ADDITIONAL CONTEXT ===")
                merged += "\n\n" + extra_clean

        # Check for available drill-downs related to the context
        deepenable = _find_deepenable(context)
        result = {"status": "found", "context": merged}
        if deepenable:
            result["deepenable"] = deepenable
            result["hint"] = "Some results have detailed drill-downs available. Use aidam_deepen(items=[...]) to get code snippets, file paths, and implementation details."
        return format_result(result, 0)  # No truncation for retrieval

    elif name == "aidam_learn":
        context = args["context"]

        # Find running orchestrator session_id
        rows = mem.select_query(
            "SELECT session_id FROM orchestrator_state WHERE status = 'running' "
            "ORDER BY last_heartbeat_at DESC NULLS LAST LIMIT 1"
        )
        if not rows:
            return format_result({"error": "No running AIDAM orchestrator found. Learning unavailable."})

        session_id = rows[0]["session_id"]

        # Insert learn_trigger into cognitive_inbox (fire-and-forget)
        mem.execute_write(
            "INSERT INTO cognitive_inbox (session_id, message_type, payload, status) "
            "VALUES (%s, 'learn_trigger', %s, 'pending')",
            (session_id, json.dumps({
                'context': context,
                'timestamp': time.time()
            }))
        )

        return format_result({"status": "queued", "message": "Learning context sent to Learner agent for processing."})

    elif name == "aidam_create_tool":
        tool_name = args["name"]
        description = args["description"]
        file_path = args["file_path"]
        language = args.get("language", "bash")
        tags = args.get("tags", [])

        # Resolve path: relative paths are under ~/.claude/generated_tools/
        if not os.path.isabs(file_path):
            file_path = os.path.join(os.path.expanduser("~/.claude/generated_tools"), file_path)

        # Security: only allow scripts under ~/.claude/generated_tools/
        allowed_dir = os.path.realpath(os.path.expanduser("~/.claude/generated_tools"))
        real_path = os.path.realpath(file_path)
        if not real_path.startswith(allowed_dir):
            return format_result({"error": f"Security: script must be under {allowed_dir}"})

        if not os.path.exists(real_path):
            return format_result({"error": f"Script file not found: {file_path}. Write the script first, then register it."})

        # Store relative path in DB for portability
        rel_path = os.path.relpath(real_path, os.path.expanduser("~/.claude/generated_tools"))

        # INSERT into generated_tools (upsert on name)
        new_id = mem.execute_insert(
            "INSERT INTO generated_tools (name, description, file_path, language, tags) "
            "VALUES (%s, %s, %s, %s, %s) "
            "ON CONFLICT (name) DO UPDATE SET description=EXCLUDED.description, "
            "file_path=EXCLUDED.file_path, language=EXCLUDED.language, tags=EXCLUDED.tags, "
            "updated_at=CURRENT_TIMESTAMP, is_active=TRUE",
            (tool_name, description, rel_path, language,
             json.dumps(tags) if tags else None)
        )

        # Index in knowledge_index for retrieval
        mem.upsert_knowledge_index(
            source_table='generated_tools',
            source_id=new_id,
            domain='generated-tools',
            title=tool_name,
            summary=description,
            tags=tags
        )

        return format_result({
            "status": "created",
            "id": new_id,
            "name": tool_name,
            "file_path": rel_path,
            "message": f"Tool '{tool_name}' registered and indexed. Use aidam_use_tool(name='{tool_name}') to execute."
        })

    elif name == "aidam_smart_compact":
        force_summary = args.get("force_summary", False)

        # Find running orchestrator
        orch_rows = mem.select_query(
            "SELECT session_id, pid, status, started_at, last_heartbeat_at "
            "FROM orchestrator_state WHERE status = 'running' "
            "ORDER BY last_heartbeat_at DESC NULLS LAST LIMIT 1"
        )
        if not orch_rows:
            return format_result({"error": "No running AIDAM orchestrator found."})

        session_id = orch_rows[0]["session_id"]

        # Get latest session_state
        state_rows = mem.select_query(
            "SELECT version, length(state_text) as state_len, token_estimate, created_at "
            "FROM session_state WHERE session_id = %s ORDER BY version DESC LIMIT 1",
            (session_id,)
        )

        current_state = state_rows[0] if state_rows else None

        if force_summary:
            # Insert compactor_trigger into cognitive_inbox
            mem.execute_write(
                "INSERT INTO cognitive_inbox (session_id, message_type, payload, status) "
                "VALUES (%s, 'compactor_trigger', %s, 'pending')",
                (session_id, json.dumps({'force': True, 'timestamp': time.time()}))
            )

            # Poll for new version (up to 30s)
            old_version = current_state["version"] if current_state else 0
            new_state = None
            for _ in range(30):
                await asyncio.sleep(1)
                rows = mem.select_query(
                    "SELECT version, length(state_text) as state_len, token_estimate, created_at "
                    "FROM session_state WHERE session_id = %s AND version > %s "
                    "ORDER BY version DESC LIMIT 1",
                    (session_id, old_version)
                )
                if rows:
                    new_state = rows[0]
                    break

            if new_state:
                return format_result({
                    "status": "compacted",
                    "old_version": old_version,
                    "new_version": new_state["version"],
                    "state_len": new_state["state_len"],
                    "token_estimate": new_state["token_estimate"],
                    "message": f"Compaction complete. Version {old_version} → {new_state['version']}. Use /clear to apply."
                })
            else:
                return format_result({
                    "status": "timeout",
                    "message": "Compaction triggered but did not complete within 30s. It may still be processing."
                })
        else:
            # Just report status
            return format_result({
                "status": "ok",
                "orchestrator": {
                    "session_id": session_id,
                    "pid": orch_rows[0].get("pid"),
                    "started_at": orch_rows[0].get("started_at"),
                    "last_heartbeat": orch_rows[0].get("last_heartbeat_at")
                },
                "session_state": current_state,
                "message": "Use force_summary=true to trigger compaction, then /clear to apply."
            })

    elif name == "aidam_usage":
        # Find running orchestrator
        orch_rows = mem.select_query(
            "SELECT session_id, pid, status, started_at, last_heartbeat_at "
            "FROM orchestrator_state WHERE status = 'running' "
            "ORDER BY last_heartbeat_at DESC NULLS LAST LIMIT 1"
        )
        if not orch_rows:
            return format_result({"error": "No running AIDAM orchestrator found."})

        session_id = orch_rows[0]["session_id"]

        # Get per-agent usage
        usage_rows = mem.select_query(
            "SELECT agent_name, invocation_count, total_cost_usd, last_cost_usd, "
            "budget_per_call, budget_session, status "
            "FROM agent_usage WHERE session_id = %s ORDER BY agent_name",
            (session_id,)
        )

        total_cost = sum(float(r.get("total_cost_usd", 0) or 0) for r in usage_rows)
        session_budget = float(usage_rows[0].get("budget_session", 5.0) or 5.0) if usage_rows else 5.0

        return format_result({
            "session_id": session_id,
            "orchestrator": {
                "pid": orch_rows[0].get("pid"),
                "started_at": orch_rows[0].get("started_at"),
                "last_heartbeat": orch_rows[0].get("last_heartbeat_at")
            },
            "agents": usage_rows,
            "total_cost_usd": round(total_cost, 4),
            "session_budget_usd": session_budget,
            "budget_remaining_usd": round(session_budget - total_cost, 4)
        }, max_chars, offset, filter_text)

    elif name == "aidam_deepen":
        items = args.get("items", [])
        if not items:
            return format_result({"error": "No items to deepen"})
        if len(items) > 5:
            items = items[:5]

        results = []
        for item in items:
            parent_type = item.get("parent_type", "")
            parent_id = item.get("parent_id", 0)
            if not parent_type or not parent_id:
                continue

            details = mem.get_knowledge_details(parent_type, parent_id)
            if details:
                # Get parent name for context
                parent_name = ""
                if parent_type == "learning":
                    rows = mem.select_query("SELECT topic FROM learnings WHERE id = %s", (parent_id,))
                    parent_name = rows[0]["topic"] if rows else ""
                elif parent_type == "pattern":
                    rows = mem.select_query("SELECT name FROM patterns WHERE id = %s", (parent_id,))
                    parent_name = rows[0]["name"] if rows else ""
                elif parent_type == "project":
                    rows = mem.select_query("SELECT name FROM projects WHERE id = %s", (parent_id,))
                    parent_name = rows[0]["name"] if rows else ""

                results.append({
                    "parent_type": parent_type,
                    "parent_id": parent_id,
                    "parent_name": parent_name,
                    "details": details
                })

        if not results:
            return format_result({"status": "empty", "message": "No drill-down details found for the requested items."})

        return format_result({"status": "found", "results": results, "count": len(results)}, 0)

    # ============================================
    # DB MCP HANDLERS
    # ============================================
    elif name == "db.describe_schema":
        schema = mem.describe_schema()
        return format_result(schema, max_chars, offset, filter_text)

    elif name == "db.select":
        sql = args["sql"]
        params = tuple(args.get("params", []))
        rows = mem.select_query(sql, params)
        return format_result({"rows": rows, "count": len(rows)}, max_chars, offset, filter_text)

    elif name == "db.execute_migration_scoped":
        name_mig = args["name"]
        tables = args["tables"]
        sql = args["sql"]
        result = mem.execute_scoped_migration(name_mig, tables, sql)
        return format_result(result)

    elif name == "db_execute":
        sql = args["sql"]
        params = tuple(args.get("params", []))

        # Security: only allow specific tables
        ALLOWED_TABLES = {
            'projects', 'learnings', 'errors_solutions', 'patterns',
            'sessions', 'user_preferences', 'knowledge_details', 'knowledge_index',
            'memory_meta', 'cognitive_inbox', 'retrieval_inbox', 'generated_tools'
        }

        # Parse and validate
        sql_upper = sql.strip().upper()
        if not (sql_upper.startswith("UPDATE") or sql_upper.startswith("INSERT") or sql_upper.startswith("DELETE")):
            return format_result({"error": "Only UPDATE, INSERT, DELETE allowed"})

        # Check table is in whitelist (basic check)
        sql_lower = sql.lower()
        table_found = False
        for table in ALLOWED_TABLES:
            if table in sql_lower:
                table_found = True
                break

        if not table_found:
            return format_result({"error": f"Table not in allowed list: {ALLOWED_TABLES}"})

        # Execute
        try:
            result = mem.execute_write(sql, params)
            return format_result({"success": True, "affected_rows": result, "sql": sql})
        except Exception as e:
            return format_result({"error": str(e)})

    else:
        return format_result({"error": f"Unknown tool: {name}"})


# ============================================
# SERVER ENTRY POINT
# ============================================

async def main():
    """Run the MCP server."""
    async with stdio_server() as (read_stream, write_stream):
        await server.run(read_stream, write_stream, server.create_initialization_options())


if __name__ == "__main__":
    asyncio.run(main())
