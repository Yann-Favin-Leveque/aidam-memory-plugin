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
  pollIntervalMs: number;
  heartbeatIntervalMs: number;
  retrieverModel: string;
  learnerModel: string;
  mcpServerScript: string;
  pythonPath: string;
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
  password: "***REDACTED***",
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
  private running: boolean = false;
  private slidingWindow: SlidingWindow;
  private pollTimer: ReturnType<typeof setInterval> | undefined;
  private heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  private retrieverBusy: boolean = false;
  private learnerBusy: boolean = false;

  constructor(config: OrchestratorConfig) {
    this.config = config;
    this.db = new Client(DB_CONFIG);
    this.slidingWindow = new SlidingWindow(5);
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

    // Graceful shutdown handlers
    process.on("SIGTERM", () => this.shutdown());
    process.on("SIGINT", () => this.shutdown());
    process.on("uncaughtException", (err) => {
      log(`Uncaught exception: ${err.message}`);
      this.shutdown();
    });

    log(`Orchestrator running. Retriever: ${this.retrieverSessionId || "disabled"}, Learner: ${this.learnerSessionId || "disabled"}`);
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
          maxBudgetUsd: 0.15,
          maxThinkingTokens: 1024,
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
          maxBudgetUsd: 0.25,
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

    if (this.pollTimer) clearInterval(this.pollTimer);
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);

    // Update state
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
    pollIntervalMs: 2000,
    heartbeatIntervalMs: 30000,
    retrieverModel: "claude-haiku-4-5-20251001",
    learnerModel: "claude-sonnet-4-6",
    mcpServerScript: "C:/Users/user/.claude/tools/python/memory_mcp_server.py",
    pythonPath: "C:/Users/user/AppData/Local/Programs/Python/Python312/python.exe",
  };

  log(`Config: session=${config.sessionId}, retriever=${config.retrieverEnabled}, learner=${config.learnerEnabled}`);

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
