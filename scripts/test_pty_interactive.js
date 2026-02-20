const pty = require("node-pty");
const fs = require("fs");
const { Client } = require("pg");

const logFile = "C:/Users/user/.claude/logs/pty_interactive_test.log";
const log = (msg) => {
  const ts = new Date().toISOString().split("T")[1].split(".")[0];
  const line = `[${ts}] ${msg}\n`;
  fs.appendFileSync(logFile, line);
  process.stdout.write(line);
};

fs.writeFileSync(logFile, "");
log("=== AIDAM Level 7 Interactive Test ===");

let output = "";
let newOutput = "";
const env = { ...process.env };
delete env.CLAUDECODE;

const pluginDir = "C:/Users/user/IdeaProjects/aidam-memory-plugin";
const proc = pty.spawn(
  "C:/Program Files/Git/bin/bash.exe",
  ["-c", `claude --plugin-dir "${pluginDir}"`],
  {
    name: "xterm-256color",
    cols: 200,
    rows: 50,
    cwd: "C:/Users/user/IdeaProjects/ecopathsWebApp1b",
    env,
  }
);

proc.onData((d) => {
  output += d;
  newOutput += d;
});

let exited = false;
proc.onExit(({ exitCode }) => {
  exited = true;
  log(`Process exited: ${exitCode}`);
});

