import { escapeLike, toFtsQuery } from "./search-request"
import type {
  CatalogSnapshot,
  Env,
  NormalizedPart,
  SearchPayload,
  SearchRequest,
} from "./types"

export class CatalogUnavailable extends Error {}

const seconds = (raw: string | undefined, fallback: number): number => {
  const n = Number(raw)
  return Number.isFinite(n) && n > 0 ? n : fallback
}

export const getSnapshot = async (env: Env): Promise<CatalogSnapshot> => {
  const snapshot = await env.DB.prepare(`SELECT s.* FROM catalog_snapshots s
    JOIN catalog_state c ON s.id = c.active_snapshot WHERE c.singleton = 1`).first<CatalogSnapshot>()
  if (!snapshot)
    throw new CatalogUnavailable("The TI catalog has not been synchronized yet")
  if (
    Date.now() - snapshot.imported_at >
    seconds(env.TI_CATALOG_MAX_AGE_SECONDS, 604800) * 1000
  )
    throw new CatalogUnavailable(
      "The TI catalog is too old to serve. A successful catalog sync is required",
    )
  return snapshot
}

export const searchIndexedParts = async (
  env: Env,
  request: SearchRequest,
): Promise<SearchPayload> => {
  const snapshot = await getSnapshot(env)
  const clauses = ["p.snapshot_id = ?"]
  const bindings: (string | number)[] = [snapshot.id]
  if (request.query) {
    clauses.push(
      "(p.ti_part_number = ? COLLATE NOCASE OR p.id IN (SELECT rowid FROM parts_fts WHERE parts_fts MATCH ?))",
    )
    bindings.push(request.query, toFtsQuery(request.query))
  }
  if (request.inStock) clauses.push("p.stock > 0")
  if (request.category) {
    clauses.push(
      "EXISTS (SELECT 1 FROM json_each(p.categories_json) WHERE value = ?)",
    )
    bindings.push(request.category)
  }
  if (request.package) {
    clauses.push("p.package LIKE ? ESCAPE '\\'")
    bindings.push(`%${escapeLike(request.package)}%`)
  }
  if (request.pinCount !== null) {
    clauses.push("p.pin_count = ?")
    bindings.push(request.pinCount)
  }
  if (request.lifecycle) {
    clauses.push("p.lifecycle = ? COLLATE NOCASE")
    bindings.push(request.lifecycle)
  }
  if (request.genericPartNumber) {
    clauses.push("p.generic_part_number = ? COLLATE NOCASE")
    bindings.push(request.genericPartNumber)
  }
  const where = clauses.join(" AND ")
  // Both queries use one captured snapshot ID; a concurrent sync cannot mix catalogs.
  const [count, rows] = await env.DB.batch<Record<string, unknown>>([
    env.DB.prepare(`SELECT COUNT(*) AS total FROM parts p WHERE ${where}`).bind(
      ...bindings,
    ),
    env.DB.prepare(`SELECT p.data_json FROM parts p WHERE ${where}
      ORDER BY (p.ti_part_number = ? COLLATE NOCASE) DESC, p.stock DESC, p.ti_part_number ASC LIMIT ? OFFSET ?`).bind(
      ...bindings,
      request.query,
      request.limit,
      request.offset,
    ),
  ])
  const expiresAt =
    snapshot.imported_at + seconds(env.TI_CATALOG_TTL_SECONDS, 21600) * 1000
  return {
    query: request.query,
    components: rows.results.map(
      (row) => JSON.parse(String(row.data_json)) as NormalizedPart,
    ),
    total: Number(count.results[0]?.total ?? 0),
    limit: request.limit,
    offset: request.offset,
    source: "ti",
    cached: true,
    stale: Date.now() > expiresAt,
    catalog_updated_at: new Date(snapshot.imported_at).toISOString(),
    cache_expires_at: new Date(expiresAt).toISOString(),
    currency: snapshot.currency,
  }
}

export const getPackageIndex = async (
  env: Env,
): Promise<Record<string, unknown>[]> => {
  const snapshot = await getSnapshot(env)
  const result =
    await env.DB.prepare(`SELECT package, COUNT(*) AS parts, SUM(stock) AS stock
    FROM parts WHERE snapshot_id = ? AND stock > 0 GROUP BY package ORDER BY parts DESC, package ASC`)
      .bind(snapshot.id)
      .all()
  return result.results
}
