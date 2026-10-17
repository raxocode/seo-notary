import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "unit",
          include: ["packages/*/test/**/*.test.ts", "tests/integration/**/*.test.ts"],
          testTimeout: 15_000,
        },
      },
      {
        test: {
          name: "security",
          include: ["tests/security/**/*.test.ts"],
          testTimeout: 15_000,
        },
      },
    ],
  },
});
