-- Migration v2: Weighted tsvector search
-- Upgrades search triggers to use setweight() for better ranking
-- A=title (1.0), B=main content (0.4), C=context (0.2), D=secondary (0.1)

-- TOOLS: name=A, description=B, use_cases=C
CREATE OR REPLACE FUNCTION tools_search_trigger() RETURNS trigger AS $$
BEGIN
    NEW.search_vector :=
        setweight(to_tsvector('english', COALESCE(NEW.name, '')), 'A') ||
        setweight(to_tsvector('english', COALESCE(NEW.description, '')), 'B') ||
        setweight(to_tsvector('english', COALESCE(NEW.use_cases, '')), 'C');
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- PATTERNS: name=A, problem+solution=B, context=D
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

-- LEARNINGS: topic=A, insight=B, context=C
CREATE OR REPLACE FUNCTION learnings_search_trigger() RETURNS trigger AS $$
BEGIN
    NEW.search_vector :=
        setweight(to_tsvector('english', COALESCE(NEW.topic, '')), 'A') ||
        setweight(to_tsvector('english', COALESCE(NEW.insight, '')), 'B') ||
        setweight(to_tsvector('english', COALESCE(NEW.context, '')), 'C');
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ERRORS: error_signature=A, solution=B, error_message=C, root_cause=D
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

-- GENERATED_TOOLS: name=A, description=B
CREATE OR REPLACE FUNCTION generated_tools_search_trigger() RETURNS trigger AS $$
BEGIN
    NEW.search_vector :=
        setweight(to_tsvector('english', COALESCE(NEW.name, '')), 'A') ||
        setweight(to_tsvector('english', COALESCE(NEW.description, '')), 'B');
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Rebuild all existing tsvectors with new weights
UPDATE tools SET name = name WHERE TRUE;
UPDATE patterns SET name = name WHERE TRUE;
UPDATE learnings SET topic = topic WHERE TRUE;
UPDATE errors_solutions SET error_signature = error_signature WHERE TRUE;
UPDATE generated_tools SET name = name WHERE name IS NOT NULL;

DO $$
BEGIN
    RAISE NOTICE 'Migration v2 complete: weighted tsvector triggers applied + existing vectors rebuilt';
END $$;
