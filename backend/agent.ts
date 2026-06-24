/**
 * backend/agent.ts
 *
 * Core PayFi Agent orchestrator.
 *
 * Config usage pattern:
 *   - All network/identity values come from the validated `config` singleton.
 *   - Tools that need the Keypair call `config.agentKeypair()` explicitly —
 *     the secret never lives on the config object itself.
 *   - The spending limit is enforced here before delegating to tools.
 */

import { EventEmitter } from "events";
import { config, MAINNET_SPENDING_CAP } from "./config";
import { StellarPaymentTool } from "./tools/StellarPaymentTool";
import { SorobanInvokeTool } from "./tools/SorobanInvokeTool";
import { X402PaymentTool } from "./tools/X402PaymentTool";
import { createLogger, generateCorrelationId } from "./utils/logger";

const log = createLogger("orchestrator");

// ─── Task types ───────────────────────────────────────────────────────────────

export type TaskType = "stellar_payment" | "soroban_invoke" | "x402_respond";

export interface AgentTask {
  type: TaskType;
  payload: unknown;
}

export interface AgentResult {
  success: boolean;
  taskType: TaskType;
  data?: unknown;
  error?: string;
}

// ─── Spending limit guard ─────────────────────────────────────────────────────

/**
 * Check that a payment amount does not exceed the configured spending limit.
 * Called before delegating to StellarPaymentTool or X402PaymentTool.
 */
function assertWithinSpendingLimit(amount: unknown): void {
  if (typeof amount !== "string") return; // let the tool's own schema catch this
  const parsed = parseFloat(amount);
  const limit  = parseFloat(config.AGENT_SPENDING_LIMIT);
  if (!isNaN(parsed) && parsed > limit) {
    throw new Error(
      `Payment amount ${amount} ${config.X402_ASSET_CODE} exceeds ` +
      `AGENT_SPENDING_LIMIT of ${config.AGENT_SPENDING_LIMIT}`
    );
  }
  if (!isNaN(parsed) && config.STELLAR_NETWORK === "mainnet" && parsed > MAINNET_SPENDING_CAP) {
    throw new Error(
      `Payment amount ${amount} ${config.X402_ASSET_CODE} exceeds ` +
      `mainnet spending cap of ${MAINNET_SPENDING_CAP}`
    );
  }
}

// ─── Agent ────────────────────────────────────────────────────────────────────

export class PayFiAgent extends EventEmitter {
  private paymentTool: StellarPaymentTool;
  private sorobanTool: SorobanInvokeTool;
  private x402Tool: X402PaymentTool;

  private activeTasks = 0;
  private isDraining = false;

  // Bound handler references kept so destroy() can call .off() with the exact same function
  // reference — EventEmitter requires identity equality for removal.
  private readonly _boundHandlers = new Map<string, (...args: unknown[]) => void>();

  constructor() {
    super();

    // config.agentKeypair().secret() is the canonical way to obtain the signing secret.
    // Direct access to config.AGENT_SECRET_KEY is intentionally blocked by the AgentConfig
    // type (Omit<RawEnv, "AGENT_SECRET_KEY">); using agentKeypair() makes the access explicit.
    this.paymentTool = new StellarPaymentTool(config.agentKeypair().secret());
    this.sorobanTool = new SorobanInvokeTool(config.agentKeypair().secret());
    this.x402Tool    = new X402PaymentTool(config.agentKeypair().secret());

    // ── Register event listeners — every registration is mirrored in destroy() ──
    const onError = (err: Error) => {
      const safe = err.message.replace(/S[A-Z2-7]{55}/g, "[REDACTED]");
      log.error({ msg: "Unhandled agent error", error: safe });
    };
    const onTaskComplete = (result: AgentResult) => {
      log.info({ msg: "Task complete event", taskType: result.taskType });
    };
    const onTaskFailed = (result: AgentResult) => {
      log.warn({ msg: "Task failed event", taskType: result.taskType, error: result.error });
    };

    this.on("error", onError);
    this.on("task:complete", onTaskComplete);
    this.on("task:failed", onTaskFailed);

    this._boundHandlers.set("error", onError as (...args: unknown[]) => void);
    this._boundHandlers.set("task:complete", onTaskComplete as (...args: unknown[]) => void);
    this._boundHandlers.set("task:failed", onTaskFailed as (...args: unknown[]) => void);

    log.info({
      msg: "PayFiAgent initialised",
      network: config.STELLAR_NETWORK,
      horizon: config.HORIZON_URL,
      soroban: config.SOROBAN_RPC_URL,
      agentPubkey: config.AGENT_PUBLIC_KEY,
      spendingLimit: `${config.AGENT_SPENDING_LIMIT} ${config.X402_ASSET_CODE}`,
    });
  }

  /**
   * Detach all registered event listeners and release internal resources.
   *
   * Must be called by the lifecycle manager when an agent instance is
   * decommissioned or stopped. Failure to call destroy() prevents the garbage
   * collector from reclaiming this instance because EventEmitter holds a strong
   * reference to every registered callback closure.
   *
   * Usage:
   *   const agent = new PayFiAgent();
   *   // ... use agent ...
   *   agent.destroy(); // call when decommissioning
   */
  destroy(): void {
    for (const [event, handler] of this._boundHandlers) {
      this.off(event, handler);
    }
    this._boundHandlers.clear();
    // Remove any listeners added externally after construction
    this.removeAllListeners();
    log.info({ msg: "PayFiAgent destroyed — all event listeners removed" });
  }

  drain(): void {
    this.isDraining = true;
    log.info({ msg: "PayFiAgent draining — rejecting new tasks" });
  }

  async waitForPendingTasks(): Promise<void> {
    if (this.activeTasks === 0) return;
    log.info({ msg: "Waiting for pending tasks to finish", activeTasks: this.activeTasks });
    return new Promise<void>((resolve) => {
      const interval = setInterval(() => {
        if (this.activeTasks === 0) {
          clearInterval(interval);
          resolve();
        }
      }, 100);
    });
  }

  /** Dispatch a task to the correct tool */
  async run(task: AgentTask): Promise<AgentResult> {
    if (this.isDraining) {
      return {
        success: false,
        taskType: task.type,
        error: "Agent is shutting down — task rejected",
      };
    }

    this.activeTasks++;
    const correlationId = generateCorrelationId();
    const taskLog = createLogger("orchestrator", correlationId);
    taskLog.info({ msg: "Running task", taskType: task.type });
    try {
      let data: unknown;

      switch (task.type) {
        case "stellar_payment": {
          const p = task.payload as Record<string, unknown>;
          assertWithinSpendingLimit(p?.amount);
          data = await this.paymentTool.execute(task.payload);
          break;
        }

        case "soroban_invoke":
          data = await this.sorobanTool.execute(task.payload);
          break;

        case "x402_respond": {
          const p = task.payload as Record<string, unknown>;
          assertWithinSpendingLimit(p?.amount);
          data = await this.x402Tool.respond(task.payload);
          break;
        }

        default:
          throw new Error(`Unknown task type: ${(task as AgentTask).type}`);
      }

      taskLog.info({ msg: "Task completed", taskType: task.type });
      const result: AgentResult = { success: true, taskType: task.type, data };
      this.emit("task:complete", result);
      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // Redact anything that looks like a secret key before logging
      const safe = message.replace(/S[A-Z2-7]{55}/g, "[REDACTED]");
      taskLog.error({ msg: "Task failed", taskType: task.type, error: safe });
      const result: AgentResult = { success: false, taskType: task.type, error: safe };
      this.emit("task:failed", result);
      return result;
    } finally {
      this.activeTasks--;
    }
  }
}
