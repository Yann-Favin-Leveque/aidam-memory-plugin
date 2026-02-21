/**
 * AIDAM Memory Plugin - Orchestrator
 *
 * Manages two persistent Sonnet sessions (Retriever + Learner) that run
 * alongside the user's main Claude Code session. Communicates via PostgreSQL
 * queue tables (cognitive_inbox, retrieval_inbox).
 */

import { query } from "@anthropic-ai/claude-agent-sdk";
import type { SDKMessage, SDKResultMessage } from "@anthropic-ai/claude-agent-sdk";
import { Client } from "pg";
import * as fs from "fs";
import * as path from "path";

// ============================================
// CONFIGURATION
// ============================================

interface OrchestratorConfig {
  sessionId: string;
  cwd: string;
  retrieverEnabled: boolean;
  learnerEnabled: boolean;
  compactorEnabled: boolean;
  pollIntervalMs: number;
  heartbeatIntervalMs: number;
  compactorCheckIntervalMs: number;
  compactorTokenThreshold: number;
  retrieverModel: string;
  learnerModel: string;
  compactorModel: string;
  mcpServerScript: string;
  pythonPath: string;
  transcriptPath: string;
  projectSlug: string;
  lastCompactSize: number;
}

interface CognitiveMessage {
  id: number;
  session_id: string;
  message_type: string;
  payload: any;
  status: string;
  created_at: Date;
}

const DB_CONFIG = {
  host: "localhost",
  database: "claude_memory",
  user: "postgres",
  password: process.env.PGPASSWORD || "",
  port: 5432,
};

// ============================================
// SLIDING WINDOW
// ============================================

interface TurnEntry {
  role: "user" | "claude";
  content: string;
  timestamp: number;
}

class SlidingWindow {
  private turns: TurnEntry[] = [];
  private maxTurns: number;

  constructor(maxTurns: number = 5) {
    this.maxTurns = maxTurns;
  }

  addUserTurn(prompt: string): void {
    this.turns.push({ role: "user", content: prompt, timestamp: Date.now() });
    this.trim();
  }

  addClaudeSummary(summary: string): void {
    this.turns.push({ role: "claude", content: summary, timestamp: Date.now() });
    this.trim();
  }

  private trim(): void {
    // Keep last maxTurns * 2 entries (pairs of user+claude)
    const maxEntries = this.maxTurns * 2;
    if (this.turns.length > maxEntries) {
      this.turns = this.turns.slice(-maxEntries);
    }
  }

  format(): string {
    if (this.turns.length === 0) return "(no previous context)";
    return this.turns
      .map((t) => `[${t.role === "user" ? "USER" : "CLAUDE"}] ${t.content}`)
      .join("\n\n");
  }
}

// ============================================
// ORCHESTRATOR
// ============================================

class Orchestrator {
  private config: OrchestratorConfig;
  private db: Client;
  private retrieverSessionId: string | undefined;
  private learnerSessionId: string | undefined;
  private compactorSessionId: string | undefined;
  private running: boolean = false;
  private slidingWindow: SlidingWindow;
  private pollTimer: ReturnType<typeof setInterval> | undefined;
  private heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  private compactorTimer: ReturnType<typeof setInterval> | undefined;
  private retrieverBusy: boolean = false;
  private learnerBusy: boolean = false;
  private compactorBusy: boolean = false;
  private lastCompactedSize: number = 0;
  private compactorVersion: number = 0;

  constructor(config: OrchestratorConfig) {
    this.config = config;
    this.db = new Client(DB_CONFIG);
    this.slidingWindow = new SlidingWindow(5);
    // Initialize from config (set by SessionStart when source=clear)
    this.lastCompactedSize = config.lastCompactSize;
  }

