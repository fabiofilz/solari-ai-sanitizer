import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/unit/**/*.test.ts", "tests/contract/**/*.test.ts"],
    exclude: ["tests/integration/**", "node_modules/**", "dist/**"],
    environment: "node",
    globals: false,
    reporters: ["default"],
    testTimeout: 10_000,
  },
});
