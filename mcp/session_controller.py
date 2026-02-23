#!/usr/bin/env python3
"""
Session Controller MCP Server
==============================
MCP server that spawns and controls interactive Claude Code CLI sessions.
Allows the main Claude session to act as a "user" guiding a subprocess Claude.

Tools:
  - session_start: Spawn a new Claude CLI session (non-blocking by default)
  - session_send: Send a message (non-blocking by default)
  - session_send_keys: Send special keys (arrows, enter, ctrl+c, etc.)
  - session_read: Read latest output from a session
  - session_status: Check session state
  - session_stop: Terminate a session
"""

import os
import re
import sys
import json
import time
import uuid
import threading
import asyncio
from typing import Any, Dict, Optional

from mcp.server import Server
from mcp.server.stdio import stdio_server
from mcp.types import Tool, TextContent

import winpty

# ============================================
# GLOBALS
# ============================================

server = Server("session-controller")
sessions: Dict[str, dict] = {}

# Key name → raw escape sequence mapping for terminal control
KEY_MAP = {
    # Arrow keys
    "up":        "\x1b[A",
    "down":      "\x1b[B",
    "right":     "\x1b[C",
    "left":      "\x1b[D",
    # Enter / Return
    "enter":     "\r",
    "return":    "\r",
    # Escape
    "escape":    "\x1b",
    "esc":       "\x1b",
    # Tab
    "tab":       "\t",
    # Backspace
    "backspace": "\x7f",
    # Delete
    "delete":    "\x1b[3~",
    # Home / End
    "home":      "\x1b[H",
    "end":       "\x1b[F",
    # Page Up / Down
    "pageup":    "\x1b[5~",
    "pagedown":  "\x1b[6~",
    # Ctrl combos (Ctrl+A=\x01 ... Ctrl+Z=\x1a)
    "ctrl+a":    "\x01",
    "ctrl+b":    "\x02",
    "ctrl+c":    "\x03",
    "ctrl+d":    "\x04",
    "ctrl+e":    "\x05",
    "ctrl+f":    "\x06",
    "ctrl+g":    "\x07",
    "ctrl+h":    "\x08",
    "ctrl+k":    "\x0b",
    "ctrl+l":    "\x0c",
    "ctrl+n":    "\x0e",
    "ctrl+o":    "\x0f",
    "ctrl+p":    "\x10",
    "ctrl+r":    "\x12",
    "ctrl+s":    "\x13",
    "ctrl+t":    "\x14",
    "ctrl+u":    "\x15",
    "ctrl+w":    "\x17",
    "ctrl+z":    "\x1a",
    # Space
    "space":     " ",
}

ANSI_RE = re.compile(r'''
    \x1b       # ESC
    (?:
        \[     # CSI
        [0-9;]*
        [a-zA-Z]
    |
        \]     # OSC
        .*?
        (?:\x07|\x1b\\)  # BEL or ST
    |
        [()][AB012]  # charset
    |
        \[[0-9;]*[ -/]*[@-~]  # broader CSI
    )
''', re.VERBOSE | re.DOTALL)

CONTROL_RE = re.compile(r'[\x00-\x08\x0e-\x1f]')


def strip_ansi(text: str) -> str:
    """Remove ANSI escape codes and control characters from PTY output."""
    text = ANSI_RE.sub('', text)
    text = CONTROL_RE.sub('', text)
    # Collapse excessive blank lines
    text = re.sub(r'\n{4,}', '\n\n\n', text)
    return text.strip()


# ============================================
# BACKGROUND READER THREAD
# ============================================

def _reader_thread(session_id: str):
    """Continuously read from PTY into session buffer. Runs in background thread."""
    sess = sessions.get(session_id)
    if not sess:
        return

    proc = sess["proc"]
    while sess["alive"]:
        try:
            data = proc.read(4096)
            if data:
                with sess["lock"]:
                    sess["buffer"] += data
                    sess["last_data_time"] = time.time()
        except EOFError:
            sess["alive"] = False
            break
        except Exception:
            time.sleep(0.1)


# ============================================
# CORE FUNCTIONS
# ============================================

def _wait_for_idle(session_id: str, idle_threshold: float = 4.0, timeout: float = 120.0) -> str:
    """Wait until the session has been idle for `idle_threshold` seconds, then return new output."""
    sess = sessions.get(session_id)
    if not sess:
        return ""

    start = time.time()
    with sess["lock"]:
        start_pos = len(sess["buffer"])

    while time.time() - start < timeout:
        if not sess["alive"]:
            break

        with sess["lock"]:
            elapsed_since_data = time.time() - sess["last_data_time"]
            current_len = len(sess["buffer"])

        if current_len > start_pos and elapsed_since_data >= idle_threshold:
            break

        time.sleep(0.3)

    with sess["lock"]:
        new_output = sess["buffer"][start_pos:]

    return strip_ansi(new_output)


