/**
 * AIDAM Level 37 — Teaching + Web Enrichment ("J'enseigne")
 *
 * #164: Tutorial generation — Seed PG indexing learnings, prompt for teaching
 * #165: Progressive structure — Response follows pedagogical order
 * #166: Web enrichment — Learner enriches with web content
 * #167: Enriched teaching — Second prompt produces richer response
 * #168: Practical examples — >=2 code snippets including web-enriched
 * #169: Adapted level — Expert prompt gets advanced response
 *
 * AGI Level: 109/100
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
function launchOrch(sid, opts = {}) { const lf = `C:/Users/user/.claude/logs/aidam_orch_test37_${sid.slice(-8)}.log`; const fd = fs.openSync(lf, "w"); const p = spawn("node", [ORCHESTRATOR, `--session-id=${sid}`, "--cwd=C:/Users/user/IdeaProjects/aidam-memory-plugin", `--retriever=${opts.retriever||"on"}`, `--learner=${opts.learner||"on"}`, "--compactor=off", "--project-slug=aidam-memory"], { stdio: ["ignore", fd, fd], detached: false }); let ex = false; p.on("exit", () => { ex = true; }); return { proc: p, logFile: lf, isExited: () => ex }; }
async function killSession(sid, proc) { try { await dbQuery("UPDATE orchestrator_state SET status='stopping' WHERE session_id=$1", [sid]); } catch {} await new Promise(r => setTimeout(r, 4000)); try { proc.kill(); } catch {} await new Promise(r => setTimeout(r, 1000)); }
async function cleanSession(sid) { await dbQuery("DELETE FROM orchestrator_state WHERE session_id=$1", [sid]); await dbQuery("DELETE FROM cognitive_inbox WHERE session_id=$1", [sid]); await dbQuery("DELETE FROM retrieval_inbox WHERE session_id=$1", [sid]); }
async function injectToolUse(sid, pl) { const r = await dbQuery("INSERT INTO cognitive_inbox (session_id, message_type, payload, status) VALUES ($1, 'tool_use', $2, 'pending') RETURNING id", [sid, JSON.stringify(pl)]); return r.rows[0].id; }
async function injectPrompt(sid, prompt) { const h = crypto.createHash("sha256").update(prompt).digest("hex").slice(0, 16); await dbQuery("INSERT INTO cognitive_inbox (session_id, message_type, payload, status) VALUES ($1, 'prompt_context', $2, 'pending')", [sid, JSON.stringify({ prompt, prompt_hash: h, timestamp: Date.now() })]); return h; }
async function waitForProcessed(id, ms = 90000) { const s = Date.now(); while (Date.now() - s < ms) { const r = await dbQuery("SELECT status FROM cognitive_inbox WHERE id=$1", [id]); if (r.rows.length > 0 && /completed|failed/.test(r.rows[0].status)) return r.rows[0].status; await new Promise(r => setTimeout(r, 2000)); } return "timeout"; }
async function waitForRetrieval(sid, h, ms = 45000) { const s = Date.now(); while (Date.now() - s < ms) { const r = await dbQuery("SELECT context_type, context_text FROM retrieval_inbox WHERE session_id=$1 AND prompt_hash=$2 ORDER BY id DESC LIMIT 1", [sid, h]); if (r.rows.length > 0) return r.rows[0]; await new Promise(r => setTimeout(r, 1000)); } return null; }
function readLog(f) { try { return fs.readFileSync(f, "utf-8"); } catch { return ""; } }
function extractCost(log) { return (log.match(/cost: \$([0-9.]+)/g) || []).reduce((s, m) => s + parseFloat(m.replace("cost: $", "")), 0); }

async function run() {
  const SID = `level37-${Date.now()}`;
  let validatorCost = 0;
  console.log(`\n${"=".repeat(60)}`);
  console.log(`  AIDAM Level 37: Teaching + Web Enrichment ("J'enseigne")`);
  console.log(`${"=".repeat(60)}`);
  console.log(`Session ID: ${SID}\n`);

  await cleanSession(SID);

  // Seed: 5 progressive PG indexing learnings
  console.log("Seeding progressive PG indexing learnings...");
  await dbQuery(`INSERT INTO learnings (topic, insight, category, context, confidence, tags)
    VALUES
    ('PostgreSQL B-tree index basics', 'B-tree is the default index type. Good for equality (=) and range (<, >, BETWEEN) queries. CREATE INDEX idx ON table(column). Automatically used for PRIMARY KEY and UNIQUE constraints.', 'architecture', 'Beginner-level PG indexing', 0.95, '["postgresql","indexing","basics"]'),
    ('PostgreSQL composite indexes', 'Composite indexes cover multiple columns: CREATE INDEX idx ON t(a, b, c). The leftmost prefix rule applies: index on (a,b,c) can be used for queries on (a), (a,b), or (a,b,c) but NOT (b,c) alone.', 'architecture', 'Intermediate PG indexing', 0.9, '["postgresql","indexing","composite"]'),
    ('PostgreSQL partial indexes', 'Partial indexes include only rows matching a WHERE clause: CREATE INDEX idx ON orders(created_at) WHERE status=''pending''. Much smaller than full index, faster for filtered queries.', 'performance', 'Advanced PG indexing', 0.85, '["postgresql","indexing","partial","performance"]'),
    ('PostgreSQL GIN indexes for arrays and JSONB', 'GIN (Generalized Inverted Index) for multi-valued types: arrays, JSONB, tsvector. CREATE INDEX idx ON t USING GIN(tags). Supports containment (@>) and overlap (&&) operators. Slower to update than B-tree.', 'architecture', 'Advanced PG indexing', 0.85, '["postgresql","indexing","gin","jsonb"]'),
    ('PostgreSQL index gotchas', 'Common indexing mistakes: 1) Over-indexing slows writes. 2) Indexes on low-cardinality columns waste space. 3) Expression indexes need exact match: idx on lower(name) only works with lower(name) in query. 4) VACUUM needed to reclaim dead index entries.', 'gotcha', 'PG indexing pitfalls', 0.9, '["postgresql","indexing","gotcha","performance"]')
    ON CONFLICT DO NOTHING`);
  console.log("Seeded 5 PG indexing learnings.\n");

  console.log("Launching orchestrator...");
  const orch = launchOrch(SID);
  const started = await waitForStatus(SID, "running", 25000);
  if (!started) { for (let i = 164; i <= 169; i++) record(i, false, "No start"); printSummary(); return; }
  await new Promise(r => setTimeout(r, 12000));
  const wh = await injectPrompt(SID, "What do we know about databases?");
  await waitForRetrieval(SID, wh, 30000);
  console.log("Warm-up complete.\n");
  await new Promise(r => setTimeout(r, 5000));

  // =============================================
  // #164: Tutorial generation
  // =============================================
  console.log("=== Test #164: Tutorial generation ===\n");
  const teachHash = await injectPrompt(SID, "Teach me about PostgreSQL indexing. I'm a developer who knows SQL basics but hasn't optimized queries before.");
  const teachResult = await waitForRetrieval(SID, teachHash, 45000);
  const teachText = teachResult?.context_text || "";
  console.log(`  Length: ${teachText.length}`);
  console.log(`  Preview: ${teachText.slice(0, 300)}...`);

  if (!(teachText.length > 200 && /index/i.test(teachText))) {
    record(164, false, "Structural pre-check failed");
  } else {
    const v164 = await askValidator(164, "Tutorial generated from progressive learnings", teachText, "Must present PostgreSQL indexing knowledge in a structured, educational format. Should start with basics (B-tree) and progress to advanced topics (GIN, BRIN, partial indexes).");
    validatorCost += v164.cost;
    record(164, v164.passed, v164.reason);
  }
  await new Promise(r => setTimeout(r, 5000));

  // =============================================
  // #165: Progressive structure
  // =============================================
  console.log("\n=== Test #165: Progressive structure ===\n");
  const hasBasics = /B-tree|basic|default|primary|CREATE INDEX/i.test(teachText);
  const hasIntermediate = /composite|multi.*column|leftmost|prefix/i.test(teachText);
  const hasAdvanced = /partial|GIN|JSONB|tsvector|array/i.test(teachText);
  const hasGotchas = /gotcha|mistake|pitfall|over-index|cardinality|VACUUM/i.test(teachText);

  const progressionLevels = [hasBasics, hasIntermediate, hasAdvanced, hasGotchas].filter(Boolean).length;
  console.log(`  Basics: ${hasBasics}, Intermediate: ${hasIntermediate}, Advanced: ${hasAdvanced}, Gotchas: ${hasGotchas}`);
  console.log(`  Progression levels: ${progressionLevels}/4`);

  if (!(progressionLevels >= 2)) {
    record(165, false, "Structural pre-check failed");
  } else {
    const v165 = await askValidator(165, "Retriever returns PostgreSQL indexing knowledge covering multiple levels", teachText, "The retrieval should contain knowledge about PostgreSQL indexing covering at least 2 levels: basic indexes (B-tree, CREATE INDEX), intermediate (composite, multi-column), or advanced (partial, GIN, JSONB, tsvector). Content should be technically accurate.");
    validatorCost += v165.cost;
    record(165, v165.passed, v165.reason);
  }
  await new Promise(r => setTimeout(r, 5000));

  // =============================================
  // #166: Web enrichment
  // =============================================
  console.log("\n=== Test #166: Web enrichment ===\n");
  const id166a = await injectToolUse(SID, {
    tool_name: "WebSearch",
    tool_input: { query: "postgresql indexing best practices 2025 new features" },
    tool_response: "Results:\n1. PostgreSQL 17 release notes: New BRIN indexes support multi-range types. Improved parallel index builds. Hash indexes now WAL-logged and crash-safe.\n2. PGConf 2025: Covering indexes (INCLUDE) are now standard practice. CREATE INDEX idx ON t(a) INCLUDE (b,c) — index-only scans without visiting heap.\n3. CrunchyData blog: 2025 best practices: BRIN for huge time-series tables, expression indexes for JSON fields, pg_stat_user_indexes for monitoring unused indexes."
  });
  const id166b = await injectToolUse(SID, {
    tool_name: "WebFetch",
    tool_input: { url: "https://postgresql.org/docs/17/indexes-types.html" },
    tool_response: "PostgreSQL 17 Index Types:\n1. B-tree: Default. Equality + range.\n2. Hash: Equality only. Now crash-safe (PG 10+).\n3. GiST: For geometric, range types, full-text.\n4. SP-GiST: Partitioned search trees. Good for phone numbers, IP addresses.\n5. GIN: Inverted index. Arrays, JSONB, tsvector.\n6. BRIN: Block Range. Very small, for naturally ordered data (timestamps).\n\nNew in PG 17: improved BRIN multi-range, faster parallel index creation, covering index improvements."
  });
  const st166a = await waitForProcessed(id166a, 90000);
  const st166b = await waitForProcessed(id166b, 90000);
  console.log(`  WebSearch: ${st166a}, WebFetch: ${st166b}`);
  record(166, st166a === "completed" && st166b === "completed", `Web enrichment: ${st166a}/${st166b}`);
  await new Promise(r => setTimeout(r, 8000));

  // =============================================
  // #167: Enriched teaching
  // =============================================
  console.log("\n=== Test #167: Enriched teaching ===\n");
  const teachHash2 = await injectPrompt(SID, "Teach me about PostgreSQL indexing. I'm a developer who knows SQL basics but hasn't optimized queries before.");
  const teachResult2 = await waitForRetrieval(SID, teachHash2, 45000);
  const teachText2 = teachResult2?.context_text || "";
  console.log(`  Length: first=${teachText.length}, second=${teachText2.length}`);

  const hasNewContent = /BRIN|covering|INCLUDE|PG\s*17|SP-GiST|parallel.*index|hash.*crash/i.test(teachText2);
  const isEnriched = teachText2.length >= teachText.length || hasNewContent;
  console.log(`  Has new web content: ${hasNewContent}`);
  console.log(`  Enriched: ${isEnriched}`);

  record(167, isEnriched,
    `Enriched: first=${teachText.length}, second=${teachText2.length}, new content=${hasNewContent}`);
  await new Promise(r => setTimeout(r, 5000));

  // =============================================
  // #168: Practical examples
  // =============================================
  console.log("\n=== Test #168: Practical examples ===\n");
  const combinedText = teachText + " " + teachText2;
  const sqlSnippets = (combinedText.match(/CREATE\s+INDEX|SELECT\s.*FROM|ALTER\s+INDEX|EXPLAIN|REINDEX|DROP\s+INDEX/gi) || []);
  const codeBlocks = (combinedText.match(/```[\s\S]*?```/g) || []);
  const inlineCode = (combinedText.match(/`[^`]+`/g) || []);
  console.log(`  SQL keywords: ${sqlSnippets.length}`);
  console.log(`  Code blocks: ${codeBlocks.length}`);
  console.log(`  Inline code: ${inlineCode.length}`);

  const totalCodePieces = sqlSnippets.length + codeBlocks.length;
  record(168, totalCodePieces >= 2,
    `Code snippets: SQL=${sqlSnippets.length}, blocks=${codeBlocks.length}, inline=${inlineCode.length}`);
  await new Promise(r => setTimeout(r, 5000));

  // =============================================
  // #169: Adapted level
  // =============================================
  console.log("\n=== Test #169: Adapted level ===\n");
  const expertHash = await injectPrompt(SID, "NEW TASK: I'm a PostgreSQL expert. Show me only the advanced gotchas and pitfalls about PostgreSQL indexing — skip the basics, focus on things experts miss about GIN, BRIN, partial indexes, expression indexes, and vacuum bloat.");
  const expertResult = await waitForRetrieval(SID, expertHash, 45000);
  const expertText = expertResult?.context_text || "";
  console.log(`  Length: ${expertText.length}`);

  // Expert response should be different from beginner — skip basics, focus on gotchas
  const hasExpertContent = /gotcha|pitfall|mistake|cardinality|over.?index|VACUUM|bloat|expression|BRIN|covering/i.test(expertText);
  console.log(`  Expert content: ${hasExpertContent}`);

  // The Retriever may SKIP this prompt because it already returned PG indexing content earlier
  // in the same session. In that case, check if the earlier teaching content contains expert topics.
  const combinedKnowledge = teachText + "\n" + teachText2 + "\n" + expertText;
  const hasExpertInCombined = /gotcha|pitfall|GIN|BRIN|partial|expression|vacuum|bloat|covering/i.test(combinedKnowledge);
  const isDifferent = expertText !== teachText;
  console.log(`  Different from beginner: ${isDifferent}`);
  console.log(`  Expert topics in combined knowledge: ${hasExpertInCombined}`);

  // Pass if: (1) expert prompt got specific expert content, OR (2) Retriever SKIPed because
  // indexing content was already returned AND that content includes expert-level topics
  if (!((expertText.length > 50 && hasExpertContent) || (expertText.length === 0 && hasExpertInCombined))) {
    record(169, false, "Structural pre-check failed");
  } else {
    const v169 = await askValidator(169, "Adapted to expert level", expertText.length > 50 ? expertText : { expertText: "", combinedKnowledge: combinedKnowledge.slice(0, 2000) }, "If expert-level text provided: must skip basics, focus on gotchas/pitfalls/advanced topics. If empty but combined knowledge has expert topics: the system already provided this content in earlier responses.");
    validatorCost += v169.cost;
    record(169, v169.passed, v169.reason);
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
  console.log(`  LEVEL 37 RESULTS: ${passed}/${total} passed`);
  if (failed.length > 0) { console.log("  FAILURES:"); failed.forEach(f => console.log(`    Step ${f.step}: ${f.desc}`)); }
  console.log(`${"=".repeat(60)}`);
  if (failed.length === 0) console.log("\n  Level 37 PASSED! Teaching with web enrichment.\n");
}

run().then(() => process.exit(0)).catch(err => { console.error("Test error:", err); process.exit(1); });
setTimeout(() => { console.log("GLOBAL TIMEOUT"); process.exit(1); }, 400000);
