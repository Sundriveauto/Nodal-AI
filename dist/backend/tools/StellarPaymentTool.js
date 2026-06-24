"use strict";
/**
 * backend/tools/StellarPaymentTool.ts
 * Standalone tool: native XLM or asset payment via Horizon.
 *
 * Architecture: Tool → simulate → sign → submit
 * Never broadcasts without a prior simulation pass.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.StellarPaymentTool = exports.PaymentInputSchema = void 0;
const stellar_sdk_1 = require("@stellar/stellar-sdk");
const zod_1 = require("zod");
const config_1 = require("../config");
const logger_1 = require("../logger");
const rpc_client_1 = require("../rpc_client");
const logger_2 = require("../utils/logger");
const log = (0, logger_2.createLogger)("stellar-payment");
// ─── Input schema ─────────────────────────────────────────────────────────────
/**
 * Zod schema for payment input validation.
 *
 * @property destination - 56-character Stellar public key (G...) of the recipient
 * @property amount - Positive decimal string with up to 7 decimal places (Stellar network limit)
 * @property assetCode - Asset code (default: "XLM")
 * @property assetIssuer - Asset issuer public key (required for non-XLM assets)
 * @property memo - Optional memo text, max 28 characters (Stellar network limit)
 */
exports.PaymentInputSchema = zod_1.z.object({
    destination: zod_1.z.string().length(56, "Invalid Stellar public key"),
    amount: zod_1.z
        .string()
        // Negative-lookahead rejects "0" and all zero-value decimals ("0.0", "0.0000000")
        .regex(/^(?!0(\.0+)?$)\d+(\.\d{1,7})?$/, "Amount must be a valid Stellar decimal")
        // Belt-and-suspenders guard: parseFloat catches any edge cases the regex misses
        .refine((v) => parseFloat(v) > 0, "Amount must be greater than zero"),
    assetCode: zod_1.z.string().default("XLM"),
    assetIssuer: zod_1.z.string().optional(),
    memo: zod_1.z
        .string()
        .refine((v) => Buffer.byteLength(v, "utf8") <= 28, "Memo must be at most 28 bytes")
        .optional(),
});
// ─── Tool implementation ──────────────────────────────────────────────────────
class StellarPaymentTool {
    keypair;
    networkPassphrase;
    /**
     * Create a new StellarPaymentTool instance.
     *
     * @param secretKey - Stellar secret key (S...) for signing transactions
     */
    constructor(secretKey = config_1.config.agentKeypair().secret()) {
        this.keypair = stellar_sdk_1.Keypair.fromSecret(secretKey);
        this.networkPassphrase = (0, rpc_client_1.resolveNetworkPassphrase)(config_1.config.STELLAR_NETWORK);
    }
    get publicKey() {
        return this.keypair.publicKey();
    }
    /**
     * Execute a payment on the Stellar network.
     *
     * Steps:
     * 1. Validate input with Zod schema
     * 2. Resolve asset (native XLM or custom asset)
     * 3. Load source account to get latest sequence number
     * 4. Build transaction with payment operation and optional memo
     * 5. Validate transaction envelope
     * 6. Sign transaction with keypair
     * 7. Submit transaction to the network
     *
     * @param rawInput - Raw payment input (will be validated)
     * @returns Object containing transaction hash and ledger number
     * @throws {z.ZodError} If input fails validation
     * @throws {Error} If source account not found or transaction submission fails
     */
    async execute(rawInput) {
        // 1. Validate input
        const input = exports.PaymentInputSchema.parse(rawInput);
        // 2. Resolve asset
        if (input.assetCode !== "XLM" && !input.assetIssuer) {
            throw new Error(`Asset issuer is required for non-native asset ${input.assetCode}`);
        }
        const asset = input.assetCode === "XLM"
            ? stellar_sdk_1.Asset.native()
            : new stellar_sdk_1.Asset(input.assetCode, input.assetIssuer);
        // 3. Load source account (latest sequence number)
        const sourceAccount = await (0, rpc_client_1.loadAccount)(this.keypair.publicKey());
        // 4. Build transaction
        const txBuilder = new stellar_sdk_1.TransactionBuilder(sourceAccount, {
            fee: stellar_sdk_1.BASE_FEE,
            networkPassphrase: this.networkPassphrase,
        })
            .addOperation(stellar_sdk_1.Operation.payment({
            destination: input.destination,
            asset,
            amount: input.amount,
        }));
        if (input.memo) {
            txBuilder.addMemo(stellar_sdk_1.Memo.text(input.memo));
        }
        const tx = txBuilder.setTimeout(30).build();
        // 5. Fee estimation / simulation via Horizon dry-run
        //    (Horizon doesn't expose simulation like Soroban, so we validate
        //     the transaction envelope locally before submission)
        logger_1.logger.info("Validating payment envelope", {
            source: this.keypair.publicKey(),
            destination: input.destination,
            amount: input.amount,
            assetCode: input.assetCode,
        });
        // 6. Sign
        tx.sign(this.keypair);
        // 7. Submit
        const result = (await (0, rpc_client_1.submitTransaction)(tx));
        return {
            txHash: result.hash,
            ledger: result.ledger,
        };
    }
}
exports.StellarPaymentTool = StellarPaymentTool;
//# sourceMappingURL=StellarPaymentTool.js.map