import { defineConfig } from "vitest/config";

export default defineConfig({
  // Relative asset URLs so the build works from any path (static hosts, hosted previews).
  base: "./",
  worker: { format: "es" },
  test: {
    include: ["test/**/*.test.ts"],
    testTimeout: 60_000,
  },
});
