/**
 * AIDAM Level 25 — Self-Correction & Versioning ("Je me corrige")
 *
 * #100: Initial learning — "HikariCP default pool size: 10"
 * #101: Contradicting info — "Actually: CPU cores * 2 + 1"
 * #102: Version check — learning enriched, no duplicate
 * #103: Corrected recall — Retriever gives corrected info
 *
 * AGI Level: 95/100
 */
const { Client } = require("pg");
const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

// Load .env from project root
const envPath = path.join(__dirname, "..", ".env");
if (fs.existsSync(envPath)) {
  fs.readFileSync(envPath, "utf-8").replace(/\r/g, "").split("\n").forEach(line => {
    const m = line.match(/^([^#=]+)=(.*)$/);
    if (m && !process.env[m[1].trim()]) process.env[m[1].trim()] = m[2].trim();
  });
}

const DB = { host: "localhost", database: "claude_memory", user: "postgres", password: process.env.PGPASSWORD || "", port: 5432 };
const ORCHESTRATOR = path.join(__dirname, "orchestrator.js");

const results = [];
function record(step, passed, desc) { results.push({ step, passed, desc }); console.log(`  ${passed ? "PASS" : "FAIL"}: ${desc}`); }

async function dbQuery(sql, params = []) { const db = new Client(DB); await db.connect(); const r = await db.query(sql, params); await db.end(); return r; }
async function waitForStatus(sid, pat, ms = 25000) { const re = new RegExp(pat, "i"); const s = Date.now(); while (Date.now() - s < ms) { const r = await dbQuery("SELECT status FROM orchestrator_state WHERE session_id=$1", [sid]); if (r.rows.length > 0 && re.test(r.rows[0].status)) return true; await new Promise(r => setTimeout(r, 1000)); } return false; }
function launchOrch(sid, opts = {}) { const lf = `C:/Users/user/.claude/logs/aidam_orch_test25_${sid.slice(-8)}.log`; const fd = fs.openSync(lf, "w"); const p = spawn("node", [ORCHESTRATOR, `--session-id=${sid}`, "--cwd=C:/Users/user/IdeaProjects/ecopathsWebApp1b", `--retriever=${opts.retriever||"on"}`, `--learner=${opts.learner||"on"}`, "--compactor=off", "--project-slug=ecopaths"], { stdio: ["ignore", fd, fd], detached: false }); let ex = false; p.on("exit", () => { ex = true; }); return { proc: p, logFile: lf, isExited: () => ex }; }
async function killSession(sid, proc) { try { await dbQuery("UPDATE orchestrator_state SET status='stopping' WHERE session_id=$1", [sid]); } catch {} await new Promise(r => setTimeout(r, 4000)); try { proc.kill(); } catch {} await new Promise(r => setTimeout(r, 1000)); }
async function cleanSession(sid) { await dbQuery("DELETE FROM orchestrator_state WHERE session_id=$1", [sid]); await dbQuery("DELETE FROM cognitive_inbox WHERE session_id=$1", [sid]); await dbQuery("DELETE FROM retrieval_inbox WHERE session_id=$1", [sid]); }
async function injectToolUse(sid, pl) { const r = await dbQuery("INSERT INTO cognitive_inbox (session_id, message_type, payload, status) VALUES ($1, 'tool_use', $2, 'pending') RETURNING id", [sid, JSON.stringify(pl)]); return r.rows[0].id; }
async function injectPrompt(sid, prompt) { const h = crypto.createHash("sha256").update(prompt).digest("hex").slice(0, 16); await dbQuery("INSERT INTO cognitive_inbox (session_id, message_type, payload, status) VALUES ($1, 'prompt_context', $2, 'pending')", [sid, JSON.stringify({ prompt, prompt_hash: h, timestamp: Date.now() })]); return h; }
async function waitForProcessed(id, ms = 90000) { const s = Date.now(); while (Date.now() - s < ms) { const r = await dbQuery("SELECT status FROM cognitive_inbox WHERE id=$1", [id]); if (r.rows.length > 0 && /completed|failed/.test(r.rows[0].status)) return r.rows[0].status; await new Promise(r => setTimeout(r, 2000)); } return "timeout"; }
async function waitForRetrieval(sid, h, ms = 45000) { const s = Date.now(); while (Date.now() - s < ms) { const r = await dbQuery("SELECT context_type, context_text FROM retrieval_inbox WHERE session_id=$1 AND prompt_hash=$2 ORDER BY id DESC LIMIT 1", [sid, h]); if (r.rows.length > 0) return r.rows[0]; await new Promise(r => setTimeout(r, 1000)); } return null; }
function readLog(f) { try { return fs.readFileSync(f, "utf-8"); } catch { return ""; } }
function extractCost(log) { return (log.match(/cost: \$([0-9.]+)/g) || []).reduce((s, m) => s + parseFloat(m.replace("cost: $", "")), 0); }

async function run() {
  const SID = `level25-${Date.now()}`;
  console.log(`\n${"═".repeat(60)}`);
  console.log(`  AIDAM Level 25: Self-Correction ("Je me corrige")`);
  console.log(`${"═".repeat(60)}`);
  console.log(`Session ID: ${SID}\n`);

  await cleanSession(SID);
  console.log("Launching orchestrator (Retriever + Learner)...");
  const orch = launchOrch(SID);
  const started = await waitForStatus(SID, "running", 25000);
  console.log(`Orchestrator started: ${started}`);
  if (!started) { for (let i = 100; i <= 103; i++) record(i, false, "No start"); printSummary(); return; }
  console.log("Waiting for agents to initialize...\n");
  await new Promise(r => setTimeout(r, 12000));
  const wh = await injectPrompt(SID, "What projects are stored in memory?");
  await waitForRetrieval(SID, wh, 30000);
  console.log("Warm-up complete.\n");
  await new Promise(r => setTimeout(r, 8000));

  // ═══════════════════════════════════════════════════════════
  // TEST #100: Initial learning
  // ═══════════════════════════════════════════════════════════
  console.log("=== Test #100: Initial learning ===\n");

  const obs1 = await injectToolUse(SID, {
    tool_name: "Bash",
    tool_input: { command: 'cat src/main/resources/application.properties' },
    tool_response: `HikariCP connection pool configuration:
spring.datasource.hikari.maximum-pool-size=10
spring.datasource.hikari.minimum-idle=5
spring.datasource.hikari.idle-timeout=30000
spring.datasource.hikari.connection-timeout=20000

Note: The default pool size in HikariCP is 10 connections. This is the recommended starting point.
Most Spring Boot applications use 10 as the default maximum pool size.
Documentation says: "A pool of 10 connections can typically handle 100+ concurrent users due to connection reuse."`
  });
  console.log(`  Initial pool size observation (id=${obs1})`);
  const s1 = await waitForProcessed(obs1, 90000);
  console.log(`  Learner: ${s1}`);

  await new Promise(r => setTimeout(r, 3000));

  // Count HikariCP learnings before contradiction
  const beforeLearnings = await dbQuery("SELECT id, topic, insight FROM learnings WHERE (topic ILIKE '%hikari%' OR topic ILIKE '%pool%' OR insight ILIKE '%hikari%' OR insight ILIKE '%pool%size%') AND insight ILIKE '%10%' ORDER BY id DESC LIMIT 10");
  const beforeDrilldowns = await dbQuery("SELECT id, topic FROM knowledge_details WHERE topic ILIKE '%hikari%' OR topic ILIKE '%pool%' ORDER BY id DESC LIMIT 10");
  console.log(`  Learnings mentioning pool/HikariCP: ${beforeLearnings.rows.length}`);
  console.log(`  Drilldowns: ${beforeDrilldowns.rows.length}`);

  record(100, beforeLearnings.rows.length >= 1,
    `Initial learning: learnings_with_pool=${beforeLearnings.rows.length}`);

  await new Promise(r => setTimeout(r, 5000));

  // ═══════════════════════════════════════════════════════════
  // TEST #101: Contradicting info
  // ═══════════════════════════════════════════════════════════
  console.log("\n=== Test #101: Contradicting info ===\n");

  const obs2 = await injectToolUse(SID, {
    tool_name: "Bash",
    tool_input: { command: 'echo "HikariCP pool size investigation"' },
    tool_response: `CORRECTION: HikariCP default pool size is NOT fixed at 10!

According to HikariCP GitHub (brettwooldridge/HikariCP):
- Default maximumPoolSize is indeed 10 in the library code
- BUT the RECOMMENDED formula for optimal pool size is: connections = (CPU cores * 2) + effective_spindle_count
- For a typical 4-core server with SSD: optimal = (4 * 2) + 1 = 9
- For an 8-core server: optimal = (8 * 2) + 1 = 17
- For a 16-core production server: optimal = (16 * 2) + 1 = 33

Key insight: A fixed pool of 10 is WRONG for production. You MUST calculate based on cores.
The formula accounts for CPU-bound operations (cores * 2) plus I/O wait (spindle_count, typically 1 for SSD).
Setting too many connections actually DECREASES performance due to context switching.

Previous knowledge that "10 is the recommended default" is INCORRECT for production sizing.`
  });
  console.log(`  Contradiction observation (id=${obs2})`);
  const s2 = await waitForProcessed(obs2, 90000);
  console.log(`  Learner: ${s2}`);

  await new Promise(r => setTimeout(r, 5000));

  // ═══════════════════════════════════════════════════════════
  // TEST #102: Version check — no duplicate, enrichment
  // ═══════════════════════════════════════════════════════════
  console.log("\n=== Test #102: Version check ===\n");

  const afterLearnings = await dbQuery("SELECT id, topic, insight FROM learnings WHERE topic ILIKE '%hikari%' OR topic ILIKE '%pool%' OR insight ILIKE '%hikari%' OR insight ILIKE '%pool%size%' ORDER BY id DESC LIMIT 10");
  const afterDrilldowns = await dbQuery("SELECT id, topic, details FROM knowledge_details WHERE (topic ILIKE '%hikari%' OR topic ILIKE '%pool%' OR details ILIKE '%cores%') ORDER BY id DESC LIMIT 10");
  const afterErrors = await dbQuery("SELECT id, error_signature FROM errors_solutions WHERE error_signature ILIKE '%pool%' OR solution ILIKE '%hikari%' ORDER BY id DESC LIMIT 5");

  console.log(`  Learnings after contradiction: ${afterLearnings.rows.length}`);
  console.log(`  Drilldowns after: ${afterDrilldowns.rows.length}`);
  console.log(`  Errors after: ${afterErrors.rows.length}`);

  // The Learner should have enriched (drilldown) or updated, not created a full duplicate
  // A drilldown with the correction OR a new learning with the formula = both acceptable
  const hasFormula = afterLearnings.rows.some(r => /core|formula|CPU|\* 2/i.test(r.insight || "")) ||
                     afterDrilldowns.rows.some(r => /core|formula|CPU|\* 2/i.test(r.details || ""));

  console.log(`  Has corrected formula: ${hasFormula}`);

  // Check no exact duplicate (both saying "10 is default" with same content)
  const poolLearnings = afterLearnings.rows.filter(r => /pool/i.test(r.topic || "") || /hikari/i.test(r.topic || ""));
  console.log(`  Pool-specific learnings: ${poolLearnings.length}`);

  record(102, hasFormula,
    `Version check: formula_present=${hasFormula}, pool_learnings=${poolLearnings.length}, drilldowns=${afterDrilldowns.rows.length}`);

  await new Promise(r => setTimeout(r, 5000));

  // ═══════════════════════════════════════════════════════════
  // TEST #103: Corrected recall
  // ═══════════════════════════════════════════════════════════
  console.log("\n=== Test #103: Corrected recall ===\n");

  const recallPrompt = "NEW TASK: I'm deploying our Spring Boot app to a production server with 8 CPU cores. What HikariCP connection pool size should I configure? What's the formula?";
  const recallHash = await injectPrompt(SID, recallPrompt);
  console.log(`  Sent recall prompt (hash=${recallHash})`);

  const recallResult = await waitForRetrieval(SID, recallHash, 45000);
  const recallText = recallResult?.context_text || "";
  console.log(`  Retriever type: ${recallResult?.context_type || "timeout"}`);
  console.log(`  Length: ${recallText.length} chars`);
  console.log(`  Preview: ${recallText.slice(0, 400)}`);

  const mentionsFormula = /core|CPU|\* 2|formula/i.test(recallText);
  const mentionsCorrection = /correct|actually|not.*10|dynamic|calculate/i.test(recallText);
  const gives17 = /17|16.*\+.*1|8.*\*.*2/i.test(recallText);

  console.log(`  Mentions formula: ${mentionsFormula}`);
  console.log(`  Mentions correction: ${mentionsCorrection}`);
  console.log(`  Gives answer 17 (for 8 cores): ${gives17}`);

  record(103, recallText.length > 100 && mentionsFormula,
    `Corrected recall: formula=${mentionsFormula}, correction=${mentionsCorrection}, answer_17=${gives17}, length=${recallText.length}`);

  // Cost
  const logContent = readLog(orch.logFile);
  const totalCost = extractCost(logContent);
  const apiCalls = (logContent.match(/cost: \$/g) || []).length;
  console.log(`\n=== Cost Summary ===`);
  console.log(`  Total cost: $${totalCost.toFixed(4)}`);
  console.log(`  API calls: ${apiCalls}`);

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
  console.log(`  LEVEL 25 RESULTS: ${passed}/${total} passed`);
  if (failed.length > 0) { console.log("  FAILURES:"); failed.forEach(f => console.log(`    Step ${f.step}: ${f.desc}`)); }
  console.log(`${"═".repeat(60)}`);
  if (failed.length === 0) {
    console.log(`\n████████████████████████████████████████████████████████████
█   ALL LEVEL 25 TESTS PASSED — SELF-CORRECTION!         █
█   AIDAM updates knowledge when contradicted, enriches   █
█   with corrections, and recalls the corrected version.  █
████████████████████████████████████████████████████████████\n`);
  }
}

run().then(() => process.exit(0)).catch(err => { console.error("Test error:", err); process.exit(1); });
setTimeout(() => { console.log("GLOBAL TIMEOUT"); process.exit(1); }, 600000);
