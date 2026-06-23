/**
 * tests/soroban_invoke.test.ts
 *
 * Comprehensive test suite for SorobanInvokeTool.
 * Covers: simulation gate, happy path, ERROR/FAILED status handling,
 * polling timeout, invalid inputs, and dry-run mode.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { SorobanInvokeTool } from "../backend/tools/SorobanInvokeTool";
import * as rpcClient from "../backend/rpc_client";

// ─── Module mock ──────────────────────────────────────────────────────────────

vi.mock("../backend/rpc_client", () => ({
  loadAccount: vi.fn(),
  submitTransaction: vi.fn(),
  simulateSorobanTx: vi.fn(),
  prepareSorobanTx: vi.fn(),
  horizonServer: {},
  sorobanServer: {
    sendTransaction: vi.fn(),
    getTransaction: vi.fn(),
  },
}));

vi.mock("../backend/config", () => ({
  config: {
    STELLAR_NETWORK: "testnet",
    HORIZON_URL: "https://horizon-testnet.stellar.org",
    SOROBAN_RPC_URL: "https://soroban-testnet.stellar.org",
    AGENT_SECRET_KEY: "SBPTNBEQQVQD5NIPZTCXHKM5ZVONK2ENLP5DTZJBGSUPOPWQSIFWZKX",
    X402_ASSET_CODE: "USDC",
    X402_ASSET_ISSUER: "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
    MAX_RETRIES: 3,
    RETRY_DELAY_MS: 100,
  },
}));

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const TEST_SECRET    = "SBPTNBEQQVQD5NIPZTCXHKM5ZVONK2ENLP5DTZJBGSUPOPWQSIFWZKX";
const VALID_CONTRACT = "CBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";

function makeMockAccount(publicKey: string) {
  return {
    id: publicKey,
    accountId: () => publicKey,
    sequenceNumber: () => "100",
    incrementSequenceNumber: vi.fn(),
    sequence: "100",
    incrementedSequenceNumber: () => "101",
    thresholds: { low_threshold: 0, med_threshold: 0, high_threshold: 0 },
    flags: { auth_required: false, auth_revocable: false, auth_immutable: false },
    balances: [],
    signers: [],
    data_attr: {},
    subentry_count: 0,
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("SorobanInvokeTool", () => {
  let tool: SorobanInvokeTool;

  beforeEach(() => {
    vi.clearAllMocks();
    tool = new SorobanInvokeTool(TEST_SECRET);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── Input validation ────────────────────────────────────────────────────────

  describe("Input validation", () => {
    it("rejects a contractId that is too short", async () => {
      await expect(
        tool.execute({ contractId: "bad_id", method: "release", args: [] })
      ).rejects.toThrow(/Invalid Stellar contract ID/);
    });

    it("rejects a contractId that is too long (57 chars)", async () => {
      await expect(
        tool.execute({ contractId: "C".padEnd(57, "A"), method: "release", args: [] })
      ).rejects.toThrow(/Invalid Stellar contract ID/);
    });

    it("rejects an empty method name", async () => {
      await expect(
        tool.execute({ contractId: VALID_CONTRACT, method: "", args: [] })
      ).rejects.toThrow();
    });

    it("rejects missing contractId", async () => {
      await expect(
        tool.execute({ method: "release", args: [] })
      ).rejects.toThrow();
    });
  });

  // ── Simulation gate (mandatory) ─────────────────────────────────────────────

  describe("Simulation gate", () => {
    beforeEach(() => {
      vi.mocked(rpcClient.loadAccount).mockResolvedValue(
        makeMockAccount("GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5") as any
      );
    });

    it("calls prepareSorobanTx before any submission", async () => {
      vi.mocked(rpcClient.prepareSorobanTx).mockResolvedValue({ sign: vi.fn() } as any);
      vi.mocked(rpcClient.sorobanServer.sendTransaction as any).mockResolvedValue({
        status: "PENDING",
        hash: "sim_test_hash",
      });
      vi.mocked(rpcClient.sorobanServer.getTransaction as any).mockResolvedValue({
        status: "SUCCESS",
      });

      await tool.execute({ contractId: VALID_CONTRACT, method: "release", args: [] });

      expect(rpcClient.prepareSorobanTx).toHaveBeenCalledOnce();
    });

    it("throws and does NOT submit when simulation fails", async () => {
      vi.mocked(rpcClient.prepareSorobanTx).mockRejectedValue(
        new Error("Soroban simulation failed: insufficient balance")
      );

      await expect(
        tool.execute({ contractId: VALID_CONTRACT, method: "release", args: [] })
      ).rejects.toThrow(/simulation failed/);

      expect(rpcClient.sorobanServer.sendTransaction).not.toHaveBeenCalled();
    });

    it("throws when simulation fails with contract error code", async () => {
      vi.mocked(rpcClient.prepareSorobanTx).mockRejectedValue(
        new Error("Soroban simulation failed: Error(Contract, #3)")
      );

      await expect(
        tool.execute({ contractId: VALID_CONTRACT, method: "release", args: [] })
      ).rejects.toThrow(/simulation failed/);
    });

    it("does NOT call sendTransaction when simulateOnly=true", async () => {
      vi.mocked(rpcClient.prepareSorobanTx).mockResolvedValue({ sign: vi.fn() } as any);

      const result = await tool.execute({
        contractId: VALID_CONTRACT,
        method: "release",
        args: [],
        simulateOnly: true,
      });

      expect(rpcClient.sorobanServer.sendTransaction).not.toHaveBeenCalled();
      expect(result.simulationResult).toBeDefined();
    });
  });

  // ── Submission and confirmation polling ─────────────────────────────────────

  describe("Submission and confirmation polling", () => {
    beforeEach(() => {
      vi.mocked(rpcClient.loadAccount).mockResolvedValue(
        makeMockAccount("GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5") as any
      );
      vi.mocked(rpcClient.prepareSorobanTx).mockResolvedValue({ sign: vi.fn() } as any);
    });

    it("returns txHash after a successful confirmation on first poll", async () => {
      vi.mocked(rpcClient.sorobanServer.sendTransaction as any).mockResolvedValue({
        status: "PENDING",
        hash: "confirmed_hash",
      });
      vi.mocked(rpcClient.sorobanServer.getTransaction as any).mockResolvedValue({
        status: "SUCCESS",
      });

      const result = await tool.execute({
        contractId: VALID_CONTRACT,
        method: "release",
        args: [],
      });

      expect(result.txHash).toBe("confirmed_hash");
    });

    it("polls multiple times before SUCCESS", async () => {
      vi.mocked(rpcClient.sorobanServer.sendTransaction as any).mockResolvedValue({
        status: "PENDING",
        hash: "slow_confirm_hash",
      });
      vi.mocked(rpcClient.sorobanServer.getTransaction as any)
        .mockResolvedValueOnce({ status: "NOT_FOUND" })
        .mockResolvedValueOnce({ status: "NOT_FOUND" })
        .mockResolvedValueOnce({ status: "SUCCESS" });

      const result = await tool.execute({
        contractId: VALID_CONTRACT,
        method: "release",
        args: [],
      });

      expect(result.txHash).toBe("slow_confirm_hash");
      expect(rpcClient.sorobanServer.getTransaction).toHaveBeenCalledTimes(3);
    });

    it("throws when on-chain status is FAILED", async () => {
      vi.mocked(rpcClient.sorobanServer.sendTransaction as any).mockResolvedValue({
        status: "PENDING",
        hash: "failed_on_chain_hash",
      });
      vi.mocked(rpcClient.sorobanServer.getTransaction as any).mockResolvedValue({
        status: "FAILED",
      });

      await expect(
        tool.execute({ contractId: VALID_CONTRACT, method: "release", args: [] })
      ).rejects.toThrow(/failed on-chain/);
    });

    it("throws when sendTransaction returns ERROR status", async () => {
      vi.mocked(rpcClient.sorobanServer.sendTransaction as any).mockResolvedValue({
        status: "ERROR",
        errorResult: { toXDR: () => "base64_error_xdr" },
        hash: "error_hash",
      });

      await expect(
        tool.execute({ contractId: VALID_CONTRACT, method: "release", args: [] })
      ).rejects.toThrow(/Soroban submit failed/);
    });

    it("throws when polling window is exhausted (timeout)", async () => {
      vi.mocked(rpcClient.sorobanServer.sendTransaction as any).mockResolvedValue({
        status: "PENDING",
        hash: "never_confirms_hash",
      });
      // Always return NOT_FOUND — simulates a stalled transaction
      vi.mocked(rpcClient.sorobanServer.getTransaction as any).mockResolvedValue({
        status: "NOT_FOUND",
      });

      await expect(
        tool.execute({ contractId: VALID_CONTRACT, method: "release", args: [] })
      ).rejects.toThrow(/not confirmed within polling window/);
    }, 5_000); // RETRY_DELAY_MS=100 → intervalMs=200ms × 10 attempts ≈ 2s
  });

  // ── Network error handling ──────────────────────────────────────────────────

  describe("Network error handling", () => {
    beforeEach(() => {
      vi.mocked(rpcClient.loadAccount).mockResolvedValue(
        makeMockAccount("GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5") as any
      );
    });

    it("propagates network timeout on prepareSorobanTx", async () => {
      vi.mocked(rpcClient.prepareSorobanTx).mockRejectedValue(
        new Error("ECONNABORTED: network timeout")
      );

      await expect(
        tool.execute({ contractId: VALID_CONTRACT, method: "release", args: [] })
      ).rejects.toThrow(/timeout/);
    });

    it("propagates account load failure", async () => {
      vi.mocked(rpcClient.loadAccount).mockRejectedValue(
        new Error("Horizon: account not found (404)")
      );

      await expect(
        tool.execute({ contractId: VALID_CONTRACT, method: "release", args: [] })
      ).rejects.toThrow(/not found/);
    });
  });
});
