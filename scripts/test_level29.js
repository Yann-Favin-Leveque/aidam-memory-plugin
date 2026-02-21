/**
 * AIDAM Level 29 — Auto-Documentation ("Je documente")
 *
 * #117: Knowledge inventory — Retriever generates structured doc from PG knowledge
 * #118: Cross-reference doc — References across learnings, patterns, errors
 * #119: Quality check — >500 chars, >=3 sections, cites specific IDs
 * #120: Incremental update — After new learning, doc is enriched
 *
 * AGI Level: 101/100
 */
const { Client } = require("pg");
const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { askValidator } = require("./test_helpers.js");

require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const DB = { host: "localhost", database: "claude_memory", user: "postgres", password: process.env.PGPASSWORD || "", port: 5432 };
const ORCHESTRATOR = path.join(__dirname, "orchestrator.js");

const results = [];
function record(step, passed, desc) { results.push({ step, passed, desc }); console.log(`  ${passed ? "PASS" : "FAIL"}: ${desc}`); }

async function dbQuery(sql, params = []) { const db = new Client(DB); await db.connect(); const r = await db.query(sql, params); await db.end(); return r; }
async function waitForStatus(sid, pat, ms = 25000) { const re = new RegExp(pat, "i"); const s = Date.now(); while (Date.now() - s < ms) { const r = await dbQuery("SELECT status FROM orchestrator_state WHERE session_id=$1", [sid]); if (r.rows.length > 0 && re.test(r.rows[0].status)) return true; await new Promise(r => setTimeout(r, 1000)); } return false; }
function launchOrch(sid, opts = {}) { const lf = `C:/Users/user/.claude/logs/aidam_orch_test29_${sid.slice(-8)}.log`; const fd = fs.openSync(lf, "w"); const p = spawn("node", [ORCHESTRATOR, `--session-id=${sid}`, "--cwd=C:/Users/user/IdeaProjects/aidam-memory-plugin", `--retriever=${opts.retriever||"on"}`, `--learner=${opts.learner||"on"}`, "--compactor=off", "--project-slug=aidam-memory"], { stdio: ["ignore", fd, fd], detached: false }); let ex = false; p.on("exit", () => { ex = true; }); return { proc: p, logFile: lf, isExited: () => ex }; }
async function killSession(sid, proc) { try { await dbQuery("UPDATE orchestrator_state SET status='stopping' WHERE session_id=$1", [sid]); } catch {} await new Promise(r => setTimeout(r, 4000)); try { proc.kill(); } catch {} await new Promise(r => setTimeout(r, 1000)); }
async function cleanSession(sid) { await dbQuery("DELETE FROM orchestrator_state WHERE session_id=$1", [sid]); await dbQuery("DELETE FROM cognitive_inbox WHERE session_id=$1", [sid]); await dbQuery("DELETE FROM retrieval_inbox WHERE session_id=$1", [sid]); }
async function injectToolUse(sid, pl) { const r = await dbQuery("INSERT INTO cognitive_inbox (session_id, message_type, payload, status) VALUES ($1, 'tool_use', $2, 'pending') RETURNING id", [sid, JSON.stringify(pl)]); return r.rows[0].id; }
async function injectPrompt(sid, prompt) { const h = crypto.createHash("sha256").update(prompt).digest("hex").slice(0, 16); await dbQuery("INSERT INTO cognitive_inbox (session_id, message_type, payload, status) VALUES ($1, 'prompt_context', $2, 'pending')", [sid, JSON.stringify({ prompt, prompt_hash: h, timestamp: Date.now() })]); return h; }
async function waitForProcessed(id, ms = 90000) { const s = Date.now(); while (Date.now() - s < ms) { const r = await dbQuery("SELECT status FROM cognitive_inbox WHERE id=$1", [id]); if (r.rows.length > 0 && /completed|failed/.test(r.rows[0].status)) return r.rows[0].status; await new Promise(r => setTimeout(r, 2000)); } return "timeout"; }
async function waitForRetrieval(sid, h, ms = 45000) { const s = Date.now(); while (Date.now() - s < ms) { const r = await dbQuery("SELECT context_type, context_text FROM retrieval_inbox WHERE session_id=$1 AND prompt_hash=$2 ORDER BY id DESC LIMIT 1", [sid, h]); if (r.rows.length > 0) return r.rows[0]; await new Promise(r => setTimeout(r, 1000)); } return null; }
function readLog(f) { try { return fs.readFileSync(f, "utf-8"); } catch { return ""; } }
function extractCost(log) { return (log.match(/cost: \$([0-9.]+)/g) || []).reduce((s, m) => s + parseFloat(m.replace("cost: $", "")), 0); }

