/**
 * AIDAM Level 22 — Scientific/Math Memory ("Je calcule")
 *
 * #88: Constant extraction — Learner extracts benchmarks/heuristics from observations
 * #89: Formula recall — Retriever applies learned heuristics to new questions
 * #90: Performance modeling — Learner saves performance impact data
 * #91: Optimization chain — Retriever combines batch sizing + indexing for compound recommendation
 *
 * AGI Level: 92/100
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
function launchOrch(sid, opts = {}) { const lf = `C:/Users/user/.claude/logs/aidam_orch_test22_${sid.slice(-8)}.log`; const fd = fs.openSync(lf, "w"); const p = spawn("node", [ORCHESTRATOR, `--session-id=${sid}`, "--cwd=C:/Users/user/IdeaProjects/ecopathsWebApp1b", `--retriever=${opts.retriever||"on"}`, `--learner=${opts.learner||"on"}`, "--compactor=off", "--project-slug=ecopaths"], { stdio: ["ignore", fd, fd], detached: false }); let ex = false; p.on("exit", () => { ex = true; }); return { proc: p, logFile: lf, isExited: () => ex }; }
async function killSession(sid, proc) { try { await dbQuery("UPDATE orchestrator_state SET status='stopping' WHERE session_id=$1", [sid]); } catch {} await new Promise(r => setTimeout(r, 4000)); try { proc.kill(); } catch {} await new Promise(r => setTimeout(r, 1000)); }
async function cleanSession(sid) { await dbQuery("DELETE FROM orchestrator_state WHERE session_id=$1", [sid]); await dbQuery("DELETE FROM cognitive_inbox WHERE session_id=$1", [sid]); await dbQuery("DELETE FROM retrieval_inbox WHERE session_id=$1", [sid]); }
async function injectToolUse(sid, pl) { const r = await dbQuery("INSERT INTO cognitive_inbox (session_id, message_type, payload, status) VALUES ($1, 'tool_use', $2, 'pending') RETURNING id", [sid, JSON.stringify(pl)]); return r.rows[0].id; }
async function injectPrompt(sid, prompt) { const h = crypto.createHash("sha256").update(prompt).digest("hex").slice(0, 16); await dbQuery("INSERT INTO cognitive_inbox (session_id, message_type, payload, status) VALUES ($1, 'prompt_context', $2, 'pending')", [sid, JSON.stringify({ prompt, prompt_hash: h, timestamp: Date.now() })]); return h; }
async function waitForProcessed(id, ms = 90000) { const s = Date.now(); while (Date.now() - s < ms) { const r = await dbQuery("SELECT status FROM cognitive_inbox WHERE id=$1", [id]); if (r.rows.length > 0 && /completed|failed/.test(r.rows[0].status)) return r.rows[0].status; await new Promise(r => setTimeout(r, 2000)); } return "timeout"; }
async function waitForRetrieval(sid, h, ms = 45000) { const s = Date.now(); while (Date.now() - s < ms) { const r = await dbQuery("SELECT context_type, context_text FROM retrieval_inbox WHERE session_id=$1 AND prompt_hash=$2 ORDER BY id DESC LIMIT 1", [sid, h]); if (r.rows.length > 0) return r.rows[0]; await new Promise(r => setTimeout(r, 1000)); } return null; }
function readLog(f) { try { return fs.readFileSync(f, "utf-8"); } catch { return ""; } }
function extractCost(log) { return (log.match(/cost: \$([0-9.]+)/g) || []).reduce((s, m) => s + parseFloat(m.replace("cost: $", "")), 0); }

async function run() {
  const SID = `level22-${Date.now()}`;
  let validatorCost = 0;
  console.log(`\n${"═".repeat(60)}`);
  console.log(`  AIDAM Level 22: Scientific/Math Memory ("Je calcule")`);
  console.log(`${"═".repeat(60)}`);
  console.log(`Session ID: ${SID}\n`);

  await cleanSession(SID);
  console.log("Launching orchestrator (Retriever + Learner)...");
  const orch = launchOrch(SID);
  const started = await waitForStatus(SID, "running", 25000);
  console.log(`Orchestrator started: ${started}`);
  if (!started) { for (let i = 88; i <= 91; i++) record(i, false, "No start"); printSummary(); return; }
  console.log("Waiting for agents to initialize...\n");
  await new Promise(r => setTimeout(r, 12000));
  const wh = await injectPrompt(SID, "What projects are stored in memory?");
  await waitForRetrieval(SID, wh, 30000);
  console.log("Warm-up complete.\n");
  await new Promise(r => setTimeout(r, 8000));

  // ═══════════════════════════════════════════════════════════
  // TEST #88: Constant extraction — batch size benchmarks
  // ═══════════════════════════════════════════════════════════
  console.log("=== Test #88: Constant extraction (batch benchmarks) ===\n");

  const bench = await injectToolUse(SID, {
    tool_name: "Bash",
    tool_input: { command: 'java -jar benchmark-runner.jar --test batch-insert' },
    tool_response: `Batch INSERT benchmark on activities_user (PostgreSQL, 1M rows target):

Batch size 100:  45.2s total, 450ms/batch — too many round trips
Batch size 500:  12.3s total, 61ms/batch — good throughput
Batch size 1000: 11.8s total, 118ms/batch — similar to 500, slightly better
Batch size 2000: 18.7s total, 374ms/batch — WORSE, memory pressure starts
Batch size 5000: 42.1s total, 2105ms/batch — OOM risk, GC pauses

Conclusion: Optimal batch size is 500-1000 for PostgreSQL JPA batch inserts.
Above 1000, performance degrades non-linearly due to JDBC buffer allocation and GC pressure.
Formula: optimal_batch ≈ 500 + (available_heap_MB / 10), capped at 1500.`
  });
  console.log(`  Benchmark observation (id=${bench})`);
  const s1 = await waitForProcessed(bench, 90000);
  console.log(`  Learner: ${s1}`);

  await new Promise(r => setTimeout(r, 3000));

  // Check saved
  const benchLearnings = await dbQuery("SELECT id, topic FROM learnings WHERE topic ILIKE '%batch%' OR insight ILIKE '%batch%size%' OR insight ILIKE '%500%1000%' ORDER BY id DESC LIMIT 5");
  const benchPatterns = await dbQuery("SELECT id, name FROM patterns WHERE name ILIKE '%batch%' OR context ILIKE '%batch%' ORDER BY id DESC LIMIT 5");
  console.log(`  Batch learnings: ${benchLearnings.rows.length}`);
  console.log(`  Batch patterns: ${benchPatterns.rows.length}`);

  record(88, benchLearnings.rows.length >= 1 || benchPatterns.rows.length >= 1,
    `Constant extraction: learnings=${benchLearnings.rows.length}, patterns=${benchPatterns.rows.length}`);

  await new Promise(r => setTimeout(r, 5000));

  // ═══════════════════════════════════════════════════════════
  // TEST #89: Formula recall
  // ═══════════════════════════════════════════════════════════
  console.log("\n=== Test #89: Formula recall ===\n");

  const formulaPrompt = "NEW TASK: I'm implementing a product import feature that will INSERT 50,000 rows into the activities_user table. I remember we ran benchmarks on batch sizes — what was the optimal batch size and the formula we found? What happens above 1000?";
  const formulaHash = await injectPrompt(SID, formulaPrompt);
  console.log(`  Sent formula prompt (hash=${formulaHash})`);

  const formulaResult = await waitForRetrieval(SID, formulaHash, 45000);
  const formulaText = formulaResult?.context_text || "";
  console.log(`  Retriever type: ${formulaResult?.context_type || "timeout"}`);
  console.log(`  Length: ${formulaText.length} chars`);
  console.log(`  Preview: ${formulaText.slice(0, 400)}`);

  const mentionsBatch = /batch.*size|batch.*500|batch.*1000/i.test(formulaText);
  const mentionsOptimal = /optimal|recommend|500|1000/i.test(formulaText);
  const mentionsDegradation = /degrad|non.?linear|worse|OOM|memory|2000/i.test(formulaText);

  console.log(`  Mentions batch size: ${mentionsBatch}`);
  console.log(`  Mentions optimal range: ${mentionsOptimal}`);
  console.log(`  Mentions degradation: ${mentionsDegradation}`);

  if (!(formulaText.length > 100 && mentionsBatch)) {
    record(89, false, "Structural pre-check failed: text too short or no batch mention");
  } else {
    const v89 = await askValidator(89, "Retriever recalls batch size formula with correct values", formulaText, "Must include specific numeric values (batch sizes like 500, 1000) and the relationship between batch size and performance. Should mention degradation at large sizes.");
    validatorCost += v89.cost;
    record(89, v89.passed, v89.reason);
  }

  await new Promise(r => setTimeout(r, 5000));

  // ═══════════════════════════════════════════════════════════
  // TEST #90: Performance modeling — indexing impact
  // ═══════════════════════════════════════════════════════════
  console.log("\n=== Test #90: Performance modeling ===\n");

  const indexObs = await injectToolUse(SID, {
    tool_name: "Bash",
    tool_input: { command: 'psql -c "EXPLAIN ANALYZE SELECT * FROM activities_user WHERE product_id = 42"' },
    tool_response: `Query performance before/after indexing on activities_user (1.2M rows):

BEFORE index (Seq Scan):
  Execution Time: 2,847ms
  Rows scanned: 1,200,000
  Plan: Seq Scan on activities_user (cost=0.00..28847.00)

CREATE INDEX idx_activities_product ON activities_user(product_id);

AFTER index (Index Scan):
  Execution Time: 0.34ms
  Rows scanned: 47
  Plan: Index Scan using idx_activities_product (cost=0.43..8.45)

Speedup: 8,373x improvement (2847ms → 0.34ms)
Rule of thumb: Any column used in WHERE with >100k rows MUST have an index.
B-tree index on integer column: ~32MB overhead for 1M rows.`
  });
  console.log(`  Index observation (id=${indexObs})`);
  const s2 = await waitForProcessed(indexObs, 90000);
  console.log(`  Learner: ${s2}`);

  await new Promise(r => setTimeout(r, 3000));

  const indexLearnings = await dbQuery("SELECT id, topic FROM learnings WHERE topic ILIKE '%index%' OR insight ILIKE '%index%' OR insight ILIKE '%speedup%' ORDER BY id DESC LIMIT 5");
  const indexPatterns = await dbQuery("SELECT id, name FROM patterns WHERE name ILIKE '%index%' OR context ILIKE '%index%' OR solution ILIKE '%index%' ORDER BY id DESC LIMIT 5");
  console.log(`  Index learnings: ${indexLearnings.rows.length}`);
  console.log(`  Index patterns: ${indexPatterns.rows.length}`);

  record(90, indexLearnings.rows.length >= 1 || indexPatterns.rows.length >= 1,
    `Performance modeling: learnings=${indexLearnings.rows.length}, patterns=${indexPatterns.rows.length}`);

  await new Promise(r => setTimeout(r, 5000));

  // ═══════════════════════════════════════════════════════════
  // TEST #91: Optimization chain — combine batch + indexing
  // ═══════════════════════════════════════════════════════════
  console.log("\n=== Test #91: Optimization chain ===\n");

  const chainPrompt = "NEW TASK: Performance crisis — our /api/products/import endpoint takes 30 minutes for 500K records, AND the subsequent SELECT queries on activities_user by product_id are also slow (2+ seconds). We need to fix BOTH the batch insert throughput AND the query speed. What do our benchmarks and indexing tests tell us?";
  const chainHash = await injectPrompt(SID, chainPrompt);
  console.log(`  Sent optimization chain prompt (hash=${chainHash})`);

  const chainResult = await waitForRetrieval(SID, chainHash, 45000);
  const chainText = chainResult?.context_text || "";
  console.log(`  Retriever type: ${chainResult?.context_type || "timeout"}`);
  console.log(`  Length: ${chainText.length} chars`);
  console.log(`  Preview: ${chainText.slice(0, 400)}`);

  const mentionsBatchChain = /batch|500|1000|bulk/i.test(chainText);
  const mentionsIndexChain = /index|B.?tree|CREATE INDEX/i.test(chainText);
  const combined = mentionsBatchChain && mentionsIndexChain;

  console.log(`  Mentions batch optimization: ${mentionsBatchChain}`);
  console.log(`  Mentions indexing: ${mentionsIndexChain}`);
  console.log(`  Combined knowledge: ${combined}`);

  if (!(chainText.length > 100)) {
    record(91, false, "Structural pre-check failed: retrieval text too short");
  } else {
    const v91 = await askValidator(91, "Retriever recalls both batch processing and indexing knowledge", chainText, "The retrieval should contain knowledge about both batch processing AND indexing/performance optimization. Both topics should be represented in the response, providing useful details for optimizing write performance.");
    validatorCost += v91.cost;
    record(91, v91.passed, v91.reason);
  }

  // Cost
  const logContent = readLog(orch.logFile);
  const totalCost = extractCost(logContent);
  const apiCalls = (logContent.match(/cost: \$/g) || []).length;
  console.log(`\n=== Cost Summary ===`);
  console.log(`  Total cost: $${totalCost.toFixed(4)}`);
  console.log(`  API calls: ${apiCalls}`);

  console.log(`  Validator cost: $${validatorCost.toFixed(4)}`);

  console.log(`\n--- Orchestrator Log (last 3000 chars) ---`);
  console.log(logContent.slice(-3000));
  console.log("--- End Log ---\n");

  await killSession(SID, orch.proc);
  await cleanSession(SID);
  printSummary();
}

function printSummary() {
  const passed = results.filter(r => r.passed).length;
  const total = results.length;
  const failed = results.filter(r => !r.passed);
  console.log(`\n${"═".repeat(60)}`);
  console.log(`  LEVEL 22 RESULTS: ${passed}/${total} passed`);
  if (failed.length > 0) { console.log("  FAILURES:"); failed.forEach(f => console.log(`    Step ${f.step}: ${f.desc}`)); }
  console.log(`${"═".repeat(60)}`);
  if (failed.length === 0) {
    console.log(`\n████████████████████████████████████████████████████████████
█   ALL LEVEL 22 TESTS PASSED — SCIENTIFIC MEMORY!        █
█   AIDAM extracts benchmarks, recalls formulas, models   █
█   performance, and chains optimizations together.       █
████████████████████████████████████████████████████████████\n`);
  }
}

run().then(() => process.exit(0)).catch(err => { console.error("Test error:", err); process.exit(1); });
setTimeout(() => { console.log("GLOBAL TIMEOUT"); process.exit(1); }, 600000);
