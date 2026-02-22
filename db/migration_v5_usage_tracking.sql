-- ============================================
-- MIGRATION V5: Usage Tracking
-- Adds cost persistence for /aidam-usage skill
-- ============================================

-- 1. Summary columns on orchestrator_state (fast single-query access)
ALTER TABLE orchestrator_state ADD COLUMN IF NOT EXISTS total_cost_usd REAL DEFAULT 0.0;
ALTER TABLE orchestrator_state ADD COLUMN IF NOT EXISTS total_invocations INTEGER DEFAULT 0;

-- 2. Per-agent detail table
CREATE TABLE IF NOT EXISTS agent_usage (
    id SERIAL PRIMARY KEY,
    session_id TEXT NOT NULL,
    agent_name TEXT NOT NULL,           -- 'retriever_a', 'retriever_b', 'learner', 'compactor', 'curator'
    invocation_count INTEGER DEFAULT 0,
    total_cost_usd REAL DEFAULT 0.0,
    last_cost_usd REAL DEFAULT 0.0,
    budget_per_call REAL DEFAULT 0.0,
    budget_session REAL DEFAULT 0.0,
    first_invocation_at TIMESTAMP,
    last_invocation_at TIMESTAMP,
    status TEXT DEFAULT 'idle',         -- 'idle', 'busy', 'disabled'
    UNIQUE(session_id, agent_name)
);

CREATE INDEX IF NOT EXISTS idx_agent_usage_session ON agent_usage(session_id);

-- Verify
DO $$
BEGIN
    RAISE NOTICE 'Migration V5 complete: usage tracking columns + agent_usage table';
END $$;
