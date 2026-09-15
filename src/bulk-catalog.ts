import { DurableObject } from "cloudflare:workers"
import { catalogRecords } from "./catalog-stream"
import { normalizeProduct } from "./normalize"
import { hydratePart } from "./catalog"
import { saveParts } from "./parts-store"
import type { Env, NormalizedPart } from "./types"

const FOUR_HOURS = 4 * 3600_000
const DAY = 86400_000
const CHUNK_SIZE = 500
interface BulkState {
  status: "idle" | "downloading" | "importing" | "complete" | "error"
  snapshot?: string
  fetchedAt?: number
  nextDownloadAt: number
  chunks: number
  nextChunk: number
  downloaded: number
  processed: number
  rejected: number
  completedAt?: number
  lastError?: string
  rejectedSamples?: Array<{ partNumber: string; reason: string }>
}
const initial = (): BulkState => ({
  status: "idle",
  nextDownloadAt: 0,
  chunks: 0,
  nextChunk: 0,
  downloaded: 0,
  processed: 0,
  rejected: 0,
})

// Inventory snapshots may arrive after per-part refreshes. Do not overwrite
// newer inventory, or erase categories/specifications absent from the bulk API.
export async function importCatalogChunk(
  env: Env,
  records: Record<string, unknown>[],
  fetchedAt: number,
) {
  let rejected = 0
  const rejectedSamples: Array<{ partNumber: string; reason: string }> = []
  for (let i = 0; i < records.length; i += 100) {
    const readAt = Date.now()
    const fresh: NormalizedPart[] = []
    for (const store of records.slice(i, i + 100)) {
      try {
        fresh.push(normalizeProduct({ store }, env.TI_CURRENCY ?? "USD"))
      } catch (error) {
        rejected++
        if (rejectedSamples.length < 20)
          rejectedSamples.push({
            partNumber: String(store.tiPartNumber ?? "").slice(0, 100),
            reason:
              error instanceof Error ? error.message : "Invalid catalog record",
          })
      }
    }
    if (!fresh.length) continue
    const slots = fresh.map(() => "?").join(",")
    const existingRequest = env.DB.prepare(
      `SELECT ti_product_number,raw_json,updated_at FROM parts WHERE ti_product_number IN (${slots})`,
    )
      .bind(...fresh.map((p) => p.ti_product_number))
      .all<{
        ti_product_number: string
        raw_json: string
        updated_at: number
      }>()
    // Reuse a known family for package variants of the same TI base product.
    // Do not guess categories from keywords or invent electrical specifications.
    const familiesRequest = env.DB.prepare(
      `SELECT json_extract(raw_json,'$.generic_part_number') AS gpn,category,subcategory FROM parts WHERE json_extract(raw_json,'$.generic_part_number') IN (${slots}) AND category IS NOT NULL AND category!='' GROUP BY json_extract(raw_json,'$.generic_part_number') HAVING count(DISTINCT category)=1`,
    )
      .bind(...fresh.map((p) => p.generic_part_number))
      .all<{ gpn: string; category: string; subcategory: string }>()
    const [existing, families] = await Promise.all([
      existingRequest,
      familiesRequest,
    ])
    const oldParts = new Map(
      existing.results.map((row) => [row.ti_product_number, row]),
    )
    const familyByGpn = new Map(families.results.map((row) => [row.gpn, row]))
    const parts: NormalizedPart[] = []
    for (const part of fresh) {
      const existing = oldParts.get(part.ti_product_number)
      if (existing && existing.updated_at > fetchedAt) continue
      const old = existing ? hydratePart(existing.raw_json) : undefined
      const family = familyByGpn.get(part.generic_part_number)
      const merged: NormalizedPart = {
        ...old,
        ...part,
        category: old?.category || family?.category || "",
        subcategory: old?.subcategory || family?.subcategory || "",
        parametrics: old?.parametrics ?? {},
        parameters: { ...old?.parameters, ...part.parameters },
        datasheet_url: old?.datasheet_url || part.datasheet_url,
      }
      // Keep previously enriched electrical fields, including explicit ratings
      // whose raw parametrics were not stored by older importer versions.
      for (const name of [
        "resolution_bits",
        "num_channels",
        "output_voltage_min",
        "output_voltage_max",
        "output_type",
        "cpu_core",
        "flash_size_bytes",
        "ram_size_bytes",
        "topology",
      ])
        if (old?.[name] != null) merged[name] = old[name]
      parts.push(merged)
    }
    await saveParts(env, parts, fetchedAt, [], readAt)
  }
  return { rejected, rejectedSamples }
}

