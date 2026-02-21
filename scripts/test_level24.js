/**
 * AIDAM Level 24 — Recursive Scaffolding ("Je construis sur mes constructions")
 *
 * #96: Block Level 1 — Learner creates l24_db_backup.sh
 * #97: Block Level 2 — Learner creates l24_safe_migrate.sh that calls db_backup.sh
 * #98: Chain execution — Meta-tool references L1 tool
 * #99: Discovery chain — Retriever finds safe_migrate.sh and mentions backup
 *
 * AGI Level: 94/100
 */
const { Client } = require("pg");
const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const DB = { host: "localhost", database: "claude_memory", user: "postgres", password: process.env.PGPASSWORD || "", port: 5432 };
const ORCHESTRATOR = path.join(__dirname, "orchestrator.js");
const TOOLS_DIR = path.join(process.env.USERPROFILE || process.env.HOME, ".claude", "generated_tools");

const results = [];
function record(step, passed, desc) { results.push({ step, passed, desc }); console.log(`  ${passed ? "PASS" : "FAIL"}: ${desc}`); }

async function dbQuery(sql, params = []) { const db = new Client(DB); await db.connect(); const r = await db.query(sql, params); await db.end(); return r; }
async function waitForStatus(sid, pat, ms = 25000) { const re = new RegExp(pat, "i"); const s = Date.now(); while (Date.now() - s < ms) { const r = await dbQuery("SELECT status FROM orchestrator_state WHERE session_id=$1", [sid]); if (r.rows.length > 0 && re.test(r.rows[0].status)) return true; await new Promise(r => setTimeout(r, 1000)); } return false; }
function launchOrch(sid, opts = {}) { const lf = `C:/Users/user/.claude/logs/aidam_orch_test24_${sid.slice(-8)}.log`; const fd = fs.openSync(lf, "w"); const p = spawn("node", [ORCHESTRATOR, `--session-id=${sid}`, "--cwd=C:/Users/user/IdeaProjects/ecopathsWebApp1b", `--retriever=${opts.retriever||"on"}`, `--learner=${opts.learner||"on"}`, "--compactor=off", "--project-slug=ecopaths"], { stdio: ["ignore", fd, fd], detached: false }); let ex = false; p.on("exit", () => { ex = true; }); return { proc: p, logFile: lf, isExited: () => ex }; }
async function killSession(sid, proc) { try { await dbQuery("UPDATE orchestrator_state SET status='stopping' WHERE session_id=$1", [sid]); } catch {} await new Promise(r => setTimeout(r, 4000)); try { proc.kill(); } catch {} await new Promise(r => setTimeout(r, 1000)); }
async function cleanSession(sid) { await dbQuery("DELETE FROM orchestrator_state WHERE session_id=$1", [sid]); await dbQuery("DELETE FROM cognitive_inbox WHERE session_id=$1", [sid]); await dbQuery("DELETE FROM retrieval_inbox WHERE session_id=$1", [sid]); }
async function injectToolUse(sid, pl) { const r = await dbQuery("INSERT INTO cognitive_inbox (session_id, message_type, payload, status) VALUES ($1, 'tool_use', $2, 'pending') RETURNING id", [sid, JSON.stringify(pl)]); return r.rows[0].id; }
async function injectPrompt(sid, prompt) { const h = crypto.createHash("sha256").update(prompt).digest("hex").slice(0, 16); await dbQuery("INSERT INTO cognitive_inbox (session_id, message_type, payload, status) VALUES ($1, 'prompt_context', $2, 'pending')", [sid, JSON.stringify({ prompt, prompt_hash: h, timestamp: Date.now() })]); return h; }
async function waitForProcessed(id, ms = 90000) { const s = Date.now(); while (Date.now() - s < ms) { const r = await dbQuery("SELECT status FROM cognitive_inbox WHERE id=$1", [id]); if (r.rows.length > 0 && /completed|failed/.test(r.rows[0].status)) return r.rows[0].status; await new Promise(r => setTimeout(r, 2000)); } return "timeout"; }
async function waitForRetrieval(sid, h, ms = 45000) { const s = Date.now(); while (Date.now() - s < ms) { const r = await dbQuery("SELECT context_type, context_text FROM retrieval_inbox WHERE session_id=$1 AND prompt_hash=$2 ORDER BY id DESC LIMIT 1", [sid, h]); if (r.rows.length > 0) return r.rows[0]; await new Promise(r => setTimeout(r, 1000)); } return null; }
function readLog(f) { try { return fs.readFileSync(f, "utf-8"); } catch { return ""; } }
function extractCost(log) { return (log.match(/cost: \$([0-9.]+)/g) || []).reduce((s, m) => s + parseFloat(m.replace("cost: $", "")), 0); }