  async start(): Promise<void> {
    log("Starting orchestrator...");
    await this.db.connect();

    // Register in orchestrator_state (upsert)
    await this.db.query(
      `INSERT INTO orchestrator_state (session_id, pid, retriever_enabled, learner_enabled, status)
       VALUES ($1, $2, $3, $4, 'starting')
       ON CONFLICT (session_id) DO UPDATE SET
         pid = $2, retriever_enabled = $3, learner_enabled = $4,
         status = 'starting', started_at = CURRENT_TIMESTAMP,
         last_heartbeat_at = CURRENT_TIMESTAMP, stopped_at = NULL, error_message = NULL`,
      [this.config.sessionId, process.pid, this.config.retrieverEnabled, this.config.learnerEnabled]
    );

    // Initialize sessions
    const initPromises: Promise<void>[] = [];
    if (this.config.retrieverEnabled) {
      initPromises.push(this.initRetriever());
    }
    if (this.config.learnerEnabled) {
      initPromises.push(this.initLearner());
    }
    if (this.config.compactorEnabled) {
      initPromises.push(this.initCompactor());
    }
    await Promise.all(initPromises);

    // Mark as running
    await this.db.query(
      `UPDATE orchestrator_state SET status = 'running',
         retriever_session_id = $2, learner_session_id = $3,
         last_heartbeat_at = CURRENT_TIMESTAMP
       WHERE session_id = $1`,
      [this.config.sessionId, this.retrieverSessionId || null, this.learnerSessionId || null]
    );

    this.running = true;
    this.startPolling();
    this.startHeartbeat();
    if (this.config.compactorEnabled) {
      this.startCompactorMonitor();
    }

    // Graceful shutdown handlers
    process.on("SIGTERM", () => this.shutdown());
    process.on("SIGINT", () => this.shutdown());
    process.on("uncaughtException", (err) => {
      log(`Uncaught exception: ${err.message}`);
      this.shutdown();
    });

    log(`Orchestrator running. Retriever: ${this.retrieverSessionId || "disabled"}, Learner: ${this.learnerSessionId || "disabled"}, Compactor: ${this.compactorSessionId || "disabled"}`);
  }

  private getMcpConfig() {
    return {
      memory: {
        type: "stdio" as const,
        command: this.config.pythonPath,
        args: [this.config.mcpServerScript],
        env: {
          PYTHONPATH: path.dirname(this.config.mcpServerScript),
        },
      },
    };
  }

  private async initRetriever(): Promise<void> {
    log("Initializing Retriever session...");
    const promptPath = path.join(__dirname, "..", "prompts", "retriever_system.md");
    let systemPrompt: string;
    try {
      systemPrompt = fs.readFileSync(promptPath, "utf-8");
    } catch {
      systemPrompt = "You are a memory retrieval agent. Search the MCP memory tools for relevant context when given a user prompt. Respond with SKIP if nothing relevant.";
    }

    try {
      const response = query({
        prompt: systemPrompt + "\n\n[INIT] Retriever session initialized. Waiting for queries. Respond with READY.",
        options: {
          model: this.config.retrieverModel,
          mcpServers: this.getMcpConfig(),
          allowedTools: [
            "mcp__memory__memory_search",
            "mcp__memory__memory_get_project",
            "mcp__memory__memory_list_projects",
            "mcp__memory__memory_search_errors",
            "mcp__memory__memory_search_patterns",
            "mcp__memory__memory_get_project_learnings",
            "mcp__memory__memory_get_sessions",
            "mcp__memory__memory_get_recent_learnings",
            "mcp__memory__memory_get_preferences",
            "mcp__memory__memory_drilldown_list",
            "mcp__memory__memory_drilldown_get",
            "mcp__memory__memory_drilldown_search",
            "mcp__memory__db_select",
          ],
          permissionMode: "bypassPermissions",
          allowDangerouslySkipPermissions: true,
          maxTurns: 2,
          maxBudgetUsd: 0.10,
          maxThinkingTokens: 1024,
          cwd: this.config.cwd,
          persistSession: true,
        },
      });

      for await (const msg of response) {
        if (msg.type === "system" && "subtype" in msg && msg.subtype === "init") {
          this.retrieverSessionId = msg.session_id;
          log(`Retriever session ID: ${this.retrieverSessionId}`);
        }
      }
    } catch (err: any) {
      log(`Retriever init error: ${err.message}`);
    }
  }

