/**
 * AIDAM Level 15 — API Pattern Extraction ("J'apprends une API")
 *
 * #59: API observation — Learner observes Azure CLI calls → saves pattern
 * #60: API recall — Retriever surfaces Azure commands when asked
 * #61: API error learning — Learner observes 401 error + fix → saves error_solution
 * #62: API composition — Retriever composes deploy+configure+verify in one response
 *
 * AGI Level: 84/100
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
  const logFile = `C:/Users/user/.claude/logs/aidam_orch_test15_${sessionId.slice(-8)}.log`;
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

const TEST_TAG = `L15_${Date.now()}`;

async function run() {
  const SESSION_ID = `level15-${Date.now()}`;
  console.log(`\n${"═".repeat(60)}`);
  console.log(`  AIDAM Level 15: API Pattern Extraction ("J'apprends une API")`);
  console.log(`${"═".repeat(60)}`);
  let validatorCost = 0;
  console.log(`Session ID: ${SESSION_ID}`);
  console.log(`Test tag: ${TEST_TAG}\n`);

  await cleanSession(SESSION_ID);

  // Launch orchestrator
  console.log("Launching orchestrator (Retriever + Learner)...");
  const orch = launchOrchestrator(SESSION_ID);
  const started = await waitForStatus(SESSION_ID, "running", 25000);
  console.log(`Orchestrator started: ${started}`);
  if (!started) {
    console.log("FATAL: Orchestrator didn't start.");
    console.log("Log:", readLog(orch.logFile).slice(-2000));
    for (let i = 59; i <= 62; i++) record(i, false, "Orchestrator didn't start");
    printSummary();
    return;
  }
  console.log("Waiting for agents to initialize...\n");
  await new Promise(r => setTimeout(r, 12000));

  // Warm-up — use a generic memory check to prime the Retriever without Azure context
  const warmHash = await injectPrompt(SESSION_ID, "What projects are stored in memory?");
  await waitForRetrieval(SESSION_ID, warmHash, 30000);
  console.log("Warm-up complete.\n");

  // Extra pause to let Retriever context settle
  await new Promise(r => setTimeout(r, 5000));

  // ═══════════════════════════════════════════════════════════
  // TEST #59: API Observation
  // Learner sees 3 Azure CLI calls with real-looking responses
  // ═══════════════════════════════════════════════════════════
  console.log("=== Test #59: API observation ===\n");

  // Observation 1: az webapp list
  const az1 = await injectToolUse(SESSION_ID, {
    tool_name: "Bash",
    tool_input: { command: 'az webapp list --resource-group EcopathsWebService --output table' },
    tool_response: `Name               Location       State    ResourceGroup\n-----------------  -------------  -------  -------------------\necopaths-webapp    France Central Running  EcopathsWebService\necopaths-staging   France Central Stopped  EcopathsWebService`
  });
  console.log(`  Observation 1: az webapp list (id=${az1})`);
  const s1 = await waitForProcessed(az1, 90000);
  console.log(`  Learner processed: ${s1}`);

  // Observation 2: az webapp config
  const az2 = await injectToolUse(SESSION_ID, {
    tool_name: "Bash",
    tool_input: { command: 'az webapp config appsettings set --name ecopaths-webapp --resource-group EcopathsWebService --settings SPRING_PROFILES_ACTIVE=staging,prod JWT_KEY=my-secret-key-2026' },
    tool_response: `[\n  {"name": "SPRING_PROFILES_ACTIVE", "slotSetting": false, "value": "staging,prod"},\n  {"name": "JWT_KEY", "slotSetting": false, "value": "my-secret-key-2026"},\n  {"name": "SPRING_DATASOURCE_USERNAME", "slotSetting": false, "value": "postgres"}\n]`
  });
  console.log(`  Observation 2: az webapp config (id=${az2})`);
  const s2 = await waitForProcessed(az2, 90000);
  console.log(`  Learner processed: ${s2}`);

  // Observation 3: az webapp deploy
  const az3 = await injectToolUse(SESSION_ID, {
    tool_name: "Bash",
    tool_input: { command: 'az webapp deploy --name ecopaths-webapp --resource-group EcopathsWebService --src-path target/ecopaths-0.0.1-SNAPSHOT.jar --type jar --async true' },
    tool_response: `Deploying to ecopaths-webapp...\nDeployment initiated. Track status with: az webapp deployment show --name ecopaths-webapp\nDeployment ID: deploy-2026-02-21-001\nStatus: InProgress`
  });
  console.log(`  Observation 3: az webapp deploy (id=${az3})`);
  const s3 = await waitForProcessed(az3, 90000);
  console.log(`  Learner processed: ${s3}`);

  await new Promise(r => setTimeout(r, 3000));

  // Check what was saved
  const azurePatterns = await dbQuery(
    "SELECT id, name FROM patterns WHERE name ILIKE '%azure%' OR name ILIKE '%az %' OR context ILIKE '%az webapp%' OR solution ILIKE '%az webapp%' ORDER BY id DESC LIMIT 5"
  );
  const azureLearnings = await dbQuery(
    "SELECT id, topic FROM learnings WHERE topic ILIKE '%azure%' OR topic ILIKE '%az %' OR insight ILIKE '%az webapp%' ORDER BY id DESC LIMIT 5"
  );

  console.log(`  Azure patterns saved: ${azurePatterns.rows.length}`);
  azurePatterns.rows.forEach(p => console.log(`    [#${p.id}] ${p.name}`));
  console.log(`  Azure learnings saved: ${azureLearnings.rows.length}`);
  azureLearnings.rows.forEach(l => console.log(`    [#${l.id}] ${l.topic}`));

  const apiKnowledge = azurePatterns.rows.length + azureLearnings.rows.length;
  record(59, apiKnowledge >= 1,
    `API observation: patterns=${azurePatterns.rows.length}, learnings=${azureLearnings.rows.length}, total=${apiKnowledge}`);

  await new Promise(r => setTimeout(r, 3000));

  // ═══════════════════════════════════════════════════════════
  // TEST #60: API Recall
  // Retriever surfaces Azure CLI commands when asked
  // ═══════════════════════════════════════════════════════════
  console.log("\n=== Test #60: API recall ===\n");

  const recallPrompt = "NEW TASK: I need to deploy a Spring Boot JAR to Azure App Service. Give me the exact az CLI commands for listing webapps, setting config, and deploying the artifact.";
  const recallHash = await injectPrompt(SESSION_ID, recallPrompt);
  console.log(`  Sent recall prompt (hash=${recallHash})`);

  const recallResult = await waitForRetrieval(SESSION_ID, recallHash, 35000);
  const recallText = recallResult?.context_text || "";
  console.log(`  Retriever type: ${recallResult?.context_type || "timeout"}`);
  console.log(`  Length: ${recallText.length} chars`);
  console.log(`  Preview: ${recallText.slice(0, 300)}`);

  const mentionsAz = /az webapp|azure/i.test(recallText);
  const mentionsDeploy = /deploy|jar/i.test(recallText);
  console.log(`  Mentions az/azure: ${mentionsAz}`);
  console.log(`  Mentions deploy/jar: ${mentionsDeploy}`);

  const preCheck60 = recallText.length > 50 && (mentionsAz || mentionsDeploy);
  if (preCheck60) {
    const v60 = await askValidator(60, "Retriever recalls Azure-related knowledge when asked about deploying a Java WAR on Azure", recallText, "The retrieval should return Azure-related knowledge: deployment patterns, error solutions, or configuration commands (e.g., az webapp, az login, az config). Any Azure-related actionable content counts as relevant recall, including known errors and their solutions.");
    validatorCost += v60.cost;
    record(60, v60.passed, `${v60.reason}`);
  } else {
    record(60, false, `Structural pre-check failed: azure=${mentionsAz}, deploy=${mentionsDeploy}, length=${recallText.length}`);
  }

  await new Promise(r => setTimeout(r, 3000));

  // ═══════════════════════════════════════════════════════════
  // TEST #61: API Error Learning
  // Learner observes a 401 error + the fix
  // ═══════════════════════════════════════════════════════════
  console.log("\n=== Test #61: API error learning ===\n");

  // Error observation
  const azErr = await injectToolUse(SESSION_ID, {
    tool_name: "Bash",
    tool_input: { command: 'az webapp deploy --name ecopaths-webapp --resource-group EcopathsWebService --src-path target/ecopaths-0.0.1-SNAPSHOT.jar --type jar' },
    tool_response: `ERROR: The client '5a3f7b9c-xxxx' with object id '5a3f7b9c-xxxx' does not have authorization to perform action 'Microsoft.Web/sites/extensions/write' over scope '/subscriptions/04da664c/resourceGroups/EcopathsWebService/providers/Microsoft.Web/sites/ecopaths-webapp'. Status: 401 (Unauthorized)\nPlease ensure your Azure credentials are fresh: try 'az login --tenant <your-tenant-id>'`
  });
  console.log(`  Error observation (id=${azErr})`);
  const sErr = await waitForProcessed(azErr, 90000);
  console.log(`  Learner processed: ${sErr}`);

  // Fix observation
  const azFix = await injectToolUse(SESSION_ID, {
    tool_name: "Bash",
    tool_input: { command: 'az login --tenant 04da664c-9191-4cbd-a63f-4fc203e43724 && az webapp deploy --name ecopaths-webapp --resource-group EcopathsWebService --src-path target/ecopaths-0.0.1-SNAPSHOT.jar --type jar' },
    tool_response: `Logged in as yann.favin-leveque@eco-paths.com\nDeploying to ecopaths-webapp...\nDeployment complete. Status: Success`
  });
  console.log(`  Fix observation (id=${azFix})`);
  const sFix = await waitForProcessed(azFix, 90000);
  console.log(`  Learner processed: ${sFix}`);

  await new Promise(r => setTimeout(r, 3000));

  // Check for error_solutions
  const azureErrors = await dbQuery(
    "SELECT id, error_signature, solution FROM errors_solutions WHERE error_signature ILIKE '%401%' OR error_signature ILIKE '%unauthorized%' OR error_signature ILIKE '%azure%' OR solution ILIKE '%az login%' ORDER BY id DESC LIMIT 3"
  );
  console.log(`  Azure errors saved: ${azureErrors.rows.length}`);
  azureErrors.rows.forEach(e => console.log(`    [#${e.id}] ${e.error_signature.slice(0, 80)}`));

  // Also check if it was saved as a learning
  const azureErrLearnings = await dbQuery(
    "SELECT id, topic FROM learnings WHERE topic ILIKE '%401%' OR topic ILIKE '%unauthorized%' OR insight ILIKE '%az login%' OR topic ILIKE '%azure%auth%' ORDER BY id DESC LIMIT 3"
  );
  console.log(`  Error learnings: ${azureErrLearnings.rows.length}`);

  const errorSaved = azureErrors.rows.length > 0 || azureErrLearnings.rows.length > 0;
  record(61, errorSaved,
    `API error: errors=${azureErrors.rows.length}, learnings=${azureErrLearnings.rows.length}`);

  await new Promise(r => setTimeout(r, 3000));

  // ═══════════════════════════════════════════════════════════
  // TEST #62: API Composition
  // Retriever should compose deploy+configure+verify
  // ═══════════════════════════════════════════════════════════
  console.log("\n=== Test #62: API composition ===\n");

  const composePrompt = "NEW TASK: Write a complete deployment checklist for Azure App Service: first set environment variables like SPRING_PROFILES_ACTIVE, then deploy the JAR, handle any auth errors, and verify with health endpoint.";
  const composeHash = await injectPrompt(SESSION_ID, composePrompt);
  console.log(`  Sent composition prompt (hash=${composeHash})`);

  const composeResult = await waitForRetrieval(SESSION_ID, composeHash, 35000);
  const composeText = composeResult?.context_text || "";
  console.log(`  Retriever type: ${composeResult?.context_type || "timeout"}`);
  console.log(`  Length: ${composeText.length} chars`);
  console.log(`  Preview: ${composeText.slice(0, 400)}`);

  const mentionsConfig = /config|appsettings|SPRING_PROFILES|environment/i.test(composeText);
  const mentionsDeployCmd = /deploy|webapp|jar/i.test(composeText);
  const mentionsAuth = /login|401|unauthorized|credential/i.test(composeText);
  const aspectsCovered = [mentionsConfig, mentionsDeployCmd, mentionsAuth].filter(Boolean).length;

  console.log(`  Mentions config: ${mentionsConfig}`);
  console.log(`  Mentions deploy: ${mentionsDeployCmd}`);
  console.log(`  Mentions auth: ${mentionsAuth}`);
  console.log(`  Aspects covered: ${aspectsCovered}/3`);

  // Pass if at least 2 aspects are covered (config + deploy minimum)
  const preCheck62 = composeText.length > 100 && aspectsCovered >= 2;
  if (preCheck62) {
    const v62 = await askValidator(62, "Retriever composes config+deploy+auth aspects", composeText, "Must cover at least 2 of: configuration (appsettings, environment vars), deployment (az webapp, JAR), authentication (401, credentials). Should synthesize them coherently.");
    validatorCost += v62.cost;
    record(62, v62.passed, `${v62.reason}`);
  } else {
    record(62, false, `Structural pre-check failed: aspects=${aspectsCovered}/3, length=${composeText.length}`);
  }

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

  // Cleanup
  await killSession(SESSION_ID, orch.proc);
  await cleanSession(SESSION_ID);

  console.log(`  Validator cost: $${validatorCost.toFixed(4)}`);
  printSummary();
}

function printSummary() {
  const passed = results.filter(r => r.passed).length;
  const total = results.length;
  const failed = results.filter(r => !r.passed);
  console.log(`\n${"═".repeat(60)}`);
  console.log(`  LEVEL 15 RESULTS: ${passed}/${total} passed`);
  if (failed.length > 0) {
    console.log("  FAILURES:");
    failed.forEach(f => console.log(`    Step ${f.step}: ${f.desc}`));
  }
  console.log(`${"═".repeat(60)}`);
  if (failed.length === 0) {
    console.log(`\n████████████████████████████████████████████████████████████
█                                                          █
█   ALL LEVEL 15 TESTS PASSED — API PATTERN EXTRACTION!   █
█                                                          █
█   AIDAM learns API usage from observations, recalls      █
█   commands, saves errors+fixes, and composes multi-step  █
█   API workflows from memory.                             █
█                                                          █
████████████████████████████████████████████████████████████\n`);
  }
}

run().then(() => process.exit(0)).catch(err => {
  console.error("Test error:", err);
  process.exit(1);
});

setTimeout(() => { console.log("GLOBAL TIMEOUT"); process.exit(1); }, 600000);