DEFAULT_MAX_CHARS = 4000
MAX_CHARS_LIMIT = 20000


def _get_new_output(session_id: str, max_chars: int = DEFAULT_MAX_CHARS, offset: int = 0) -> dict:
    """Read session output. Always reads from the full buffer (no stateful cursor).

    By default returns the LAST max_chars (most recent output).
    Use offset to paginate from the beginning.
    """
    sess = sessions.get(session_id)
    if not sess:
        return {"text": "", "total_chars": 0, "truncated": False}

    with sess["lock"]:
        raw = sess["buffer"]

    cleaned = strip_ansi(raw)
    total_chars = len(cleaned)

    # Apply max_chars cap
    if max_chars <= 0:
        max_chars = MAX_CHARS_LIMIT
    max_chars = min(max_chars, MAX_CHARS_LIMIT)

    if offset > 0:
        sliced = cleaned[offset:offset + max_chars]
        return {
            "text": sliced,
            "total_chars": total_chars,
            "showing": f"chars {offset}-{offset + len(sliced)} of {total_chars}",
            "truncated": total_chars > offset + max_chars,
            "next_offset": offset + max_chars if total_chars > offset + max_chars else None,
        }

    if total_chars <= max_chars:
        return {"text": cleaned, "total_chars": total_chars, "truncated": False}

    # Truncate: show the LAST max_chars (most recent output is most useful)
    sliced = cleaned[-max_chars:]
    return {
        "text": sliced,
        "total_chars": total_chars,
        "truncated": True,
        "showing": f"last {max_chars} of {total_chars} chars",
        "use_offset": 0,
    }


def do_session_start(working_dir: str, with_plugin: bool = True, model: str = None, wait: bool = False) -> dict:
    """Spawn a new Claude CLI session."""
    if not os.path.isdir(working_dir):
        return {"error": f"Directory does not exist: {working_dir}"}

    session_id = str(uuid.uuid4())[:8]

    # Build command — use aidam.cmd when plugin is requested (sets AIDAM_PARENT_PID),
    # otherwise fall back to plain claude.cmd
    if with_plugin:
        aidam_cmd = "C:/Users/user/IdeaProjects/aidam-memory-plugin/bin/aidam.cmd"
        cmd_parts = [aidam_cmd]
    else:
        claude_cmd = "C:/Users/user/AppData/Roaming/npm/claude.cmd"
        cmd_parts = [claude_cmd]
    if model:
        cmd_parts.extend(["--model", model])
    cmd_parts.append("--dangerously-skip-permissions")

    # Environment: remove CLAUDECODE to avoid nested session block
    env = os.environ.copy()
    env.pop("CLAUDECODE", None)
    env.pop("CLAUDE_CODE_ENTRYPOINT", None)

    try:
        spawn_args = ["cmd.exe", "/c"] + cmd_parts
        proc = winpty.PtyProcess.spawn(
            spawn_args,
            cwd=working_dir,
            env=env,
            dimensions=(50, 200)
        )
    except Exception as e:
        return {"error": f"Failed to spawn: {str(e)}"}

    sess = {
        "proc": proc,
        "buffer": "",
        "lock": threading.Lock(),
        "alive": True,
        "last_data_time": time.time(),
        "messages_sent": 0,
        "working_dir": working_dir,
        "with_plugin": with_plugin,
        "created_at": time.time(),
    }
    sessions[session_id] = sess

    # Start background reader
    t = threading.Thread(target=_reader_thread, args=(session_id,), daemon=True)
    t.start()
    sess["reader_thread"] = t

    result = {
        "session_id": session_id,
        "status": "started",
        "working_dir": working_dir,
    }

    if wait:
        startup_output = _wait_for_idle(session_id, idle_threshold=5.0, timeout=30.0)
        result["output"] = startup_output[:2000] if startup_output else "(no output yet)"

    return result