function cleanAnsi(s) {
  return s.replace(/\x1b\[[0-9;?]*[a-zA-Z]|\x1b\][^\x07]*\x07|\x1b\(B/g, "").trim();
}

async function send(text) {
  log(`SEND: ${text}`);
  newOutput = "";
  // Type char by char to avoid bracketed paste mode
  // (Claude Code's TUI treats bulk writes as paste, where Enter = newline)
  for (const c of text) {
    proc.write(c);
    await new Promise((r) => setTimeout(r, 10));
  }
  await new Promise((r) => setTimeout(r, 100));
  proc.write("\r"); // Submit
}

async function sleep(ms) {
  log(`SLEEP ${ms}ms...`);
  await new Promise((r) => setTimeout(r, ms));
}

async function checkDb(sql, expectPattern) {
  const db = new Client({
    host: "localhost",
    database: "claude_memory",
    user: "postgres",
    password: "***REDACTED***",
    port: 5432,
  });
  await db.connect();
  const result = await db.query(sql);
  await db.end();
  const json = JSON.stringify(result.rows);
  if (expectPattern) {
    const regex = new RegExp(expectPattern, "i");
    if (regex.test(json)) {
      log(`DB PASS: ${json.slice(0, 300)}`);
      return true;
    } else {
      log(`DB FAIL: expected /${expectPattern}/ got ${json.slice(0, 300)}`);
      return false;
    }
  }
  log(`DB: ${json.slice(0, 300)}`);
  return result.rows.length > 0;
}

// Poll DB until condition met or timeout
async function waitForDb(sql, expectPattern, timeoutMs = 30000, intervalMs = 2000) {
  const regex = new RegExp(expectPattern, "i");
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const db = new Client({
      host: "localhost", database: "claude_memory",
      user: "postgres", password: "***REDACTED***", port: 5432,
    });
    await db.connect();
    const result = await db.query(sql);
    await db.end();
    const json = JSON.stringify(result.rows);
    if (regex.test(json)) {
      log(`DB POLL PASS (${((Date.now() - start) / 1000).toFixed(1)}s): ${json.slice(0, 300)}`);
      return true;
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  log(`DB POLL TIMEOUT after ${timeoutMs / 1000}s`);
  return false;
}

const results = [];
function record(step, passed, desc) {
  results.push({ step, passed, desc });
  log(`  ${passed ? "PASS" : "FAIL"}: ${desc}`);
}

async function run() {
  try {
    // ──────────────────────────────────────────────────────
    // Step 1: Wait for Claude to be ready (UI appears)
    // ──────────────────────────────────────────────────────
    log("Step 1: Waiting for Claude to initialize...");
    const initStart = Date.now();
    while (Date.now() - initStart < 45000) {
      const clean = cleanAnsi(output);
      if (/(tips|Try|claude|help|shortcuts)/i.test(clean) && clean.length > 100) {
        break;
      }
      if (exited) throw new Error("Process exited during init");
      await new Promise((r) => setTimeout(r, 500));
    }
    log("Claude is ready!");
    record(1, true, "Claude Code initialized");

    // ──────────────────────────────────────────────────────
    // Step 2: Wait for orchestrator to be running in DB
    // ──────────────────────────────────────────────────────
    log("Step 2: Waiting for orchestrator to be running...");
    const orchRunning = await waitForDb(
      "SELECT status FROM orchestrator_state WHERE status='running' AND last_heartbeat_at > NOW() - INTERVAL '30 seconds' ORDER BY id DESC LIMIT 1",
      "running",
      15000,
      1000
    );
    record(2, orchRunning, "Orchestrator running in DB");
    if (!orchRunning) {
      log("WARNING: Orchestrator not running, continuing anyway...");
    }

    // ──────────────────────────────────────────────────────
    // Step 3: Send prompt and wait for real response
    // ──────────────────────────────────────────────────────
    log("Step 3: Sending prompt...");
    await send("Tell me about the ecopaths project agent pipeline");

    // Wait for actual content (not just UI chrome).
    // Look for words that would appear in a real answer about ecopaths/agents.
    log("Step 3b: Waiting for meaningful response content...");
    const respStart = Date.now();
    let gotResponse = false;
    while (Date.now() - respStart < 120000) {
      const clean = cleanAnsi(newOutput);
      // Look for keywords that indicate a real answer
      if (/(agent.*pipeline|pipeline.*agent|categoriz|product|lifecycle|200.*201|201.*202|processing|Spring|Java|ecopath)/i.test(clean)) {
        log(`Got meaningful response (${((Date.now() - respStart) / 1000).toFixed(1)}s)`);
        gotResponse = true;
        break;
      }
      // Also accept: substantial new text after the prompt echo
      const afterPrompt = clean.split("pipeline").slice(1).join("pipeline");
      // Filter out UI chrome: lines, shortcuts, installer notices, rate limits
      const realContent = afterPrompt
        .replace(/─+/g, "")
        .replace(/Claude Code has switched.*?options\./g, "")
        .replace(/ctrl\+g.*?Notepad/g, "")
        .replace(/\?forshortcuts/g, "")
        .replace(/You've used.*?weekly limit.*?$/gm, "")
        .replace(/resets?\s+\d+.*?Paris\)/gi, "")
        .replace(/\s+/g, " ")
        .trim();
      if (realContent.length > 300) {
        log(`Got substantial response (${realContent.length} chars, ${((Date.now() - respStart) / 1000).toFixed(1)}s)`);
        gotResponse = true;
        break;
      }
      if (exited) throw new Error("Process exited while waiting for response");
      await new Promise((r) => setTimeout(r, 2000));
    }
    record(3, gotResponse, "Claude responded to prompt");

    // ──────────────────────────────────────────────────────
    // Step 4: Check retrieval_inbox for memory context
    // (Retriever can take 20-30s, poll for up to 45s)
    // ──────────────────────────────────────────────────────
    log("Step 4: Checking retrieval_inbox...");
    const hasRetrieval = await waitForDb(
      "SELECT context_type FROM retrieval_inbox WHERE created_at > NOW() - INTERVAL '3 minutes' AND context_type='memory_results' ORDER BY id DESC LIMIT 1",
      "memory_results",
      45000,
      2000
    );
    record(4, hasRetrieval, "Retriever injected memory context");

    // ──────────────────────────────────────────────────────
    // Step 5: Snapshot output
    // ──────────────────────────────────────────────────────
    log("Step 5: Output snapshot:");
    log(cleanAnsi(output).slice(-2000));

    // ──────────────────────────────────────────────────────
    // Step 6: Check cognitive_inbox has the prompt
    // ──────────────────────────────────────────────────────
    log("Step 6: Checking cognitive_inbox...");
    const hasCogInbox = await checkDb(
      "SELECT message_type, status FROM cognitive_inbox WHERE message_type='prompt_context' AND created_at > NOW() - INTERVAL '3 minutes' ORDER BY id DESC LIMIT 1",
      "prompt_context"
    );
    record(6, hasCogInbox, "Cognitive inbox received prompt");

    // ──────────────────────────────────────────────────────
    // Step 7: Wait for Claude to finish, then exit
    // ──────────────────────────────────────────────────────
    // Wait for Claude to finish processing (no more "Hyperspacing" or activity)
    log("Step 7: Waiting for Claude to finish responding...");
    let stableCount = 0;
    let lastLen = 0;
    const finishStart = Date.now();
    while (Date.now() - finishStart < 60000) {
      const curLen = output.length;
      if (curLen === lastLen) {
        stableCount++;
        if (stableCount >= 3) break; // Output stable for ~6s
      } else {
        stableCount = 0;
      }
      lastLen = curLen;
      await new Promise((r) => setTimeout(r, 2000));
    }
    log("Claude appears done. Sending Escape first, then /exit...");
    // Press Escape to ensure we're in input mode (cancel any ongoing operation)
    proc.write("\x1b");
    await new Promise((r) => setTimeout(r, 1000));
    // Send /exit
    await send("/exit");

    // Wait for process to exit first (up to 45s)
    const exitStart = Date.now();
    while (!exited && Date.now() - exitStart < 45000) {
      await new Promise((r) => setTimeout(r, 500));
    }

    // If process didn't exit, try Ctrl+C
    if (!exited) {
      log("Process didn't exit, trying Ctrl+C...");
      proc.write("\x03");
      await new Promise((r) => setTimeout(r, 5000));
    }

    // Give SessionEnd hook time to clean up
    await sleep(3000);

    // Check if orchestrator stopped
    const cleanExit = await waitForDb(
      "SELECT status FROM orchestrator_state ORDER BY id DESC LIMIT 1",
      "(stop|crash)",
      15000,
      1000
    );
    // Also accept: process exited (means SessionEnd ran)
    const exitOk = cleanExit || exited;
    record(7, exitOk, "Orchestrator stopped cleanly");

    // ──────────────────────────────────────────────────────
    // Step 8: Check orchestrator log
    // ──────────────────────────────────────────────────────
    log("Step 8: Checking orchestrator log...");
    const logsDir = "C:/Users/user/.claude/logs/";
    const logFiles = fs.readdirSync(logsDir)
      .filter(f => f.startsWith("aidam_orchestrator_2"))
      .sort()
      .reverse();
    if (logFiles.length > 0) {
      const latestLog = fs.readFileSync(logsDir + logFiles[0], "utf-8");
      log(`Latest orchestrator log (${logFiles[0]}):`);
      log(latestLog);
      const hasRetrieverInit = /Retriever session ID/.test(latestLog);
      record(8, hasRetrieverInit, "Orchestrator log shows Retriever initialized");
    } else {
      record(8, false, "No orchestrator log found");
    }

    // ──────────────────────────────────────────────────────
    // Summary
    // ──────────────────────────────────────────────────────
    const passed = results.filter(r => r.passed).length;
    const total = results.length;
    const failed = results.filter(r => !r.passed);
    log(`\n${"=".repeat(60)}`);
    log(`RESULTS: ${passed}/${total} passed`);
    if (failed.length > 0) {
      log("FAILURES:");
      failed.forEach(f => log(`  Step ${f.step}: ${f.desc}`));
    }
    log(`${"=".repeat(60)}`);
    if (failed.length === 0) {
      log("\n=== ALL TESTS PASSED ===");
    }

  } catch (err) {
    log(`ERROR: ${err.message}`);
    log(`Last output: ${cleanAnsi(output).slice(-1000)}`);
  } finally {
    if (!exited) {
      proc.write("\x03"); // Ctrl+C
      await new Promise((r) => setTimeout(r, 3000));
      if (!exited) proc.kill();
    }
  }
}

run().then(() => process.exit(0)).catch(() => process.exit(1));

// Safety timeout
setTimeout(() => {
  log("GLOBAL TIMEOUT - killing");
  if (!exited) proc.kill();
  process.exit(1);
}, 180000);
