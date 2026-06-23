import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Discover all test files under tests/
    include: ["tests/**/*.test.ts"],
    // Each test file runs in its own isolated context — prevents mock bleed
    isolate: true,
    // Global test timeout (ms) — generous for polling tests
    testTimeout: 15_000,
    // Coverage configuration (used by test:ts:coverage)
    coverage: {
      provider: "v8",
      include: ["backend/**/*.ts"],
      exclude: ["backend/config.ts"], // config module is mocked in all tests
      reporter: ["text", "lcov", "html"],
      reportsDirectory: "./coverage",
    },
  },
});