export class BulkCatalogImporter extends DurableObject<Env> {
  async fetch(request: Request) {
    if (request.method === "GET")
      return Response.json(
        (await this.ctx.storage.get<BulkState>("job")) ?? initial(),
      )
    if (request.method !== "POST") return new Response(null, { status: 405 })
    // This object has no public route; only the scheduled Worker invokes it.
    if (!(await this.ctx.storage.getAlarm()))
      await this.ctx.storage.setAlarm(Date.now() + 1000)
    return Response.json({ scheduled: true })
  }

  async alarm() {
    const job = (await this.ctx.storage.get<BulkState>("job")) ?? initial()
    try {
      if (job.status === "importing") {
        // Watchdog survives eviction/crashes; committed chunks can be replayed.
        await this.ctx.storage.setAlarm(Date.now() + 60_000)
        const object = await this.env.TI_CATALOG.get(
          `${job.snapshot}/${job.nextChunk}.json`,
        )
        if (!object) throw new Error("Missing saved catalog chunk")
        const records = await object.json<Record<string, unknown>[]>()
        const result = await importCatalogChunk(
          this.env,
          records,
          job.fetchedAt!,
        )
        job.processed += records.length
        job.rejected += result.rejected
        job.rejectedSamples = [
          ...(job.rejectedSamples ?? []),
          ...result.rejectedSamples,
        ].slice(0, 20)
        job.nextChunk++
        delete job.lastError
        if (job.nextChunk === job.chunks) {
          job.status = "complete"
          job.completedAt = Date.now()
        }
        await this.ctx.storage.put("job", job)
        await this.ctx.storage.setAlarm(
          job.status === "complete"
            ? Math.max(Date.now() + 1000, job.nextDownloadAt)
            : Date.now() + 1000,
        )
        return
      }
      if (job.status === "downloading") {
        // A previous execution ended before validating the complete response.
        job.status = "error"
        job.lastError = "Catalog download interrupted; waiting before retry"
        job.nextDownloadAt = Math.max(
          Date.now() + 60_000,
          (job.fetchedAt ?? Date.now()) + FOUR_HOURS,
        )
        await this.ctx.storage.put("job", job)
      }
      if (job.nextDownloadAt > Date.now()) {
        await this.ctx.storage.setAlarm(job.nextDownloadAt)
        return
      }
      await this.download(job)
    } catch (error) {
      job.lastError =
        error instanceof Error ? error.message : "Bulk import failed"
      if (job.status !== "importing") {
        job.status = "error"
        job.nextDownloadAt = Date.now() + FOUR_HOURS + 60_000
      }
      await this.ctx.storage.put("job", job)
      await this.ctx.storage.setAlarm(
        job.status === "importing" ? Date.now() + 60_000 : job.nextDownloadAt,
      )
      console.warn("TI bulk catalog paused", job.lastError)
    }
  }

  private async download(job: BulkState) {
    // Remove only chunks belonging to this importer's previous snapshot.
    if (job.snapshot) {
      for (let i = 0; i < job.chunks; i += 100)
        await this.env.TI_CATALOG.delete(
          Array.from(
            { length: Math.min(100, job.chunks - i) },
            (_, n) => `${job.snapshot}/${i + n}.json`,
          ),
        )
    }
    Object.assign(job, initial(), {
      status: "downloading",
      snapshot: `catalog/${crypto.randomUUID()}`,
      fetchedAt: Date.now(),
      nextDownloadAt: Date.now() + DAY,
    })
    await this.ctx.storage.put("job", job)
    await this.ctx.storage.setAlarm(Date.now() + 15 * 60_000)
    if (!this.env.TI_GATEWAY)
      throw new Error("TI gateway is required for bulk downloads")
    const url = new URL("https://transact.ti.com/v2/store/products/catalog")
    url.searchParams.set("currency", this.env.TI_CURRENCY ?? "USD")
    url.searchParams.set("exclude-evms", "true")
    const response = await this.env.TI_GATEWAY.get(
      this.env.TI_GATEWAY.idFromName("ti-account"),
    ).fetch(url)
    if (!response.ok || !response.body) {
      await response.body?.cancel()
      throw new Error(`TI catalog HTTP ${response.status}`)
    }
    let records: Record<string, unknown>[] = []
    const flush = async () => {
      await this.env.TI_CATALOG.put(
        `${job.snapshot}/${job.chunks}.json`,
        JSON.stringify(records),
        { httpMetadata: { contentType: "application/json" } },
      )
      job.chunks++
      job.downloaded += records.length
      records = []
      await this.ctx.storage.put("job", job)
    }
    for await (const record of catalogRecords(response.body)) {
      records.push(record)
      if (records.length === CHUNK_SIZE) await flush()
    }
    if (records.length) await flush()
    if (!job.downloaded) throw new Error("TI returned an empty catalog")
    job.status = "importing"
    await this.ctx.storage.put("job", job)
    await this.ctx.storage.setAlarm(Date.now() + 1000)
  }
}
