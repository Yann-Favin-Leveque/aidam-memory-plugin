-- ============================================
-- CLAUDE MEMORY DATABASE SCHEMA (PostgreSQL)
-- Version: 2.0
-- ============================================

-- ============================================
-- CORE TABLES
-- ============================================

-- PROJECTS: Track all projects I work on
CREATE TABLE IF NOT EXISTS projects (
    id SERIAL PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    path TEXT NOT NULL,
    description TEXT,
    stack JSONB,                          -- ["spring-boot", "postgresql", "react"]
    status TEXT DEFAULT 'active',         -- active, paused, completed, archived
    git_repo TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    last_session_at TIMESTAMP,
    notes TEXT
);

-- TOOLS: Scripts and utilities I create for reuse
CREATE TABLE IF NOT EXISTS tools (
    id SERIAL PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    description TEXT NOT NULL,
    category TEXT NOT NULL,               -- script, utility, automation, query, template
    language TEXT NOT NULL,               -- python, batch, powershell, sql, bash, java
    file_path TEXT,                       -- Path to script file (relative to .claude/tools/)
    code TEXT,                            -- Inline code for small scripts
    parameters JSONB,                     -- JSON schema for parameters
    use_cases TEXT,
    tags JSONB,                           -- ["tag1", "tag2"]
    project_id INTEGER REFERENCES projects(id) ON DELETE SET NULL,
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    last_used_at TIMESTAMP,
    usage_count INTEGER DEFAULT 0
);

-- PATTERNS: Reusable code patterns and solutions
CREATE TABLE IF NOT EXISTS patterns (
    id SERIAL PRIMARY KEY,
    name TEXT NOT NULL,
    category TEXT NOT NULL,               -- architecture, algorithm, design-pattern, workaround, config
    problem TEXT NOT NULL,
    solution TEXT NOT NULL,
    context TEXT,
    code_example TEXT,
    language TEXT,
    tags JSONB,
    source TEXT,
    confidence TEXT DEFAULT 'proven',     -- proven, tested, theoretical
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    last_used_at TIMESTAMP,
    usage_count INTEGER DEFAULT 0
);

-- LEARNINGS: Things I learn during sessions
CREATE TABLE IF NOT EXISTS learnings (
    id SERIAL PRIMARY KEY,
    topic TEXT NOT NULL,
    insight TEXT NOT NULL,
    category TEXT,                        -- bug-fix, performance, security, config, api, gotcha
    context TEXT,
    related_project_id INTEGER REFERENCES projects(id) ON DELETE SET NULL,
    tags JSONB,
    source TEXT,
    confidence TEXT DEFAULT 'confirmed',  -- confirmed, likely, uncertain
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    last_referenced_at TIMESTAMP,
    reference_count INTEGER DEFAULT 0
);

-- USER_PREFERENCES: User's coding style, preferences, conventions
CREATE TABLE IF NOT EXISTS user_preferences (
    id SERIAL PRIMARY KEY,
    category TEXT NOT NULL,               -- coding-style, naming, architecture, workflow, personal
    key TEXT NOT NULL,
    value TEXT NOT NULL,
    notes TEXT,
    project_id INTEGER REFERENCES projects(id) ON DELETE CASCADE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(category, key, project_id)
);

-- Handle NULL project_id uniqueness
CREATE UNIQUE INDEX IF NOT EXISTS idx_prefs_unique_global
ON user_preferences(category, key) WHERE project_id IS NULL;

-- SESSIONS: Track my work sessions
CREATE TABLE IF NOT EXISTS sessions (
    id SERIAL PRIMARY KEY,
    project_id INTEGER REFERENCES projects(id) ON DELETE SET NULL,
    session_type TEXT,                    -- orchestrator, worker, standard
    worker_params TEXT,                   -- nopush, nocompile, tested, tested-full
    summary TEXT,
    tasks_completed JSONB,
    tasks_remaining JSONB,
    learnings_ids JSONB,                  -- IDs of learnings created this session
    tools_ids JSONB,                      -- IDs of tools created this session
    started_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    ended_at TIMESTAMP
);

-- COMMANDS: Frequently used commands
CREATE TABLE IF NOT EXISTS commands (
    id SERIAL PRIMARY KEY,
    name TEXT NOT NULL,
    command TEXT NOT NULL,
    description TEXT,
    category TEXT,                        -- git, maven, npm, docker, db, system
    project_id INTEGER REFERENCES projects(id) ON DELETE SET NULL,
    tags JSONB,
    usage_count INTEGER DEFAULT 0,
    last_used_at TIMESTAMP
);

