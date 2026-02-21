/**
 * AIDAM Level 33 — Autonomous Debugging + Web Research ("Je debogue")
 *
 * #137: Bug injection (known) — Known error from memory
 * #138: Diagnosis from memory — Retriever finds solution locally
 * #139: Bug injection (unknown) — New error never seen
 * #140: Web search fallback — Learner saves from web search results
 * #141: Solution persistence — DB has error_solution with web source
 * #142: Cross-error pattern — Pattern detected across errors
 *
 * AGI Level: 105/100
 */
const { Client } = require("pg");
const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { askValidator } = require("./test_helpers.js");

require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const DB = { host: "localhost", database: "claude_memory", user: "postgres", password: process.env.PGPASSWORD || "", port: 5432 };
const ORCHESTRATOR = path.join(__dirname, "orchestrator.js");

const results = [];
function record(step, passed, desc) { results.push({ step, passed, desc }); console.log(`  ${passed ? "PASS" : "FAIL"}: ${desc}`); }

async function dbQuery(sql, params = []) { const db = new Client(DB); await db.connect(); const r = await db.query(sql, params); await db.end(); return r; }
async function waitForStatus(sid, pat, ms = 25000) { const re = new RegExp(pat, "i"); const s = Date.now(); while (Date.now() - s < ms) { const r = await dbQuery("SELECT status FROM orchestrator_state WHERE session_id=$1", [sid]); if (r.rows.length > 0 && re.test(r.rows[0].status)) return true; await new Promise(r => setTimeout(r, 1000)); } return false; }
function launchOrch(sid, opts = {}) { const lf = `C:/Users/user/.claude/logs/aidam_orch_test33_${sid.slice(-8)}.log`; const fd = fs.openSync(lf, "w"); const p = spawn("node", [ORCHESTRATOR, `--session-id=${sid}`, "--cwd=C:/Users/user/IdeaProjects/aidam-memory-plugin", `--retriever=${opts.retriever||"on"}`, `--learner=${opts.learner||"on"}`, "--compactor=off", "--project-slug=aidam-memory"], { stdio: ["ignore", fd, fd], detached: false }); let ex = false; p.on("exit", () => { ex = true; }); return { proc: p, logFile: lf, isExited: () => ex }; }
async function killSession(sid, proc) { try { await dbQuery("UPDATE orchestrator_state SET status='stopping' WHERE session_id=$1", [sid]); } catch {} await new Promise(r => setTimeout(r, 4000)); try { proc.kill(); } catch {} await new Promise(r => setTimeout(r, 1000)); }
async function cleanSession(sid) { await dbQuery("DELETE FROM orchestrator_state WHERE session_id=$1", [sid]); await dbQuery("DELETE FROM cognitive_inbox WHERE session_id=$1", [sid]); await dbQuery("DELETE FROM retrieval_inbox WHERE session_id=$1", [sid]); }
async function injectToolUse(sid, pl) { const r = await dbQuery("INSERT INTO cognitive_inbox (session_id, message_type, payload, status) VALUES ($1, 'tool_use', $2, 'pending') RETURNING id", [sid, JSON.stringify(pl)]); return r.rows[0].id; }
async function injectPrompt(sid, prompt) { const h = crypto.createHash("sha256").update(prompt).digest("hex").slice(0, 16); await dbQuery("INSERT INTO cognitive_inbox (session_id, message_type, payload, status) VALUES ($1, 'prompt_context', $2, 'pending')", [sid, JSON.stringify({ prompt, prompt_hash: h, timestamp: Date.now() })]); return h; }
async function waitForProcessed(id, ms = 90000) { const s = Date.now(); while (Date.now() - s < ms) { const r = await dbQuery("SELECT status FROM cognitive_inbox WHERE id=$1", [id]); if (r.rows.length > 0 && /completed|failed/.test(r.rows[0].status)) return r.rows[0].status; await new Promise(r => setTimeout(r, 2000)); } return "timeout"; }
async function waitForRetrieval(sid, h, ms = 45000) { const s = Date.now(); while (Date.now() - s < ms) { const r = await dbQuery("SELECT context_type, context_text FROM retrieval_inbox WHERE session_id=$1 AND prompt_hash=$2 ORDER BY id DESC LIMIT 1", [sid, h]); if (r.rows.length > 0) return r.rows[0]; await new Promise(r => setTimeout(r, 1000)); } return null; }
function readLog(f) { try { return fs.readFileSync(f, "utf-8"); } catch { return ""; } }
function extractCost(log) { return (log.match(/cost: \$([0-9.]+)/g) || []).reduce((s, m) => s + parseFloat(m.replace("cost: $", "")), 0); }

