/**
 * tests/soroban_invoke.test.ts
 *
 * Comprehensive test suite for SorobanInvokeTool.
 * Covers: simulation gate, happy path, ERROR/FAILED status handling,
 * polling timeout, invalid inputs, and dry-run mode.
 *
 * ## Mock Architecture
 *
 * This suite uses vi.mock() at the module level to mock two critical dependencies:
 *
 * 1. **rpcClient**: The RPC abstraction layer that communicates with Horizon and Soroban.
 *    - Allows us to test SorobanInvokeTool in complete isolation from network calls.
 *    - Each test configures the mock's return values to simulate different network scenarios
 *      (SUCCESS, FAILED, NOT_FOUND, ERROR statuses, timeouts, etc.).
 *    - The mock is cleared before each test via vi.clearAllMocks() (from vitest.config.ts).
 *
 * 2. **config**: The environment configuration (network URLs, agent keypair, thresholds).
 *    - Mocked to return predictable, test-friendly values.
 *    - Prevents the test from requiring actual environment variables or .env files.
 *
 * ## Why isolate: true Matters Here
 *
 * With vitest.config.ts set to isolate: true, each test file gets its own V8 context:
 * - Mock definitions (vi.mock()) apply only to this test file.
 * - Other test files can mock the same modules differently without interference.
 * - Global state (vi.clearAllMocks(), test instance) is not shared between files.
 *
 * Example: If balance_check.test.ts also mocks rpcClient, it won't affect this file's mocks.
 */
export {};
//# sourceMappingURL=soroban_invoke.test.d.ts.map