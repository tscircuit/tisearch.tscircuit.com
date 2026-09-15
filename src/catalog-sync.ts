import { CATEGORY_DEFINITIONS } from "./categories"
import { TI_ROUTE_FAMILIES } from "./jlc/catalog"
import { hydratePart } from "./catalog"
import { standardFields } from "./jlc-compat"
import { normalizeProduct } from "./normalize"
import { saveParts } from "./parts-store"
import { TiClient, TiApiError } from "./ti-client"
import type { Env } from "./types"

const getClient = (env: Env) =>
  new TiClient(env, (input, init) =>
    env.TI_GATEWAY
      ? env.TI_GATEWAY.get(env.TI_GATEWAY.idFromName("ti-account")).fetch(
          input,
          init,
        )
      : fetch(input, init),
  )

// Public requests never call these jobs. D1 preserves cursors and import queues.
export const discoverCatalog = async (env: Env) => {
  const now = Date.now()
  const families = [
    ...new Set([
      ...CATEGORY_DEFINITIONS.map((c) => c.query),
      ...Object.values(TI_ROUTE_FAMILIES).flat(),
    ]),
  ]
  await env.DB.batch(
    families.map((family) =>
      env.DB.prepare(
        "INSERT INTO catalog_sync(family) VALUES (?) ON CONFLICT DO NOTHING",
      ).bind(family),
    ),
  )
  const job = await env.DB.prepare(
    "SELECT family,next_offset FROM catalog_sync WHERE next_sync_at<=? AND lease_until<=? ORDER BY next_sync_at,family LIMIT 1",
  )
    .bind(now, now)
    .first<{ family: string; next_offset: number }>()
  if (!job) return
  const lease = await env.DB.prepare(
    "UPDATE catalog_sync SET lease_until=? WHERE family=? AND lease_until<=?",
  )
    .bind(now + 600_000, job.family, now)
    .run()
  if (!lease.meta.changes) return
  try {
    // One metadata request discovers 100 OPNs. Store lookups run separately.
    const result = await getClient(env).discover(job.family, job.next_offset)
    await env.DB.batch([
      ...result.information.map((info) =>
        env.DB.prepare(
          "INSERT INTO catalog_pending(ti_product_number,information_json,created_at) VALUES (?,?,?) ON CONFLICT(ti_product_number) DO UPDATE SET information_json=excluded.information_json",
        ).bind(String(info.Identifier), JSON.stringify(info), now),
      ),
      env.DB.prepare(
        "UPDATE catalog_sync SET next_offset=?,next_sync_at=?,lease_until=0,last_success_at=?,last_error=NULL WHERE family=?",
      ).bind(
        result.nextOffset ?? 0,
        now + (result.nextOffset === null ? 30 * 86400_000 : 86400_000),
        now,
        job.family,
      ),
    ])
  } catch (error) {
    await env.DB.prepare(
      "UPDATE catalog_sync SET lease_until=0,next_sync_at=?,last_error=? WHERE family=?",
    )
      .bind(
        now + 6 * 3600_000,
        error instanceof TiApiError ? `TI HTTP ${error.status}` : "Sync failed",
        job.family,
      )
      .run()
    console.warn(
      "TI catalog discovery paused",
      error instanceof TiApiError ? error.status : "sync error",
    )
  }
}

