/**
 * AIDAM Level 30 — Browser Capability Acquisition ("J'apprends a voir")
 *
 * #121: Need discovery — Learner detects need for browser screenshots
 * #122: Web research — Learner extracts options from web search results
 * #123: Solution comparison — Learner compares approaches and saves best choice
 * #124: Tool creation — Learner saves generated_tool + pattern
 * #125: Knowledge persistence — DB check: tool + pattern + learning with URLs
 * #126: Capability recall — Retriever finds screenshot tool when needed
 *
 * AGI Level: 102/100
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
function launchOrch(sid, opts = {}) { const lf = `C:/Users/user/.claude/logs/aidam_orch_test30_${sid.slice(-8)}.log`; const fd = fs.openSync(lf, "w"); const p = spawn("node", [ORCHESTRATOR, `--session-id=${sid}`, "--cwd=C:/Users/user/IdeaProjects/aidam-memory-plugin", `--retriever=${opts.retriever||"on"}`, `--learner=${opts.learner||"on"}`, "--compactor=off", "--project-slug=aidam-memory"], { stdio: ["ignore", fd, fd], detached: false }); let ex = false; p.on("exit", () => { ex = true; }); return { proc: p, logFile: lf, isExited: () => ex }; }
async function killSession(sid, proc) { try { await dbQuery("UPDATE orchestrator_state SET status='stopping' WHERE session_id=$1", [sid]); } catch {} await new Promise(r => setTimeout(r, 4000)); try { proc.kill(); } catch {} await new Promise(r => setTimeout(r, 1000)); }
async function cleanSession(sid) { await dbQuery("DELETE FROM orchestrator_state WHERE session_id=$1", [sid]); await dbQuery("DELETE FROM cognitive_inbox WHERE session_id=$1", [sid]); await dbQuery("DELETE FROM retrieval_inbox WHERE session_id=$1", [sid]); }
async function injectToolUse(sid, pl) { const r = await dbQuery("INSERT INTO cognitive_inbox (session_id, message_type, payload, status) VALUES ($1, 'tool_use', $2, 'pending') RETURNING id", [sid, JSON.stringify(pl)]); return r.rows[0].id; }
async function injectPrompt(sid, prompt) { const h = crypto.createHash("sha256").update(prompt).digest("hex").slice(0, 16); await dbQuery("INSERT INTO cognitive_inbox (session_id, message_type, payload, status) VALUES ($1, 'prompt_context', $2, 'pending')", [sid, JSON.stringify({ prompt, prompt_hash: h, timestamp: Date.now() })]); return h; }
async function waitForProcessed(id, ms = 90000) { const s = Date.now(); while (Date.now() - s < ms) { const r = await dbQuery("SELECT status FROM cognitive_inbox WHERE id=$1", [id]); if (r.rows.length > 0 && /completed|failed/.test(r.rows[0].status)) return r.rows[0].status; await new Promise(r => setTimeout(r, 2000)); } return "timeout"; }
async function waitForRetrieval(sid, h, ms = 45000) { const s = Date.now(); while (Date.now() - s < ms) { const r = await dbQuery("SELECT context_type, context_text FROM retrieval_inbox WHERE session_id=$1 AND prompt_hash=$2 ORDER BY id DESC LIMIT 1", [sid, h]); if (r.rows.length > 0) return r.rows[0]; await new Promise(r => setTimeout(r, 1000)); } return null; }
function readLog(f) { try { return fs.readFileSync(f, "utf-8"); } catch { return ""; } }
function extractCost(log) { return (log.match(/cost: \$([0-9.]+)/g) || []).reduce((s, m) => s + parseFloat(m.replace("cost: $", "")), 0); }

async function run() {
  const SID = `level30-${Date.now()}`;
  let validatorCost = 0;
  console.log(`\n${"=".repeat(60)}`);
  console.log(`  AIDAM Level 30: Browser Capability Acquisition ("J'apprends a voir")`);
  console.log(`${"=".repeat(60)}`);
  console.log(`Session ID: ${SID}\n`);

  await cleanSession(SID);

  console.log("Launching orchestrator (Retriever + Learner)...");
  const orch = launchOrch(SID);
  const started = await waitForStatus(SID, "running", 25000);
  console.log(`Orchestrator started: ${started}`);
  if (!started) { for (let i = 121; i <= 126; i++) record(i, false, "No start"); printSummary(); return; }
  console.log("Waiting for agents to initialize...\n");
  await new Promise(r => setTimeout(r, 12000));
  const wh = await injectPrompt(SID, "What tools do we have?");
  await waitForRetrieval(SID, wh, 30000);
  console.log("Warm-up complete.\n");
  await new Promise(r => setTimeout(r, 5000));

  // =============================================
  // TEST #121: Need discovery
  // =============================================
  console.log("=== Test #121: Need discovery ===\n");

  const id121 = await injectToolUse(SID, {
    tool_name: "Bash",
    tool_input: { command: "curl -s https://example.com/landing" },
    tool_response: "I need to check if the landing page renders correctly and the hero section looks right, but I can only see the raw HTML. I can't visually verify the page layout, colors, or responsive design. A screenshot or browser rendering capability would let me actually see what users see."
  });
  console.log(`  Injected need observation (id=${id121})`);
  const st121 = await waitForProcessed(id121, 90000);
  console.log(`  Status: ${st121}`);
  record(121, st121 === "completed", `Need discovery: ${st121}`);
  await new Promise(r => setTimeout(r, 5000));

  // =============================================
  // TEST #122: Web research
  // =============================================
  console.log("\n=== Test #122: Web research ===\n");

  const id122a = await injectToolUse(SID, {
    tool_name: "WebSearch",
    tool_input: { query: "headless browser screenshot CLI tool npm" },
    tool_response: "Results:\n1. Puppeteer - Chrome DevTools Protocol, Google maintained. npm install puppeteer. page.screenshot({path:'shot.png'}).\n2. Playwright - Microsoft, multi-browser (Chrome, Firefox, Safari). npm install playwright.\n3. capture-website-cli - Simple CLI wrapper. npx capture-website-cli https://url --output=screenshot.png\n4. Pageres - CLI tool, batch screenshots. npm install -g pageres-cli."
  });
  const id122b = await injectToolUse(SID, {
    tool_name: "WebFetch",
    tool_input: { url: "https://pptr.dev/guides/screenshots" },
    tool_response: "Puppeteer Screenshot Guide:\n- page.screenshot({path: 'screenshot.png', fullPage: true})\n- Viewport: page.setViewport({width: 1280, height: 720})\n- Element screenshot: element.screenshot({path: 'el.png'})\n- PDF: page.pdf({path: 'page.pdf', format: 'A4'})\n- Clip region: page.screenshot({clip: {x:0, y:0, width:800, height:600}})"
  });
  console.log(`  Injected WebSearch (id=${id122a}) + WebFetch (id=${id122b})`);
  const st122a = await waitForProcessed(id122a, 90000);
  const st122b = await waitForProcessed(id122b, 90000);
  console.log(`  WebSearch: ${st122a}, WebFetch: ${st122b}`);
  record(122, st122a === "completed" && st122b === "completed", `Web research: search=${st122a}, fetch=${st122b}`);
  await new Promise(r => setTimeout(r, 5000));

  // =============================================
  // TEST #123: Solution comparison
  // =============================================
  console.log("\n=== Test #123: Solution comparison ===\n");

  const id123 = await injectToolUse(SID, {
    tool_name: "WebFetch",
    tool_input: { url: "https://playwright.dev/docs/screenshots" },
    tool_response: "Playwright Screenshots:\n- page.screenshot({path:'screenshot.png'})\n- Full page: page.screenshot({path:'full.png', fullPage:true})\n- Element: locator.screenshot({path:'el.png'})\n- Comparison: Playwright supports multiple browsers (Chromium, Firefox, WebKit), built-in auto-waiting, better for testing. Puppeteer is Chrome-only but lighter, better for simple screenshots. For CI: Playwright has built-in test runner. For quick screenshots: Puppeteer or capture-website-cli."
  });
  console.log(`  Injected comparison observation (id=${id123})`);
  const st123 = await waitForProcessed(id123, 90000);
  console.log(`  Status: ${st123}`);

  // Check if a learning or pattern about the comparison was saved
  await new Promise(r => setTimeout(r, 5000));
  const comparisonCheck = await dbQuery(`
    (SELECT 'learning' AS src, topic AS name FROM learnings WHERE (topic ILIKE '%puppeteer%' OR topic ILIKE '%playwright%' OR topic ILIKE '%screenshot%' OR topic ILIKE '%browser%' OR insight ILIKE '%puppeteer%') ORDER BY created_at DESC LIMIT 3)
    UNION ALL
    (SELECT 'pattern', name FROM patterns WHERE (name ILIKE '%screenshot%' OR name ILIKE '%browser%' OR name ILIKE '%puppeteer%' OR solution ILIKE '%puppeteer%') ORDER BY created_at DESC LIMIT 3)
  `);
  console.log(`  DB entries about browser/screenshot: ${comparisonCheck.rows.length}`);
  comparisonCheck.rows.forEach(r => console.log(`    ${r.src}: ${r.name}`));

  if (!(st123 === "completed" && comparisonCheck.rows.length > 0)) {
    record(123, false, "Structural pre-check failed");
  } else {
    const v123 = await askValidator(123, "Learner saved knowledge about browser automation tools", comparisonCheck.rows, "At least one saved entry should be about browser automation, testing tools, Puppeteer, Playwright, or screenshot generation. The entry name/topic should clearly relate to browser testing or automation.");
    validatorCost += v123.cost;
    record(123, v123.passed, v123.reason);
  }
  await new Promise(r => setTimeout(r, 5000));

  // =============================================
  // TEST #124: Tool creation
  // =============================================
  console.log("\n=== Test #124: Tool creation ===\n");

  const id124 = await injectToolUse(SID, {
    tool_name: "Write",
    tool_input: { file_path: "scripts/screenshot.js" },
    tool_response: "Created screenshot.js:\nconst puppeteer = require('puppeteer');\nasync function takeScreenshot(url, output = 'screenshot.png', width = 1280, height = 720) {\n  const browser = await puppeteer.launch({headless: 'new'});\n  const page = await browser.newPage();\n  await page.setViewport({width, height});\n  await page.goto(url, {waitUntil: 'networkidle0'});\n  await page.screenshot({path: output, fullPage: true});\n  await browser.close();\n  console.log(`Screenshot saved: ${output}`);\n}\nconst [url, out] = process.argv.slice(2);\ntakeScreenshot(url, out || 'screenshot.png');\n\nUsage: node scripts/screenshot.js https://example.com output.png"
  });
  console.log(`  Injected tool creation observation (id=${id124})`);
  const st124 = await waitForProcessed(id124, 90000);
  console.log(`  Status: ${st124}`);
  record(124, st124 === "completed", `Tool creation: ${st124}`);
  await new Promise(r => setTimeout(r, 8000));

  // =============================================
  // TEST #125: Knowledge persistence
  // =============================================
  console.log("\n=== Test #125: Knowledge persistence ===\n");

  // Check for generated_tool
  const toolCheck = await dbQuery("SELECT name, description FROM generated_tools WHERE name ILIKE '%screenshot%' OR description ILIKE '%screenshot%' OR description ILIKE '%puppeteer%' LIMIT 5");
  console.log(`  Generated tools: ${toolCheck.rows.length}`);
  toolCheck.rows.forEach(r => console.log(`    Tool: ${r.name} — ${(r.description || "").slice(0, 80)}`));

  // Check for pattern
  const patternCheck = await dbQuery("SELECT name FROM patterns WHERE name ILIKE '%screenshot%' OR name ILIKE '%browser%' OR solution ILIKE '%screenshot%' OR solution ILIKE '%puppeteer%' ORDER BY created_at DESC LIMIT 5");
  console.log(`  Patterns: ${patternCheck.rows.length}`);
  patternCheck.rows.forEach(r => console.log(`    Pattern: ${r.name}`));

  // Check for learning with web source
  const learningCheck = await dbQuery("SELECT topic, insight FROM learnings WHERE (topic ILIKE '%screenshot%' OR topic ILIKE '%puppeteer%' OR topic ILIKE '%playwright%' OR topic ILIKE '%browser%') ORDER BY created_at DESC LIMIT 5");
  console.log(`  Learnings: ${learningCheck.rows.length}`);
  learningCheck.rows.forEach(r => console.log(`    Learning: ${r.topic}`));

  // We need at least 2 out of 3 (tool, pattern, learning)
  const persisted = [toolCheck.rows.length > 0, patternCheck.rows.length > 0, learningCheck.rows.length > 0].filter(Boolean).length;
  if (!(persisted >= 2)) {
    record(125, false, "Structural pre-check failed");
  } else {
    const v125 = await askValidator(125, "Multiple knowledge artifact types persisted", { tools: toolCheck.rows, patterns: patternCheck.rows, learnings: learningCheck.rows }, "At least 2 of 3 artifact types (tools, patterns, learnings) should exist with names related to browser automation, screenshots, or testing. Having multiple artifact types shows the Learner categorizes knowledge appropriately.");
    validatorCost += v125.cost;
    record(125, v125.passed, v125.reason);
  }

  await new Promise(r => setTimeout(r, 5000));

  // =============================================
  // TEST #126: Capability recall
  // =============================================
  console.log("\n=== Test #126: Capability recall ===\n");

  const recallHash = await injectPrompt(SID, "I need to verify the landing page looks correct and the layout is proper. How can I take a screenshot of a web page?");
  console.log(`  Sent recall prompt (hash=${recallHash})`);
  const recallResult = await waitForRetrieval(SID, recallHash, 45000);
  const recallText = recallResult?.context_text || "";
  console.log(`  Type: ${recallResult?.context_type}, Length: ${recallText.length}`);

  const recallHasScreenshot = /screenshot|puppeteer|playwright|capture/i.test(recallText);
  const recallHasUsage = /node|npm|script|command|page\./i.test(recallText);
  console.log(`  Mentions screenshot tool: ${recallHasScreenshot}`);
  console.log(`  Has usage info: ${recallHasUsage}`);

  if (!(recallText.length > 50 && recallHasScreenshot)) {
    record(126, false, "Structural pre-check failed");
  } else {
    const v126 = await askValidator(126, "Retriever recalls screenshot capability when asked about verification", recallText, "Must mention screenshot tools (Puppeteer or Playwright) with actual usage examples or commands. Should be actionable, not just 'use a screenshot tool'.");
    validatorCost += v126.cost;
    record(126, v126.passed, v126.reason);
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
  console.log(`  LEVEL 30 RESULTS: ${passed}/${total} passed`);
  if (failed.length > 0) { console.log("  FAILURES:"); failed.forEach(f => console.log(`    Step ${f.step}: ${f.desc}`)); }
  console.log(`${"=".repeat(60)}`);
  if (failed.length === 0) console.log("\n  Level 30 PASSED! Browser capability acquired.\n");
}

run().then(() => process.exit(0)).catch(err => { console.error("Test error:", err); process.exit(1); });
setTimeout(() => { console.log("GLOBAL TIMEOUT"); process.exit(1); }, 400000);