def do_session_send(session_id: str, message: str, timeout: float = 180.0, wait: bool = True, max_response_chars: int = 0) -> dict:
    """Send a message to the Claude subprocess. If wait=True, block until response. If wait=False, return immediately.

    Args:
        max_response_chars: Truncate the response to this many chars (0=no limit).
            When truncated, keeps the LAST N chars (most recent output is most useful).
    """
    sess = sessions.get(session_id)
    if not sess:
        return {"error": f"Session not found: {session_id}"}
    if not sess["alive"]:
        return {"error": "Session is dead", "last_output": strip_ansi(sess["buffer"][-3000:])}

    proc = sess["proc"]

    # Mark buffer position before sending
    with sess["lock"]:
        sess["last_data_time"] = time.time()

    # Write message to PTY — send text first, then Enter separately
    try:
        proc.write(message)
        time.sleep(0.2)
        proc.write("\r")
    except Exception as e:
        return {"error": f"Failed to write: {str(e)}"}

    sess["messages_sent"] += 1

    result = {
        "session_id": session_id,
        "message_sent": True,
        "alive": sess["alive"],
        "messages_sent": sess["messages_sent"],
    }

    if wait:
        response = _wait_for_idle(session_id, idle_threshold=4.0, timeout=timeout)

        # Try to remove the echo of our own message
        lines = response.split('\n')
        cleaned_lines = []
        skip_echo = True
        for line in lines:
            if skip_echo and message.strip()[:50] in line:
                skip_echo = False
                continue
            cleaned_lines.append(line)
        cleaned = '\n'.join(cleaned_lines).strip()
        response_text = cleaned if cleaned else response

        # Truncate if requested
        if max_response_chars > 0 and len(response_text) > max_response_chars:
            result["response"] = response_text[-max_response_chars:]
            result["response_truncated"] = True
            result["response_total_chars"] = len(response_text)
        else:
            result["response"] = response_text

    return result


def do_session_send_keys(session_id: str, keys: list, timeout: float = 30.0, wait: bool = True, max_response_chars: int = 0) -> dict:
    """Send special keys to the session. If wait=True, block until idle. If wait=False, return immediately.

    Args:
        max_response_chars: Truncate the response to this many chars (0=no limit).
            When truncated, keeps the LAST N chars (most recent output is most useful).
    """
    sess = sessions.get(session_id)
    if not sess:
        return {"error": f"Session not found: {session_id}"}
    if not sess["alive"]:
        return {"error": "Session is dead", "last_output": strip_ansi(sess["buffer"][-3000:])}

    proc = sess["proc"]

    with sess["lock"]:
        sess["last_data_time"] = time.time()

    sent = []
    try:
        for key in keys:
            key_lower = key.lower().strip()
            if key_lower in KEY_MAP:
                proc.write(KEY_MAP[key_lower])
                sent.append(f"[{key}]")
            else:
                proc.write(key)
                sent.append(key)
            time.sleep(0.15)
    except Exception as e:
        return {"error": f"Failed to write keys: {str(e)}", "sent_before_error": sent}

    sess["messages_sent"] += 1

    result = {
        "session_id": session_id,
        "keys_sent": sent,
        "alive": sess["alive"],
    }

    if wait:
        response = _wait_for_idle(session_id, idle_threshold=4.0, timeout=timeout)

        # Truncate if requested
        if max_response_chars > 0 and len(response) > max_response_chars:
            result["response"] = response[-max_response_chars:]
            result["response_truncated"] = True
            result["response_total_chars"] = len(response)
        else:
            result["response"] = response

    return result


def do_session_read(session_id: str, max_chars: int = DEFAULT_MAX_CHARS, offset: int = 0) -> dict:
    """Read new output from a session since the last read. Always instant, never blocks.

    Args:
        max_chars: Max chars to return (default 4000, max 20000, 0=max).
                   Without offset, returns the LAST max_chars (most recent).
                   With offset, returns from that position.
        offset: Character offset into the new output (for pagination).
    """
    sess = sessions.get(session_id)
    if not sess:
        return {"error": f"Session not found: {session_id}"}

    out = _get_new_output(session_id, max_chars=max_chars, offset=offset)

    with sess["lock"]:
        idle_seconds = time.time() - sess["last_data_time"]

    return {
        "session_id": session_id,
        "output": out["text"],
        "total_chars": out["total_chars"],
        "truncated": out.get("truncated", False),
        "alive": sess["alive"],
        "idle_seconds": round(idle_seconds, 1),
    }


def do_session_status(session_id: str) -> dict:
    """Get status of a session. Light — no big output, just metadata."""
    sess = sessions.get(session_id)
    if not sess:
        return {"error": f"Session not found: {session_id}"}

    with sess["lock"]:
        buf_len = len(sess["buffer"])
        idle_seconds = time.time() - sess["last_data_time"]

    return {
        "session_id": session_id,
        "alive": sess["alive"],
        "messages_sent": sess["messages_sent"],
        "buffer_size": buf_len,
        "idle_seconds": round(idle_seconds, 1),
        "working_dir": sess["working_dir"],
        "uptime_seconds": round(time.time() - sess["created_at"], 1),
    }


