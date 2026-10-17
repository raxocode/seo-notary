import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const alias = { "seo-notary-core": fileURLToPath(new URL("./packages/core/src/index.ts", import.meta.url)) };

export default defineConfig({
  resolve: { alias },
  test: {
    projects: [
      {
        extends: true,
        test: {
          name: "unit",
          include: ["packages/*/test/**/*.test.ts", "tests/integration/**/*.test.ts"],
          exclude: ["packages/browser/test/**"],
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
          include: ["packages/browser/test/**/*.test.ts"],
          testTimeout: 60_000,
          hookTimeout: 60_000,
          fileParallelism: false,
        },
      },
    ],
  },
});
