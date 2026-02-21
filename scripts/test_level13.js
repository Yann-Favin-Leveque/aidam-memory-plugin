/**
 * AIDAM Level 13 — Parallel Sessions ("Je coexiste")
 *
 * #49: Two orchestrators run simultaneously without interference
 * #50: Learner isolation — session A's Learner doesn't see session B's tool_use
 * #51: Retriever isolation — session A's Retriever doesn't answer session B's prompts
 * #52: PID file scoping — killing session A doesn't kill session B
 * #53: /clear marker in DB — correct previous session is found per-session
 *
 * Strategy: Launch TWO orchestrators (session A + session B) simultaneously,
 * inject events into each, and verify strict isolation.
 */
const { Client } = require("pg");
const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });
const { askValidator } = require("./test_helpers.js");

const DB = {
  host: "localhost", database: "claude_memory",
  user: "postgres", password: process.env.PGPASSWORD || "", port: 5432,
};
const ORCHESTRATOR = path.join(__dirname, "orchestrator.js");
const PLUGIN_ROOT = path.join(__dirname, "..");

const results = [];
function record(step, passed, desc) {
  results.push({ step, passed, desc });
  console.log(`  ${passed ? "PASS" : "FAIL"}: ${desc}`);
}

async function query(sql, params = []) {
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
    const r = await query("SELECT status FROM orchestrator_state WHERE session_id=$1", [sessionId]);
    if (r.rows.length > 0 && regex.test(r.rows[0].status)) return true;
    await new Promise(r => setTimeout(r, 1000));
  }
  return false;
}

function launchOrchestrator(sessionId, opts = {}) {
  const logFile = `C:/Users/user/.claude/logs/aidam_orch_test13_${sessionId.slice(-8)}.log`;
  const args = [
    ORCHESTRATOR,
    `--session-id=${sessionId}`,
    "--cwd=C:/Users/user/IdeaProjects/ecopathsWebApp1b",
    `--retriever=${opts.retriever || "on"}`,
    `--learner=${opts.learner || "on"}`,
    "--compactor=off",
  ];
  const p = spawn("node", args, {
    stdio: ["ignore", fs.openSync(logFile, "w"), fs.openSync(logFile, "a")],
    detached: false,
  });
  let exited = false;
  p.on("exit", () => { exited = true; });
  return { proc: p, logFile, isExited: () => exited };
}

async function killSession(sessionId, proc) {
  try { await query("UPDATE orchestrator_state SET status='stopping' WHERE session_id=$1", [sessionId]); } catch {}
  await new Promise(r => setTimeout(r, 4000));
  try { proc.kill(); } catch {}
  await new Promise(r => setTimeout(r, 1000));
}

async function cleanSession(sessionId) {
  await query("DELETE FROM orchestrator_state WHERE session_id=$1", [sessionId]);
  await query("DELETE FROM cognitive_inbox WHERE session_id=$1", [sessionId]);
  await query("DELETE FROM retrieval_inbox WHERE session_id=$1", [sessionId]);
}

async function injectToolUse(sessionId, payload) {
  const r = await query(
    "INSERT INTO cognitive_inbox (session_id, message_type, payload, status) VALUES ($1, 'tool_use', $2, 'pending') RETURNING id",
    [sessionId, JSON.stringify(payload)]
  );
  return r.rows[0].id;
}

async function injectPrompt(sessionId, prompt) {
  const hash = crypto.createHash("sha256").update(prompt).digest("hex").slice(0, 16);
  await query(
    "INSERT INTO cognitive_inbox (session_id, message_type, payload, status) VALUES ($1, 'prompt_context', $2, 'pending')",
    [sessionId, JSON.stringify({ prompt, prompt_hash: hash, timestamp: Date.now() })]
  );
  return hash;
}

