import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest(async () => ({
      miniflare: {
        compatibilityDate: "2026-06-22",
        compatibilityFlags: ["nodejs_compat"],
        d1Databases: ["DB", "LEGACY_DB"],
        bindings: {
          SESSION_SECRET: "workers-test-session-secret",
          TEST_MIGRATIONS: await readD1Migrations(new URL("./migrations", import.meta.url).pathname)
        }
      }
    }))
  ],
  test: {
    include: ["tests-workers/**/*.test.ts"],
    setupFiles: ["./tests-workers/setup.ts"],
    clearMocks: true,
    restoreMocks: true
  }
});
