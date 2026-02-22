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
import os
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
    "db.execute_migration_scoped", "db_execute"
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
