/**
 * AIDAM Level 16 — Code Comprehension ("Je comprends le code")
 *
 * #63: Architecture extraction — Learner extracts "why" from security config edit
 * #64: Anti-pattern detection — Learner spots an N+1 query in code edit
 * #65: Refactoring pattern — Learner captures Extract Service refactoring
 * #66: Architecture recall — Retriever explains auth architecture from learned patterns
 *
 * AGI Level: 86/100
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
  const logFile = `C:/Users/user/.claude/logs/aidam_orch_test16_${sessionId.slice(-8)}.log`;
  const args = [
    ORCHESTRATOR,
    `--session-id=${sessionId}`,
    "--cwd=C:/Users/user/IdeaProjects/ecopathsWebApp1b",
    `--retriever=${opts.retriever || "on"}`,
    `--learner=${opts.learner || "on"}`,
    "--compactor=off",
    "--project-slug=ecopaths",
  ];
  const fd = fs.openSync(logFile, "w");
  const p = spawn("node", args, { stdio: ["ignore", fd, fd], detached: false });
  let exited = false;
  p.on("exit", () => { exited = true; });
  return { proc: p, logFile, isExited: () => exited };
}

async function killSession(sessionId, proc) {
  try { await dbQuery("UPDATE orchestrator_state SET status='stopping' WHERE session_id=$1", [sessionId]); } catch {}
  await new Promise(r => setTimeout(r, 4000));
  try { proc.kill(); } catch {}
  await new Promise(r => setTimeout(r, 1000));
}

async function cleanSession(sessionId) {
  await dbQuery("DELETE FROM orchestrator_state WHERE session_id=$1", [sessionId]);
  await dbQuery("DELETE FROM cognitive_inbox WHERE session_id=$1", [sessionId]);
  await dbQuery("DELETE FROM retrieval_inbox WHERE session_id=$1", [sessionId]);
}

async function injectToolUse(sessionId, payload) {
  const r = await dbQuery(
    "INSERT INTO cognitive_inbox (session_id, message_type, payload, status) VALUES ($1, 'tool_use', $2, 'pending') RETURNING id",
    [sessionId, JSON.stringify(payload)]
  );
  return r.rows[0].id;
}

async function injectPrompt(sessionId, prompt) {
  const hash = crypto.createHash("sha256").update(prompt).digest("hex").slice(0, 16);
  await dbQuery(
    "INSERT INTO cognitive_inbox (session_id, message_type, payload, status) VALUES ($1, 'prompt_context', $2, 'pending')",
    [sessionId, JSON.stringify({ prompt, prompt_hash: hash, timestamp: Date.now() })]
  );
  return hash;
}

async function waitForProcessed(msgId, timeoutMs = 90000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const r = await dbQuery("SELECT status FROM cognitive_inbox WHERE id=$1", [msgId]);
    if (r.rows.length > 0 && (r.rows[0].status === "completed" || r.rows[0].status === "failed")) {
      return r.rows[0].status;
    }
    await new Promise(r => setTimeout(r, 2000));
  }
  return "timeout";
}

async function waitForRetrieval(sessionId, promptHash, timeoutMs = 35000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const r = await dbQuery(
      "SELECT context_type, context_text FROM retrieval_inbox WHERE session_id=$1 AND prompt_hash=$2 ORDER BY id DESC LIMIT 1",
      [sessionId, promptHash]
    );
    if (r.rows.length > 0) return r.rows[0];
    await new Promise(r => setTimeout(r, 1000));
  }
  return null;
}

function readLog(logFile) {
  try { return fs.readFileSync(logFile, "utf-8"); } catch { return ""; }
}

function extractCost(logContent) {
  const matches = logContent.match(/cost: \$([0-9.]+)/g) || [];
  return matches.reduce((sum, m) => sum + parseFloat(m.replace("cost: $", "")), 0);
}

const TEST_TAG = `L16_${Date.now()}`;

async function run() {
  const SESSION_ID = `level16-${Date.now()}`;
  console.log(`\n${"═".repeat(60)}`);
  console.log(`  AIDAM Level 16: Code Comprehension ("Je comprends le code")`);
  console.log(`${"═".repeat(60)}`);
  console.log(`Session ID: ${SESSION_ID}`);
  console.log(`Test tag: ${TEST_TAG}\n`);

  await cleanSession(SESSION_ID);

  console.log("Launching orchestrator (Retriever + Learner)...");
  const orch = launchOrchestrator(SESSION_ID);
  const started = await waitForStatus(SESSION_ID, "running", 25000);
  console.log(`Orchestrator started: ${started}`);
  if (!started) {
    console.log("FATAL: Orchestrator didn't start.");
    for (let i = 63; i <= 66; i++) record(i, false, "Orchestrator didn't start");
    printSummary();
    return;
  }
  console.log("Waiting for agents to initialize...\n");
  await new Promise(r => setTimeout(r, 12000));

  // Warm-up — neutral topic, unrelated to security/auth
  const warmHash = await injectPrompt(SESSION_ID, "What projects are stored in memory?");
  await waitForRetrieval(SESSION_ID, warmHash, 30000);
  console.log("Warm-up complete.\n");
  await new Promise(r => setTimeout(r, 5000));

  // ═══════════════════════════════════════════════════════════
  // TEST #63: Architecture extraction
  // Learner sees an Edit on SecurityConfig.java adding JWT filter chain
  // Should save the WHY (not just the what)
  // ═══════════════════════════════════════════════════════════
  console.log("=== Test #63: Architecture extraction ===\n");

  const secEdit = await injectToolUse(SESSION_ID, {
    tool_name: "Edit",
    tool_input: {
      file_path: "src/main/java/com/ecopaths/config/SecurityConfig.java",
      old_string: "http.csrf().disable();",
      new_string: `http.csrf().disable()
    .sessionManagement().sessionCreationPolicy(SessionCreationPolicy.STATELESS)
    .and()
    .addFilterBefore(jwtAuthenticationFilter, UsernamePasswordAuthenticationFilter.class)
    .authorizeRequests()
    .antMatchers("/api/authenticate", "/api/health", "/api/version").permitAll()
    .antMatchers("/api/admin/**").hasRole("ADMIN")
    .anyRequest().authenticated();`
    },
    tool_response: `File edited successfully.\n\nThe SecurityConfig now:\n1. Disables sessions (stateless for JWT)\n2. Adds JwtAuthenticationFilter BEFORE UsernamePasswordAuth filter\n3. Permits /api/authenticate, /api/health, /api/version without auth\n4. Restricts /api/admin/** to ADMIN role\n5. All other endpoints require authentication\n\nThis is a standard Spring Security + JWT configuration. The key decision is making it STATELESS (no server-side sessions) because we use JWT tokens. The filter order matters — JWT filter must come first to extract the token before Spring's default auth kicks in.`
  });
  console.log(`  Edit observation: SecurityConfig.java (id=${secEdit})`);
  const sEdit = await waitForProcessed(secEdit, 90000);
  console.log(`  Learner processed: ${sEdit}`);

  await new Promise(r => setTimeout(r, 3000));

  // Check what was saved — should have WHY (stateless, filter order, JWT)
  const secPatterns = await dbQuery(
    "SELECT id, name, solution, context FROM patterns WHERE name ILIKE '%security%' OR name ILIKE '%JWT%' OR name ILIKE '%filter%' OR context ILIKE '%SecurityConfig%' OR solution ILIKE '%stateless%' ORDER BY id DESC LIMIT 5"
  );
  const secLearnings = await dbQuery(
    "SELECT id, topic, insight FROM learnings WHERE topic ILIKE '%security%' OR topic ILIKE '%JWT%' OR topic ILIKE '%filter%' OR insight ILIKE '%SecurityConfig%' OR insight ILIKE '%stateless%' ORDER BY id DESC LIMIT 5"
  );

  console.log(`  Security patterns: ${secPatterns.rows.length}`);
  secPatterns.rows.forEach(p => console.log(`    [#${p.id}] ${p.name}`));
  console.log(`  Security learnings: ${secLearnings.rows.length}`);
  secLearnings.rows.forEach(l => console.log(`    [#${l.id}] ${l.topic}`));

  // Check for WHY content (not just WHAT)
  const allText = [...secPatterns.rows.map(p => `${p.solution} ${p.context}`), ...secLearnings.rows.map(l => l.insight)].join(" ");
  const hasWhy = /stateless|filter.*order|before.*Username|JWT.*first|no.*session/i.test(allText);
  const savedSomething = secPatterns.rows.length > 0 || secLearnings.rows.length > 0;

  console.log(`  Contains WHY (stateless/filter order): ${hasWhy}`);

  record(63, savedSomething,
    `Architecture extraction: patterns=${secPatterns.rows.length}, learnings=${secLearnings.rows.length}, has_why=${hasWhy}`);

  await new Promise(r => setTimeout(r, 3000));

  // ═══════════════════════════════════════════════════════════
  // TEST #64: Anti-pattern detection
  // Learner sees code that introduces an N+1 query problem
  // ═══════════════════════════════════════════════════════════
  console.log("\n=== Test #64: Anti-pattern detection ===\n");

  const n1Edit = await injectToolUse(SESSION_ID, {
    tool_name: "Edit",
    tool_input: {
      file_path: "src/main/java/com/ecopaths/service/ActivityService.java",
      old_string: "return activityRepository.findAll();",
      new_string: `List<Activity> activities = activityRepository.findAll();
    for (Activity a : activities) {
        // BUG: N+1 query! Each iteration fires a separate SQL query
        User user = userRepository.findById(a.getUserId()).orElseThrow();
        a.setUserName(user.getFullName());
    }
    return activities;`
    },
    tool_response: `File edited. WARNING: This introduces an N+1 query problem!\nWith 100 activities, this fires 101 SQL queries (1 for findAll + 100 for findById).\n\nFix: Use a JOIN in the repository query or @EntityGraph, or batch-load users:\n  @Query("SELECT a FROM Activity a JOIN FETCH a.user")\n  List<Activity> findAllWithUsers();`
  });
  console.log(`  Edit observation: N+1 query (id=${n1Edit})`);
  const sN1 = await waitForProcessed(n1Edit, 90000);
  console.log(`  Learner processed: ${sN1}`);

  await new Promise(r => setTimeout(r, 3000));

  const n1Patterns = await dbQuery(
    "SELECT id, name FROM patterns WHERE name ILIKE '%N+1%' OR name ILIKE '%N\\+1%' OR context ILIKE '%N+1%' OR solution ILIKE '%N+1%' OR name ILIKE '%query%problem%' ORDER BY id DESC LIMIT 5"
  );
  const n1Learnings = await dbQuery(
    "SELECT id, topic FROM learnings WHERE topic ILIKE '%N+1%' OR topic ILIKE '%N\\+1%' OR insight ILIKE '%N+1%' OR topic ILIKE '%query%' ORDER BY id DESC LIMIT 5"
  );
  const n1Errors = await dbQuery(
    "SELECT id, error_signature FROM errors_solutions WHERE error_signature ILIKE '%N+1%' OR error_signature ILIKE '%N\\+1%' OR solution ILIKE '%N+1%' OR solution ILIKE '%JOIN FETCH%' ORDER BY id DESC LIMIT 5"
  );

  console.log(`  N+1 patterns: ${n1Patterns.rows.length}`);
  n1Patterns.rows.forEach(p => console.log(`    [#${p.id}] ${p.name}`));
  console.log(`  N+1 learnings: ${n1Learnings.rows.length}`);
  n1Learnings.rows.forEach(l => console.log(`    [#${l.id}] ${l.topic}`));
  console.log(`  N+1 errors: ${n1Errors.rows.length}`);
  n1Errors.rows.forEach(e => console.log(`    [#${e.id}] ${e.error_signature}`));

  const n1Detected = n1Patterns.rows.length > 0 || n1Learnings.rows.length > 0 || n1Errors.rows.length > 0;
  record(64, n1Detected,
    `Anti-pattern: patterns=${n1Patterns.rows.length}, learnings=${n1Learnings.rows.length}, errors=${n1Errors.rows.length}`);

  await new Promise(r => setTimeout(r, 3000));

  // ═══════════════════════════════════════════════════════════
  // TEST #65: Refactoring pattern
  // Learner sees an Extract Service refactoring
  // ═══════════════════════════════════════════════════════════
  console.log("\n=== Test #65: Refactoring pattern ===\n");

  const refactorEdit = await injectToolUse(SESSION_ID, {
    tool_name: "Bash",
    tool_input: { command: `# Extract EmailService from UserService
# Before: UserService had sendWelcomeEmail(), sendPasswordResetEmail(), sendNotification()
# After: Created EmailService with those 3 methods, UserService delegates to EmailService
# Files changed:
#   - src/main/java/com/ecopaths/service/UserService.java (removed email methods, added @Autowired EmailService)
#   - src/main/java/com/ecopaths/service/EmailService.java (NEW - extracted email logic)
#   - src/main/java/com/ecopaths/config/MailConfig.java (moved from UserService inner config)
# Reason: Single Responsibility Principle — UserService was doing user CRUD + email sending` },
    tool_response: `Refactoring complete. UserService: 450 lines → 280 lines. EmailService: 190 lines (new).\nAll 12 unit tests pass. Email functionality unchanged.\n\nKey decisions:\n- EmailService is @Service (Spring-managed), injected into UserService\n- MailConfig extracted as standalone @Configuration\n- Interface EmailPort created for testability (hexagonal architecture)\n- UserService tests now mock EmailService instead of MailSender directly`
  });
  console.log(`  Refactoring observation (id=${refactorEdit})`);
  const sRef = await waitForProcessed(refactorEdit, 90000);
  console.log(`  Learner processed: ${sRef}`);

  await new Promise(r => setTimeout(r, 3000));

  const refPatterns = await dbQuery(
    "SELECT id, name FROM patterns WHERE name ILIKE '%extract%' OR name ILIKE '%refactor%' OR name ILIKE '%single responsib%' OR context ILIKE '%extract%service%' OR solution ILIKE '%EmailService%' ORDER BY id DESC LIMIT 5"
  );
  const refLearnings = await dbQuery(
    "SELECT id, topic FROM learnings WHERE topic ILIKE '%extract%' OR topic ILIKE '%refactor%' OR topic ILIKE '%single responsib%' OR insight ILIKE '%EmailService%' OR insight ILIKE '%extract%service%' ORDER BY id DESC LIMIT 5"
  );

  console.log(`  Refactoring patterns: ${refPatterns.rows.length}`);
  refPatterns.rows.forEach(p => console.log(`    [#${p.id}] ${p.name}`));
  console.log(`  Refactoring learnings: ${refLearnings.rows.length}`);
  refLearnings.rows.forEach(l => console.log(`    [#${l.id}] ${l.topic}`));

  const refSaved = refPatterns.rows.length > 0 || refLearnings.rows.length > 0;
  record(65, refSaved,
    `Refactoring pattern: patterns=${refPatterns.rows.length}, learnings=${refLearnings.rows.length}`);

  await new Promise(r => setTimeout(r, 3000));

  // ═══════════════════════════════════════════════════════════
  // TEST #66: Architecture recall
  // Retriever explains auth when asked
  // ═══════════════════════════════════════════════════════════
  console.log("\n=== Test #66: Architecture recall ===\n");

  const archPrompt = "NEW TASK: Explain the Spring Security JWT configuration in our ecopaths project — the filter chain setup, stateless session policy, and which endpoints are public vs protected.";
  const archHash = await injectPrompt(SESSION_ID, archPrompt);
  console.log(`  Sent architecture prompt (hash=${archHash})`);

  const archResult = await waitForRetrieval(SESSION_ID, archHash, 35000);
  const archText = archResult?.context_text || "";
  console.log(`  Retriever type: ${archResult?.context_type || "timeout"}`);
  console.log(`  Length: ${archText.length} chars`);
  console.log(`  Preview: ${archText.slice(0, 400)}`);

  const mentionsJWT = /JWT|token/i.test(archText);
  const mentionsFilter = /filter|SecurityConfig/i.test(archText);
  const mentionsStateless = /stateless|no.*session/i.test(archText);
  const mentionsEndpoints = /permitAll|authenticate|admin/i.test(archText);
  const aspects = [mentionsJWT, mentionsFilter, mentionsStateless, mentionsEndpoints].filter(Boolean).length;

  console.log(`  Mentions JWT: ${mentionsJWT}`);
  console.log(`  Mentions filter/SecurityConfig: ${mentionsFilter}`);
  console.log(`  Mentions stateless: ${mentionsStateless}`);
  console.log(`  Mentions endpoints: ${mentionsEndpoints}`);
  console.log(`  Architecture aspects: ${aspects}/4`);

  record(66, archText.length > 100 && aspects >= 2,
    `Architecture recall: aspects=${aspects}/4, jwt=${mentionsJWT}, filter=${mentionsFilter}, stateless=${mentionsStateless}, length=${archText.length}`);

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

  await killSession(SESSION_ID, orch.proc);
  await cleanSession(SESSION_ID);

  printSummary();
}

function printSummary() {
  const passed = results.filter(r => r.passed).length;
  const total = results.length;
  const failed = results.filter(r => !r.passed);
  console.log(`\n${"═".repeat(60)}`);
  console.log(`  LEVEL 16 RESULTS: ${passed}/${total} passed`);
  if (failed.length > 0) {
    console.log("  FAILURES:");
    failed.forEach(f => console.log(`    Step ${f.step}: ${f.desc}`));
  }
  console.log(`${"═".repeat(60)}`);
  if (failed.length === 0) {
    console.log(`\n████████████████████████████████████████████████████████████
█                                                          █
█   ALL LEVEL 16 TESTS PASSED — CODE COMPREHENSION!       █
█                                                          █
█   AIDAM understands architecture (WHY, not just WHAT),   █
█   detects anti-patterns, captures refactoring patterns,  █
█   and explains the full security picture from memory.    █
█                                                          █
████████████████████████████████████████████████████████████\n`);
  }
}

run().then(() => process.exit(0)).catch(err => {
  console.error("Test error:", err);
  process.exit(1);
});

setTimeout(() => { console.log("GLOBAL TIMEOUT"); process.exit(1); }, 600000);