  private async initLearner(): Promise<void> {
    log("Initializing Learner session...");
    const promptPath = path.join(__dirname, "..", "prompts", "learner_system.md");
    let systemPrompt: string;
    try {
      systemPrompt = fs.readFileSync(promptPath, "utf-8");
    } catch {
      systemPrompt = "You are a memory learning agent. Extract and save valuable knowledge from tool observations. Use MCP memory tools to search for duplicates before saving. Respond with SKIP if nothing worth saving.";
    }

    try {
      const response = query({
        prompt: systemPrompt + "\n\n[INIT] Learner session initialized. Waiting for tool observations. Respond with READY.",
        options: {
          model: this.config.learnerModel,
          mcpServers: this.getMcpConfig(),
          allowedTools: [
            "mcp__memory__memory_search",
            "mcp__memory__memory_save_learning",
            "mcp__memory__memory_save_error",
            "mcp__memory__memory_save_pattern",
            "mcp__memory__memory_drilldown_save",
            "mcp__memory__memory_drilldown_search",
            "mcp__memory__memory_get_project",
            "mcp__memory__memory_get_recent_learnings",
            "mcp__memory__db_select",
            "mcp__memory__db_execute",
            "Bash",
          ],
          permissionMode: "bypassPermissions",
          allowDangerouslySkipPermissions: true,
          maxTurns: 3,
          maxBudgetUsd: 0.10,
          cwd: this.config.cwd,
          persistSession: true,
        },
      });

      for await (const msg of response) {
        if (msg.type === "system" && "subtype" in msg && msg.subtype === "init") {
          this.learnerSessionId = msg.session_id;
          log(`Learner session ID: ${this.learnerSessionId}`);
        }
      }
    } catch (err: any) {
      log(`Learner init error: ${err.message}`);
    }
  }

  // ============================================
  // POLLING LOOP
  // ============================================

  private startPolling(): void {
    this.pollTimer = setInterval(async () => {
      if (!this.running) return;
      try {
        await this.pollCognitiveInbox();
        await this.checkShutdownSignal();
      } catch (err: any) {
        log(`Poll error: ${err.message}`);
      }
    }, this.config.pollIntervalMs);
  }

  private startHeartbeat(): void {
    this.heartbeatTimer = setInterval(async () => {
      if (!this.running) return;
      try {
        await this.db.query(
          `UPDATE orchestrator_state SET last_heartbeat_at = CURRENT_TIMESTAMP
           WHERE session_id = $1 AND status = 'running'`,
          [this.config.sessionId]
        );
      } catch (err: any) {
        log(`Heartbeat error: ${err.message}`);
      }
    }, this.config.heartbeatIntervalMs);
  }

  private async pollCognitiveInbox(): Promise<void> {
    // Fetch and claim pending messages in one atomic operation
    const result = await this.db.query(
      `UPDATE cognitive_inbox
       SET status = 'processing', processed_at = CURRENT_TIMESTAMP
       WHERE id IN (
         SELECT id FROM cognitive_inbox
         WHERE session_id = $1 AND status = 'pending'
         ORDER BY created_at ASC
         LIMIT 10
       )
       RETURNING *`,
      [this.config.sessionId]
    );

    const messages: CognitiveMessage[] = result.rows;
    if (messages.length === 0) return;

    for (const msg of messages) {
      try {
        if (msg.message_type === "prompt_context" && this.config.retrieverEnabled) {
          await this.routeToRetriever(msg);
        } else if (msg.message_type === "tool_use" && this.config.learnerEnabled) {
          await this.routeToLearner(msg);
        } else if (msg.message_type === "session_event") {
          const event = msg.payload?.event;
          if (event === "session_end") {
            await this.markCompleted(msg.id);
            await this.shutdown();
            return;
          }
        }
        await this.markCompleted(msg.id);
      } catch (err: any) {
        log(`Error processing message ${msg.id}: ${err.message}`);
        await this.markFailed(msg.id);
      }
    }
  }