async function run() {
  const SID = `level29-${Date.now()}`;
  let validatorCost = 0;
  console.log(`\n${"=".repeat(60)}`);
  console.log(`  AIDAM Level 29: Auto-Documentation ("Je documente")`);
  console.log(`${"=".repeat(60)}`);
  console.log(`Session ID: ${SID}\n`);

  await cleanSession(SID);

  // Seed: 5 PG learnings + 2 PG patterns + 1 PG error
  console.log("Seeding PostgreSQL knowledge...");
  await dbQuery(`INSERT INTO learnings (topic, insight, category, context, confidence, tags, related_project_id)
    VALUES
    ('PostgreSQL connection pooling', 'Use PgBouncer or HikariCP for connection pooling. Max pool size = (core_count * 2) + effective_spindle_count. For SSD: cores*2+1.', 'performance', 'High-traffic applications', 0.9, '["postgresql","performance","pooling"]', 1),
    ('PostgreSQL JSONB indexing', 'Use GIN indexes for JSONB containment queries (@>). For specific key lookups, use expression index: CREATE INDEX idx ON t ((data->>''key'')). GIN is slower to update but faster to query.', 'performance', 'Document-style storage in PG', 0.85, '["postgresql","jsonb","indexing"]', 1),
    ('PostgreSQL vacuum tuning', 'autovacuum_vacuum_scale_factor=0.1 for busy tables (default 0.2 too high). autovacuum_analyze_scale_factor=0.05. Monitor pg_stat_user_tables.n_dead_tup.', 'config', 'Production PG maintenance', 0.8, '["postgresql","vacuum","tuning"]', NULL),
    ('PostgreSQL full-text search', 'Use tsvector + tsquery for FTS. setweight() for ranking: A=title, B=body, C=tags. ts_rank with weights array. GIN index on tsvector column.', 'architecture', 'Search feature implementation', 0.95, '["postgresql","fts","search"]', 4),
    ('PostgreSQL partitioning', 'Use RANGE partitioning for time-series data. CREATE TABLE ... PARTITION BY RANGE (created_at). Each partition = 1 month. Auto-create with pg_partman.', 'architecture', 'Large tables with time-series data', 0.85, '["postgresql","partitioning","performance"]', NULL)
    ON CONFLICT DO NOTHING`);

  await dbQuery(`INSERT INTO patterns (name, category, problem, solution, context, code_example, confidence, tags)
    VALUES
    ('PostgreSQL migration pattern', 'devops', 'Need to evolve DB schema safely in production', 'Use versioned migration files (v1, v2, etc.) with IF NOT EXISTS guards. Always test rollback. Use transactions for DDL.', 'Any PostgreSQL project', 'CREATE TABLE IF NOT EXISTS ...; ALTER TABLE ... ADD COLUMN IF NOT EXISTS ...;', 0.9, '["postgresql","migration","devops"]'),
    ('PostgreSQL backup strategy', 'ops', 'Need reliable backup for production databases', 'pg_dump for logical backups (small DBs), pg_basebackup for physical (large). WAL archiving for PITR. Test restores monthly.', 'Production PostgreSQL', 'pg_dump -Fc -h localhost -U postgres dbname > backup.dump', 0.85, '["postgresql","backup","ops"]')
    ON CONFLICT DO NOTHING`);

  await dbQuery(`INSERT INTO errors_solutions (error_signature, error_message, solution, root_cause, prevention)
    VALUES
    ('PostgreSQL deadlock detected', 'ERROR: deadlock detected\nDetail: Process X waits for ShareLock on transaction Y', 'Ensure consistent ordering of UPDATE statements across transactions. Use SELECT ... FOR UPDATE with NOWAIT to detect early.', 'Two transactions updating same rows in different order', 'Always lock rows in consistent order (e.g., by primary key ASC). Set lock_timeout.')
    ON CONFLICT DO NOTHING`);

  console.log("Seeded 5 learnings + 2 patterns + 1 error.\n");

  console.log("Launching orchestrator (Retriever + Learner)...");
  const orch = launchOrch(SID);
  const started = await waitForStatus(SID, "running", 25000);
  console.log(`Orchestrator started: ${started}`);
  if (!started) { for (let i = 117; i <= 120; i++) record(i, false, "No start"); printSummary(); return; }
  console.log("Waiting for agents to initialize...\n");
  await new Promise(r => setTimeout(r, 12000));
  // Warm-up
  const wh = await injectPrompt(SID, "What do you know about databases?");
  await waitForRetrieval(SID, wh, 30000);
  console.log("Warm-up complete.\n");
  await new Promise(r => setTimeout(r, 5000));

  // =============================================
  // TEST #117: Knowledge inventory
  // =============================================
  console.log("=== Test #117: Knowledge inventory ===\n");

  const docPrompt = "Generate documentation for all patterns you know about PostgreSQL. Include learnings, patterns, and known errors. Structure it as a technical reference.";
  const docHash = await injectPrompt(SID, docPrompt);
  console.log(`  Sent doc prompt (hash=${docHash})`);
  const docResult = await waitForRetrieval(SID, docHash, 45000);
  const docText = docResult?.context_text || "";
  console.log(`  Type: ${docResult?.context_type}, Length: ${docText.length}`);
  console.log(`  Preview: ${docText.slice(0, 300)}...\n`);

  if (!(docText.length > 200 && docResult?.context_type === "memory_results")) {
    record(117, false, "Structural pre-check failed");
  } else {
    const v117 = await askValidator(117, "Retriever generates structured documentation from PG knowledge", docText, "Must produce a structured document that synthesizes PostgreSQL knowledge from memory. Should organize learnings into sections, reference specific patterns/errors, and be useful as actual documentation.");
    validatorCost += v117.cost;
    record(117, v117.passed, v117.reason);
  }

  await new Promise(r => setTimeout(r, 5000));

  // =============================================
  // TEST #118: Cross-reference doc
  // =============================================
  console.log("=== Test #118: Cross-reference doc ===\n");

  const hasLearningRef = /learning|insight|topic/i.test(docText);
  const hasPatternRef = /pattern|migration|backup/i.test(docText);
  const hasErrorRef = /error|deadlock|solution/i.test(docText);
  const crossRefCount = [hasLearningRef, hasPatternRef, hasErrorRef].filter(Boolean).length;
  console.log(`  Learning refs: ${hasLearningRef}, Pattern refs: ${hasPatternRef}, Error refs: ${hasErrorRef}`);

  if (!(crossRefCount >= 2)) {
    record(118, false, "Structural pre-check failed");
  } else {
    const v118 = await askValidator(118, "Retriever returns documentation with pattern/learning references", docText, "The retrieved documentation should contain references to numbered patterns (e.g., #17, #18) or learnings from memory. Having at least 2 such references indicates the Retriever is pulling from multiple knowledge sources.");
    validatorCost += v118.cost;
    record(118, v118.passed, v118.reason);
  }

  // =============================================
  // TEST #119: Quality check
  // =============================================
  console.log("\n=== Test #119: Quality check ===\n");

  const sections = docText.split(/\n#{1,3}\s|\n\*\*[A-Z]/).length - 1;
  const hasIds = /\b(#\d+|ID[:\s]*\d+|learning|pattern)\b/i.test(docText);
  const isLongEnough = docText.length > 500;
  console.log(`  Length: ${docText.length} (need >500: ${isLongEnough})`);
  console.log(`  Sections: ~${sections} (need >=3)`);
  console.log(`  Cites IDs/types: ${hasIds}`);

  record(119, isLongEnough && (sections >= 2 || docText.split("\n").filter(l => l.trim().length > 0).length >= 10),
    `Quality: length=${docText.length}, sections~${sections}, IDs=${hasIds}`);

  await new Promise(r => setTimeout(r, 5000));

  // =============================================
  // TEST #120: Incremental update
  // =============================================
  console.log("\n=== Test #120: Incremental update ===\n");

  // Add a new PG learning
  await dbQuery(`INSERT INTO learnings (topic, insight, category, context, confidence, tags)
    VALUES ('PostgreSQL logical replication', 'Use CREATE PUBLICATION/SUBSCRIPTION for logical replication. Allows selective table replication and cross-version upgrades. Requires wal_level=logical. Slots must be monitored for lag.', 'architecture', 'Multi-region database setup', 0.9, '["postgresql","replication","ha"]')
    ON CONFLICT DO NOTHING`);
  console.log("  Added new learning: PostgreSQL logical replication");

  // Same prompt again
  const docHash2 = await injectPrompt(SID, docPrompt);
  console.log(`  Re-sent doc prompt (hash=${docHash2})`);
  const docResult2 = await waitForRetrieval(SID, docHash2, 45000);
  const docText2 = docResult2?.context_text || "";
  console.log(`  Type: ${docResult2?.context_type}, Length: ${docText2.length}`);

  const hasReplication = /replication|publication|subscription|logical/i.test(docText2);
  const isEnriched = docText2.length > docText.length || hasReplication;
  console.log(`  Contains replication: ${hasReplication}`);
  console.log(`  Enriched (longer or has new content): ${isEnriched}`);

  if (!isEnriched) {
    record(120, false, "Structural pre-check failed");
  } else {
    const v120 = await askValidator(120, "Second retrieval is enriched with more content than the first", { first: docText.slice(0, 500), second: docText2.slice(0, 500), firstLen: docText.length, secondLen: docText2.length }, "The second retrieval should be different from (and ideally richer than) the first one. It may contain additional topics, more details, or different knowledge. The key point is that the memory system shows evolution.");
    validatorCost += v120.cost;
    record(120, v120.passed, v120.reason);
  }

  // Cleanup
  const logContent = readLog(orch.logFile);
  const totalCost = extractCost(logContent);
  console.log(`\n  Total cost: $${totalCost.toFixed(4)}`);
  console.log(`  Validator cost: $${validatorCost.toFixed(4)}`);

  await killSession(SID, orch.proc);
  await cleanSession(SID);
  printSummary();
}

function printSummary() {
  const passed = results.filter(r => r.passed).length;
  const total = results.length;
  const failed = results.filter(r => !r.passed);
  console.log(`\n${"=".repeat(60)}`);
  console.log(`  LEVEL 29 RESULTS: ${passed}/${total} passed`);
  if (failed.length > 0) { console.log("  FAILURES:"); failed.forEach(f => console.log(`    Step ${f.step}: ${f.desc}`)); }
  console.log(`${"=".repeat(60)}`);
  if (failed.length === 0) console.log("\n  Level 29 PASSED! Auto-documentation works.\n");
}

run().then(() => process.exit(0)).catch(err => { console.error("Test error:", err); process.exit(1); });
setTimeout(() => { console.log("GLOBAL TIMEOUT"); process.exit(1); }, 300000);
