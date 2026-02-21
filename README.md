# AIDAM Memory Plugin

Cognitive memory system for Claude Code. Five persistent background agents (2 Retrievers, Learner, Compactor, Curator) automatically search, save, compact, and maintain knowledge, injecting relevant context into your main Claude Code session.

## Architecture

```
Main Session (user)
  ├── SessionStart hook → launches orchestrator
  ├── UserPromptSubmit hook → polls retrieval_inbox → merges + injects context
  ├── PostToolUse hook (async) → pushes to cognitive_inbox
  └── SessionEnd hook → stops orchestrator

Orchestrator (Node.js, Agent SDK)
  ├── Retriever A — Keyword (persistent)  → FTS/fuzzy search across all tables
  ├── Retriever B — Cascade (persistent)  → knowledge_index → domain → drill down
  ├── Learner (persistent)                → extracts knowledge → saves to memory DB + knowledge_index
  ├── Compactor (persistent)              → monitors transcript size → writes session summaries
  └── Curator (scheduled)                 → merges duplicates, archives stale, detects contradictions

Memory DB (PostgreSQL)
  ├── learnings, patterns, errors_solutions, tools  (knowledge tables)
  ├── knowledge_index                                (domain summary for cascade retrieval)
  ├── cognitive_inbox → retrieval_inbox              (queue tables)
  ├── session_state                                  (compactor output)
  └── Full-text search (weighted tsvector) + fuzzy search (pg_trgm)
```

### Agent Details

| Agent | Role | Model | Trigger |
|-------|------|-------|---------|
| **Retriever A (Keyword)** | Broad FTS/fuzzy search across all memory tables with parallel tool calls | Haiku | Every user prompt |
| **Retriever B (Cascade)** | Searches knowledge_index summary first, identifies relevant domains, then drills down | Haiku | Every user prompt |
| **Learner** | Extracts knowledge from tool observations (batch mode) + indexes in knowledge_index | Haiku | Tool use events |
| **Compactor** | Summarizes conversation into structured state for `/clear` re-injection | Haiku | Transcript size threshold (~20k tokens) |
| **Curator** | DB maintenance: merge duplicates (>80% overlap), archive stale entries, detect contradictions | Haiku | Scheduled interval (default: 6h) or on-demand |

### Dual Retriever Architecture

Both retrievers run **in parallel** on every user prompt, using different strategies:

- **Retriever A (Keyword)**: Direct FTS + fuzzy search across learnings, patterns, errors, tools. Uses parallel tool calls (3-5 searches in a single turn).
- **Retriever B (Cascade)**: Starts with `knowledge_index` (domain summary table), identifies relevant knowledge domains, then drills down into specific entries.

Results are **injected as they arrive** (no waiting for both). When one retriever injects, the other receives a `[PEER_INJECTED]` notification to avoid duplicating content. The hook merges multiple results before injecting into the main session.

## Prerequisites

### Required tools

| Tool | Version | Purpose |
|------|---------|---------|
| **Claude Code** | Latest | The CLI this plugin extends (`claude`) |
| **Node.js** | >= 18 | Orchestrator runtime |
| **Python** | >= 3.10 | Hook scripts (on_prompt_submit, on_tool_use) |
| **PostgreSQL** | >= 15 | Memory storage backend (with pg_trgm extension) |
| **npm** | >= 9 | Package management |
| **psql** | (bundled with PG) | Database migrations |
| **bash** | (Git Bash on Windows) | Hook scripts |

### Required npm packages (installed via `npm install`)

| Package | Purpose |
|---------|---------|
| `@anthropic-ai/claude-agent-sdk` | Persistent agent sessions (Retriever, Learner, Compactor, Curator) |
| `pg` | PostgreSQL client for orchestrator |
| `dotenv` | Environment variable loading for tests |

### Required Python packages

```bash
pip install psycopg2-binary
```

### MCP Memory Server (included in this repo)

The orchestrator launches an MCP server to give agents access to memory tools. All files are in `mcp/`:

| File | Purpose |
|------|---------|
| `mcp/memory_mcp_server.py` | MCP server exposing memory as tools to agents |
| `mcp/memory_pg.py` | Core memory library (weighted FTS + pg_trgm fuzzy search) |
| `mcp/schema.sql` | Main memory tables + search functions (smart_search, fuzzy_search) |

### Database setup

The plugin requires a PostgreSQL database called `claude_memory` with:

1. **Main memory tables** (learnings, patterns, errors_solutions, tools, etc.) — created by `mcp/schema.sql`
2. **Plugin queue tables** (cognitive_inbox, retrieval_inbox, orchestrator_state, session_state) — created by `db/migration.sql`
3. **Weighted search triggers** — created by `db/migration_v2_weighted_search.sql`
4. **Fuzzy search indexes** (pg_trgm) — created by `db/migration_v3_trigram.sql`
5. **Knowledge index** (domain summary for cascade retrieval) — created by `db/migration_v4_knowledge_index.sql`

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

