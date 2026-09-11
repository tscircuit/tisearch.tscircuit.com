import type { NormalizedPart } from "./types"

export const sqlString = (value: string): string =>
  `'${value.replaceAll("'", "''")}'`
export const CATALOG_INTERVAL_MS = 4 * 60 * 60 * 1000

// Durable lease, shared by scheduled and manual syncs, claimed before sending to TI.
export const claimCatalogRequestSql = (now: number): string =>
  `UPDATE catalog_state SET next_request_at = ${now + CATALOG_INTERVAL_MS}
   WHERE singleton = 1 AND next_request_at <= ${now} RETURNING next_request_at;`

export const createSnapshotSql = (
  parts: NormalizedPart[],
  id: string,
  now: number,
  currency: string,
): string => {
  if (!parts.length) throw new Error("Cannot publish an empty catalog")
  const snapshot = sqlString(id)
  const statements = [
    `INSERT INTO catalog_snapshots(id, imported_at, part_count, currency) VALUES (${snapshot}, ${now}, ${parts.length}, ${sqlString(currency)});`,
  ]
  for (const part of parts) {
    const searchText = [
      part.ti_part_number,
      part.generic_part_number,
      part.description,
      part.package,
      part.manufacturer,
    ].join(" ")
    const values = [
      snapshot,
      sqlString(part.ti_part_number),
      sqlString(part.generic_part_number),
      sqlString(part.package),
      part.pin_count ?? "NULL",
      part.stock,
      sqlString(part.lifecycle),
      sqlString(JSON.stringify(part.categories)),
      sqlString(JSON.stringify(part)),
      sqlString(searchText),
    ]
    const statement = `INSERT INTO parts(snapshot_id, ti_part_number, generic_part_number, package, pin_count, stock, lifecycle, categories_json, data_json, search_text) VALUES (${values.join(",")});`
    if (new TextEncoder().encode(statement).length > 95000)
      throw new Error(
        `TI product ${part.ti_part_number} exceeds D1's SQL statement limit`,
      )
    statements.push(statement)
  }
  // Switch only once the entire immutable snapshot has been inserted.
  statements.push(
    `UPDATE catalog_state SET active_snapshot = ${snapshot} WHERE singleton = 1 AND (SELECT COUNT(*) FROM parts WHERE snapshot_id = ${snapshot}) = ${parts.length};`,
  )
  // Keep snapshots for 24 hours so in-flight readers still have their captured snapshot.
  statements.push(
    `DELETE FROM catalog_snapshots WHERE id != (SELECT active_snapshot FROM catalog_state WHERE singleton = 1) AND imported_at < ${now - 86400000};`,
  )
  return statements.join("\n")
}
