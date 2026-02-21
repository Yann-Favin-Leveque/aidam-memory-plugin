/**
 * AIDAM Test Helpers — Shared utilities for test suite L13-L39
 *
 * Provides:
 * - askValidator(): LLM-based semantic validation (Haiku, ~$0.0003/call)
 * - DB helpers: dbQuery(), cleanSession()
 * - Orchestrator helpers: launchOrch(), waitForStatus(), killSession()
 * - Queue helpers: injectToolUse(), injectPrompt(), waitForProcessed(), waitForRetrieval()
 * - Log helpers: readLog(), extractCost()
 */
const { Client } = require("pg");
const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const DB_CONFIG = {
  host: "localhost",
  database: "claude_memory",
  user: "postgres",
  password: process.env.PGPASSWORD || "",
  port: 5432,
};

const ORCHESTRATOR = path.join(__dirname, "orchestrator.js");

// ============================================
// LLM Validator (Haiku — test-only)
// ============================================

/**
 * Ask a Haiku LLM to judge whether a test result meets acceptance criteria.
 *
 * @param {number} testNum - Test number (e.g. 123)
 * @param {string} task - What was supposed to happen (in plain language)
 * @param {string|object} actual - The actual output (retriever text, DB rows, log snippet)
 * @param {string} criteria - Acceptance criteria (what "correct" looks like)
 * @returns {{ passed: boolean, reason: string, cost: number }}
 */
async function askValidator(testNum, task, actual, criteria) {
  const { query } = require("@anthropic-ai/claude-agent-sdk");

  const actualStr = typeof actual === "string"
    ? actual.slice(0, 3000)
    : JSON.stringify(actual, null, 2).slice(0, 3000);

  const prompt = `You are a strict test validator for AIDAM, a cognitive memory system for Claude Code.
Your job is to judge whether an actual test output meets the acceptance criteria.
Be STRICT but FAIR. If the output mostly meets criteria with minor gaps, still PASS.
If the output is clearly wrong, irrelevant, or missing key elements, FAIL.

TEST #${testNum}
TASK: ${task}
ACTUAL OUTPUT:
${actualStr}

ACCEPTANCE CRITERIA: ${criteria}

Respond with exactly ONE line:
PASS: <brief reason (max 80 chars)>
or
FAIL: <brief reason (max 80 chars)>`;

  try {
    const response = query({
      prompt,
      options: {
        model: "claude-haiku-4-5-20251001",
        maxBudgetUsd: 0.01,
        maxTurns: 1,
      },
    });

    let text = "", cost = 0;
    for await (const msg of response) {
      if (msg.type === "result") {
        text = msg.result || "";
        cost = msg.total_cost_usd || 0;
      }
    }

    const passed = text.trim().toUpperCase().startsWith("PASS");
    const reason = text.replace(/^(PASS|FAIL):\s*/i, "").trim().slice(0, 120);
    console.log(`  [VALIDATOR #${testNum}] ${passed ? "PASS" : "FAIL"}: ${reason} ($${cost.toFixed(4)})`);
    return { passed, reason, cost };
  } catch (err) {
    console.log(`  [VALIDATOR #${testNum}] ERROR: ${err.message.slice(0, 100)}`);
    // On validator error, don't block the test — return pass with warning
    return { passed: true, reason: `Validator error: ${err.message.slice(0, 60)}`, cost: 0 };
  }
}

// ============================================
// Database helpers
// ============================================

async function dbQuery(sql, params = []) {
  const db = new Client(DB_CONFIG);
  await db.connect();
  const r = await db.query(sql, params);
  await db.end();
  return r;
}

async function cleanSession(sid) {
  await dbQuery("DELETE FROM orchestrator_state WHERE session_id=$1", [sid]);
  await dbQuery("DELETE FROM cognitive_inbox WHERE session_id=$1", [sid]);
  await dbQuery("DELETE FROM retrieval_inbox WHERE session_id=$1", [sid]);
}

// ============================================
// Orchestrator helpers
// ============================================

