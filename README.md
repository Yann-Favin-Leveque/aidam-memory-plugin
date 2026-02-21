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

## Prerequisites

### Required tools

| Tool | Version | Purpose |
|------|---------|---------|
| **Claude Code** | Latest | The CLI this plugin extends (`claude`) |
| **Node.js** | >= 18 | Orchestrator runtime |
| **Python** | >= 3.10 | Hook scripts (on_prompt_submit, on_tool_use) |
| **PostgreSQL** | >= 15 | Memory storage backend |
| **npm** | >= 9 | Package management |
| **psql** | (bundled with PG) | Database migrations |
| **bash** | (Git Bash on Windows) | Hook scripts |

### Required npm packages (installed via `npm install`)

| Package | Purpose |
|---------|---------|
| `@anthropic-ai/claude-agent-sdk` | Persistent Retriever + Learner sessions |
| `pg` | PostgreSQL client for orchestrator |
| `node-pty` | Interactive testing (optional, for test suite) |

### Required Python packages

```bash
pip install psycopg2-binary
```

### MCP Memory Server (included in this repo)

The orchestrator launches an MCP server to give the Retriever and Learner access to memory tools. All files are in `mcp/`:

| File | Purpose |
|------|---------|
| `mcp/memory_mcp_server.py` | MCP server exposing memory as tools to agents |
| `mcp/memory_pg.py` | Core memory library (search, save, drilldown) |
| `mcp/schema.sql` | Main memory tables (learnings, patterns, errors, tools, etc.) |

### Database setup

The plugin requires a PostgreSQL database called `claude_memory` with two sets of tables:

1. **Main memory tables** (learnings, patterns, errors_solutions, tools, etc.) — created by `mcp/schema.sql`
2. **Plugin queue tables** (cognitive_inbox, retrieval_inbox, orchestrator_state, etc.) — created by `db/migration.sql`

## Installation

```bash
# 1. Clone the repo
git clone https://github.com/Yann-Favin-Leveque/aidam-memory-plugin.git
cd aidam-memory-plugin

# 2. Create .env with your PostgreSQL password
cp .env.example .env
# Edit .env with your credentials

# 3. Install Node.js dependencies
npm install

# 4. Compile TypeScript
npx tsc

# 5. Install Python dependencies
pip install psycopg2-binary

# 6. Create the database (if not exists)
source .env
createdb -U postgres claude_memory 2>/dev/null || true

# 7. Run the main memory schema (tables for learnings, patterns, etc.)
PGPASSWORD=$PGPASSWORD psql -U postgres -h localhost -d claude_memory \
  -f mcp/schema.sql

# 8. Run the plugin migration (queue tables for orchestrator)
PGPASSWORD=$PGPASSWORD psql -U postgres -h localhost -d claude_memory \
  -f db/migration.sql

# 9. Create generated tools directory
mkdir -p ~/.claude/generated_tools

# 10. Launch Claude Code with the plugin
claude --plugin-dir "$(pwd)"
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
├── .env.example                  # Environment variables template
├── hooks/hooks.json              # 4 lifecycle hooks
├── scripts/
│   ├── orchestrator.ts/.js       # Core: manages Retriever + Learner sessions
│   ├── on_session_start.sh       # Launches orchestrator
│   ├── on_prompt_submit.py       # Polls retrieval results, injects context
│   ├── on_tool_use.py            # Pushes tool data to Learner (async)
│   └── on_session_end.sh         # Stops orchestrator
├── prompts/
│   ├── retriever_system.md       # Retriever agent instructions
│   ├── learner_system.md         # Learner agent instructions
│   └── compactor_system.md       # Compactor agent instructions
├── mcp/
│   ├── memory_mcp_server.py      # MCP server (launched by orchestrator)
│   ├── memory_pg.py              # Core memory library
│   └── schema.sql                # Main DB schema (learnings, patterns, etc.)
├── db/migration.sql              # Queue tables + cleanup functions
├── tools/cleanup_memory.sh       # Manual cleanup script
├── config/defaults.json          # Default configuration
├── TEST_PLAN.md                  # Full test suite (163 tests, levels 0-38)
└── IDEAS.md                      # Roadmap & feature ideas
```
