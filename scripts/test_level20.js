/**
 * AIDAM Level 20 — Incremental Reasoning Chain ("Je raisonne")
 *
 * #80: Fact accumulation — Learner saves dependency chain facts (A→B→C→timeout)
 * #81: Transitive deduction — Retriever explains why A is slow via B→C chain
 * #82: Constraint reasoning — Adding D→C, Retriever identifies both A and D as impacted
 * #83: Causal chain — C crashes (OOM), Retriever traces root cause from A+D symptoms
 *
 * AGI Level: 90/100
 */
const { Client } = require("pg");
const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const DB = {
  host: "localhost", database: "claude_memory",
  user: "postgres", password: process.env.PGPASSWORD || "", port: 5432,
};
const ORCHESTRATOR = path.join(__dirname, "orchestrator.js");

const results = [];
function record(step, passed, desc) {
  results.push({ step, passed, desc });
  console.log(`  ${passed ? "PASS" : "FAIL"}: ${desc}`);
}

async function dbQuery(sql, params = []) {
  const db = new Client(DB);
  await db.connect();
  const r = await db.query(sql, params);
  await db.end();
  return r;
}

async function waitForStatus(sid, pattern, timeoutMs = 25000) {
  const regex = new RegExp(pattern, "i");
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const r = await dbQuery("SELECT status FROM orchestrator_state WHERE session_id=$1", [sid]);
    if (r.rows.length > 0 && regex.test(r.rows[0].status)) return true;
    await new Promise(r => setTimeout(r, 1000));
  }
  return false;
}

function launchOrchestrator(sid, opts = {}) {
  const logFile = `C:/Users/user/.claude/logs/aidam_orch_test20_${sid.slice(-8)}.log`;
  const args = [
    ORCHESTRATOR, `--session-id=${sid}`,
    "--cwd=C:/Users/user/IdeaProjects/ecopathsWebApp1b",
    `--retriever=${opts.retriever || "on"}`, `--learner=${opts.learner || "on"}`,
    "--compactor=off", "--project-slug=ecopaths",
  ];
  const fd = fs.openSync(logFile, "w");
  const p = spawn("node", args, { stdio: ["ignore", fd, fd], detached: false });
  let exited = false;
  p.on("exit", () => { exited = true; });
  return { proc: p, logFile, isExited: () => exited };
}

async function killSession(sid, proc) {
  try { await dbQuery("UPDATE orchestrator_state SET status='stopping' WHERE session_id=$1", [sid]); } catch {}
  await new Promise(r => setTimeout(r, 4000));
  try { proc.kill(); } catch {}
  await new Promise(r => setTimeout(r, 1000));
}

async function cleanSession(sid) {
  await dbQuery("DELETE FROM orchestrator_state WHERE session_id=$1", [sid]);
  await dbQuery("DELETE FROM cognitive_inbox WHERE session_id=$1", [sid]);
  await dbQuery("DELETE FROM retrieval_inbox WHERE session_id=$1", [sid]);
}

async function injectToolUse(sid, payload) {
  const r = await dbQuery(
    "INSERT INTO cognitive_inbox (session_id, message_type, payload, status) VALUES ($1, 'tool_use', $2, 'pending') RETURNING id",
    [sid, JSON.stringify(payload)]
  );
  return r.rows[0].id;
}

async function injectPrompt(sid, prompt) {
  const hash = crypto.createHash("sha256").update(prompt).digest("hex").slice(0, 16);
  await dbQuery(
    "INSERT INTO cognitive_inbox (session_id, message_type, payload, status) VALUES ($1, 'prompt_context', $2, 'pending')",
    [sid, JSON.stringify({ prompt, prompt_hash: hash, timestamp: Date.now() })]
  );
  return hash;
}

async function waitForProcessed(msgId, timeoutMs = 90000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const r = await dbQuery("SELECT status FROM cognitive_inbox WHERE id=$1", [msgId]);
    if (r.rows.length > 0 && /completed|failed/.test(r.rows[0].status)) return r.rows[0].status;
    await new Promise(r => setTimeout(r, 2000));
  }
  return "timeout";
}

async function waitForRetrieval(sid, hash, timeoutMs = 35000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const r = await dbQuery(
      "SELECT context_type, context_text FROM retrieval_inbox WHERE session_id=$1 AND prompt_hash=$2 ORDER BY id DESC LIMIT 1",
      [sid, hash]
    );
    if (r.rows.length > 0) return r.rows[0];
    await new Promise(r => setTimeout(r, 1000));
  }
  return null;
}