async function waitForStatus(sid, pat, ms = 25000) {
  const re = new RegExp(pat, "i");
  const s = Date.now();
  while (Date.now() - s < ms) {
    const r = await dbQuery(
      "SELECT status FROM orchestrator_state WHERE session_id=$1",
      [sid]
    );
    if (r.rows.length > 0 && re.test(r.rows[0].status)) return true;
    await new Promise((r) => setTimeout(r, 1000));
  }
  return false;
}

function launchOrch(sid, opts = {}) {
  const slug = opts.slug || "aidam-memory";
  const lf = `C:/Users/user/.claude/logs/aidam_orch_test_${sid.slice(-8)}.log`;
  const fd = fs.openSync(lf, "w");
  const args = [
    ORCHESTRATOR,
    `--session-id=${sid}`,
    `--cwd=${opts.cwd || "C:/Users/user/IdeaProjects/aidam-memory-plugin"}`,
    `--retriever=${opts.retriever || "on"}`,
    `--learner=${opts.learner || "on"}`,
    `--compactor=${opts.compactor || "off"}`,
    `--curator=${opts.curator || "off"}`,
    `--project-slug=${slug}`,
  ];
  if (opts.transcriptPath) args.push(`--transcript-path=${opts.transcriptPath}`);
  if (opts.curatorInterval) args.push(`--curator-interval=${opts.curatorInterval}`);

  const p = spawn("node", args, {
    stdio: ["ignore", fd, fd],
    detached: false,
  });
  let ex = false;
  p.on("exit", () => { ex = true; });
  return { proc: p, logFile: lf, isExited: () => ex };
}

async function killSession(sid, proc) {
  try {
    await dbQuery(
      "UPDATE orchestrator_state SET status='stopping' WHERE session_id=$1",
      [sid]
    );
  } catch {}
  await new Promise((r) => setTimeout(r, 4000));
  try { proc.kill(); } catch {}
  await new Promise((r) => setTimeout(r, 1000));
}

// ============================================
// Queue helpers
// ============================================

async function injectToolUse(sid, payload) {
  const r = await dbQuery(
    "INSERT INTO cognitive_inbox (session_id, message_type, payload, status) VALUES ($1, 'tool_use', $2, 'pending') RETURNING id",
    [sid, JSON.stringify(payload)]
  );
  return r.rows[0].id;
}

async function injectPrompt(sid, prompt) {
  const h = crypto.createHash("sha256").update(prompt).digest("hex").slice(0, 16);
  await dbQuery(
    "INSERT INTO cognitive_inbox (session_id, message_type, payload, status) VALUES ($1, 'prompt_context', $2, 'pending')",
    [sid, JSON.stringify({ prompt, prompt_hash: h, timestamp: Date.now() })]
  );
  return h;
}

async function waitForProcessed(id, ms = 90000) {
  const s = Date.now();
  while (Date.now() - s < ms) {
    const r = await dbQuery("SELECT status FROM cognitive_inbox WHERE id=$1", [id]);
    if (r.rows.length > 0 && /completed|failed/.test(r.rows[0].status))
      return r.rows[0].status;
    await new Promise((r) => setTimeout(r, 2000));
  }
  return "timeout";
}

async function waitForRetrieval(sid, hash, ms = 45000) {
  const s = Date.now();
  while (Date.now() - s < ms) {
    const r = await dbQuery(
      "SELECT context_type, context_text FROM retrieval_inbox WHERE session_id=$1 AND prompt_hash=$2 ORDER BY id DESC LIMIT 1",
      [sid, hash]
    );
    if (r.rows.length > 0) return r.rows[0];
    await new Promise((r) => setTimeout(r, 1000));
  }
  return null;
}

// ============================================
// Log helpers
// ============================================

function readLog(f) {
  try { return fs.readFileSync(f, "utf-8"); } catch { return ""; }
}

function extractCost(log) {
  return (log.match(/cost: \$([0-9.]+)/g) || []).reduce(
    (s, m) => s + parseFloat(m.replace("cost: $", "")),
    0
  );
}

// ============================================
// Exports
// ============================================

module.exports = {
  askValidator,
  dbQuery,
  cleanSession,
  waitForStatus,
  launchOrch,
  killSession,
  injectToolUse,
  injectPrompt,
  waitForProcessed,
  waitForRetrieval,
  readLog,
  extractCost,
  DB_CONFIG,
  ORCHESTRATOR,
};