-- ERRORS_SOLUTIONS: Problems encountered and their solutions
CREATE TABLE IF NOT EXISTS errors_solutions (
    id SERIAL PRIMARY KEY,
    error_signature TEXT NOT NULL,
    error_message TEXT,
    root_cause TEXT,
    solution TEXT NOT NULL,
    prevention TEXT,
    related_project_id INTEGER REFERENCES projects(id) ON DELETE SET NULL,
    tags JSONB,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    last_encountered_at TIMESTAMP,
    occurrence_count INTEGER DEFAULT 1
);

-- ============================================
-- FULL-TEXT SEARCH (PostgreSQL tsvector)
-- ============================================

-- Add tsvector columns for full-text search
ALTER TABLE tools ADD COLUMN IF NOT EXISTS search_vector tsvector;
ALTER TABLE patterns ADD COLUMN IF NOT EXISTS search_vector tsvector;
ALTER TABLE learnings ADD COLUMN IF NOT EXISTS search_vector tsvector;
ALTER TABLE errors_solutions ADD COLUMN IF NOT EXISTS search_vector tsvector;

-- Create GIN indexes for fast full-text search
CREATE INDEX IF NOT EXISTS idx_tools_search ON tools USING GIN(search_vector);
CREATE INDEX IF NOT EXISTS idx_patterns_search ON patterns USING GIN(search_vector);
CREATE INDEX IF NOT EXISTS idx_learnings_search ON learnings USING GIN(search_vector);
CREATE INDEX IF NOT EXISTS idx_errors_search ON errors_solutions USING GIN(search_vector);

-- Functions to update search vectors (weighted: A=title, B=main, C=context, D=secondary)
CREATE OR REPLACE FUNCTION tools_search_trigger() RETURNS trigger AS $$
BEGIN
    NEW.search_vector :=
        setweight(to_tsvector('english', COALESCE(NEW.name, '')), 'A') ||
        setweight(to_tsvector('english', COALESCE(NEW.description, '')), 'B') ||
        setweight(to_tsvector('english', COALESCE(NEW.use_cases, '')), 'C');
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION patterns_search_trigger() RETURNS trigger AS $$
BEGIN
    NEW.search_vector :=
        setweight(to_tsvector('english', COALESCE(NEW.name, '')), 'A') ||
        setweight(to_tsvector('english', COALESCE(NEW.problem, '')), 'B') ||
        setweight(to_tsvector('english', COALESCE(NEW.solution, '')), 'B') ||
        setweight(to_tsvector('english', COALESCE(NEW.context, '')), 'D');
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION learnings_search_trigger() RETURNS trigger AS $$
BEGIN
    NEW.search_vector :=
        setweight(to_tsvector('english', COALESCE(NEW.topic, '')), 'A') ||
        setweight(to_tsvector('english', COALESCE(NEW.insight, '')), 'B') ||
        setweight(to_tsvector('english', COALESCE(NEW.context, '')), 'C');
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION errors_search_trigger() RETURNS trigger AS $$
BEGIN
    NEW.search_vector :=
        setweight(to_tsvector('english', COALESCE(NEW.error_signature, '')), 'A') ||
        setweight(to_tsvector('english', COALESCE(NEW.solution, '')), 'B') ||
        setweight(to_tsvector('english', COALESCE(NEW.error_message, '')), 'C') ||
        setweight(to_tsvector('english', COALESCE(NEW.root_cause, '')), 'D');
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Create triggers
DROP TRIGGER IF EXISTS tools_search_update ON tools;
CREATE TRIGGER tools_search_update BEFORE INSERT OR UPDATE ON tools
FOR EACH ROW EXECUTE FUNCTION tools_search_trigger();

DROP TRIGGER IF EXISTS patterns_search_update ON patterns;
CREATE TRIGGER patterns_search_update BEFORE INSERT OR UPDATE ON patterns
FOR EACH ROW EXECUTE FUNCTION patterns_search_trigger();

DROP TRIGGER IF EXISTS learnings_search_update ON learnings;
CREATE TRIGGER learnings_search_update BEFORE INSERT OR UPDATE ON learnings
FOR EACH ROW EXECUTE FUNCTION learnings_search_trigger();

DROP TRIGGER IF EXISTS errors_search_update ON errors_solutions;
CREATE TRIGGER errors_search_update BEFORE INSERT OR UPDATE ON errors_solutions
FOR EACH ROW EXECUTE FUNCTION errors_search_trigger();