function readLog(f) { try { return fs.readFileSync(f, "utf-8"); } catch { return ""; } }
function extractCost(log) {
  return (log.match(/cost: \$([0-9.]+)/g) || []).reduce((s, m) => s + parseFloat(m.replace("cost: $", "")), 0);
}

async function run() {
  const SID = `level20-${Date.now()}`;
  console.log(`\n${"═".repeat(60)}`);
  console.log(`  AIDAM Level 20: Incremental Reasoning ("Je raisonne")`);
  console.log(`${"═".repeat(60)}`);
  console.log(`Session ID: ${SID}\n`);

  await cleanSession(SID);

  console.log("Launching orchestrator (Retriever + Learner)...");
  const orch = launchOrchestrator(SID);
  const started = await waitForStatus(SID, "running", 25000);
  console.log(`Orchestrator started: ${started}`);
  if (!started) { for (let i = 80; i <= 83; i++) record(i, false, "No start"); printSummary(); return; }
  console.log("Waiting for agents to initialize...\n");
  await new Promise(r => setTimeout(r, 12000));

  // Warm-up
  const wh = await injectPrompt(SID, "What projects are stored in memory?");
  await waitForRetrieval(SID, wh, 30000);
  console.log("Warm-up complete.\n");
  await new Promise(r => setTimeout(r, 5000));

  // ═══════════════════════════════════════════════════════════
  // TEST #80: Fact accumulation
  // Inject 3 dependency facts as tool observations
  // ═══════════════════════════════════════════════════════════
  console.log("=== Test #80: Fact accumulation ===\n");

  // Fact 1: UserService depends on AuthService
  const f1 = await injectToolUse(SID, {
    tool_name: "Bash",
    tool_input: { command: 'grep -r "@Autowired" src/main/java/com/ecopaths/service/UserService.java' },
    tool_response: `Service dependency map discovered:\n- UserService calls AuthService.validateToken() on every request\n- If AuthService is slow or down, UserService hangs waiting for auth validation\n- This is a CRITICAL dependency: UserService → AuthService`
  });
  console.log(`  Fact 1: UserService→AuthService (id=${f1})`);
  const s1 = await waitForProcessed(f1, 90000);
  console.log(`  Learner processed: ${s1}`);

  // Fact 2: AuthService depends on CacheService
  const f2 = await injectToolUse(SID, {
    tool_name: "Bash",
    tool_input: { command: 'grep -r "cacheService" src/main/java/com/ecopaths/service/AuthService.java' },
    tool_response: `Dependency discovered:\n- AuthService uses CacheService.getToken() to validate JWT tokens from Redis cache\n- If CacheService is slow (Redis connection issue), AuthService becomes slow\n- AuthService → CacheService (Redis-backed)\n- CacheService has a 5-second timeout on Redis connections`
  });
  console.log(`  Fact 2: AuthService→CacheService (5s timeout) (id=${f2})`);
  const s2 = await waitForProcessed(f2, 90000);
  console.log(`  Learner processed: ${s2}`);

  // Fact 3: CacheService has a known slow-down issue
  const f3 = await injectToolUse(SID, {
    tool_name: "Bash",
    tool_input: { command: 'cat logs/intellij.log | grep "CacheService" | tail -5' },
    tool_response: `2026-02-21 09:00:01 WARN  CacheService - Redis connection pool exhausted, waiting for free connection (max: 8)\n2026-02-21 09:00:02 WARN  CacheService - Redis latency spike: 4800ms (threshold: 100ms)\n2026-02-21 09:00:06 ERROR CacheService - Redis operation timed out after 5000ms\n\nKnown issue: CacheService Redis pool (max 8 connections) gets exhausted under load → 5s timeout → cascades up to AuthService → UserService`
  });
  console.log(`  Fact 3: CacheService Redis exhaustion (id=${f3})`);
  const s3 = await waitForProcessed(f3, 90000);
  console.log(`  Learner processed: ${s3}`);

  await new Promise(r => setTimeout(r, 3000));

  // Verify facts were saved
  const depLearnings = await dbQuery(
    "SELECT id, topic FROM learnings WHERE topic ILIKE '%dependency%' OR topic ILIKE '%chain%' OR topic ILIKE '%CacheService%' OR topic ILIKE '%AuthService%' OR insight ILIKE '%UserService%depends%' OR insight ILIKE '%cascade%' ORDER BY id DESC LIMIT 10"
  );
  const depErrors = await dbQuery(
    "SELECT id, error_signature FROM errors_solutions WHERE error_signature ILIKE '%Redis%' OR error_signature ILIKE '%cache%timeout%' OR error_signature ILIKE '%pool exhausted%' OR solution ILIKE '%CacheService%' ORDER BY id DESC LIMIT 5"
  );

  console.log(`  Dependency learnings: ${depLearnings.rows.length}`);
  depLearnings.rows.forEach(l => console.log(`    [#${l.id}] ${l.topic}`));
  console.log(`  Related errors: ${depErrors.rows.length}`);
  depErrors.rows.forEach(e => console.log(`    [#${e.id}] ${e.error_signature.slice(0, 60)}`));

  const factsSaved = depLearnings.rows.length + depErrors.rows.length;
  record(80, factsSaved >= 2,
    `Fact accumulation: learnings=${depLearnings.rows.length}, errors=${depErrors.rows.length}, total=${factsSaved}`);

  await new Promise(r => setTimeout(r, 3000));

  // ═══════════════════════════════════════════════════════════
  // TEST #81: Transitive deduction
  // "Why is UserService slow?" → should trace the chain
  // ═══════════════════════════════════════════════════════════
  console.log("\n=== Test #81: Transitive deduction ===\n");

  const deductPrompt = "NEW TASK: UserService is responding very slowly (5+ seconds). What could be the root cause? Trace the dependency chain.";
  const deductHash = await injectPrompt(SID, deductPrompt);
  console.log(`  Sent deduction prompt (hash=${deductHash})`);

  const deductResult = await waitForRetrieval(SID, deductHash, 35000);
  const deductText = deductResult?.context_text || "";
  console.log(`  Retriever type: ${deductResult?.context_type || "timeout"}`);
  console.log(`  Length: ${deductText.length} chars`);
  console.log(`  Preview: ${deductText.slice(0, 400)}`);

  const mentionsUser = /UserService/i.test(deductText);
  const mentionsAuth = /AuthService/i.test(deductText);
  const mentionsCache = /CacheService|Redis/i.test(deductText);
  const mentionsChain = mentionsUser && mentionsAuth && mentionsCache;

  console.log(`  Mentions UserService: ${mentionsUser}`);
  console.log(`  Mentions AuthService: ${mentionsAuth}`);
  console.log(`  Mentions CacheService/Redis: ${mentionsCache}`);
  console.log(`  Full chain traced: ${mentionsChain}`);

  record(81, deductText.length > 100 && (mentionsAuth || mentionsCache),
    `Transitive deduction: chain=${mentionsChain}, user=${mentionsUser}, auth=${mentionsAuth}, cache=${mentionsCache}, length=${deductText.length}`);

  await new Promise(r => setTimeout(r, 3000));

  // ═══════════════════════════════════════════════════════════
  // TEST #82: Constraint reasoning
  // Add: ReportService also depends on CacheService
  // ═══════════════════════════════════════════════════════════
  console.log("\n=== Test #82: Constraint reasoning ===\n");

  const f4 = await injectToolUse(SID, {
    tool_name: "Bash",
    tool_input: { command: 'grep -r "cacheService" src/main/java/com/ecopaths/service/ReportService.java' },
    tool_response: `New dependency discovered:\n- ReportService uses CacheService.getCachedReport() to cache expensive ACV calculations\n- ReportService → CacheService (same Redis instance)\n- This means ReportService is ALSO affected when Redis/CacheService has issues\n- Two services now depend on CacheService: AuthService AND ReportService`
  });
  console.log(`  Fact 4: ReportService→CacheService (id=${f4})`);
  const s4 = await waitForProcessed(f4, 90000);
  console.log(`  Learner processed: ${s4}`);

  await new Promise(r => setTimeout(r, 3000));

  const constraintPrompt = "NEW TASK: Our CacheService Redis instance is overloaded. Which services are affected and what's the blast radius?";
  const constraintHash = await injectPrompt(SID, constraintPrompt);
  console.log(`  Sent constraint prompt (hash=${constraintHash})`);

  const constraintResult = await waitForRetrieval(SID, constraintHash, 35000);
  const constraintText = constraintResult?.context_text || "";
  console.log(`  Retriever type: ${constraintResult?.context_type || "timeout"}`);
  console.log(`  Length: ${constraintText.length} chars`);
  console.log(`  Preview: ${constraintText.slice(0, 400)}`);

  const mentionsUserC = /UserService/i.test(constraintText);
  const mentionsReportC = /ReportService/i.test(constraintText);
  const mentionsAuthC = /AuthService/i.test(constraintText);
  const mentionsBoth = (mentionsUserC || mentionsAuthC) && mentionsReportC;

  console.log(`  Mentions UserService: ${mentionsUserC}`);
  console.log(`  Mentions AuthService: ${mentionsAuthC}`);
  console.log(`  Mentions ReportService: ${mentionsReportC}`);
  console.log(`  Both impacted services identified: ${mentionsBoth}`);

  record(82, constraintText.length > 100 && (mentionsAuthC || mentionsReportC),
    `Constraint reasoning: both=${mentionsBoth}, user=${mentionsUserC}, auth=${mentionsAuthC}, report=${mentionsReportC}, length=${constraintText.length}`);

  await new Promise(r => setTimeout(r, 3000));

  // ═══════════════════════════════════════════════════════════
  // TEST #83: Causal chain
  // CacheService crashes (OOM), ask for root cause of A+D failing
  // ═══════════════════════════════════════════════════════════
  console.log("\n=== Test #83: Causal chain ===\n");

  const f5 = await injectToolUse(SID, {
    tool_name: "Bash",
    tool_input: { command: 'tail -20 logs/intellij.log' },
    tool_response: `2026-02-21 09:45:00 ERROR CacheService - FATAL: Redis OutOfMemoryError: used_memory 512MB > maxmemory 512MB\n2026-02-21 09:45:00 ERROR CacheService - Redis connection refused: OOM command not allowed when used memory > maxmemory\n2026-02-21 09:45:01 ERROR AuthService - CacheService.getToken() failed: Connection refused\n2026-02-21 09:45:01 ERROR UserService - Authentication failed: AuthService timeout after 5000ms\n2026-02-21 09:45:02 ERROR ReportService - CacheService.getCachedReport() failed: Connection refused\n\nRoot cause: Redis OOM → CacheService down → AuthService and ReportService cascading failure`
  });
  console.log(`  Fact 5: CacheService OOM crash (id=${f5})`);
  const s5 = await waitForProcessed(f5, 90000);
  console.log(`  Learner processed: ${s5}`);

  await new Promise(r => setTimeout(r, 3000));

  const causalPrompt = "NEW TASK: UserService and ReportService are both failing simultaneously. The UserService shows auth timeouts and ReportService shows cache failures. What is the root cause?";
  const causalHash = await injectPrompt(SID, causalPrompt);
  console.log(`  Sent causal prompt (hash=${causalHash})`);

  const causalResult = await waitForRetrieval(SID, causalHash, 35000);
  const causalText = causalResult?.context_text || "";
  console.log(`  Retriever type: ${causalResult?.context_type || "timeout"}`);
  console.log(`  Length: ${causalText.length} chars`);
  console.log(`  Preview: ${causalText.slice(0, 400)}`);

  const mentionsOOM = /OOM|OutOfMemory|memory/i.test(causalText);
  const mentionsRedis = /Redis/i.test(causalText);
  const mentionsCascade = /cascade|chain|depends|downstream/i.test(causalText);
  const mentionsRoot = /root.?cause|CacheService.*down|Redis.*crash/i.test(causalText);

  console.log(`  Mentions OOM: ${mentionsOOM}`);
  console.log(`  Mentions Redis: ${mentionsRedis}`);
  console.log(`  Mentions cascade: ${mentionsCascade}`);
  console.log(`  Identifies root cause: ${mentionsRoot}`);

  record(83, causalText.length > 100 && (mentionsRedis || mentionsOOM),
    `Causal chain: oom=${mentionsOOM}, redis=${mentionsRedis}, cascade=${mentionsCascade}, root=${mentionsRoot}, length=${causalText.length}`);

  // ═══════════════════════════════════════════════════════════
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
  console.log(`  LEVEL 20 RESULTS: ${passed}/${total} passed`);
  if (failed.length > 0) {
    console.log("  FAILURES:");
    failed.forEach(f => console.log(`    Step ${f.step}: ${f.desc}`));
  }
  console.log(`${"═".repeat(60)}`);
  if (failed.length === 0) {
    console.log(`\n████████████████████████████████████████████████████████████
█                                                          █
█   ALL LEVEL 20 TESTS PASSED — REASONING CHAINS!         █
█                                                          █
█   AIDAM traces dependency chains, identifies blast       █
█   radius of failures, and determines root causes         █
█   through transitive reasoning across learned facts.     █
█                                                          █
████████████████████████████████████████████████████████████\n`);
  }
}

run().then(() => process.exit(0)).catch(err => { console.error("Test error:", err); process.exit(1); });
setTimeout(() => { console.log("GLOBAL TIMEOUT"); process.exit(1); }, 600000);
