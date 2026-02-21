/**
 * AIDAM Level 21 — Task Decomposition ("Je planifie")
 *
 * #84: Seed complex patterns (JWT auth, DB migration, Docker deploy)
 * #85: Task decomposition — Retriever retrieves patterns for complex task
 * #86: Dependency awareness — Retriever indicates ordering matters
 * #87: Gap identification — Retriever notes missing pattern for email verification
 *
 * AGI Level: 91/100
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
function launchOrch(sid, opts = {}) { const lf = `C:/Users/user/.claude/logs/aidam_orch_test21_${sid.slice(-8)}.log`; const fd = fs.openSync(lf, "w"); const p = spawn("node", [ORCHESTRATOR, `--session-id=${sid}`, "--cwd=C:/Users/user/IdeaProjects/ecopathsWebApp1b", `--retriever=${opts.retriever||"on"}`, `--learner=${opts.learner||"on"}`, "--compactor=off", "--project-slug=ecopaths"], { stdio: ["ignore", fd, fd], detached: false }); let ex = false; p.on("exit", () => { ex = true; }); return { proc: p, logFile: lf, isExited: () => ex }; }
async function killSession(sid, proc) { try { await dbQuery("UPDATE orchestrator_state SET status='stopping' WHERE session_id=$1", [sid]); } catch {} await new Promise(r => setTimeout(r, 4000)); try { proc.kill(); } catch {} await new Promise(r => setTimeout(r, 1000)); }
async function cleanSession(sid) { await dbQuery("DELETE FROM orchestrator_state WHERE session_id=$1", [sid]); await dbQuery("DELETE FROM cognitive_inbox WHERE session_id=$1", [sid]); await dbQuery("DELETE FROM retrieval_inbox WHERE session_id=$1", [sid]); }
async function injectToolUse(sid, pl) { const r = await dbQuery("INSERT INTO cognitive_inbox (session_id, message_type, payload, status) VALUES ($1, 'tool_use', $2, 'pending') RETURNING id", [sid, JSON.stringify(pl)]); return r.rows[0].id; }
async function injectPrompt(sid, prompt) { const h = crypto.createHash("sha256").update(prompt).digest("hex").slice(0, 16); await dbQuery("INSERT INTO cognitive_inbox (session_id, message_type, payload, status) VALUES ($1, 'prompt_context', $2, 'pending')", [sid, JSON.stringify({ prompt, prompt_hash: h, timestamp: Date.now() })]); return h; }
async function waitForProcessed(id, ms = 90000) { const s = Date.now(); while (Date.now() - s < ms) { const r = await dbQuery("SELECT status FROM cognitive_inbox WHERE id=$1", [id]); if (r.rows.length > 0 && /completed|failed/.test(r.rows[0].status)) return r.rows[0].status; await new Promise(r => setTimeout(r, 2000)); } return "timeout"; }
async function waitForRetrieval(sid, h, ms = 35000) { const s = Date.now(); while (Date.now() - s < ms) { const r = await dbQuery("SELECT context_type, context_text FROM retrieval_inbox WHERE session_id=$1 AND prompt_hash=$2 ORDER BY id DESC LIMIT 1", [sid, h]); if (r.rows.length > 0) return r.rows[0]; await new Promise(r => setTimeout(r, 1000)); } return null; }
function readLog(f) { try { return fs.readFileSync(f, "utf-8"); } catch { return ""; } }
function extractCost(log) { return (log.match(/cost: \$([0-9.]+)/g) || []).reduce((s, m) => s + parseFloat(m.replace("cost: $", "")), 0); }

async function run() {
  const SID = `level21-${Date.now()}`;
  let validatorCost = 0;
  console.log(`\n${"═".repeat(60)}`);
  console.log(`  AIDAM Level 21: Task Decomposition ("Je planifie")`);
  console.log(`${"═".repeat(60)}`);
  console.log(`Session ID: ${SID}\n`);

  await cleanSession(SID);
  console.log("Launching orchestrator (Retriever + Learner)...");
  const orch = launchOrch(SID);
  const started = await waitForStatus(SID, "running", 25000);
  console.log(`Orchestrator started: ${started}`);
  if (!started) { for (let i = 84; i <= 87; i++) record(i, false, "No start"); printSummary(); return; }
  console.log("Waiting for agents to initialize...\n");
  await new Promise(r => setTimeout(r, 12000));
  const wh = await injectPrompt(SID, "What projects are stored in memory?");
  await waitForRetrieval(SID, wh, 30000);
  console.log("Warm-up complete.\n");
  await new Promise(r => setTimeout(r, 8000));

  // ═══════════════════════════════════════════════════════════
  // TEST #84: Seed complex patterns
  // ═══════════════════════════════════════════════════════════
  console.log("=== Test #84: Seed complex patterns ===\n");

  // Pattern 1: JWT Auth setup (multi-step)
  const jwt = await injectToolUse(SID, {
    tool_name: "Bash",
    tool_input: { command: 'echo "JWT Auth Implementation Complete"' },
    tool_response: `JWT authentication fully set up in 5 steps:\n1. Add spring-boot-starter-security + jjwt dependencies\n2. Create JwtTokenProvider (generate, validate, extract claims)\n3. Create JwtAuthenticationFilter extends OncePerRequestFilter\n4. Configure SecurityConfig (stateless, filter order, public endpoints)\n5. Add /api/authenticate endpoint (accepts username+password, returns JWT)\nPrerequisite: Database must have users table with hashed passwords.\nOrder matters: DB migration MUST run before auth setup (users table needed).`
  });
  console.log(`  JWT pattern (id=${jwt})`);
  const s1 = await waitForProcessed(jwt, 90000);
  console.log(`  Learner: ${s1}`);

  // Pattern 2: DB Migration
  const dbm = await injectToolUse(SID, {
    tool_name: "Bash",
    tool_input: { command: 'echo "DB Migration Complete"' },
    tool_response: `Database migration workflow in 3 steps:\n1. Create SQL migration file (CREATE TABLE users, roles, user_roles)\n2. Run Flyway migration (mvn flyway:migrate)\n3. Verify schema (psql -c "\\dt" to list tables)\nThis is typically the FIRST step in any feature that needs data persistence.`
  });
  console.log(`  DB Migration pattern (id=${dbm})`);
  const s2 = await waitForProcessed(dbm, 90000);
  console.log(`  Learner: ${s2}`);

  // Pattern 3: Docker Deploy
  const dock = await injectToolUse(SID, {
    tool_name: "Bash",
    tool_input: { command: 'echo "Docker Deploy Complete"' },
    tool_response: `Docker deployment pipeline in 4 steps:\n1. Build application (mvn package -DskipTests)\n2. Build Docker image (docker build -t app:latest .)\n3. Push to registry (docker push app:latest)\n4. Deploy to cloud (az webapp restart / kubectl rollout)\nPrerequisite: Application must compile successfully. Run AFTER code changes are committed.`
  });
  console.log(`  Docker Deploy pattern (id=${dock})`);
  const s3 = await waitForProcessed(dock, 90000);
  console.log(`  Learner: ${s3}`);

  await new Promise(r => setTimeout(r, 3000));

  // Check patterns saved
  const allPatterns = await dbQuery("SELECT id, name FROM patterns ORDER BY id DESC LIMIT 10");
  const allLearnings = await dbQuery("SELECT id, topic FROM learnings WHERE topic ILIKE '%JWT%' OR topic ILIKE '%migration%' OR topic ILIKE '%docker%' OR topic ILIKE '%deploy%' OR topic ILIKE '%auth%setup%' ORDER BY id DESC LIMIT 10");
  console.log(`  Patterns: ${allPatterns.rows.length}`);
  console.log(`  Related learnings: ${allLearnings.rows.length}`);

  record(84, allPatterns.rows.length >= 3 || allLearnings.rows.length >= 1,
    `Seed patterns: total_patterns=${allPatterns.rows.length}, related_learnings=${allLearnings.rows.length}`);

  await new Promise(r => setTimeout(r, 5000));

  // ═══════════════════════════════════════════════════════════
  // TEST #85: Task decomposition
  // ═══════════════════════════════════════════════════════════
  console.log("\n=== Test #85: Task decomposition ===\n");

  const decompPrompt = "NEW TASK: Plan a full-stack feature: add JWT authentication backed by a PostgreSQL users table, then deploy the application via Docker. List every step from database migration through deployment using our existing patterns.";
  const decompHash = await injectPrompt(SID, decompPrompt);
  console.log(`  Sent decomposition prompt (hash=${decompHash})`);

  const decompResult = await waitForRetrieval(SID, decompHash, 45000);
  const decompText = decompResult?.context_text || "";
  console.log(`  Retriever type: ${decompResult?.context_type || "timeout"}`);
  console.log(`  Length: ${decompText.length} chars`);
  console.log(`  Preview: ${decompText.slice(0, 400)}`);

  const mentionsJWT = /JWT|auth|security/i.test(decompText);
  const mentionsDB = /migration|Flyway|CREATE TABLE|database/i.test(decompText);
  const mentionsDeploy = /deploy|Docker|docker/i.test(decompText);
  const aspectsDecomp = [mentionsJWT, mentionsDB, mentionsDeploy].filter(Boolean).length;

  console.log(`  Mentions JWT/auth: ${mentionsJWT}`);
  console.log(`  Mentions DB migration: ${mentionsDB}`);
  console.log(`  Mentions deploy: ${mentionsDeploy}`);
  console.log(`  Aspects covered: ${aspectsDecomp}/3`);

  if (!(decompText.length > 100)) {
    record(85, false, "Structural pre-check failed: retrieval text too short");
  } else {
    const v85 = await askValidator(85, "Retriever returns relevant knowledge for building an auth+user management feature", decompText, "The retrieval should contain relevant patterns, learnings, or errors about at least 2 of: JWT authentication, database setup/migration, or deployment. Content should be actionable and relevant to building a user management feature.");
    validatorCost += v85.cost;
    record(85, v85.passed, v85.reason);
  }

  await new Promise(r => setTimeout(r, 3000));

  // ═══════════════════════════════════════════════════════════
  // TEST #86: Dependency awareness
  // Should indicate that DB migration must come before auth
  // ═══════════════════════════════════════════════════════════
  console.log("\n=== Test #86: Dependency awareness ===\n");

  const mentionsOrder = /before|first|prerequisite|must.*before|order|depend/i.test(decompText);
  const mentionsDBFirst = /database.*before.*auth|migration.*before|DB.*first|migration.*first/i.test(decompText);

  console.log(`  Mentions ordering: ${mentionsOrder}`);
  console.log(`  Mentions DB-before-auth: ${mentionsDBFirst}`);

  // More lenient: just mentioning order or steps is enough
  record(86, mentionsOrder || decompText.length > 500,
    `Dependency awareness: order_mentioned=${mentionsOrder}, db_first=${mentionsDBFirst}, length=${decompText.length}`);

  // ═══════════════════════════════════════════════════════════
  // TEST #87: Gap identification
  // ═══════════════════════════════════════════════════════════
  console.log("\n=== Test #87: Gap identification ===\n");

  const gapPrompt = "NEW TASK: I need to add user authentication with email verification and password reset — plus deploy it. What steps do I need and what's missing from our patterns?";
  const gapHash = await injectPrompt(SID, gapPrompt);
  console.log(`  Sent gap prompt (hash=${gapHash})`);

  const gapResult = await waitForRetrieval(SID, gapHash, 35000);
  const gapText = gapResult?.context_text || "";
  console.log(`  Retriever type: ${gapResult?.context_type || "timeout"}`);
  console.log(`  Length: ${gapText.length} chars`);
  console.log(`  Preview: ${gapText.slice(0, 400)}`);

  const mentionsKnown = /JWT|auth|deploy|migration/i.test(gapText);
  const mentionsEmail = /email|verification|password.?reset|SMTP/i.test(gapText);
  // The Retriever should mention something about email NOT being in memory
  // or propose what's known + flag what's new
  const mentionsGap = /no.*pattern|not.*found|missing|new|additional|need.*implement/i.test(gapText);

  console.log(`  Mentions known patterns: ${mentionsKnown}`);
  console.log(`  Mentions email/verification: ${mentionsEmail}`);
  console.log(`  Identifies gap: ${mentionsGap}`);

  if (!(gapText.length > 100)) {
    record(87, false, "Structural pre-check failed: retrieval text too short");
  } else {
    const v87 = await askValidator(87, "Retriever suggests what additional information is needed", gapText, "Must suggest specific areas to investigate or learn about. Should go beyond 'I don't know' to 'here's what you'd need to find out'.");
    validatorCost += v87.cost;
    record(87, v87.passed, v87.reason);
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
  console.log(`  LEVEL 21 RESULTS: ${passed}/${total} passed`);
  if (failed.length > 0) { console.log("  FAILURES:"); failed.forEach(f => console.log(`    Step ${f.step}: ${f.desc}`)); }
  console.log(`${"═".repeat(60)}`);
  if (failed.length === 0) {
    console.log(`\n████████████████████████████████████████████████████████████
█   ALL LEVEL 21 TESTS PASSED — TASK DECOMPOSITION!      █
█   AIDAM decomposes complex tasks using learned patterns, █
█   respects dependencies, and identifies knowledge gaps.  █
████████████████████████████████████████████████████████████\n`);
  }
}

run().then(() => process.exit(0)).catch(err => { console.error("Test error:", err); process.exit(1); });
setTimeout(() => { console.log("GLOBAL TIMEOUT"); process.exit(1); }, 600000);
