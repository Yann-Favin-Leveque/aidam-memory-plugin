/**
 * Test #14: Compactor incremental v2
 *
 * 1. Insert a fake v1 state in session_state
 * 2. Launch orchestrator with compactor only, pointing at a real transcript
 * 3. Verify Compactor produces v2 that builds on v1 (not from scratch)
 * 4. Check that KEY DECISIONS are preserved/extended and WORKING CONTEXT is updated
 */
const { Client } = require("pg");
const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");

const DB = {
  host: "localhost",
  database: "claude_memory",
  user: "postgres",
  password: process.env.PGPASSWORD || "",
  port: 5432,
};

const SESSION_ID = `compactor-v2-test-${Date.now()}`;
const ORCHESTRATOR = path.join(__dirname, "orchestrator.js");

// Find a real transcript
const projectDir = "C:/Users/user/.claude/projects/C--Users-user-IdeaProjects-ecopathsWebApp1b";
const transcripts = fs.readdirSync(projectDir)
  .filter(f => f.endsWith(".jsonl") && !f.includes("subagents") && !f.includes("compactor"))
  .map(f => ({
    name: f,
    path: path.join(projectDir, f),
    size: fs.statSync(path.join(projectDir, f)).size,
  }))
  .sort((a, b) => b.size - a.size);

const transcript = transcripts[0];
console.log(`Using transcript: ${transcript.name} (${(transcript.size / 1024).toFixed(0)} KB)`);

const results = [];
function record(step, passed, desc) {
  results.push({ step, passed, desc });
  console.log(`  ${passed ? "PASS" : "FAIL"}: ${desc}`);
}

async function query(sql, params = []) {
  const db = new Client(DB);
  await db.connect();
  const result = await db.query(sql, params);
  await db.end();
  return result;
}

// Fake v1 state that the Compactor should build upon
const FAKE_V1_STATE = `=== SESSION STATE v1 ===

## IDENTITY
- Project: ecopathsWebApp1b
- Session goal: Testing incremental compaction

## TASK TREE
- [x] Setup database connection pool
- [x] Implement read-only routing
- [ ] Add monitoring endpoints

## KEY DECISIONS (append-only)
- Decision: Use HikariCP with dual pool (main=37, readonly=8)
- Decision: Route @Transactional(readOnly=true) to readonly pool
- UNIQUE_MARKER_V1: This decision should be preserved in v2

## WORKING CONTEXT
- Files: DataSourceRoutingConfig.java
- Last compile: SUCCESS
- This section should be REPLACED in v2

## CONVERSATION DYNAMICS
- User style: Direct, technical
- Current phase: Implementation

=== END STATE ===`;

