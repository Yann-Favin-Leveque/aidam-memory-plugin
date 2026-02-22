#!/usr/bin/env python3
"""
AIDAM Command Router — UserPromptSubmit hook
=============================================
Intercepts user prompts starting with / and checks if a matching script
exists in scripts/commands/. If found, executes it and blocks the prompt
(exit 2 = block + stderr shown to user). Otherwise, lets the prompt through.

Supported script extensions: .py, .sh, .js
Matching: /aidam-usage → scripts/commands/aidam-usage.py (or .sh, .js)
"""
import sys
import os
import json
import subprocess
import glob

PLUGIN_ROOT = os.environ.get("CLAUDE_PLUGIN_ROOT", os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
COMMANDS_DIR = os.path.join(PLUGIN_ROOT, "scripts", "commands")
PYTHON = "C:/Users/user/AppData/Local/Programs/Python/Python312/python.exe"

def main():
    # Read hook input from stdin
    try:
        raw = sys.stdin.read()
        data = json.loads(raw)
    except Exception:
        sys.exit(0)  # Can't parse → let prompt through

    prompt = data.get("prompt", "").strip()

    # Only intercept /commands (not empty, not just /)
    if not prompt.startswith("/") or len(prompt) < 2:
        sys.exit(0)

    # Extract command name: "/aidam-usage foo bar" → "aidam-usage"
    parts = prompt[1:].split(None, 1)
    cmd_name = parts[0].lower()
    cmd_args = parts[1] if len(parts) > 1 else ""

    # Search for matching script
    script_path = None
    for ext in [".py", ".sh", ".js"]:
        candidate = os.path.join(COMMANDS_DIR, cmd_name + ext)
        if os.path.isfile(candidate):
            script_path = candidate
            break

    if not script_path:
        # No matching command script → let prompt through to Claude
        sys.exit(0)

    # Execute the command script
    try:
        if script_path.endswith(".py"):
            runner = [PYTHON, script_path]
        elif script_path.endswith(".sh"):
            runner = ["bash", script_path]
        elif script_path.endswith(".js"):
            runner = ["node", script_path]
        else:
            sys.exit(0)

        env = os.environ.copy()
        env["AIDAM_CMD_ARGS"] = cmd_args
        env["AIDAM_PLUGIN_ROOT"] = PLUGIN_ROOT

        result = subprocess.run(
            runner,
            capture_output=True,
            text=True,
            timeout=30,
            env=env,
            cwd=PLUGIN_ROOT
        )

        # Output stderr to user (exit 2 shows stderr to user)
        output = result.stderr.strip() if result.stderr.strip() else result.stdout.strip()
        if output:
            print(output, file=sys.stderr)
        else:
            print(f"/{cmd_name} executed (no output).", file=sys.stderr)

    except subprocess.TimeoutExpired:
        print(f"/{cmd_name} timed out after 30s.", file=sys.stderr)
    except Exception as e:
        print(f"/{cmd_name} error: {e}", file=sys.stderr)

    # Block the prompt (exit 2 = block + show stderr)
    sys.exit(2)

if __name__ == "__main__":
    main()