# 7. Run all migrations in order
PGPASSWORD=$PGPASSWORD psql -U postgres -h localhost -d claude_memory \
  -f mcp/schema.sql
PGPASSWORD=$PGPASSWORD psql -U postgres -h localhost -d claude_memory \
  -f db/migration.sql
PGPASSWORD=$PGPASSWORD psql -U postgres -h localhost -d claude_memory \
  -f db/migration_v2_weighted_search.sql
PGPASSWORD=$PGPASSWORD psql -U postgres -h localhost -d claude_memory \
  -f db/migration_v3_trigram.sql
PGPASSWORD=$PGPASSWORD psql -U postgres -h localhost -d claude_memory \
  -f db/migration_v4_knowledge_index.sql

# 8. Create generated tools directory
mkdir -p ~/.claude/generated_tools

# 9. Launch Claude Code with the plugin
claude --plugin-dir "$(pwd)"
```

## Configuration

### Environment Variables

Toggle features and configure budgets in `~/.claude/settings.json`:

```json
{
  "env": {
    "AIDAM_MEMORY_RETRIEVER": "on",
    "AIDAM_MEMORY_LEARNER": "on",
    "AIDAM_MEMORY_COMPACTOR": "on",
    "AIDAM_MEMORY_CURATOR": "off",
    "AIDAM_MEMORY_DEBUG": "off",
    "AIDAM_RETRIEVER_A_BUDGET": "0.50",
    "AIDAM_RETRIEVER_B_BUDGET": "0.50",
    "AIDAM_LEARNER_BUDGET": "0.50",
    "AIDAM_COMPACTOR_BUDGET": "0.30",
    "AIDAM_CURATOR_BUDGET": "0.30",
    "AIDAM_SESSION_BUDGET": "5.00"
  }
}
```

| Variable | Default | Description |
|----------|---------|-------------|
| `AIDAM_MEMORY_RETRIEVER` | `on` | Enable/disable the Retriever agent |
| `AIDAM_MEMORY_LEARNER` | `on` | Enable/disable the Learner agent |
| `AIDAM_MEMORY_COMPACTOR` | `on` | Enable/disable the Compactor agent |
| `AIDAM_MEMORY_CURATOR` | `off` | Enable/disable the Curator agent |
| `AIDAM_MEMORY_DEBUG` | `off` | Verbose logging |
| `AIDAM_RETRIEVER_A_BUDGET` | `0.50` | Per-call budget for Keyword Retriever ($) |
| `AIDAM_RETRIEVER_B_BUDGET` | `0.50` | Per-call budget for Cascade Retriever ($) |
| `AIDAM_LEARNER_BUDGET` | `0.50` | Per-call budget for Learner ($) |
| `AIDAM_COMPACTOR_BUDGET` | `0.30` | Per-call budget for Compactor ($) |
| `AIDAM_CURATOR_BUDGET` | `0.30` | Per-call budget for Curator ($) |
| `AIDAM_SESSION_BUDGET` | `5.00` | Total session budget — orchestrator shuts down when exhausted ($) |

### Learner Batch Processing

The Learner buffers tool observations and processes them in batches for efficiency:

| Parameter | Default | Description |
|-----------|---------|-------------|
| Batch window | 10s | Time window to accumulate observations |
| Min batch size | 3 | Flush early when this many observations are buffered |
| Max batch size | 10 | Flush immediately at this count |

### Curator Schedule

The Curator runs periodically (default: every 6 hours) and performs:
- **Merge duplicates** — entries with >80% semantic overlap
- **Archive stale** — entries not retrieved in 30+ days (lowers confidence)
- **Detect contradictions** — flags conflicting entries
- **Consolidate patterns** — groups 3+ related learnings into patterns

Trigger on-demand by inserting a `curator_trigger` message into `cognitive_inbox`.

### Compactor Context Window

The Compactor uses a dynamic sliding window over conversation content:

| Situation | Window size | Rationale |
|-----------|------------|-----------|
| First compact of session (no previous state) | **45k chars** (~11k tokens) | Needs more context to build initial state |
| Subsequent compacts (updating existing state) | **25k chars** (~6k tokens) | Only needs recent delta since last state |

### `/smart-compact` — Safe Session Clear

Custom slash command (defined in `.claude-plugin/skills/smart-compact/`) that replaces `/clear`:

| Command | Behavior |
|---------|----------|
| `/smart-compact` | Checks orchestrator is running, verifies existing state, then clears + re-injects |
| `/smart-compact -forcesummary` | Forces Compactor to run first (captures latest conversation), then clears + re-injects |
| `/clear` | Native clear — works with AIDAM if plugin is loaded, but no safety checks |

Use `/smart-compact` by default to prevent accidental context loss when the plugin isn't loaded.

## Search

The memory system uses three search strategies:

1. **Weighted Full-Text Search** (Retriever A primary) — PostgreSQL `tsvector` with `setweight()`:
   - **A (1.0)**: titles/names (highest relevance)
   - **B (0.4)**: main content (descriptions, insights, solutions)
   - **C (0.2)**: context fields
   - **D (0.1)**: secondary fields

2. **Fuzzy Search** (fallback) — `pg_trgm` trigram matching:
   - Activated when FTS returns 0 results
   - Handles typos and partial matches (threshold: 0.3 similarity)
   - GIN trigram indexes on name/title/topic/signature fields

3. **Cascade Search** (Retriever B) — `knowledge_index` summary table:
   - Domain-level overview first (what knowledge domains exist)
   - Then drill down into specific entries
   - Auto-populated by the Learner on every save

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

Typical costs per session (30 min):

| Configuration | Estimated Cost |
|---------------|---------------|
| Retriever + Learner (default) | ~$1.00 |
| + Compactor | ~$1.20 |
| + Curator | ~$1.50 |
| Session budget limit (configurable) | $5.00 default |

## Test Suite

**184 tests** across **39 levels** (L0-L38 + L39), from infrastructure smoke tests to full autonomous intelligence loops.

```
L1-12:  "Je fonctionne"          — Infrastructure, agents run correctly
L13-20: "Je pense"               — Reasoning, transfer, composition
L21-28: "Je resous"              — Planning, correction, generation
L29:    "Je documente"           — Knowledge synthesis
L30-31: "J'acquiers des moyens"  — Browser + sub-sessions (via web research)
L32-33: "Je me gere"             — Self-testing, autonomous debugging + web fallback
L34:    "Je resous partout"      — Multi-domain: ML, K8s, React, Security
L35:    "J'agis dans le monde"   — Web deployment + self-verification
L36-37: "Je partage"             — Self-improvement, teaching + web enrichment
L38:    "Je boucle"              — Full autonomous loop: plan → research → act → verify → learn
L39:    "Je maintiens"           — Curator agent: merge, archive, detect, consolidate
```

Run tests:
```bash
# Single level
node scripts/test_level29.js

