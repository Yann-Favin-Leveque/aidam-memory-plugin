/**
 * Test Level 4: Compactor isolated test
 * Launches orchestrator with only compactor enabled, pointing at a real transcript.
 * Verifies the Compactor produces a structured session state document.
 */
const { Client } = require("pg");
const { execSync, spawn } = require("child_process");
const fs = require("fs");
const path = require("path");

const DB = {
  host: "localhost",
  database: "claude_memory",
  user: "postgres",
  password: "***REDACTED***",
  port: 5432,
};

const SESSION_ID = `compactor-test-${Date.now()}`;
const ORCHESTRATOR = path.join(__dirname, "orchestrator.js");

// Find a real transcript with enough content
const projectDir = "C:/Users/user/.claude/projects/C--Users-user-IdeaProjects-ecopathsWebApp1b";
const transcripts = fs.readdirSync(projectDir)
  .filter(f => f.endsWith(".jsonl") && !f.includes("subagents"))
  .map(f => ({
    name: f,
    path: path.join(projectDir, f),
    size: fs.statSync(path.join(projectDir, f)).size,
  }))
  .sort((a, b) => b.size - a.size);

if (transcripts.length === 0) {
  console.log("FAIL: No transcripts found");
  process.exit(1);
}

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

async function run() {
  // Clean up any previous test state
  await query("DELETE FROM orchestrator_state WHERE session_id = $1", [SESSION_ID]);
  await query("DELETE FROM session_state WHERE session_id = $1", [SESSION_ID]);

  // Launch orchestrator with ONLY compactor, low threshold for quick trigger
  console.log(`\nLaunching orchestrator: session=${SESSION_ID}`);
  console.log(`  retriever=off, learner=off, compactor=on`);
  console.log(`  compactorTokenThreshold will use default (20k), transcript is ${(transcript.size / 6 / 1000).toFixed(0)}k tokens`);

  const logFile = `C:/Users/user/.claude/logs/aidam_orchestrator_test_compactor.log`;
  const proc = spawn("node", [
    ORCHESTRATOR,
    `--session-id=${SESSION_ID}`,
    `--cwd=C:/Users/user/IdeaProjects/ecopathsWebApp1b`,
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
  proc.on("exit", (code) => {
    exited = true;
    console.log(`Orchestrator exited: ${code}`);
  });

  // Step 1: Wait for orchestrator to start
  console.log("\nStep 1: Waiting for orchestrator to start...");
  let started = false;
  for (let i = 0; i < 20; i++) {
    await new Promise(r => setTimeout(r, 1000));
    const res = await query(
      "SELECT status FROM orchestrator_state WHERE session_id = $1",
      [SESSION_ID]
    );
    if (res.rows.length > 0 && res.rows[0].status === "running") {
      started = true;
      break;
    }
    if (exited) break;
  }
  record(1, started, "Orchestrator started and running");
  if (!started) {
    console.log("Log contents:");
    try { console.log(fs.readFileSync(logFile, "utf-8")); } catch {}
    proc.kill();
    return;
  }

  // Step 2: Wait for Compactor to trigger (it checks every 30s, transcript should be > 20k tokens)
  console.log("\nStep 2: Waiting for Compactor to trigger (up to 90s)...");
  let compacted = false;
  for (let i = 0; i < 45; i++) {
    await new Promise(r => setTimeout(r, 2000));
    const res = await query(
      "SELECT id, LENGTH(state_text) as len, version FROM session_state WHERE session_id = $1",
      [SESSION_ID]
    );
    if (res.rows.length > 0) {
      console.log(`  Compactor wrote state: v${res.rows[0].version}, ${res.rows[0].len} chars`);
      compacted = true;
      break;
    }
    if (exited) {
      console.log("  Orchestrator exited before compaction");
      break;
    }
  }
  record(2, compacted, "Compactor produced session state");

  // Step 3: Verify state structure
  if (compacted) {
    const res = await query(
      "SELECT state_text, raw_tail_path, token_estimate, version FROM session_state WHERE session_id = $1 ORDER BY version DESC LIMIT 1",
      [SESSION_ID]
    );
    const state = res.rows[0];
    console.log(`\nStep 3: Verifying state structure...`);
    console.log(`  Version: ${state.version}`);
    console.log(`  Token estimate: ${state.token_estimate}`);
    console.log(`  Raw tail path: ${state.raw_tail_path}`);
    console.log(`  State preview (first 500 chars):`);
    console.log(`  ${state.state_text.slice(0, 500)}`);

    // Check for expected sections
    const hasIdentity = /identity|role|purpose/i.test(state.state_text);
    const hasTask = /task|objective|goal/i.test(state.state_text);
    const hasDecision = /decision|choice/i.test(state.state_text);
    const hasContext = /context|working|current/i.test(state.state_text);
    const isStructured = hasIdentity || hasTask || hasDecision || hasContext;

    record(3, isStructured, `State has structured content (identity=${hasIdentity}, task=${hasTask}, decision=${hasDecision}, context=${hasContext})`);

    // Step 4: Check raw tail file exists
    if (state.raw_tail_path) {
      const tailExists = fs.existsSync(state.raw_tail_path);
      record(4, tailExists, `Raw tail file exists: ${state.raw_tail_path}`);
      if (tailExists) {
        const tailSize = fs.statSync(state.raw_tail_path).size;
        console.log(`  Raw tail size: ${(tailSize / 1024).toFixed(0)} KB`);
      }
    } else {
      record(4, false, "No raw tail path in state");
    }
  } else {
    record(3, false, "Skipped (no compaction)");
    record(4, false, "Skipped (no compaction)");
  }

  // Shutdown
  console.log("\nShutting down orchestrator...");
  await query(
    "UPDATE orchestrator_state SET status = 'stopping' WHERE session_id = $1",
    [SESSION_ID]
  );

  for (let i = 0; i < 15; i++) {
    await new Promise(r => setTimeout(r, 1000));
    if (exited) break;
  }
  if (!exited) {
    proc.kill();
    await new Promise(r => setTimeout(r, 2000));
  }

  const cleanExit = exited;
  record(5, cleanExit, "Orchestrator shut down cleanly");

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
  if (failed.length === 0) console.log("\n=== ALL COMPACTOR TESTS PASSED ===");

  // Keep results for inspection (no cleanup)
  console.log(`\nSession ID for inspection: ${SESSION_ID}`);
}

run().then(() => process.exit(0)).catch(err => {
  console.error("Test error:", err);
  process.exit(1);
});

setTimeout(() => {
  console.log("GLOBAL TIMEOUT");
  process.exit(1);
}, 180000);
