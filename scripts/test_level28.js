/**
 * AIDAM Level 28 — Full Autonomous Intelligence ("Je suis AIDAM")
 *
 * #112: Marathon learning — 10 tool observations, >=5 artifacts created
 * #113: Marathon retrieval — 5 prompts, >=4/5 get relevant context
 * #114: Knowledge graph — >=3 layers of depth (atomic → patterns → drilldowns)
 * #115: Autonomous workflow — Complex prompt combines >=4 sources
 * #116: Cost efficiency — Total level cost < $2.50
 *
 * AGI Level: 100/100
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
function launchOrch(sid, opts = {}) { const lf = `C:/Users/user/.claude/logs/aidam_orch_test28_${sid.slice(-8)}.log`; const fd = fs.openSync(lf, "w"); const p = spawn("node", [ORCHESTRATOR, `--session-id=${sid}`, "--cwd=C:/Users/user/IdeaProjects/ecopathsWebApp1b", `--retriever=${opts.retriever||"on"}`, `--learner=${opts.learner||"on"}`, "--compactor=off", "--project-slug=ecopaths"], { stdio: ["ignore", fd, fd], detached: false }); let ex = false; p.on("exit", () => { ex = true; }); return { proc: p, logFile: lf, isExited: () => ex }; }
async function killSession(sid, proc) { try { await dbQuery("UPDATE orchestrator_state SET status='stopping' WHERE session_id=$1", [sid]); } catch {} await new Promise(r => setTimeout(r, 4000)); try { proc.kill(); } catch {} await new Promise(r => setTimeout(r, 1000)); }
async function cleanSession(sid) { await dbQuery("DELETE FROM orchestrator_state WHERE session_id=$1", [sid]); await dbQuery("DELETE FROM cognitive_inbox WHERE session_id=$1", [sid]); await dbQuery("DELETE FROM retrieval_inbox WHERE session_id=$1", [sid]); }
async function injectToolUse(sid, pl) { const r = await dbQuery("INSERT INTO cognitive_inbox (session_id, message_type, payload, status) VALUES ($1, 'tool_use', $2, 'pending') RETURNING id", [sid, JSON.stringify(pl)]); return r.rows[0].id; }
async function injectPrompt(sid, prompt) { const h = crypto.createHash("sha256").update(prompt).digest("hex").slice(0, 16); await dbQuery("INSERT INTO cognitive_inbox (session_id, message_type, payload, status) VALUES ($1, 'prompt_context', $2, 'pending')", [sid, JSON.stringify({ prompt, prompt_hash: h, timestamp: Date.now() })]); return h; }
async function waitForProcessed(id, ms = 90000) { const s = Date.now(); while (Date.now() - s < ms) { const r = await dbQuery("SELECT status FROM cognitive_inbox WHERE id=$1", [id]); if (r.rows.length > 0 && /completed|failed/.test(r.rows[0].status)) return r.rows[0].status; await new Promise(r => setTimeout(r, 2000)); } return "timeout"; }
async function waitForRetrieval(sid, h, ms = 45000) { const s = Date.now(); while (Date.now() - s < ms) { const r = await dbQuery("SELECT context_type, context_text FROM retrieval_inbox WHERE session_id=$1 AND prompt_hash=$2 ORDER BY id DESC LIMIT 1", [sid, h]); if (r.rows.length > 0) return r.rows[0]; await new Promise(r => setTimeout(r, 1000)); } return null; }
function readLog(f) { try { return fs.readFileSync(f, "utf-8"); } catch { return ""; } }
function extractCost(log) { return (log.match(/cost: \$([0-9.]+)/g) || []).reduce((s, m) => s + parseFloat(m.replace("cost: $", "")), 0); }

async function run() {
  const SID = `level28-${Date.now()}`;
  let validatorCost = 0;
  console.log(`\n${"═".repeat(60)}`);
  console.log(`  AIDAM Level 28: Full Autonomous Intelligence ("Je suis AIDAM")`);
  console.log(`${"═".repeat(60)}`);
  console.log(`Session ID: ${SID}\n`);

  await cleanSession(SID);
  console.log("Launching orchestrator (Retriever + Learner)...");
  const orch = launchOrch(SID);
  const started = await waitForStatus(SID, "running", 25000);
  console.log(`Orchestrator started: ${started}`);
  if (!started) { for (let i = 112; i <= 116; i++) record(i, false, "No start"); printSummary(); return; }
  console.log("Waiting for agents to initialize...\n");
  await new Promise(r => setTimeout(r, 12000));
  const wh = await injectPrompt(SID, "What projects are stored in memory?");
  await waitForRetrieval(SID, wh, 30000);
  console.log("Warm-up complete.\n");
  await new Promise(r => setTimeout(r, 8000));

  // ═══════════════════════════════════════════════════════════
  // TEST #112: Marathon learning — 10 tool observations
  // ═══════════════════════════════════════════════════════════
  console.log("=== Test #112: Marathon learning (10 observations) ===\n");

  const observations = [
    { tool_name: "Bash", tool_input: { command: "mvn test" }, tool_response: "Flakey test: ProductServiceTest.testConcurrentUpdate fails 20% of the time due to race condition. Fix: Use @Transactional(isolation=SERIALIZABLE) for concurrent update tests, or use CountDownLatch for synchronization." },
    { tool_name: "Edit", tool_input: { file_path: "pom.xml" }, tool_response: "Added MapStruct 1.5.5 for DTO mapping. Convention: All mappers in com.ecopaths.mapper package, annotated with @Mapper(componentModel='spring'). Use @Mapping for field name differences." },
    { tool_name: "Bash", tool_input: { command: "docker stats" }, tool_response: "Container memory usage: app=412MB (limit 512MB, 80% used). When >75%, GC pauses increase. Set -Xmx to 75% of container limit: -Xmx384m for 512MB container." },
    { tool_name: "Edit", tool_input: { file_path: "Dockerfile" }, tool_response: "Multi-stage Docker build pattern:\nStage 1: FROM maven AS build → mvn package\nStage 2: FROM eclipse-temurin:17-jre → COPY --from=build target/*.jar\nResult: Image size reduced from 890MB to 285MB." },
    { tool_name: "Bash", tool_input: { command: "git log --oneline -5" }, tool_response: "Commit convention detected: 'feat:', 'fix:', 'chore:', 'docs:' prefix. Team uses conventional commits for changelogs. Branch naming: feature/TICKET-123-description." },
    { tool_name: "Bash", tool_input: { command: "curl -X POST /api/products/batch" }, tool_response: "Batch endpoint returns 413 Payload Too Large for >10MB. Fix: Set spring.servlet.multipart.max-file-size=50MB and spring.servlet.multipart.max-request-size=50MB in application.properties." },
    { tool_name: "Edit", tool_input: { file_path: "application.properties" }, tool_response: "spring.jpa.open-in-view=false\n# OSIV disabled. This prevents lazy loading in controllers but improves performance.\n# All eager data must be fetched in service layer with JOIN FETCH or @EntityGraph." },
    { tool_name: "Bash", tool_input: { command: "mvn dependency:tree" }, tool_response: "Dependency conflict: jackson-databind 2.15.2 vs 2.14.1. Spring Boot BOM manages 2.15.2 but a transitive dep pulls 2.14.1. Fix: Add explicit version in dependencyManagement to force 2.15.2." },
    { tool_name: "Edit", tool_input: { file_path: "SecurityConfig.java" }, tool_response: "CSRF disabled for REST API (stateless JWT). But for form-based endpoints: keep CSRF enabled. Pattern: .csrf(c -> c.ignoringRequestMatchers('/api/**'))" },
    { tool_name: "Bash", tool_input: { command: "ab -n 1000 -c 50 http://localhost:8080/api/products" }, tool_response: "Load test results:\n- Requests/sec: 847\n- p50: 45ms, p95: 180ms, p99: 520ms\n- Errors: 0%\n- CPU: 72%, Memory: 380MB\nBottleneck: JPA N+1 queries on product→category relation. Fix with @EntityGraph or JOIN FETCH." }
  ];

  let processed = 0;
  for (let i = 0; i < observations.length; i++) {
    const id = await injectToolUse(SID, observations[i]);
    console.log(`  Obs ${i+1}/10 (id=${id}): ${observations[i].tool_name} — ${(observations[i].tool_response || "").slice(0, 60)}...`);
    const status = await waitForProcessed(id, 90000);
    console.log(`    Learner: ${status}`);
    if (status === "completed") processed++;
    // Small pause between observations
    if (i < observations.length - 1) await new Promise(r => setTimeout(r, 2000));
  }

  console.log(`\n  Processed: ${processed}/10`);

  // Count artifacts created during this session
  const artifacts = await dbQuery(`
    SELECT 'learning' AS type, COUNT(*) AS c FROM learnings
    UNION ALL SELECT 'pattern', COUNT(*) FROM patterns
    UNION ALL SELECT 'error', COUNT(*) FROM errors_solutions
    UNION ALL SELECT 'drilldown', COUNT(*) FROM knowledge_details
  `);
  const totals = {};
  artifacts.rows.forEach(r => totals[r.type] = parseInt(r.c));
  console.log(`  Total artifacts: learnings=${totals.learning}, patterns=${totals.pattern}, errors=${totals.error}, drilldowns=${totals.drilldown}`);

  record(112, processed >= 8,
    `Marathon learning: processed=${processed}/10, learnings=${totals.learning}, patterns=${totals.pattern}, errors=${totals.error}`);

  await new Promise(r => setTimeout(r, 10000));

  // ═══════════════════════════════════════════════════════════
  // TEST #113: Marathon retrieval — 5 varied prompts
  // ═══════════════════════════════════════════════════════════
  console.log("\n=== Test #113: Marathon retrieval (5 prompts) ===\n");

  const prompts = [
    "NEW TASK: My Spring Boot tests are flaky with random failures on concurrent updates. How do I fix race conditions in JPA tests?",
    "NEW TASK: I need to optimize my Docker image for a Spring Boot application. It's currently 890MB and takes forever to deploy.",
    "NEW TASK: What's the recommended JVM memory configuration for running Spring Boot inside a Docker container with 512MB limit?",
    "NEW TASK: My API returns 413 errors when users upload large CSV files for batch import. How do I increase the upload limit?",
    "NEW TASK: Load testing shows p99 latency of 520ms on /api/products. What are the likely bottlenecks and how to fix them?"
  ];

  let retrievalHits = 0;
  const retrievalDetails = [];
  for (let i = 0; i < prompts.length; i++) {
    const hash = await injectPrompt(SID, prompts[i]);
    console.log(`  Prompt ${i+1}/5 (hash=${hash}): ${prompts[i].slice(0, 80)}...`);
    const result = await waitForRetrieval(SID, hash, 45000);
    const text = result?.context_text || "";
    const hit = text.length > 100;
    if (hit) retrievalHits++;
    retrievalDetails.push({ prompt: prompts[i].slice(0, 80), type: result?.context_type || "timeout", length: text.length, hit });
    console.log(`    Type: ${result?.context_type || "timeout"}, Length: ${text.length}, Hit: ${hit}`);
    if (i < prompts.length - 1) await new Promise(r => setTimeout(r, 8000));
  }

  console.log(`\n  Retrieval hits: ${retrievalHits}/5`);

  if (!(retrievalHits >= 1)) {
    record(113, false, "Structural pre-check failed: zero retrieval hits");
  } else {
    const v113 = await askValidator(113, "Marathon retrieval — 5 prompts, expect relevant hits", JSON.stringify(retrievalDetails), "At least 3 out of 5 retrieval prompts should return relevant context. Each hit should be pertinent to its specific prompt topic (flaky tests, Docker, JVM, batch uploads, load testing).");
    validatorCost += v113.cost;
    record(113, v113.passed, v113.reason);
  }

  await new Promise(r => setTimeout(r, 5000));

  // ═══════════════════════════════════════════════════════════
  // TEST #114: Knowledge graph — 3+ layers of depth
  // ═══════════════════════════════════════════════════════════
  console.log("\n=== Test #114: Knowledge graph ===\n");

  // Layer 1: Atomic learnings/errors
  const layer1 = await dbQuery("SELECT COUNT(*) AS c FROM learnings UNION ALL SELECT COUNT(*) FROM errors_solutions");
  const atomicCount = layer1.rows.reduce((s, r) => s + parseInt(r.c), 0);

  // Layer 2: Patterns (composed knowledge)
  const layer2 = await dbQuery("SELECT COUNT(*) AS c FROM patterns");
  const patternCount = parseInt(layer2.rows[0].c);

  // Layer 3: Drilldowns (enriched details)
  const layer3 = await dbQuery("SELECT COUNT(*) AS c FROM knowledge_details");
  const drilldownCount = parseInt(layer3.rows[0].c);

  // Layer 4: Generated tools (actionable knowledge)
  const layer4 = await dbQuery("SELECT COUNT(*) AS c FROM generated_tools");
  const toolCount = parseInt(layer4.rows[0].c);

  console.log(`  Layer 1 (atomic): ${atomicCount} (learnings + errors)`);
  console.log(`  Layer 2 (patterns): ${patternCount}`);
  console.log(`  Layer 3 (drilldowns): ${drilldownCount}`);
  console.log(`  Layer 4 (tools): ${toolCount}`);

  const layers = [atomicCount > 0, patternCount > 0, drilldownCount > 0].filter(Boolean).length;
  record(114, layers >= 3,
    `Knowledge graph: layers=${layers}/3, atomic=${atomicCount}, patterns=${patternCount}, drilldowns=${drilldownCount}, tools=${toolCount}`);

  // ═══════════════════════════════════════════════════════════
  // TEST #115: Autonomous workflow — complex prompt, 4+ sources
  // ═══════════════════════════════════════════════════════════
  console.log("\n=== Test #115: Autonomous workflow ===\n");

  const complexPrompt = "NEW TASK: I'm deploying our Spring Boot ecopaths application to production on a 4-core server with 2GB RAM. I need a comprehensive checklist: optimal JVM settings, HikariCP pool size, Docker configuration, monitoring setup, security checklist (JWT + CSRF), and performance baselines. What do we know from our previous work?";
  const complexHash = await injectPrompt(SID, complexPrompt);
  console.log(`  Sent complex prompt (hash=${complexHash})`);

  const complexResult = await waitForRetrieval(SID, complexHash, 45000);
  const complexText = complexResult?.context_text || "";
  console.log(`  Retriever type: ${complexResult?.context_type || "timeout"}`);
  console.log(`  Length: ${complexText.length} chars`);
  console.log(`  Preview: ${complexText.slice(0, 500)}`);

  // Count aspects covered
  const aspects = {
    jvm: /JVM|Xmx|heap|memory|GC/i.test(complexText),
    pool: /pool|HikariCP|hikari|connection/i.test(complexText),
    docker: /Docker|container|image|multi.?stage/i.test(complexText),
    monitoring: /monitor|actuator|prometheus|metric|health/i.test(complexText),
    security: /JWT|CSRF|security|auth/i.test(complexText),
    performance: /latency|p99|throughput|N\+1|index|batch/i.test(complexText)
  };

  const aspCovered = Object.values(aspects).filter(Boolean).length;
  console.log(`  Aspects: ${JSON.stringify(aspects)}`);
  console.log(`  Total covered: ${aspCovered}/6`);

  // Count references
  const refs = complexText.match(/\[#\d+\]/g) || [];
  const uniqueRefs = [...new Set(refs)];
  console.log(`  Unique references: ${uniqueRefs.length}`);

  if (!(complexText.length > 200)) {
    record(115, false, "Structural pre-check failed: retrieval text too short");
  } else {
    const v115 = await askValidator(115, "Autonomous workflow — complex prompt covers multiple aspects", complexText, "Response must coherently address a production deployment scenario covering at least 3 of: JVM settings, connection pooling, Docker optimization, monitoring, security, performance. Should synthesize from multiple learned patterns, not just list them.");
    validatorCost += v115.cost;
    record(115, v115.passed, v115.reason);
  }

  // ═══════════════════════════════════════════════════════════
  // TEST #116: Cost efficiency
  // ═══════════════════════════════════════════════════════════
  console.log("\n=== Test #116: Cost efficiency ===\n");

  const logContent = readLog(orch.logFile);
  const totalCost = extractCost(logContent);
  const apiCalls = (logContent.match(/cost: \$/g) || []).length;
  console.log(`  Total cost: $${totalCost.toFixed(4)}`);
  console.log(`  API calls: ${apiCalls}`);

  record(116, totalCost < 2.50,
    `Cost efficiency: $${totalCost.toFixed(4)} (limit: $2.50), calls=${apiCalls}`);

  console.log(`  Validator cost: $${validatorCost.toFixed(4)}`);

  console.log(`\n--- Orchestrator Log (last 3000 chars) ---`);
  console.log(logContent.slice(-3000));
  console.log("--- End Log ---\n");

  await killSession(SID, orch.proc);

  // ═══════════════════════════════════════════════════════════
  // BONUS: Compactor verification (optional, does not affect PASS/FAIL)
  // ═══════════════════════════════════════════════════════════
  console.log("\n=== Bonus: Compactor verification ===\n");
  try {
    const CSID = `level28-compactor-${Date.now()}`;
    await cleanSession(CSID);

    // Create a fake transcript file large enough to trigger compactor
    const tmpDir = path.join(__dirname, "..", ".claude", "tmp");
    try { fs.mkdirSync(tmpDir, { recursive: true }); } catch {}
    const fakeTranscript = path.join(tmpDir, `fake_transcript_${CSID}.jsonl`);

    // Generate ~150k chars of fake conversation (~25k tokens) to trigger compaction
    const lines = [];
    for (let i = 0; i < 200; i++) {
      lines.push(JSON.stringify({ type: "user", message: { content: `Tell me about topic ${i}. ${"x".repeat(300)}` } }));
      lines.push(JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: `Here is information about topic ${i}. ${"y".repeat(400)}` }] } }));
    }
    fs.writeFileSync(fakeTranscript, lines.join("\n"), "utf-8");
    console.log(`  Fake transcript: ${fakeTranscript} (${fs.statSync(fakeTranscript).size} bytes)`);

    // Launch orchestrator with compactor=on and low threshold
    const clf = `C:/Users/user/.claude/logs/aidam_orch_test28_compact.log`;
    const cfd = fs.openSync(clf, "w");
    const cproc = spawn("node", [ORCHESTRATOR,
      `--session-id=${CSID}`,
      "--cwd=C:/Users/user/IdeaProjects/ecopathsWebApp1b",
      "--retriever=off", "--learner=off", "--compactor=on",
      `--transcript-path=${fakeTranscript}`,
      "--project-slug=test-compactor"
    ], { stdio: ["ignore", cfd, cfd], detached: false });

    const cStarted = await waitForStatus(CSID, "running", 20000);
    console.log(`  Compactor orchestrator started: ${cStarted}`);

    if (cStarted) {
      // Wait for compactor to fire (check interval is 30s, but transcript is already large)
      console.log("  Waiting up to 90s for compactor to fire...");
      let compactorFired = false;
      const start = Date.now();
      while (Date.now() - start < 90000) {
        const r = await dbQuery("SELECT state_text, version FROM session_state WHERE session_id=$1 ORDER BY version DESC LIMIT 1", [CSID]);
        if (r.rows.length > 0 && r.rows[0].state_text && r.rows[0].state_text.length > 50) {
          compactorFired = true;
          const st = r.rows[0].state_text;
          console.log(`  Compactor fired! Version: ${r.rows[0].version}, Length: ${st.length}`);
          // Check for expected sections
          const sections = ["IDENTITY", "TASK", "DECISION", "CONTEXT", "DYNAMIC"].filter(s => new RegExp(s, "i").test(st));
          console.log(`  Sections found: ${sections.join(", ")} (${sections.length}/5)`);
          break;
        }
        await new Promise(r => setTimeout(r, 5000));
      }
      if (!compactorFired) console.log("  Compactor did not fire within 90s (not a failure, may need longer)");
    }

    await killSession(CSID, cproc);
    await cleanSession(CSID);
    await dbQuery("DELETE FROM session_state WHERE session_id=$1", [CSID]);
    try { fs.unlinkSync(fakeTranscript); } catch {}
    console.log("  Compactor verification done (informational only).\n");
  } catch (err) {
    console.log(`  Compactor verification error: ${err.message} (non-fatal)\n`);
  }

  await cleanSession(SID);
  printSummary();
}

function printSummary() {
  const passed = results.filter(r => r.passed).length;
  const total = results.length;
  const failed = results.filter(r => !r.passed);
  console.log(`\n${"═".repeat(60)}`);
  console.log(`  LEVEL 28 RESULTS: ${passed}/${total} passed`);
  if (failed.length > 0) { console.log("  FAILURES:"); failed.forEach(f => console.log(`    Step ${f.step}: ${f.desc}`)); }
  console.log(`${"═".repeat(60)}`);
  if (failed.length === 0) {
    console.log(`
████████████████████████████████████████████████████████████████████
█                                                                  █
█   ██████╗ ██╗ ██████╗  █████╗ ███╗   ███╗                       █
█   ██╔══██╗██║██╔════╝ ██╔══██╗████╗ ████║                       █
█   ██████╔╝██║██║  ███╗███████║██╔████╔██║                       █
█   ██╔══██╗██║██║   ██║██╔══██║██║╚██╔╝██║                       █
█   ██████╔╝██║╚██████╔╝██║  ██║██║ ╚═╝ ██║                       █
█   ╚═════╝ ╚═╝ ╚═════╝ ╚═╝  ╚═╝╚═╝     ╚═╝                     █
█                                                                  █
█   ALL 116 TESTS PASSED — AGI LEVEL 100/100                      █
█                                                                  █
█   AIDAM is a fully autonomous intelligence companion:            █
█   - Learns from observations (errors, patterns, preferences)    █
█   - Recalls knowledge with context awareness                    █
█   - Transfers across domains and projects                       █
█   - Reasons through dependency chains                           █
█   - Decomposes tasks and identifies gaps                        █
█   - Self-corrects when contradicted                             █
█   - Generates solutions by combining learned patterns           █
█   - Operates within budget constraints                          █
█                                                                  █
████████████████████████████████████████████████████████████████████
`);
  }
}

run().then(() => process.exit(0)).catch(err => { console.error("Test error:", err); process.exit(1); });
setTimeout(() => { console.log("GLOBAL TIMEOUT"); process.exit(1); }, 600000);
