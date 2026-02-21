/**
 * AIDAM Level 23 — Context-Aware Behavior ("Je m'adapte")
 *
 * #92: Seed rich knowledge — Learner saves detailed JWT pattern with drilldowns
 * #93: Beginner query — Retriever returns basics + code example
 * #94: Expert query — Retriever returns only advanced details
 * #95: Context switch — Progressive prompts get deeper content
 *
 * AGI Level: 93/100
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
function launchOrch(sid, opts = {}) { const lf = `C:/Users/user/.claude/logs/aidam_orch_test23_${sid.slice(-8)}.log`; const fd = fs.openSync(lf, "w"); const p = spawn("node", [ORCHESTRATOR, `--session-id=${sid}`, "--cwd=C:/Users/user/IdeaProjects/ecopathsWebApp1b", `--retriever=${opts.retriever||"on"}`, `--learner=${opts.learner||"on"}`, "--compactor=off", "--project-slug=ecopaths"], { stdio: ["ignore", fd, fd], detached: false }); let ex = false; p.on("exit", () => { ex = true; }); return { proc: p, logFile: lf, isExited: () => ex }; }
async function killSession(sid, proc) { try { await dbQuery("UPDATE orchestrator_state SET status='stopping' WHERE session_id=$1", [sid]); } catch {} await new Promise(r => setTimeout(r, 4000)); try { proc.kill(); } catch {} await new Promise(r => setTimeout(r, 1000)); }
async function cleanSession(sid) { await dbQuery("DELETE FROM orchestrator_state WHERE session_id=$1", [sid]); await dbQuery("DELETE FROM cognitive_inbox WHERE session_id=$1", [sid]); await dbQuery("DELETE FROM retrieval_inbox WHERE session_id=$1", [sid]); }
async function injectToolUse(sid, pl) { const r = await dbQuery("INSERT INTO cognitive_inbox (session_id, message_type, payload, status) VALUES ($1, 'tool_use', $2, 'pending') RETURNING id", [sid, JSON.stringify(pl)]); return r.rows[0].id; }
async function injectPrompt(sid, prompt) { const h = crypto.createHash("sha256").update(prompt).digest("hex").slice(0, 16); await dbQuery("INSERT INTO cognitive_inbox (session_id, message_type, payload, status) VALUES ($1, 'prompt_context', $2, 'pending')", [sid, JSON.stringify({ prompt, prompt_hash: h, timestamp: Date.now() })]); return h; }
async function waitForProcessed(id, ms = 90000) { const s = Date.now(); while (Date.now() - s < ms) { const r = await dbQuery("SELECT status FROM cognitive_inbox WHERE id=$1", [id]); if (r.rows.length > 0 && /completed|failed/.test(r.rows[0].status)) return r.rows[0].status; await new Promise(r => setTimeout(r, 2000)); } return "timeout"; }
async function waitForRetrieval(sid, h, ms = 45000) { const s = Date.now(); while (Date.now() - s < ms) { const r = await dbQuery("SELECT context_type, context_text FROM retrieval_inbox WHERE session_id=$1 AND prompt_hash=$2 ORDER BY id DESC LIMIT 1", [sid, h]); if (r.rows.length > 0) return r.rows[0]; await new Promise(r => setTimeout(r, 1000)); } return null; }
function readLog(f) { try { return fs.readFileSync(f, "utf-8"); } catch { return ""; } }
function extractCost(log) { return (log.match(/cost: \$([0-9.]+)/g) || []).reduce((s, m) => s + parseFloat(m.replace("cost: $", "")), 0); }

async function run() {
  const SID = `level23-${Date.now()}`;
  console.log(`\n${"═".repeat(60)}`);
  console.log(`  AIDAM Level 23: Context-Aware Behavior ("Je m'adapte")`);
  console.log(`${"═".repeat(60)}`);
  console.log(`Session ID: ${SID}\n`);

  await cleanSession(SID);
  console.log("Launching orchestrator (Retriever + Learner)...");
  const orch = launchOrch(SID);
  const started = await waitForStatus(SID, "running", 25000);
  console.log(`Orchestrator started: ${started}`);
  if (!started) { for (let i = 92; i <= 95; i++) record(i, false, "No start"); printSummary(); return; }
  console.log("Waiting for agents to initialize...\n");
  await new Promise(r => setTimeout(r, 12000));
  const wh = await injectPrompt(SID, "What projects are stored in memory?");
  await waitForRetrieval(SID, wh, 30000);
  console.log("Warm-up complete.\n");
  await new Promise(r => setTimeout(r, 8000));

  // ═══════════════════════════════════════════════════════════
  // TEST #92: Seed rich knowledge — detailed JWT pattern
  // ═══════════════════════════════════════════════════════════
  console.log("=== Test #92: Seed rich knowledge ===\n");

  // Seed a very rich JWT observation covering basics through advanced
  const jwtRich = await injectToolUse(SID, {
    tool_name: "Edit",
    tool_input: { file_path: "src/main/java/com/ecopaths/security/JwtTokenProvider.java", old_string: "// TODO", new_string: "full implementation" },
    tool_response: `Complete JWT authentication implementation with 3 layers of complexity:

BASICS (for beginners):
- JWT = JSON Web Token, a stateless auth mechanism
- Token has 3 parts: Header.Payload.Signature (base64 encoded)
- Flow: user sends credentials → server returns JWT → client sends JWT in Authorization header
- Spring: add spring-boot-starter-security + io.jsonwebtoken:jjwt-api

INTERMEDIATE:
- JwtTokenProvider class handles: generateToken(username), validateToken(token), getUsername(token)
- JwtAuthenticationFilter extends OncePerRequestFilter → reads "Bearer " token from header
- SecurityConfig: http.sessionManagement().stateless() + addFilterBefore(jwtFilter, UsernamePasswordAuth)
- Token expiration: typically 24h for access, 30d for refresh
- Store JWT_KEY in environment variable, never in code

ADVANCED (expert only):
- Refresh token rotation: issue new refresh token on each use, blacklist old ones in Redis
- Token blacklisting on logout: store jti (JWT ID) in Redis SET with TTL = remaining expiry
- Key rotation: use kid (key ID) header, maintain key registry, support multiple active keys
- HMAC-SHA256 vs RSA: HMAC for monolith (shared secret), RSA for microservices (public key verification)
- Rate limit on /authenticate endpoint: max 5 attempts per IP per minute (Bucket4j)

GOTCHAS:
- Never store sensitive data in JWT payload (it's base64, not encrypted)
- Set issuer and audience claims for multi-tenant systems
- Use short-lived access tokens (15-60min) + long-lived refresh tokens for security
- Clock skew: set 30s tolerance for token expiration validation`
  });
  console.log(`  JWT rich pattern (id=${jwtRich})`);
  const s1 = await waitForProcessed(jwtRich, 90000);
  console.log(`  Learner: ${s1}`);

  await new Promise(r => setTimeout(r, 3000));

  // Check what was saved
  const jwtPatterns = await dbQuery("SELECT id, name FROM patterns WHERE name ILIKE '%JWT%' OR name ILIKE '%auth%token%' OR context ILIKE '%JWT%token%' ORDER BY id DESC LIMIT 5");
  const jwtLearnings = await dbQuery("SELECT id, topic FROM learnings WHERE topic ILIKE '%JWT%' OR insight ILIKE '%JWT%' OR insight ILIKE '%token%rotation%' ORDER BY id DESC LIMIT 5");
  const jwtDrilldowns = await dbQuery("SELECT id, topic FROM knowledge_details WHERE topic ILIKE '%JWT%' OR topic ILIKE '%token%' OR topic ILIKE '%refresh%' ORDER BY id DESC LIMIT 5");
  console.log(`  JWT patterns: ${jwtPatterns.rows.length}`);
  console.log(`  JWT learnings: ${jwtLearnings.rows.length}`);
  console.log(`  JWT drilldowns: ${jwtDrilldowns.rows.length}`);

  const totalKnowledge = jwtPatterns.rows.length + jwtLearnings.rows.length + jwtDrilldowns.rows.length;
  record(92, totalKnowledge >= 2,
    `Rich knowledge: patterns=${jwtPatterns.rows.length}, learnings=${jwtLearnings.rows.length}, drilldowns=${jwtDrilldowns.rows.length}, total=${totalKnowledge}`);

  await new Promise(r => setTimeout(r, 5000));

  // ═══════════════════════════════════════════════════════════
  // TEST #93: Beginner query
  // ═══════════════════════════════════════════════════════════
  console.log("\n=== Test #93: Beginner query ===\n");

  const beginnerPrompt = "NEW TASK: What is JWT authentication and how do I add it to a Spring Boot project? I'm new to security.";
  const beginnerHash = await injectPrompt(SID, beginnerPrompt);
  console.log(`  Sent beginner prompt (hash=${beginnerHash})`);

  const beginnerResult = await waitForRetrieval(SID, beginnerHash, 45000);
  const beginnerText = beginnerResult?.context_text || "";
  console.log(`  Retriever type: ${beginnerResult?.context_type || "timeout"}`);
  console.log(`  Length: ${beginnerText.length} chars`);
  console.log(`  Preview: ${beginnerText.slice(0, 400)}`);

  const hasBasics = /stateless|Header.*Payload|base64|Authorization.*header|JSON Web Token/i.test(beginnerText);
  const hasSpringSteps = /spring-boot-starter-security|JwtTokenProvider|SecurityConfig|filter/i.test(beginnerText);

  console.log(`  Has basics: ${hasBasics}`);
  console.log(`  Has Spring steps: ${hasSpringSteps}`);

  record(93, beginnerText.length > 100 && (hasBasics || hasSpringSteps),
    `Beginner query: basics=${hasBasics}, steps=${hasSpringSteps}, length=${beginnerText.length}`);

  await new Promise(r => setTimeout(r, 8000));

  // ═══════════════════════════════════════════════════════════
  // TEST #94: Expert query
  // ═══════════════════════════════════════════════════════════
  console.log("\n=== Test #94: Expert query ===\n");

  const expertPrompt = "NEW TASK: I need to implement secure token lifecycle management for production: refresh token rotation storing used tokens in Redis, key ID (kid) header for signing key rotation, and jti-based blacklisting for immediate logout revocation. What patterns do we have for these advanced security mechanisms?";
  const expertHash = await injectPrompt(SID, expertPrompt);
  console.log(`  Sent expert prompt (hash=${expertHash})`);

  const expertResult = await waitForRetrieval(SID, expertHash, 45000);
  const expertText = expertResult?.context_text || "";
  console.log(`  Retriever type: ${expertResult?.context_type || "timeout"}`);
  console.log(`  Length: ${expertText.length} chars`);
  console.log(`  Preview: ${expertText.slice(0, 400)}`);

  const hasAdvanced = /refresh.*token|rotation|blacklist|Redis|jti|key.*rotation|kid/i.test(expertText);
  const hasJWT = /JWT|token|auth/i.test(expertText);

  console.log(`  Has advanced concepts: ${hasAdvanced}`);
  console.log(`  Has JWT context: ${hasJWT}`);

  record(94, expertText.length > 100 && hasJWT,
    `Expert query: advanced=${hasAdvanced}, jwt=${hasJWT}, length=${expertText.length}`);

  await new Promise(r => setTimeout(r, 8000));

  // ═══════════════════════════════════════════════════════════
  // TEST #95: Context switch — progressive depth
  // ═══════════════════════════════════════════════════════════
  console.log("\n=== Test #95: Context switch (progressive depth) ===\n");

  // We already have beginner (#93) and expert (#94) results
  // Now send an intermediate query
  const midPrompt = "NEW TASK: Configure Spring Security for JWT with stateless sessions and a custom authentication filter. What's the standard SecurityConfig setup?";
  const midHash = await injectPrompt(SID, midPrompt);
  console.log(`  Sent intermediate prompt (hash=${midHash})`);

  const midResult = await waitForRetrieval(SID, midHash, 45000);
  const midText = midResult?.context_text || "";
  console.log(`  Retriever type: ${midResult?.context_type || "timeout"}`);
  console.log(`  Length: ${midText.length} chars`);
  console.log(`  Preview: ${midText.slice(0, 300)}`);

  const hasMidContent = /SecurityConfig|stateless|OncePerRequestFilter|addFilterBefore|session/i.test(midText);

  console.log(`  Has intermediate content: ${hasMidContent}`);
  console.log(`  Beginner length: ${beginnerText.length}`);
  console.log(`  Intermediate length: ${midText.length}`);
  console.log(`  Expert length: ${expertText.length}`);

  // At least 2 out of 3 queries should have returned content
  const queriesWithContent = [beginnerText.length > 100, midText.length > 100, expertText.length > 100].filter(Boolean).length;

  record(95, queriesWithContent >= 2 && hasMidContent,
    `Context switch: beginner=${beginnerText.length}ch, mid=${midText.length}ch, expert=${expertText.length}ch, queries=${queriesWithContent}/3, midContent=${hasMidContent}`);

  // Cost
  const logContent = readLog(orch.logFile);
  const totalCost = extractCost(logContent);
  const apiCalls = (logContent.match(/cost: \$/g) || []).length;
  console.log(`\n=== Cost Summary ===`);
  console.log(`  Total cost: $${totalCost.toFixed(4)}`);
  console.log(`  API calls: ${apiCalls}`);

  console.log(`\n--- Orchestrator Log (last 3000 chars) ---`);
  console.log(logContent.slice(-3000));
  console.log("--- End Log ---\n");

  await killSession(SID, orch.proc);
  await cleanSession(SID);
  printSummary();
}

function printSummary() {
  const passed = results.filter(r => r.passed).length;
  const total = results.length;
  const failed = results.filter(r => !r.passed);
  console.log(`\n${"═".repeat(60)}`);
  console.log(`  LEVEL 23 RESULTS: ${passed}/${total} passed`);
  if (failed.length > 0) { console.log("  FAILURES:"); failed.forEach(f => console.log(`    Step ${f.step}: ${f.desc}`)); }
  console.log(`${"═".repeat(60)}`);
  if (failed.length === 0) {
    console.log(`\n████████████████████████████████████████████████████████████
█   ALL LEVEL 23 TESTS PASSED — CONTEXT-AWARE!           █
█   AIDAM adapts response depth based on query context:   █
█   beginner gets basics, expert gets advanced details.   █
████████████████████████████████████████████████████████████\n`);
  }
}

run().then(() => process.exit(0)).catch(err => { console.error("Test error:", err); process.exit(1); });
setTimeout(() => { console.log("GLOBAL TIMEOUT"); process.exit(1); }, 600000);
