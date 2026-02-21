# AIDAM Memory Plugin

Cognitive memory system for Claude Code. Two persistent background Sonnet sessions (Retriever + Learner) automatically search and save knowledge, injecting relevant context into your main Claude Code session.

## Architecture

```
Main Session (user)
  ├── SessionStart hook → launches orchestrator
  ├── UserPromptSubmit hook → polls retrieval_inbox → injects context
  ├── PostToolUse hook (async) → pushes to cognitive_inbox
  └── SessionEnd hook → stops orchestrator

Orchestrator (Node.js, Agent SDK)
  ├── Retriever (Sonnet, persistent) → searches memory DB → writes results
  └── Learner (Sonnet, persistent) → extracts knowledge → saves to memory DB
```

## Installation

```bash
# 1. Install dependencies
cd C:/Users/user/IdeaProjects/aidam-memory-plugin
npm install

# 2. Compile TypeScript
npx tsc

# 3. Run database migration
# Set PGPASSWORD in your .env file (see .env.example)
source .env
PGPASSWORD=$PGPASSWORD "C:/Program Files/PostgreSQL/17/bin/psql.exe" \
  -U postgres -h localhost -d claude_memory -f db/migration.sql

# 4. Create generated tools directory
mkdir -p ~/.claude/generated_tools

# 5. Test with plugin-dir flag
claude --plugin-dir "C:/Users/user/IdeaProjects/aidam-memory-plugin"
```

## Configuration

Toggle features via environment variables in `~/.claude/settings.json`:

```json
{
  "env": {
    "AIDAM_MEMORY_RETRIEVER": "on",
    "AIDAM_MEMORY_LEARNER": "on"
  }
}
```

Set to `"off"` to disable either feature.

## Cleanup

```bash
# Dry run
bash tools/cleanup_memory.sh --dry-run

# Clean entries older than 7 days
bash tools/cleanup_memory.sh

# Custom retention
bash tools/cleanup_memory.sh --days 14
```

## Cost

~$1/session (30 min) with Sonnet for both Retriever and Learner.

## Files

```
aidam-memory-plugin/
├── .claude-plugin/plugin.json    # Plugin manifest
├── hooks/hooks.json              # 4 lifecycle hooks
├── scripts/
│   ├── orchestrator.ts/.js       # Core: manages Retriever + Learner sessions
│   ├── on_session_start.sh       # Launches orchestrator
│   ├── on_prompt_submit.py       # Polls retrieval results, injects context
│   ├── on_tool_use.py            # Pushes tool data to Learner (async)
│   └── on_session_end.sh         # Stops orchestrator
├── prompts/
│   ├── retriever_system.md       # Retriever agent instructions
│   └── learner_system.md         # Learner agent instructions
├── db/migration.sql              # Queue tables + cleanup functions
├── tools/cleanup_memory.sh       # Manual cleanup script
└── config/defaults.json          # Default configuration
```
