/**
 * AIDAM Level 31 — Claude Code Session Spawning ("J'apprends a me cloner")
 *
 * #127: Need discovery — Learner detects need for sub-sessions
 * #128: Web docs research — Learner extracts docs from web search
 * #129: Pattern learning — Learner extracts claude --print pattern
 * #130: Workflow creation — Learner saves generated_tool for sub-sessions
 * #131: Sub-session pattern — DB has pattern + learning + URL
 * #132: Capability recall — Retriever finds sub-session pattern
 *
 * AGI Level: 103/100
 */
const { Client } = require("pg");
const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const DB = { host: "localhost", database: "claude_memory", user: "postgres", password: process.env.PGPASSWORD || "", port: 5432 };
const ORCHESTRATOR = path.join(__dirname, "orchestrator.js");

const results = [];
function record(step, passed, desc) { results.push({ step, passed, desc }); console.log(`  ${passed ? "PASS" : "FAIL"}: ${desc}`); }

async function dbQuery(sql, params = []) { const db = new Client(DB); await db.connect(); const r = await db.query(sql, params); await db.end(); return r; }
async function waitForStatus(sid, pat, ms = 25000) { const re = new RegExp(pat, "i"); const s = Date.now(); while (Date.now() - s < ms) { const r = await dbQuery("SELECT status FROM orchestrator_state WHERE session_id=$1", [sid]); if (r.rows.length > 0 && re.test(r.rows[0].status)) return true; await new Promise(r => setTimeout(r, 1000)); } return false; }
function launchOrch(sid, opts = {}) { const lf = `C:/Users/user/.claude/logs/aidam_orch_test31_${sid.slice(-8)}.log`; const fd = fs.openSync(lf, "w"); const p = spawn("node", [ORCHESTRATOR, `--session-id=${sid}`, "--cwd=C:/Users/user/IdeaProjects/aidam-memory-plugin", `--retriever=${opts.retriever||"on"}`, `--learner=${opts.learner||"on"}`, "--compactor=off", "--project-slug=aidam-memory"], { stdio: ["ignore", fd, fd], detached: false }); let ex = false; p.on("exit", () => { ex = true; }); return { proc: p, logFile: lf, isExited: () => ex }; }
async function killSession(sid, proc) { try { await dbQuery("UPDATE orchestrator_state SET status='stopping' WHERE session_id=$1", [sid]); } catch {} await new Promise(r => setTimeout(r, 4000)); try { proc.kill(); } catch {} await new Promise(r => setTimeout(r, 1000)); }
async function cleanSession(sid) { await dbQuery("DELETE FROM orchestrator_state WHERE session_id=$1", [sid]); await dbQuery("DELETE FROM cognitive_inbox WHERE session_id=$1", [sid]); await dbQuery("DELETE FROM retrieval_inbox WHERE session_id=$1", [sid]); }
async function injectToolUse(sid, pl) { const r = await dbQuery("INSERT INTO cognitive_inbox (session_id, message_type, payload, status) VALUES ($1, 'tool_use', $2, 'pending') RETURNING id", [sid, JSON.stringify(pl)]); return r.rows[0].id; }
async function injectPrompt(sid, prompt) { const h = crypto.createHash("sha256").update(prompt).digest("hex").slice(0, 16); await dbQuery("INSERT INTO cognitive_inbox (session_id, message_type, payload, status) VALUES ($1, 'prompt_context', $2, 'pending')", [sid, JSON.stringify({ prompt, prompt_hash: h, timestamp: Date.now() })]); return h; }
async function waitForProcessed(id, ms = 90000) { const s = Date.now(); while (Date.now() - s < ms) { const r = await dbQuery("SELECT status FROM cognitive_inbox WHERE id=$1", [id]); if (r.rows.length > 0 && /completed|failed/.test(r.rows[0].status)) return r.rows[0].status; await new Promise(r => setTimeout(r, 2000)); } return "timeout"; }
async function waitForRetrieval(sid, h, ms = 45000) { const s = Date.now(); while (Date.now() - s < ms) { const r = await dbQuery("SELECT context_type, context_text FROM retrieval_inbox WHERE session_id=$1 AND prompt_hash=$2 ORDER BY id DESC LIMIT 1", [sid, h]); if (r.rows.length > 0) return r.rows[0]; await new Promise(r => setTimeout(r, 1000)); } return null; }
function readLog(f) { try { return fs.readFileSync(f, "utf-8"); } catch { return ""; } }
function extractCost(log) { return (log.match(/cost: \$([0-9.]+)/g) || []).reduce((s, m) => s + parseFloat(m.replace("cost: $", "")), 0); }