async function waitForProcessed(msgId, timeoutMs = 60000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const r = await query("SELECT status FROM cognitive_inbox WHERE id=$1", [msgId]);
    if (r.rows.length > 0 && (r.rows[0].status === "completed" || r.rows[0].status === "failed")) {
      return r.rows[0].status;
    }
    await new Promise(r => setTimeout(r, 2000));
  }
  return "timeout";
}

async function waitForRetrieval(sessionId, promptHash, timeoutMs = 30000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const r = await query(
      "SELECT context_type, context_text FROM retrieval_inbox WHERE session_id=$1 AND prompt_hash=$2 ORDER BY id DESC LIMIT 1",
      [sessionId, promptHash]
    );
    if (r.rows.length > 0) return r.rows[0];
    await new Promise(r => setTimeout(r, 1000));
  }
  return null;
}

const TEST_TAG = `L13_${Date.now()}`;

async function run() {
  const SID_A = `parallel-A-${Date.now()}`;
  const SID_B = `parallel-B-${Date.now()}`;
  console.log(`\n${"═".repeat(60)}`);
  console.log(`  AIDAM Level 13: Parallel Sessions ("Je coexiste")`);
  console.log(`${"═".repeat(60)}`);
  let validatorCost = 0;
  console.log(`Session A: ${SID_A}`);
  console.log(`Session B: ${SID_B}\n`);

  // Clean state
  await cleanSession(SID_A);
  await cleanSession(SID_B);

  // ═══════════════════════════════════════════════════════════
  // TEST #49: Two orchestrators run simultaneously
  // ═══════════════════════════════════════════════════════════
  console.log("=== Test #49: Two orchestrators run simultaneously ===\n");

  console.log("  Launching orchestrator A (Retriever + Learner)...");
  const orchA = launchOrchestrator(SID_A);
  console.log("  Launching orchestrator B (Retriever + Learner)...");
  const orchB = launchOrchestrator(SID_B);

  const [startedA, startedB] = await Promise.all([
    waitForStatus(SID_A, "running", 25000),
    waitForStatus(SID_B, "running", 25000),
  ]);
  console.log(`  A started: ${startedA}`);
  console.log(`  B started: ${startedB}`);

  // Verify both are registered in DB as running
  const runningRows = await query(
    "SELECT session_id, status, pid FROM orchestrator_state WHERE session_id IN ($1, $2) AND status='running'",
    [SID_A, SID_B]
  );
  const bothRunning = runningRows.rows.length === 2;
  const differentPids = runningRows.rows.length === 2 &&
    runningRows.rows[0].pid !== runningRows.rows[1].pid;

  console.log(`  Both running in DB: ${bothRunning}`);
  console.log(`  Different PIDs: ${differentPids}`);

  record(49, bothRunning && differentPids,
    `Parallel launch: A=${startedA}, B=${startedB}, both_running=${bothRunning}, diff_pids=${differentPids}`);

  if (!bothRunning) {
    for (let i = 50; i <= 53; i++) record(i, false, "Skipped (orchestrators didn't start)");
    await cleanup(SID_A, SID_B, orchA, orchB);
    printSummary();
    return;
  }

  console.log("  Waiting for agents to initialize...");
  await new Promise(r => setTimeout(r, 10000));

  // ═══════════════════════════════════════════════════════════
  // TEST #50: Learner isolation
  // Inject tool_use into session A only. Session B's Learner must NOT process it.
  // ═══════════════════════════════════════════════════════════
  console.log("\n=== Test #50: Learner isolation ===\n");

  const toolPayloadA = {
    tool_name: "Bash",
    tool_input: { command: "echo 'Session A unique marker: ALPHA_ONLY_A'" },
    tool_response: `Session A unique marker: ALPHA_ONLY_A\nFixed critical bug in AuthService.validateToken() — was comparing expired timestamps wrong. ${TEST_TAG}_SESSION_A`
  };

  const msgIdA = await injectToolUse(SID_A, toolPayloadA);
  console.log(`  Injected tool_use into session A (id=${msgIdA})`);

  // Wait for A's Learner to process it
  const statusA = await waitForProcessed(msgIdA, 60000);
  console.log(`  Session A Learner processed: ${statusA}`);

  // Check that session B's cognitive_inbox has NO pending/completed tool_use from A
  const bInbox = await query(
    "SELECT id, status FROM cognitive_inbox WHERE session_id=$1 AND message_type='tool_use' AND status IN ('completed','processing')",
    [SID_B]
  );
  console.log(`  Session B processed tool_use events: ${bInbox.rows.length}`);

  // Check orchestrator B's log for any mention of ALPHA_ONLY_A
  const logB = fs.readFileSync(orchB.logFile, "utf-8");
  const bSawA = /ALPHA_ONLY_A/i.test(logB);
  console.log(`  Session B log mentions ALPHA_ONLY_A: ${bSawA}`);

  const preCheck50 = statusA === "completed" && bInbox.rows.length === 0 && !bSawA;
  if (preCheck50) {
    const v50 = await askValidator(50, "The Learner correctly processed tool_use from session A without cross-contaminating session B's inbox", { statusA, bInboxCount: bInbox.rows.length, bSawA, logBExcerpt: logB.slice(-500) }, "Session B's cognitive_inbox must have zero entries from session A's tool observations");
    validatorCost += v50.cost;
    record(50, v50.passed, `${v50.reason}`);
  } else {
    record(50, false, `Structural pre-check failed: A_processed=${statusA}, B_processed=${bInbox.rows.length}, B_saw_A=${bSawA}`);
  }

  await new Promise(r => setTimeout(r, 3000));

  // ═══════════════════════════════════════════════════════════
  // TEST #51: Retriever isolation
  // Send a prompt to session A, verify NO result appears in session B's retrieval_inbox
  // ═══════════════════════════════════════════════════════════
  console.log("\n=== Test #51: Retriever isolation ===\n");

  const promptA = "What authentication setup do we have in the ecopaths project?";
  const hashA = await injectPrompt(SID_A, promptA);
  console.log(`  Sent prompt to session A (hash=${hashA})`);

  // Wait for A's retrieval result
  const resultA = await waitForRetrieval(SID_A, hashA, 30000);
  console.log(`  Session A retrieval: ${resultA?.context_type || "timeout"}, ${resultA?.context_text?.length || 0} chars`);

  // Check that session B's retrieval_inbox has NO result with this hash
  const bRetrieval = await query(
    "SELECT id FROM retrieval_inbox WHERE session_id=$1 AND prompt_hash=$2",
    [SID_B, hashA]
  );
  console.log(`  Session B retrieval results for A's hash: ${bRetrieval.rows.length}`);

  // Also send a prompt to B and verify it gets its OWN result
  const promptB = "What's the current state of the ecopaths project?";
  const hashB = await injectPrompt(SID_B, promptB);
  console.log(`  Sent prompt to session B (hash=${hashB})`);

  const resultB = await waitForRetrieval(SID_B, hashB, 30000);
  console.log(`  Session B retrieval: ${resultB?.context_type || "timeout"}, ${resultB?.context_text?.length || 0} chars`);

  // Verify A doesn't have B's result
  const aRetrievalForB = await query(
    "SELECT id FROM retrieval_inbox WHERE session_id=$1 AND prompt_hash=$2",
    [SID_A, hashB]
  );
  console.log(`  Session A retrieval results for B's hash: ${aRetrievalForB.rows.length}`);

  const isolated = bRetrieval.rows.length === 0 && aRetrievalForB.rows.length === 0;
  const preCheck51 = isolated && resultA !== null;
  if (preCheck51) {
    const v51 = await askValidator(51, "The Retriever correctly returned results only for session A's prompt, with no cross-contamination to session B", { bRetrievalCount: bRetrieval.rows.length, aRetrievalForBCount: aRetrievalForB.rows.length, resultAType: resultA?.context_type, resultALen: resultA?.context_text?.length, resultBType: resultB?.context_type }, "Session B's retrieval_inbox must have zero entries matching session A's prompt hash");
    validatorCost += v51.cost;
    record(51, v51.passed, `${v51.reason}`);
  } else {
    record(51, false, `Structural pre-check failed: B_has_A=${bRetrieval.rows.length}, A_has_B=${aRetrievalForB.rows.length}, resultA=${resultA !== null}`);
  }

  await new Promise(r => setTimeout(r, 3000));

  // ═══════════════════════════════════════════════════════════
  // TEST #52: PID file scoping — killing A doesn't kill B
  // ═══════════════════════════════════════════════════════════
  console.log("\n=== Test #52: PID file scoping ===\n");

  // Check that PID files are scoped
  const pidFileA = path.join(PLUGIN_ROOT, `.orchestrator_${SID_A}.pid`);
  const pidFileB = path.join(PLUGIN_ROOT, `.orchestrator_${SID_B}.pid`);
  const legacyPidFile = path.join(PLUGIN_ROOT, `.orchestrator.pid`);

  // PID files may not exist if launched via test (not via on_session_start.sh)
  // But we can verify the concept: killing A's orchestrator should leave B alive
  console.log(`  Killing session A's orchestrator...`);
  await killSession(SID_A, orchA.proc);

  // Wait a moment and check B is still running
  await new Promise(r => setTimeout(r, 3000));
  const bStillRunning = await query(
    "SELECT status FROM orchestrator_state WHERE session_id=$1",
    [SID_B]
  );
  const bAlive = bStillRunning.rows.length > 0 && bStillRunning.rows[0].status === "running";
  console.log(`  Session B still running after A killed: ${bAlive}`);

  // Verify by sending a prompt to B
  const checkPrompt = "Quick check — are you still alive?";
  const checkHash = await injectPrompt(SID_B, checkPrompt);
  const checkResult = await waitForRetrieval(SID_B, checkHash, 25000);
  const bResponds = checkResult !== null;
  console.log(`  Session B responds to prompt after A killed: ${bResponds}`);

  record(52, bAlive && bResponds,
    `PID isolation: B_alive=${bAlive}, B_responds=${bResponds}`);

  // ═══════════════════════════════════════════════════════════
  // TEST #53: /clear marker in DB — correct session found
  // ═══════════════════════════════════════════════════════════
  console.log("\n=== Test #53: /clear marker in DB ===\n");

  // Simulate two /clear events: A was cleared, B was cleared
  // Insert fake session_state for both
  await query(
    "INSERT INTO session_state (session_id, project_slug, state_text, raw_tail_path, token_estimate, version) VALUES ($1, 'test', $2, '', 100, 1) ON CONFLICT DO NOTHING",
    [SID_A, `=== STATE A === Task: Fix auth bug. ${TEST_TAG}_STATE_A`]
  );
  await query(
    "INSERT INTO session_state (session_id, project_slug, state_text, raw_tail_path, token_estimate, version) VALUES ($1, 'test', $2, '', 100, 1) ON CONFLICT DO NOTHING",
    [SID_B, `=== STATE B === Task: Add email feature. ${TEST_TAG}_STATE_B`]
  );

  // Mark both as cleared in orchestrator_state
  await query("UPDATE orchestrator_state SET status='cleared' WHERE session_id=$1", [SID_A]);
  // B is still running — only A should be picked up
  // (In real usage, both would be cleared, but let's test that B's running status blocks it)

  // Now simulate a NEW session C that needs to find the previous cleared session
  const SID_C = `parallel-C-${Date.now()}`;

  // Call inject_state.py with C's session_id — it should find A (which is 'cleared')
  const { execSync } = require("child_process");
  let injectOutput = "";
  try {
    injectOutput = execSync(
      `"C:/Users/user/AppData/Local/Programs/Python/Python312/python.exe" "${path.join(__dirname, "inject_state.py")}" clear "${SID_C}"`,
      { encoding: "utf-8", timeout: 10000 }
    ).trim();
  } catch (e) {
    injectOutput = "";
  }

  console.log(`  inject_state.py output length: ${injectOutput.length}`);

  let foundCorrectState = false;
  if (injectOutput) {
    try {
      const parsed = JSON.parse(injectOutput);
      const ctx = parsed?.hookSpecificOutput?.additionalContext || "";
      console.log(`  Context preview: ${ctx.slice(0, 200)}`);
      foundCorrectState = ctx.includes("STATE A") || ctx.includes("Fix auth bug");
      const wrongState = ctx.includes("STATE B") && !ctx.includes("STATE A");
      console.log(`  Found A's state: ${foundCorrectState}`);
      console.log(`  Wrong state (B instead of A): ${wrongState}`);
    } catch (e) {
      console.log(`  Parse error: ${e.message}`);
    }
  }

  // Verify A's status was updated to 'injected' (consumed)
  const aStatus = await query("SELECT status FROM orchestrator_state WHERE session_id=$1", [SID_A]);
  const aInjected = aStatus.rows.length > 0 && aStatus.rows[0].status === "injected";
  console.log(`  A's status after injection: ${aStatus.rows[0]?.status} (expected: injected)`);

  record(53, foundCorrectState && aInjected,
    `DB marker: found_A_state=${foundCorrectState}, A_marked_injected=${aInjected}`);

  // ═══════════════════════════════════════════════════════════
  // Cleanup
  // ═══════════════════════════════════════════════════════════
  console.log("\n--- Orchestrator A Log (last 1000 chars) ---");
  const logAFinal = fs.existsSync(orchA.logFile) ? fs.readFileSync(orchA.logFile, "utf-8") : "";
  console.log(logAFinal.slice(-1000));
  console.log("--- Orchestrator B Log (last 1000 chars) ---");
  const logBFinal = fs.existsSync(orchB.logFile) ? fs.readFileSync(orchB.logFile, "utf-8") : "";
  console.log(logBFinal.slice(-1000));
  console.log("--- End Logs ---\n");

  await cleanup(SID_A, SID_B, orchA, orchB);
  // Also clean C and session_state
  await query("DELETE FROM session_state WHERE session_id IN ($1, $2)", [SID_A, SID_B]);
  await cleanSession(`parallel-C-${SID_C.split("-").pop()}`);

  console.log(`  Validator cost: $${validatorCost.toFixed(4)}`);
  printSummary();
}