def do_session_stop(session_id: str) -> dict:
    """Stop and clean up a session."""
    sess = sessions.get(session_id)
    if not sess:
        return {"error": f"Session not found: {session_id}"}

    sess["alive"] = False
    proc = sess["proc"]

    try:
        if proc.isalive():
            proc.sendintr()  # Ctrl+C
            time.sleep(0.5)
            if proc.isalive():
                proc.terminate()
                time.sleep(0.5)
            if proc.isalive():
                proc.kill(9)
    except Exception:
        pass

    with sess["lock"]:
        final_output = strip_ansi(sess["buffer"][-2000:])

    del sessions[session_id]

    return {
        "session_id": session_id,
        "status": "stopped",
        "final_output": final_output,
    }


# ============================================
# MCP TOOL DEFINITIONS
# ============================================

@server.list_tools()
async def list_tools() -> list[Tool]:
    return [
        Tool(
            name="session_start",
            description=(
                "Start a new interactive Claude Code CLI session. "
                "Returns a session_id to use with other session tools. "
                "The subprocess Claude will work in the specified directory. "
                "Use cases: (1) Launch parallel Claude instances for complex multi-part tasks and supervise them one by one. "
                "(2) Test plugins/tools in real conditions by acting as the user guiding a subprocess Claude. "
                "(3) Delegate autonomous sub-tasks to separate Claude sessions while orchestrating from the main session."
            ),
            inputSchema={
                "type": "object",
                "properties": {
                    "working_dir": {
                        "type": "string",
                        "description": "Absolute path to the working directory for the Claude subprocess"
                    },
                    "with_plugin": {
                        "type": "boolean",
                        "description": "Whether to load plugins via --plugin-dir (default: true). When true, auto-detects .claude-plugin/ in working_dir and passes --plugin-dir to the CLI. Set to false for plain sessions without hooks/skills. IMPORTANT: NEVER launch sessions with plugin enabled for autonomous tasks or worker sub-sessions unless the user explicitly requests it. The plugin spawns background agents that consume API budget. Use with_plugin=false by default for autonomous work, and only set true when testing the plugin itself or when the user explicitly asks for it.",
                        "default": True
                    },
                    "model": {
                        "type": "string",
                        "description": "Model to use (e.g. 'sonnet', 'opus'). Default: Claude's default.",
                        "default": None
                    },
                    "wait": {
                        "type": "boolean",
                        "description": "If true, wait for CLI to be ready before returning. If false (default), return immediately with session_id.",
                        "default": False
                    }
                },
                "required": ["working_dir"]
            }
        ),
        Tool(
            name="session_send",
            description=(
                "Send a message to a running Claude CLI session and wait for the response. "
                "Acts as if a user typed the message. Returns Claude's response text. "
                "Use this to give instructions, ask questions, or guide the subprocess Claude through a task. "
                "When AIDAM plugin is active (with_plugin=true): use /clear for smart compaction "
                "(session state is auto-preserved and re-injected), /aidam-usage for cost report. "
                "Custom user commands live in scripts/commands/ — add a .py/.sh/.js script and "
                "it becomes a /command-name automatically (intercepted by hook, zero LLM tokens)."
            ),
            inputSchema={
                "type": "object",
                "properties": {
                    "session_id": {
                        "type": "string",
                        "description": "Session ID from session_start"
                    },
                    "message": {
                        "type": "string",
                        "description": "The message to send to the Claude subprocess"
                    },
                    "timeout": {
                        "type": "number",
                        "description": "Max seconds to wait for response (default: 180)",
                        "default": 180
                    },
                    "wait": {
                        "type": "boolean",
                        "description": "If true (default), wait for Claude to finish responding. If false, send and return immediately — use session_read later to get the response.",
                        "default": True
                    },
                    "max_response_chars": {
                        "type": "integer",
                        "description": "Max chars to return from the response (0=no limit). When truncated, keeps the LAST N chars (most recent output). Use session_read with offset to paginate if needed.",
                        "default": 0
                    }
                },
                "required": ["session_id", "message"]
            }
        ),
        Tool(
            name="session_send_keys",
            description=(
                "Send special keys or key sequences to a Claude CLI session. "
                "Use this for navigating menus (arrow keys), confirming prompts (enter), "
                "cancelling (escape, ctrl+c), and other terminal interactions. "
                "Each item in the keys array is either a key name (down, up, enter, escape, "
                "ctrl+c, ctrl+a, tab, backspace, space, etc.) or literal text to type."
            ),
            inputSchema={
                "type": "object",
                "properties": {
                    "session_id": {
                        "type": "string",
                        "description": "Session ID"
                    },
                    "keys": {
                        "type": "array",
                        "items": {"type": "string"},
                        "description": (
                            "Sequence of keys to send. Key names: up, down, left, right, "
                            "enter, escape/esc, tab, backspace, delete, home, end, space, "
                            "ctrl+a through ctrl+z. Any other string is sent as literal text."
                        )
                    },
                    "timeout": {
                        "type": "number",
                        "description": "Max seconds to wait for response after keys (default: 30)",
                        "default": 30
                    },
                    "wait": {
                        "type": "boolean",
                        "description": "If true (default), wait for response. If false, return immediately.",
                        "default": True
                    },
                    "max_response_chars": {
                        "type": "integer",
                        "description": "Max chars to return from the response (0=no limit). When truncated, keeps the LAST N chars (most recent output). Use session_read with offset to paginate if needed.",
                        "default": 0
                    }
                },
                "required": ["session_id", "keys"]
            }
        ),
        Tool(
            name="session_read",
            description=(
                "Read new output from a Claude CLI session since the last read. "
                "Always returns immediately (never blocks). "
                "Use this after sending a message with wait=false, or to check on a long-running task. "
                "If output is empty, the subprocess is still working — just call again later. "
                "Returns last 4000 chars by default (most recent output). Use max_chars for more, offset for pagination."
            ),
            inputSchema={
                "type": "object",
                "properties": {
                    "session_id": {
                        "type": "string",
                        "description": "Session ID"
                    },
                    "max_chars": {
                        "type": "integer",
                        "description": "Max chars to return (default 4000, max 20000). Without offset, returns the LAST max_chars.",
                        "default": 4000
                    },
                    "offset": {
                        "type": "integer",
                        "description": "Character offset for pagination (0=start). Use with max_chars to page through large outputs.",
                        "default": 0
                    }
                },
                "required": ["session_id"]
            }
        ),
        Tool(
            name="session_status",
            description="Get the current status of a Claude CLI session (alive, idle time, last output).",
            inputSchema={
                "type": "object",
                "properties": {
                    "session_id": {
                        "type": "string",
                        "description": "Session ID"
                    }
                },
                "required": ["session_id"]
            }
        ),
        Tool(
            name="session_stop",
            description="Stop and clean up a Claude CLI session.",
            inputSchema={
                "type": "object",
                "properties": {
                    "session_id": {
                        "type": "string",
                        "description": "Session ID to stop"
                    }
                },
                "required": ["session_id"]
            }
        ),
    ]


