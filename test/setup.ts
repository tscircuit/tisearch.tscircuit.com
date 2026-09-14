import { applyD1Migrations, env } from "cloudflare:test"
import { beforeAll } from "vitest"
import type { D1Migration } from "@cloudflare/vitest-pool-workers/config"
import type { Env } from "../src/types"

declare module "cloudflare:test" {
  interface ProvidedEnv extends Env {
    TEST_MIGRATIONS: D1Migration[]
  }
}
beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS)
})
