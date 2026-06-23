/**
 * backend/tools/SorobanInvokeTool.ts
 * Standalone tool: invoke any Soroban smart contract function.
 *
 * MANDATORY simulation step enforced before any broadcast.
 */

import {
  Keypair,
  Networks,
  TransactionBuilder,
  Operation,
  Contract,
  BASE_FEE,
  nativeToScVal,
  xdr,
} from "@stellar/stellar-sdk";
import { z } from "zod";
import { config } from "../config";
import { loadAccount, prepareSorobanTx, sorobanServer } from "../rpc_client";

// ─── Input schema ─────────────────────────────────────────────────────────────

/**
 * Zod schema for {@link SorobanInvokeTool.execute} inputs.
 *
 * @example
 * ```ts
 * const input: SorobanInvokeInput = {
 *   contractId: "CAAAA...56-char-id",
 *   method: "transfer",
 *   args: [nativeToScVal(recipient, { type: "address" }), nativeToScVal(100n, { type: "i128" })],
 *   simulateOnly: false,
 * };
 * ```
 */
export const SorobanInvokeInputSchema = z.object({
  /** 56-character Stellar contract address (strkey C… encoding). */
  contractId: z.string().length(56, "Invalid Stellar contract ID"),

  /** Name of the contract function to invoke (e.g. `"transfer"`, `"mint"`). */
  method: z.string().min(1),

  /**
   * Positional XDR arguments passed to the contract function, in declaration order.
   *
   * Each element must be an {@link xdr.ScVal} instance. Use the Stellar SDK helper
   * {@link nativeToScVal} to convert JavaScript primitives to the correct XDR type:
   *
   * ```ts
   * import { nativeToScVal } from "@stellar/stellar-sdk";
   *
   * const args = [
   *   nativeToScVal("GABC…", { type: "address" }),  // Address
   *   nativeToScVal(500n,     { type: "i128" }),     // i128 integer
   *   nativeToScVal(true,     { type: "bool" }),     // Boolean
   * ];
   * ```
   *
   * Defaults to an empty array when no arguments are required.
   */
  args: z.array(z.instanceof(xdr.ScVal)).default([]),

  /**
   * When `true`, the transaction is simulated via Soroban RPC but **never broadcast**.
   * The returned object will contain `simulationResult` instead of `txHash`.
   *
   * Use this for dry-runs, fee estimation, or validating contract logic without
   * consuming network resources or altering on-chain state.
   *
   * @defaultValue `false`
   */
  simulateOnly: z.boolean().default(false),
});

export type SorobanInvokeInput = z.infer<typeof SorobanInvokeInputSchema>;

// ─── Tool implementation ──────────────────────────────────────────────────────

export class SorobanInvokeTool {
  private keypair: Keypair;
  private networkPassphrase: string;

  constructor(secretKey: string = config.AGENT_SECRET_KEY) {
    this.keypair = Keypair.fromSecret(secretKey);
    this.networkPassphrase =
      config.STELLAR_NETWORK === "mainnet"
        ? Networks.PUBLIC
        : config.STELLAR_NETWORK === "futurenet"
        ? Networks.FUTURENET
        : Networks.TESTNET;
  }