@server.call_tool()
async def call_tool(name: str, arguments: dict) -> list[TextContent]:
    try:
        if name == "session_start":
            result = do_session_start(
                working_dir=arguments["working_dir"],
                with_plugin=arguments.get("with_plugin", True),
                model=arguments.get("model"),
                wait=arguments.get("wait", False),
            )
        elif name == "session_send":
            result = do_session_send(
                session_id=arguments["session_id"],
                message=arguments["message"],
                timeout=arguments.get("timeout", 180),
                wait=arguments.get("wait", True),
                max_response_chars=arguments.get("max_response_chars", 0),
            )
        elif name == "session_send_keys":
            result = do_session_send_keys(
                session_id=arguments["session_id"],
                keys=arguments["keys"],
                timeout=arguments.get("timeout", 30),
                wait=arguments.get("wait", True),
                max_response_chars=arguments.get("max_response_chars", 0),
            )
        elif name == "session_read":
            result = do_session_read(
                session_id=arguments["session_id"],
                max_chars=arguments.get("max_chars", DEFAULT_MAX_CHARS),
                offset=arguments.get("offset", 0),
            )
        elif name == "session_status":
            result = do_session_status(arguments["session_id"])
        elif name == "session_stop":
            result = do_session_stop(arguments["session_id"])
        else:
            result = {"error": f"Unknown tool: {name}"}
    except Exception as e:
        result = {"error": f"Exception in {name}: {str(e)}"}

    return [TextContent(type="text", text=json.dumps(result, indent=2, ensure_ascii=False))]


# ============================================
# MAIN
# ============================================

async def main():
    async with stdio_server() as (read_stream, write_stream):
        await server.run(read_stream, write_stream, server.create_initialization_options())


if __name__ == "__main__":
    asyncio.run(main())
