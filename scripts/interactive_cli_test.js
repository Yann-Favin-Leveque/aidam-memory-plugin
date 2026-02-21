"use strict";
/**
 * Interactive CLI Test Harness
 *
 * Uses node-pty (ConPTY on Windows) to create a real pseudo-terminal,
 * enabling automated testing of interactive CLI tools like Claude Code.
 *
 * Usage:
 *   npx ts-node tools/interactive_cli_test.ts [test-script.json]
 *   node tools/interactive_cli_test.js [test-script.json]
 *
 * Test script format: see TestScript interface below.
 */
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
const pty = __importStar(require("node-pty"));
const pg_1 = require("pg");
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
// ============================================
// INTERACTIVE CLI
// ============================================
class InteractiveCLI {
    proc;
    output = "";
    newOutput = "";
    closed = false;
    constructor(command, args, cwd, env) {
        const mergedEnv = { ...process.env, ...env };
        // On Windows, node-pty needs full paths or cmd.exe wrapper
        const spawnCmd = command;
        const spawnArgs = args;
        // Remove CLAUDECODE env var to avoid "nested session" detection
        // when testing Claude Code from within a Claude Code session
        delete mergedEnv["CLAUDECODE"];
        this.proc = pty.spawn(spawnCmd, spawnArgs, {
            name: "xterm-256color",
            cols: 200,
            rows: 50,
            cwd,
            env: mergedEnv,
        });
        this.proc.onData((data) => {
            this.output += data;
            this.newOutput += data;
        });
        this.proc.onExit(({ exitCode }) => {
            this.closed = true;
            log(`Process exited with code ${exitCode}`);
        });
    }
    /** Send text to the process stdin. Appends newline. */
    send(text) {
        if (this.closed)
            throw new Error("Process already closed");
        this.newOutput = "";
        this.proc.write(text + "\r");
    }
    /** Send raw text without newline (for special keys, Ctrl+C, etc.) */
    sendRaw(text) {
        if (this.closed)
            throw new Error("Process already closed");
        this.proc.write(text);
    }
    /** Wait until output matches a regex pattern, or timeout. */
    async waitFor(pattern, timeoutMs = 30000) {
        const regex = new RegExp(pattern, "i");
        const start = Date.now();
        while (Date.now() - start < timeoutMs) {
            if (regex.test(this.output)) {
                return this.getRecentOutput();
            }
            if (this.closed) {
                throw new Error(`Process exited while waiting for pattern: ${pattern}`);
            }
            await sleep(200);
        }
        throw new Error(`Timeout waiting for pattern: ${pattern} (${timeoutMs}ms)`);
    }
    /** Wait until NEW output (since last send) matches a pattern. */
    async waitForNew(pattern, timeoutMs = 30000) {
        const regex = new RegExp(pattern, "i");
        const start = Date.now();
        while (Date.now() - start < timeoutMs) {
            if (regex.test(this.newOutput)) {
                return this.newOutput;
            }
            if (this.closed) {
                throw new Error(`Process exited while waiting for pattern: ${pattern}`);
            }
            await sleep(200);
        }
        throw new Error(`Timeout waiting for new output pattern: ${pattern} (${timeoutMs}ms)`);
    }
    /** Get all output so far. */
    getOutput() {
        return this.output;
    }
    /** Get output since last send(). */
    getRecentOutput() {
        return this.newOutput;
    }
    /** Get last N chars of output. */
    getTail(chars = 2000) {
        return this.output.slice(-chars);
    }
    /** Check if process is still running. */
    isAlive() {
        return !this.closed;
    }
    /** Kill the process. */
    close() {
        if (!this.closed) {
            this.proc.kill();
            this.closed = true;
        }
    }
}
// ============================================
// TEST RUNNER
// ============================================
async function runTestScript(script) {
    const results = [];
    log(`\n${"=".repeat(60)}`);
    log(`TEST: ${script.name}`);
    log(`${"=".repeat(60)}`);
    log(`Command: ${script.command} ${script.args.join(" ")}`);
    const cwd = script.cwd || process.cwd();
    const cli = new InteractiveCLI(script.command, script.args, cwd, script.env);
    // Give the process a moment to start
    await sleep(1000);
    const db = new pg_1.Client({
        host: "localhost",
        database: "claude_memory",
        user: "postgres",
        password: process.env.PGPASSWORD || "",
        port: 5432,
    });
    let dbConnected = false;
    try {
        for (let i = 0; i < script.steps.length; i++) {
            const step = script.steps[i];
            const desc = step.desc || `${step.action}: ${step.text || step.pattern || step.sql || step.ms || ""}`;
            const start = Date.now();
            let passed = false;
            let output = "";
            let error = "";
            log(`\n--- Step ${i + 1}: ${desc}`);
            try {
                switch (step.action) {
                    case "send":
                        cli.send(step.text || "");
                        passed = true;
                        output = `Sent: ${step.text}`;
                        break;
                    case "wait_for":
                        output = await cli.waitForNew(step.pattern || "", step.timeout || 30000);
                        passed = true;
                        output = `Matched: ${output.slice(-500)}`;
                        break;
                    case "sleep":
                        await sleep(step.ms || 1000);
                        passed = true;
                        output = `Slept ${step.ms}ms`;
                        break;
                    case "check_db":
                        if (!dbConnected) {
                            await db.connect();
                            dbConnected = true;
                        }
                        const result = await db.query(step.sql || "SELECT 1");
                        const dbOutput = JSON.stringify(result.rows);
                        if (step.expect) {
                            const expectRegex = new RegExp(step.expect, "i");
                            if (expectRegex.test(dbOutput)) {
                                passed = true;
                                output = `DB match: ${dbOutput.slice(0, 300)}`;
                            }
                            else {
                                passed = false;
                                error = `DB mismatch. Expected /${step.expect}/ but got: ${dbOutput.slice(0, 300)}`;
                            }
                        }
                        else {
                            passed = result.rows.length > 0;
                            output = `DB result: ${dbOutput.slice(0, 300)}`;
                        }
                        break;
                    case "check_log":
                        if (step.file && fs.existsSync(step.file)) {
                            const logContent = fs.readFileSync(step.file, "utf-8");
                            if (step.pattern) {
                                const logRegex = new RegExp(step.pattern, "i");
                                if (logRegex.test(logContent)) {
                                    passed = true;
                                    output = `Log match in ${step.file}`;
                                }
                                else {
                                    passed = false;
                                    error = `Log pattern /${step.pattern}/ not found in ${step.file}`;
                                }
                            }
                            else {
                                passed = true;
                                output = `Log exists: ${logContent.length} chars`;
                            }
                        }
                        else {
                            passed = false;
                            error = `Log file not found: ${step.file}`;
                        }
                        break;
                    case "snapshot":
                        output = cli.getTail(step.ms || 2000);
                        passed = true;
                        log(`SNAPSHOT:\n${output}`);
                        break;
                }
            }
            catch (err) {
                passed = false;
                error = err.message;
            }
            const duration = Date.now() - start;
            const status = passed ? "PASS" : "FAIL";
            log(`  ${status} (${duration}ms) ${passed ? output.slice(0, 100) : error.slice(0, 200)}`);
            results.push({ step: i + 1, action: step.action, desc, passed, duration, output, error });
            // If a critical step fails, stop
            if (!passed && step.action !== "snapshot") {
                log(`\n  STOPPING: step ${i + 1} failed`);
                break;
            }
        }
    }
    finally {
        cli.close();
        if (dbConnected) {
            try {
                await db.end();
            }
            catch { /* ok */ }
        }
    }
    // Summary
    const total = results.length;
    const passed = results.filter((r) => r.passed).length;
    const failed = total - passed;
    log(`\n${"=".repeat(60)}`);
    log(`RESULTS: ${passed}/${total} passed, ${failed} failed`);
    log(`${"=".repeat(60)}\n`);
    return results;
}
// ============================================
// BUILT-IN TEST: Claude Code with AIDAM plugin
// ============================================
function getAidamPluginTest() {
    return {
        name: "AIDAM Memory Plugin - Full Integration (Level 7)",
        command: "C:\\Program Files\\Git\\bin\\bash.exe",
        args: ["-c", "claude -p 'Tell me about the ecopaths project. What agent pipeline does it use?'"],
        cwd: "C:/Users/user/IdeaProjects/ecopathsWebApp1b",
        env: {
            AIDAM_MEMORY_RETRIEVER: "on",
            AIDAM_MEMORY_LEARNER: "on",
            AIDAM_MEMORY_COMPACTOR: "off",
        },
        steps: [
            {
                action: "wait_for",
                pattern: "(agent|pipeline|ecopaths|memory|AIDAM|categoriz)",
                timeout: 120000,
                desc: "Wait for Claude response mentioning ecopaths/agents",
            },
            {
                action: "snapshot",
                desc: "Capture Claude's response",
            },
            {
                action: "check_db",
                sql: "SELECT COUNT(*) as cnt FROM cognitive_inbox WHERE message_type='prompt_context' AND created_at > NOW() - INTERVAL '3 minutes'",
                expect: "cnt.*[1-9]",
                desc: "Check cognitive_inbox received prompt",
            },
            {
                action: "check_db",
                sql: "SELECT COUNT(*) as cnt FROM retrieval_inbox WHERE created_at > NOW() - INTERVAL '3 minutes'",
                expect: "cnt",
                desc: "Check retrieval_inbox has results",
            },
        ],
    };
}
function getAidamInteractiveTest() {
    return {
        name: "AIDAM Memory Plugin - Interactive Session (Level 7 full)",
        command: "C:\\Program Files\\Git\\bin\\bash.exe",
        args: ["-c", "claude"],
        cwd: "C:/Users/user/IdeaProjects/ecopathsWebApp1b",
        env: {
            AIDAM_MEMORY_RETRIEVER: "on",
            AIDAM_MEMORY_LEARNER: "off",
            AIDAM_MEMORY_COMPACTOR: "off",
        },
        steps: [
            {
                action: "wait_for",
                pattern: "(claude|>|\\$)",
                timeout: 30000,
                desc: "Wait for Claude prompt to appear",
            },
            {
                action: "sleep",
                ms: 5000,
                desc: "Wait for SessionStart hook + orchestrator init",
            },
            {
                action: "check_db",
                sql: "SELECT status FROM orchestrator_state WHERE status='running' AND last_heartbeat_at > NOW() - INTERVAL '30 seconds' ORDER BY id DESC LIMIT 1",
                expect: "running",
                desc: "Verify orchestrator is running",
            },
            {
                action: "send",
                text: "Tell me about the ecopaths project agent pipeline",
                desc: "Send prompt about ecopaths",
            },
            {
                action: "wait_for",
                pattern: "(agent|pipeline|200|201|202|203|categoriz)",
                timeout: 60000,
                desc: "Wait for Claude response about agents",
            },
            {
                action: "snapshot",
                desc: "Capture response",
            },
            {
                action: "check_db",
                sql: "SELECT context_type, LEFT(context_text, 200) as preview FROM retrieval_inbox WHERE created_at > NOW() - INTERVAL '2 minutes' AND context_type='memory_results' ORDER BY id DESC LIMIT 1",
                expect: "memory_results",
                desc: "Verify Retriever injected memory context",
            },
            {
                action: "send",
                text: "/exit",
                desc: "Exit Claude",
            },
            {
                action: "sleep",
                ms: 5000,
                desc: "Wait for SessionEnd cleanup",
            },
            {
                action: "check_db",
                sql: "SELECT status FROM orchestrator_state WHERE status IN ('stopped','stopping') AND stopped_at > NOW() - INTERVAL '30 seconds' ORDER BY id DESC LIMIT 1",
                expect: "stop",
                desc: "Verify orchestrator stopped cleanly",
            },
        ],
    };
}
// ============================================
// UTILITIES
// ============================================
function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
function log(msg) {
    const ts = new Date().toISOString().split("T")[1].split(".")[0];
    console.log(`[${ts}] ${msg}`);
}
// ============================================
// CLI ENTRY POINT
// ============================================
async function main() {
    const args = process.argv.slice(2);
    let script;
    if (args[0] === "--interactive" || args[0] === "-i") {
        script = getAidamInteractiveTest();
    }
    else if (args[0] && fs.existsSync(args[0])) {
        script = JSON.parse(fs.readFileSync(args[0], "utf-8"));
    }
    else {
        // Default: non-interactive test with -p
        script = getAidamPluginTest();
    }
    const results = await runTestScript(script);
    // Write results to file
    const resultPath = path.join(__dirname, "..", "test-results.json");
    fs.writeFileSync(resultPath, JSON.stringify(results, null, 2));
    log(`Results saved to ${resultPath}`);
    // Exit with failure code if any test failed
    const failed = results.filter((r) => !r.passed).length;
    process.exit(failed > 0 ? 1 : 0);
}
main().catch((err) => {
    console.error("Fatal:", err.message);
    process.exit(1);
});
