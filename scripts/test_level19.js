/**
 * AIDAM Level 19 — Cross-Domain Transfer ("Je transfère")
 *
 * #76: Pattern in domain A — Learner sees rate limiter in Spring (bucket4j)
 * #77: Transfer to domain B — Retriever surfaces Spring pattern for Express API question
 * #78: Error transfer — CORS fix from Spring → applied to React+Express question
 * #79: Architecture transfer — Java layered architecture → Python Flask question
 *
 * AGI Level: 89/100
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

async function waitForStatus(sid, pattern, timeoutMs = 25000) {
  const regex = new RegExp(pattern, "i");
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const r = await dbQuery("SELECT status FROM orchestrator_state WHERE session_id=$1", [sid]);
    if (r.rows.length > 0 && regex.test(r.rows[0].status)) return true;
    await new Promise(r => setTimeout(r, 1000));
  }
  return false;
}

function launchOrchestrator(sid, opts = {}) {
  const logFile = `C:/Users/user/.claude/logs/aidam_orch_test19_${sid.slice(-8)}.log`;
  const args = [
    ORCHESTRATOR, `--session-id=${sid}`,
    "--cwd=C:/Users/user/IdeaProjects/ecopathsWebApp1b",
    `--retriever=${opts.retriever || "on"}`, `--learner=${opts.learner || "on"}`,
    "--compactor=off", "--project-slug=ecopaths",
  ];
  const fd = fs.openSync(logFile, "w");
  const p = spawn("node", args, { stdio: ["ignore", fd, fd], detached: false });
  let exited = false;
  p.on("exit", () => { exited = true; });
  return { proc: p, logFile, isExited: () => exited };
}

async function killSession(sid, proc) {
  try { await dbQuery("UPDATE orchestrator_state SET status='stopping' WHERE session_id=$1", [sid]); } catch {}
  await new Promise(r => setTimeout(r, 4000));
  try { proc.kill(); } catch {}
  await new Promise(r => setTimeout(r, 1000));
}

async function cleanSession(sid) {
  await dbQuery("DELETE FROM orchestrator_state WHERE session_id=$1", [sid]);
  await dbQuery("DELETE FROM cognitive_inbox WHERE session_id=$1", [sid]);
  await dbQuery("DELETE FROM retrieval_inbox WHERE session_id=$1", [sid]);
}

async function injectToolUse(sid, payload) {
  const r = await dbQuery(
    "INSERT INTO cognitive_inbox (session_id, message_type, payload, status) VALUES ($1, 'tool_use', $2, 'pending') RETURNING id",
    [sid, JSON.stringify(payload)]
  );
  return r.rows[0].id;
}

async function injectPrompt(sid, prompt) {
  const hash = crypto.createHash("sha256").update(prompt).digest("hex").slice(0, 16);
  await dbQuery(
    "INSERT INTO cognitive_inbox (session_id, message_type, payload, status) VALUES ($1, 'prompt_context', $2, 'pending')",
    [sid, JSON.stringify({ prompt, prompt_hash: hash, timestamp: Date.now() })]
  );
  return hash;
}

async function waitForProcessed(msgId, timeoutMs = 90000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const r = await dbQuery("SELECT status FROM cognitive_inbox WHERE id=$1", [msgId]);
    if (r.rows.length > 0 && /completed|failed/.test(r.rows[0].status)) return r.rows[0].status;
    await new Promise(r => setTimeout(r, 2000));
  }
  return "timeout";
}

async function waitForRetrieval(sid, hash, timeoutMs = 35000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const r = await dbQuery(
      "SELECT context_type, context_text FROM retrieval_inbox WHERE session_id=$1 AND prompt_hash=$2 ORDER BY id DESC LIMIT 1",
      [sid, hash]
    );
    if (r.rows.length > 0) return r.rows[0];
    await new Promise(r => setTimeout(r, 1000));
  }
  return null;
}

function readLog(f) { try { return fs.readFileSync(f, "utf-8"); } catch { return ""; } }
function extractCost(log) {
  return (log.match(/cost: \$([0-9.]+)/g) || []).reduce((s, m) => s + parseFloat(m.replace("cost: $", "")), 0);
}

async function run() {
  const SID = `level19-${Date.now()}`;
  console.log(`\n${"═".repeat(60)}`);
  console.log(`  AIDAM Level 19: Cross-Domain Transfer ("Je transfère")`);
  console.log(`${"═".repeat(60)}`);
  let validatorCost = 0;
  console.log(`Session ID: ${SID}\n`);

  await cleanSession(SID);

  console.log("Launching orchestrator (Retriever + Learner)...");
  const orch = launchOrchestrator(SID);
  const started = await waitForStatus(SID, "running", 25000);
  console.log(`Orchestrator started: ${started}`);
  if (!started) { for (let i = 76; i <= 79; i++) record(i, false, "No start"); printSummary(); return; }
  console.log("Waiting for agents to initialize...\n");
  await new Promise(r => setTimeout(r, 12000));

  // Warm-up
  const wh = await injectPrompt(SID, "What patterns do we have in memory about web application development?");
  await waitForRetrieval(SID, wh, 30000);
  console.log("Warm-up complete.\n");

  // ═══════════════════════════════════════════════════════════
  // TEST #76: Pattern in domain A (Spring Boot)
  // ═══════════════════════════════════════════════════════════
  console.log("=== Test #76: Pattern in domain A (Spring rate limiter) ===\n");

  const rateObs = await injectToolUse(SID, {
    tool_name: "Edit",
    tool_input: {
      file_path: "src/main/java/com/ecopaths/config/RateLimitConfig.java",
      old_string: "// TODO: add rate limiting",
      new_string: `@Bean
    public RateLimiter rateLimiter() {
        // Bucket4j rate limiter: 100 requests per minute per IP
        return RateLimiter.builder()
            .bandwidth(Bandwidth.classic(100, Refill.intervally(100, Duration.ofMinutes(1))))
            .build();
    }

    @Bean
    public FilterRegistrationBean<RateLimitFilter> rateLimitFilter() {
        // Apply to all /api/** endpoints
        FilterRegistrationBean<RateLimitFilter> bean = new FilterRegistrationBean<>();
        bean.setFilter(new RateLimitFilter(rateLimiter()));
        bean.addUrlPatterns("/api/*");
        bean.setOrder(1); // Before auth filter
        return bean;
    }`
    },
    tool_response: `Rate limiting configured with Bucket4j:\n- 100 requests/minute per IP address\n- Applied as a servlet filter on /api/* endpoints\n- Filter order=1 (before authentication)\n- Token bucket algorithm: refills 100 tokens every minute\n- Returns HTTP 429 Too Many Requests when exceeded\n\nKey decisions:\n- IP-based (not user-based) to protect against unauthenticated abuse\n- 100/min is generous for our use case (mostly internal/B2B)\n- Filter-based approach (not interceptor) for performance`
  });
  console.log(`  Rate limiter observation (id=${rateObs})`);
  const sRate = await waitForProcessed(rateObs, 90000);
  console.log(`  Learner processed: ${sRate}`);

  await new Promise(r => setTimeout(r, 3000));

  const ratePatterns = await dbQuery(
    "SELECT id, name FROM patterns WHERE name ILIKE '%rate%limit%' OR solution ILIKE '%rate%limit%' OR solution ILIKE '%bucket4j%' OR solution ILIKE '%429%' ORDER BY id DESC LIMIT 5"
  );
  const rateLearnings = await dbQuery(
    "SELECT id, topic FROM learnings WHERE topic ILIKE '%rate%limit%' OR insight ILIKE '%rate%limit%' OR insight ILIKE '%bucket4j%' ORDER BY id DESC LIMIT 5"
  );

  console.log(`  Rate limit patterns: ${ratePatterns.rows.length}`);
  ratePatterns.rows.forEach(p => console.log(`    [#${p.id}] ${p.name}`));
  console.log(`  Rate limit learnings: ${rateLearnings.rows.length}`);

  const rateSaved = ratePatterns.rows.length > 0 || rateLearnings.rows.length > 0;
  if (rateSaved) {
    const v76 = await askValidator(76, "System has rate-limiting knowledge stored", { ratePatterns: ratePatterns.rows }, "At least one pattern should be about rate limiting, API throttling, or Bucket4j. The pattern name should clearly indicate it's about rate limiting or request throttling.");
    validatorCost += v76.cost;
    record(76, v76.passed, `${v76.reason}`);
  } else {
    record(76, false, `Structural pre-check failed: patterns=${ratePatterns.rows.length}, learnings=${rateLearnings.rows.length}`);
  }

  await new Promise(r => setTimeout(r, 3000));

  // ═══════════════════════════════════════════════════════════
  // TEST #77: Transfer to domain B (Express)
  // ═══════════════════════════════════════════════════════════
  console.log("\n=== Test #77: Transfer to domain B (Express rate limiting) ===\n");

  const transferPrompt = "I'm building a new Express.js API and need to add rate limiting — 100 requests per minute per IP. What approach should I use? Any lessons from our previous implementations?";
  const transferHash = await injectPrompt(SID, transferPrompt);
  console.log(`  Sent transfer prompt (hash=${transferHash})`);

  const transferResult = await waitForRetrieval(SID, transferHash, 35000);
  const transferText = transferResult?.context_text || "";
  console.log(`  Retriever type: ${transferResult?.context_type || "timeout"}`);
  console.log(`  Length: ${transferText.length} chars`);
  console.log(`  Preview: ${transferText.slice(0, 400)}`);

  // The Retriever should surface the Spring rate limiter pattern even though we asked about Express
  const mentionsRateLimit = /rate.?limit|bucket|429|too many/i.test(transferText);
  const mentionsApproach = /filter|middleware|token.?bucket|per.?ip/i.test(transferText);

  console.log(`  Mentions rate limiting: ${mentionsRateLimit}`);
  console.log(`  Mentions approach: ${mentionsApproach}`);

  record(77, transferText.length > 50 && mentionsRateLimit,
    `Cross-domain transfer: rate_limit=${mentionsRateLimit}, approach=${mentionsApproach}, length=${transferText.length}`);

  await new Promise(r => setTimeout(r, 3000));

  // ═══════════════════════════════════════════════════════════
  // TEST #78: Error transfer (CORS)
  // CORS error saved from Spring, asked about in React+Express context
  // ═══════════════════════════════════════════════════════════
  console.log("\n=== Test #78: Error transfer (CORS) ===\n");

  // First: inject a CORS error and fix in Spring context
  const corsObs = await injectToolUse(SID, {
    tool_name: "Bash",
    tool_input: { command: 'curl -H "Origin: http://localhost:3000" http://localhost:8080/api/users' },
    tool_response: `Access to XMLHttpRequest at 'http://localhost:8080/api/users' from origin 'http://localhost:3000' has been blocked by CORS policy: No 'Access-Control-Allow-Origin' header is present.\n\nFix applied in Spring Boot WebMvcConfigurer:\n@Override\npublic void addCorsMappings(CorsRegistry registry) {\n    registry.addMapping("/api/**")\n        .allowedOrigins("http://localhost:3000", "https://ecopaths.eco-paths.com")\n        .allowedMethods("GET", "POST", "PUT", "DELETE")\n        .allowCredentials(true);\n}\nKey: Must list specific origins (not "*") when allowCredentials=true.`
  });
  console.log(`  CORS error observation (id=${corsObs})`);
  const sCors = await waitForProcessed(corsObs, 90000);
  console.log(`  Learner processed: ${sCors}`);

  await new Promise(r => setTimeout(r, 3000));

  // Now ask about CORS in a DIFFERENT context (React + Express)
  const corsPrompt = "I'm getting CORS errors in my new React frontend calling an Express backend. The React app runs on port 3000 and Express on 4000. How do I fix it?";
  const corsHash = await injectPrompt(SID, corsPrompt);
  console.log(`  Sent CORS transfer prompt (hash=${corsHash})`);

  const corsResult = await waitForRetrieval(SID, corsHash, 35000);
  const corsText = corsResult?.context_text || "";
  console.log(`  Retriever type: ${corsResult?.context_type || "timeout"}`);
  console.log(`  Length: ${corsText.length} chars`);
  console.log(`  Preview: ${corsText.slice(0, 400)}`);

  const mentionsCors = /CORS|cors|Access-Control/i.test(corsText);
  const mentionsOrigin = /origin|allowedOrigin|allow.*origin/i.test(corsText);
  const mentionsCredentials = /credentials|allowCredentials/i.test(corsText);

  console.log(`  Mentions CORS: ${mentionsCors}`);
  console.log(`  Mentions origin: ${mentionsOrigin}`);
  console.log(`  Mentions credentials: ${mentionsCredentials}`);

  const preCheck78 = corsText.length > 50 && mentionsCors;
  if (preCheck78) {
    const v78 = await askValidator(78, "Retriever recalls CORS/security configuration knowledge", corsText, "The retrieval should contain CORS configuration, security headers, or Spring Security cross-origin setup details. Should include code snippets or concrete configuration, not just generic advice.");
    validatorCost += v78.cost;
    record(78, v78.passed, `${v78.reason}`);
  } else {
    record(78, false, `Structural pre-check failed: cors=${mentionsCors}, length=${corsText.length}`);
  }

  await new Promise(r => setTimeout(r, 3000));

  // ═══════════════════════════════════════════════════════════
  // TEST #79: Architecture transfer
  // Java Repository+Service+Controller → Python Flask question
  // ═══════════════════════════════════════════════════════════
  console.log("\n=== Test #79: Architecture transfer ===\n");

  const archPrompt = "I'm starting a new Python Flask REST API project. Based on our experience with the ecopaths Java project, what layered architecture should I follow? We used Repository+Service+Controller in Java.";
  const archHash = await injectPrompt(SID, archPrompt);
  console.log(`  Sent architecture transfer prompt (hash=${archHash})`);

  const archResult = await waitForRetrieval(SID, archHash, 35000);
  const archText = archResult?.context_text || "";
  console.log(`  Retriever type: ${archResult?.context_type || "timeout"}`);
  console.log(`  Length: ${archText.length} chars`);
  console.log(`  Preview: ${archText.slice(0, 400)}`);

  // Should mention layered architecture concepts from ecopaths
  const mentionsLayers = /service|controller|repository|layer/i.test(archText);
  const mentionsProject = /ecopath/i.test(archText);
  const mentionsArch = /architecture|pattern|structure/i.test(archText);

  console.log(`  Mentions layers: ${mentionsLayers}`);
  console.log(`  Mentions ecopaths: ${mentionsProject}`);
  console.log(`  Mentions architecture: ${mentionsArch}`);

  record(79, archText.length > 50 && (mentionsLayers || mentionsArch),
    `Architecture transfer: layers=${mentionsLayers}, project=${mentionsProject}, arch=${mentionsArch}, length=${archText.length}`);

  // ═══════════════════════════════════════════════════════════
  // Cost
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

  await killSession(SID, orch.proc);
  await cleanSession(SID);
  console.log(`  Validator cost: $${validatorCost.toFixed(4)}`);
  printSummary();
}

function printSummary() {
  const passed = results.filter(r => r.passed).length;
  const total = results.length;
  const failed = results.filter(r => !r.passed);
  console.log(`\n${"═".repeat(60)}`);
  console.log(`  LEVEL 19 RESULTS: ${passed}/${total} passed`);
  if (failed.length > 0) {
    console.log("  FAILURES:");
    failed.forEach(f => console.log(`    Step ${f.step}: ${f.desc}`));
  }
  console.log(`${"═".repeat(60)}`);
  if (failed.length === 0) {
    console.log(`\n████████████████████████████████████████████████████████████
█                                                          █
█   ALL LEVEL 19 TESTS PASSED — CROSS-DOMAIN TRANSFER!   █
█                                                          █
█   AIDAM transfers knowledge across frameworks and        █
█   languages: Spring→Express, Java→Python, CORS fixes    █
█   that work regardless of the tech stack.                █
█                                                          █
████████████████████████████████████████████████████████████\n`);
  }
}

run().then(() => process.exit(0)).catch(err => { console.error("Test error:", err); process.exit(1); });
setTimeout(() => { console.log("GLOBAL TIMEOUT"); process.exit(1); }, 600000);
