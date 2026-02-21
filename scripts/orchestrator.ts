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
  curatorEnabled: boolean;
  pollIntervalMs: number;
  heartbeatIntervalMs: number;
  compactorCheckIntervalMs: number;
  compactorTokenThreshold: number;
  retrieverModel: string;
  learnerModel: string;
  compactorModel: string;
  curatorModel: string;
  curatorIntervalMs: number;
  mcpServerScript: string;
  pythonPath: string;
  transcriptPath: string;
  projectSlug: string;
  lastCompactSize: number;
  // Budget config
  retrieverABudget: number;
  retrieverBBudget: number;
  learnerBudget: number;
  compactorBudget: number;
  curatorBudget: number;
  sessionBudget: number;
  // Batch config
  batchWindowMs: number;
  batchMinSize: number;
  batchMaxSize: number;
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
  private retrieverASessionId: string | undefined;  // Keyword retriever
  private retrieverBSessionId: string | undefined;  // Cascade retriever
  private learnerSessionId: string | undefined;
  private compactorSessionId: string | undefined;
  private curatorSessionId: string | undefined;
  private running: boolean = false;
  private slidingWindow: SlidingWindow;
  private pollTimer: ReturnType<typeof setInterval> | undefined;
  private heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  private compactorTimer: ReturnType<typeof setInterval> | undefined;
  private curatorTimer: ReturnType<typeof setInterval> | undefined;
  private retrieverABusy: boolean = false;
  private retrieverBBusy: boolean = false;
  private learnerBusy: boolean = false;
  private compactorBusy: boolean = false;
  private curatorBusy: boolean = false;
  private lastCompactedSize: number = 0;
  private compactorVersion: number = 0;
  private totalCostUsd: number = 0;
  private lastCuratorRun: number = 0;
  // Learner batch buffer
  private learnerBuffer: CognitiveMessage[] = [];
  private learnerBatchTimer: ReturnType<typeof setTimeout> | undefined;

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
      initPromises.push(this.initRetrieverA());
      initPromises.push(this.initRetrieverB());
    }
    if (this.config.learnerEnabled) {
      initPromises.push(this.initLearner());
    }
    if (this.config.compactorEnabled) {
      initPromises.push(this.initCompactor());
    }
    if (this.config.curatorEnabled) {
      initPromises.push(this.initCurator());
    }
    await Promise.all(initPromises);

    // Mark as running
    await this.db.query(
      `UPDATE orchestrator_state SET status = 'running',
         retriever_session_id = $2, learner_session_id = $3,
         last_heartbeat_at = CURRENT_TIMESTAMP
       WHERE session_id = $1`,
      [this.config.sessionId, this.retrieverASessionId || this.retrieverBSessionId || null, this.learnerSessionId || null]
    );

    this.running = true;
    this.startPolling();
    this.startHeartbeat();
    if (this.config.compactorEnabled) {
      this.startCompactorMonitor();
    }
    if (this.config.curatorEnabled) {
      this.startCuratorSchedule();
    }

    // Graceful shutdown handlers
    process.on("SIGTERM", () => this.shutdown());
    process.on("SIGINT", () => this.shutdown());
    process.on("uncaughtException", (err) => {
      log(`Uncaught exception: ${err.message}`);
      this.shutdown();
    });

    log(`Orchestrator running. RetrieverA: ${this.retrieverASessionId || "disabled"}, RetrieverB: ${this.retrieverBSessionId || "disabled"}, Learner: ${this.learnerSessionId || "disabled"}, Compactor: ${this.compactorSessionId || "disabled"}, Curator: ${this.curatorSessionId || "disabled"}`);
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

  // Shared tools available to both retrievers
  private get retrieverBaseTools(): string[] {
    return [
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
    ];
  }

  // Additional tools for cascade retriever (knowledge_index)
  private get retrieverCascadeTools(): string[] {
    return [
      ...this.retrieverBaseTools,
      "mcp__memory__memory_index_search",
      "mcp__memory__memory_index_domains",
    ];
  }

  private async initRetrieverA(): Promise<void> {
    log("Initializing Retriever A (Keyword)...");
    const promptPath = path.join(__dirname, "..", "prompts", "retriever_keyword_system.md");
    let systemPrompt: string;
    try {
      systemPrompt = fs.readFileSync(promptPath, "utf-8");
    } catch {
      systemPrompt = "You are a keyword memory retrieval agent. Search the MCP memory tools for relevant context when given a user prompt. Use parallel tool calls. Respond with SKIP if nothing relevant.";
    }

    try {
      const response = query({
        prompt: systemPrompt + "\n\n[INIT] Keyword Retriever session initialized. Waiting for queries. Respond with READY.",
        options: {
          model: this.config.retrieverModel,
          mcpServers: this.getMcpConfig(),
          allowedTools: this.retrieverBaseTools,
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
          this.retrieverASessionId = msg.session_id;
          log(`Retriever A session ID: ${this.retrieverASessionId}`);
        }
      }
    } catch (err: any) {
      log(`Retriever A init error: ${err.message}`);
    }
  }

  private async initRetrieverB(): Promise<void> {
    log("Initializing Retriever B (Cascade)...");
    const promptPath = path.join(__dirname, "..", "prompts", "retriever_cascade_system.md");
    let systemPrompt: string;
    try {
      systemPrompt = fs.readFileSync(promptPath, "utf-8");
    } catch {
      systemPrompt = "You are a cascade memory retrieval agent. Search knowledge_index first, then drill down. Use parallel tool calls. Respond with SKIP if nothing relevant.";
    }

    try {
      const response = query({
        prompt: systemPrompt + "\n\n[INIT] Cascade Retriever session initialized. Waiting for queries. Respond with READY.",
        options: {
          model: this.config.retrieverModel,
          mcpServers: this.getMcpConfig(),
          allowedTools: this.retrieverCascadeTools,
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
          this.retrieverBSessionId = msg.session_id;
          log(`Retriever B session ID: ${this.retrieverBSessionId}`);
        }
      }
    } catch (err: any) {
      log(`Retriever B init error: ${err.message}`);
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
            "mcp__memory__memory_index_upsert",
            "mcp__memory__memory_index_search",
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
          await this.markCompleted(msg.id);
        } else if (msg.message_type === "tool_use" && this.config.learnerEnabled) {
          // Buffer tool_use messages for batch processing
          this.learnerBuffer.push(msg);
          this.checkLearnerBatchFlush();
        } else if (msg.message_type === "curator_trigger") {
          await this.runCurator();
          await this.markCompleted(msg.id);
        } else if (msg.message_type === "compactor_trigger") {
          if (this.compactorSessionId && this.config.transcriptPath) {
            log("Compactor triggered on-demand (smart-compact)");
            const stat = fs.statSync(this.config.transcriptPath);
            await this.runCompactor(this.config.transcriptPath, Math.floor(stat.size / 6));
          } else {
            log("Compactor trigger ignored: no compactor session or transcript path");
          }
          await this.markCompleted(msg.id);
        } else if (msg.message_type === "session_event") {
          const event = msg.payload?.event;
          if (event === "session_end") {
            // Flush any remaining buffered observations before shutdown
            await this.flushLearnerBatch();
            await this.markCompleted(msg.id);
            await this.shutdown();
            return;
          }
          await this.markCompleted(msg.id);
        } else {
          await this.markCompleted(msg.id);
        }
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

  // Track what has been injected this session for retriever awareness
  private injectionHistory: string[] = [];

  private async routeToRetriever(msg: CognitiveMessage): Promise<void> {
    const prompt = msg.payload.prompt;
    const promptHash = msg.payload.prompt_hash;

    // Add to sliding window
    this.slidingWindow.addUserTurn(prompt);

    // If both retrievers are busy, write 'none' so the hook doesn't hang
    if (this.retrieverABusy && this.retrieverBBusy) {
      log("Both retrievers busy, skipping prompt");
      await this.writeRetrievalResult(promptHash, "none", null);
      return;
    }

    // Build the injection history context
    const injectionCtx = this.injectionHistory.length > 0
      ? `\n\n[PREVIOUSLY INJECTED THIS SESSION — avoid repeating]\n${this.injectionHistory.slice(-5).map((s, i) => `${i + 1}. ${s}`).join("\n")}`
      : "";

    const retrieverPrompt = `[NEW USER PROMPT]
${prompt}

[CONVERSATION CONTEXT - Last turns]
${this.slidingWindow.format()}${injectionCtx}

Search memory for relevant context for this user's work. If nothing relevant, respond with SKIP.`;

    // Launch both retrievers in parallel
    const promiseA = this.retrieverASessionId && !this.retrieverABusy
      ? this.routeToRetrieverA(retrieverPrompt, promptHash)
      : Promise.resolve();
    const promiseB = this.retrieverBSessionId && !this.retrieverBBusy
      ? this.routeToRetrieverB(retrieverPrompt, promptHash)
      : Promise.resolve();

    await Promise.allSettled([promiseA, promiseB]);

    // If neither produced a result, write 'none' so hook doesn't hang forever
    // (each individual method already writes its own result, but if both were skipped/busy)
  }

  private async routeToRetrieverA(retrieverPrompt: string, promptHash: string): Promise<void> {
    this.retrieverABusy = true;

    try {
      let resultText = "";

      const response = query({
        prompt: retrieverPrompt,
        options: {
          resume: this.retrieverASessionId!,
          mcpServers: this.getMcpConfig(),
          allowedTools: this.retrieverBaseTools,
          permissionMode: "bypassPermissions",
          allowDangerouslySkipPermissions: true,
          maxTurns: 15,
          maxBudgetUsd: this.config.retrieverABudget,
          maxThinkingTokens: 1024,
          cwd: this.config.cwd,
        },
      });

      for await (const sdkMsg of response) {
        if (sdkMsg.type === "result") {
          const resultMsg = sdkMsg as SDKResultMessage;
          if (resultMsg.subtype === "success") {
            resultText = resultMsg.result || "";
            log(`Retriever A result: ${resultText.length} chars, cost: $${resultMsg.total_cost_usd.toFixed(4)}`);
            this.totalCostUsd += resultMsg.total_cost_usd;
          } else {
            log(`Retriever A error: ${resultMsg.subtype}`);
          }
        }
      }

      const isSkip = !resultText || resultText.trim().toUpperCase() === "SKIP" || resultText.trim().length < 20;

      if (isSkip) {
        await this.writeRetrievalResult(promptHash, "none", null, "retriever_a");
      } else {
        await this.writeRetrievalResult(promptHash, "memory_results", resultText, "retriever_a");
        this.slidingWindow.addClaudeSummary(`[Retriever A found: ${resultText.slice(0, 100)}...]`);
        this.injectionHistory.push(resultText.slice(0, 150));

        // Notify Retriever B if still working (best-effort)
        if (this.retrieverBBusy && this.retrieverBSessionId) {
          this.notifyPeer("B", resultText).catch(() => {});
        }
      }
    } catch (err: any) {
      log(`Retriever A error: ${err.message}`);
      await this.writeRetrievalResult(promptHash, "none", null, "retriever_a");
    } finally {
      this.retrieverABusy = false;
      this.checkSessionBudget();
    }
  }

  private async routeToRetrieverB(retrieverPrompt: string, promptHash: string): Promise<void> {
    this.retrieverBBusy = true;

    try {
      let resultText = "";

      const response = query({
        prompt: retrieverPrompt,
        options: {
          resume: this.retrieverBSessionId!,
          mcpServers: this.getMcpConfig(),
          allowedTools: this.retrieverCascadeTools,
          permissionMode: "bypassPermissions",
          allowDangerouslySkipPermissions: true,
          maxTurns: 15,
          maxBudgetUsd: this.config.retrieverBBudget,
          maxThinkingTokens: 1024,
          cwd: this.config.cwd,
        },
      });

      for await (const sdkMsg of response) {
        if (sdkMsg.type === "result") {
          const resultMsg = sdkMsg as SDKResultMessage;
          if (resultMsg.subtype === "success") {
            resultText = resultMsg.result || "";
            log(`Retriever B result: ${resultText.length} chars, cost: $${resultMsg.total_cost_usd.toFixed(4)}`);
            this.totalCostUsd += resultMsg.total_cost_usd;
          } else {
            log(`Retriever B error: ${resultMsg.subtype}`);
          }
        }
      }

      const isSkip = !resultText || resultText.trim().toUpperCase() === "SKIP" || resultText.trim().length < 20;

      if (isSkip) {
        await this.writeRetrievalResult(promptHash, "none", null, "retriever_b");
      } else {
        await this.writeRetrievalResult(promptHash, "memory_results", resultText, "retriever_b");
        this.slidingWindow.addClaudeSummary(`[Retriever B found: ${resultText.slice(0, 100)}...]`);
        this.injectionHistory.push(resultText.slice(0, 150));

        // Notify Retriever A if still working (best-effort)
        if (this.retrieverABusy && this.retrieverASessionId) {
          this.notifyPeer("A", resultText).catch(() => {});
        }
      }
    } catch (err: any) {
      log(`Retriever B error: ${err.message}`);
      await this.writeRetrievalResult(promptHash, "none", null, "retriever_b");
    } finally {
      this.retrieverBBusy = false;
      this.checkSessionBudget();
    }
  }

  private async notifyPeer(target: "A" | "B", injectedText: string): Promise<void> {
    const sessionId = target === "A" ? this.retrieverASessionId : this.retrieverBSessionId;
    if (!sessionId) return;

    const notification = `[PEER_INJECTED] The other retriever already injected: "${injectedText.slice(0, 200)}..."
Check what's already covered. Focus on COMPLEMENTARY information or respond SKIP if already sufficient.`;

    try {
      const response = query({
        prompt: notification,
        options: {
          resume: sessionId,
          mcpServers: this.getMcpConfig(),
          allowedTools: target === "A" ? this.retrieverBaseTools : this.retrieverCascadeTools,
          permissionMode: "bypassPermissions",
          allowDangerouslySkipPermissions: true,
          maxTurns: 1,
          maxBudgetUsd: 0.02,
          cwd: this.config.cwd,
        },
      });
      for await (const _ of response) {} // drain
    } catch {
      // Best effort — race conditions are OK
    }
  }

  // Clear injection history (called on compactor clear/reset)
  clearInjectionHistory(): void {
    this.injectionHistory = [];
  }

  private async writeRetrievalResult(promptHash: string, type: string, text: string | null, source?: string): Promise<void> {
    await this.db.query(
      `INSERT INTO retrieval_inbox (session_id, prompt_hash, context_type, context_text, relevance_score, source)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [this.config.sessionId, promptHash, type, text, text ? 0.8 : 0.0, source || "retriever"]
    );
  }

  // ============================================
  // LEARNER ROUTING
  // ============================================

  // ============================================
  // LEARNER BATCH PROCESSING
  // ============================================

  private checkLearnerBatchFlush(): void {
    // Flush immediately if buffer is full
    if (this.learnerBuffer.length >= this.config.batchMaxSize) {
      this.flushLearnerBatch();
      return;
    }
    // Start batch timer if not already running
    if (!this.learnerBatchTimer && this.learnerBuffer.length > 0) {
      this.learnerBatchTimer = setTimeout(() => {
        this.learnerBatchTimer = undefined;
        this.flushLearnerBatch();
      }, this.config.batchWindowMs);
    }
    // Flush early if we hit min size
    if (this.learnerBuffer.length >= this.config.batchMinSize && this.learnerBatchTimer) {
      clearTimeout(this.learnerBatchTimer);
      this.learnerBatchTimer = undefined;
      this.flushLearnerBatch();
    }
  }

  private async flushLearnerBatch(): Promise<void> {
    if (this.learnerBuffer.length === 0) return;

    if (this.learnerBusy) {
      // Re-queue all buffered messages for next poll
      for (const msg of this.learnerBuffer) {
        await this.db.query("UPDATE cognitive_inbox SET status = 'pending' WHERE id = $1", [msg.id]);
      }
      this.learnerBuffer = [];
      return;
    }

    const batch = this.learnerBuffer.splice(0, this.config.batchMaxSize);

    if (batch.length === 1) {
      // Single message — use normal routing
      await this.routeToLearner(batch[0]);
      await this.markCompleted(batch[0].id);
      return;
    }

    // Batch mode: format all observations as one prompt
    log(`Batch: ${batch.length} observations → Learner`);
    this.learnerBusy = true;

    const observations = batch.map((msg, i) => {
      const p = msg.payload;
      const inputStr = JSON.stringify(p.tool_input, null, 2);
      const responseStr = JSON.stringify(p.tool_response, null, 2);
      return `### Observation ${i + 1}\nTool: ${p.tool_name}\nInput: ${inputStr.slice(0, 1500)}\nResult: ${responseStr.slice(0, 1500)}`;
    }).join("\n\n");

    const learnerPrompt = `[BATCH TOOL OBSERVATIONS — ${batch.length} items]

${observations}

Analyze ALL observations together. Look for patterns BETWEEN them. For each observation worth saving, save to memory (check for duplicates first). If nothing worth saving, respond SKIP.`;

    try {
      const response = query({
        prompt: learnerPrompt,
        options: {
          resume: this.learnerSessionId!,
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
            "mcp__memory__memory_index_upsert",
            "mcp__memory__memory_index_search",
            "mcp__memory__db_select",
            "mcp__memory__db_execute",
            "Bash",
          ],
          permissionMode: "bypassPermissions",
          allowDangerouslySkipPermissions: true,
          maxTurns: 8,
          maxBudgetUsd: this.config.learnerBudget,
          cwd: this.config.cwd,
        },
      });

      for await (const sdkMsg of response) {
        if (sdkMsg.type === "result") {
          const resultMsg = sdkMsg as SDKResultMessage;
          if (resultMsg.subtype === "success") {
            const summary = (resultMsg.result || "SKIP").slice(0, 200);
            log(`Learner (batch ${batch.length}): ${summary}, cost: $${resultMsg.total_cost_usd.toFixed(4)}`);
            this.totalCostUsd += resultMsg.total_cost_usd;
          } else {
            log(`Learner batch error: ${resultMsg.subtype}`);
          }
        }
      }

      // Mark all batch messages as completed
      for (const msg of batch) {
        await this.markCompleted(msg.id);
      }
    } catch (err: any) {
      log(`Learner batch error: ${err.message}`);
      for (const msg of batch) {
        await this.markFailed(msg.id);
      }
    } finally {
      this.learnerBusy = false;
      this.checkSessionBudget();
    }
  }

  private async checkSessionBudget(): Promise<void> {
    if (this.config.sessionBudget > 0 && this.totalCostUsd >= this.config.sessionBudget) {
      log(`Session budget exhausted: $${this.totalCostUsd.toFixed(4)} >= $${this.config.sessionBudget}`);
      await this.shutdown();
    }
  }

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
            "mcp__memory__memory_index_upsert",
            "mcp__memory__memory_index_search",
            "mcp__memory__db_select",
            "mcp__memory__db_execute",
            "Bash",
          ],
          permissionMode: "bypassPermissions",
          allowDangerouslySkipPermissions: true,
          maxTurns: 8,
          maxBudgetUsd: this.config.learnerBudget,
          cwd: this.config.cwd,
        },
      });

      for await (const sdkMsg of response) {
        if (sdkMsg.type === "result") {
          const resultMsg = sdkMsg as SDKResultMessage;
          if (resultMsg.subtype === "success") {
            const summary = (resultMsg.result || "SKIP").slice(0, 200);
            log(`Learner: ${summary}, cost: $${resultMsg.total_cost_usd.toFixed(4)}`);
            this.totalCostUsd += resultMsg.total_cost_usd;
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
      this.checkSessionBudget();
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

      // 2. Get previous state from DB (needed to determine context window size)
      const prevResult = await this.db.query(
        `SELECT state_text, version FROM session_state
         WHERE session_id = $1
         ORDER BY version DESC LIMIT 1`,
        [this.config.sessionId]
      );

      const previousState = prevResult.rows.length > 0 ? prevResult.rows[0].state_text : "";
      const previousVersion = prevResult.rows.length > 0 ? prevResult.rows[0].version : 0;
      this.compactorVersion = previousVersion + 1;

      // 3. Take the LAST N chars of conversation chunks (sliding window)
      //    First compact of session (no previous state) → 45k chars (~11k tokens)
      //    Subsequent compacts (has previous state) → 25k chars (~6k tokens)
      const maxChars = previousVersion === 0 ? 45000 : 25000;

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

      log(`Compactor: using ${maxChars} char window (v${this.compactorVersion}, prev=${previousVersion}), collected ${charsCollected} chars from ${conversationChunks.length} chunks`);

      // 4. Build prompt for Compactor
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

      // 5. Send to Compactor agent
      const response = query({
        prompt: compactorPrompt,
        options: {
          resume: this.compactorSessionId,
          permissionMode: "bypassPermissions",
          allowDangerouslySkipPermissions: true,
          maxTurns: 1,
          maxBudgetUsd: this.config.compactorBudget,
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

      // Clear injection history — compaction means the main session context was reset
      this.clearInjectionHistory();
      log("Compactor: cleared injection history");
    } catch (err: any) {
      log(`Compactor error: ${err.message}`);
      if (err.stack) log(`Compactor stack: ${err.stack.slice(0, 500)}`);
    } finally {
      this.compactorBusy = false;
    }
  }

  // ============================================
  // CURATOR
  // ============================================

  private async initCurator(): Promise<void> {
    log("Initializing Curator session...");
    const promptPath = path.join(__dirname, "..", "prompts", "curator_system.md");
    let systemPrompt: string;
    try {
      systemPrompt = fs.readFileSync(promptPath, "utf-8");
    } catch {
      systemPrompt = "You are a memory database curator. Merge duplicates, archive stale entries, detect contradictions, and consolidate patterns. Report all actions.";
    }

    try {
      const response = query({
        prompt: systemPrompt + "\n\n[INIT] Curator session initialized. Waiting for maintenance triggers. Respond with READY.",
        options: {
          model: this.config.curatorModel,
          mcpServers: this.getMcpConfig(),
          allowedTools: [
            "mcp__memory__memory_search",
            "mcp__memory__memory_save_learning",
            "mcp__memory__memory_save_pattern",
            "mcp__memory__memory_get_recent_learnings",
            "mcp__memory__memory_search_errors",
            "mcp__memory__memory_search_patterns",
            "mcp__memory__db_select",
            "mcp__memory__db_execute",
          ],
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
          this.curatorSessionId = msg.session_id;
          log(`Curator session ID: ${this.curatorSessionId}`);
        }
      }
    } catch (err: any) {
      log(`Curator init error: ${err.message}`);
    }
  }

  private startCuratorSchedule(): void {
    this.lastCuratorRun = Date.now();
    this.curatorTimer = setInterval(async () => {
      if (!this.running || this.curatorBusy || !this.curatorSessionId) return;
      const elapsed = Date.now() - this.lastCuratorRun;
      if (elapsed >= this.config.curatorIntervalMs) {
        await this.runCurator();
      }
    }, 60000); // Check every minute if it's time to run
  }

  private async runCurator(): Promise<void> {
    if (!this.curatorSessionId || this.curatorBusy) return;
    this.curatorBusy = true;
    this.lastCuratorRun = Date.now();

    log("Curator triggered: starting maintenance run...");

    const curatorPrompt = `[MAINTENANCE RUN — ${new Date().toISOString()}]

Run your full maintenance workflow:
1. Scan for duplicate learnings/patterns (>80% overlap) — merge up to 10
2. Archive stale entries (not retrieved in 30+ days, created 7+ days ago) — lower confidence
3. Detect contradictions — flag them
4. Consolidate related learnings into patterns if 3+ share a theme
5. Produce your report

Be efficient. If the database is clean, report "No actions needed".`;

    try {
      const response = query({
        prompt: curatorPrompt,
        options: {
          resume: this.curatorSessionId,
          mcpServers: this.getMcpConfig(),
          allowedTools: [
            "mcp__memory__memory_search",
            "mcp__memory__memory_save_learning",
            "mcp__memory__memory_save_pattern",
            "mcp__memory__memory_get_recent_learnings",
            "mcp__memory__memory_search_errors",
            "mcp__memory__memory_search_patterns",
            "mcp__memory__db_select",
            "mcp__memory__db_execute",
          ],
          permissionMode: "bypassPermissions",
          allowDangerouslySkipPermissions: true,
          maxTurns: 15,
          maxBudgetUsd: this.config.curatorBudget,
          cwd: this.config.cwd,
        },
      });

      for await (const sdkMsg of response) {
        if (sdkMsg.type === "result") {
          const resultMsg = sdkMsg as SDKResultMessage;
          if (resultMsg.subtype === "success") {
            const report = (resultMsg.result || "No report").slice(0, 500);
            log(`Curator report: ${report}`);
            log(`Curator cost: $${resultMsg.total_cost_usd.toFixed(4)}`);
            this.totalCostUsd += resultMsg.total_cost_usd;
          } else {
            log(`Curator error: ${resultMsg.subtype}`);
          }
        }
      }
    } catch (err: any) {
      log(`Curator error: ${err.message}`);
    } finally {
      this.curatorBusy = false;
      this.checkSessionBudget();
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
    if (this.curatorTimer) clearInterval(this.curatorTimer);
    if (this.learnerBatchTimer) clearTimeout(this.learnerBatchTimer);
    this.pollTimer = undefined;
    this.heartbeatTimer = undefined;
    this.compactorTimer = undefined;
    this.curatorTimer = undefined;
    this.learnerBatchTimer = undefined;

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
    curatorEnabled: getArg("curator", "off") !== "off",
    pollIntervalMs: 2000,
    heartbeatIntervalMs: 30000,
    compactorCheckIntervalMs: 30000,        // Check every 30s
    compactorTokenThreshold: 20000,          // Compact every ~20k new tokens
    retrieverModel: "claude-haiku-4-5-20251001",
    learnerModel: "claude-haiku-4-5-20251001",
    compactorModel: "claude-haiku-4-5-20251001",
    curatorModel: "claude-haiku-4-5-20251001",
    curatorIntervalMs: parseInt(getArg("curator-interval", String(6 * 60 * 60 * 1000)), 10),
    mcpServerScript: getArg("mcp-server", path.join(__dirname, "..", "mcp", "memory_mcp_server.py")),
    pythonPath: getArg("python-path", process.env.PYTHON_PATH || "C:/Users/user/AppData/Local/Programs/Python/Python312/python.exe"),
    transcriptPath: getArg("transcript-path", ""),
    projectSlug: getArg("project-slug", ""),
    lastCompactSize: parseInt(getArg("last-compact-size", "0"), 10) || 0,
    // Budget config
    retrieverABudget: parseFloat(getArg("retriever-a-budget", "0.50")),
    retrieverBBudget: parseFloat(getArg("retriever-b-budget", "0.50")),
    learnerBudget: parseFloat(getArg("learner-budget", "0.50")),
    compactorBudget: parseFloat(getArg("compactor-budget", "0.30")),
    curatorBudget: parseFloat(getArg("curator-budget", "0.30")),
    sessionBudget: parseFloat(getArg("session-budget", "5.00")),
    // Batch config
    batchWindowMs: parseInt(getArg("batch-window", "10000"), 10),
    batchMinSize: parseInt(getArg("batch-min", "3"), 10),
    batchMaxSize: parseInt(getArg("batch-max", "10"), 10),
  };

  log(`Config: session=${config.sessionId}, retriever=${config.retrieverEnabled}, learner=${config.learnerEnabled}, compactor=${config.compactorEnabled}, curator=${config.curatorEnabled}`);
  log(`Budgets: retrieverA=$${config.retrieverABudget}, retrieverB=$${config.retrieverBBudget}, learner=$${config.learnerBudget}, compactor=$${config.compactorBudget}, curator=$${config.curatorBudget}, session=$${config.sessionBudget}`);
  log(`Batch: window=${config.batchWindowMs}ms, min=${config.batchMinSize}, max=${config.batchMaxSize}`);
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
