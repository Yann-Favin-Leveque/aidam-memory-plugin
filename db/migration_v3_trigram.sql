-- Migration v3: pg_trgm fuzzy matching
-- Enables trigram-based fuzzy search as fallback when FTS returns 0 results

CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- GIN trigram indexes on title/name fields (primary fuzzy targets)
CREATE INDEX IF NOT EXISTS idx_tools_name_trgm ON tools USING GIN(name gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_patterns_name_trgm ON patterns USING GIN(name gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_learnings_topic_trgm ON learnings USING GIN(topic gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_errors_signature_trgm ON errors_solutions USING GIN(error_signature gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_generated_tools_name_trgm ON generated_tools USING GIN(name gin_trgm_ops);

-- Additional trigram indexes on content fields for broader fuzzy coverage
CREATE INDEX IF NOT EXISTS idx_learnings_insight_trgm ON learnings USING GIN(insight gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_errors_solution_trgm ON errors_solutions USING GIN(solution gin_trgm_ops);

DO $$
BEGIN
    RAISE NOTICE 'Migration v3 complete: pg_trgm extension enabled + trigram indexes created';
END $$;