export const refreshInventory = async (env: Env) => {
  const client = getClient(env)
  const pending = await env.DB.prepare(
    "SELECT catalog_pending.ti_product_number,information_json,parts.raw_json FROM catalog_pending LEFT JOIN parts USING(ti_product_number) ORDER BY created_at,catalog_pending.ti_product_number LIMIT 20",
  ).all<{
    ti_product_number: string
    information_json: string
    raw_json: string | null
  }>()
  for (const row of pending.results) {
    try {
      const inventory = await client.inventory(row.ti_product_number)
      const old = row.raw_json ? hydratePart(row.raw_json) : null
      const part = normalizeProduct(
        {
          store: inventory.store,
          information: JSON.parse(row.information_json),
          parametrics: old?.parametrics,
        },
        env.TI_CURRENCY ?? "USD",
      )
      await saveParts(env, [part], inventory.updatedAt, [
        env.DB.prepare(
          "DELETE FROM catalog_pending WHERE ti_product_number=?",
        ).bind(row.ti_product_number),
      ])
    } catch (error) {
      if (error instanceof TiApiError && error.status === 404) {
        await env.DB.prepare(
          "DELETE FROM catalog_pending WHERE ti_product_number=?",
        )
          .bind(row.ti_product_number)
          .run()
        continue
      }
      console.warn(
        "TI import paused",
        error instanceof TiApiError ? error.status : "sync error",
      )
      return
    }
  }
  const remaining = 20 - pending.results.length
  if (!remaining) return
  const rows = await env.DB.prepare(
    "SELECT raw_json FROM parts WHERE updated_at<=? ORDER BY updated_at,ti_product_number LIMIT ?",
  )
    .bind(Date.now() - 86400_000, remaining)
    .all<{ raw_json: string }>()
  for (const row of rows.results) {
    const old = hydratePart(row.raw_json)
    try {
      const result = await client.inventory(old.ti_product_number)
      const fresh = normalizeProduct(
        { store: result.store, parametrics: old.parametrics },
        env.TI_CURRENCY ?? "USD",
      )
      await saveParts(
        env,
        [
          {
            ...fresh,
            category: old.category,
            subcategory: old.subcategory,
            parameters: { ...old.parameters, ...fresh.parameters },
          },
        ],
        result.updatedAt,
      )
    } catch (error) {
      if (error instanceof TiApiError && error.status === 404) {
        await saveParts(env, [
          {
            ...old,
            stock: 0,
            normally_stocking: false,
            price: null,
            price1: null,
            price_quantity: null,
            price_breaks: [],
          },
        ])
        continue
      }
      console.warn(
        "TI inventory sync paused",
        error instanceof TiApiError ? error.status : "sync error",
      )
      break
    }
  }
}

export const refreshSpecifications = async (env: Env) => {
  const client = getClient(env)
  const rows = await env.DB.prepare(
    "SELECT raw_json,updated_at FROM parts WHERE metadata_checked_at<=? ORDER BY metadata_checked_at,ti_product_number LIMIT 5",
  )
    .bind(Date.now() - 30 * 86400_000)
    .all<{ raw_json: string; updated_at: number }>()
  for (const row of rows.results) {
    const old = hydratePart(row.raw_json)
    try {
      const parametrics = await client.specifications(old.ti_product_number)
      // Reuse the normalizer to turn TI parametrics into readable parameter values.
      const readable = normalizeProduct({
        store: { tiPartNumber: old.ti_product_number, quantity: old.stock },
        parametrics,
      }).parameters
      await saveParts(
        env,
        [
          {
            ...old,
            ...standardFields(parametrics),
            parametrics,
            parameters: { ...old.parameters, ...readable },
          },
        ],
        row.updated_at,
        [
          env.DB.prepare(
            "UPDATE parts SET metadata_checked_at=? WHERE ti_product_number=?",
          ).bind(Date.now(), old.ti_product_number),
        ],
      )
    } catch (error) {
      if (error instanceof TiApiError && error.status === 404) {
        await env.DB.prepare(
          "UPDATE parts SET metadata_checked_at=? WHERE ti_product_number=?",
        )
          .bind(Date.now(), old.ti_product_number)
          .run()
        continue
      }
      console.warn(
        "TI specification sync paused",
        error instanceof TiApiError ? error.status : "sync error",
      )
      break
    }
  }
}

export const syncMetadata = async (env: Env) => {
  await discoverCatalog(env)
  await refreshSpecifications(env)
}