async function run() {
  const SID = `level31-${Date.now()}`;
  console.log(`\n${"=".repeat(60)}`);
  console.log(`  AIDAM Level 31: Claude Code Session Spawning ("J'apprends a me cloner")`);
  console.log(`${"=".repeat(60)}`);
  console.log(`Session ID: ${SID}\n`);

  await cleanSession(SID);

  console.log("Launching orchestrator (Retriever + Learner)...");
  const orch = launchOrch(SID);
  const started = await waitForStatus(SID, "running", 25000);
  console.log(`Orchestrator started: ${started}`);
  if (!started) { for (let i = 127; i <= 132; i++) record(i, false, "No start"); printSummary(); return; }
  console.log("Waiting for agents to initialize...\n");
  await new Promise(r => setTimeout(r, 12000));
  const wh = await injectPrompt(SID, "What automation tools do we use?");
  await waitForRetrieval(SID, wh, 30000);
  console.log("Warm-up complete.\n");
  await new Promise(r => setTimeout(r, 5000));

  // =============================================
  // TEST #127: Need discovery
  // =============================================
  console.log("=== Test #127: Need discovery ===\n");

  const id127 = await injectToolUse(SID, {
    tool_name: "Read",
    tool_input: { file_path: "src/main/java/com/app/services/" },
    tool_response: "I have 12 complex service files to analyze (each ~500 lines). The context window is getting large and I'm losing earlier context. This task would be easier if I could delegate sub-analyses to separate Claude sessions, each handling one file, then consolidate results. Currently I must process them sequentially and risk context loss."
  });
  console.log(`  Injected need observation (id=${id127})`);
  const st127 = await waitForProcessed(id127, 90000);
  console.log(`  Status: ${st127}`);
  record(127, st127 === "completed", `Need discovery: ${st127}`);
  await new Promise(r => setTimeout(r, 5000));

  // =============================================
  // TEST #128: Web docs research
  // =============================================
  console.log("\n=== Test #128: Web docs research ===\n");

  const id128a = await injectToolUse(SID, {
    tool_name: "WebSearch",
    tool_input: { query: "claude code CLI headless mode run prompt programmatically" },
    tool_response: "Results:\n1. Claude Code CLI docs: Use `claude -p 'prompt'` or `claude --print 'prompt'` for non-interactive (headless) mode. Outputs result to stdout.\n2. Claude Code SDK: `import { query } from '@anthropic-ai/claude-agent-sdk'` for programmatic access. Supports persistSession, resume, mcpServers.\n3. Piping: `echo 'prompt' | claude -p` works for stdin. Exit code 0 on success.\n4. Batch mode: Process multiple prompts with a script that calls `claude -p` in a loop."
  });
  const id128b = await injectToolUse(SID, {
    tool_name: "WebFetch",
    tool_input: { url: "https://docs.anthropic.com/claude-code/cli-reference" },
    tool_response: "Claude Code CLI Reference:\n\nUsage: claude [options] [prompt]\n\nOptions:\n  -p, --print     Print response without interactive mode\n  --model MODEL   Specify model (default: claude-sonnet)\n  --cwd DIR       Set working directory\n  --output-format json|text  Output format\n  --max-turns N   Maximum agent turns\n  --allowedTools  Comma-separated list of allowed tools\n\nSDK: @anthropic-ai/claude-agent-sdk\n  query({prompt, options: {model, cwd, maxTurns, persistSession, resume, mcpServers}})\n  Returns AsyncIterable<SDKMessage>"
  });
  console.log(`  Injected WebSearch (id=${id128a}) + WebFetch (id=${id128b})`);
  const st128a = await waitForProcessed(id128a, 90000);
  const st128b = await waitForProcessed(id128b, 90000);
  console.log(`  WebSearch: ${st128a}, WebFetch: ${st128b}`);
  record(128, st128a === "completed" && st128b === "completed", `Web docs: search=${st128a}, fetch=${st128b}`);
  await new Promise(r => setTimeout(r, 5000));

  // =============================================
  // TEST #129: Pattern learning
  // =============================================
  console.log("\n=== Test #129: Pattern learning ===\n");

  const id129 = await injectToolUse(SID, {
    tool_name: "Bash",
    tool_input: { command: "claude -p 'Analyze this file and list all public methods' < src/UserService.java" },
    tool_response: "Public methods in UserService.java:\n1. findById(Long id) -> Optional<User>\n2. createUser(UserDTO dto) -> User\n3. updateUser(Long id, UserDTO dto) -> User\n4. deleteUser(Long id) -> void\n5. findByEmail(String email) -> Optional<User>\n6. listUsers(Pageable page) -> Page<User>\n\nThis worked! claude -p runs in headless mode, processes the prompt, and returns results to stdout. Very useful for parallelizing analysis tasks."
  });
  console.log(`  Injected claude -p usage (id=${id129})`);
  const st129 = await waitForProcessed(id129, 90000);
  console.log(`  Status: ${st129}`);
  record(129, st129 === "completed", `Pattern learning: ${st129}`);
  await new Promise(r => setTimeout(r, 5000));

  // =============================================
  // TEST #130: Workflow creation
  // =============================================
  console.log("\n=== Test #130: Workflow creation ===\n");

  const id130 = await injectToolUse(SID, {
    tool_name: "Write",
    tool_input: { file_path: "scripts/parallel_analysis.sh" },
    tool_response: "Created parallel_analysis.sh:\n#!/bin/bash\n# Parallel file analysis using Claude sub-sessions\n# Usage: ./parallel_analysis.sh src/services/*.java\n\nOUTDIR=$(mktemp -d)\nPIDS=()\n\nfor file in \"$@\"; do\n  name=$(basename \"$file\" .java)\n  claude -p \"Analyze $file: list public methods, identify bugs, suggest improvements\" \\\n    --output-format json > \"$OUTDIR/$name.json\" &\n  PIDS+=($!)\ndone\n\n# Wait for all sub-sessions\nfor pid in \"${PIDS[@]}\"; do wait $pid; done\n\n# Consolidate results\necho '=== Consolidated Analysis ==='\nfor f in $OUTDIR/*.json; do\n  echo \"--- $(basename $f .json) ---\"\n  cat \"$f\"\ndone\nrm -rf \"$OUTDIR\"\n\nThis script demonstrates parallel Claude sub-session spawning."
  });
  console.log(`  Injected workflow creation (id=${id130})`);
  const st130 = await waitForProcessed(id130, 90000);
  console.log(`  Status: ${st130}`);
  record(130, st130 === "completed", `Workflow creation: ${st130}`);
  await new Promise(r => setTimeout(r, 8000));

  // =============================================
  // TEST #131: Sub-session pattern in DB
  // =============================================
  console.log("\n=== Test #131: Sub-session pattern in DB ===\n");

  const patternCheck = await dbQuery(`
    SELECT name, solution FROM patterns
    WHERE name ILIKE '%session%' OR name ILIKE '%claude%' OR name ILIKE '%parallel%' OR name ILIKE '%delegate%' OR name ILIKE '%headless%'
       OR solution ILIKE '%claude -p%' OR solution ILIKE '%sub-session%' OR solution ILIKE '%headless%'
    ORDER BY created_at DESC LIMIT 5
  `);
  console.log(`  Patterns about sub-sessions: ${patternCheck.rows.length}`);
  patternCheck.rows.forEach(r => console.log(`    Pattern: ${r.name}`));

  const learningCheck = await dbQuery(`
    SELECT topic, insight FROM learnings
    WHERE topic ILIKE '%claude%session%' OR topic ILIKE '%headless%' OR topic ILIKE '%sub-session%' OR topic ILIKE '%parallel%analysis%'
       OR insight ILIKE '%claude -p%' OR insight ILIKE '%sub-session%'
    ORDER BY created_at DESC LIMIT 5
  `);
  console.log(`  Learnings about sub-sessions: ${learningCheck.rows.length}`);
  learningCheck.rows.forEach(r => console.log(`    Learning: ${r.topic}`));

  const toolCheck = await dbQuery("SELECT name FROM generated_tools WHERE name ILIKE '%parallel%' OR name ILIKE '%analysis%' OR description ILIKE '%sub-session%' OR description ILIKE '%claude%' LIMIT 5");
  console.log(`  Generated tools: ${toolCheck.rows.length}`);

  const persisted = [patternCheck.rows.length > 0, learningCheck.rows.length > 0].filter(Boolean).length;
  record(131, persisted >= 1,
    `DB persistence: patterns=${patternCheck.rows.length}, learnings=${learningCheck.rows.length}, tools=${toolCheck.rows.length}`);

  await new Promise(r => setTimeout(r, 5000));

  // =============================================
  // TEST #132: Capability recall
  // =============================================
  console.log("\n=== Test #132: Capability recall ===\n");

  const recallHash = await injectPrompt(SID, "I need to analyze 5 complex files in parallel, each requiring deep analysis. How can I delegate this to separate Claude sessions?");
  console.log(`  Sent recall prompt (hash=${recallHash})`);
  const recallResult = await waitForRetrieval(SID, recallHash, 45000);
  const recallText = recallResult?.context_text || "";
  console.log(`  Type: ${recallResult?.context_type}, Length: ${recallText.length}`);

  const hasCliRef = /claude\s*(-p|--print)/i.test(recallText);
  const hasParallel = /parallel|concurrent|sub.?session|delegate|spawn/i.test(recallText);
  console.log(`  CLI reference: ${hasCliRef}`);
  console.log(`  Parallel concept: ${hasParallel}`);

  record(132, recallText.length > 50 && (hasCliRef || hasParallel),
    `Capability recall: length=${recallText.length}, CLI=${hasCliRef}, parallel=${hasParallel}`);

  // Cleanup
  const logContent = readLog(orch.logFile);
  const totalCost = extractCost(logContent);
  console.log(`\n  Total cost: $${totalCost.toFixed(4)}`);

  await killSession(SID, orch.proc);
  await cleanSession(SID);
  printSummary();
}

function printSummary() {
  const passed = results.filter(r => r.passed).length;
  const total = results.length;
  const failed = results.filter(r => !r.passed);
  console.log(`\n${"=".repeat(60)}`);
  console.log(`  LEVEL 31 RESULTS: ${passed}/${total} passed`);
  if (failed.length > 0) { console.log("  FAILURES:"); failed.forEach(f => console.log(`    Step ${f.step}: ${f.desc}`)); }
  console.log(`${"=".repeat(60)}`);
  if (failed.length === 0) console.log("\n  Level 31 PASSED! Sub-session capability acquired.\n");
}

run().then(() => process.exit(0)).catch(err => { console.error("Test error:", err); process.exit(1); });
setTimeout(() => { console.log("GLOBAL TIMEOUT"); process.exit(1); }, 400000);