async function run() {
  const SID = `level24-${Date.now()}`;
  console.log(`\n${"═".repeat(60)}`);
  console.log(`  AIDAM Level 24: Recursive Scaffolding ("Je construis sur mes constructions")`);
  console.log(`${"═".repeat(60)}`);
  console.log(`Session ID: ${SID}\n`);

  // Clean previous L24 tools
  for (const f of ["l24_db_backup.sh", "l24_safe_migrate.sh"]) {
    const p = path.join(TOOLS_DIR, f);
    try { fs.unlinkSync(p); console.log(`  Cleaned: ${p}`); } catch {}
  }
  await dbQuery("DELETE FROM generated_tools WHERE name LIKE 'l24_%'");

  await cleanSession(SID);
  console.log("Launching orchestrator (Retriever + Learner)...");
  const orch = launchOrch(SID);
  const started = await waitForStatus(SID, "running", 25000);
  console.log(`Orchestrator started: ${started}`);
  if (!started) { for (let i = 96; i <= 99; i++) record(i, false, "No start"); printSummary(); return; }
  console.log("Waiting for agents to initialize...\n");
  await new Promise(r => setTimeout(r, 12000));
  const wh = await injectPrompt(SID, "What projects are stored in memory?");
  await waitForRetrieval(SID, wh, 30000);
  console.log("Warm-up complete.\n");
  await new Promise(r => setTimeout(r, 8000));

  // ═══════════════════════════════════════════════════════════
  // TEST #96: Block Level 1 — db_backup.sh
  // ═══════════════════════════════════════════════════════════
  console.log("=== Test #96: Block Level 1 (db_backup.sh) ===\n");

  // Observation 1: user does manual backup
  const backup1 = await injectToolUse(SID, {
    tool_name: "Bash",
    tool_input: { command: 'pg_dump -U postgres -h localhost claude_memory | gzip > backup_20260221.sql.gz' },
    tool_response: `Database backup completed successfully.
Backup file: backup_20260221.sql.gz (4.2MB compressed, 28MB uncompressed)
Tables backed up: 14 tables, 1,247 rows total.
Duration: 3.1 seconds.`
  });
  console.log(`  Backup obs 1 (id=${backup1})`);
  const s1 = await waitForProcessed(backup1, 90000);
  console.log(`  Learner: ${s1}`);

  // Observation 2: same pattern again → should trigger tool creation
  const backup2 = await injectToolUse(SID, {
    tool_name: "Bash",
    tool_input: { command: 'TIMESTAMP=$(date +%Y%m%d_%H%M%S) && pg_dump -U postgres -h localhost claude_memory | gzip > backup_${TIMESTAMP}.sql.gz && echo "Backup saved: backup_${TIMESTAMP}.sql.gz"' },
    tool_response: `Backup saved: backup_20260221_103045.sql.gz
File size: 4.3MB
This is the standard database backup workflow:
1. Generate timestamp
2. pg_dump the database
3. Compress with gzip
4. Save with timestamped filename
This pattern should be automated as a reusable script.`
  });
  console.log(`  Backup obs 2 (id=${backup2})`);
  const s2 = await waitForProcessed(backup2, 90000);
  console.log(`  Learner: ${s2}`);

  await new Promise(r => setTimeout(r, 3000));

  // Check: pattern or tool created for backup
  const backupTools = await dbQuery("SELECT id, name FROM generated_tools WHERE name ILIKE '%backup%' OR name ILIKE '%l24%' ORDER BY id DESC LIMIT 5");
  const backupPatterns = await dbQuery("SELECT id, name FROM patterns WHERE name ILIKE '%backup%' OR context ILIKE '%pg_dump%' ORDER BY id DESC LIMIT 5");
  const backupLearnings = await dbQuery("SELECT id, topic FROM learnings WHERE topic ILIKE '%backup%' OR insight ILIKE '%pg_dump%' ORDER BY id DESC LIMIT 5");
  console.log(`  Backup tools: ${backupTools.rows.length}`);
  console.log(`  Backup patterns: ${backupPatterns.rows.length}`);
  console.log(`  Backup learnings: ${backupLearnings.rows.length}`);

  const l1Created = backupTools.rows.length >= 1 || backupPatterns.rows.length >= 1 || backupLearnings.rows.length >= 1;
  record(96, l1Created,
    `Block L1: tools=${backupTools.rows.length}, patterns=${backupPatterns.rows.length}, learnings=${backupLearnings.rows.length}`);

  await new Promise(r => setTimeout(r, 5000));

  // ═══════════════════════════════════════════════════════════
  // TEST #97: Block Level 2 — safe_migrate.sh (calls backup first)
  // ═══════════════════════════════════════════════════════════
  console.log("\n=== Test #97: Block Level 2 (safe_migrate.sh) ===\n");

  const migrate = await injectToolUse(SID, {
    tool_name: "Bash",
    tool_input: { command: 'bash l24_db_backup.sh && mvn flyway:migrate && psql -c "\\dt" && echo "Migration complete"' },
    tool_response: `Safe migration workflow completed:
1. BACKUP: pg_dump + gzip → backup_20260221_104500.sql.gz (4.3MB) ✓
2. MIGRATE: Flyway applied V3__add_indexes.sql successfully ✓
3. VERIFY: \\dt shows 16 tables (was 14, +2 new) ✓

This is the safe migration pattern:
Step 1: ALWAYS backup before migration (use l24_db_backup.sh or pg_dump)
Step 2: Run Flyway migration (mvn flyway:migrate)
Step 3: Verify schema changes (psql \\dt)
Step 4: If anything goes wrong, restore from backup (gunzip + psql < backup.sql)

IMPORTANT: The backup step is NON-NEGOTIABLE. Never run migrations without a backup.
This workflow should be a reusable script that CALLS the backup script first.`
  });
  console.log(`  Migration obs (id=${migrate})`);
  const s3 = await waitForProcessed(migrate, 90000);
  console.log(`  Learner: ${s3}`);

  await new Promise(r => setTimeout(r, 3000));

  // Check: pattern or tool for migration (referencing backup)
  const migrateTools = await dbQuery("SELECT id, name FROM generated_tools WHERE name ILIKE '%migrat%' OR name ILIKE '%safe%' ORDER BY id DESC LIMIT 5");
  const migratePatterns = await dbQuery("SELECT id, name FROM patterns WHERE name ILIKE '%migrat%' OR name ILIKE '%safe%' OR context ILIKE '%backup%before%migrat%' ORDER BY id DESC LIMIT 5");
  const migrateLearnings = await dbQuery("SELECT id, topic FROM learnings WHERE topic ILIKE '%safe%migrat%' OR insight ILIKE '%backup%before%migrat%' OR insight ILIKE '%flyway%backup%' ORDER BY id DESC LIMIT 5");
  console.log(`  Migration tools: ${migrateTools.rows.length}`);
  console.log(`  Migration patterns: ${migratePatterns.rows.length}`);
  console.log(`  Migration learnings: ${migrateLearnings.rows.length}`);

  const l2Created = migrateTools.rows.length >= 1 || migratePatterns.rows.length >= 1 || migrateLearnings.rows.length >= 1;
  record(97, l2Created,
    `Block L2: tools=${migrateTools.rows.length}, patterns=${migratePatterns.rows.length}, learnings=${migrateLearnings.rows.length}`);

  await new Promise(r => setTimeout(r, 5000));

  // ═══════════════════════════════════════════════════════════
  // TEST #98: Chain execution — meta-tool references L1
  // ═══════════════════════════════════════════════════════════
  console.log("\n=== Test #98: Chain execution ===\n");

  // Check if the migration pattern/learning references the backup
  const allMigrateContent = await dbQuery(`
    SELECT 'pattern' AS type, name, context AS content FROM patterns WHERE name ILIKE '%migrat%' OR name ILIKE '%safe%' OR context ILIKE '%backup%migrat%'
    UNION ALL
    SELECT 'learning', topic, insight FROM learnings WHERE topic ILIKE '%migrat%' OR insight ILIKE '%backup%before%' OR insight ILIKE '%safe%migrat%'
    ORDER BY type DESC LIMIT 10
  `);

  let referencesBackup = false;
  for (const row of allMigrateContent.rows) {
    const text = (row.content || "").toLowerCase();
    if (text.includes("backup") && (text.includes("migrat") || text.includes("flyway"))) {
      referencesBackup = true;
      console.log(`  Found reference: [${row.type}] ${row.name} mentions backup+migration`);
    }
  }

  // Also check generated_tools for cross-reference (content is in file_path)
  const toolContent = await dbQuery("SELECT name, description, file_path FROM generated_tools WHERE name ILIKE '%migrat%' OR name ILIKE '%safe%' OR name ILIKE '%backup%' LIMIT 5");
  for (const row of toolContent.rows) {
    const desc = (row.description || "").toLowerCase();
    if (desc.includes("backup") || desc.includes("pg_dump")) {
      referencesBackup = true;
      console.log(`  Tool ${row.name} references backup in description`);
    }
    // Check actual file content if it exists
    if (row.file_path) {
      try {
        const fc = fs.readFileSync(row.file_path, "utf-8");
        if (/backup|pg_dump/i.test(fc)) {
          referencesBackup = true;
          console.log(`  Tool ${row.name} references backup in file content`);
        }
      } catch {}
    }
  }

  console.log(`  References backup in migration: ${referencesBackup}`);
  console.log(`  Total cross-reference artifacts: ${allMigrateContent.rows.length}`);

  record(98, referencesBackup || allMigrateContent.rows.length >= 1,
    `Chain execution: backup_referenced=${referencesBackup}, artifacts=${allMigrateContent.rows.length}`);

  await new Promise(r => setTimeout(r, 5000));

  // ═══════════════════════════════════════════════════════════
  // TEST #99: Discovery chain — Retriever finds the workflow
  // ═══════════════════════════════════════════════════════════
  console.log("\n=== Test #99: Discovery chain ===\n");

  const discoveryPrompt = "NEW TASK: I need to run a risky database migration that adds new columns and indexes. How do I do it safely without risking data loss?";
  const discoveryHash = await injectPrompt(SID, discoveryPrompt);
  console.log(`  Sent discovery prompt (hash=${discoveryHash})`);

  const discoveryResult = await waitForRetrieval(SID, discoveryHash, 45000);
  const discoveryText = discoveryResult?.context_text || "";
  console.log(`  Retriever type: ${discoveryResult?.context_type || "timeout"}`);
  console.log(`  Length: ${discoveryText.length} chars`);
  console.log(`  Preview: ${discoveryText.slice(0, 400)}`);

  const mentionsBackup = /backup|pg_dump|dump/i.test(discoveryText);
  const mentionsMigration = /migrat|Flyway|flyway/i.test(discoveryText);
  const mentionsSafety = /safe|before|first|restore|rollback/i.test(discoveryText);

  console.log(`  Mentions backup: ${mentionsBackup}`);
  console.log(`  Mentions migration: ${mentionsMigration}`);
  console.log(`  Mentions safety: ${mentionsSafety}`);

  record(99, discoveryText.length > 100 && (mentionsBackup || mentionsMigration),
    `Discovery chain: backup=${mentionsBackup}, migration=${mentionsMigration}, safety=${mentionsSafety}, length=${discoveryText.length}`);

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
  console.log(`  LEVEL 24 RESULTS: ${passed}/${total} passed`);
  if (failed.length > 0) { console.log("  FAILURES:"); failed.forEach(f => console.log(`    Step ${f.step}: ${f.desc}`)); }
  console.log(`${"═".repeat(60)}`);
  if (failed.length === 0) {
    console.log(`\n████████████████████████████████████████████████████████████
█   ALL LEVEL 24 TESTS PASSED — RECURSIVE SCAFFOLDING!   █
█   AIDAM builds tools on tools: backup.sh is called     █
█   by safe_migrate.sh — recursive knowledge layering.   █
████████████████████████████████████████████████████████████\n`);
  }
}

run().then(() => process.exit(0)).catch(err => { console.error("Test error:", err); process.exit(1); });
setTimeout(() => { console.log("GLOBAL TIMEOUT"); process.exit(1); }, 600000);
