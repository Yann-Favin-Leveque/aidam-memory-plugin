-- ============================================
-- AIDAM-MEMORY PLUGIN: DATABASE MIGRATION
-- Target: claude_memory database
-- Version: 1.0
-- ============================================

-- COGNITIVE_INBOX: Queue for messages from hooks to Retriever/Learner
CREATE TABLE IF NOT EXISTS cognitive_inbox (
    id SERIAL PRIMARY KEY,
    session_id TEXT NOT NULL,
    message_type TEXT NOT NULL,         -- 'prompt_context', 'tool_use', 'session_event'
    payload JSONB NOT NULL,
    status TEXT DEFAULT 'pending',      -- 'pending', 'processing', 'completed', 'failed'
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    processed_at TIMESTAMP,
    processor_session_id TEXT
);

CREATE INDEX IF NOT EXISTS idx_cognitive_inbox_status ON cognitive_inbox(status);
CREATE INDEX IF NOT EXISTS idx_cognitive_inbox_session ON cognitive_inbox(session_id);
CREATE INDEX IF NOT EXISTS idx_cognitive_inbox_created ON cognitive_inbox(created_at);

-- RETRIEVAL_INBOX: Results from Retriever back to the main session hook
CREATE TABLE IF NOT EXISTS retrieval_inbox (
    id SERIAL PRIMARY KEY,
    session_id TEXT NOT NULL,
    prompt_hash TEXT NOT NULL,
    context_type TEXT NOT NULL,         -- 'memory_results', 'recipe', 'project_context', 'none'
    context_text TEXT,
    relevance_score REAL DEFAULT 0.0,
    status TEXT DEFAULT 'pending',      -- 'pending', 'delivered', 'expired', 'skipped'
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    delivered_at TIMESTAMP,
    expires_at TIMESTAMP DEFAULT (CURRENT_TIMESTAMP + INTERVAL '60 seconds')
);

CREATE INDEX IF NOT EXISTS idx_retrieval_inbox_session_status ON retrieval_inbox(session_id, status);
CREATE INDEX IF NOT EXISTS idx_retrieval_inbox_prompt ON retrieval_inbox(prompt_hash);
CREATE INDEX IF NOT EXISTS idx_retrieval_inbox_expires ON retrieval_inbox(expires_at);

-- GENERATED_TOOLS: Metadata for tools created by the Learner
CREATE TABLE IF NOT EXISTS generated_tools (
    id SERIAL PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    description TEXT NOT NULL,
    file_path TEXT NOT NULL,
    language TEXT NOT NULL DEFAULT 'bash',
    parameters JSONB,
    created_by_session TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    last_used_at TIMESTAMP,
    usage_count INTEGER DEFAULT 0,
    is_active BOOLEAN DEFAULT TRUE,
    tags JSONB,
    search_vector TSVECTOR
);

CREATE INDEX IF NOT EXISTS idx_generated_tools_search ON generated_tools USING GIN(search_vector);
CREATE INDEX IF NOT EXISTS idx_generated_tools_active ON generated_tools(is_active);

CREATE OR REPLACE FUNCTION generated_tools_search_trigger() RETURNS trigger AS $$
BEGIN
    NEW.search_vector := to_tsvector('english',
        COALESCE(NEW.name, '') || ' ' ||
        COALESCE(NEW.description, ''));
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS generated_tools_search_update ON generated_tools;
CREATE TRIGGER generated_tools_search_update
    BEFORE INSERT OR UPDATE ON generated_tools
    FOR EACH ROW EXECUTE FUNCTION generated_tools_search_trigger();

-- ORCHESTRATOR_STATE: Tracks orchestrator lifecycle per session
CREATE TABLE IF NOT EXISTS orchestrator_state (
    id SERIAL PRIMARY KEY,
    session_id TEXT NOT NULL UNIQUE,
    pid INTEGER,
    retriever_session_id TEXT,
    learner_session_id TEXT,
    status TEXT DEFAULT 'starting',     -- 'starting', 'running', 'stopping', 'stopped', 'crashed'
    retriever_enabled BOOLEAN DEFAULT TRUE,
    learner_enabled BOOLEAN DEFAULT TRUE,
    started_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    last_heartbeat_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    stopped_at TIMESTAMP,
    error_message TEXT
);

CREATE INDEX IF NOT EXISTS idx_orchestrator_state_session ON orchestrator_state(session_id);
CREATE INDEX IF NOT EXISTS idx_orchestrator_state_status ON orchestrator_state(status);

-- Cleanup function: expire old retrieval_inbox entries
CREATE OR REPLACE FUNCTION cleanup_expired_retrieval() RETURNS INTEGER AS $$
DECLARE
    affected INTEGER;
BEGIN
    UPDATE retrieval_inbox
    SET status = 'expired'
    WHERE status = 'pending'
      AND expires_at < CURRENT_TIMESTAMP;
    GET DIAGNOSTICS affected = ROW_COUNT;
    RETURN affected;
END;
$$ LANGUAGE plpgsql;

-- Cleanup function: purge old cognitive_inbox entries (older than 24h)
CREATE OR REPLACE FUNCTION cleanup_old_cognitive_inbox() RETURNS INTEGER AS $$
DECLARE
    affected INTEGER;
BEGIN
    DELETE FROM cognitive_inbox
    WHERE created_at < CURRENT_TIMESTAMP - INTERVAL '24 hours'
      AND status IN ('completed', 'failed');
    GET DIAGNOSTICS affected = ROW_COUNT;
    RETURN affected;
END;
$$ LANGUAGE plpgsql;

-- Verify migration
DO $$
BEGIN
    RAISE NOTICE 'Migration complete. Tables created: cognitive_inbox, retrieval_inbox, generated_tools, orchestrator_state';
END $$;
