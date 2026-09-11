import { mkdir, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { parseArgs } from "node:util"
import { importTiPart } from "../src/import-ti-part"
import { TiApiError, TiClient } from "../src/ti-client"

const main = async () => {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
    allowPositionals: true,
    options: {
      out: { type: "string", default: "imports" },
      format: { type: "string", default: "json" },
    },
  })
  if (positionals.length !== 1)
    throw new Error(
      "Usage: bun run import:part <TI-OPN> [--out imports] [--format json] (metadata only; TSX unsupported)",
    )
  const client = new TiClient(
    process.env.TI_CLIENT_ID ?? "",
    process.env.TI_CLIENT_SECRET ?? "",
  )
  const document = await importTiPart(client, positionals[0], {
    currency: process.env.TI_CURRENCY ?? "USD",
    format: values.format,
  })
  const target = resolve(values.out)
  await mkdir(target, { recursive: true })
  // Encoding preserves /NOPB without creating a nested path or colliding with _NOPB.
  const file = join(
    target,
    `${encodeURIComponent(document.part.ti_part_number)}.ti.json`,
  )
  await writeFile(file, `${JSON.stringify(document, null, 2)}\n`, {
    flag: "wx",
  })
  console.log(
    `Imported ${document.part.ti_part_number} metadata from the TI API to ${file}`,
  )
  console.log(
    "TSX conversion unavailable: TI's API does not supply pin mappings or PCB pad geometry.",
  )
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : "TI import failed"
  console.error(
    error instanceof TiApiError ? `${message} (HTTP ${error.status})` : message,
  )
  process.exitCode = 1
})
