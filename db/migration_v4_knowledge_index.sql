-- ============================================
-- MIGRATION V4: Knowledge Index + Retrieval Inbox Source
-- ============================================

-- ============================================
-- 1. KNOWLEDGE INDEX TABLE
-- ============================================
-- Summary table for fast domain-based retrieval (cascade search)
-- Each row maps to ONE entry in learnings/patterns/errors_solutions/tools

CREATE TABLE IF NOT EXISTS knowledge_index (
    id SERIAL PRIMARY KEY,
    domain TEXT NOT NULL,                -- e.g. "spring-security", "postgresql", "docker", "java"
    source_table TEXT NOT NULL,          -- 'learnings', 'patterns', 'errors_solutions', 'tools'
    source_id INTEGER NOT NULL,          -- ID in the source table
    title TEXT NOT NULL,                 -- Short title (topic/name/error_signature)
    summary TEXT NOT NULL,               -- 1-2 sentence summary
    tags JSONB,                          -- Aggregated tags
    search_vector TSVECTOR,              -- FTS on domain + title + summary
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(source_table, source_id)
);

CREATE INDEX IF NOT EXISTS idx_ki_search ON knowledge_index USING GIN(search_vector);
CREATE INDEX IF NOT EXISTS idx_ki_domain ON knowledge_index(domain);
CREATE INDEX IF NOT EXISTS idx_ki_source ON knowledge_index(source_table, source_id);

-- FTS trigger: weighted search on domain (A) + title (A) + summary (B)
CREATE OR REPLACE FUNCTION ki_search_trigger() RETURNS trigger AS $$
BEGIN
    NEW.search_vector :=
        setweight(to_tsvector('english', COALESCE(NEW.domain, '')), 'A') ||
        setweight(to_tsvector('english', COALESCE(NEW.title, '')), 'A') ||
        setweight(to_tsvector('english', COALESCE(NEW.summary, '')), 'B');
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS ki_search_update ON knowledge_index;
CREATE TRIGGER ki_search_update BEFORE INSERT OR UPDATE ON knowledge_index
FOR EACH ROW EXECUTE FUNCTION ki_search_trigger();

-- ============================================
-- 2. BACKFILL FROM EXISTING TABLES
-- ============================================

-- Learnings → knowledge_index
INSERT INTO knowledge_index (domain, source_table, source_id, title, summary, tags)
SELECT
    COALESCE(l.category, 'general'),
    'learnings', l.id, l.topic,
    LEFT(l.insight, 200),
    l.tags
FROM learnings l
ON CONFLICT (source_table, source_id) DO NOTHING;

-- Patterns → knowledge_index
INSERT INTO knowledge_index (domain, source_table, source_id, title, summary, tags)
SELECT
    COALESCE(p.category, 'general'),
    'patterns', p.id, p.name,
    LEFT(COALESCE(p.problem, '') || ' → ' || COALESCE(p.solution, ''), 200),
    p.tags
FROM patterns p
ON CONFLICT (source_table, source_id) DO NOTHING;

-- Errors → knowledge_index
INSERT INTO knowledge_index (domain, source_table, source_id, title, summary, tags)
SELECT
    'error',
    'errors_solutions', e.id, e.error_signature,
    LEFT(COALESCE(e.root_cause, '') || ' → ' || COALESCE(e.solution, ''), 200),
    e.tags
FROM errors_solutions e
ON CONFLICT (source_table, source_id) DO NOTHING;

-- Tools → knowledge_index
INSERT INTO knowledge_index (domain, source_table, source_id, title, summary, tags)
SELECT
    COALESCE(t.category, 'tool'),
    'tools', t.id, t.name,
    LEFT(t.description, 200),
    t.tags
FROM tools t
WHERE t.is_active = TRUE
ON CONFLICT (source_table, source_id) DO NOTHING;

-- ============================================
-- 3. RETRIEVAL INBOX: ADD SOURCE COLUMN
-- ============================================
-- Tracks which retriever agent produced each result

ALTER TABLE retrieval_inbox ADD COLUMN IF NOT EXISTS source TEXT;