  /**
   * Invoke a Soroban smart contract function.
   *
   * Every call **always** runs a mandatory simulation step via
   * {@link prepareSorobanTx} before any broadcast attempt. The simulation both
   * validates the transaction and attaches the required Soroban resource footprint.
   *
   * ### Return shape — driven by `simulateOnly`
   *
   * The return type is polymorphic based on the `simulateOnly` flag in the parsed
   * input. Callers **must** check which key is present before accessing the result:
   *
   * | `simulateOnly` | Returned key       | Value type  | Description                          |
   * |----------------|--------------------|-------------|--------------------------------------|
   * | `false`        | `txHash`           | `string`    | Hex hash of the confirmed transaction |
   * | `true`         | `simulationResult` | `Transaction` (prepared) | Simulation-only — not broadcast |
   *
   * @example Broadcast (simulateOnly = false)
   * ```ts
   * const { txHash } = await tool.execute({ contractId, method, args, simulateOnly: false });
   * console.log("Confirmed:", txHash);
   * ```
   *
   * @example Dry-run (simulateOnly = true)
   * ```ts
   * const { simulationResult } = await tool.execute({ contractId, method, args, simulateOnly: true });
   * console.log("Simulation passed, prepared tx:", simulationResult);
   * ```
   *
   * @param rawInput - Raw (unvalidated) input object; parsed and typed via
   *   {@link SorobanInvokeInputSchema} internally.
   * @returns `{ txHash: string }` on broadcast success, or
   *   `{ simulationResult: unknown }` on dry-run.
   * @throws {Error} If simulation fails, the network rejects the submission
   *   (`status === "ERROR"`), or the transaction does not reach a terminal state
   *   within the polling window.
   */
  async execute(
    rawInput: unknown
  ): Promise<{ txHash?: string; simulationResult?: unknown }> {
    const input = SorobanInvokeInputSchema.parse(rawInput);

    // 1. Resolve contract
    const contract = new Contract(input.contractId);

    // 2. Load source account
    const sourceAccount = await loadAccount(this.keypair.publicKey());

    // 3. Build invocation transaction
    const tx = new TransactionBuilder(sourceAccount, {
      fee: BASE_FEE,
      networkPassphrase: this.networkPassphrase,
    })
      .addOperation(contract.call(input.method, ...input.args))
      .setTimeout(30)
      .build();

    console.log(`🔍 [SorobanInvokeTool] Simulating ${input.method} on ${input.contractId}...`);

    // 4. MANDATORY simulate step — throws on simulation failure
    const preparedTx = await prepareSorobanTx(tx);

    if (input.simulateOnly) {
      console.log(`✅ [SorobanInvokeTool] Simulation passed (dry-run, not broadcasting).`);
      return { simulationResult: preparedTx };
    }

    // 5. Sign prepared transaction
    preparedTx.sign(this.keypair);

    // 6. Submit
    const result = await sorobanServer.sendTransaction(preparedTx);

    if (result.status === "ERROR") {
      throw new Error(`Soroban submit failed: ${result.errorResult?.toXDR("base64")}`);
    }

    // 7. Poll for confirmation
    const confirmed = await this.pollForConfirmation(result.hash);
    return { txHash: confirmed.txHash };
  }

  /**
   * Poll Soroban RPC until the transaction reaches a terminal state.
   *
   * Implements a simple fixed-interval polling loop that drives the following
   * state machine transitions:
   *
   * ```
   * NOT_FOUND ──(each attempt)──► NOT_FOUND   (keep polling)
   *                            └─► SUCCESS    (return txHash) ✅
   *                            └─► FAILED     (throw Error)   ❌
   * ```
   *
   * The loop exits early on `SUCCESS` or `FAILED`. If neither terminal state is
   * reached within `maxAttempts` iterations, an error is thrown.
   *
   * @private
   * @param hash - Transaction hash returned by `sendTransaction`.
   * @param maxAttempts - Maximum number of polling iterations before timing out.
   *   Each attempt waits `intervalMs` milliseconds. Defaults to `10`.
   * @param intervalMs - Delay in milliseconds between each polling attempt.
   *   Defaults to `2000` (2 seconds), giving a default window of ~20 seconds.
   * @returns Resolves with `{ txHash }` when the transaction is confirmed on-chain.
   * @throws {Error} If the transaction status is `FAILED` or the polling window
   *   is exhausted without reaching a terminal state.
   */
  private async pollForConfirmation(
    hash: string,
    maxAttempts = 10,
    intervalMs = 2000
  ): Promise<{ txHash: string }> {
    for (let i = 0; i < maxAttempts; i++) {
      await new Promise((r) => setTimeout(r, intervalMs));
      const status = await sorobanServer.getTransaction(hash);

      if (status.status === "SUCCESS") {
        console.log(`✅ [SorobanInvokeTool] Transaction confirmed: ${hash}`);
        return { txHash: hash };
      }
      if (status.status === "FAILED") {
        throw new Error(`Soroban transaction failed on-chain: ${hash}`);
      }
      console.log(`⏳ [SorobanInvokeTool] Polling... attempt ${i + 1}/${maxAttempts}`);
    }
    throw new Error(`Soroban transaction not confirmed within polling window: ${hash}`);
  }
}