# All levels (sequential)
for i in $(seq 13 39); do node scripts/test_level$i.js; done
```

## Files

```
aidam-memory-plugin/
├── .claude-plugin/
│   ├── plugin.json                      # Plugin manifest
│   └── skills/smart-compact/SKILL.md    # /smart-compact slash command
├── .env.example                         # Environment variables template
├── hooks/hooks.json                     # 4 lifecycle hooks
├── scripts/
│   ├── orchestrator.ts/.js              # Core: manages 4 agent sessions
│   ├── on_session_start.sh              # Launches orchestrator (passes budgets, curator config)
│   ├── on_prompt_submit.py              # Polls retrieval results, injects context
│   ├── on_tool_use.py                   # Pushes tool data to Learner (async)
│   ├── on_session_end.sh                # Stops orchestrator
│   ├── inject_state.py                  # Injects compactor state on /clear
│   └── test_level{1-39}.js             # Test suite (184 tests)
├── prompts/
│   ├── retriever_keyword_system.md      # Retriever A (Keyword) agent instructions
│   ├── retriever_cascade_system.md      # Retriever B (Cascade) agent instructions
│   ├── learner_system.md                # Learner agent instructions
│   ├── compactor_system.md              # Compactor agent instructions
│   └── curator_system.md               # Curator agent instructions
├── mcp/
│   ├── memory_mcp_server.py             # MCP server (launched by orchestrator)
│   ├── memory_pg.py                     # Core memory library (weighted FTS + fuzzy)
│   └── schema.sql                       # Main DB schema + search functions
├── db/
│   ├── migration.sql                    # Queue tables + cleanup functions
│   ├── migration_v2_weighted_search.sql # Weighted tsvector triggers
│   ├── migration_v3_trigram.sql         # pg_trgm fuzzy search indexes
│   └── migration_v4_knowledge_index.sql # Knowledge index for cascade retrieval
├── config/defaults.json                 # Default configuration (agents, budgets, batch)
├── tools/cleanup_memory.sh              # Manual cleanup script
├── TEST_PLAN.md                         # Full test plan (184 tests, levels 0-39)
└── IDEAS.md                             # Roadmap & feature ideas
```
