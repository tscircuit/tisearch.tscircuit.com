import { SPEC_FILTERS, NUMERIC_SPEC_FILTERS } from "./jlc-compat"
import { CATEGORY_DEFINITIONS, type CategoryDefinition } from "./categories"
import { validatePartNumber } from "./part-number"
import type { SearchRequest } from "./types"

export class SearchInputError extends Error {}

const integer = (
  raw: string | null,
  fallback: number,
  min: number,
  max: number,
) => {
  if (raw === null || raw === "") return fallback
  const n = Number(raw)
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(n) || n < min || n > max)
    throw new SearchInputError(`Expected an integer between ${min} and ${max}`)
  return n
}

export const createSearchRequest = (
  url: URL,
  category?: CategoryDefinition,
  options: { catalog?: boolean } = {},
): SearchRequest => {
  const p = url.searchParams
  for (const name of ["is_basic", "is_preferred", "lcsc"]) {
    if (p.get(name) && p.get(name) !== "All")
      throw new SearchInputError(`${name} is not available in TI's catalog`)
  }
  let query = (
    p.get("q") ??
    p.get("search") ??
    p.get("subcategory_name") ??
    category?.query ??
    ""
  )
    .replace(/\s+/g, " ")
    .trim()
  if (
    (!query && !options.catalog) ||
    query.length > 200 ||
    (query && !/[\p{L}\p{N}]/u.test(query))
  )
    throw new SearchInputError(
      "A non-empty q or search parameter of at most 200 characters is required",
    )
  const family = CATEGORY_DEFINITIONS.find((c) =>
    [c.query, c.label, c.responseKey.replaceAll("_", " ")].some(
      (v) => v.toLowerCase() === query.toLowerCase(),
    ),
  )
  if (family) query = family.query
  const mode =
    p.get("mode") ||
    (/^[A-Za-z][A-Za-z0-9./+_-]*\d[A-Za-z0-9./+_-]*$/.test(query)
      ? "part"
      : "family")
  if (mode !== "part" && mode !== "family")
    throw new SearchInputError("mode must be part or family")
  if (mode === "part") {
    try {
      validatePartNumber(query)
    } catch {
      throw new SearchInputError("Provide one TI orderable or base part number")
    }
  }
  const limit = options.catalog
    ? 0
    : integer(p.get("limit"), category ? 5 : 20, 1, 20)
  const offset = options.catalog ? 0 : integer(p.get("offset"), 0, 0, 100000)

  const inStock = p.get("in_stock") || "false"
  if (!["true", "false"].includes(inStock))
    throw new SearchInputError("in_stock must be true or false")
  const postFilters: Record<string, string> = { ...category?.defaultFilters }
  for (const name of [
    "package",
    "lifecycle",
    "package_code",
    ...Object.keys(SPEC_FILTERS),
  ]) {
    const value = p.get(name)?.trim()
    if (value && value.length > 100)
      throw new SearchInputError("Filter is too long")
    if (value && value !== "All") {
      if (
        NUMERIC_SPEC_FILTERS.has(name) &&
        (!Number.isFinite(Number(value)) || Number(value) < 0)
      )
        throw new SearchInputError(`Invalid numeric filter: ${name}`)
      postFilters[name] = value
    }
  }
  const pins = p.get("pin_count") || p.get("num_pins")
  if (pins && pins !== "All")
    postFilters.num_pins = String(integer(pins, 0, 1, 10000))
  const parametricFilters: SearchRequest["parametricFilters"] = []
  for (const [name, value] of p) {
    const match = /^param_(\d+)_(\d+)$/.exec(name)
    if (!match || !value) continue
    if (value.length > 500) throw new SearchInputError("Filter is too long")
    const id = Number(match[2])
    if (!Number.isSafeInteger(id))
      throw new SearchInputError("Invalid parameter ID")
    parametricFilters.push({
      categoryId: match[1],
      parameterId: id,
      valueIds: [
        ...new Set(
          value
            .split(",")
            .map((v) => v.trim())
            .filter(Boolean),
        ),
      ].sort(),
    })
  }
  parametricFilters.sort(
    (a, b) =>
      a.categoryId.localeCompare(b.categoryId) || a.parameterId - b.parameterId,
  )
  const manufacturers =
    p.get("manufacturer") === "All" ? "" : (p.get("manufacturer") ?? "")
  if (manufacturers.length > 200)
    throw new SearchInputError("Filter is too long")
  return {
    query,
    mode,
    limit,
    offset,
    responseKey: category?.responseKey ?? "components",
    sourceKind: category ? "category" : "search",
    inStock: inStock === "true",
    postFilters,
    manufacturerNames: [
      ...new Set(
        manufacturers
          .split(",")
          .map((v) => v.trim())
          .filter(Boolean),
      ),
    ].sort(),
    parametricFilters,
  }
}

export const getSearchCacheKey = async (
  request: SearchRequest,
  currency = "USD",
): Promise<string> => {
  const canonical = JSON.stringify({
    ...request,
    schemaVersion: 3,
    currency,
    query: request.query.toLowerCase(),
    postFilters: Object.fromEntries(
      Object.entries(request.postFilters).sort(([a], [b]) =>
        a.localeCompare(b),
      ),
    ),
  })
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(canonical),
  )
  return Array.from(new Uint8Array(digest), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("")
}

// Filter-only changes reuse the same TI retrieval and D1 cache entry.
export const upstreamRequest = (request: SearchRequest): SearchRequest => ({
  ...request,
  inStock: false,
  manufacturerNames: [],
  parametricFilters: [],
  responseKey: "components",
  sourceKind: "search",
  postFilters: Object.fromEntries(
    Object.entries(request.postFilters).filter(([key]) =>
      ["num_pins", "lifecycle", "package_code"].includes(key),
    ),
  ),
})
