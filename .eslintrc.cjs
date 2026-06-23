
module.exports = {
  parser: "@typescript-eslint/parser",
  plugins: ["@typescript-eslint"],
  extends: [
    "eslint:recommended",
    "plugin:@typescript-eslint/recommended",
  ],
  env: { node: true, es2022: true },

  rules: {
    "@typescript-eslint/no-explicit-any": "warn",
    "@typescript-eslint/no-unused-vars": ["warn", { argsIgnorePattern: "^_" }],
  },

  overrides: [
    {
      files: [
        "backend/agent.ts",
        "backend/tools/**/*.ts",
      ],

      // Environment variables must be accessed through backend/config.ts
      // so they pass Zod validation and secret-redaction logic.
      rules: {
        "no-restricted-properties": [
          "error",
          {
            object: "process",
            property: "env",
            message:
              "Do not access process.env directly. Use backend/config.ts instead.",
          },
        ],
      },
    },
  ],
};