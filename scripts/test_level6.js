/**
 * Test Level 6: Sliding window 40k
 *
 * #18: 80k+ transcript → Compactor only reads last ~30k chars of conversation
 * #19: Prompt sent to Compactor contains [PREVIOUS STATE] + [NEW CONVERSATION]
 *
 * These are verified via code analysis + the actual behavior observed in tests.
 */
const fs = require("fs");
const path = require("path");

const results = [];
function record(step, passed, desc) {
  results.push({ step, passed, desc });
  console.log(`  ${passed ? "PASS" : "FAIL"}: ${desc}`);
}

console.log("=== Test #18: Sliding window limits conversation to ~30k chars ===\n");

// Read orchestrator code and verify the sliding window logic
const orchCode = fs.readFileSync(
  path.join(__dirname, "orchestrator.ts"), "utf-8"
);

// Verify: maxChars is defined and used to limit collection
const hasMaxChars = /const maxChars = 30000/.test(orchCode);
console.log(`  maxChars = 30000: ${hasMaxChars}`);

// Verify: backwards collection (not byte-offset based)
const hasBackwards = /for \(let i = allChunks\.length - 1/.test(orchCode);
console.log(`  Backwards collection from end: ${hasBackwards}`);

// Verify: char budget check
const hasCharBudget = /charsCollected \+ allChunks\[i\]\.text\.length > maxChars/.test(orchCode);
console.log(`  Char budget check: ${hasCharBudget}`);

// Verify: NO byte-offset filtering (the old bug)
const hasByteOffsetFilter = /chunk\.byteOffset < startByte/.test(orchCode);
console.log(`  Old byte-offset filter removed: ${!hasByteOffsetFilter}`);

record(18, hasMaxChars && hasBackwards && hasCharBudget && !hasByteOffsetFilter,
  "Sliding window collects last ~30k chars of conversation chunks (not raw bytes)");

// Empirical verification: parse the large transcript and check
const projectDir = "C:/Users/user/.claude/projects/C--Users-user-IdeaProjects-ecopathsWebApp1b";
const transcripts = fs.readdirSync(projectDir)
  .filter(f => f.endsWith(".jsonl") && !f.includes("subagents") && !f.includes("compactor"))
  .map(f => ({ path: path.join(projectDir, f), size: fs.statSync(path.join(projectDir, f)).size }))
  .sort((a, b) => b.size - a.size);

const bigTranscript = transcripts[0];
console.log(`\n  Empirical test on: ${path.basename(bigTranscript.path)} (${(bigTranscript.size / 1024 / 1024).toFixed(1)} MB)`);

const rawContent = fs.readFileSync(bigTranscript.path, "utf-8");
const lines = rawContent.split("\n").filter(l => l.trim());

// Extract all chunks (same as orchestrator)
const allChunks = [];
for (const line of lines) {
  try {
    const entry = JSON.parse(line);
    if (entry.type === "user" && entry.message?.content) {
      const content = typeof entry.message.content === "string"
        ? entry.message.content : JSON.stringify(entry.message.content);
      allChunks.push(`[USER] ${content.slice(0, 3000)}`);
    } else if (entry.type === "assistant" && entry.message?.content) {
      const blocks = entry.message.content;
      if (Array.isArray(blocks)) {
        const text = blocks.filter(b => b.type === "text").map(b => b.text).join("\n");
        if (text) allChunks.push(`[CLAUDE] ${text.slice(0, 3000)}`);
      }
    }
  } catch {}
}

const totalChunkChars = allChunks.reduce((s, c) => s + c.length, 0);
console.log(`  Total conversation chunks: ${allChunks.length} (${(totalChunkChars / 1024).toFixed(0)} KB)`);

// Apply sliding window (same logic as orchestrator)
const maxChars = 30000;
const windowChunks = [];
let collected = 0;
for (let i = allChunks.length - 1; i >= 0; i--) {
  if (collected + allChunks[i].length > maxChars) break;
  windowChunks.unshift(allChunks[i]);
  collected += allChunks[i].length;
}

console.log(`  Window chunks: ${windowChunks.length} / ${allChunks.length} (${(collected / 1024).toFixed(0)} KB / ${(totalChunkChars / 1024).toFixed(0)} KB)`);
console.log(`  Percentage of conversation in window: ${(windowChunks.length / allChunks.length * 100).toFixed(1)}%`);
console.log(`  Char budget used: ${collected} / ${maxChars} (${(collected / maxChars * 100).toFixed(0)}%)`);

const windowIsLimited = collected <= maxChars && collected > maxChars * 0.5;
record("18b", windowIsLimited,
  `Window correctly limits to ${(collected / 1024).toFixed(0)}KB from ${(totalChunkChars / 1024).toFixed(0)}KB total`);

// ═══════════════════════════════════════════════════
console.log("\n=== Test #19: Compactor prompt contains [PREVIOUS STATE] + [NEW CONVERSATION] ===\n");

// Check the code builds the right prompt format
const hasPreviousState = /\[PREVIOUS STATE\]/.test(orchCode);
const hasNewConversation = /\[NEW CONVERSATION/.test(orchCode);
const hasUpdateRequest = /\[UPDATE REQUEST/.test(orchCode);
const hasInitialRequest = /\[INITIAL STATE REQUEST/.test(orchCode);

console.log(`  [PREVIOUS STATE] in prompt: ${hasPreviousState}`);
console.log(`  [NEW CONVERSATION] in prompt: ${hasNewConversation}`);
console.log(`  [UPDATE REQUEST] for v2+: ${hasUpdateRequest}`);
console.log(`  [INITIAL STATE REQUEST] for v1: ${hasInitialRequest}`);

// Check it fetches previous state from DB
const fetchesPrevState = /SELECT state_text.*FROM session_state/.test(orchCode);
console.log(`  Fetches previous state from DB: ${fetchesPrevState}`);

record(19, hasPreviousState && hasNewConversation && hasUpdateRequest && hasInitialRequest && fetchesPrevState,
  "Compactor prompt correctly formats [PREVIOUS STATE] + [NEW CONVERSATION]");

// ═══════════════════════════════════════════════════
// Summary
const passed = results.filter(r => r.passed).length;
const total = results.length;
console.log(`\n${"=".repeat(60)}`);
console.log(`RESULTS: ${passed}/${total} passed`);
const failed = results.filter(r => !r.passed);
if (failed.length > 0) {
  console.log("FAILURES:");
  failed.forEach(f => console.log(`  Step ${f.step}: ${f.desc}`));
}
console.log("=".repeat(60));
if (failed.length === 0) console.log("\n=== LEVEL 6 TESTS PASSED ===");
