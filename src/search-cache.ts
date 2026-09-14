import { toSearchText } from "./normalize"
import type {
  TiFilterOptions,
  TiSearchResponse,
  Env,
  NormalizedPart,
  SearchCacheRow,
  SearchPayload,
  SearchRequest,
} from "./types"

interface CachedSearchDocument {
  components: NormalizedPart[]
  total: number
  upstream_total: number
  limit: number
  offset: number
  next_offset: number | null
  filter_options: TiFilterOptions
}

const secondsFromEnv = (raw: string | undefined, fallback: number): number => {
  const parsed = Number.parseInt(raw ?? "", 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

const mapCacheRow = (row: Record<string, unknown>): SearchCacheRow => ({
  cache_key: String(row.cache_key),
  query: String(row.query),
  request_json: String(row.request_json),
  response_json: String(row.response_json),
  response_key: String(row.response_key),
  source_kind: row.source_kind as "search" | "category",
  created_at: Number(row.created_at),
  refreshed_at: Number(row.refreshed_at),
  expires_at: Number(row.expires_at),
  stale_until: Number(row.stale_until),
  last_accessed_at: Number(row.last_accessed_at),
  access_count: Number(row.access_count),
  api_rate_limit_remaining:
    row.api_rate_limit_remaining === null
      ? null
      : Number(row.api_rate_limit_remaining),
})

export const getCachedSearch = async (
  env: Env,
  cacheKey: string,
): Promise<{
  row: SearchCacheRow
  document: CachedSearchDocument
} | null> => {
  const rawRow = await env.DB.prepare(
    "SELECT * FROM search_cache WHERE cache_key = ? LIMIT 1",
  )
    .bind(cacheKey)
    .first<Record<string, unknown>>()

  if (!rawRow) return null

  const now = Date.now()
  await env.DB.prepare(
    `UPDATE search_cache
     SET access_count = access_count + 1, last_accessed_at = ?
     WHERE cache_key = ?`,
  )
    .bind(now, cacheKey)
    .run()

  const row = mapCacheRow(rawRow)
  try {
    return {
      row,
      document: JSON.parse(row.response_json) as CachedSearchDocument,
    }
  } catch {
    await env.DB.prepare("DELETE FROM search_cache WHERE cache_key = ?")
      .bind(cacheKey)
      .run()
    return null
  }
}

export const putCachedSearch = async (
  env: Env,
  cacheKey: string,
  request: SearchRequest,
  upstreamResponse: TiSearchResponse,
  components: NormalizedPart[],
  filterOptions: TiFilterOptions,
  rateLimitRemaining: number | null,
  indexedParts: NormalizedPart[] = components,
): Promise<{ row: SearchCacheRow; document: CachedSearchDocument }> => {
  const now = Date.now()
  const ttlSeconds = secondsFromEnv(env.TI_CACHE_TTL_SECONDS, 86_400)
  const staleTtlSeconds = secondsFromEnv(env.TI_STALE_TTL_SECONDS, 604_800)
  const expiresAt = now + ttlSeconds * 1_000
  const staleUntil = expiresAt + staleTtlSeconds * 1_000
  const document: CachedSearchDocument = {
    components,
    total: components.length,
    upstream_total: upstreamResponse.upstreamTotal,
    limit: request.limit,
    offset: request.offset,
    next_offset: upstreamResponse.nextOffset,
    filter_options: filterOptions,
  }
  const responseJson = JSON.stringify(document)

  const statements: D1PreparedStatement[] = [
    env.DB.prepare(
      `INSERT INTO search_cache (
        cache_key, query, request_json, response_json, response_key,
        source_kind, created_at, refreshed_at, expires_at, stale_until,
        last_accessed_at, access_count, api_rate_limit_remaining
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
      ON CONFLICT(cache_key) DO UPDATE SET
        query = excluded.query,
        request_json = excluded.request_json,
        response_json = excluded.response_json,
        response_key = excluded.response_key,
        source_kind = excluded.source_kind,
        refreshed_at = excluded.refreshed_at,
        expires_at = excluded.expires_at,
        stale_until = excluded.stale_until,
        last_accessed_at = excluded.last_accessed_at,
        access_count = search_cache.access_count + 1,
        api_rate_limit_remaining = excluded.api_rate_limit_remaining`,
    ).bind(
      cacheKey,
      request.query,
      JSON.stringify(request),
      responseJson,
      request.responseKey,
      request.sourceKind,
      now,
      now,
      expiresAt,
      staleUntil,
      now,
      rateLimitRemaining,
    ),
  ]

  for (const part of indexedParts) {
    statements.push(
      env.DB.prepare(
        `INSERT INTO parts (
          ti_product_number, manufacturer_part_number, manufacturer,
          description, detailed_description, package, category_id, category,
          subcategory, stock, unit_price, product_url, datasheet_url, photo_url,
          normally_stocking, discontinued, marketplace, parameters_json,
          search_text, raw_json, first_seen_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(ti_product_number) DO UPDATE SET
          manufacturer_part_number = excluded.manufacturer_part_number,
          manufacturer = excluded.manufacturer,
          description = excluded.description,
          detailed_description = excluded.detailed_description,
          package = excluded.package,
          category = excluded.category,
          subcategory = excluded.subcategory,
          stock = excluded.stock,
          unit_price = excluded.unit_price,
          product_url = excluded.product_url,
          datasheet_url = excluded.datasheet_url,
          photo_url = excluded.photo_url,
          normally_stocking = excluded.normally_stocking,
          discontinued = excluded.discontinued,
          marketplace = excluded.marketplace,
          parameters_json = excluded.parameters_json,
          search_text = excluded.search_text,
          raw_json = excluded.raw_json,
          updated_at = excluded.updated_at`,
      ).bind(
        part.ti_product_number,
        part.mfr,
        part.manufacturer,
        part.description,
        part.detailed_description,
        part.package || null,
        part.category || null,
        part.subcategory || null,
        part.stock,
        part.price,
        part.product_url || null,
        part.datasheet_url || null,
        part.photo_url || null,
        Number(part.normally_stocking),
        Number(part.discontinued),
        Number(part.marketplace),
        JSON.stringify(part.parameters),
        toSearchText(part),
        JSON.stringify(part),
        now,
        now,
      ),
    )
  }

  await env.DB.batch(statements)

  return {
    row: {
      cache_key: cacheKey,
      query: request.query,
      request_json: JSON.stringify(request),
      response_json: responseJson,
      response_key: request.responseKey,
      source_kind: request.sourceKind,
      created_at: now,
      refreshed_at: now,
      expires_at: expiresAt,
      stale_until: staleUntil,
      last_accessed_at: now,
      access_count: 1,
      api_rate_limit_remaining: rateLimitRemaining,
    },
    document,
  }
}

export const buildSearchPayload = (
  row: SearchCacheRow,
  document: CachedSearchDocument,
  cached: boolean,
  stale: boolean,
): SearchPayload => ({
  query: row.query,
  components: document.components,
  total: document.total,
  upstream_total: document.upstream_total,
  limit: document.limit,
  offset: document.offset,
  next_offset: document.next_offset,
  filter_options: document.filter_options,
  source: "ti",
  cached,
  stale,
  cache_expires_at: new Date(row.expires_at).toISOString(),
})

export const getPackageIndex = async (
  env: Env,
): Promise<
  Array<{
    package: string
    num_components: number
    stock: number
    footprinter_string: null
    tscircuit_accepts: false
  }>
> => {
  const result = await env.DB.prepare(
    `SELECT package, COUNT(*) AS num_components, SUM(stock) AS stock
     FROM parts
     WHERE package IS NOT NULL AND package != ''
     GROUP BY package
     ORDER BY stock DESC, num_components DESC
     LIMIT 500`,
  ).all<{ package: string; num_components: number; stock: number }>()

  return (result.results ?? []).map((row) => ({
    package: row.package,
    num_components: Number(row.num_components),
    stock: Number(row.stock),
    footprinter_string: null,
    tscircuit_accepts: false,
  }))
}

export const getIndexedCategories = async (
  env: Env,
): Promise<Array<{ category: string; subcategory: string; stock: number }>> => {
  const result = await env.DB.prepare(
    `SELECT category, subcategory, SUM(stock) AS stock
     FROM parts
     WHERE category IS NOT NULL AND category != ''
     GROUP BY category, subcategory
     ORDER BY stock DESC
     LIMIT 500`,
  ).all<{ category: string; subcategory: string; stock: number }>()

  return (result.results ?? []).map((row) => ({
    category: row.category,
    subcategory: row.subcategory,
    stock: Number(row.stock),
  }))
}

export const searchIndexedParts = async (
  env: Env,
  query: string,
  limit: number,
): Promise<NormalizedPart[]> => {
  const tokens = query.toLowerCase().match(/[a-z0-9]+/g) ?? []
  if (tokens.length === 0) return []
  const match = tokens.map((token) => `${token.replaceAll('"', "")}*`).join(" ")

  const result = await env.DB.prepare(
    `SELECT parts.raw_json
     FROM parts_fts
     JOIN parts ON parts.rowid = parts_fts.rowid
     WHERE parts_fts MATCH ? AND parts.stock > 0 AND parts.updated_at >= ? AND json_extract(parts.raw_json, '$.currency') = ?
     ORDER BY parts.stock DESC
     LIMIT ?`,
  )
    .bind(
      match,
      Date.now() -
        (secondsFromEnv(env.TI_CACHE_TTL_SECONDS, 86400) +
          secondsFromEnv(env.TI_STALE_TTL_SECONDS, 604800)) *
          1000,
      env.TI_CURRENCY ?? "USD",
      limit,
    )
    .all<{ raw_json: string }>()

  return (result.results ?? [])
    .map((row) => {
      try {
        return JSON.parse(row.raw_json) as NormalizedPart
      } catch {
        return null
      }
    })
    .filter((part): part is NormalizedPart => part !== null)
}

export const getRefreshCandidates = async (
  env: Env,
  limit = 20,
): Promise<SearchCacheRow[]> => {
  const result = await env.DB.prepare(
    `SELECT * FROM search_cache
     WHERE expires_at <= ?
     ORDER BY access_count DESC, last_accessed_at DESC
     LIMIT ?`,
  )
    .bind(Date.now(), limit)
    .all<Record<string, unknown>>()

  return (result.results ?? []).map(mapCacheRow)
}

export const getRecentParts = async (env: Env): Promise<NormalizedPart[]> => {
  const result = await env.DB.prepare(
    `SELECT raw_json FROM parts
     WHERE updated_at >= ? AND json_extract(raw_json, '$.currency') = ?
     ORDER BY stock DESC, updated_at DESC, ti_product_number
     LIMIT 20`,
  )
    .bind(
      Date.now() - secondsFromEnv(env.TI_CACHE_TTL_SECONDS, 86400) * 1000,
      env.TI_CURRENCY ?? "USD",
    )
    .all<{ raw_json: string }>()
  return (result.results ?? []).flatMap(({ raw_json }) => {
    try {
      return [JSON.parse(raw_json) as NormalizedPart]
    } catch {
      return []
    }
  })
}
