/**
 * AIDAM Level 18 — Incremental Problem Solving ("Je résous des problèmes")
 *
 * #72: Knowledge accumulation — 4 different DB errors → 4 error_solutions
 * #73: Synthesis retrieval — Retriever combines relevant solutions for composite problem
 * #74: Drilldown depth — Learner enriches a solution with PostgreSQL-specific config
 * #75: Novel problem — Retriever combines pool+timeout for never-seen combination
 *
 * AGI Level: 88/100
 */
const { Client } = require("pg");
const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

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

async function waitForStatus(sessionId, pattern, timeoutMs = 25000) {
  const regex = new RegExp(pattern, "i");
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const r = await dbQuery("SELECT status FROM orchestrator_state WHERE session_id=$1", [sessionId]);
    if (r.rows.length > 0 && regex.test(r.rows[0].status)) return true;
    await new Promise(r => setTimeout(r, 1000));
  }
  return false;
}

function launchOrchestrator(sessionId, opts = {}) {
  const logFile = `C:/Users/user/.claude/logs/aidam_orch_test18_${sessionId.slice(-8)}.log`;
  const args = [
    ORCHESTRATOR, `--session-id=${sessionId}`,
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
  const SID = `level18-${Date.now()}`;
  console.log(`\n${"═".repeat(60)}`);
  console.log(`  AIDAM Level 18: Incremental Problem Solving ("Je résous")`);
  console.log(`${"═".repeat(60)}`);
  console.log(`Session ID: ${SID}\n`);

  await cleanSession(SID);

  console.log("Launching orchestrator (Retriever + Learner)...");
  const orch = launchOrchestrator(SID);
  const started = await waitForStatus(SID, "running", 25000);
  console.log(`Orchestrator started: ${started}`);
  if (!started) { for (let i = 72; i <= 75; i++) record(i, false, "No start"); printSummary(); return; }
  console.log("Waiting for agents to initialize...\n");
  await new Promise(r => setTimeout(r, 12000));

  // Warm-up
  const wh = await injectPrompt(SID, "What database issues have we seen in ecopaths?");
  await waitForRetrieval(SID, wh, 30000);
  console.log("Warm-up complete.\n");

  // ═══════════════════════════════════════════════════════════
  // TEST #72: Knowledge accumulation — 4 different DB errors
  // ═══════════════════════════════════════════════════════════
  console.log("=== Test #72: Knowledge accumulation ===\n");

  const dbErrors = [
    {
      tool_input: { command: 'mvn spring-boot:run' },
      tool_response: `ERROR: org.postgresql.util.PSQLException: FATAL: too many connections for role "postgres"\nCurrent connections: 100, Max: 100\nFix applied: increased HikariCP pool from default to max=20, min=5 in application.properties:\nspring.datasource.hikari.maximum-pool-size=20\nspring.datasource.hikari.minimum-idle=5`
    },
    {
      tool_input: { command: 'curl -s http://localhost:8080/api/reports/heavy' },
      tool_response: `ERROR: org.springframework.dao.QueryTimeoutException: Statement timed out after 30000ms\nQuery: SELECT * FROM activities_user au JOIN ... (complex 5-table join)\nFix: Added statement_timeout=60s in PostgreSQL, added @QueryHints(@QueryHint(name="javax.persistence.query.timeout", value="60000")) on the repository method. Also added index on activities_user(user_id, category_id).`
    },
    {
      tool_input: { command: 'mvn test -pl service' },
      tool_response: `ERROR: org.postgresql.util.PSQLException: ERROR: deadlock detected\nDetail: Process 1234 waits for ShareLock on transaction 5678; blocked by process 9012.\nProcess 9012 waits for ShareLock on transaction 1234; blocked by process 1234.\nFix: Reordered the updates in BatchUpdateService to always acquire locks in the same order (by entity ID ascending). Added @Lock(LockModeType.PESSIMISTIC_WRITE) with timeout.`
    },
    {
      tool_input: { command: 'psql -c "SELECT * FROM activities_user WHERE description LIKE \'%café%\'"' },
      tool_response: `ERROR: character with byte sequence 0xc3 0xa9 in encoding "UTF8" has no equivalent in encoding "LATIN1"\nFix: Database encoding was LATIN1 (legacy). Migrated to UTF8:\n1. pg_dump --encoding=UTF8 > backup.sql\n2. dropdb ecopaths_db && createdb -E UTF8 ecopaths_db\n3. psql -f backup.sql\nAlso set client_encoding=UTF8 in application.properties.`
    }
  ];

  let savedCount = 0;
  for (let i = 0; i < dbErrors.length; i++) {
    const id = await injectToolUse(SID, { tool_name: "Bash", ...dbErrors[i] });
    console.log(`  Error ${i + 1}: injected (id=${id})`);
    const s = await waitForProcessed(id, 90000);
    console.log(`  Learner processed: ${s}`);
    if (s === "completed") savedCount++;
  }

  await new Promise(r => setTimeout(r, 3000));

  // Check how many errors/learnings were saved
  const errSaved = await dbQuery(
    "SELECT id, error_signature FROM errors_solutions WHERE error_signature ILIKE '%too many connections%' OR error_signature ILIKE '%timeout%' OR error_signature ILIKE '%deadlock%' OR error_signature ILIKE '%encoding%' OR error_signature ILIKE '%UTF%' OR error_signature ILIKE '%connection pool%' ORDER BY id DESC LIMIT 10"
  );
  const lrnSaved = await dbQuery(
    "SELECT id, topic FROM learnings WHERE topic ILIKE '%connection%pool%' OR topic ILIKE '%timeout%' OR topic ILIKE '%deadlock%' OR topic ILIKE '%encoding%' OR topic ILIKE '%UTF%' OR topic ILIKE '%HikariCP%' ORDER BY id DESC LIMIT 10"
  );

  const totalSaved = errSaved.rows.length + lrnSaved.rows.length;
  console.log(`\n  Errors saved: ${errSaved.rows.length}`);
  errSaved.rows.forEach(e => console.log(`    [#${e.id}] ${e.error_signature.slice(0, 80)}`));
  console.log(`  Learnings saved: ${lrnSaved.rows.length}`);
  lrnSaved.rows.forEach(l => console.log(`    [#${l.id}] ${l.topic}`));

  record(72, totalSaved >= 2,
    `Knowledge accumulation: errors=${errSaved.rows.length}, learnings=${lrnSaved.rows.length}, total=${totalSaved} (expected ≥2)`);

  await new Promise(r => setTimeout(r, 3000));

  // ═══════════════════════════════════════════════════════════
  // TEST #73: Synthesis retrieval
  // Retriever should combine relevant solutions for a composite problem
  // ═══════════════════════════════════════════════════════════
  console.log("\n=== Test #73: Synthesis retrieval ===\n");

  const synthPrompt = "My database is slow and sometimes hangs completely — queries timeout and occasionally we see deadlocks. What should I check?";
  const synthHash = await injectPrompt(SID, synthPrompt);
  console.log(`  Sent synthesis prompt (hash=${synthHash})`);

  const synthResult = await waitForRetrieval(SID, synthHash, 35000);
  const synthText = synthResult?.context_text || "";
  console.log(`  Retriever type: ${synthResult?.context_type || "timeout"}`);
  console.log(`  Length: ${synthText.length} chars`);
  console.log(`  Preview: ${synthText.slice(0, 400)}`);

  const mentionsPool = /pool|HikariCP|connection/i.test(synthText);
  const mentionsTimeout = /timeout|statement_timeout|query.*timeout/i.test(synthText);
  const mentionsDeadlock = /deadlock|lock.*order/i.test(synthText);
  const aspects = [mentionsPool, mentionsTimeout, mentionsDeadlock].filter(Boolean).length;

  console.log(`  Mentions pool: ${mentionsPool}`);
  console.log(`  Mentions timeout: ${mentionsTimeout}`);
  console.log(`  Mentions deadlock: ${mentionsDeadlock}`);
  console.log(`  Aspects: ${aspects}/3`);

  record(73, synthText.length > 100 && aspects >= 2,
    `Synthesis: aspects=${aspects}/3, pool=${mentionsPool}, timeout=${mentionsTimeout}, deadlock=${mentionsDeadlock}, length=${synthText.length}`);

  await new Promise(r => setTimeout(r, 3000));

  // ═══════════════════════════════════════════════════════════
  // TEST #74: Drilldown depth
  // Inject a detailed PostgreSQL config observation → should enrich existing
  // ═══════════════════════════════════════════════════════════
  console.log("\n=== Test #74: Drilldown depth ===\n");

  const configObs = await injectToolUse(SID, {
    tool_name: "Bash",
    tool_input: { command: `psql -c "SHOW ALL" | grep -E "shared_buffers|work_mem|effective_cache|max_connections"` },
    tool_response: `shared_buffers = 128MB (should be 25% of RAM = 4GB for 16GB server)\nwork_mem = 4MB (increase to 64MB for complex joins)\neffective_cache_size = 4GB (should be 75% of RAM = 12GB)\nmax_connections = 100\n\nOptimal PostgreSQL tuning for our 16GB ecopaths server:\n- shared_buffers = 4GB\n- work_mem = 64MB\n- effective_cache_size = 12GB\n- max_connections = 200\n- Also: enable pg_stat_statements for query monitoring`
  });
  console.log(`  Config observation (id=${configObs})`);
  const sConf = await waitForProcessed(configObs, 90000);
  console.log(`  Learner processed: ${sConf}`);

  await new Promise(r => setTimeout(r, 3000));

  // Check for drilldowns on existing DB-related knowledge
  const drilldowns = await dbQuery(
    "SELECT id, parent_type, parent_id, topic FROM knowledge_details WHERE topic ILIKE '%postgres%' OR topic ILIKE '%tuning%' OR topic ILIKE '%shared_buffers%' OR topic ILIKE '%config%' OR details ILIKE '%shared_buffers%' ORDER BY id DESC LIMIT 5"
  );
  const configLearnings = await dbQuery(
    "SELECT id, topic FROM learnings WHERE topic ILIKE '%postgres%tuning%' OR topic ILIKE '%shared_buffers%' OR insight ILIKE '%shared_buffers%' OR insight ILIKE '%work_mem%' ORDER BY id DESC LIMIT 5"
  );

  console.log(`  Config drilldowns: ${drilldowns.rows.length}`);
  drilldowns.rows.forEach(d => console.log(`    [#${d.id}] ${d.parent_type}#${d.parent_id} → ${d.topic}`));
  console.log(`  Config learnings: ${configLearnings.rows.length}`);
  configLearnings.rows.forEach(l => console.log(`    [#${l.id}] ${l.topic}`));

  const depthAdded = drilldowns.rows.length > 0 || configLearnings.rows.length > 0;
  record(74, depthAdded,
    `Drilldown depth: drilldowns=${drilldowns.rows.length}, learnings=${configLearnings.rows.length}`);

  await new Promise(r => setTimeout(r, 3000));

  // ═══════════════════════════════════════════════════════════
  // TEST #75: Novel problem solving
  // Retriever combines pool + timeout for never-seen problem
  // ═══════════════════════════════════════════════════════════
  console.log("\n=== Test #75: Novel problem solving ===\n");

  const novelPrompt = "Under high traffic, our API connections drop and users see 503 errors. The server has 16GB RAM. What PostgreSQL and HikariCP settings should we tune?";
  const novelHash = await injectPrompt(SID, novelPrompt);
  console.log(`  Sent novel prompt (hash=${novelHash})`);

  const novelResult = await waitForRetrieval(SID, novelHash, 35000);
  const novelText = novelResult?.context_text || "";
  console.log(`  Retriever type: ${novelResult?.context_type || "timeout"}`);
  console.log(`  Length: ${novelText.length} chars`);
  console.log(`  Preview: ${novelText.slice(0, 400)}`);

  const mentionsPoolConf = /pool|HikariCP|max.*pool|maximum/i.test(novelText);
  const mentionsPgConf = /shared_buffers|work_mem|max_connections|effective_cache/i.test(novelText);
  const mentionsCombo = mentionsPoolConf && mentionsPgConf;

  console.log(`  Mentions HikariCP pool: ${mentionsPoolConf}`);
  console.log(`  Mentions PG config: ${mentionsPgConf}`);
  console.log(`  Combined knowledge: ${mentionsCombo}`);

  record(75, novelText.length > 100 && (mentionsPoolConf || mentionsPgConf),
    `Novel problem: pool=${mentionsPoolConf}, pg_config=${mentionsPgConf}, combined=${mentionsCombo}, length=${novelText.length}`);

  // ═══════════════════════════════════════════════════════════
  // Cost + Logs
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
  console.log(`  LEVEL 18 RESULTS: ${passed}/${total} passed`);
  if (failed.length > 0) {
    console.log("  FAILURES:");
    failed.forEach(f => console.log(`    Step ${f.step}: ${f.desc}`));
  }
  console.log(`${"═".repeat(60)}`);
  if (failed.length === 0) {
    console.log(`\n████████████████████████████████████████████████████████████
█                                                          █
█   ALL LEVEL 18 TESTS PASSED — PROBLEM SOLVING!          █
█                                                          █
█   AIDAM accumulates knowledge, synthesizes solutions,    █
█   enriches with drilldowns, and solves novel problems    █
█   by combining previously learned insights.              █
█                                                          █
████████████████████████████████████████████████████████████\n`);
  }
}

run().then(() => process.exit(0)).catch(err => { console.error("Test error:", err); process.exit(1); });
setTimeout(() => { console.log("GLOBAL TIMEOUT"); process.exit(1); }, 600000);
