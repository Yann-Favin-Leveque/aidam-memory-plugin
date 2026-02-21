/**
 * Test Level 5: Post-/clear survival
 *
 * #15: inject_state.py reads session_state and outputs additionalContext
 * #16: emergency_compact.py extracts state from transcript without AI
 * #17: on_session_start.sh passes --last-compact-size to prevent immediate re-trigger
 */
const { Client } = require("pg");
const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const DB = {
  host: "localhost",
  database: "claude_memory",
  user: "postgres",
  password: process.env.PGPASSWORD || "",
  port: 5432,
};

const PYTHON = "C:/Users/user/AppData/Local/Programs/Python/Python312/python.exe";
const SCRIPTS = "C:/Users/user/IdeaProjects/aidam-memory-plugin/scripts";

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
  const SESSION_ID = `level5-test-${Date.now()}`;

  // ═══════════════════════════════════════════════════
  // Test #16: emergency_compact.py (test this first since inject_state needs a state)
  // ═══════════════════════════════════════════════════
  console.log("\n=== Test #16: emergency_compact.py ===");

  // Find a real transcript
  const projectDir = "C:/Users/user/.claude/projects/C--Users-user-IdeaProjects-ecopathsWebApp1b";
  const transcripts = fs.readdirSync(projectDir)
    .filter(f => f.endsWith(".jsonl") && !f.includes("subagents") && !f.includes("compactor"))
    .map(f => ({ path: path.join(projectDir, f), size: fs.statSync(path.join(projectDir, f)).size }))
    .filter(f => f.size > 10000)  // Need some content
    .sort((a, b) => b.size - a.size);

  if (transcripts.length === 0) {
    record(16, false, "No suitable transcript found");
  } else {
    const transcript = transcripts[Math.min(5, transcripts.length - 1)]; // Use a medium-sized one
    console.log(`  Using transcript: ${path.basename(transcript.path)} (${(transcript.size / 1024).toFixed(0)} KB)`);

    try {
      execSync(`"${PYTHON}" "${SCRIPTS}/emergency_compact.py" "${SESSION_ID}" "${transcript.path}"`, {
        timeout: 30000,
        env: { ...process.env, PGPASSWORD: process.env.PGPASSWORD || "" },
      });

      // Check DB
      const res = await query(
        "SELECT state_text, raw_tail_path, version FROM session_state WHERE session_id = $1",
        [SESSION_ID]
      );

      if (res.rows.length > 0) {
        const state = res.rows[0];
        console.log(`  State v${state.version}: ${state.state_text.length} chars`);
        console.log(`  Raw tail: ${state.raw_tail_path}`);
        console.log(`  Preview: ${state.state_text.slice(0, 200)}`);

        const hasStructure = /SESSION STATE/i.test(state.state_text) &&
                             /IDENTITY/i.test(state.state_text) &&
                             /TASK TREE/i.test(state.state_text);
        record(16, hasStructure, `emergency_compact produced structured state (${state.state_text.length} chars)`);

        // Check raw tail file
        if (state.raw_tail_path && fs.existsSync(state.raw_tail_path)) {
          const tailSize = fs.statSync(state.raw_tail_path).size;
          console.log(`  Raw tail file: ${(tailSize / 1024).toFixed(0)} KB`);
        }
      } else {
        record(16, false, "emergency_compact didn't write to DB");
      }
    } catch (err) {
      record(16, false, `emergency_compact error: ${err.message.slice(0, 200)}`);
    }
  }

  // ═══════════════════════════════════════════════════
  // Test #15: inject_state.py
  // ═══════════════════════════════════════════════════
  console.log("\n=== Test #15: inject_state.py ===");

  // Set up marker file (simulating what SessionEnd does on /clear)
  const markerDir = path.join(process.env.HOME || process.env.USERPROFILE, ".claude/aidam");
  fs.mkdirSync(markerDir, { recursive: true });
  const markerFile = path.join(markerDir, "last_cleared_session");
  fs.writeFileSync(markerFile, SESSION_ID, "utf-8");
  console.log(`  Marker written: ${markerFile} -> ${SESSION_ID}`);

  try {
    const output = execSync(`"${PYTHON}" "${SCRIPTS}/inject_state.py" "clear"`, {
      timeout: 10000,
      env: {
        ...process.env,
        PGPASSWORD: process.env.PGPASSWORD || "",
        CWD: "C:/Users/user/IdeaProjects/ecopathsWebApp1b",
      },
      encoding: "utf-8",
    });

    console.log(`  Output length: ${output.length}`);
    if (output.trim()) {
      try {
        const parsed = JSON.parse(output.trim());
        const hasContext = parsed?.hookSpecificOutput?.additionalContext;
        if (hasContext) {
          console.log(`  additionalContext length: ${hasContext.length}`);
          console.log(`  Preview: ${hasContext.slice(0, 200)}`);
          const hasRecovery = /restored|recovered|previous session/i.test(hasContext);
          const hasState = /SESSION STATE/i.test(hasContext);
          record(15, hasRecovery && hasState, `inject_state outputs valid additionalContext (${hasContext.length} chars)`);
        } else {
          record(15, false, "inject_state output missing additionalContext");
        }
      } catch (parseErr) {
        record(15, false, `inject_state output not valid JSON: ${output.slice(0, 100)}`);
      }
    } else {
      record(15, false, "inject_state produced no output");
    }
  } catch (err) {
    // inject_state exits with 0 even if no state found
    record(15, false, `inject_state error: ${err.message.slice(0, 200)}`);
  }

  // Verify marker was cleaned up
  const markerGone = !fs.existsSync(markerFile);
  console.log(`  Marker cleaned up: ${markerGone}`);

  // ═══════════════════════════════════════════════════
  // Test #17: --last-compact-size prevents immediate re-trigger
  // ═══════════════════════════════════════════════════
  console.log("\n=== Test #17: --last-compact-size ===");

  // This is a logic check: when on_session_start.sh detects source=clear and
  // inject_state.py outputs context, it calculates LAST_COMPACT_SIZE from the
  // output length and passes it to the orchestrator. The orchestrator's
  // checkAndRunCompactor() only fires when tokensSinceLastCompact >= threshold.
  //
  // We verify this by checking the code logic directly.

  const startScript = fs.readFileSync(path.join(SCRIPTS, "..", "scripts", "on_session_start.sh"), "utf-8");
  const hasLastCompactCalc = /LAST_COMPACT_SIZE.*INJECT_CHARS/.test(startScript) ||
                              /last-compact-size.*LAST_COMPACT_SIZE/.test(startScript);
  const passesFlag = /--last-compact-size/.test(startScript);

  const orchestratorCode = fs.readFileSync(path.join(SCRIPTS, "orchestrator.ts"), "utf-8");
  const usesLastCompact = /lastCompactSize/.test(orchestratorCode) && /lastCompactedSize/.test(orchestratorCode);
  const hasThresholdCheck = /tokensSinceLastCompact.*compactorTokenThreshold/.test(orchestratorCode);

  const logicCorrect = hasLastCompactCalc && passesFlag && usesLastCompact && hasThresholdCheck;
  record(17, logicCorrect, `--last-compact-size logic: calc=${hasLastCompactCalc}, flag=${passesFlag}, use=${usesLastCompact}, check=${hasThresholdCheck}`);

  // ═══════════════════════════════════════════════════
  // Cleanup
  // ═══════════════════════════════════════════════════
  await query("DELETE FROM session_state WHERE session_id = $1", [SESSION_ID]);
  try { fs.unlinkSync(markerFile); } catch {}

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
  if (failed.length === 0) console.log("\n=== LEVEL 5 TESTS PASSED ===");
}

run().then(() => process.exit(0)).catch(err => {
  console.error("Test error:", err);
  process.exit(1);
});
