import { type CategoryDefinition } from "./categories"
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
): SearchRequest => {
  const p = url.searchParams
  const query = (p.get("q") ?? p.get("search") ?? category?.query ?? "")
    .replace(/\s+/g, " ")
    .trim()
  if (!query || query.length > 200 || !/[\p{L}\p{N}]/u.test(query))
    throw new SearchInputError(
      "A non-empty q or search parameter of at most 200 characters is required",
    )
  const mode =
    p.get("mode") ||
    (category
      ? "family"
      : /^[A-Za-z][A-Za-z0-9./+_-]*\d[A-Za-z0-9./+_-]*$/.test(query)
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
  const limit = integer(p.get("limit"), category ? 5 : 20, 1, 20)
  const offset = integer(p.get("offset"), 0, 0, 100000)
  if (offset % limit !== 0)
    throw new SearchInputError("offset must be a multiple of limit")
  const inStock = p.get("in_stock") || "false"
  if (!["true", "false"].includes(inStock))
    throw new SearchInputError("in_stock must be true or false")
  const postFilters: Record<string, string> = {}
  for (const name of ["package", "lifecycle", "package_code"]) {
    const value = p.get(name)?.trim()
    if (value && value.length > 100)
      throw new SearchInputError("Filter is too long")
    if (value) postFilters[name] = value
  }
  const pins = p.get("pin_count") || p.get("num_pins")
  if (pins) postFilters.num_pins = String(integer(pins, 0, 1, 10000))
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
  const manufacturers = p.get("manufacturer") ?? ""
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
    schemaVersion: 2,
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
