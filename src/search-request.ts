import type { SearchRequest } from "./types"

export class RequestError extends Error {}

const boundedInteger = (
  value: string | null,
  fallback: number,
  min: number,
  max: number,
): number => {
  if (value === null || value === "") return fallback
  if (!/^\d+$/.test(value) || Number(value) < min || Number(value) > max)
    throw new RequestError(`Expected an integer between ${min} and ${max}`)
  return Number(value)
}

export const createSearchRequest = (
  url: URL,
  category?: string,
): SearchRequest => {
  const params = url.searchParams
  const query = (params.get("q") ?? params.get("search") ?? "").trim()
  if (!category && !query)
    throw new RequestError("A non-empty q or search parameter is required")
  if (query.length > 200 || (query && !/[\p{L}\p{N}]/u.test(query)))
    throw new RequestError(
      "Search must contain letters or numbers and be at most 200 characters",
    )
  const getFilter = (name: string) => {
    const value = (params.get(name) ?? "").trim()
    if (value.length > 100)
      throw new RequestError(`${name} must be at most 100 characters`)
    return value
  }
  const inStock = params.get("in_stock") ?? "true"
  if (inStock !== "true" && inStock !== "false")
    throw new RequestError("in_stock must be true or false")
  const pins = params.get("pin_count") ?? params.get("num_pins")
  return {
    query,
    category,
    limit: boundedInteger(params.get("limit"), 20, 1, 100),
    offset: boundedInteger(params.get("offset"), 0, 0, 1_000_000),
    package: getFilter("package"),
    lifecycle: getFilter("lifecycle"),
    genericPartNumber: getFilter("gpn"),
    inStock: inStock === "true",
    pinCount: pins ? boundedInteger(pins, 0, 1, 10000) : null,
  }
}

export const toFtsQuery = (query: string): string =>
  (query.match(/[\p{L}\p{N}]+/gu) ?? [])
    .map((token) => `"${token}"*`)
    .join(" AND ")

export const escapeLike = (value: string): string =>
  value.replace(/[\\%_]/g, "\\$&")
