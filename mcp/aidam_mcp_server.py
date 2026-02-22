#!/usr/bin/env python3
"""
AIDAM MCP Server — Main Session Tools
======================================
MCP server exposing AIDAM orchestrator tools (aidam_*) to the main Claude Code session.

This server is separate from the memory_mcp_server.py which exposes memory_* tools
to the background agents (Retriever, Learner, Compactor, Curator).

Tools:
  - aidam_retrieve: Search memory via dual Retriever agents
  - aidam_deepen: Get detailed drill-downs for specific items
  - aidam_learn: Send observations to Learner for async extraction
  - aidam_create_tool: Register a generated tool script
  - aidam_use_tool: Execute a generated tool by name
  - aidam_smart_compact: Check/force compaction
  - aidam_usage: Agent cost breakdown
"""

import json
import asyncio
import hashlib
import os
import subprocess
import sys
import time
from typing import Any
from mcp.server import Server
from mcp.server.stdio import stdio_server
from mcp.types import Tool, TextContent

# Import existing memory functions
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import memory_pg as mem

# Create server instance
server = Server("aidam")


# ============================================
# RESPONSE FORMATTING
# ============================================

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


def format_result(data: Any, max_chars: int = 0) -> str:
    """Format data as JSON string for MCP response.

    Args:
        data: The data to format
        max_chars: Max characters to return (0=unlimited)
    """
    full_json = json.dumps(json_serializer(data), indent=2, ensure_ascii=False)
    if max_chars == 0 or len(full_json) <= max_chars:
        return full_json
    return full_json[:max_chars] + f"\n\n[TRUNCATED: {max_chars}/{len(full_json)} chars]"


# ============================================
# DEEPENABLE HELPER
# ============================================

def _find_deepenable(context: str) -> list[dict]:
    """Find knowledge_details parents that have drill-downs and are related to the context."""
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
# TOOL DEFINITIONS
# ============================================

@server.list_tools()
async def list_tools() -> list[Tool]:
    """List available AIDAM tools for the main session."""
    return [
        Tool(
            name="aidam_retrieve",
            description="Search memory for relevant knowledge. Sends context to dual Retriever agents "
                        "(keyword + cascade) and returns merged results. Searches learnings, patterns, "
                        "errors, AND generated tools. This is your single entry point for all knowledge discovery.",
            inputSchema={
                "type": "object",
                "properties": {
                    "context": {
                        "type": "string",
                        "description": "What you want to search for. Be specific: describe the task, error, or question."
                    }
                },
                "required": ["context"]
            }
        ),
        Tool(
            name="aidam_deepen",
            description="Get detailed drill-downs (code snippets, file paths, implementation details) for specific "
                        "items flagged by aidam_retrieve. Use when surface results aren't enough.",
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
            name="aidam_learn",
            description="Send observations to the Learner agent for async knowledge extraction. "
                        "Fire-and-forget: returns immediately. Use after solving a bug, discovering a pattern, etc.",
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
            name="aidam_create_tool",
            description="Register a generated tool (script) in the database and index it for retrieval. "
                        "The script file must already exist under ~/.claude/generated_tools/. "
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
        Tool(
            name="aidam_use_tool",
            description="Execute a generated tool (script) by name. "
                        "To discover available tools, use aidam_retrieve — it searches generated tools alongside all knowledge.",
            inputSchema={
                "type": "object",
                "properties": {
                    "name": {
                        "type": "string",
                        "description": "Tool name (must match a registered generated_tools entry)"
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
            name="aidam_smart_compact",
            description="Check compaction status or force a new compaction. "
                        "Use force_summary=true to trigger immediate compaction (~10-30s). "
                        "Then /clear to apply the saved state.",
            inputSchema={
                "type": "object",
                "properties": {
                    "force_summary": {
                        "type": "boolean",
                        "description": "If true, trigger immediate compaction (default: false)",
                        "default": False
                    }
                }
            }
        ),
        Tool(
            name="aidam_usage",
            description="Get AIDAM agent usage and cost breakdown for the current session. "
                        "Shows per-agent invocation counts, costs, and session budget.",
            inputSchema={
                "type": "object",
                "properties": {}
            }
        ),
    ]


# ============================================
# TOOL HANDLERS
# ============================================

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

    if name == "aidam_retrieve":
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

        # Poll retrieval_inbox (up to ~7s, dual-retriever merge logic)
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
        return format_result(result)

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

        return format_result({"status": "found", "results": results, "count": len(results)})

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
                cmd = ["python", real_path]
            elif language == "javascript":
                cmd = ["node", real_path]
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
        })

    else:
        return format_result({"error": f"Unknown tool: {name}"})


# ============================================
# SERVER ENTRY POINT
# ============================================

async def main():
    """Run the AIDAM MCP server."""
    async with stdio_server() as (read_stream, write_stream):
        await server.run(read_stream, write_stream, server.create_initialization_options())


if __name__ == "__main__":
    asyncio.run(main())
