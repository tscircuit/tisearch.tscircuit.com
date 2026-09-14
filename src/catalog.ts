import { CATEGORY_DEFINITIONS, type CategoryDefinition } from "./categories"
import { standardFields } from "./jlc-compat"
import { applyPostFilters, buildTiFilterOptions } from "./normalize"
import { createSearchRequest } from "./search-request"
import type { Env, NormalizedPart, SearchPayload } from "./types"

export const hydratePart = (raw: string): NormalizedPart => {
  const part = JSON.parse(raw) as NormalizedPart
  return {
    ...part,
    ...standardFields(part.parametrics ?? {}),
    num_pins: part.pin_count,
    price1: part.price_breaks?.find((b) => b.quantity === 1)?.price ?? null,
  }
}
const escapeLike = (value: string) => value.replace(/[\\%_]/g, "\\$&")
const familyName = (value: string) =>
  CATEGORY_DEFINITIONS.find((category) =>
    [
      category.query,
      category.label,
      category.responseKey.replaceAll("_", " "),
    ].some((name) => name.toLowerCase() === value.toLowerCase()),
  )?.query

// Public reads never instantiate a TI client, queue a fetch, or refresh a cache.
export const queryCatalog = async (
  env: Env,
  url: URL,
  category?: CategoryDefinition,
): Promise<SearchPayload> => {
  const request = createSearchRequest(url, category, { catalog: true })
  const family =
    category?.query ??
    familyName(url.searchParams.get("subcategory_name") ?? "") ??
    familyName(request.query) ??
    (url.searchParams.get("mode") === "family" ? request.query : undefined)
  const where = ["json_extract(raw_json, '$.currency') = ?"]
  const values: (string | number)[] = [env.TI_CURRENCY ?? "USD"]
  if (family) {
    where.push("category LIKE ? ESCAPE '\\'")
    values.push(`${escapeLike(family)}%`)
  }
  if (request.query && request.query !== family) {
    if (request.mode === "part") {
      where.push(
        "(manufacturer_part_number = ? COLLATE NOCASE OR json_extract(raw_json, '$.generic_part_number') = ? COLLATE NOCASE)",
      )
      values.push(request.query, request.query)
    } else {
      const tokens = request.query.match(/[\p{L}\p{N}]+/gu) ?? []
      where.push(
        "rowid IN (SELECT rowid FROM parts_fts WHERE parts_fts MATCH ?)",
      )
      values.push(tokens.map((token) => `"${token}"*`).join(" AND "))
    }
  }
  const result = await env.DB.prepare(
    `SELECT raw_json,updated_at FROM parts WHERE ${where.join(" AND ")} ORDER BY stock DESC, manufacturer_part_number ASC`,
  )
    .bind(...values)
    .all<{ raw_json: string; updated_at: number }>()
  const rows = result.results ?? []
  // Evaluate every electrical filter over the full stored category before rendering.
  const parts = rows.map((row) => ({
    ...hydratePart(row.raw_json),
    inventory_updated_at: new Date(row.updated_at).toISOString(),
  }))
  const components = applyPostFilters(parts, request)
  const oldest = rows.length
    ? rows.reduce((min, row) => Math.min(min, row.updated_at), Infinity)
    : null
  return {
    query: request.query,
    components,
    total: components.length,
    upstream_total: null,
    limit: components.length,
    offset: 0,
    next_offset: null,
    filter_options: buildTiFilterOptions(parts),
    filter_scope: "catalog",
    source: "ti-d1-index",
    cached: true,
    stale: oldest !== null && oldest < Date.now() - 86400_000,
    cache_expires_at:
      oldest === null ? "" : new Date(oldest + 86400_000).toISOString(),
    last_updated_at: oldest === null ? null : new Date(oldest).toISOString(),
    catalog_complete: false,
  }
}
