import { normalizeProduct } from "./normalize"
import { validatePartNumber } from "./part-number"
import { getTiProductUrl, type TiClient } from "./ti-client"

export const TSX_UNSUPPORTED_REASON =
  "TI's documented product APIs do not provide schematic pin mappings or PCB pad geometry. TI API-only TSX conversion is unsupported; use --format json to import part metadata."

export const importTiPart = async (
  client: Pick<TiClient, "getProduct">,
  partNumber: string,
  {
    currency = "USD",
    format = "json",
  }: { currency?: string; format?: string } = {},
) => {
  const pn = validatePartNumber(partNumber)
  if (format === "tsx") throw new Error(TSX_UNSUPPORTED_REASON)
  if (format !== "json") throw new Error("Supported import format: json")
  const sourceUrl = getTiProductUrl(pn, currency).href
  const part = normalizeProduct(await client.getProduct(pn, currency), currency)
  // An orderable part must match in full, including package and packing suffixes.
  if (part.ti_part_number.toUpperCase() !== pn.toUpperCase())
    throw new Error(
      "TI returned a different orderable part number; import refused",
    )
  return {
    schema_version: 1,
    source: "ti_api",
    source_url: sourceUrl,
    imported_at: new Date().toISOString(),
    part,
    tsx: { supported: false, reason: TSX_UNSUPPORTED_REASON },
  }
}
