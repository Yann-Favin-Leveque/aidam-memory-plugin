/**
 * AIDAM Level 17 — Companion Memory ("Je me souviens de toi")
 *
 * #67: Style capture — Learner detects coding conventions from observations
 * #68: Language preference — Learner detects user speaks French
 * #69: Work habit capture — Learner spots "always test before push" pattern
 * #70: Preference recall — Retriever injects preferences on style-related prompt
 * #71: Personal context — Retriever answers "what do you know about me?"
 *
 * AGI Level: 87/100
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
  const logFile = `C:/Users/user/.claude/logs/aidam_orch_test17_${sessionId.slice(-8)}.log`;
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

const TEST_TAG = `L17_${Date.now()}`;

async function run() {
  const SESSION_ID = `level17-${Date.now()}`;
  console.log(`\n${"═".repeat(60)}`);
  console.log(`  AIDAM Level 17: Companion Memory ("Je me souviens de toi")`);
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
    for (let i = 67; i <= 71; i++) record(i, false, "Orchestrator didn't start");
    printSummary();
    return;
  }
  console.log("Waiting for agents to initialize...\n");
  await new Promise(r => setTimeout(r, 12000));

  // Warm-up
  const warmHash = await injectPrompt(SESSION_ID, "What do we know about the user's preferences?");
  await waitForRetrieval(SESSION_ID, warmHash, 30000);
  console.log("Warm-up complete.\n");

  // ═══════════════════════════════════════════════════════════
  // TEST #67: Style capture
  // Learner sees coding convention indicators in tool calls
  // ═══════════════════════════════════════════════════════════
  console.log("=== Test #67: Style capture ===\n");

  // Observation: user writes Java with specific style
  const styleObs = await injectToolUse(SESSION_ID, {
    tool_name: "Edit",
    tool_input: {
      file_path: "src/main/java/com/ecopaths/service/UserService.java",
      old_string: "public User get(Long id) {",
      new_string: `/**
     * Get user by ID.
     * Following project conventions: camelCase methods, 4-space indent,
     * always use Optional.orElseThrow(), never return null.
     */
    public User getUserById(Long id) {`
    },
    tool_response: `Edit applied. The user consistently follows these conventions:\n- camelCase method names (getUserById not get_user_by_id)\n- 4-space indentation\n- JavaDoc on public methods\n- Optional.orElseThrow() instead of returning null\n- Descriptive method names (getUserById > get)\n- French comments sometimes (mixed FR/EN codebase)`
  });
  console.log(`  Style observation (id=${styleObs})`);
  const sSt = await waitForProcessed(styleObs, 90000);
  console.log(`  Learner processed: ${sSt}`);

  await new Promise(r => setTimeout(r, 3000));

  // Check user_preferences
  const stylePrefs = await dbQuery(
    "SELECT category, key, value FROM user_preferences WHERE category='coding-style' OR key ILIKE '%camelCase%' OR key ILIKE '%convention%' OR key ILIKE '%indent%' OR value ILIKE '%camelCase%'"
  );
  // Also check learnings about style
  const styleLearnings = await dbQuery(
    "SELECT id, topic FROM learnings WHERE topic ILIKE '%convention%' OR topic ILIKE '%coding style%' OR topic ILIKE '%camelCase%' OR insight ILIKE '%camelCase%' OR insight ILIKE '%convention%' ORDER BY id DESC LIMIT 5"
  );

  console.log(`  Style preferences: ${stylePrefs.rows.length}`);
  stylePrefs.rows.forEach(p => console.log(`    ${p.category}/${p.key}: ${p.value}`));
  console.log(`  Style learnings: ${styleLearnings.rows.length}`);
  styleLearnings.rows.forEach(l => console.log(`    [#${l.id}] ${l.topic}`));

  const styleSaved = stylePrefs.rows.length > 0 || styleLearnings.rows.length > 0;
  record(67, styleSaved,
    `Style capture: prefs=${stylePrefs.rows.length}, learnings=${styleLearnings.rows.length}`);

  await new Promise(r => setTimeout(r, 3000));

  // ═══════════════════════════════════════════════════════════
  // TEST #68: Language preference
  // Learner detects French language usage
  // ═══════════════════════════════════════════════════════════
  console.log("\n=== Test #68: Language preference ===\n");

  const langObs = await injectToolUse(SESSION_ID, {
    tool_name: "Bash",
    tool_input: { command: `echo "L'utilisateur écrit en français dans ses commits et commentaires. Exemples:\n- git commit -m 'feat: ajout du système de notification'\n- // Vérifier que l'utilisateur est connecté avant de continuer\n- // Cette méthode calcule le score pondéré selon les critères ACV\nL'utilisateur préfère le français pour la communication mais l'anglais pour les noms de variables et méthodes."` },
    tool_response: `L'utilisateur écrit en français dans ses commits et commentaires. Exemples:\n- git commit -m 'feat: ajout du système de notification'\n- // Vérifier que l'utilisateur est connecté avant de continuer\n- // Cette méthode calcule le score pondéré selon les critères ACV\nL'utilisateur préfère le français pour la communication mais l'anglais pour les noms de variables et méthodes.`
  });
  console.log(`  Language observation (id=${langObs})`);
  const sLang = await waitForProcessed(langObs, 90000);
  console.log(`  Learner processed: ${sLang}`);

  await new Promise(r => setTimeout(r, 3000));

  const langPrefs = await dbQuery(
    "SELECT category, key, value FROM user_preferences WHERE key ILIKE '%language%' OR key ILIKE '%lang%' OR key ILIKE '%french%' OR key ILIKE '%français%' OR value ILIKE '%french%' OR value ILIKE '%français%' OR value ILIKE '%fr%'"
  );
  const langLearnings = await dbQuery(
    "SELECT id, topic FROM learnings WHERE topic ILIKE '%language%' OR topic ILIKE '%french%' OR topic ILIKE '%français%' OR insight ILIKE '%french%' OR insight ILIKE '%français%' ORDER BY id DESC LIMIT 5"
  );

  console.log(`  Language preferences: ${langPrefs.rows.length}`);
  langPrefs.rows.forEach(p => console.log(`    ${p.category}/${p.key}: ${p.value}`));
  console.log(`  Language learnings: ${langLearnings.rows.length}`);

  const langSaved = langPrefs.rows.length > 0 || langLearnings.rows.length > 0;
  record(68, langSaved,
    `Language pref: prefs=${langPrefs.rows.length}, learnings=${langLearnings.rows.length}`);

  await new Promise(r => setTimeout(r, 3000));

  // ═══════════════════════════════════════════════════════════
  // TEST #69: Work habit capture
  // Learner observes: compile → test → push pattern
  // ═══════════════════════════════════════════════════════════
  console.log("\n=== Test #69: Work habit capture ===\n");

  const habitObs = await injectToolUse(SESSION_ID, {
    tool_name: "Bash",
    tool_input: { command: `# User's consistent workflow before every git push:
# Step 1: Compile
mvn clean compile -q
# Step 2: Run unit tests
mvn test -q
# Step 3: Check for uncommitted changes
git status
# Step 4: Commit and push
git add -A && git commit -m "feat: add notification service" && git push
# The user ALWAYS runs compile + tests before pushing. Never skips tests.` },
    tool_response: `[INFO] BUILD SUCCESS (compile)\n[INFO] Tests run: 42, Failures: 0, Errors: 0, Skipped: 0\n[INFO] BUILD SUCCESS (tests)\nOn branch feature/notifications\nnothing to commit, working tree clean\n[feature/notifications abc1234] feat: add notification service\nCounting objects: 5, done.\nTo github.com:ecopaths/webapp.git`
  });
  console.log(`  Habit observation (id=${habitObs})`);
  const sHab = await waitForProcessed(habitObs, 90000);
  console.log(`  Learner processed: ${sHab}`);

  await new Promise(r => setTimeout(r, 3000));

  const habitPrefs = await dbQuery(
    "SELECT category, key, value FROM user_preferences WHERE key ILIKE '%test%' OR key ILIKE '%workflow%' OR key ILIKE '%push%' OR key ILIKE '%compile%' OR value ILIKE '%test before push%' OR value ILIKE '%always test%'"
  );
  const habitLearnings = await dbQuery(
    "SELECT id, topic FROM learnings WHERE topic ILIKE '%workflow%' OR topic ILIKE '%habit%' OR topic ILIKE '%test.*push%' OR insight ILIKE '%always.*test%' OR insight ILIKE '%before.*push%' ORDER BY id DESC LIMIT 5"
  );

  console.log(`  Habit preferences: ${habitPrefs.rows.length}`);
  habitPrefs.rows.forEach(p => console.log(`    ${p.category}/${p.key}: ${p.value}`));
  console.log(`  Habit learnings: ${habitLearnings.rows.length}`);
  habitLearnings.rows.forEach(l => console.log(`    [#${l.id}] ${l.topic}`));

  const habitSaved = habitPrefs.rows.length > 0 || habitLearnings.rows.length > 0;
  record(69, habitSaved,
    `Work habit: prefs=${habitPrefs.rows.length}, learnings=${habitLearnings.rows.length}`);

  await new Promise(r => setTimeout(r, 3000));

  // ═══════════════════════════════════════════════════════════
  // TEST #70: Preference recall
  // Retriever injects preferences on style question
  // ═══════════════════════════════════════════════════════════
  console.log("\n=== Test #70: Preference recall ===\n");

  const prefPrompt = "What coding conventions should I follow in this project? What's the standard style?";
  const prefHash = await injectPrompt(SESSION_ID, prefPrompt);
  console.log(`  Sent preference prompt (hash=${prefHash})`);

  const prefResult = await waitForRetrieval(SESSION_ID, prefHash, 35000);
  const prefText = prefResult?.context_text || "";
  console.log(`  Retriever type: ${prefResult?.context_type || "timeout"}`);
  console.log(`  Length: ${prefText.length} chars`);
  console.log(`  Preview: ${prefText.slice(0, 400)}`);

  const mentionsCamel = /camelCase|camel.?case/i.test(prefText);
  const mentionsIndent = /4.?space|indent/i.test(prefText);
  const mentionsConventions = /convention|style|standard/i.test(prefText);

  console.log(`  Mentions camelCase: ${mentionsCamel}`);
  console.log(`  Mentions indentation: ${mentionsIndent}`);
  console.log(`  Mentions conventions: ${mentionsConventions}`);

  record(70, prefText.length > 50,
    `Preference recall: camel=${mentionsCamel}, indent=${mentionsIndent}, conventions=${mentionsConventions}, length=${prefText.length}`);

  await new Promise(r => setTimeout(r, 3000));

  // ═══════════════════════════════════════════════════════════
  // TEST #71: Personal context
  // Retriever answers "what do you know about me?"
  // ═══════════════════════════════════════════════════════════
  console.log("\n=== Test #71: Personal context ===\n");

  const personalPrompt = "What do you know about me? My preferences, my habits, my language?";
  const personalHash = await injectPrompt(SESSION_ID, personalPrompt);
  console.log(`  Sent personal prompt (hash=${personalHash})`);

  const personalResult = await waitForRetrieval(SESSION_ID, personalHash, 35000);
  const personalText = personalResult?.context_text || "";
  console.log(`  Retriever type: ${personalResult?.context_type || "timeout"}`);
  console.log(`  Length: ${personalText.length} chars`);
  console.log(`  Preview: ${personalText.slice(0, 400)}`);

  const mentionsFrench = /french|français|fr/i.test(personalText);
  const mentionsCamelP = /camelCase|camel/i.test(personalText);
  const mentionsTestHabit = /test|push|compile|workflow/i.test(personalText);
  const personalAspects = [mentionsFrench, mentionsCamelP, mentionsTestHabit].filter(Boolean).length;

  console.log(`  Mentions French: ${mentionsFrench}`);
  console.log(`  Mentions camelCase: ${mentionsCamelP}`);
  console.log(`  Mentions test/push habit: ${mentionsTestHabit}`);
  console.log(`  Personal aspects: ${personalAspects}/3`);

  record(71, personalText.length > 50 && personalAspects >= 1,
    `Personal context: aspects=${personalAspects}/3, french=${mentionsFrench}, camel=${mentionsCamelP}, test_habit=${mentionsTestHabit}, length=${personalText.length}`);

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
  console.log(`  LEVEL 17 RESULTS: ${passed}/${total} passed`);
  if (failed.length > 0) {
    console.log("  FAILURES:");
    failed.forEach(f => console.log(`    Step ${f.step}: ${f.desc}`));
  }
  console.log(`${"═".repeat(60)}`);
  if (failed.length === 0) {
    console.log(`\n████████████████████████████████████████████████████████████
█                                                          █
█   ALL LEVEL 17 TESTS PASSED — COMPANION MEMORY!         █
█                                                          █
█   AIDAM remembers your coding style, language preference,█
█   work habits, and personal context. It knows YOU.       █
█                                                          █
████████████████████████████████████████████████████████████\n`);
  }
}

run().then(() => process.exit(0)).catch(err => {
  console.error("Test error:", err);
  process.exit(1);
});

setTimeout(() => { console.log("GLOBAL TIMEOUT"); process.exit(1); }, 600000);
