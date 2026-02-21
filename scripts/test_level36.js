/**
 * AIDAM Level 36 — Self-Improvement ("Je m'ameliore")
 *
 * #159: Performance observation — Learner observes retrieval hit/miss data
 * #160: Weakness identification — Learner identifies "fails on vague prompts"
 * #161: Web research for solutions — Learner saves IR improvement techniques
 * #162: Improvement suggestion — Retriever synthesizes failures + web solutions
 * #163: Meta-learning — DB has learning about AIDAM itself
 *
 * AGI Level: 108/100
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
function launchOrch(sid, opts = {}) { const lf = `C:/Users/user/.claude/logs/aidam_orch_test36_${sid.slice(-8)}.log`; const fd = fs.openSync(lf, "w"); const p = spawn("node", [ORCHESTRATOR, `--session-id=${sid}`, "--cwd=C:/Users/user/IdeaProjects/aidam-memory-plugin", `--retriever=${opts.retriever||"on"}`, `--learner=${opts.learner||"on"}`, "--compactor=off", "--project-slug=aidam-memory"], { stdio: ["ignore", fd, fd], detached: false }); let ex = false; p.on("exit", () => { ex = true; }); return { proc: p, logFile: lf, isExited: () => ex }; }
async function killSession(sid, proc) { try { await dbQuery("UPDATE orchestrator_state SET status='stopping' WHERE session_id=$1", [sid]); } catch {} await new Promise(r => setTimeout(r, 4000)); try { proc.kill(); } catch {} await new Promise(r => setTimeout(r, 1000)); }
async function cleanSession(sid) { await dbQuery("DELETE FROM orchestrator_state WHERE session_id=$1", [sid]); await dbQuery("DELETE FROM cognitive_inbox WHERE session_id=$1", [sid]); await dbQuery("DELETE FROM retrieval_inbox WHERE session_id=$1", [sid]); }
async function injectToolUse(sid, pl) { const r = await dbQuery("INSERT INTO cognitive_inbox (session_id, message_type, payload, status) VALUES ($1, 'tool_use', $2, 'pending') RETURNING id", [sid, JSON.stringify(pl)]); return r.rows[0].id; }
async function injectPrompt(sid, prompt) { const h = crypto.createHash("sha256").update(prompt).digest("hex").slice(0, 16); await dbQuery("INSERT INTO cognitive_inbox (session_id, message_type, payload, status) VALUES ($1, 'prompt_context', $2, 'pending')", [sid, JSON.stringify({ prompt, prompt_hash: h, timestamp: Date.now() })]); return h; }
async function waitForProcessed(id, ms = 90000) { const s = Date.now(); while (Date.now() - s < ms) { const r = await dbQuery("SELECT status FROM cognitive_inbox WHERE id=$1", [id]); if (r.rows.length > 0 && /completed|failed/.test(r.rows[0].status)) return r.rows[0].status; await new Promise(r => setTimeout(r, 2000)); } return "timeout"; }
async function waitForRetrieval(sid, h, ms = 45000) { const s = Date.now(); while (Date.now() - s < ms) { const r = await dbQuery("SELECT context_type, context_text FROM retrieval_inbox WHERE session_id=$1 AND prompt_hash=$2 ORDER BY id DESC LIMIT 1", [sid, h]); if (r.rows.length > 0) return r.rows[0]; await new Promise(r => setTimeout(r, 1000)); } return null; }
function readLog(f) { try { return fs.readFileSync(f, "utf-8"); } catch { return ""; } }
function extractCost(log) { return (log.match(/cost: \$([0-9.]+)/g) || []).reduce((s, m) => s + parseFloat(m.replace("cost: $", "")), 0); }

async function run() {
  const SID = `level36-${Date.now()}`;
  let validatorCost = 0;
  console.log(`\n${"=".repeat(60)}`);
  console.log(`  AIDAM Level 36: Self-Improvement ("Je m'ameliore")`);
  console.log(`${"=".repeat(60)}`);
  console.log(`Session ID: ${SID}\n`);

  await cleanSession(SID);

  console.log("Launching orchestrator...");
  const orch = launchOrch(SID);
  const started = await waitForStatus(SID, "running", 25000);
  if (!started) { for (let i = 159; i <= 163; i++) record(i, false, "No start"); printSummary(); return; }
  await new Promise(r => setTimeout(r, 12000));
  const wh = await injectPrompt(SID, "How does AIDAM perform?");
  await waitForRetrieval(SID, wh, 30000);
  console.log("Warm-up complete.\n");
  await new Promise(r => setTimeout(r, 5000));

  // =============================================
  // #159: Performance observation
  // =============================================
  console.log("=== Test #159: Performance observation ===\n");
  const id159 = await injectToolUse(SID, {
    tool_name: "Bash",
    tool_input: { command: "psql -c \"SELECT prompt_hash, context_type, length(context_text) FROM retrieval_inbox ORDER BY id DESC LIMIT 10\"" },
    tool_response: "AIDAM Retriever performance analysis (last 10 retrievals):\n\nRESULTS RELEVANT (5/10):\n1. prompt='Fix SQL column error' → context=1200 chars, matched error_solution [RELEVANT]\n2. prompt='Docker memory optimization' → context=800 chars, matched pattern [RELEVANT]\n3. prompt='Spring Security JWT setup' → context=950 chars, matched pattern [RELEVANT]\n4. prompt='PostgreSQL indexing best practices' → context=1500 chars, matched 3 learnings [RELEVANT]\n5. prompt='React useEffect cleanup' → context=600 chars, matched pattern [RELEVANT]\n\nRESULTS IRRELEVANT (5/10):\n6. prompt='Hello, how are you?' → context=300 chars, returned generic info [IRRELEVANT - should SKIP]\n7. prompt='Continue with the task' → context=200 chars, returned old context [IRRELEVANT - should SKIP]\n8. prompt='OK' → context=150 chars, returned noise [IRRELEVANT - should SKIP]\n9. prompt='Sure, go ahead' → context=100 chars, returned noise [IRRELEVANT - should SKIP]\n10. prompt='Thanks' → context=50 chars, returned noise [IRRELEVANT - should SKIP]\n\nPattern: Specific technical prompts get relevant results. Vague/conversational prompts waste budget and return noise. The Retriever needs a way to detect and SKIP non-informational prompts."
  });
  const st159 = await waitForProcessed(id159, 90000);
  console.log(`  Status: ${st159}`);
  record(159, st159 === "completed", `Performance observation: ${st159}`);
  await new Promise(r => setTimeout(r, 5000));

  // =============================================
  // #160: Weakness identification
  // =============================================
  console.log("\n=== Test #160: Weakness identification ===\n");
  // Check if Learner saved a weakness learning
  await new Promise(r => setTimeout(r, 3000));
  const weakCheck = await dbQuery(`
    SELECT topic, insight FROM learnings
    WHERE topic ILIKE '%retriever%fail%' OR topic ILIKE '%vague%prompt%' OR topic ILIKE '%retrieval%weakness%'
       OR topic ILIKE '%SKIP%' OR insight ILIKE '%vague%prompt%' OR insight ILIKE '%retriever%fail%'
       OR topic ILIKE '%AIDAM%improve%' OR insight ILIKE '%conversational%prompt%'
    ORDER BY created_at DESC LIMIT 5
  `);
  console.log(`  Weakness learnings: ${weakCheck.rows.length}`);
  weakCheck.rows.forEach(r => console.log(`    ${r.topic}: ${(r.insight || "").slice(0, 80)}...`));

  if (!(weakCheck.rows.length > 0 || st159 === "completed")) {
    record(160, false, "Structural pre-check failed");
  } else {
    const v160 = await askValidator(160, "Learner identifies AIDAM's own weaknesses", weakCheck.rows.length > 0 ? weakCheck.rows : { status: st159, learningsFound: 0 }, "Must identify specific weaknesses in the Retriever (e.g., wasted retrievals on simple prompts, low hit rate). Should cite concrete observations, not vague claims.");
    validatorCost += v160.cost;
    record(160, v160.passed, v160.reason);
  }
  await new Promise(r => setTimeout(r, 5000));

  // =============================================
  // #161: Web research for solutions
  // =============================================
  console.log("\n=== Test #161: Web research for IR solutions ===\n");
  const id161a = await injectToolUse(SID, {
    tool_name: "WebSearch",
    tool_input: { query: "information retrieval precision improvement techniques query expansion reranking" },
    tool_response: "Results:\n1. ACM Survey: Modern IR improvements: query expansion (adding synonyms/related terms), BM25 reranking, cross-encoder reranking, hybrid search (keyword + semantic).\n2. Elasticsearch blog: Boosting precision: use multi-match with 'best_fields' type, field boosting, minimum_should_match. For fuzzy: trigram matching + edit distance.\n3. LlamaIndex docs: RAG improvements: query decomposition, HyDE (hypothetical document embeddings), contextual compression, parent-child chunk retrieval."
  });
  const id161b = await injectToolUse(SID, {
    tool_name: "WebFetch",
    tool_input: { url: "https://arxiv.org/abs/2305.12345" },
    tool_response: "Paper: 'Improving Retrieval-Augmented Generation with Query Classification'\n\nAbstract: We propose classifying queries into informational vs conversational before retrieval. Conversational queries (greetings, acknowledgments, simple yes/no) should bypass retrieval entirely. This reduces noise by 40% and improves precision from 0.65 to 0.82.\n\nKey techniques:\n1. Query intent classifier (few-shot with LLM)\n2. Minimum query complexity threshold\n3. Result confidence scoring (filter low-confidence)\n4. Hybrid search: BM25 + semantic similarity"
  });
  const st161a = await waitForProcessed(id161a, 90000);
  const st161b = await waitForProcessed(id161b, 90000);
  console.log(`  WebSearch: ${st161a}, WebFetch: ${st161b}`);
  record(161, st161a === "completed" && st161b === "completed", `IR research: ${st161a}/${st161b}`);
  await new Promise(r => setTimeout(r, 8000));

  // =============================================
  // #162: Improvement suggestion
  // =============================================
  console.log("\n=== Test #162: Improvement suggestion ===\n");
  const impHash = await injectPrompt(SID, "How can AIDAM be improved? What are its current weaknesses and what solutions have been found?");
  const impResult = await waitForRetrieval(SID, impHash, 45000);
  const impText = impResult?.context_text || "";
  console.log(`  Length: ${impText.length}`);

  const hasWeakness = /fail|weakness|vague|noise|irrelevant|skip/i.test(impText);
  const hasSolution = /query.*class|expansion|rerank|hybrid|precision|intent/i.test(impText);
  const hasSpecific = impText.length > 100;
  console.log(`  Mentions weaknesses: ${hasWeakness}`);
  console.log(`  Mentions solutions: ${hasSolution}`);

  if (!(hasSpecific && (hasWeakness || hasSolution))) {
    record(162, false, "Structural pre-check failed");
  } else {
    const v162 = await askValidator(162, "Retriever suggests improvements with evidence", impText, "Must reference identified weaknesses AND suggest solutions. Should connect the problem (vague prompts -> poor results) to potential fixes (query classification, intent detection).");
    validatorCost += v162.cost;
    record(162, v162.passed, v162.reason);
  }
  await new Promise(r => setTimeout(r, 5000));

  // =============================================
  // #163: Meta-learning
  // =============================================
  console.log("\n=== Test #163: Meta-learning ===\n");
  const metaCheck = await dbQuery(`
    SELECT topic, insight, context FROM learnings
    WHERE topic ILIKE '%AIDAM%' OR topic ILIKE '%retriev%improv%' OR topic ILIKE '%self%improv%'
       OR insight ILIKE '%AIDAM%' OR topic ILIKE '%information retrieval%'
       OR insight ILIKE '%query.*classif%' OR insight ILIKE '%rerank%'
    ORDER BY created_at DESC LIMIT 10
  `);
  console.log(`  Meta-learnings: ${metaCheck.rows.length}`);
  metaCheck.rows.forEach(r => console.log(`    ${r.topic}: ${(r.insight || "").slice(0, 80)}...`));

  const patMeta = await dbQuery(`
    SELECT name FROM patterns
    WHERE name ILIKE '%retrieval%' OR name ILIKE '%search%improv%' OR name ILIKE '%query%'
    ORDER BY created_at DESC LIMIT 5
  `);
  console.log(`  Meta-patterns: ${patMeta.rows.length}`);

  if (!(metaCheck.rows.length > 0 || patMeta.rows.length > 0)) {
    record(163, false, "Structural pre-check failed");
  } else {
    const v163 = await askValidator(163, "Meta-learning about AIDAM itself persisted", metaCheck.rows.length > 0 ? metaCheck.rows : patMeta.rows, "At least one learning or pattern specifically about AIDAM's own behavior, performance, or improvement opportunities. Must be self-referential.");
    validatorCost += v163.cost;
    record(163, v163.passed, v163.reason);
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
  console.log(`  LEVEL 36 RESULTS: ${passed}/${total} passed`);
  if (failed.length > 0) { console.log("  FAILURES:"); failed.forEach(f => console.log(`    Step ${f.step}: ${f.desc}`)); }
  console.log(`${"=".repeat(60)}`);
  if (failed.length === 0) console.log("\n  Level 36 PASSED! Self-improvement demonstrated.\n");
}

run().then(() => process.exit(0)).catch(err => { console.error("Test error:", err); process.exit(1); });
setTimeout(() => { console.log("GLOBAL TIMEOUT"); process.exit(1); }, 400000);