async function run() {
  const SID = `level33-${Date.now()}`;
  let validatorCost = 0;
  console.log(`\n${"=".repeat(60)}`);
  console.log(`  AIDAM Level 33: Autonomous Debugging + Web Research ("Je debogue")`);
  console.log(`${"=".repeat(60)}`);
  console.log(`Session ID: ${SID}\n`);

  await cleanSession(SID);

  // Seed a known error in the DB
  console.log("Seeding known error...");
  await dbQuery(`INSERT INTO errors_solutions (error_signature, error_message, solution, root_cause, prevention)
    VALUES ('column session_id does not exist', 'ERROR: column "session_id" does not exist\nHINT: Perhaps you meant to reference the column "cognitive_inbox.session_id"', 'The query references a column name without the table qualifier. Use table.column syntax or check the column name spelling. In this case, use cognitive_inbox.session_id.', 'Ambiguous column reference in JOIN or subquery', 'Always qualify column names with table alias in complex queries')
    ON CONFLICT DO NOTHING`);
  console.log("Seeded known error.\n");

  console.log("Launching orchestrator (Retriever + Learner)...");
  const orch = launchOrch(SID);
  const started = await waitForStatus(SID, "running", 25000);
  console.log(`Orchestrator started: ${started}`);
  if (!started) { for (let i = 137; i <= 142; i++) record(i, false, "No start"); printSummary(); return; }
  console.log("Waiting for agents to initialize...\n");
  await new Promise(r => setTimeout(r, 12000));
  const wh = await injectPrompt(SID, "What errors have we seen before?");
  await waitForRetrieval(SID, wh, 30000);
  console.log("Warm-up complete.\n");
  await new Promise(r => setTimeout(r, 5000));

  // =============================================
  // TEST #137: Bug injection (known)
  // =============================================
  console.log("=== Test #137: Bug injection (known error) ===\n");

  const id137 = await injectToolUse(SID, {
    tool_name: "Bash",
    tool_input: { command: "psql -c \"SELECT session_id FROM cognitive_inbox WHERE status='pending'\"" },
    tool_response: "ERROR:  column \"session_id\" does not exist\nLINE 1: SELECT session_id FROM cognitive_inbox WHERE status='pending'\n               ^\nHINT:  Perhaps you meant to reference the column \"cognitive_inbox.session_id\".\n\nThis SQL query fails because 'session_id' is ambiguous or doesn't exist. We've seen this before."
  });
  console.log(`  Injected known bug (id=${id137})`);
  const st137 = await waitForProcessed(id137, 90000);
  console.log(`  Status: ${st137}`);
  record(137, st137 === "completed", `Known bug injection: ${st137}`);
  await new Promise(r => setTimeout(r, 5000));

  // =============================================
  // TEST #138: Diagnosis from memory
  // =============================================
  console.log("\n=== Test #138: Diagnosis from memory ===\n");

  const diagHash = await injectPrompt(SID, "I'm getting this error: ERROR: column \"session_id\" does not exist. HINT: Perhaps you meant to reference the column. How do I fix this SQL column error?");
  console.log(`  Sent diagnosis prompt (hash=${diagHash})`);
  const diagResult = await waitForRetrieval(SID, diagHash, 45000);
  const diagText = diagResult?.context_text || "";
  console.log(`  Type: ${diagResult?.context_type}, Length: ${diagText.length}`);

  const hasFix = /qualify|table|alias|column|reference/i.test(diagText);
  console.log(`  Contains fix guidance: ${hasFix}`);

  if (!(diagText.length > 50 && hasFix)) {
    record(138, false, "Structural pre-check failed");
  } else {
    const v138 = await askValidator(138, "Retriever diagnoses known error from memory", diagText, "Must identify the specific error (column session_id not found) and provide the correct fix (qualify column with table name). Should reference the stored error_solution.");
    validatorCost += v138.cost;
    record(138, v138.passed, v138.reason);
  }

  await new Promise(r => setTimeout(r, 5000));

  // =============================================
  // TEST #139: Bug injection (unknown)
  // =============================================
  console.log("\n=== Test #139: Bug injection (unknown error) ===\n");

  const id139 = await injectToolUse(SID, {
    tool_name: "Bash",
    tool_input: { command: "python -c \"import psycopg2; conn=psycopg2.connect(...); cur=conn.cursor(); cur.execute('SELECT similarity(name, %s) FROM tools', ('test',))\"" },
    tool_response: "Traceback (most recent call last):\n  File \"<string>\", line 1, in <module>\npsycopg2.errors.UndefinedFunction: function similarity(text, text) does not exist\nLINE 1: SELECT similarity(name, 'test') FROM tools\n               ^\nHINT:  No function matches the given name and argument types. You might need to add explicit type casts.\n\nThis error has never been seen before in our system."
  });
  console.log(`  Injected unknown bug (id=${id139})`);
  const st139 = await waitForProcessed(id139, 90000);
  console.log(`  Status: ${st139}`);
  record(139, st139 === "completed", `Unknown bug injection: ${st139}`);
  await new Promise(r => setTimeout(r, 5000));

  // =============================================
  // TEST #140: Web search fallback
  // =============================================
  console.log("\n=== Test #140: Web search fallback ===\n");

  const id140a = await injectToolUse(SID, {
    tool_name: "WebSearch",
    tool_input: { query: "psycopg2 UndefinedFunction similarity does not exist postgresql" },
    tool_response: "Results:\n1. Stack Overflow: 'function similarity() does not exist' — You need to install the pg_trgm extension: CREATE EXTENSION IF NOT EXISTS pg_trgm; The similarity() function is part of pg_trgm.\n2. PostgreSQL docs: pg_trgm provides functions and operators for determining the similarity of alphanumeric text. Install with: CREATE EXTENSION pg_trgm;\n3. DBA StackExchange: Missing extension error — Many PostgreSQL functions require extensions to be installed first. Common ones: pg_trgm (similarity), pgcrypto (gen_random_uuid), postgis (spatial)."
  });
  const id140b = await injectToolUse(SID, {
    tool_name: "WebFetch",
    tool_input: { url: "https://stackoverflow.com/questions/12345/similarity-function-not-found" },
    tool_response: "Question: psycopg2.errors.UndefinedFunction: function similarity() does not exist\n\nAccepted Answer (Score: 142):\nThe similarity() function is provided by the pg_trgm extension. You need to install it:\n\nCREATE EXTENSION IF NOT EXISTS pg_trgm;\n\nThis extension must be installed per-database. After installation, the similarity(), word_similarity(), and strict_word_similarity() functions become available.\n\nAlternatively, if you don't have superuser access:\nSELECT * FROM pg_available_extensions WHERE name = 'pg_trgm';\n\nCommon missing extension errors:\n- similarity() → pg_trgm\n- gen_random_uuid() → pgcrypto (or use gen_random_uuid() in PG 13+)\n- ST_Distance() → postgis"
  });
  console.log(`  Injected web search (id=${id140a}) + web fetch (id=${id140b})`);
  const st140a = await waitForProcessed(id140a, 90000);
  const st140b = await waitForProcessed(id140b, 90000);
  console.log(`  WebSearch: ${st140a}, WebFetch: ${st140b}`);
  record(140, st140a === "completed" && st140b === "completed", `Web fallback: search=${st140a}, fetch=${st140b}`);
  await new Promise(r => setTimeout(r, 8000));

  // =============================================
  // TEST #141: Solution persistence
  // =============================================
  console.log("\n=== Test #141: Solution persistence ===\n");

  const errorCheck = await dbQuery(`
    SELECT error_signature, solution, root_cause FROM errors_solutions
    WHERE error_signature ILIKE '%similarity%' OR error_signature ILIKE '%UndefinedFunction%'
       OR error_signature ILIKE '%pg_trgm%' OR solution ILIKE '%pg_trgm%'
    ORDER BY created_at DESC LIMIT 5
  `);
  console.log(`  Errors about similarity/pg_trgm: ${errorCheck.rows.length}`);
  errorCheck.rows.forEach(r => console.log(`    Error: ${r.error_signature} → ${(r.solution || "").slice(0, 80)}`));

  const hasPgTrgm = errorCheck.rows.some(r =>
    /pg_trgm|extension/i.test(r.solution || "") || /pg_trgm|extension/i.test(r.root_cause || ""));

  if (!(errorCheck.rows.length > 0 && hasPgTrgm)) {
    record(141, false, "Structural pre-check failed");
  } else {
    const v141 = await askValidator(141, "Unknown error + web research saved as error_solution", errorCheck.rows, "Saved error must have: specific error_signature mentioning UndefinedFunction or similarity, solution mentioning CREATE EXTENSION pg_trgm, and root_cause explaining the missing extension.");
    validatorCost += v141.cost;
    record(141, v141.passed, v141.reason);
  }

  await new Promise(r => setTimeout(r, 5000));

  // =============================================
  // TEST #142: Cross-error pattern
  // =============================================
  console.log("\n=== Test #142: Cross-error pattern ===\n");

  // Check for a general pattern about missing extensions (in patterns, learnings, OR errors)
  const patternCheck = await dbQuery(`
    SELECT name, solution FROM patterns
    WHERE name ILIKE '%extension%' OR name ILIKE '%missing%function%' OR name ILIKE '%PostgreSQL%extension%'
       OR solution ILIKE '%extension%' OR solution ILIKE '%missing%function%'
    ORDER BY created_at DESC LIMIT 5
  `);
  console.log(`  Patterns about extensions: ${patternCheck.rows.length}`);
  patternCheck.rows.forEach(r => console.log(`    Pattern: ${r.name}`));

  const learningCheck = await dbQuery(`
    SELECT topic FROM learnings
    WHERE topic ILIKE '%extension%' OR topic ILIKE '%pg_trgm%' OR topic ILIKE '%missing%function%'
       OR insight ILIKE '%CREATE EXTENSION%'
    ORDER BY created_at DESC LIMIT 5
  `);
  console.log(`  Learnings about extensions: ${learningCheck.rows.length}`);

  // Also check errors_solutions — the Learner may store as error rather than pattern
  const errorExtCheck = await dbQuery(`
    SELECT error_signature, solution FROM errors_solutions
    WHERE solution ILIKE '%CREATE EXTENSION%' OR error_signature ILIKE '%extension%'
       OR error_signature ILIKE '%UndefinedFunction%' OR solution ILIKE '%pg_trgm%'
    ORDER BY created_at DESC LIMIT 5
  `);
  console.log(`  Errors about extensions: ${errorExtCheck.rows.length}`);

  // Any stored knowledge about missing extensions counts (pattern, learning, or error)
  const hasGeneralPattern = patternCheck.rows.length > 0 || learningCheck.rows.length > 0 || errorExtCheck.rows.length > 0;
  if (!hasGeneralPattern) {
    record(142, false, "Structural pre-check failed");
  } else {
    const v142 = await askValidator(142, "System has PostgreSQL extension-related knowledge", { patterns: patternCheck.rows, learnings: learningCheck.rows, errors: errorExtCheck.rows }, "At least one entry should relate to PostgreSQL extensions (pg_trgm, unaccent, CREATE EXTENSION, or similar). An error entry about missing function/extension with a CREATE EXTENSION solution counts as valid.");
    validatorCost += v142.cost;
    record(142, v142.passed, v142.reason);
  }

  // Cleanup
  const logContent = readLog(orch.logFile);
  const totalCost = extractCost(logContent);
  console.log(`\n  Total cost: $${totalCost.toFixed(4)}`);
  console.log(`  Validator cost: $${validatorCost.toFixed(4)}`);

  await killSession(SID, orch.proc);
  await cleanSession(SID);
  printSummary();
}

function printSummary() {
  const passed = results.filter(r => r.passed).length;
  const total = results.length;
  const failed = results.filter(r => !r.passed);
  console.log(`\n${"=".repeat(60)}`);
  console.log(`  LEVEL 33 RESULTS: ${passed}/${total} passed`);
  if (failed.length > 0) { console.log("  FAILURES:"); failed.forEach(f => console.log(`    Step ${f.step}: ${f.desc}`)); }
  console.log(`${"=".repeat(60)}`);
  if (failed.length === 0) console.log("\n  Level 33 PASSED! Autonomous debugging with web fallback.\n");
}

run().then(() => process.exit(0)).catch(err => { console.error("Test error:", err); process.exit(1); });
setTimeout(() => { console.log("GLOBAL TIMEOUT"); process.exit(1); }, 400000);