  private async markCompleted(id: number): Promise<void> {
    await this.db.query("UPDATE cognitive_inbox SET status = 'completed' WHERE id = $1", [id]);
  }

  private async markFailed(id: number): Promise<void> {
    await this.db.query("UPDATE cognitive_inbox SET status = 'failed' WHERE id = $1", [id]);
  }

  // ============================================
  // RETRIEVER ROUTING
  // ============================================

  private async routeToRetriever(msg: CognitiveMessage): Promise<void> {
    if (!this.retrieverSessionId) return;
    if (this.retrieverBusy) {
      log("Retriever busy, skipping prompt");
      // Write 'none' result so the hook doesn't hang
      await this.writeRetrievalResult(msg.payload.prompt_hash, "none", null);
      return;
    }

    this.retrieverBusy = true;
    const prompt = msg.payload.prompt;
    const promptHash = msg.payload.prompt_hash;

    // Add to sliding window
    this.slidingWindow.addUserTurn(prompt);

    const retrieverPrompt = `[NEW USER PROMPT]
${prompt}

[CONVERSATION CONTEXT - Last turns]
${this.slidingWindow.format()}

Search memory for relevant context for this user's work. If nothing relevant, respond with SKIP.`;

    try {
      let resultText = "";

      const response = query({
        prompt: retrieverPrompt,
        options: {
          resume: this.retrieverSessionId,
          mcpServers: this.getMcpConfig(),
          allowedTools: [
            "mcp__memory__memory_search",
            "mcp__memory__memory_get_project",
            "mcp__memory__memory_list_projects",
            "mcp__memory__memory_search_errors",
            "mcp__memory__memory_search_patterns",
            "mcp__memory__memory_get_project_learnings",
            "mcp__memory__memory_get_sessions",
            "mcp__memory__memory_get_recent_learnings",
            "mcp__memory__memory_get_preferences",
            "mcp__memory__memory_drilldown_list",
            "mcp__memory__memory_drilldown_get",
            "mcp__memory__memory_drilldown_search",
            "mcp__memory__db_select",
          ],
          permissionMode: "bypassPermissions",
          allowDangerouslySkipPermissions: true,
          maxTurns: 5,
          maxBudgetUsd: 0.50,
          maxThinkingTokens: 1024,
          cwd: this.config.cwd,
        },
      });

      for await (const sdkMsg of response) {
        if (sdkMsg.type === "result") {
          const resultMsg = sdkMsg as SDKResultMessage;
          if (resultMsg.subtype === "success") {
            resultText = resultMsg.result || "";
            log(`Retriever result: ${resultText.length} chars, cost: $${resultMsg.total_cost_usd.toFixed(4)}`);
          } else {
            log(`Retriever error: ${resultMsg.subtype}`);
          }
        }
      }

      // Parse result and write to retrieval_inbox
      const isSkip = !resultText || resultText.trim().toUpperCase() === "SKIP" || resultText.trim().length < 20;

      if (isSkip) {
        await this.writeRetrievalResult(promptHash, "none", null);
      } else {
        await this.writeRetrievalResult(promptHash, "memory_results", resultText);
        this.slidingWindow.addClaudeSummary(`[Retriever found context: ${resultText.slice(0, 100)}...]`);
      }
    } catch (err: any) {
      log(`Retriever error: ${err.message}`);
      await this.writeRetrievalResult(promptHash, "none", null);
    } finally {
      this.retrieverBusy = false;
    }
  }

  private async writeRetrievalResult(promptHash: string, type: string, text: string | null): Promise<void> {
    await this.db.query(
      `INSERT INTO retrieval_inbox (session_id, prompt_hash, context_type, context_text, relevance_score)
       VALUES ($1, $2, $3, $4, $5)`,
      [this.config.sessionId, promptHash, type, text, text ? 0.8 : 0.0]
    );
  }

