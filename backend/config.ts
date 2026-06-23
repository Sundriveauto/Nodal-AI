/**
 * backend/config.ts
 *
 * Production-grade, schema-validated configuration layer.
 *
 * Security guarantees:
 *   - AGENT_SECRET_KEY is NEVER included in error messages or logs.
 *   - AGENT_PUBLIC_KEY is derived from the secret key at startup;
 *     only the public key is exposed on the config object.
 *   - Invalid env causes an informative error + process.exit(1)
 *     before any network or tool code runs.
 *
 * Usage:
 *   import { config } from "./config";
 *   config.HORIZON_URL          // validated URL string
 *   config.AGENT_PUBLIC_KEY     // derived G-address, safe to log
 *   config.agentKeypair()       // call-site requests the Keypair explicitly
 */

import { z } from "zod";
import * as dotenv from "dotenv";
import { Keypair } from "@stellar/stellar-sdk";

// Load .env file (no-op when running in CI / production with real env vars)
dotenv.config();

// ─── Custom Zod refinements ───────────────────────────────────────────────────

/**
 * Validates a Stellar secret key (S…, 56 chars, base32).
 * The key itself is NEVER surfaced in Zod error messages —
 * we only report structural problems.
 */
const StellarSecretKeySchema = z
  .string()
  .refine(
    (val) => {
      try {
        Keypair.fromSecret(val);
        return true;
      } catch {
        return false;
      }
    },
    // Generic message — does not echo the value
    { message: "AGENT_SECRET_KEY is not a valid Stellar secret key (must start with S and be 56 chars)" }
  );

/**
 * Stellar public key — 56-char G-address.
 * Optional: when absent it is derived from AGENT_SECRET_KEY.
 */
const StellarPublicKeySchema = z
  .string()
  .length(56, "Must be a 56-character Stellar public key (G…)")
  .refine((val) => val.startsWith("G"), { message: "Public key must start with G" })
  .optional();

/**
 * Spending limit: a positive decimal with up to 7 decimal places.
 * "0" is not permitted — agents must have a non-zero spending cap.
 */
const SpendingLimitSchema = z
  .string()
  .regex(
    /^[1-9]\d*(\.\d{1,7})?$/,
    "AGENT_SPENDING_LIMIT must be a positive decimal (e.g. '100' or '50.0000000')"
  )
  .default("100");

// ─── Raw environment schema ───────────────────────────────────────────────────

const EnvSchema = z.object({
  // Network
  STELLAR_NETWORK: z
    .enum(["testnet", "mainnet", "futurenet"], {
      errorMap: () => ({
        message: "STELLAR_NETWORK must be one of: testnet | mainnet | futurenet",
      }),
    })
    .default("testnet"),

  // RPC endpoints
  HORIZON_URL: z
    .string({ required_error: "HORIZON_URL is required" })
    .url("HORIZON_URL must be a valid URL (e.g. https://horizon-testnet.stellar.org)"),

  SOROBAN_RPC_URL: z
    .string({ required_error: "SOROBAN_RPC_URL is required" })
    .url("SOROBAN_RPC_URL must be a valid URL (e.g. https://soroban-testnet.stellar.org)"),

  // Agent identity
  AGENT_SECRET_KEY: StellarSecretKeySchema,
  AGENT_PUBLIC_KEY: StellarPublicKeySchema,

  // x402 / PayFi asset
  X402_ASSET_CODE: z.string().min(1).max(12).default("USDC"),
  X402_ASSET_ISSUER: z
    .string({ required_error: "X402_ASSET_ISSUER is required" })
    .length(56, "X402_ASSET_ISSUER must be a 56-character Stellar address"),

  // Spending cap
  AGENT_SPENDING_LIMIT: SpendingLimitSchema,

  // Retry behaviour
  // Exponential back-off: delay = RETRY_DELAY_MS * 2^(attempt-1), capped at 30 000 ms,
  // plus ±20% random jitter. Example — MAX_RETRIES=3, RETRY_DELAY_MS=1500 →
  // delays [1500, 3000, 6000] ms (before jitter), not linear [1500, 3000, 4500].
  MAX_RETRIES: z.coerce
    .number()
    .int()
    .min(1)
    .max(10)
    .default(3),

  RETRY_DELAY_MS: z.coerce
    .number()
    .int()
    .min(100)
    .default(1500),
});

