import {
  defineWorkersConfig,
  readD1Migrations,
} from "@cloudflare/vitest-pool-workers/config"

export default defineWorkersConfig(async () => ({
  test: {
    setupFiles: ["./test/setup.ts"],
    poolOptions: {
      workers: {
        wrangler: { configPath: "./wrangler.toml" },
        miniflare: {
          bindings: {
            TI_CATALOG_POPULATION_ENABLED: "true",
            TI_CLIENT_ID: "test-id",
            TI_CLIENT_SECRET: "test-secret",
            TEST_MIGRATIONS: await readD1Migrations("./migrations"),
          },
        },
      },
    },
  },
}))