  // ============================================
  // LEARNER ROUTING
  // ============================================

  private async routeToLearner(msg: CognitiveMessage): Promise<void> {
    if (!this.learnerSessionId) return;
    if (this.learnerBusy) {
      log("Learner busy, queuing will retry on next poll");
      // Re-mark as pending so it gets picked up next poll
      await this.db.query("UPDATE cognitive_inbox SET status = 'pending' WHERE id = $1", [msg.id]);
      return;
    }

    this.learnerBusy = true;
    const payload = msg.payload;

    const inputStr = JSON.stringify(payload.tool_input, null, 2);
    const responseStr = JSON.stringify(payload.tool_response, null, 2);

    const learnerPrompt = `[TOOL OBSERVATION]
Tool: ${payload.tool_name}
Input: ${inputStr.slice(0, 2000)}
Result: ${responseStr.slice(0, 2000)}

Analyze this tool call. If it contains a valuable learning, error solution, or reusable pattern, save it to memory (check for duplicates first). If trivial, respond with SKIP.`;

    try {
      const response = query({
        prompt: learnerPrompt,
        options: {
          resume: this.learnerSessionId,
          mcpServers: this.getMcpConfig(),
          allowedTools: [
            "mcp__memory__memory_search",
            "mcp__memory__memory_save_learning",
            "mcp__memory__memory_save_error",
            "mcp__memory__memory_save_pattern",
            "mcp__memory__memory_drilldown_save",
            "mcp__memory__memory_drilldown_search",
            "mcp__memory__memory_get_project",
            "mcp__memory__memory_get_recent_learnings",
            "mcp__memory__db_select",
            "mcp__memory__db_execute",
            "Bash",
          ],
          permissionMode: "bypassPermissions",
          allowDangerouslySkipPermissions: true,
          maxTurns: 8,
          maxBudgetUsd: 0.50,
          cwd: this.config.cwd,
        },
      });

      for await (const sdkMsg of response) {
        if (sdkMsg.type === "result") {
          const resultMsg = sdkMsg as SDKResultMessage;
          if (resultMsg.subtype === "success") {
            const summary = (resultMsg.result || "SKIP").slice(0, 200);
            log(`Learner: ${summary}, cost: $${resultMsg.total_cost_usd.toFixed(4)}`);
            this.slidingWindow.addClaudeSummary(`[Claude used ${payload.tool_name}: ${summary}]`);
          } else {
            log(`Learner error: ${resultMsg.subtype}`);
          }
        }
      }
    } catch (err: any) {
      log(`Learner error: ${err.message}`);
    } finally {
      this.learnerBusy = false;
    }
  }

  // ============================================
  // COMPACTOR
  // ============================================

  private async initCompactor(): Promise<void> {
    log("Initializing Compactor session...");
    const promptPath = path.join(__dirname, "..", "prompts", "compactor_system.md");
    let systemPrompt: string;
    try {
      systemPrompt = fs.readFileSync(promptPath, "utf-8");
    } catch {
      systemPrompt = "You are a session state compactor. Summarize conversation context into a structured document with sections: IDENTITY, TASK TREE, KEY DECISIONS, WORKING CONTEXT, CONVERSATION DYNAMICS.";
    }

    try {
      const response = query({
        prompt: systemPrompt + "\n\n[INIT] Compactor session initialized. Waiting for conversation chunks. Respond with READY.",
        options: {
          model: this.config.compactorModel,
          permissionMode: "bypassPermissions",
          allowDangerouslySkipPermissions: true,
          maxTurns: 1,
          maxBudgetUsd: 0.05,
          maxThinkingTokens: 1024,
          cwd: this.config.cwd,
          persistSession: true,
        },
      });

      for await (const msg of response) {
        if (msg.type === "system" && "subtype" in msg && msg.subtype === "init") {
          this.compactorSessionId = msg.session_id;
          log(`Compactor session ID: ${this.compactorSessionId}`);
        }
      }
    } catch (err: any) {
      log(`Compactor init error: ${err.message}`);
    }
  }

