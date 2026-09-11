import {
  mkdtemp,
  readdir,
  readFile,
  mkdir,
  writeFile,
  rm,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { spawnSync } from "node:child_process"
import {
  findExactJlcPart,
  validateImportedTsx,
  validatePartNumber,
} from "../src/import-match"

const main = async () => {
  const args = process.argv.slice(2)
  if (args.length !== 1 && !(args.length === 3 && args[1] === "--out"))
    throw new Error("Usage: bun run import:part <TI-OPN> [--out imports]")
  const pn = validatePartNumber(args[0])
  const response = await fetch(
    `https://jlcsearch.tscircuit.com/api/search?q=${encodeURIComponent(pn)}&limit=50`,
    { signal: AbortSignal.timeout(30000) },
  )
  if (!response.ok)
    throw new Error(`JLC CAD lookup failed (HTTP ${response.status})`)
  const match = findExactJlcPart(pn, await response.json())
  const directory = await mkdtemp(join(tmpdir(), "ti-import-"))
  try {
    const result = spawnSync(
      "tsci",
      ["import", `C${match.lcsc}`, "--use-exact-footprint"],
      {
        cwd: directory,
        encoding: "utf8",
        timeout: 120000,
      },
    )
    if (result.status !== 0)
      throw new Error(
        result.error?.message ??
          "tsci import failed; install tscircuit and check the CAD source",
      )
    const files = (await readdir(join(directory, "imports"))).filter((f) =>
      f.endsWith(".tsx"),
    )
    if (files.length !== 1)
      throw new Error("Expected exactly one imported TSX component")
    const tsx = await readFile(join(directory, "imports", files[0]), "utf8")
    validateImportedTsx(tsx, pn, match.lcsc)
    const target = resolve(args[2] ?? "imports")
    await mkdir(target, { recursive: true })
    // Exclusive writes protect an existing edited component. Provenance stays separate
    // from supplierPartNumbers: the CAD came from EasyEDA, not TI's buying API.
    await writeFile(join(target, files[0]), tsx, { flag: "wx" })
    await writeFile(
      join(target, `${files[0]}.provenance.json`),
      JSON.stringify(
        {
          ti_part_number: pn,
          cad_source: "easyeda",
          lcsc_part_number: `C${match.lcsc}`,
          matched_package: match.package,
          imported_at: new Date().toISOString(),
          identity_checked: true,
          footprint_electrically_verified: false,
        },
        null,
        2,
      ),
      { flag: "wx" },
    )
    console.log(
      `Imported ${pn} via EasyEDA C${match.lcsc} to ${join(target, files[0])}`,
    )
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}
main().catch((error) => {
  console.error(error instanceof Error ? error.message : "Import failed")
  process.exitCode = 1
})