type RawEnv = z.infer<typeof EnvSchema>;

// ─── Derived / enriched config type ──────────────────────────────────────────

export interface AgentConfig extends Omit<RawEnv, "AGENT_SECRET_KEY" | "AGENT_PUBLIC_KEY"> {
  /** Derived G-address — safe to log */
  readonly AGENT_PUBLIC_KEY: string;
  /**
   * Returns the agent Keypair on demand.
   * Deliberately a function so callers are explicit about accessing the secret.
   * The secret key is held in closure and never placed on the config object.
   */
  readonly agentKeypair: () => Keypair;
}

// ─── Loader ───────────────────────────────────────────────────────────────────

function formatValidationErrors(errors: z.ZodError): string {
  return errors.issues
    .map((issue) => {
      const field = issue.path.join(".") || "unknown";
      // Redact any value that looks like a secret key
      const message = issue.message.replace(/S[A-Z2-7]{55}/g, "[REDACTED]");
      return `  • ${field}: ${message}`;
    })
    .join("\n");
}

function loadConfig(): AgentConfig {
  const result = EnvSchema.safeParse(process.env);

  if (!result.success) {
    // Print structured errors — secret values are never echoed
    process.stderr.write(
      `\n❌ [Config] Invalid environment — fix the following before starting:\n` +
      formatValidationErrors(result.error) +
      `\n\nSee .env.example for reference.\n\n`
    );
    process.exit(1);
  }

  const raw: RawEnv = result.data;

  // ── Derive public key from secret ──────────────────────────────────────────
  let keypair: Keypair;
  try {
    keypair = Keypair.fromSecret(raw.AGENT_SECRET_KEY);
  } catch {
    process.stderr.write("❌ [Config] Failed to derive keypair from AGENT_SECRET_KEY.\n");
    process.exit(1);
  }

  const derivedPublicKey = keypair.publicKey();

  // If AGENT_PUBLIC_KEY was explicitly provided, cross-check it matches
  if (raw.AGENT_PUBLIC_KEY && raw.AGENT_PUBLIC_KEY !== derivedPublicKey) {
    process.stderr.write(
      `❌ [Config] AGENT_PUBLIC_KEY does not match the key derived from AGENT_SECRET_KEY.\n` +
      `   Provided : ${raw.AGENT_PUBLIC_KEY}\n` +
      `   Derived  : ${derivedPublicKey}\n`
    );
    process.exit(1);
  }

  // ── Mainnet safety guard ───────────────────────────────────────────────────
  if (raw.STELLAR_NETWORK === "mainnet") {
    const limit = parseFloat(raw.AGENT_SPENDING_LIMIT);
    if (limit > 10_000) {
      process.stderr.write(
        `❌ [Config] AGENT_SPENDING_LIMIT (${raw.AGENT_SPENDING_LIMIT}) exceeds ` +
        `the mainnet safety cap of 10,000. Lower it or explicitly override.\n`
      );
      process.exit(1);
    }
  }

  // ── Build the config object — secret key stays in closure only ────────────
  const { AGENT_SECRET_KEY: _secret, AGENT_PUBLIC_KEY: _rawPub, ...rest } = raw;

  const cfg: AgentConfig = {
    ...rest,
    AGENT_PUBLIC_KEY: derivedPublicKey,
    // Secret is captured in closure; never on the object
    agentKeypair: () => Keypair.fromSecret(_secret),
  };

  // Startup banner — only safe fields
  process.stdout.write(
    `✅ [Config] Environment validated\n` +
    `   Network        : ${cfg.STELLAR_NETWORK}\n` +
    `   Horizon        : ${cfg.HORIZON_URL}\n` +
    `   Soroban        : ${cfg.SOROBAN_RPC_URL}\n` +
    `   Agent pubkey   : ${cfg.AGENT_PUBLIC_KEY}\n` +
    `   Spending limit : ${cfg.AGENT_SPENDING_LIMIT} ${cfg.X402_ASSET_CODE}\n` +
    `   Max retries    : ${cfg.MAX_RETRIES}\n`
  );

  return cfg;
}

// ─── Singleton — validated once at import time ────────────────────────────────
export const config: AgentConfig = loadConfig();
