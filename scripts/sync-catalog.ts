import { mkdir, readFile, writeFile, rm } from "node:fs/promises"
import { randomUUID } from "node:crypto"
import { join } from "node:path"
import { claimCatalogRequestSql, createSnapshotSql } from "../src/catalog-sql"
import { normalizeCatalog } from "../src/normalize"
import { TiApiError, TiClient } from "../src/ti-client"
import { executeSql, runWrangler } from "./d1"

const main = async () => {
  const args = process.argv.slice(2)
  const remote = args.includes("--remote")
  const catalogIndex = args.indexOf("--catalog")
  const catalogPath = catalogIndex < 0 ? undefined : args[catalogIndex + 1]
  for (let i = 0; i < args.length; i++) {
    if (
      args[i] === "--catalog" &&
      args[i + 1] &&
      !args[i + 1].startsWith("--")
    ) {
      i++
      continue
    }
    if (args[i] !== "--remote")
      throw new Error(
        "Usage: bun scripts/sync-catalog.ts [--remote] [--catalog file.json]",
      )
  }
  if (remote && catalogPath)
    throw new Error(
      "Fixture/file ingestion is local only; remote sync must fetch TI's catalog",
    )
  const currency = process.env.TI_CURRENCY || "USD"
  let raw: unknown
  if (catalogPath) raw = JSON.parse(await readFile(catalogPath, "utf8"))
  else {
    if (!process.env.TI_CLIENT_ID || !process.env.TI_CLIENT_SECRET)
      throw new Error(
        "Set TI_CLIENT_ID and TI_CLIENT_SECRET, or use --catalog for a local fixture",
      )
    if (!/^[A-Z]{3}$/.test(currency))
      throw new Error(
        "TI_CURRENCY must be a three-letter uppercase currency code",
      )
    const lease = executeSql(claimCatalogRequestSql(Date.now()), remote)
    if (!lease.length)
      throw new Error(
        "Catalog request skipped: TI allows one request per four hours. The previous attempt still holds the lease",
      )
    raw = await new TiClient(
      process.env.TI_CLIENT_ID,
      process.env.TI_CLIENT_SECRET,
    ).getCatalog(currency)
  }
  const parts = normalizeCatalog(raw, currency)
  const id = randomUUID()
  const sql = createSnapshotSql(parts, id, Date.now(), currency)
  // The full catalog is processed in this scheduled job, outside Worker memory/CPU limits.
  const directory = join(".wrangler", "catalog-imports")
  await mkdir(directory, { recursive: true })
  const sqlPath = join(directory, `${id}.sql`)
  try {
    await writeFile(sqlPath, sql, { mode: 0o600 })
    runWrangler([
      "d1",
      "execute",
      "tisearch",
      remote ? "--remote" : "--local",
      "--file",
      sqlPath,
      "--yes",
    ])
    const [state] = executeSql(
      "SELECT active_snapshot FROM catalog_state WHERE singleton = 1",
      remote,
    )
    if (state?.active_snapshot !== id)
      throw new Error(
        "Catalog activation failed; the previous snapshot is still active",
      )
    console.log(
      `Published ${parts.length} TI parts in ${currency}; snapshot ${id}`,
    )
  } finally {
    await rm(sqlPath, { force: true })
  }
}

main().catch((error) => {
  if (error instanceof TiApiError)
    console.error(
      `${error.message} (HTTP ${error.status})${error.retryAfter ? `; Retry-After: ${error.retryAfter}` : ""}`,
    )
  else
    console.error(
      error instanceof Error ? error.message : "Catalog sync failed",
    )
  process.exitCode = 1
})