-- ============================================
-- INDEXES FOR PERFORMANCE
-- ============================================

CREATE INDEX IF NOT EXISTS idx_tools_category ON tools(category);
CREATE INDEX IF NOT EXISTS idx_tools_language ON tools(language);
CREATE INDEX IF NOT EXISTS idx_tools_project ON tools(project_id);
CREATE INDEX IF NOT EXISTS idx_patterns_category ON patterns(category);
CREATE INDEX IF NOT EXISTS idx_patterns_language ON patterns(language);
CREATE INDEX IF NOT EXISTS idx_learnings_category ON learnings(category);
CREATE INDEX IF NOT EXISTS idx_learnings_project ON learnings(related_project_id);
CREATE INDEX IF NOT EXISTS idx_sessions_project ON sessions(project_id);
CREATE INDEX IF NOT EXISTS idx_commands_category ON commands(category);
CREATE INDEX IF NOT EXISTS idx_errors_project ON errors_solutions(related_project_id);

-- JSONB indexes for tag searches
CREATE INDEX IF NOT EXISTS idx_tools_tags ON tools USING GIN(tags);
CREATE INDEX IF NOT EXISTS idx_patterns_tags ON patterns USING GIN(tags);
CREATE INDEX IF NOT EXISTS idx_learnings_tags ON learnings USING GIN(tags);

-- ============================================
-- VIEWS
-- ============================================

CREATE OR REPLACE VIEW v_active_tools AS
SELECT t.*, p.name as project_name
FROM tools t
LEFT JOIN projects p ON t.project_id = p.id
WHERE t.is_active = TRUE
ORDER BY t.usage_count DESC, t.last_used_at DESC NULLS LAST;

CREATE OR REPLACE VIEW v_recent_learnings AS
SELECT l.*, p.name as project_name
FROM learnings l
LEFT JOIN projects p ON l.related_project_id = p.id
ORDER BY l.created_at DESC
LIMIT 50;

CREATE OR REPLACE VIEW v_memory_stats AS
SELECT
    (SELECT COUNT(*) FROM projects) as projects,
    (SELECT COUNT(*) FROM tools) as tools,
    (SELECT COUNT(*) FROM patterns) as patterns,
    (SELECT COUNT(*) FROM learnings) as learnings,
    (SELECT COUNT(*) FROM errors_solutions) as errors,
    (SELECT COUNT(*) FROM user_preferences) as preferences,
    (SELECT COUNT(*) FROM sessions) as sessions,
    (SELECT COUNT(*) FROM commands) as commands;

-- ============================================
-- HELPER FUNCTIONS
-- ============================================

-- Smart search across all tables (weighted: D=0.1, C=0.2, B=0.4, A=1.0)
CREATE OR REPLACE FUNCTION smart_search(query_text TEXT, limit_per_table INTEGER DEFAULT 5)
RETURNS TABLE(
    source_table TEXT,
    id INTEGER,
    title TEXT,
    preview TEXT,
    rank REAL
) AS $$
BEGIN
    RETURN QUERY
    SELECT 'tools'::TEXT, t.id, t.name, LEFT(t.description, 100),
           ts_rank('{0.1, 0.2, 0.4, 1.0}', t.search_vector, plainto_tsquery('english', query_text))
    FROM tools t
    WHERE t.search_vector @@ plainto_tsquery('english', query_text)
    ORDER BY ts_rank('{0.1, 0.2, 0.4, 1.0}', t.search_vector, plainto_tsquery('english', query_text)) DESC
    LIMIT limit_per_table;

    RETURN QUERY
    SELECT 'patterns'::TEXT, p.id, p.name, LEFT(p.problem, 100),
           ts_rank('{0.1, 0.2, 0.4, 1.0}', p.search_vector, plainto_tsquery('english', query_text))
    FROM patterns p
    WHERE p.search_vector @@ plainto_tsquery('english', query_text)
    ORDER BY ts_rank('{0.1, 0.2, 0.4, 1.0}', p.search_vector, plainto_tsquery('english', query_text)) DESC
    LIMIT limit_per_table;

    RETURN QUERY
    SELECT 'learnings'::TEXT, l.id, l.topic, LEFT(l.insight, 100),
           ts_rank('{0.1, 0.2, 0.4, 1.0}', l.search_vector, plainto_tsquery('english', query_text))
    FROM learnings l
    WHERE l.search_vector @@ plainto_tsquery('english', query_text)
    ORDER BY ts_rank('{0.1, 0.2, 0.4, 1.0}', l.search_vector, plainto_tsquery('english', query_text)) DESC
    LIMIT limit_per_table;

    RETURN QUERY
    SELECT 'errors'::TEXT, e.id, e.error_signature, LEFT(e.solution, 100),
           ts_rank('{0.1, 0.2, 0.4, 1.0}', e.search_vector, plainto_tsquery('english', query_text))
    FROM errors_solutions e
    WHERE e.search_vector @@ plainto_tsquery('english', query_text)
    ORDER BY ts_rank('{0.1, 0.2, 0.4, 1.0}', e.search_vector, plainto_tsquery('english', query_text)) DESC
    LIMIT limit_per_table;
