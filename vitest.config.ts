import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const alias = {
  "seo-notary-core": fileURLToPath(new URL("./packages/core/src/index.ts", import.meta.url)),
  "seo-notary-browser": fileURLToPath(new URL("./packages/browser/src/index.ts", import.meta.url)),
};

export default defineConfig({
  resolve: { alias },
  test: {
    projects: [
      {
        extends: true,
        test: {
          name: "unit",
          include: ["packages/*/test/**/*.test.ts", "tests/integration/**/*.test.ts"],
          exclude: ["packages/browser/test/**", "**/*.browser.test.ts"],
          testTimeout: 15_000,
        },
      },
      {
        extends: true,
        test: {
          name: "security",
          include: ["tests/security/**/*.test.ts"],
          testTimeout: 15_000,
        },
      },
      {
        extends: true,
        test: {
          name: "browser",
          include: ["packages/browser/test/**/*.test.ts", "packages/*/test/**/*.browser.test.ts", "demo/**/*.browser.test.ts"],
          testTimeout: 60_000,
          hookTimeout: 60_000,
          fileParallelism: false,
        },
      },
      {
        extends: true,
        test: {
          name: "smoke",
          include: ["tests/smoke/**/*.test.ts"],
          testTimeout: 240_000,
          hookTimeout: 240_000,
        },
      },
    ],
  },
});