async function cleanup(sidA, sidB, orchA, orchB) {
  console.log("Cleaning up...");
  await killSession(sidB, orchB.proc);
  // A was already killed in test #52
  try { orchA.proc.kill(); } catch {}
  await cleanSession(sidA);
  await cleanSession(sidB);
  // Clean PID files
  try { fs.unlinkSync(path.join(PLUGIN_ROOT, `.orchestrator_${sidA}.pid`)); } catch {}
  try { fs.unlinkSync(path.join(PLUGIN_ROOT, `.orchestrator_${sidB}.pid`)); } catch {}
}

function printSummary() {
  const passed = results.filter(r => r.passed).length;
  const total = results.length;
  const failed = results.filter(r => !r.passed);
  console.log(`\n${"═".repeat(60)}`);
  console.log(`  LEVEL 13 RESULTS: ${passed}/${total} passed`);
  if (failed.length > 0) {
    console.log("  FAILURES:");
    failed.forEach(f => console.log(`    Step ${f.step}: ${f.desc}`));
  }
  console.log(`${"═".repeat(60)}`);
  if (failed.length === 0) {
    console.log("\n=== ALL LEVEL 13 TESTS PASSED — PARALLEL SESSIONS VERIFIED ===");
  }
}

run().then(() => process.exit(0)).catch(err => {
  console.error("Test error:", err);
  process.exit(1);
});

setTimeout(() => { console.log("GLOBAL TIMEOUT"); process.exit(1); }, 600000);