  private startCompactorMonitor(): void {
    // Check transcript size periodically
    this.compactorTimer = setInterval(async () => {
      if (!this.running || this.compactorBusy || !this.compactorSessionId) return;
      try {
        await this.checkAndRunCompactor();
      } catch (err: any) {
        log(`Compactor monitor error: ${err.message}`);
      }
    }, this.config.compactorCheckIntervalMs);
  }

  private async checkAndRunCompactor(): Promise<void> {
    const transcriptPath = this.config.transcriptPath;
    if (!transcriptPath) {
      log("Compactor check: no transcript path configured");
      return;
    }

    let fileSize: number;
    try {
      const stat = fs.statSync(transcriptPath);
      fileSize = stat.size;
    } catch (err: any) {
      log(`Compactor check: transcript not accessible: ${err.message}`);
      return;
    }

    const estimatedTokens = Math.floor(fileSize / 6);
    const tokensSinceLastCompact = estimatedTokens - this.lastCompactedSize;

    if (tokensSinceLastCompact < this.config.compactorTokenThreshold) return;

    log(`Compactor triggered: ~${estimatedTokens} tokens total, ~${tokensSinceLastCompact} since last compact`);
    await this.runCompactor(transcriptPath, estimatedTokens);
  }

  private async runCompactor(transcriptPath: string, currentTokenEstimate: number): Promise<void> {
    if (!this.compactorSessionId) return;
    this.compactorBusy = true;

    try {
      // 1. Read transcript and extract user/assistant messages
      const rawContent = fs.readFileSync(transcriptPath, "utf-8");
      const lines = rawContent.split("\n").filter((l) => l.trim());

      // Extract ALL user/assistant messages from the transcript
      const allChunks: { text: string; byteOffset: number }[] = [];
      let byteOffset = 0;

      for (let i = 0; i < lines.length; i++) {
        const lineBytes = lines[i].length + 1;
        try {
          const entry = JSON.parse(lines[i]);
          if (entry.type === "user" && entry.message?.content) {
            const content = typeof entry.message.content === "string"
              ? entry.message.content
              : JSON.stringify(entry.message.content);
            allChunks.push({ text: `[USER] ${content.slice(0, 3000)}`, byteOffset });
          } else if (entry.type === "assistant" && entry.message?.content) {
            const blocks = entry.message.content;
            if (Array.isArray(blocks)) {
              const text = blocks
                .filter((b: any) => b.type === "text")
                .map((b: any) => b.text)
                .join("\n");
              if (text) {
                allChunks.push({ text: `[CLAUDE] ${text.slice(0, 3000)}`, byteOffset });
              }
            }
          }
        } catch {
          // Skip malformed lines (progress entries, etc.)
        }
        byteOffset += lineBytes;
      }

      log(`Compactor: ${lines.length} lines, ${allChunks.length} conversation chunks`);

      // 2. Take the LAST ~30k chars of conversation chunks (not raw file bytes)
      //    The sliding window applies to extracted conversation content, not raw JSONL
      //    (because JSONL is dominated by tool progress entries, not conversation)
      const maxChars = 30000; // ~7.5k tokens max to send to agent

      // Work backwards from the end to collect up to maxChars
      const conversationChunks: string[] = [];
      let charsCollected = 0;

      for (let i = allChunks.length - 1; i >= 0; i--) {
        if (charsCollected + allChunks[i].text.length > maxChars) break;
        conversationChunks.unshift(allChunks[i].text);
        charsCollected += allChunks[i].text.length;
      }

      if (conversationChunks.length === 0) {
        log("Compactor: no conversation content found");
        this.compactorBusy = false;
        return;
      }

      // 2. Get previous state from DB
      const prevResult = await this.db.query(
        `SELECT state_text, version FROM session_state
         WHERE session_id = $1
         ORDER BY version DESC LIMIT 1`,
        [this.config.sessionId]
      );

      const previousState = prevResult.rows.length > 0 ? prevResult.rows[0].state_text : "";
      const previousVersion = prevResult.rows.length > 0 ? prevResult.rows[0].version : 0;
      this.compactorVersion = previousVersion + 1;

      // 3. Build prompt for Compactor
      const compactorPrompt = previousState
        ? `[UPDATE REQUEST - Version ${this.compactorVersion}]

[PREVIOUS STATE]
${previousState}

[NEW CONVERSATION SINCE LAST UPDATE]
${conversationChunks.join("\n\n")}

Update the session state document. Follow the update rules: append KEY DECISIONS, replace WORKING CONTEXT, update TASK TREE and CONVERSATION DYNAMICS.`
        : `[INITIAL STATE REQUEST - Version 1]

[CONVERSATION]
${conversationChunks.join("\n\n")}

Build the initial session state document from this conversation.`;

      // 4. Send to Compactor agent
      const response = query({
        prompt: compactorPrompt,
        options: {
          resume: this.compactorSessionId,
          permissionMode: "bypassPermissions",
          allowDangerouslySkipPermissions: true,
          maxTurns: 1,
          maxBudgetUsd: 0.30,
          maxThinkingTokens: 2048,
          cwd: this.config.cwd,
        },
      });

      let stateText = "";
      for await (const sdkMsg of response) {
        if (sdkMsg.type === "result") {
          const resultMsg = sdkMsg as SDKResultMessage;
          if (resultMsg.subtype === "success") {
            stateText = resultMsg.result || "";
            log(`Compactor v${this.compactorVersion}: ${stateText.length} chars, cost: $${resultMsg.total_cost_usd.toFixed(4)}`);
          } else {
            log(`Compactor error: ${resultMsg.subtype}`);
            log(`Compactor error details: ${JSON.stringify(resultMsg).slice(0, 500)}`);
          }
        }
      }

      if (!stateText || stateText.length < 50) {
        log("Compactor: empty or too short result, skipping save");
        return;
      }

      // 5. Save raw tail (last ~40k tokens of conversation) to a file
      const tailChunks = conversationChunks.slice(-Math.ceil(conversationChunks.length / 2));
      const rawTailDir = path.join(path.dirname(transcriptPath), "compactor_tails");
      try { fs.mkdirSync(rawTailDir, { recursive: true }); } catch { /* exists */ }
      const rawTailPath = path.join(rawTailDir, `${this.config.sessionId}_v${this.compactorVersion}.txt`);
      fs.writeFileSync(rawTailPath, tailChunks.join("\n\n"), "utf-8");

      // 6. Save state to DB
      await this.db.query(
        `INSERT INTO session_state (session_id, project_slug, state_text, raw_tail_path, token_estimate, version)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          this.config.sessionId,
          this.config.projectSlug,
          stateText,
          rawTailPath,
          currentTokenEstimate,
          this.compactorVersion,
        ]
      );

      this.lastCompactedSize = currentTokenEstimate;
      log(`Compactor: saved state v${this.compactorVersion} to DB + raw tail to ${rawTailPath}`);
    } catch (err: any) {
      log(`Compactor error: ${err.message}`);
      if (err.stack) log(`Compactor stack: ${err.stack.slice(0, 500)}`);
    } finally {
      this.compactorBusy = false;
    }
  }

  // ============================================
  // SHUTDOWN
  // ============================================

  private async checkShutdownSignal(): Promise<void> {
    const result = await this.db.query(
      "SELECT status FROM orchestrator_state WHERE session_id = $1",
      [this.config.sessionId]
    );
    if (result.rows.length > 0 && result.rows[0].status === "stopping") {
      await this.shutdown();
    }
  }

  async shutdown(): Promise<void> {
    if (!this.running) return;
    this.running = false;

    log("Shutting down...");

    // Clear all intervals immediately
    if (this.pollTimer) clearInterval(this.pollTimer);
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    if (this.compactorTimer) clearInterval(this.compactorTimer);
    this.pollTimer = undefined;
    this.heartbeatTimer = undefined;
    this.compactorTimer = undefined;

    // Update state — use a short timeout to avoid hanging
    const shutdownTimeout = setTimeout(() => {
      log("Shutdown timeout — force exit");
      process.exit(0);
    }, 5000);

    try {
      await this.db.query(
        `UPDATE orchestrator_state SET status = 'stopped', stopped_at = CURRENT_TIMESTAMP
         WHERE session_id = $1`,
        [this.config.sessionId]
      );
    } catch {
      /* best effort */
    }

    // Fail pending messages
    try {
      await this.db.query(
        `UPDATE cognitive_inbox SET status = 'failed'
         WHERE session_id = $1 AND status IN ('pending', 'processing')`,
        [this.config.sessionId]
      );
    } catch {
      /* best effort */
    }

    try {
      await this.db.end();
    } catch {
      /* best effort */
    }

    clearTimeout(shutdownTimeout);
    log("Shutdown complete.");
    process.exit(0);
  }
}

// ============================================
// LOGGING
// ============================================

function log(message: string): void {
  const ts = new Date().toISOString();
  console.log(`[${ts}] [aidam-orchestrator] ${message}`);
}

// ============================================
// CLI ENTRY POINT
// ============================================

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const getArg = (name: string, defaultVal: string = ""): string => {
    const arg = args.find((a) => a.startsWith(`--${name}=`));
    return arg ? arg.split("=").slice(1).join("=") : defaultVal;
  };

  const sessionId = getArg("session-id");
  if (!sessionId) {
    console.error("Error: --session-id is required");
    process.exit(1);
  }

  const config: OrchestratorConfig = {
    sessionId,
    cwd: getArg("cwd", process.cwd()),
    retrieverEnabled: getArg("retriever", "on") !== "off",
    learnerEnabled: getArg("learner", "on") !== "off",
    compactorEnabled: getArg("compactor", "on") !== "off",
    pollIntervalMs: 2000,
    heartbeatIntervalMs: 30000,
    compactorCheckIntervalMs: 30000,        // Check every 30s
    compactorTokenThreshold: 20000,          // Compact every ~20k new tokens
    retrieverModel: "claude-haiku-4-5-20251001",
    learnerModel: "claude-haiku-4-5-20251001",
    compactorModel: "claude-haiku-4-5-20251001",
    mcpServerScript: getArg("mcp-server", path.join(__dirname, "..", "mcp", "memory_mcp_server.py")),
    pythonPath: getArg("python-path", process.env.PYTHON_PATH || "C:/Users/user/AppData/Local/Programs/Python/Python312/python.exe"),
    transcriptPath: getArg("transcript-path", ""),
    projectSlug: getArg("project-slug", ""),
    lastCompactSize: parseInt(getArg("last-compact-size", "0"), 10) || 0,
  };

  log(`Config: session=${config.sessionId}, retriever=${config.retrieverEnabled}, learner=${config.learnerEnabled}, compactor=${config.compactorEnabled}`);
  if (config.transcriptPath) {
    log(`Transcript path: ${config.transcriptPath}`);
    try {
      const stat = fs.statSync(config.transcriptPath);
      log(`Transcript exists: ${stat.size} bytes`);
    } catch (err: any) {
      log(`Transcript NOT accessible: ${err.message}`);
    }
  } else {
    log(`WARNING: No transcript path provided!`);
  }

  const orchestrator = new Orchestrator(config);

  try {
    await orchestrator.start();
    // Keep alive - the polling intervals keep the event loop running
  } catch (err: any) {
    log(`Fatal error: ${err.message}`);
    // Record crash
    try {
      const crashDb = new Client(DB_CONFIG);
      await crashDb.connect();
      await crashDb.query(
        `UPDATE orchestrator_state SET status = 'crashed', error_message = $2, stopped_at = CURRENT_TIMESTAMP
         WHERE session_id = $1`,
        [config.sessionId, String(err)]
      );
      await crashDb.end();
    } catch {
      /* best effort */
    }
    process.exit(1);
  }
}

main();