END;
$$ LANGUAGE plpgsql;

-- Fuzzy search across all tables (pg_trgm fallback when FTS returns 0 results)
CREATE OR REPLACE FUNCTION fuzzy_search(query_text TEXT, limit_per_table INTEGER DEFAULT 5, threshold REAL DEFAULT 0.3)
RETURNS TABLE(
    source_table TEXT,
    id INTEGER,
    title TEXT,
    preview TEXT,
    rank REAL
) AS $$
BEGIN
    RETURN QUERY
    SELECT 'tools'::TEXT, t.id, t.name, LEFT(t.description, 100),
           similarity(t.name, query_text)
    FROM tools t
    WHERE similarity(t.name, query_text) > threshold
       OR similarity(t.description, query_text) > threshold
    ORDER BY greatest(similarity(t.name, query_text), similarity(t.description, query_text)) DESC
    LIMIT limit_per_table;

    RETURN QUERY
    SELECT 'patterns'::TEXT, p.id, p.name, LEFT(p.problem, 100),
           similarity(p.name, query_text)
    FROM patterns p
    WHERE similarity(p.name, query_text) > threshold
       OR similarity(p.problem, query_text) > threshold
    ORDER BY greatest(similarity(p.name, query_text), similarity(p.problem, query_text)) DESC
    LIMIT limit_per_table;

    RETURN QUERY
    SELECT 'learnings'::TEXT, l.id, l.topic, LEFT(l.insight, 100),
           similarity(l.topic, query_text)
    FROM learnings l
    WHERE similarity(l.topic, query_text) > threshold
       OR similarity(l.insight, query_text) > threshold
    ORDER BY greatest(similarity(l.topic, query_text), similarity(l.insight, query_text)) DESC
    LIMIT limit_per_table;

    RETURN QUERY
    SELECT 'errors'::TEXT, e.id, e.error_signature, LEFT(e.solution, 100),
           similarity(e.error_signature, query_text)
    FROM errors_solutions e
    WHERE similarity(e.error_signature, query_text) > threshold
       OR similarity(e.solution, query_text) > threshold
    ORDER BY greatest(similarity(e.error_signature, query_text), similarity(e.solution, query_text)) DESC
    LIMIT limit_per_table;
END;
$$ LANGUAGE plpgsql;

-- Get full context for a project
CREATE OR REPLACE FUNCTION get_project_context(p_project_id INTEGER)
RETURNS TABLE(
    context_type TEXT,
    data JSONB
) AS $$
BEGIN
    -- Project info
    RETURN QUERY
    SELECT 'project'::TEXT, to_jsonb(p.*)
    FROM projects p WHERE p.id = p_project_id;

    -- Project tools + global tools
    RETURN QUERY
    SELECT 'tools'::TEXT, jsonb_agg(to_jsonb(t.*))
    FROM tools t
    WHERE (t.project_id = p_project_id OR t.project_id IS NULL) AND t.is_active = TRUE;

    -- Project learnings
    RETURN QUERY
    SELECT 'learnings'::TEXT, jsonb_agg(to_jsonb(l.*))
    FROM learnings l
    WHERE l.related_project_id = p_project_id;

    -- Recent sessions
    RETURN QUERY
    SELECT 'sessions'::TEXT, jsonb_agg(to_jsonb(s.*))
    FROM (SELECT * FROM sessions WHERE project_id = p_project_id ORDER BY started_at DESC LIMIT 5) s;

    -- Project commands + global commands
    RETURN QUERY
    SELECT 'commands'::TEXT, jsonb_agg(to_jsonb(c.*))
    FROM commands c
    WHERE c.project_id = p_project_id OR c.project_id IS NULL;
END;
$$ LANGUAGE plpgsql;
