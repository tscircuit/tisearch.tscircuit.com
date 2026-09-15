import { hydratePart } from "./catalog"
import { categoryRoutesForPart } from "./jlc/catalog"
import { standardFields } from "./jlc-compat"
import { normalizeProduct, toSearchText } from "./normalize"
import type { Env, NormalizedPart } from "./types"

export function enrichPart(
  old: NormalizedPart,
  information?: Record<string, unknown>,
  parametrics?: Record<string, unknown>,
): NormalizedPart {
  const info =
    information ?? (old.ti_information as Record<string, unknown>) ?? {}
  const specs =
    parametrics && Object.keys(parametrics).length
      ? parametrics
      : (old.parametrics ?? {})
  const fresh = normalizeProduct(
    {
      store: {
        tiPartNumber: old.ti_product_number,
        genericPartNumber:
          info.GenericProductIdentifier || old.generic_part_number,
        quantity: old.stock,
        description: info.Description || old.description,
        packageType:
          info.PackageGroup || info.IndustryPackageType || old.package,
        pinCount: info.Pin ?? old.pin_count,
        lifeCycle: info.LifeCycleStatus || old.lifecycle,
        buyNowUrl: old.product_url,
      },
      information: info,
      parametrics: specs,
    },
    old.currency,
  )
  const part: NormalizedPart = {
    ...old,
    ...fresh,
    // Product Information prices are not Store prices. Preserve all inventory.
    price: old.price,
    price1: old.price1,
    price_quantity: old.price_quantity,
    price_breaks: old.price_breaks,
    normally_stocking: old.normally_stocking,
    photo_url: old.photo_url,
    category: fresh.category || old.category,
    subcategory: fresh.subcategory || old.subcategory,
    datasheet_url: fresh.datasheet_url || old.datasheet_url,
    parameters: { ...old.parameters, ...fresh.parameters },
    ti_information: info,
    ti_family: fresh.category || old.category,
  }
  for (const name of Object.keys(standardFields({})))
    if (part[name] == null && old[name] != null) part[name] = old[name]
  part.category_routes = categoryRoutesForPart(part)
  part.category_mapping_status = (part.category_routes as string[]).length
    ? "mapped"
    : "unresolved"
  return part
}

// Update-only writes and optimistic concurrency protect both the frozen catalog
// and inventory/specification changes made while a TI request was in flight.
export async function updateMetadata(
  env: Env,
  records: Array<{
    pn: string
    information?: Record<string, unknown>
    parametrics?: Record<string, unknown>
  }>,
) {
  let remaining = records
  for (let attempt = 0; attempt < 4 && remaining.length; attempt++) {
    const rows = await env.DB.prepare(
      `SELECT ti_product_number,raw_json FROM parts WHERE ti_product_number IN (${remaining.map(() => "?").join(",")})`,
    )
      .bind(...remaining.map((r) => r.pn))
      .all<{ ti_product_number: string; raw_json: string }>()
    const byPn = new Map(
      rows.results.map((row) => [row.ti_product_number, row.raw_json]),
    )
    const matched = remaining.filter((record) => byPn.has(record.pn))
    if (!matched.length) return
    const results = await env.DB.batch(
      matched.map((record) => {
        const raw = byPn.get(record.pn)!
        const part = enrichPart(
          hydratePart(raw),
          record.information,
          record.parametrics,
        )
        return env.DB.prepare(`UPDATE parts SET
        description=?,detailed_description=?,package=?,category=?,subcategory=?,
        datasheet_url=?,discontinued=?,parameters_json=?,search_text=?,raw_json=?,
        information_checked_at=CASE WHEN ? THEN ? ELSE information_checked_at END,
        information_status=CASE WHEN ? THEN 'available' ELSE information_status END,
        metadata_checked_at=CASE WHEN ? THEN ? ELSE metadata_checked_at END,
        specification_status=CASE WHEN ? THEN ? ELSE specification_status END
        WHERE ti_product_number=? AND raw_json=?`).bind(
          part.description,
          part.detailed_description,
          part.package,
          part.category,
          part.subcategory,
          part.datasheet_url,
          Number(part.discontinued),
          JSON.stringify(part.parameters),
          toSearchText(part),
          JSON.stringify(part),
          Number(!!record.information),
          Date.now(),
          Number(!!record.information),
          Number(!!record.parametrics),
          Date.now(),
          Number(!!record.parametrics),
          Object.keys(record.parametrics ?? {}).length
            ? "available"
            : "unavailable",
          record.pn,
          raw,
        )
      }),
    )
    remaining = matched.filter((_, i) => !results[i].meta.changes)
  }
  if (remaining.length)
    throw new Error("Concurrent metadata update; retry saved batch")
}

export async function updateExistingInventory(
  env: Env,
  pn: string,
  store: Record<string, unknown> | null,
  updatedAt = Date.now(),
) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const row = await env.DB.prepare(
      "SELECT raw_json,updated_at FROM parts WHERE ti_product_number=?",
    )
      .bind(pn)
      .first<{ raw_json: string; updated_at: number }>()
    if (!row || row.updated_at > updatedAt) return
    const old = hydratePart(row.raw_json)
    const fresh = store
      ? normalizeProduct({ store, parametrics: old.parametrics }, old.currency)
      : {
          ...old,
          stock: 0,
          normally_stocking: false,
          price: null,
          price1: null,
          price_quantity: null,
          price_breaks: [],
        }
    const part = enrichPart({
      ...old,
      ...fresh,
      category: old.category,
      subcategory: old.subcategory,
      parameters: { ...old.parameters, ...fresh.parameters },
    })
    const result = await env.DB.prepare(`UPDATE parts SET
      description=?,detailed_description=?,package=?,discontinued=?,
      stock=?,unit_price=?,normally_stocking=?,parameters_json=?,search_text=?,raw_json=?,updated_at=?
      WHERE ti_product_number=? AND raw_json=?`)
      .bind(
        part.description,
        part.detailed_description,
        part.package,
        Number(part.discontinued),
        part.stock,
        part.price,
        Number(part.normally_stocking),
        JSON.stringify(part.parameters),
        toSearchText(part),
        JSON.stringify(part),
        updatedAt,
        pn,
        row.raw_json,
      )
      .run()
    if (result.meta.changes) return
  }
  throw new Error("Concurrent inventory update; retry later")
}
