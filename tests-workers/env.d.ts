/// <reference types="@cloudflare/vitest-pool-workers/types" />

import type { D1Migration } from "cloudflare:test";

declare global {
  namespace Cloudflare {
    interface Env {
      DB: D1Database;
      LEGACY_DB: D1Database;
      SESSION_SECRET: string;
      TEST_MIGRATIONS: D1Migration[];
    }
  }
}

export {};
