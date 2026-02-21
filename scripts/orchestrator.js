"use strict";
/**
 * AIDAM Memory Plugin - Orchestrator
 *
 * Manages two persistent Sonnet sessions (Retriever + Learner) that run
 * alongside the user's main Claude Code session. Communicates via PostgreSQL
 * queue tables (cognitive_inbox, retrieval_inbox).
 */
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
var __generator = (this && this.__generator) || function (thisArg, body) {
    var _ = { label: 0, sent: function() { if (t[0] & 1) throw t[1]; return t[1]; }, trys: [], ops: [] }, f, y, t, g = Object.create((typeof Iterator === "function" ? Iterator : Object).prototype);
    return g.next = verb(0), g["throw"] = verb(1), g["return"] = verb(2), typeof Symbol === "function" && (g[Symbol.iterator] = function() { return this; }), g;
    function verb(n) { return function (v) { return step([n, v]); }; }
    function step(op) {
        if (f) throw new TypeError("Generator is already executing.");
        while (g && (g = 0, op[0] && (_ = 0)), _) try {
            if (f = 1, y && (t = op[0] & 2 ? y["return"] : op[0] ? y["throw"] || ((t = y["return"]) && t.call(y), 0) : y.next) && !(t = t.call(y, op[1])).done) return t;
            if (y = 0, t) op = [op[0] & 2, t.value];
            switch (op[0]) {
                case 0: case 1: t = op; break;
                case 4: _.label++; return { value: op[1], done: false };
                case 5: _.label++; y = op[1]; op = [0]; continue;
                case 7: op = _.ops.pop(); _.trys.pop(); continue;
                default:
                    if (!(t = _.trys, t = t.length > 0 && t[t.length - 1]) && (op[0] === 6 || op[0] === 2)) { _ = 0; continue; }
                    if (op[0] === 3 && (!t || (op[1] > t[0] && op[1] < t[3]))) { _.label = op[1]; break; }
                    if (op[0] === 6 && _.label < t[1]) { _.label = t[1]; t = op; break; }
                    if (t && _.label < t[2]) { _.label = t[2]; _.ops.push(op); break; }
                    if (t[2]) _.ops.pop();
                    _.trys.pop(); continue;
            }
            op = body.call(thisArg, _);
        } catch (e) { op = [6, e]; y = 0; } finally { f = t = 0; }
        if (op[0] & 5) throw op[1]; return { value: op[0] ? op[1] : void 0, done: true };
    }
};
var __asyncValues = (this && this.__asyncValues) || function (o) {
    if (!Symbol.asyncIterator) throw new TypeError("Symbol.asyncIterator is not defined.");
    var m = o[Symbol.asyncIterator], i;
    return m ? m.call(o) : (o = typeof __values === "function" ? __values(o) : o[Symbol.iterator](), i = {}, verb("next"), verb("throw"), verb("return"), i[Symbol.asyncIterator] = function () { return this; }, i);
    function verb(n) { i[n] = o[n] && function (v) { return new Promise(function (resolve, reject) { v = o[n](v), settle(resolve, reject, v.done, v.value); }); }; }
    function settle(resolve, reject, d, v) { Promise.resolve(v).then(function(v) { resolve({ value: v, done: d }); }, reject); }
};
var __spreadArray = (this && this.__spreadArray) || function (to, from, pack) {
    if (pack || arguments.length === 2) for (var i = 0, l = from.length, ar; i < l; i++) {
        if (ar || !(i in from)) {
            if (!ar) ar = Array.prototype.slice.call(from, 0, i);
            ar[i] = from[i];
        }
    }
    return to.concat(ar || Array.prototype.slice.call(from));
};
Object.defineProperty(exports, "__esModule", { value: true });
var claude_agent_sdk_1 = require("@anthropic-ai/claude-agent-sdk");
var pg_1 = require("pg");
var fs = require("fs");
var path = require("path");
var DB_CONFIG = {
    host: "localhost",
    database: "claude_memory",
    user: "postgres",
    password: process.env.PGPASSWORD || "",
    port: 5432,
};
var SlidingWindow = /** @class */ (function () {
    function SlidingWindow(maxTurns) {
        if (maxTurns === void 0) { maxTurns = 5; }
        this.turns = [];
        this.maxTurns = maxTurns;
    }
    SlidingWindow.prototype.addUserTurn = function (prompt) {
        this.turns.push({ role: "user", content: prompt, timestamp: Date.now() });
        this.trim();
    };
    SlidingWindow.prototype.addClaudeSummary = function (summary) {
        this.turns.push({ role: "claude", content: summary, timestamp: Date.now() });
        this.trim();
    };
    SlidingWindow.prototype.trim = function () {
        // Keep last maxTurns * 2 entries (pairs of user+claude)
        var maxEntries = this.maxTurns * 2;
        if (this.turns.length > maxEntries) {
            this.turns = this.turns.slice(-maxEntries);
        }
    };
    SlidingWindow.prototype.format = function () {
        if (this.turns.length === 0)
            return "(no previous context)";
        return this.turns
            .map(function (t) { return "[".concat(t.role === "user" ? "USER" : "CLAUDE", "] ").concat(t.content); })
            .join("\n\n");
    };
    return SlidingWindow;
}());
// ============================================
// ORCHESTRATOR
// ============================================
var Orchestrator = /** @class */ (function () {
    function Orchestrator(config) {
        this.running = false;
        this.retrieverABusy = false;
        this.retrieverBBusy = false;
        this.learnerBusy = false;
        this.compactorBusy = false;
        this.curatorBusy = false;
        this.lastCompactedSize = 0;
        this.compactorVersion = 0;
        this.totalCostUsd = 0;
        this.lastCuratorRun = 0;
        // Learner batch buffer
        this.learnerBuffer = [];
        // ============================================
        // RETRIEVER ROUTING
        // ============================================
        // Track what has been injected this session for retriever awareness
        this.injectionHistory = [];
        this.config = config;
        this.db = new pg_1.Client(DB_CONFIG);
        this.slidingWindow = new SlidingWindow(5);
        // Initialize from config (set by SessionStart when source=clear)
        this.lastCompactedSize = config.lastCompactSize;
    }
    Orchestrator.prototype.start = function () {
        return __awaiter(this, void 0, void 0, function () {
            var initPromises;
            var _this = this;
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0:
                        log("Starting orchestrator...");
                        return [4 /*yield*/, this.db.connect()];
                    case 1:
                        _a.sent();
                        // Register in orchestrator_state (upsert)
                        return [4 /*yield*/, this.db.query("INSERT INTO orchestrator_state (session_id, pid, retriever_enabled, learner_enabled, status)\n       VALUES ($1, $2, $3, $4, 'starting')\n       ON CONFLICT (session_id) DO UPDATE SET\n         pid = $2, retriever_enabled = $3, learner_enabled = $4,\n         status = 'starting', started_at = CURRENT_TIMESTAMP,\n         last_heartbeat_at = CURRENT_TIMESTAMP, stopped_at = NULL, error_message = NULL", [this.config.sessionId, process.pid, this.config.retrieverEnabled, this.config.learnerEnabled])];
                    case 2:
                        // Register in orchestrator_state (upsert)
                        _a.sent();
                        initPromises = [];
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
                        return [4 /*yield*/, Promise.all(initPromises)];
                    case 3:
                        _a.sent();
                        // Mark as running
                        return [4 /*yield*/, this.db.query("UPDATE orchestrator_state SET status = 'running',\n         retriever_session_id = $2, learner_session_id = $3,\n         last_heartbeat_at = CURRENT_TIMESTAMP\n       WHERE session_id = $1", [this.config.sessionId, this.retrieverASessionId || this.retrieverBSessionId || null, this.learnerSessionId || null])];
                    case 4:
                        // Mark as running
                        _a.sent();
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
                        process.on("SIGTERM", function () { return _this.shutdown(); });
                        process.on("SIGINT", function () { return _this.shutdown(); });
                        process.on("uncaughtException", function (err) {
                            log("Uncaught exception: ".concat(err.message));
                            _this.shutdown();
                        });
                        log("Orchestrator running. RetrieverA: ".concat(this.retrieverASessionId || "disabled", ", RetrieverB: ").concat(this.retrieverBSessionId || "disabled", ", Learner: ").concat(this.learnerSessionId || "disabled", ", Compactor: ").concat(this.compactorSessionId || "disabled", ", Curator: ").concat(this.curatorSessionId || "disabled"));
                        return [2 /*return*/];
                }
            });
        });
    };
    Orchestrator.prototype.getMcpConfig = function () {
        return {
            memory: {
                type: "stdio",
                command: this.config.pythonPath,
                args: [this.config.mcpServerScript],
                env: {
                    PYTHONPATH: path.dirname(this.config.mcpServerScript),
                },
            },
        };
    };
    Object.defineProperty(Orchestrator.prototype, "retrieverBaseTools", {
        // Shared tools available to both retrievers
        get: function () {
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
        },
        enumerable: false,
        configurable: true
    });
    Object.defineProperty(Orchestrator.prototype, "retrieverCascadeTools", {
        // Additional tools for cascade retriever (knowledge_index)
        get: function () {
            return __spreadArray(__spreadArray([], this.retrieverBaseTools, true), [
                "mcp__memory__memory_index_search",
                "mcp__memory__memory_index_domains",
            ], false);
        },
        enumerable: false,
        configurable: true
    });
    Orchestrator.prototype.initRetrieverA = function () {
        return __awaiter(this, void 0, void 0, function () {
            var promptPath, systemPrompt, response, _a, response_1, response_1_1, msg, e_1_1, err_1;
            var _b, e_1, _c, _d;
            return __generator(this, function (_e) {
                switch (_e.label) {
                    case 0:
                        log("Initializing Retriever A (Keyword)...");
                        promptPath = path.join(__dirname, "..", "prompts", "retriever_keyword_system.md");
                        try {
                            systemPrompt = fs.readFileSync(promptPath, "utf-8");
                        }
                        catch (_f) {
                            systemPrompt = "You are a keyword memory retrieval agent. Search the MCP memory tools for relevant context when given a user prompt. Use parallel tool calls. Respond with SKIP if nothing relevant.";
                        }
                        _e.label = 1;
                    case 1:
                        _e.trys.push([1, 14, , 15]);
                        response = (0, claude_agent_sdk_1.query)({
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
                        _e.label = 2;
                    case 2:
                        _e.trys.push([2, 7, 8, 13]);
                        _a = true, response_1 = __asyncValues(response);
                        _e.label = 3;
                    case 3: return [4 /*yield*/, response_1.next()];
                    case 4:
                        if (!(response_1_1 = _e.sent(), _b = response_1_1.done, !_b)) return [3 /*break*/, 6];
                        _d = response_1_1.value;
                        _a = false;
                        msg = _d;
                        if (msg.type === "system" && "subtype" in msg && msg.subtype === "init") {
                            this.retrieverASessionId = msg.session_id;
                            log("Retriever A session ID: ".concat(this.retrieverASessionId));
                        }
                        _e.label = 5;
                    case 5:
                        _a = true;
                        return [3 /*break*/, 3];
                    case 6: return [3 /*break*/, 13];
                    case 7:
                        e_1_1 = _e.sent();
                        e_1 = { error: e_1_1 };
                        return [3 /*break*/, 13];
                    case 8:
                        _e.trys.push([8, , 11, 12]);
                        if (!(!_a && !_b && (_c = response_1.return))) return [3 /*break*/, 10];
                        return [4 /*yield*/, _c.call(response_1)];
                    case 9:
                        _e.sent();
                        _e.label = 10;
                    case 10: return [3 /*break*/, 12];
                    case 11:
                        if (e_1) throw e_1.error;
                        return [7 /*endfinally*/];
                    case 12: return [7 /*endfinally*/];
                    case 13: return [3 /*break*/, 15];
                    case 14:
                        err_1 = _e.sent();
                        log("Retriever A init error: ".concat(err_1.message));
                        return [3 /*break*/, 15];
                    case 15: return [2 /*return*/];
                }
            });
        });
    };
    Orchestrator.prototype.initRetrieverB = function () {
        return __awaiter(this, void 0, void 0, function () {
            var promptPath, systemPrompt, response, _a, response_2, response_2_1, msg, e_2_1, err_2;
            var _b, e_2, _c, _d;
            return __generator(this, function (_e) {
                switch (_e.label) {
                    case 0:
                        log("Initializing Retriever B (Cascade)...");
                        promptPath = path.join(__dirname, "..", "prompts", "retriever_cascade_system.md");
                        try {
                            systemPrompt = fs.readFileSync(promptPath, "utf-8");
                        }
                        catch (_f) {
                            systemPrompt = "You are a cascade memory retrieval agent. Search knowledge_index first, then drill down. Use parallel tool calls. Respond with SKIP if nothing relevant.";
                        }
                        _e.label = 1;
                    case 1:
                        _e.trys.push([1, 14, , 15]);
                        response = (0, claude_agent_sdk_1.query)({
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
                        _e.label = 2;
                    case 2:
                        _e.trys.push([2, 7, 8, 13]);
                        _a = true, response_2 = __asyncValues(response);
                        _e.label = 3;
                    case 3: return [4 /*yield*/, response_2.next()];
                    case 4:
                        if (!(response_2_1 = _e.sent(), _b = response_2_1.done, !_b)) return [3 /*break*/, 6];
                        _d = response_2_1.value;
                        _a = false;
                        msg = _d;
                        if (msg.type === "system" && "subtype" in msg && msg.subtype === "init") {
                            this.retrieverBSessionId = msg.session_id;
                            log("Retriever B session ID: ".concat(this.retrieverBSessionId));
                        }
                        _e.label = 5;
                    case 5:
                        _a = true;
                        return [3 /*break*/, 3];
                    case 6: return [3 /*break*/, 13];
                    case 7:
                        e_2_1 = _e.sent();
                        e_2 = { error: e_2_1 };
                        return [3 /*break*/, 13];
                    case 8:
                        _e.trys.push([8, , 11, 12]);
                        if (!(!_a && !_b && (_c = response_2.return))) return [3 /*break*/, 10];
                        return [4 /*yield*/, _c.call(response_2)];
                    case 9:
                        _e.sent();
                        _e.label = 10;
                    case 10: return [3 /*break*/, 12];
                    case 11:
                        if (e_2) throw e_2.error;
                        return [7 /*endfinally*/];
                    case 12: return [7 /*endfinally*/];
                    case 13: return [3 /*break*/, 15];
                    case 14:
                        err_2 = _e.sent();
                        log("Retriever B init error: ".concat(err_2.message));
                        return [3 /*break*/, 15];
                    case 15: return [2 /*return*/];
                }
            });
        });
    };
    Orchestrator.prototype.initLearner = function () {
        return __awaiter(this, void 0, void 0, function () {
            var promptPath, systemPrompt, response, _a, response_3, response_3_1, msg, e_3_1, err_3;
            var _b, e_3, _c, _d;
            return __generator(this, function (_e) {
                switch (_e.label) {
                    case 0:
                        log("Initializing Learner session...");
                        promptPath = path.join(__dirname, "..", "prompts", "learner_system.md");
                        try {
                            systemPrompt = fs.readFileSync(promptPath, "utf-8");
                        }
                        catch (_f) {
                            systemPrompt = "You are a memory learning agent. Extract and save valuable knowledge from tool observations. Use MCP memory tools to search for duplicates before saving. Respond with SKIP if nothing worth saving.";
                        }
                        _e.label = 1;
                    case 1:
                        _e.trys.push([1, 14, , 15]);
                        response = (0, claude_agent_sdk_1.query)({
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
                        _e.label = 2;
                    case 2:
                        _e.trys.push([2, 7, 8, 13]);
                        _a = true, response_3 = __asyncValues(response);
                        _e.label = 3;
                    case 3: return [4 /*yield*/, response_3.next()];
                    case 4:
                        if (!(response_3_1 = _e.sent(), _b = response_3_1.done, !_b)) return [3 /*break*/, 6];
                        _d = response_3_1.value;
                        _a = false;
                        msg = _d;
                        if (msg.type === "system" && "subtype" in msg && msg.subtype === "init") {
                            this.learnerSessionId = msg.session_id;
                            log("Learner session ID: ".concat(this.learnerSessionId));
                        }
                        _e.label = 5;
                    case 5:
                        _a = true;
                        return [3 /*break*/, 3];
                    case 6: return [3 /*break*/, 13];
                    case 7:
                        e_3_1 = _e.sent();
                        e_3 = { error: e_3_1 };
                        return [3 /*break*/, 13];
                    case 8:
                        _e.trys.push([8, , 11, 12]);
                        if (!(!_a && !_b && (_c = response_3.return))) return [3 /*break*/, 10];
                        return [4 /*yield*/, _c.call(response_3)];
                    case 9:
                        _e.sent();
                        _e.label = 10;
                    case 10: return [3 /*break*/, 12];
                    case 11:
                        if (e_3) throw e_3.error;
                        return [7 /*endfinally*/];
                    case 12: return [7 /*endfinally*/];
                    case 13: return [3 /*break*/, 15];
                    case 14:
                        err_3 = _e.sent();
                        log("Learner init error: ".concat(err_3.message));
                        return [3 /*break*/, 15];
                    case 15: return [2 /*return*/];
                }
            });
        });
    };
    // ============================================
    // POLLING LOOP
    // ============================================
    Orchestrator.prototype.startPolling = function () {
        var _this = this;
        this.pollTimer = setInterval(function () { return __awaiter(_this, void 0, void 0, function () {
            var err_4;
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0:
                        if (!this.running)
                            return [2 /*return*/];
                        _a.label = 1;
                    case 1:
                        _a.trys.push([1, 4, , 5]);
                        return [4 /*yield*/, this.pollCognitiveInbox()];
                    case 2:
                        _a.sent();
                        return [4 /*yield*/, this.checkShutdownSignal()];
                    case 3:
                        _a.sent();
                        return [3 /*break*/, 5];
                    case 4:
                        err_4 = _a.sent();
                        log("Poll error: ".concat(err_4.message));
                        return [3 /*break*/, 5];
                    case 5: return [2 /*return*/];
                }
            });
        }); }, this.config.pollIntervalMs);
    };
    Orchestrator.prototype.startHeartbeat = function () {
        var _this = this;
        this.heartbeatTimer = setInterval(function () { return __awaiter(_this, void 0, void 0, function () {
            var err_5;
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0:
                        if (!this.running)
                            return [2 /*return*/];
                        _a.label = 1;
                    case 1:
                        _a.trys.push([1, 3, , 4]);
                        return [4 /*yield*/, this.db.query("UPDATE orchestrator_state SET last_heartbeat_at = CURRENT_TIMESTAMP\n           WHERE session_id = $1 AND status = 'running'", [this.config.sessionId])];
                    case 2:
                        _a.sent();
                        return [3 /*break*/, 4];
                    case 3:
                        err_5 = _a.sent();
                        log("Heartbeat error: ".concat(err_5.message));
                        return [3 /*break*/, 4];
                    case 4: return [2 /*return*/];
                }
            });
        }); }, this.config.heartbeatIntervalMs);
    };
    Orchestrator.prototype.pollCognitiveInbox = function () {
        return __awaiter(this, void 0, void 0, function () {
            var result, messages, _i, messages_1, msg, stat, event_1, err_6;
            var _a;
            return __generator(this, function (_b) {
                switch (_b.label) {
                    case 0: return [4 /*yield*/, this.db.query("UPDATE cognitive_inbox\n       SET status = 'processing', processed_at = CURRENT_TIMESTAMP\n       WHERE id IN (\n         SELECT id FROM cognitive_inbox\n         WHERE session_id = $1 AND status = 'pending'\n         ORDER BY created_at ASC\n         LIMIT 10\n       )\n       RETURNING *", [this.config.sessionId])];
                    case 1:
                        result = _b.sent();
                        messages = result.rows;
                        if (messages.length === 0)
                            return [2 /*return*/];
                        _i = 0, messages_1 = messages;
                        _b.label = 2;
                    case 2:
                        if (!(_i < messages_1.length)) return [3 /*break*/, 27];
                        msg = messages_1[_i];
                        _b.label = 3;
                    case 3:
                        _b.trys.push([3, 24, , 26]);
                        if (!(msg.message_type === "prompt_context" && this.config.retrieverEnabled)) return [3 /*break*/, 6];
                        return [4 /*yield*/, this.routeToRetriever(msg)];
                    case 4:
                        _b.sent();
                        return [4 /*yield*/, this.markCompleted(msg.id)];
                    case 5:
                        _b.sent();
                        return [3 /*break*/, 23];
                    case 6:
                        if (!(msg.message_type === "tool_use" && this.config.learnerEnabled)) return [3 /*break*/, 7];
                        // Buffer tool_use messages for batch processing
                        this.learnerBuffer.push(msg);
                        this.checkLearnerBatchFlush();
                        return [3 /*break*/, 23];
                    case 7:
                        if (!(msg.message_type === "curator_trigger")) return [3 /*break*/, 10];
                        return [4 /*yield*/, this.runCurator()];
                    case 8:
                        _b.sent();
                        return [4 /*yield*/, this.markCompleted(msg.id)];
                    case 9:
                        _b.sent();
                        return [3 /*break*/, 23];
                    case 10:
                        if (!(msg.message_type === "compactor_trigger")) return [3 /*break*/, 15];
                        if (!(this.compactorSessionId && this.config.transcriptPath)) return [3 /*break*/, 12];
                        log("Compactor triggered on-demand (smart-compact)");
                        stat = fs.statSync(this.config.transcriptPath);
                        return [4 /*yield*/, this.runCompactor(this.config.transcriptPath, Math.floor(stat.size / 6))];
                    case 11:
                        _b.sent();
                        return [3 /*break*/, 13];
                    case 12:
                        log("Compactor trigger ignored: no compactor session or transcript path");
                        _b.label = 13;
                    case 13: return [4 /*yield*/, this.markCompleted(msg.id)];
                    case 14:
                        _b.sent();
                        return [3 /*break*/, 23];
                    case 15:
                        if (!(msg.message_type === "session_event")) return [3 /*break*/, 21];
                        event_1 = (_a = msg.payload) === null || _a === void 0 ? void 0 : _a.event;
                        if (!(event_1 === "session_end")) return [3 /*break*/, 19];
                        // Flush any remaining buffered observations before shutdown
                        return [4 /*yield*/, this.flushLearnerBatch()];
                    case 16:
                        // Flush any remaining buffered observations before shutdown
                        _b.sent();
                        return [4 /*yield*/, this.markCompleted(msg.id)];
                    case 17:
                        _b.sent();
                        return [4 /*yield*/, this.shutdown()];
                    case 18:
                        _b.sent();
                        return [2 /*return*/];
                    case 19: return [4 /*yield*/, this.markCompleted(msg.id)];
                    case 20:
                        _b.sent();
                        return [3 /*break*/, 23];
                    case 21: return [4 /*yield*/, this.markCompleted(msg.id)];
                    case 22:
                        _b.sent();
                        _b.label = 23;
                    case 23: return [3 /*break*/, 26];
                    case 24:
                        err_6 = _b.sent();
                        log("Error processing message ".concat(msg.id, ": ").concat(err_6.message));
                        return [4 /*yield*/, this.markFailed(msg.id)];
                    case 25:
                        _b.sent();
                        return [3 /*break*/, 26];
                    case 26:
                        _i++;
                        return [3 /*break*/, 2];
                    case 27: return [2 /*return*/];
                }
            });
        });
    };
    Orchestrator.prototype.markCompleted = function (id) {
        return __awaiter(this, void 0, void 0, function () {
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0: return [4 /*yield*/, this.db.query("UPDATE cognitive_inbox SET status = 'completed' WHERE id = $1", [id])];
                    case 1:
                        _a.sent();
                        return [2 /*return*/];
                }
            });
        });
    };
    Orchestrator.prototype.markFailed = function (id) {
        return __awaiter(this, void 0, void 0, function () {
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0: return [4 /*yield*/, this.db.query("UPDATE cognitive_inbox SET status = 'failed' WHERE id = $1", [id])];
                    case 1:
                        _a.sent();
                        return [2 /*return*/];
                }
            });
        });
    };
    Orchestrator.prototype.routeToRetriever = function (msg) {
        return __awaiter(this, void 0, void 0, function () {
            var prompt, promptHash, injectionCtx, retrieverPrompt, promiseA, promiseB;
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0:
                        prompt = msg.payload.prompt;
                        promptHash = msg.payload.prompt_hash;
                        // Add to sliding window
                        this.slidingWindow.addUserTurn(prompt);
                        if (!(this.retrieverABusy && this.retrieverBBusy)) return [3 /*break*/, 2];
                        log("Both retrievers busy, skipping prompt");
                        return [4 /*yield*/, this.writeRetrievalResult(promptHash, "none", null)];
                    case 1:
                        _a.sent();
                        return [2 /*return*/];
                    case 2:
                        injectionCtx = this.injectionHistory.length > 0
                            ? "\n\n[PREVIOUSLY INJECTED THIS SESSION \u2014 avoid repeating]\n".concat(this.injectionHistory.slice(-5).map(function (s, i) { return "".concat(i + 1, ". ").concat(s); }).join("\n"))
                            : "";
                        retrieverPrompt = "[NEW USER PROMPT]\n".concat(prompt, "\n\n[CONVERSATION CONTEXT - Last turns]\n").concat(this.slidingWindow.format()).concat(injectionCtx, "\n\nSearch memory for relevant context for this user's work. If nothing relevant, respond with SKIP.");
                        promiseA = this.retrieverASessionId && !this.retrieverABusy
                            ? this.routeToRetrieverA(retrieverPrompt, promptHash)
                            : Promise.resolve();
                        promiseB = this.retrieverBSessionId && !this.retrieverBBusy
                            ? this.routeToRetrieverB(retrieverPrompt, promptHash)
                            : Promise.resolve();
                        return [4 /*yield*/, Promise.allSettled([promiseA, promiseB])];
                    case 3:
                        _a.sent();
                        return [2 /*return*/];
                }
            });
        });
    };
    Orchestrator.prototype.routeToRetrieverA = function (retrieverPrompt, promptHash) {
        return __awaiter(this, void 0, void 0, function () {
            var resultText, response, _a, response_4, response_4_1, sdkMsg, resultMsg, e_4_1, isSkip, err_7;
            var _b, e_4, _c, _d;
            return __generator(this, function (_e) {
                switch (_e.label) {
                    case 0:
                        this.retrieverABusy = true;
                        _e.label = 1;
                    case 1:
                        _e.trys.push([1, 18, 20, 21]);
                        resultText = "";
                        response = (0, claude_agent_sdk_1.query)({
                            prompt: retrieverPrompt,
                            options: {
                                resume: this.retrieverASessionId,
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
                        _e.label = 2;
                    case 2:
                        _e.trys.push([2, 7, 8, 13]);
                        _a = true, response_4 = __asyncValues(response);
                        _e.label = 3;
                    case 3: return [4 /*yield*/, response_4.next()];
                    case 4:
                        if (!(response_4_1 = _e.sent(), _b = response_4_1.done, !_b)) return [3 /*break*/, 6];
                        _d = response_4_1.value;
                        _a = false;
                        sdkMsg = _d;
                        if (sdkMsg.type === "result") {
                            resultMsg = sdkMsg;
                            if (resultMsg.subtype === "success") {
                                resultText = resultMsg.result || "";
                                log("Retriever A result: ".concat(resultText.length, " chars, cost: $").concat(resultMsg.total_cost_usd.toFixed(4)));
                                this.totalCostUsd += resultMsg.total_cost_usd;
                            }
                            else {
                                log("Retriever A error: ".concat(resultMsg.subtype));
                            }
                        }
                        _e.label = 5;
                    case 5:
                        _a = true;
                        return [3 /*break*/, 3];
                    case 6: return [3 /*break*/, 13];
                    case 7:
                        e_4_1 = _e.sent();
                        e_4 = { error: e_4_1 };
                        return [3 /*break*/, 13];
                    case 8:
                        _e.trys.push([8, , 11, 12]);
                        if (!(!_a && !_b && (_c = response_4.return))) return [3 /*break*/, 10];
                        return [4 /*yield*/, _c.call(response_4)];
                    case 9:
                        _e.sent();
                        _e.label = 10;
                    case 10: return [3 /*break*/, 12];
                    case 11:
                        if (e_4) throw e_4.error;
                        return [7 /*endfinally*/];
                    case 12: return [7 /*endfinally*/];
                    case 13:
                        isSkip = !resultText || resultText.trim().toUpperCase() === "SKIP" || resultText.trim().length < 20;
                        if (!isSkip) return [3 /*break*/, 15];
                        return [4 /*yield*/, this.writeRetrievalResult(promptHash, "none", null, "retriever_a")];
                    case 14:
                        _e.sent();
                        return [3 /*break*/, 17];
                    case 15: return [4 /*yield*/, this.writeRetrievalResult(promptHash, "memory_results", resultText, "retriever_a")];
                    case 16:
                        _e.sent();
                        this.slidingWindow.addClaudeSummary("[Retriever A found: ".concat(resultText.slice(0, 100), "...]"));
                        this.injectionHistory.push(resultText.slice(0, 150));
                        // Notify Retriever B if still working (best-effort)
                        if (this.retrieverBBusy && this.retrieverBSessionId) {
                            this.notifyPeer("B", resultText).catch(function () { });
                        }
                        _e.label = 17;
                    case 17: return [3 /*break*/, 21];
                    case 18:
                        err_7 = _e.sent();
                        log("Retriever A error: ".concat(err_7.message));
                        return [4 /*yield*/, this.writeRetrievalResult(promptHash, "none", null, "retriever_a")];
                    case 19:
                        _e.sent();
                        return [3 /*break*/, 21];
                    case 20:
                        this.retrieverABusy = false;
                        this.checkSessionBudget();
                        return [7 /*endfinally*/];
                    case 21: return [2 /*return*/];
                }
            });
        });
    };
    Orchestrator.prototype.routeToRetrieverB = function (retrieverPrompt, promptHash) {
        return __awaiter(this, void 0, void 0, function () {
            var resultText, response, _a, response_5, response_5_1, sdkMsg, resultMsg, e_5_1, isSkip, err_8;
            var _b, e_5, _c, _d;
            return __generator(this, function (_e) {
                switch (_e.label) {
                    case 0:
                        this.retrieverBBusy = true;
                        _e.label = 1;
                    case 1:
                        _e.trys.push([1, 18, 20, 21]);
                        resultText = "";
                        response = (0, claude_agent_sdk_1.query)({
                            prompt: retrieverPrompt,
                            options: {
                                resume: this.retrieverBSessionId,
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
                        _e.label = 2;
                    case 2:
                        _e.trys.push([2, 7, 8, 13]);
                        _a = true, response_5 = __asyncValues(response);
                        _e.label = 3;
                    case 3: return [4 /*yield*/, response_5.next()];
                    case 4:
                        if (!(response_5_1 = _e.sent(), _b = response_5_1.done, !_b)) return [3 /*break*/, 6];
                        _d = response_5_1.value;
                        _a = false;
                        sdkMsg = _d;
                        if (sdkMsg.type === "result") {
                            resultMsg = sdkMsg;
                            if (resultMsg.subtype === "success") {
                                resultText = resultMsg.result || "";
                                log("Retriever B result: ".concat(resultText.length, " chars, cost: $").concat(resultMsg.total_cost_usd.toFixed(4)));
                                this.totalCostUsd += resultMsg.total_cost_usd;
                            }
                            else {
                                log("Retriever B error: ".concat(resultMsg.subtype));
                            }
                        }
                        _e.label = 5;
                    case 5:
                        _a = true;
                        return [3 /*break*/, 3];
                    case 6: return [3 /*break*/, 13];
                    case 7:
                        e_5_1 = _e.sent();
                        e_5 = { error: e_5_1 };
                        return [3 /*break*/, 13];
                    case 8:
                        _e.trys.push([8, , 11, 12]);
                        if (!(!_a && !_b && (_c = response_5.return))) return [3 /*break*/, 10];
                        return [4 /*yield*/, _c.call(response_5)];
                    case 9:
                        _e.sent();
                        _e.label = 10;
                    case 10: return [3 /*break*/, 12];
                    case 11:
                        if (e_5) throw e_5.error;
                        return [7 /*endfinally*/];
                    case 12: return [7 /*endfinally*/];
                    case 13:
                        isSkip = !resultText || resultText.trim().toUpperCase() === "SKIP" || resultText.trim().length < 20;
                        if (!isSkip) return [3 /*break*/, 15];
                        return [4 /*yield*/, this.writeRetrievalResult(promptHash, "none", null, "retriever_b")];
                    case 14:
                        _e.sent();
                        return [3 /*break*/, 17];
                    case 15: return [4 /*yield*/, this.writeRetrievalResult(promptHash, "memory_results", resultText, "retriever_b")];
                    case 16:
                        _e.sent();
                        this.slidingWindow.addClaudeSummary("[Retriever B found: ".concat(resultText.slice(0, 100), "...]"));
                        this.injectionHistory.push(resultText.slice(0, 150));
                        // Notify Retriever A if still working (best-effort)
                        if (this.retrieverABusy && this.retrieverASessionId) {
                            this.notifyPeer("A", resultText).catch(function () { });
                        }
                        _e.label = 17;
                    case 17: return [3 /*break*/, 21];
                    case 18:
                        err_8 = _e.sent();
                        log("Retriever B error: ".concat(err_8.message));
                        return [4 /*yield*/, this.writeRetrievalResult(promptHash, "none", null, "retriever_b")];
                    case 19:
                        _e.sent();
                        return [3 /*break*/, 21];
                    case 20:
                        this.retrieverBBusy = false;
                        this.checkSessionBudget();
                        return [7 /*endfinally*/];
                    case 21: return [2 /*return*/];
                }
            });
        });
    };
    Orchestrator.prototype.notifyPeer = function (target, injectedText) {
        return __awaiter(this, void 0, void 0, function () {
            var sessionId, notification, response, _a, response_6, response_6_1, _, e_6_1, _b;
            var _c, e_6, _d, _e;
            return __generator(this, function (_f) {
                switch (_f.label) {
                    case 0:
                        sessionId = target === "A" ? this.retrieverASessionId : this.retrieverBSessionId;
                        if (!sessionId)
                            return [2 /*return*/];
                        notification = "[PEER_INJECTED] The other retriever already injected: \"".concat(injectedText.slice(0, 200), "...\"\nCheck what's already covered. Focus on COMPLEMENTARY information or respond SKIP if already sufficient.");
                        _f.label = 1;
                    case 1:
                        _f.trys.push([1, 14, , 15]);
                        response = (0, claude_agent_sdk_1.query)({
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
                        _f.label = 2;
                    case 2:
                        _f.trys.push([2, 7, 8, 13]);
                        _a = true, response_6 = __asyncValues(response);
                        _f.label = 3;
                    case 3: return [4 /*yield*/, response_6.next()];
                    case 4:
                        if (!(response_6_1 = _f.sent(), _c = response_6_1.done, !_c)) return [3 /*break*/, 6];
                        _e = response_6_1.value;
                        _a = false;
                        _ = _e;
                        _f.label = 5;
                    case 5:
                        _a = true;
                        return [3 /*break*/, 3];
                    case 6: return [3 /*break*/, 13];
                    case 7:
                        e_6_1 = _f.sent();
                        e_6 = { error: e_6_1 };
                        return [3 /*break*/, 13];
                    case 8:
                        _f.trys.push([8, , 11, 12]);
                        if (!(!_a && !_c && (_d = response_6.return))) return [3 /*break*/, 10];
                        return [4 /*yield*/, _d.call(response_6)];
                    case 9:
                        _f.sent();
                        _f.label = 10;
                    case 10: return [3 /*break*/, 12];
                    case 11:
                        if (e_6) throw e_6.error;
                        return [7 /*endfinally*/];
                    case 12: return [7 /*endfinally*/];
                    case 13: return [3 /*break*/, 15];
                    case 14:
                        _b = _f.sent();
                        return [3 /*break*/, 15];
                    case 15: return [2 /*return*/];
                }
            });
        });
    };
    // Clear injection history (called on compactor clear/reset)
    Orchestrator.prototype.clearInjectionHistory = function () {
        this.injectionHistory = [];
    };
    Orchestrator.prototype.writeRetrievalResult = function (promptHash, type, text, source) {
        return __awaiter(this, void 0, void 0, function () {
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0: return [4 /*yield*/, this.db.query("INSERT INTO retrieval_inbox (session_id, prompt_hash, context_type, context_text, relevance_score, source)\n       VALUES ($1, $2, $3, $4, $5, $6)", [this.config.sessionId, promptHash, type, text, text ? 0.8 : 0.0, source || "retriever"])];
                    case 1:
                        _a.sent();
                        return [2 /*return*/];
                }
            });
        });
    };
    // ============================================
    // LEARNER ROUTING
    // ============================================
    // ============================================
    // LEARNER BATCH PROCESSING
    // ============================================
    Orchestrator.prototype.checkLearnerBatchFlush = function () {
        var _this = this;
        // Flush immediately if buffer is full
        if (this.learnerBuffer.length >= this.config.batchMaxSize) {
            this.flushLearnerBatch();
            return;
        }
        // Start batch timer if not already running
        if (!this.learnerBatchTimer && this.learnerBuffer.length > 0) {
            this.learnerBatchTimer = setTimeout(function () {
                _this.learnerBatchTimer = undefined;
                _this.flushLearnerBatch();
            }, this.config.batchWindowMs);
        }
        // Flush early if we hit min size
        if (this.learnerBuffer.length >= this.config.batchMinSize && this.learnerBatchTimer) {
            clearTimeout(this.learnerBatchTimer);
            this.learnerBatchTimer = undefined;
            this.flushLearnerBatch();
        }
    };
    Orchestrator.prototype.flushLearnerBatch = function () {
        return __awaiter(this, void 0, void 0, function () {
            var _i, _a, msg, batch, observations, learnerPrompt, response, _b, response_7, response_7_1, sdkMsg, resultMsg, summary, e_7_1, _c, batch_1, msg, err_9, _d, batch_2, msg;
            var _e, e_7, _f, _g;
            return __generator(this, function (_h) {
                switch (_h.label) {
                    case 0:
                        if (this.learnerBuffer.length === 0)
                            return [2 /*return*/];
                        if (!this.learnerBusy) return [3 /*break*/, 5];
                        _i = 0, _a = this.learnerBuffer;
                        _h.label = 1;
                    case 1:
                        if (!(_i < _a.length)) return [3 /*break*/, 4];
                        msg = _a[_i];
                        return [4 /*yield*/, this.db.query("UPDATE cognitive_inbox SET status = 'pending' WHERE id = $1", [msg.id])];
                    case 2:
                        _h.sent();
                        _h.label = 3;
                    case 3:
                        _i++;
                        return [3 /*break*/, 1];
                    case 4:
                        this.learnerBuffer = [];
                        return [2 /*return*/];
                    case 5:
                        batch = this.learnerBuffer.splice(0, this.config.batchMaxSize);
                        if (!(batch.length === 1)) return [3 /*break*/, 8];
                        // Single message — use normal routing
                        return [4 /*yield*/, this.routeToLearner(batch[0])];
                    case 6:
                        // Single message — use normal routing
                        _h.sent();
                        return [4 /*yield*/, this.markCompleted(batch[0].id)];
                    case 7:
                        _h.sent();
                        return [2 /*return*/];
                    case 8:
                        // Batch mode: format all observations as one prompt
                        log("Batch: ".concat(batch.length, " observations \u2192 Learner"));
                        this.learnerBusy = true;
                        observations = batch.map(function (msg, i) {
                            var p = msg.payload;
                            var inputStr = JSON.stringify(p.tool_input, null, 2);
                            var responseStr = JSON.stringify(p.tool_response, null, 2);
                            return "### Observation ".concat(i + 1, "\nTool: ").concat(p.tool_name, "\nInput: ").concat(inputStr.slice(0, 1500), "\nResult: ").concat(responseStr.slice(0, 1500));
                        }).join("\n\n");
                        learnerPrompt = "[BATCH TOOL OBSERVATIONS \u2014 ".concat(batch.length, " items]\n\n").concat(observations, "\n\nAnalyze ALL observations together. Look for patterns BETWEEN them. For each observation worth saving, save to memory (check for duplicates first). If nothing worth saving, respond SKIP.");
                        _h.label = 9;
                    case 9:
                        _h.trys.push([9, 26, 31, 32]);
                        response = (0, claude_agent_sdk_1.query)({
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
                        _h.label = 10;
                    case 10:
                        _h.trys.push([10, 15, 16, 21]);
                        _b = true, response_7 = __asyncValues(response);
                        _h.label = 11;
                    case 11: return [4 /*yield*/, response_7.next()];
                    case 12:
                        if (!(response_7_1 = _h.sent(), _e = response_7_1.done, !_e)) return [3 /*break*/, 14];
                        _g = response_7_1.value;
                        _b = false;
                        sdkMsg = _g;
                        if (sdkMsg.type === "result") {
                            resultMsg = sdkMsg;
                            if (resultMsg.subtype === "success") {
                                summary = (resultMsg.result || "SKIP").slice(0, 200);
                                log("Learner (batch ".concat(batch.length, "): ").concat(summary, ", cost: $").concat(resultMsg.total_cost_usd.toFixed(4)));
                                this.totalCostUsd += resultMsg.total_cost_usd;
                            }
                            else {
                                log("Learner batch error: ".concat(resultMsg.subtype));
                            }
                        }
                        _h.label = 13;
                    case 13:
                        _b = true;
                        return [3 /*break*/, 11];
                    case 14: return [3 /*break*/, 21];
                    case 15:
                        e_7_1 = _h.sent();
                        e_7 = { error: e_7_1 };
                        return [3 /*break*/, 21];
                    case 16:
                        _h.trys.push([16, , 19, 20]);
                        if (!(!_b && !_e && (_f = response_7.return))) return [3 /*break*/, 18];
                        return [4 /*yield*/, _f.call(response_7)];
                    case 17:
                        _h.sent();
                        _h.label = 18;
                    case 18: return [3 /*break*/, 20];
                    case 19:
                        if (e_7) throw e_7.error;
                        return [7 /*endfinally*/];
                    case 20: return [7 /*endfinally*/];
                    case 21:
                        _c = 0, batch_1 = batch;
                        _h.label = 22;
                    case 22:
                        if (!(_c < batch_1.length)) return [3 /*break*/, 25];
                        msg = batch_1[_c];
                        return [4 /*yield*/, this.markCompleted(msg.id)];
                    case 23:
                        _h.sent();
                        _h.label = 24;
                    case 24:
                        _c++;
                        return [3 /*break*/, 22];
                    case 25: return [3 /*break*/, 32];
                    case 26:
                        err_9 = _h.sent();
                        log("Learner batch error: ".concat(err_9.message));
                        _d = 0, batch_2 = batch;
                        _h.label = 27;
                    case 27:
                        if (!(_d < batch_2.length)) return [3 /*break*/, 30];
                        msg = batch_2[_d];
                        return [4 /*yield*/, this.markFailed(msg.id)];
                    case 28:
                        _h.sent();
                        _h.label = 29;
                    case 29:
                        _d++;
                        return [3 /*break*/, 27];
                    case 30: return [3 /*break*/, 32];
                    case 31:
                        this.learnerBusy = false;
                        this.checkSessionBudget();
                        return [7 /*endfinally*/];
                    case 32: return [2 /*return*/];
                }
            });
        });
    };
    Orchestrator.prototype.checkSessionBudget = function () {
        return __awaiter(this, void 0, void 0, function () {
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0:
                        if (!(this.config.sessionBudget > 0 && this.totalCostUsd >= this.config.sessionBudget)) return [3 /*break*/, 2];
                        log("Session budget exhausted: $".concat(this.totalCostUsd.toFixed(4), " >= $").concat(this.config.sessionBudget));
                        return [4 /*yield*/, this.shutdown()];
                    case 1:
                        _a.sent();
                        _a.label = 2;
                    case 2: return [2 /*return*/];
                }
            });
        });
    };
    Orchestrator.prototype.routeToLearner = function (msg) {
        return __awaiter(this, void 0, void 0, function () {
            var payload, inputStr, responseStr, learnerPrompt, response, _a, response_8, response_8_1, sdkMsg, resultMsg, summary, e_8_1, err_10;
            var _b, e_8, _c, _d;
            return __generator(this, function (_e) {
                switch (_e.label) {
                    case 0:
                        if (!this.learnerSessionId)
                            return [2 /*return*/];
                        if (!this.learnerBusy) return [3 /*break*/, 2];
                        log("Learner busy, queuing will retry on next poll");
                        // Re-mark as pending so it gets picked up next poll
                        return [4 /*yield*/, this.db.query("UPDATE cognitive_inbox SET status = 'pending' WHERE id = $1", [msg.id])];
                    case 1:
                        // Re-mark as pending so it gets picked up next poll
                        _e.sent();
                        return [2 /*return*/];
                    case 2:
                        this.learnerBusy = true;
                        payload = msg.payload;
                        inputStr = JSON.stringify(payload.tool_input, null, 2);
                        responseStr = JSON.stringify(payload.tool_response, null, 2);
                        learnerPrompt = "[TOOL OBSERVATION]\nTool: ".concat(payload.tool_name, "\nInput: ").concat(inputStr.slice(0, 2000), "\nResult: ").concat(responseStr.slice(0, 2000), "\n\nAnalyze this tool call. If it contains a valuable learning, error solution, or reusable pattern, save it to memory (check for duplicates first). If trivial, respond with SKIP.");
                        _e.label = 3;
                    case 3:
                        _e.trys.push([3, 16, 17, 18]);
                        response = (0, claude_agent_sdk_1.query)({
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
                        _e.label = 4;
                    case 4:
                        _e.trys.push([4, 9, 10, 15]);
                        _a = true, response_8 = __asyncValues(response);
                        _e.label = 5;
                    case 5: return [4 /*yield*/, response_8.next()];
                    case 6:
                        if (!(response_8_1 = _e.sent(), _b = response_8_1.done, !_b)) return [3 /*break*/, 8];
                        _d = response_8_1.value;
                        _a = false;
                        sdkMsg = _d;
                        if (sdkMsg.type === "result") {
                            resultMsg = sdkMsg;
                            if (resultMsg.subtype === "success") {
                                summary = (resultMsg.result || "SKIP").slice(0, 200);
                                log("Learner: ".concat(summary, ", cost: $").concat(resultMsg.total_cost_usd.toFixed(4)));
                                this.totalCostUsd += resultMsg.total_cost_usd;
                                this.slidingWindow.addClaudeSummary("[Claude used ".concat(payload.tool_name, ": ").concat(summary, "]"));
                            }
                            else {
                                log("Learner error: ".concat(resultMsg.subtype));
                            }
                        }
                        _e.label = 7;
                    case 7:
                        _a = true;
                        return [3 /*break*/, 5];
                    case 8: return [3 /*break*/, 15];
                    case 9:
                        e_8_1 = _e.sent();
                        e_8 = { error: e_8_1 };
                        return [3 /*break*/, 15];
                    case 10:
                        _e.trys.push([10, , 13, 14]);
                        if (!(!_a && !_b && (_c = response_8.return))) return [3 /*break*/, 12];
                        return [4 /*yield*/, _c.call(response_8)];
                    case 11:
                        _e.sent();
                        _e.label = 12;
                    case 12: return [3 /*break*/, 14];
                    case 13:
                        if (e_8) throw e_8.error;
                        return [7 /*endfinally*/];
                    case 14: return [7 /*endfinally*/];
                    case 15: return [3 /*break*/, 18];
                    case 16:
                        err_10 = _e.sent();
                        log("Learner error: ".concat(err_10.message));
                        return [3 /*break*/, 18];
                    case 17:
                        this.learnerBusy = false;
                        this.checkSessionBudget();
                        return [7 /*endfinally*/];
                    case 18: return [2 /*return*/];
                }
            });
        });
    };
    // ============================================
    // COMPACTOR
    // ============================================
    Orchestrator.prototype.initCompactor = function () {
        return __awaiter(this, void 0, void 0, function () {
            var promptPath, systemPrompt, response, _a, response_9, response_9_1, msg, e_9_1, err_11;
            var _b, e_9, _c, _d;
            return __generator(this, function (_e) {
                switch (_e.label) {
                    case 0:
                        log("Initializing Compactor session...");
                        promptPath = path.join(__dirname, "..", "prompts", "compactor_system.md");
                        try {
                            systemPrompt = fs.readFileSync(promptPath, "utf-8");
                        }
                        catch (_f) {
                            systemPrompt = "You are a session state compactor. Summarize conversation context into a structured document with sections: IDENTITY, TASK TREE, KEY DECISIONS, WORKING CONTEXT, CONVERSATION DYNAMICS.";
                        }
                        _e.label = 1;
                    case 1:
                        _e.trys.push([1, 14, , 15]);
                        response = (0, claude_agent_sdk_1.query)({
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
                        _e.label = 2;
                    case 2:
                        _e.trys.push([2, 7, 8, 13]);
                        _a = true, response_9 = __asyncValues(response);
                        _e.label = 3;
                    case 3: return [4 /*yield*/, response_9.next()];
                    case 4:
                        if (!(response_9_1 = _e.sent(), _b = response_9_1.done, !_b)) return [3 /*break*/, 6];
                        _d = response_9_1.value;
                        _a = false;
                        msg = _d;
                        if (msg.type === "system" && "subtype" in msg && msg.subtype === "init") {
                            this.compactorSessionId = msg.session_id;
                            log("Compactor session ID: ".concat(this.compactorSessionId));
                        }
                        _e.label = 5;
                    case 5:
                        _a = true;
                        return [3 /*break*/, 3];
                    case 6: return [3 /*break*/, 13];
                    case 7:
                        e_9_1 = _e.sent();
                        e_9 = { error: e_9_1 };
                        return [3 /*break*/, 13];
                    case 8:
                        _e.trys.push([8, , 11, 12]);
                        if (!(!_a && !_b && (_c = response_9.return))) return [3 /*break*/, 10];
                        return [4 /*yield*/, _c.call(response_9)];
                    case 9:
                        _e.sent();
                        _e.label = 10;
                    case 10: return [3 /*break*/, 12];
                    case 11:
                        if (e_9) throw e_9.error;
                        return [7 /*endfinally*/];
                    case 12: return [7 /*endfinally*/];
                    case 13: return [3 /*break*/, 15];
                    case 14:
                        err_11 = _e.sent();
                        log("Compactor init error: ".concat(err_11.message));
                        return [3 /*break*/, 15];
                    case 15: return [2 /*return*/];
                }
            });
        });
    };
    Orchestrator.prototype.startCompactorMonitor = function () {
        var _this = this;
        // Check transcript size periodically
        this.compactorTimer = setInterval(function () { return __awaiter(_this, void 0, void 0, function () {
            var err_12;
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0:
                        if (!this.running || this.compactorBusy || !this.compactorSessionId)
                            return [2 /*return*/];
                        _a.label = 1;
                    case 1:
                        _a.trys.push([1, 3, , 4]);
                        return [4 /*yield*/, this.checkAndRunCompactor()];
                    case 2:
                        _a.sent();
                        return [3 /*break*/, 4];
                    case 3:
                        err_12 = _a.sent();
                        log("Compactor monitor error: ".concat(err_12.message));
                        return [3 /*break*/, 4];
                    case 4: return [2 /*return*/];
                }
            });
        }); }, this.config.compactorCheckIntervalMs);
    };
    Orchestrator.prototype.checkAndRunCompactor = function () {
        return __awaiter(this, void 0, void 0, function () {
            var transcriptPath, fileSize, stat, estimatedTokens, tokensSinceLastCompact;
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0:
                        transcriptPath = this.config.transcriptPath;
                        if (!transcriptPath) {
                            log("Compactor check: no transcript path configured");
                            return [2 /*return*/];
                        }
                        try {
                            stat = fs.statSync(transcriptPath);
                            fileSize = stat.size;
                        }
                        catch (err) {
                            log("Compactor check: transcript not accessible: ".concat(err.message));
                            return [2 /*return*/];
                        }
                        estimatedTokens = Math.floor(fileSize / 6);
                        tokensSinceLastCompact = estimatedTokens - this.lastCompactedSize;
                        if (tokensSinceLastCompact < this.config.compactorTokenThreshold)
                            return [2 /*return*/];
                        log("Compactor triggered: ~".concat(estimatedTokens, " tokens total, ~").concat(tokensSinceLastCompact, " since last compact"));
                        return [4 /*yield*/, this.runCompactor(transcriptPath, estimatedTokens)];
                    case 1:
                        _a.sent();
                        return [2 /*return*/];
                }
            });
        });
    };
    Orchestrator.prototype.runCompactor = function (transcriptPath, currentTokenEstimate) {
        return __awaiter(this, void 0, void 0, function () {
            var rawContent, lines, allChunks, byteOffset, i, lineBytes, entry, content, blocks, text, prevResult, previousState, previousVersion, maxChars, conversationChunks, charsCollected, i, compactorPrompt, response, stateText, _a, response_10, response_10_1, sdkMsg, resultMsg, e_10_1, tailChunks, rawTailDir, rawTailPath, err_13;
            var _b, e_10, _c, _d;
            var _e, _f;
            return __generator(this, function (_g) {
                switch (_g.label) {
                    case 0:
                        if (!this.compactorSessionId)
                            return [2 /*return*/];
                        this.compactorBusy = true;
                        _g.label = 1;
                    case 1:
                        _g.trys.push([1, 16, 17, 18]);
                        rawContent = fs.readFileSync(transcriptPath, "utf-8");
                        lines = rawContent.split("\n").filter(function (l) { return l.trim(); });
                        allChunks = [];
                        byteOffset = 0;
                        for (i = 0; i < lines.length; i++) {
                            lineBytes = lines[i].length + 1;
                            try {
                                entry = JSON.parse(lines[i]);
                                if (entry.type === "user" && ((_e = entry.message) === null || _e === void 0 ? void 0 : _e.content)) {
                                    content = typeof entry.message.content === "string"
                                        ? entry.message.content
                                        : JSON.stringify(entry.message.content);
                                    allChunks.push({ text: "[USER] ".concat(content.slice(0, 3000)), byteOffset: byteOffset });
                                }
                                else if (entry.type === "assistant" && ((_f = entry.message) === null || _f === void 0 ? void 0 : _f.content)) {
                                    blocks = entry.message.content;
                                    if (Array.isArray(blocks)) {
                                        text = blocks
                                            .filter(function (b) { return b.type === "text"; })
                                            .map(function (b) { return b.text; })
                                            .join("\n");
                                        if (text) {
                                            allChunks.push({ text: "[CLAUDE] ".concat(text.slice(0, 3000)), byteOffset: byteOffset });
                                        }
                                    }
                                }
                            }
                            catch (_h) {
                                // Skip malformed lines (progress entries, etc.)
                            }
                            byteOffset += lineBytes;
                        }
                        log("Compactor: ".concat(lines.length, " lines, ").concat(allChunks.length, " conversation chunks"));
                        return [4 /*yield*/, this.db.query("SELECT state_text, version FROM session_state\n         WHERE session_id = $1\n         ORDER BY version DESC LIMIT 1", [this.config.sessionId])];
                    case 2:
                        prevResult = _g.sent();
                        previousState = prevResult.rows.length > 0 ? prevResult.rows[0].state_text : "";
                        previousVersion = prevResult.rows.length > 0 ? prevResult.rows[0].version : 0;
                        this.compactorVersion = previousVersion + 1;
                        maxChars = previousVersion === 0 ? 45000 : 25000;
                        conversationChunks = [];
                        charsCollected = 0;
                        for (i = allChunks.length - 1; i >= 0; i--) {
                            if (charsCollected + allChunks[i].text.length > maxChars)
                                break;
                            conversationChunks.unshift(allChunks[i].text);
                            charsCollected += allChunks[i].text.length;
                        }
                        if (conversationChunks.length === 0) {
                            log("Compactor: no conversation content found");
                            this.compactorBusy = false;
                            return [2 /*return*/];
                        }
                        log("Compactor: using ".concat(maxChars, " char window (v").concat(this.compactorVersion, ", prev=").concat(previousVersion, "), collected ").concat(charsCollected, " chars from ").concat(conversationChunks.length, " chunks"));
                        compactorPrompt = previousState
                            ? "[UPDATE REQUEST - Version ".concat(this.compactorVersion, "]\n\n[PREVIOUS STATE]\n").concat(previousState, "\n\n[NEW CONVERSATION SINCE LAST UPDATE]\n").concat(conversationChunks.join("\n\n"), "\n\nUpdate the session state document. Follow the update rules: append KEY DECISIONS, replace WORKING CONTEXT, update TASK TREE and CONVERSATION DYNAMICS.")
                            : "[INITIAL STATE REQUEST - Version 1]\n\n[CONVERSATION]\n".concat(conversationChunks.join("\n\n"), "\n\nBuild the initial session state document from this conversation.");
                        response = (0, claude_agent_sdk_1.query)({
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
                        stateText = "";
                        _g.label = 3;
                    case 3:
                        _g.trys.push([3, 8, 9, 14]);
                        _a = true, response_10 = __asyncValues(response);
                        _g.label = 4;
                    case 4: return [4 /*yield*/, response_10.next()];
                    case 5:
                        if (!(response_10_1 = _g.sent(), _b = response_10_1.done, !_b)) return [3 /*break*/, 7];
                        _d = response_10_1.value;
                        _a = false;
                        sdkMsg = _d;
                        if (sdkMsg.type === "result") {
                            resultMsg = sdkMsg;
                            if (resultMsg.subtype === "success") {
                                stateText = resultMsg.result || "";
                                log("Compactor v".concat(this.compactorVersion, ": ").concat(stateText.length, " chars, cost: $").concat(resultMsg.total_cost_usd.toFixed(4)));
                            }
                            else {
                                log("Compactor error: ".concat(resultMsg.subtype));
                                log("Compactor error details: ".concat(JSON.stringify(resultMsg).slice(0, 500)));
                            }
                        }
                        _g.label = 6;
                    case 6:
                        _a = true;
                        return [3 /*break*/, 4];
                    case 7: return [3 /*break*/, 14];
                    case 8:
                        e_10_1 = _g.sent();
                        e_10 = { error: e_10_1 };
                        return [3 /*break*/, 14];
                    case 9:
                        _g.trys.push([9, , 12, 13]);
                        if (!(!_a && !_b && (_c = response_10.return))) return [3 /*break*/, 11];
                        return [4 /*yield*/, _c.call(response_10)];
                    case 10:
                        _g.sent();
                        _g.label = 11;
                    case 11: return [3 /*break*/, 13];
                    case 12:
                        if (e_10) throw e_10.error;
                        return [7 /*endfinally*/];
                    case 13: return [7 /*endfinally*/];
                    case 14:
                        if (!stateText || stateText.length < 50) {
                            log("Compactor: empty or too short result, skipping save");
                            return [2 /*return*/];
                        }
                        tailChunks = conversationChunks.slice(-Math.ceil(conversationChunks.length / 2));
                        rawTailDir = path.join(path.dirname(transcriptPath), "compactor_tails");
                        try {
                            fs.mkdirSync(rawTailDir, { recursive: true });
                        }
                        catch ( /* exists */_j) { /* exists */ }
                        rawTailPath = path.join(rawTailDir, "".concat(this.config.sessionId, "_v").concat(this.compactorVersion, ".txt"));
                        fs.writeFileSync(rawTailPath, tailChunks.join("\n\n"), "utf-8");
                        // 6. Save state to DB
                        return [4 /*yield*/, this.db.query("INSERT INTO session_state (session_id, project_slug, state_text, raw_tail_path, token_estimate, version)\n         VALUES ($1, $2, $3, $4, $5, $6)", [
                                this.config.sessionId,
                                this.config.projectSlug,
                                stateText,
                                rawTailPath,
                                currentTokenEstimate,
                                this.compactorVersion,
                            ])];
                    case 15:
                        // 6. Save state to DB
                        _g.sent();
                        this.lastCompactedSize = currentTokenEstimate;
                        log("Compactor: saved state v".concat(this.compactorVersion, " to DB + raw tail to ").concat(rawTailPath));
                        // Clear injection history — compaction means the main session context was reset
                        this.clearInjectionHistory();
                        log("Compactor: cleared injection history");
                        return [3 /*break*/, 18];
                    case 16:
                        err_13 = _g.sent();
                        log("Compactor error: ".concat(err_13.message));
                        if (err_13.stack)
                            log("Compactor stack: ".concat(err_13.stack.slice(0, 500)));
                        return [3 /*break*/, 18];
                    case 17:
                        this.compactorBusy = false;
                        return [7 /*endfinally*/];
                    case 18: return [2 /*return*/];
                }
            });
        });
    };
    // ============================================
    // CURATOR
    // ============================================
    Orchestrator.prototype.initCurator = function () {
        return __awaiter(this, void 0, void 0, function () {
            var promptPath, systemPrompt, response, _a, response_11, response_11_1, msg, e_11_1, err_14;
            var _b, e_11, _c, _d;
            return __generator(this, function (_e) {
                switch (_e.label) {
                    case 0:
                        log("Initializing Curator session...");
                        promptPath = path.join(__dirname, "..", "prompts", "curator_system.md");
                        try {
                            systemPrompt = fs.readFileSync(promptPath, "utf-8");
                        }
                        catch (_f) {
                            systemPrompt = "You are a memory database curator. Merge duplicates, archive stale entries, detect contradictions, and consolidate patterns. Report all actions.";
                        }
                        _e.label = 1;
                    case 1:
                        _e.trys.push([1, 14, , 15]);
                        response = (0, claude_agent_sdk_1.query)({
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
                        _e.label = 2;
                    case 2:
                        _e.trys.push([2, 7, 8, 13]);
                        _a = true, response_11 = __asyncValues(response);
                        _e.label = 3;
                    case 3: return [4 /*yield*/, response_11.next()];
                    case 4:
                        if (!(response_11_1 = _e.sent(), _b = response_11_1.done, !_b)) return [3 /*break*/, 6];
                        _d = response_11_1.value;
                        _a = false;
                        msg = _d;
                        if (msg.type === "system" && "subtype" in msg && msg.subtype === "init") {
                            this.curatorSessionId = msg.session_id;
                            log("Curator session ID: ".concat(this.curatorSessionId));
                        }
                        _e.label = 5;
                    case 5:
                        _a = true;
                        return [3 /*break*/, 3];
                    case 6: return [3 /*break*/, 13];
                    case 7:
                        e_11_1 = _e.sent();
                        e_11 = { error: e_11_1 };
                        return [3 /*break*/, 13];
                    case 8:
                        _e.trys.push([8, , 11, 12]);
                        if (!(!_a && !_b && (_c = response_11.return))) return [3 /*break*/, 10];
                        return [4 /*yield*/, _c.call(response_11)];
                    case 9:
                        _e.sent();
                        _e.label = 10;
                    case 10: return [3 /*break*/, 12];
                    case 11:
                        if (e_11) throw e_11.error;
                        return [7 /*endfinally*/];
                    case 12: return [7 /*endfinally*/];
                    case 13: return [3 /*break*/, 15];
                    case 14:
                        err_14 = _e.sent();
                        log("Curator init error: ".concat(err_14.message));
                        return [3 /*break*/, 15];
                    case 15: return [2 /*return*/];
                }
            });
        });
    };
    Orchestrator.prototype.startCuratorSchedule = function () {
        var _this = this;
        this.lastCuratorRun = Date.now();
        this.curatorTimer = setInterval(function () { return __awaiter(_this, void 0, void 0, function () {
            var elapsed;
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0:
                        if (!this.running || this.curatorBusy || !this.curatorSessionId)
                            return [2 /*return*/];
                        elapsed = Date.now() - this.lastCuratorRun;
                        if (!(elapsed >= this.config.curatorIntervalMs)) return [3 /*break*/, 2];
                        return [4 /*yield*/, this.runCurator()];
                    case 1:
                        _a.sent();
                        _a.label = 2;
                    case 2: return [2 /*return*/];
                }
            });
        }); }, 60000); // Check every minute if it's time to run
    };
    Orchestrator.prototype.runCurator = function () {
        return __awaiter(this, void 0, void 0, function () {
            var curatorPrompt, response, _a, response_12, response_12_1, sdkMsg, resultMsg, report, e_12_1, err_15;
            var _b, e_12, _c, _d;
            return __generator(this, function (_e) {
                switch (_e.label) {
                    case 0:
                        if (!this.curatorSessionId || this.curatorBusy)
                            return [2 /*return*/];
                        this.curatorBusy = true;
                        this.lastCuratorRun = Date.now();
                        log("Curator triggered: starting maintenance run...");
                        curatorPrompt = "[MAINTENANCE RUN \u2014 ".concat(new Date().toISOString(), "]\n\nRun your full maintenance workflow:\n1. Scan for duplicate learnings/patterns (>80% overlap) \u2014 merge up to 10\n2. Archive stale entries (not retrieved in 30+ days, created 7+ days ago) \u2014 lower confidence\n3. Detect contradictions \u2014 flag them\n4. Consolidate related learnings into patterns if 3+ share a theme\n5. Produce your report\n\nBe efficient. If the database is clean, report \"No actions needed\".");
                        _e.label = 1;
                    case 1:
                        _e.trys.push([1, 14, 15, 16]);
                        response = (0, claude_agent_sdk_1.query)({
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
                        _e.label = 2;
                    case 2:
                        _e.trys.push([2, 7, 8, 13]);
                        _a = true, response_12 = __asyncValues(response);
                        _e.label = 3;
                    case 3: return [4 /*yield*/, response_12.next()];
                    case 4:
                        if (!(response_12_1 = _e.sent(), _b = response_12_1.done, !_b)) return [3 /*break*/, 6];
                        _d = response_12_1.value;
                        _a = false;
                        sdkMsg = _d;
                        if (sdkMsg.type === "result") {
                            resultMsg = sdkMsg;
                            if (resultMsg.subtype === "success") {
                                report = (resultMsg.result || "No report").slice(0, 500);
                                log("Curator report: ".concat(report));
                                log("Curator cost: $".concat(resultMsg.total_cost_usd.toFixed(4)));
                                this.totalCostUsd += resultMsg.total_cost_usd;
                            }
                            else {
                                log("Curator error: ".concat(resultMsg.subtype));
                            }
                        }
                        _e.label = 5;
                    case 5:
                        _a = true;
                        return [3 /*break*/, 3];
                    case 6: return [3 /*break*/, 13];
                    case 7:
                        e_12_1 = _e.sent();
                        e_12 = { error: e_12_1 };
                        return [3 /*break*/, 13];
                    case 8:
                        _e.trys.push([8, , 11, 12]);
                        if (!(!_a && !_b && (_c = response_12.return))) return [3 /*break*/, 10];
                        return [4 /*yield*/, _c.call(response_12)];
                    case 9:
                        _e.sent();
                        _e.label = 10;
                    case 10: return [3 /*break*/, 12];
                    case 11:
                        if (e_12) throw e_12.error;
                        return [7 /*endfinally*/];
                    case 12: return [7 /*endfinally*/];
                    case 13: return [3 /*break*/, 16];
                    case 14:
                        err_15 = _e.sent();
                        log("Curator error: ".concat(err_15.message));
                        return [3 /*break*/, 16];
                    case 15:
                        this.curatorBusy = false;
                        this.checkSessionBudget();
                        return [7 /*endfinally*/];
                    case 16: return [2 /*return*/];
                }
            });
        });
    };
    // ============================================
    // SHUTDOWN
    // ============================================
    Orchestrator.prototype.checkShutdownSignal = function () {
        return __awaiter(this, void 0, void 0, function () {
            var result;
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0: return [4 /*yield*/, this.db.query("SELECT status FROM orchestrator_state WHERE session_id = $1", [this.config.sessionId])];
                    case 1:
                        result = _a.sent();
                        if (!(result.rows.length > 0 && result.rows[0].status === "stopping")) return [3 /*break*/, 3];
                        return [4 /*yield*/, this.shutdown()];
                    case 2:
                        _a.sent();
                        _a.label = 3;
                    case 3: return [2 /*return*/];
                }
            });
        });
    };
    Orchestrator.prototype.shutdown = function () {
        return __awaiter(this, void 0, void 0, function () {
            var shutdownTimeout, _a, _b, _c;
            return __generator(this, function (_d) {
                switch (_d.label) {
                    case 0:
                        if (!this.running)
                            return [2 /*return*/];
                        this.running = false;
                        log("Shutting down...");
                        // Clear all intervals immediately
                        if (this.pollTimer)
                            clearInterval(this.pollTimer);
                        if (this.heartbeatTimer)
                            clearInterval(this.heartbeatTimer);
                        if (this.compactorTimer)
                            clearInterval(this.compactorTimer);
                        if (this.curatorTimer)
                            clearInterval(this.curatorTimer);
                        if (this.learnerBatchTimer)
                            clearTimeout(this.learnerBatchTimer);
                        this.pollTimer = undefined;
                        this.heartbeatTimer = undefined;
                        this.compactorTimer = undefined;
                        this.curatorTimer = undefined;
                        this.learnerBatchTimer = undefined;
                        shutdownTimeout = setTimeout(function () {
                            log("Shutdown timeout — force exit");
                            process.exit(0);
                        }, 5000);
                        _d.label = 1;
                    case 1:
                        _d.trys.push([1, 3, , 4]);
                        return [4 /*yield*/, this.db.query("UPDATE orchestrator_state SET status = 'stopped', stopped_at = CURRENT_TIMESTAMP\n         WHERE session_id = $1", [this.config.sessionId])];
                    case 2:
                        _d.sent();
                        return [3 /*break*/, 4];
                    case 3:
                        _a = _d.sent();
                        return [3 /*break*/, 4];
                    case 4:
                        _d.trys.push([4, 6, , 7]);
                        return [4 /*yield*/, this.db.query("UPDATE cognitive_inbox SET status = 'failed'\n         WHERE session_id = $1 AND status IN ('pending', 'processing')", [this.config.sessionId])];
                    case 5:
                        _d.sent();
                        return [3 /*break*/, 7];
                    case 6:
                        _b = _d.sent();
                        return [3 /*break*/, 7];
                    case 7:
                        _d.trys.push([7, 9, , 10]);
                        return [4 /*yield*/, this.db.end()];
                    case 8:
                        _d.sent();
                        return [3 /*break*/, 10];
                    case 9:
                        _c = _d.sent();
                        return [3 /*break*/, 10];
                    case 10:
                        clearTimeout(shutdownTimeout);
                        log("Shutdown complete.");
                        process.exit(0);
                        return [2 /*return*/];
                }
            });
        });
    };
    return Orchestrator;
}());
// ============================================
// LOGGING
// ============================================
function log(message) {
    var ts = new Date().toISOString();
    console.log("[".concat(ts, "] [aidam-orchestrator] ").concat(message));
}
// ============================================
// CLI ENTRY POINT
// ============================================
function main() {
    return __awaiter(this, void 0, void 0, function () {
        var args, getArg, sessionId, config, stat, orchestrator, err_16, crashDb, _a;
        return __generator(this, function (_b) {
            switch (_b.label) {
                case 0:
                    args = process.argv.slice(2);
                    getArg = function (name, defaultVal) {
                        if (defaultVal === void 0) { defaultVal = ""; }
                        var arg = args.find(function (a) { return a.startsWith("--".concat(name, "=")); });
                        return arg ? arg.split("=").slice(1).join("=") : defaultVal;
                    };
                    sessionId = getArg("session-id");
                    if (!sessionId) {
                        console.error("Error: --session-id is required");
                        process.exit(1);
                    }
                    config = {
                        sessionId: sessionId,
                        cwd: getArg("cwd", process.cwd()),
                        retrieverEnabled: getArg("retriever", "on") !== "off",
                        learnerEnabled: getArg("learner", "on") !== "off",
                        compactorEnabled: getArg("compactor", "on") !== "off",
                        curatorEnabled: getArg("curator", "off") !== "off",
                        pollIntervalMs: 2000,
                        heartbeatIntervalMs: 30000,
                        compactorCheckIntervalMs: 30000, // Check every 30s
                        compactorTokenThreshold: 20000, // Compact every ~20k new tokens
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
                    log("Config: session=".concat(config.sessionId, ", retriever=").concat(config.retrieverEnabled, ", learner=").concat(config.learnerEnabled, ", compactor=").concat(config.compactorEnabled, ", curator=").concat(config.curatorEnabled));
                    log("Budgets: retrieverA=$".concat(config.retrieverABudget, ", retrieverB=$").concat(config.retrieverBBudget, ", learner=$").concat(config.learnerBudget, ", compactor=$").concat(config.compactorBudget, ", curator=$").concat(config.curatorBudget, ", session=$").concat(config.sessionBudget));
                    log("Batch: window=".concat(config.batchWindowMs, "ms, min=").concat(config.batchMinSize, ", max=").concat(config.batchMaxSize));
                    if (config.transcriptPath) {
                        log("Transcript path: ".concat(config.transcriptPath));
                        try {
                            stat = fs.statSync(config.transcriptPath);
                            log("Transcript exists: ".concat(stat.size, " bytes"));
                        }
                        catch (err) {
                            log("Transcript NOT accessible: ".concat(err.message));
                        }
                    }
                    else {
                        log("WARNING: No transcript path provided!");
                    }
                    orchestrator = new Orchestrator(config);
                    _b.label = 1;
                case 1:
                    _b.trys.push([1, 3, , 10]);
                    return [4 /*yield*/, orchestrator.start()];
                case 2:
                    _b.sent();
                    return [3 /*break*/, 10];
                case 3:
                    err_16 = _b.sent();
                    log("Fatal error: ".concat(err_16.message));
                    _b.label = 4;
                case 4:
                    _b.trys.push([4, 8, , 9]);
                    crashDb = new pg_1.Client(DB_CONFIG);
                    return [4 /*yield*/, crashDb.connect()];
                case 5:
                    _b.sent();
                    return [4 /*yield*/, crashDb.query("UPDATE orchestrator_state SET status = 'crashed', error_message = $2, stopped_at = CURRENT_TIMESTAMP\n         WHERE session_id = $1", [config.sessionId, String(err_16)])];
                case 6:
                    _b.sent();
                    return [4 /*yield*/, crashDb.end()];
                case 7:
                    _b.sent();
                    return [3 /*break*/, 9];
                case 8:
                    _a = _b.sent();
                    return [3 /*break*/, 9];
                case 9:
                    process.exit(1);
                    return [3 /*break*/, 10];
                case 10: return [2 /*return*/];
            }
        });
    });
}
main();
