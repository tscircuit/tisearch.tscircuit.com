import { toSearchText } from "./normalize"
import type { Env, NormalizedPart } from "./types"

export const saveParts = async (
  env: Env,
  parts: NormalizedPart[],
  now = Date.now(),
  extraStatements: D1PreparedStatement[] = [],
) => {
  const statements: D1PreparedStatement[] = []
  for (const part of parts) {
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

  statements.push(...extraStatements)
  if (statements.length) await env.DB.batch(statements)
}

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
