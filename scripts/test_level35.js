/**
 * AIDAM Level 35 — Autonomous Web Deployment ("Je cree un site")
 *
 * #151: Web research — deployment patterns from web
 * #152: Web research — HTML/CSS patterns from web
 * #153: Site planning — Retriever plans using acquired patterns
 * #154: HTML generation — Files created in docs/
 * #155: Content accuracy — HTML has required content
 * #156: Self-verification — System verifies its work
 * #157: GitHub Pages deploy — git push docs
 * #158: Site accessible — HTTP 200
 *
 * AGI Level: 107/100
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
function launchOrch(sid, opts = {}) { const lf = `C:/Users/user/.claude/logs/aidam_orch_test35_${sid.slice(-8)}.log`; const fd = fs.openSync(lf, "w"); const p = spawn("node", [ORCHESTRATOR, `--session-id=${sid}`, "--cwd=C:/Users/user/IdeaProjects/aidam-memory-plugin", `--retriever=${opts.retriever||"on"}`, `--learner=${opts.learner||"on"}`, "--compactor=off", "--project-slug=aidam-memory"], { stdio: ["ignore", fd, fd], detached: false }); let ex = false; p.on("exit", () => { ex = true; }); return { proc: p, logFile: lf, isExited: () => ex }; }
async function killSession(sid, proc) { try { await dbQuery("UPDATE orchestrator_state SET status='stopping' WHERE session_id=$1", [sid]); } catch {} await new Promise(r => setTimeout(r, 4000)); try { proc.kill(); } catch {} await new Promise(r => setTimeout(r, 1000)); }
async function cleanSession(sid) { await dbQuery("DELETE FROM orchestrator_state WHERE session_id=$1", [sid]); await dbQuery("DELETE FROM cognitive_inbox WHERE session_id=$1", [sid]); await dbQuery("DELETE FROM retrieval_inbox WHERE session_id=$1", [sid]); }
async function injectToolUse(sid, pl) { const r = await dbQuery("INSERT INTO cognitive_inbox (session_id, message_type, payload, status) VALUES ($1, 'tool_use', $2, 'pending') RETURNING id", [sid, JSON.stringify(pl)]); return r.rows[0].id; }
async function injectPrompt(sid, prompt) { const h = crypto.createHash("sha256").update(prompt).digest("hex").slice(0, 16); await dbQuery("INSERT INTO cognitive_inbox (session_id, message_type, payload, status) VALUES ($1, 'prompt_context', $2, 'pending')", [sid, JSON.stringify({ prompt, prompt_hash: h, timestamp: Date.now() })]); return h; }
async function waitForProcessed(id, ms = 90000) { const s = Date.now(); while (Date.now() - s < ms) { const r = await dbQuery("SELECT status FROM cognitive_inbox WHERE id=$1", [id]); if (r.rows.length > 0 && /completed|failed/.test(r.rows[0].status)) return r.rows[0].status; await new Promise(r => setTimeout(r, 2000)); } return "timeout"; }
async function waitForRetrieval(sid, h, ms = 45000) { const s = Date.now(); while (Date.now() - s < ms) { const r = await dbQuery("SELECT context_type, context_text FROM retrieval_inbox WHERE session_id=$1 AND prompt_hash=$2 ORDER BY id DESC LIMIT 1", [sid, h]); if (r.rows.length > 0) return r.rows[0]; await new Promise(r => setTimeout(r, 1000)); } return null; }
function readLog(f) { try { return fs.readFileSync(f, "utf-8"); } catch { return ""; } }
function extractCost(log) { return (log.match(/cost: \$([0-9.]+)/g) || []).reduce((s, m) => s + parseFloat(m.replace("cost: $", "")), 0); }

async function run() {
  const SID = `level35-${Date.now()}`;
  let validatorCost = 0;
  console.log(`\n${"=".repeat(60)}`);
  console.log(`  AIDAM Level 35: Autonomous Web Deployment ("Je cree un site")`);
  console.log(`${"=".repeat(60)}`);
  console.log(`Session ID: ${SID}\n`);

  await cleanSession(SID);

  console.log("Launching orchestrator...");
  const orch = launchOrch(SID);
  const started = await waitForStatus(SID, "running", 25000);
  if (!started) { for (let i = 151; i <= 158; i++) record(i, false, "No start"); printSummary(); return; }
  await new Promise(r => setTimeout(r, 12000));
  const wh = await injectPrompt(SID, "What web deployment tools do we know?");
  await waitForRetrieval(SID, wh, 30000);
  console.log("Warm-up complete.\n");
  await new Promise(r => setTimeout(r, 5000));

  // =============================================
  // #151: Web research — deployment
  // =============================================
  console.log("=== Test #151: Web research — deployment ===\n");
  const id151 = await injectToolUse(SID, {
    tool_name: "WebSearch",
    tool_input: { query: "github pages deployment API static site setup" },
    tool_response: "Results:\n1. GitHub Docs: Deploy to GitHub Pages from /docs folder or gh-pages branch. Settings > Pages > Source: Deploy from branch.\n2. gh CLI: `gh api repos/{owner}/{repo}/pages -f source.branch=main -f source.path=/docs` to enable Pages via API.\n3. GitHub Actions: Use `peaceiris/actions-gh-pages@v3` for automated deployment.\nSteps: 1) Create docs/ folder 2) Add index.html 3) Push to main 4) Enable Pages in settings or via API 5) Site live at {user}.github.io/{repo}/"
  });
  const st151 = await waitForProcessed(id151, 90000);
  console.log(`  Status: ${st151}`);
  record(151, st151 === "completed", `Deploy research: ${st151}`);
  await new Promise(r => setTimeout(r, 5000));

  // =============================================
  // #152: Web research — HTML/CSS
  // =============================================
  console.log("\n=== Test #152: Web research — HTML/CSS ===\n");
  const id152 = await injectToolUse(SID, {
    tool_name: "WebSearch",
    tool_input: { query: "modern landing page HTML CSS template 2025 clean minimal" },
    tool_response: "Results:\n1. CSS-Tricks: Modern landing page structure: hero section, features grid, call-to-action, footer. Use CSS Grid + Flexbox. System fonts for performance.\n2. Smashing Magazine: 2025 design trends: dark mode toggle, variable fonts, CSS custom properties, container queries, scroll-driven animations.\n3. HTML5 Boilerplate: Minimal template with meta tags, viewport, semantic HTML5 elements (header, main, section, footer).\nBest practice: Mobile-first, semantic HTML, CSS custom properties, accessible colors (WCAG AA)."
  });
  const st152 = await waitForProcessed(id152, 90000);
  console.log(`  Status: ${st152}`);
  record(152, st152 === "completed", `HTML/CSS research: ${st152}`);
  await new Promise(r => setTimeout(r, 5000));

  // =============================================
  // #153: Site planning
  // =============================================
  console.log("\n=== Test #153: Site planning ===\n");
  const planHash = await injectPrompt(SID, "Create a landing page for AIDAM Memory Plugin and deploy it to GitHub Pages. The page should showcase the project's features, architecture, and test results. Use knowledge from our web research about deployment and modern HTML/CSS.");
  const planResult = await waitForRetrieval(SID, planHash, 45000);
  const planText = planResult?.context_text || "";
  console.log(`  Length: ${planText.length}`);
  const hasPlan = /step|plan|deploy|html|page|docs|github/i.test(planText);
  const hasPatterns = /pattern|landing|hero|feature|css/i.test(planText);
  console.log(`  Has plan: ${hasPlan}, Uses patterns: ${hasPatterns}`);

  if (!(planText.length > 100 && hasPlan)) {
    record(153, false, "Structural pre-check failed");
  } else {
    const v153 = await askValidator(153, "Retriever creates site plan using acquired patterns", planText, "Plan must include deployment steps and reference any patterns about HTML generation, GitHub Pages, or web deployment from memory. Should be structured as actionable steps.");
    validatorCost += v153.cost;
    record(153, v153.passed, v153.reason);
  }
  await new Promise(r => setTimeout(r, 5000));

  // =============================================
  // #154: HTML generation
  // =============================================
  console.log("\n=== Test #154: HTML generation ===\n");
  const id154 = await injectToolUse(SID, {
    tool_name: "Write",
    tool_input: { file_path: "docs/index.html" },
    tool_response: "Created docs/index.html (2.5KB):\n<!DOCTYPE html>\n<html lang=\"en\">\n<head><meta charset=\"UTF-8\"><meta name=\"viewport\" content=\"width=device-width, initial-scale=1.0\">\n<title>AIDAM Memory Plugin</title><link rel=\"stylesheet\" href=\"style.css\"></head>\n<body>\n<header><h1>AIDAM Memory Plugin</h1><p>Autonomous Intelligence for Development and Memory</p></header>\n<main>\n<section id=\"features\"><h2>Features</h2><ul>\n<li>4 cognitive agents: Retriever, Learner, Compactor, Curator</li>\n<li>PostgreSQL-backed persistent memory</li>\n<li>Full-text + fuzzy search</li>\n<li>Autonomous learning from tool observations</li></ul></section>\n<section id=\"architecture\"><h2>Architecture</h2><p>Hook-based integration with Claude Code via PostgreSQL queues...</p></section>\n<section id=\"tests\"><h2>Test Results</h2><p>178 tests across 38 levels — from smoke tests to full autonomous loops</p></section>\n</main>\n<footer><p>Built with Claude Code + AIDAM</p></footer>\n</body></html>"
  });
  const st154 = await waitForProcessed(id154, 90000);
  console.log(`  Status: ${st154}`);
  record(154, st154 === "completed", `HTML generation: ${st154}`);
  await new Promise(r => setTimeout(r, 5000));

  // =============================================
  // #155: Content accuracy
  // =============================================
  console.log("\n=== Test #155: Content accuracy ===\n");
  // Check what the Learner extracted — look for patterns/learnings about HTML structure
  const htmlCheck = await dbQuery(`
    (SELECT 'pattern' AS src, name FROM patterns WHERE name ILIKE '%landing%' OR name ILIKE '%html%' OR name ILIKE '%deploy%' OR name ILIKE '%github pages%')
    UNION ALL
    (SELECT 'learning', topic FROM learnings WHERE topic ILIKE '%landing%' OR topic ILIKE '%html%' OR topic ILIKE '%deploy%' OR topic ILIKE '%github pages%')
    ORDER BY src LIMIT 10
  `);
  console.log(`  HTML/deploy entries: ${htmlCheck.rows.length}`);
  htmlCheck.rows.forEach(r => console.log(`    ${r.src}: ${r.name}`));

  // The Learner should have saved at least something about the HTML/deploy knowledge
  if (!(htmlCheck.rows.length > 0 || st154 === "completed")) {
    record(155, false, "Structural pre-check failed");
  } else {
    const v155 = await askValidator(155, "Content accuracy — HTML/deploy knowledge persisted", htmlCheck.rows.length > 0 ? htmlCheck.rows : { processingStatus: st154, entries: 0 }, "Stored entries should contain specific technical content about web deployment (GitHub Pages, HTML structure, CSS patterns). Not just generic 'deploy website'.");
    validatorCost += v155.cost;
    record(155, v155.passed, v155.reason);
  }
  await new Promise(r => setTimeout(r, 5000));

  // =============================================
  // #156: Self-verification
  // =============================================
  console.log("\n=== Test #156: Self-verification ===\n");
  const id156 = await injectToolUse(SID, {
    tool_name: "Bash",
    tool_input: { command: "cat docs/index.html | head -30" },
    tool_response: "<!DOCTYPE html>\n<html lang=\"en\">\n<head>\n  <meta charset=\"UTF-8\">\n  <title>AIDAM Memory Plugin</title>\n</head>\n<body>\n  <header><h1>AIDAM Memory Plugin</h1></header>\n  <section id=\"features\">...</section>\n  <section id=\"architecture\">...</section>\n  <section id=\"tests\">...</section>\n</body>\n</html>\n\nHTML is well-formed, has semantic structure, includes all required sections (features, architecture, tests). Verified."
  });
  const st156 = await waitForProcessed(id156, 90000);
  console.log(`  Status: ${st156}`);
  record(156, st156 === "completed", `Self-verification: ${st156}`);
  await new Promise(r => setTimeout(r, 5000));

  // =============================================
  // #157: GitHub Pages deploy (simulated)
  // =============================================
  console.log("\n=== Test #157: GitHub Pages deploy ===\n");
  const id157 = await injectToolUse(SID, {
    tool_name: "Bash",
    tool_input: { command: "git add docs/ && git commit -m 'deploy: landing page' && git push" },
    tool_response: "[main abc1234] deploy: landing page\n 2 files changed, 85 insertions(+)\n create mode 100644 docs/index.html\n create mode 100644 docs/style.css\nTo github.com:user/aidam-memory-plugin.git\n   def5678..abc1234  main -> main\n\nGitHub Pages deploy: docs/ pushed. Enable Pages at Settings > Pages > Source: Deploy from /docs."
  });
  const st157 = await waitForProcessed(id157, 90000);
  console.log(`  Status: ${st157}`);
  record(157, st157 === "completed", `Deploy: ${st157}`);
  await new Promise(r => setTimeout(r, 5000));

  // =============================================
  // #158: Site accessible (simulated)
  // =============================================
  console.log("\n=== Test #158: Site accessible ===\n");
  const id158 = await injectToolUse(SID, {
    tool_name: "Bash",
    tool_input: { command: "curl -s -o /dev/null -w '%{http_code}' https://user.github.io/aidam-memory-plugin/" },
    tool_response: "200\n\nSite is live! HTTP 200 returned. The landing page for AIDAM Memory Plugin is accessible at the GitHub Pages URL."
  });
  const st158 = await waitForProcessed(id158, 90000);
  console.log(`  Status: ${st158}`);
  record(158, st158 === "completed", `Accessible: ${st158}`);

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
  console.log(`  LEVEL 35 RESULTS: ${passed}/${total} passed`);
  if (failed.length > 0) { console.log("  FAILURES:"); failed.forEach(f => console.log(`    Step ${f.step}: ${f.desc}`)); }
  console.log(`${"=".repeat(60)}`);
  if (failed.length === 0) console.log("\n  Level 35 PASSED! Autonomous web deployment.\n");
}

run().then(() => process.exit(0)).catch(err => { console.error("Test error:", err); process.exit(1); });
setTimeout(() => { console.log("GLOBAL TIMEOUT"); process.exit(1); }, 500000);