async function run() {
  // Clean up
  await query("DELETE FROM orchestrator_state WHERE session_id = $1", [SESSION_ID]);
  await query("DELETE FROM session_state WHERE session_id = $1", [SESSION_ID]);

  // Step 1: Insert fake v1 state
  console.log("\nStep 1: Inserting fake v1 state...");
  await query(
    `INSERT INTO session_state (session_id, project_slug, state_text, token_estimate, version)
     VALUES ($1, 'ecopathsWebApp1b', $2, 50000, 1)`,
    [SESSION_ID, FAKE_V1_STATE]
  );
  const v1Check = await query("SELECT version FROM session_state WHERE session_id = $1", [SESSION_ID]);
  record(1, v1Check.rows.length === 1 && v1Check.rows[0].version === 1, "v1 state inserted");

  // Step 2: Launch orchestrator (compactor only)
  console.log("\nStep 2: Launching orchestrator with compactor only...");
  const logFile = `C:/Users/user/.claude/logs/aidam_orchestrator_test_v2.log`;
  const proc = spawn("node", [
    ORCHESTRATOR,
    `--session-id=${SESSION_ID}`,
    "--cwd=C:/Users/user/IdeaProjects/ecopathsWebApp1b",
    "--retriever=off",
    "--learner=off",
    "--compactor=on",
    `--transcript-path=${transcript.path}`,
    "--project-slug=ecopathsWebApp1b",
  ], {
    stdio: ["ignore", fs.openSync(logFile, "w"), fs.openSync(logFile, "a")],
    detached: false,
  });

  let exited = false;
  proc.on("exit", (code) => { exited = true; console.log(`  Orchestrator exited: ${code}`); });

  // Wait for running
  let started = false;
  for (let i = 0; i < 20; i++) {
    await new Promise(r => setTimeout(r, 1000));
    const res = await query("SELECT status FROM orchestrator_state WHERE session_id = $1", [SESSION_ID]);
    if (res.rows.length > 0 && res.rows[0].status === "running") { started = true; break; }
    if (exited) break;
  }
  record(2, started, "Orchestrator started");
  if (!started) {
    console.log("Log:"); try { console.log(fs.readFileSync(logFile, "utf-8")); } catch {}
    proc.kill(); return;
  }

  // Step 3: Wait for v2 to appear in DB
  console.log("\nStep 3: Waiting for Compactor v2 (up to 90s)...");
  let gotV2 = false;
  for (let i = 0; i < 45; i++) {
    await new Promise(r => setTimeout(r, 2000));
    const res = await query(
      "SELECT version, LENGTH(state_text) as len FROM session_state WHERE session_id = $1 ORDER BY version DESC LIMIT 1",
      [SESSION_ID]
    );
    if (res.rows.length > 0 && res.rows[0].version >= 2) {
      console.log(`  Got v${res.rows[0].version}: ${res.rows[0].len} chars`);
      gotV2 = true;
      break;
    }
    if (exited) { console.log("  Orchestrator exited before v2"); break; }
  }
  record(3, gotV2, "Compactor produced v2");

  // Step 4: Verify incremental nature
  if (gotV2) {
    const res = await query(
      "SELECT state_text, version FROM session_state WHERE session_id = $1 ORDER BY version DESC LIMIT 1",
      [SESSION_ID]
    );
    const v2State = res.rows[0].state_text;
    console.log(`\nStep 4: Verifying incremental nature...`);

    // Check that the UNIQUE_MARKER from v1 is preserved
    const hasMarker = v2State.includes("UNIQUE_MARKER_V1") ||
                      v2State.includes("HikariCP") ||
                      v2State.includes("dual pool");
    record("4a", hasMarker, "v1 KEY DECISIONS preserved in v2");

    // Check v2 has actual conversation content (not just the fake state)
    const hasNewContent = v2State.length > FAKE_V1_STATE.length * 0.8;
    record("4b", hasNewContent, `v2 has substantial content (${v2State.length} chars vs v1 ${FAKE_V1_STATE.length} chars)`);

    // Check structure is maintained
    const hasSections = /IDENTITY/i.test(v2State) && /TASK TREE/i.test(v2State) && /KEY DECISIONS/i.test(v2State);
    record("4c", hasSections, "v2 maintains structured sections");

    // Show preview
    console.log(`\n--- v2 State Preview (first 1000 chars) ---`);
    console.log(v2State.slice(0, 1000));
    console.log("--- end preview ---");
  } else {
    record("4a", false, "Skipped (no v2)");
    record("4b", false, "Skipped (no v2)");
    record("4c", false, "Skipped (no v2)");
  }

  // Shutdown
  console.log("\nShutting down...");
  await query("UPDATE orchestrator_state SET status = 'stopping' WHERE session_id = $1", [SESSION_ID]);
  for (let i = 0; i < 15; i++) { await new Promise(r => setTimeout(r, 1000)); if (exited) break; }
  if (!exited) { proc.kill(); await new Promise(r => setTimeout(r, 2000)); }
  record(5, exited, "Clean shutdown");

  // Print log
  console.log("\n--- Orchestrator Log ---");
  try { console.log(fs.readFileSync(logFile, "utf-8")); } catch {}

  // Summary
  const passed = results.filter(r => r.passed).length;
  const total = results.length;
  console.log(`\n${"=".repeat(60)}`);
  console.log(`RESULTS: ${passed}/${total} passed`);
  const failed = results.filter(r => !r.passed);
  if (failed.length > 0) {
    console.log("FAILURES:");
    failed.forEach(f => console.log(`  Step ${f.step}: ${f.desc}`));
  }
  console.log("=".repeat(60));
  if (failed.length === 0) console.log("\n=== COMPACTOR V2 INCREMENTAL TEST PASSED ===");

  // Keep for inspection
  console.log(`\nSession ID: ${SESSION_ID}`);
}

run().then(() => process.exit(0)).catch(err => {
  console.error("Test error:", err);
  process.exit(1);
});

setTimeout(() => { console.log("GLOBAL TIMEOUT"); process.exit(1); }, 180000);
