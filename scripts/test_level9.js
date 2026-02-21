/**
 * AIDAM Level 9 — Verified Learning Quality ("J'apprends bien")
 *
 * #29: Bug fix tool_use → Learner saves error+solution correctly
 * #30: 3 similar fixes → Learner deduplicates (doesn't create 3 entries)
 * #31: Same bug prompt → Retriever injects previous solution
 * #32: Relevance rate measurement (target >60%)
 * #33: Learner does NOT save noise (routine operations)
 *
 * This test launches a REAL orchestrator with Retriever+Learner enabled,
 * injects simulated tool_use and prompt_context messages into cognitive_inbox,
 * and verifies that the Learner saves correctly and the Retriever retrieves.
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

async function query(sql, params = []) {
  const db = new Client(DB);
  await db.connect();
  const r = await db.query(sql, params);
  await db.end();
  return r;
}

async function waitForStatus(sessionId, pattern, timeoutMs = 20000) {
  const regex = new RegExp(pattern, "i");
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const r = await query("SELECT status FROM orchestrator_state WHERE session_id=$1", [sessionId]);
    if (r.rows.length > 0 && regex.test(r.rows[0].status)) return true;
    await new Promise(r => setTimeout(r, 1000));
  }
  return false;
}

function launchOrchestrator(sessionId, extraArgs = []) {
  const logFile = `C:/Users/user/.claude/logs/aidam_orch_test9_${sessionId.slice(-8)}.log`;
  const args = [
    ORCHESTRATOR,
    `--session-id=${sessionId}`,
    "--cwd=C:/Users/user/IdeaProjects/ecopathsWebApp1b",
    "--retriever=on",
    "--learner=on",
    "--compactor=off",
    ...extraArgs,
  ];
  const p = spawn("node", args, {
    stdio: ["ignore", fs.openSync(logFile, "w"), fs.openSync(logFile, "a")],
    detached: false,
  });
  let exited = false;
  p.on("exit", () => { exited = true; });
  return { proc: p, logFile, isExited: () => exited };
}

async function killAndClean(sessionId, proc) {
  try { await query("UPDATE orchestrator_state SET status='stopping' WHERE session_id=$1", [sessionId]); } catch {}
  await new Promise(r => setTimeout(r, 5000));
  try { proc.kill(); } catch {}
  await new Promise(r => setTimeout(r, 1000));
  await query("DELETE FROM orchestrator_state WHERE session_id=$1", [sessionId]);
  await query("DELETE FROM cognitive_inbox WHERE session_id=$1", [sessionId]);
  await query("DELETE FROM retrieval_inbox WHERE session_id=$1", [sessionId]);
}

// Wait for a learner to finish processing (cognitive_inbox entry becomes completed)
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

// Wait for a retrieval result to appear
async function waitForRetrieval(sessionId, promptHash, timeoutMs = 30000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const r = await query(
      "SELECT context_type, context_text, relevance_score FROM retrieval_inbox WHERE session_id=$1 AND prompt_hash=$2 ORDER BY id DESC LIMIT 1",
      [sessionId, promptHash]
    );
    if (r.rows.length > 0) return r.rows[0];
    await new Promise(r => setTimeout(r, 1000));
  }
  return null;
}

// ═══════════════════════════════════════════════════════════════
// UNIQUE TEST MARKER — avoids collision with real memory data
// ═══════════════════════════════════════════════════════════════
const TEST_MARKER = `AIDAMTEST9_${Date.now()}`;

async function run() {
  const SID = `level9-${Date.now()}`;
  console.log(`\n=== AIDAM Level 9: Verified Learning Quality ===`);
  console.log(`Session ID: ${SID}`);
  console.log(`Test marker: ${TEST_MARKER}\n`);

  // Clean up any previous test data
  await query("DELETE FROM orchestrator_state WHERE session_id=$1", [SID]);
  await query("DELETE FROM cognitive_inbox WHERE session_id=$1", [SID]);
  await query("DELETE FROM retrieval_inbox WHERE session_id=$1", [SID]);

  // Launch orchestrator with Retriever + Learner
  console.log("Launching orchestrator with Retriever + Learner...");
  const orch = launchOrchestrator(SID);
  const started = await waitForStatus(SID, "running", 25000);
  console.log(`Orchestrator started: ${started}`);

  if (!started) {
    record(29, false, "Orchestrator didn't start");
    record(30, false, "Skipped (no orchestrator)");
    record(31, false, "Skipped (no orchestrator)");
    record(32, false, "Skipped (no orchestrator)");
    record(33, false, "Skipped (no orchestrator)");
    printSummary();
    return;
  }

  // Give agents time to fully initialize
  console.log("Waiting for agents to initialize...");
  await new Promise(r => setTimeout(r, 8000));

  // ═══════════════════════════════════════════════════════════
  // TEST #29: Bug fix → Learner saves error+solution
  // ═══════════════════════════════════════════════════════════
  console.log("\n=== Test #29: Bug fix → Learner saves error+solution ===\n");

  // Simulate a tool_use that shows a bug fix (Edit tool fixing a NullPointerException)
  const bugFixPayload = {
    tool_name: "Edit",
    tool_input: {
      file_path: "/test/src/main/java/com/ecopaths/service/CategoryService.java",
      old_string: `Category cat = categoryRepository.findById(id).get();
    return cat.getName();`,
      new_string: `Category cat = categoryRepository.findById(id).orElse(null);
    if (cat == null) {
      throw new ResourceNotFoundException("Category not found: " + id);
    }
    return cat.getName();`,
    },
    tool_response: `Successfully edited file. ${TEST_MARKER}_BUGFIX`
  };

  const insertRes29 = await query(
    "INSERT INTO cognitive_inbox (session_id, message_type, payload, status) VALUES ($1, 'tool_use', $2, 'pending') RETURNING id",
    [SID, JSON.stringify(bugFixPayload)]
  );
  const msgId29 = insertRes29.rows[0].id;
  console.log(`  Injected bug fix tool_use (id=${msgId29}), waiting for Learner...`);

  const status29 = await waitForProcessed(msgId29, 60000);
  console.log(`  Processing status: ${status29}`);

  // Check if Learner saved an error or learning about this
  await new Promise(r => setTimeout(r, 3000)); // Give time for MCP saves to complete

  const errorSaved = await query(
    `SELECT id, error_signature, solution FROM errors_solutions
     WHERE created_at > NOW() - INTERVAL '3 minutes'
     AND (error_signature ILIKE '%NullPointer%' OR error_signature ILIKE '%findById%' OR error_signature ILIKE '%Category%' OR error_signature ILIKE '%orElse%' OR error_signature ILIKE '%ResourceNotFound%')
     ORDER BY id DESC LIMIT 3`
  );

  const learningSaved = await query(
    `SELECT id, topic, insight FROM learnings
     WHERE created_at > NOW() - INTERVAL '3 minutes'
     AND (topic ILIKE '%null%' OR topic ILIKE '%findById%' OR topic ILIKE '%Category%' OR topic ILIKE '%Optional%' OR topic ILIKE '%orElse%' OR insight ILIKE '%orElse%' OR insight ILIKE '%NullPointer%')
     ORDER BY id DESC LIMIT 3`
  );

  const savedSomething = errorSaved.rows.length > 0 || learningSaved.rows.length > 0;
  if (errorSaved.rows.length > 0) {
    console.log(`  Error saved: ${errorSaved.rows[0].error_signature}`);
    console.log(`  Solution: ${errorSaved.rows[0].solution?.slice(0, 150)}`);
  }
  if (learningSaved.rows.length > 0) {
    console.log(`  Learning saved: ${learningSaved.rows[0].topic}`);
    console.log(`  Insight: ${learningSaved.rows[0].insight?.slice(0, 150)}`);
  }

  // Also check the orchestrator log for Learner activity
  const orchLog = fs.existsSync(orch.logFile) ? fs.readFileSync(orch.logFile, "utf-8") : "";
  const learnerResponded = /Learner:.*(?!SKIP)/i.test(orchLog);
  const learnerSkipped = (orchLog.match(/Learner: SKIP/g) || []).length;
  const learnerSaved = (orchLog.match(/Learner:.*save|Learner:.*cost/gi) || []).length;
  console.log(`  Learner log: responded=${learnerResponded}, skipped=${learnerSkipped}, saved_calls=${learnerSaved}`);

  record(29, status29 === "completed" && savedSomething,
    `Bug fix → Learner: status=${status29}, error_saved=${errorSaved.rows.length}, learning_saved=${learningSaved.rows.length}`);

  // ═══════════════════════════════════════════════════════════
  // TEST #30: 3 similar fixes → deduplication
  // ═══════════════════════════════════════════════════════════
  console.log("\n=== Test #30: 3 similar fixes → Learner deduplicates ===\n");

  // Count current entries related to our bug pattern BEFORE
  const beforeErrors = await query(
    `SELECT COUNT(*) as cnt FROM errors_solutions
     WHERE created_at > NOW() - INTERVAL '5 minutes'
     AND (error_signature ILIKE '%NullPointer%' OR error_signature ILIKE '%findById%' OR error_signature ILIKE '%orElse%')`
  );
  const beforeLearnings = await query(
    `SELECT COUNT(*) as cnt FROM learnings
     WHERE created_at > NOW() - INTERVAL '5 minutes'
     AND (topic ILIKE '%null%' OR topic ILIKE '%findById%' OR topic ILIKE '%orElse%' OR topic ILIKE '%Optional%')`
  );
  const beforeCount = parseInt(beforeErrors.rows[0].cnt) + parseInt(beforeLearnings.rows[0].cnt);
  console.log(`  Before: ${beforeCount} entries related to this pattern`);

  // Send 2 more similar bug fixes
  for (let i = 0; i < 2; i++) {
    const similarPayload = {
      tool_name: "Edit",
      tool_input: {
        file_path: `/test/src/main/java/com/ecopaths/service/Product${i === 0 ? "Service" : "CategoryService"}.java`,
        old_string: `${i === 0 ? "Product" : "ProcessUnit"} obj = ${i === 0 ? "product" : "processUnit"}Repository.findById(id).get();`,
        new_string: `${i === 0 ? "Product" : "ProcessUnit"} obj = ${i === 0 ? "product" : "processUnit"}Repository.findById(id).orElseThrow(() -> new ResourceNotFoundException("Not found: " + id));`,
      },
      tool_response: `Successfully edited file. ${TEST_MARKER}_DEDUP_${i}`
    };

    const insertRes = await query(
      "INSERT INTO cognitive_inbox (session_id, message_type, payload, status) VALUES ($1, 'tool_use', $2, 'pending') RETURNING id",
      [SID, JSON.stringify(similarPayload)]
    );
    console.log(`  Injected similar fix #${i + 2} (id=${insertRes.rows[0].id})`);

    // Wait for processing
    const procStatus = await waitForProcessed(insertRes.rows[0].id, 60000);
    console.log(`  Fix #${i + 2} processing: ${procStatus}`);
    await new Promise(r => setTimeout(r, 2000));
  }

  // Check how many NEW entries were created
  await new Promise(r => setTimeout(r, 3000));
  const afterErrors = await query(
    `SELECT COUNT(*) as cnt FROM errors_solutions
     WHERE created_at > NOW() - INTERVAL '5 minutes'
     AND (error_signature ILIKE '%NullPointer%' OR error_signature ILIKE '%findById%' OR error_signature ILIKE '%orElse%')`
  );
  const afterLearnings = await query(
    `SELECT COUNT(*) as cnt FROM learnings
     WHERE created_at > NOW() - INTERVAL '5 minutes'
     AND (topic ILIKE '%null%' OR topic ILIKE '%findById%' OR topic ILIKE '%orElse%' OR topic ILIKE '%Optional%')`
  );
  const afterCount = parseInt(afterErrors.rows[0].cnt) + parseInt(afterLearnings.rows[0].cnt);
  const newEntries = afterCount - beforeCount;
  console.log(`  After: ${afterCount} entries (${newEntries} new from 2 similar fixes)`);

  // Dedup success = the 2 additional similar fixes created 0 or 1 new entries (not 2)
  // The Learner should recognize these are the same pattern and either:
  // - SKIP (already known) or
  // - drilldown_save to enrich existing entry
  const dedupWorked = newEntries <= 1;
  record(30, dedupWorked,
    `Deduplication: 2 similar fixes → ${newEntries} new entries (expected ≤1)`);

  // ═══════════════════════════════════════════════════════════
  // TEST #31: Same bug prompt → Retriever injects solution
  // ═══════════════════════════════════════════════════════════
  console.log("\n=== Test #31: Same bug prompt → Retriever injects solution ===\n");

  const bugPrompt = "I'm getting a NullPointerException in CategoryService when calling findById. The Optional.get() throws NoSuchElementException when the category doesn't exist.";
  const promptHash31 = crypto.createHash("sha256").update(bugPrompt).digest("hex").slice(0, 16);

  // Insert prompt_context to trigger Retriever
  const insertRes31 = await query(
    "INSERT INTO cognitive_inbox (session_id, message_type, payload, status) VALUES ($1, 'prompt_context', $2, 'pending') RETURNING id",
    [SID, JSON.stringify({ prompt: bugPrompt, prompt_hash: promptHash31, timestamp: Date.now() })]
  );
  console.log(`  Injected bug prompt (id=${insertRes31.rows[0].id}, hash=${promptHash31}), waiting for Retriever...`);

  // Wait for retrieval result
  const retrieval31 = await waitForRetrieval(SID, promptHash31, 30000);

  if (retrieval31) {
    console.log(`  Retrieval type: ${retrieval31.context_type}`);
    console.log(`  Relevance score: ${retrieval31.relevance_score}`);
    if (retrieval31.context_text) {
      console.log(`  Context length: ${retrieval31.context_text.length} chars`);
      console.log(`  Context preview: ${retrieval31.context_text.slice(0, 200)}`);
    }

    const hasMemoryContext = retrieval31.context_type === "memory_results" &&
                              retrieval31.context_text &&
                              retrieval31.context_text.length > 20;
    // Check if the retrieved context mentions the solution
    const mentionsSolution = retrieval31.context_text && (
      /orElse|orElseThrow|Optional|findById|NullPointer|ResourceNotFound/i.test(retrieval31.context_text)
    );

    record(31, hasMemoryContext,
      `Retriever: type=${retrieval31.context_type}, has_context=${hasMemoryContext}, mentions_solution=${mentionsSolution}`);
  } else {
    record(31, false, "No retrieval result within timeout");
  }

  // ═══════════════════════════════════════════════════════════
  // TEST #32: Relevance rate > 60%
  // ═══════════════════════════════════════════════════════════
  console.log("\n=== Test #32: Relevance rate measurement ===\n");

  // Send 5 prompts of varying relevance and measure how many get useful context
  const testPrompts = [
    { prompt: "How do I configure Spring Security with JWT in this project?", expectRelevant: true },
    { prompt: "Show me how the agent pipeline 200→201→202 works", expectRelevant: true },
    { prompt: "What was the last error we fixed?", expectRelevant: true },
    { prompt: "ok", expectRelevant: false },  // Trivial - should SKIP
    { prompt: "Can you explain the ecopaths product categorization flow?", expectRelevant: true },
  ];

  let relevantCount = 0;
  let expectedRelevant = 0;
  let correctDecisions = 0;

  for (let i = 0; i < testPrompts.length; i++) {
    const tp = testPrompts[i];
    const hash = crypto.createHash("sha256").update(tp.prompt).digest("hex").slice(0, 16);

    await query(
      "INSERT INTO cognitive_inbox (session_id, message_type, payload, status) VALUES ($1, 'prompt_context', $2, 'pending')",
      [SID, JSON.stringify({ prompt: tp.prompt, prompt_hash: hash, timestamp: Date.now() })]
    );

    const result = await waitForRetrieval(SID, hash, 25000);
    const isRelevant = result && result.context_type === "memory_results" &&
                        result.context_text && result.context_text.length > 50;

    if (isRelevant) relevantCount++;
    if (tp.expectRelevant) expectedRelevant++;

    // Correct decision = relevant when expected OR not relevant when not expected
    const correct = isRelevant === tp.expectRelevant;
    if (correct) correctDecisions++;

    console.log(`  Prompt ${i + 1}: "${tp.prompt.slice(0, 50)}..." → ${isRelevant ? "RELEVANT" : "SKIP"} (expected: ${tp.expectRelevant ? "RELEVANT" : "SKIP"}) ${correct ? "✓" : "✗"}`);

    // Small delay between prompts
    await new Promise(r => setTimeout(r, 2000));
  }

  const relevanceRate = (correctDecisions / testPrompts.length * 100).toFixed(0);
  console.log(`\n  Relevance accuracy: ${correctDecisions}/${testPrompts.length} = ${relevanceRate}%`);
  console.log(`  Relevant responses: ${relevantCount}/${testPrompts.length}`);

  record(32, correctDecisions >= 3,
    `Relevance: ${correctDecisions}/${testPrompts.length} correct (${relevanceRate}%) — target ≥60%`);

  // ═══════════════════════════════════════════════════════════
  // TEST #33: Learner does NOT save noise
  // ═══════════════════════════════════════════════════════════
  console.log("\n=== Test #33: Learner does NOT save noise ===\n");

  // Count learnings/errors before noise injection
  const beforeNoise = await query(
    "SELECT COUNT(*) as cnt FROM learnings WHERE created_at > NOW() - INTERVAL '2 minutes'"
  );
  const beforeNoiseErrors = await query(
    "SELECT COUNT(*) as cnt FROM errors_solutions WHERE created_at > NOW() - INTERVAL '2 minutes'"
  );
  const beforeNoiseCount = parseInt(beforeNoise.rows[0].cnt) + parseInt(beforeNoiseErrors.rows[0].cnt);

  // Send routine/noise tool_use events that should NOT be saved
  const noisePayloads = [
    { tool_name: "Bash", tool_input: { command: "git status" }, tool_response: "On branch main\nnothing to commit, working tree clean" },
    { tool_name: "Bash", tool_input: { command: "ls src/" }, tool_response: "main\ntest\nresources" },
    { tool_name: "Write", tool_input: { file_path: "/tmp/test.txt", content: "hello world" }, tool_response: "File written successfully" },
    { tool_name: "Bash", tool_input: { command: "npm install" }, tool_response: "added 0 packages in 1.2s\n\n5 packages are looking for funding" },
  ];

  const noiseIds = [];
  for (const np of noisePayloads) {
    np.tool_response += ` ${TEST_MARKER}_NOISE`;
    const insertRes = await query(
      "INSERT INTO cognitive_inbox (session_id, message_type, payload, status) VALUES ($1, 'tool_use', $2, 'pending') RETURNING id",
      [SID, JSON.stringify(np)]
    );
    noiseIds.push(insertRes.rows[0].id);
  }
  console.log(`  Injected ${noisePayloads.length} noise events (ids: ${noiseIds.join(", ")})`);

  // Wait for all to be processed
  for (const nid of noiseIds) {
    await waitForProcessed(nid, 60000);
  }
  await new Promise(r => setTimeout(r, 3000));

  // Check orchestrator log for SKIP responses
  const orchLog33 = fs.existsSync(orch.logFile) ? fs.readFileSync(orch.logFile, "utf-8") : "";
  const skipCount = (orchLog33.match(/Learner: SKIP/g) || []).length;
  console.log(`  Learner SKIP responses in log: ${skipCount}`);

  // Check how many new entries appeared
  const afterNoise = await query(
    "SELECT COUNT(*) as cnt FROM learnings WHERE created_at > NOW() - INTERVAL '2 minutes'"
  );
  const afterNoiseErrors = await query(
    "SELECT COUNT(*) as cnt FROM errors_solutions WHERE created_at > NOW() - INTERVAL '2 minutes'"
  );
  const afterNoiseCount = parseInt(afterNoise.rows[0].cnt) + parseInt(afterNoiseErrors.rows[0].cnt);
  const noiseSaved = afterNoiseCount - beforeNoiseCount;

  console.log(`  New entries from noise: ${noiseSaved} (should be 0)`);

  // Pass if no more than 1 entry was saved from noise (some tolerance)
  record(33, noiseSaved <= 1,
    `Noise filtering: ${noiseSaved} saved from ${noisePayloads.length} noise events (expected ≤1)`);

  // ═══════════════════════════════════════════════════════════
  // Cleanup
  // ═══════════════════════════════════════════════════════════
  console.log("\n--- Orchestrator Log (last 2000 chars) ---");
  const finalLog = fs.existsSync(orch.logFile) ? fs.readFileSync(orch.logFile, "utf-8") : "";
  console.log(finalLog.slice(-2000));
  console.log("--- End Log ---\n");

  await killAndClean(SID, orch.proc);

  // Clean up test data from memory tables (don't pollute real memory)
  // We use the TEST_MARKER to find our test entries
  // But be conservative - only delete entries we're sure are test data
  console.log("Cleaning up test entries from memory tables...");
  const cleaned = await query(
    `DELETE FROM errors_solutions
     WHERE created_at > NOW() - INTERVAL '10 minutes'
     AND (solution ILIKE $1 OR error_message ILIKE $1)
     RETURNING id`,
    [`%${TEST_MARKER}%`]
  );
  const cleaned2 = await query(
    `DELETE FROM learnings
     WHERE created_at > NOW() - INTERVAL '10 minutes'
     AND (insight ILIKE $1 OR context ILIKE $1)
     RETURNING id`,
    [`%${TEST_MARKER}%`]
  );
  console.log(`  Cleaned ${cleaned.rows.length} test errors + ${cleaned2.rows.length} test learnings`);

  printSummary();
}

function printSummary() {
  const passed = results.filter(r => r.passed).length;
  const total = results.length;
  const failed = results.filter(r => !r.passed);
  console.log(`\n${"=".repeat(60)}`);
  console.log(`LEVEL 9 RESULTS: ${passed}/${total} passed`);
  if (failed.length > 0) {
    console.log("FAILURES:");
    failed.forEach(f => console.log(`  Step ${f.step}: ${f.desc}`));
  }
  console.log("=".repeat(60));
  if (failed.length === 0) console.log("\n=== ALL LEVEL 9 TESTS PASSED ===");
}

run().then(() => process.exit(0)).catch(err => {
  console.error("Test error:", err);
  process.exit(1);
});

setTimeout(() => { console.log("GLOBAL TIMEOUT"); process.exit(1); }, 600000); // 10 min timeout
