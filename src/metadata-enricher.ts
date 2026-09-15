import { DurableObject } from "cloudflare:workers"
import { TiClient, TiApiError } from "./ti-client"
import { updateMetadata } from "./metadata-store"
import type { Env } from "./types"

const DAY = 86400_000
// Reserve room for stock/specification maintenance and other account clients.
const DAILY_REQUESTS = 1500
interface Job {
  phase: "catalog" | "missing" | "specifications" | "complete"
  page: number
  total?: number
  pagesApplied: number
  targeted: number
  specsChecked: number
  requestsToday: number
  budgetResetAt: number
  nextRunAt: number | null
  lastError?: string
  completedAt?: number
}
const initial = (): Job => ({
  phase: "catalog",
  page: 0,
  pagesApplied: 0,
  targeted: 0,
  specsChecked: 0,
  requestsToday: 0,
  budgetResetAt: Date.now() + DAY,
  nextRunAt: null,
})

export class MetadataEnricher extends DurableObject<Env> {
  private client() {
    if (!this.env.TI_GATEWAY)
      throw new Error("TI gateway is required for enrichment")
    return new TiClient(this.env, (input, init) =>
      this.env
        .TI_GATEWAY!.get(this.env.TI_GATEWAY!.idFromName("ti-account"))
        .fetch(input, init),
    )
  }
  async fetch(request: Request) {
    const job = (await this.ctx.storage.get<Job>("job")) ?? initial()
    const enabled = this.env.TI_METADATA_ENRICHMENT_ENABLED === "true"
    if (request.method === "GET")
      return Response.json({
        ...job,
        enabled,
        dailyRequestBudget: DAILY_REQUESTS,
      })
    if (request.method !== "POST") return new Response(null, { status: 405 })
    if (!enabled || job.phase === "complete") {
      await this.ctx.storage.deleteAlarm()
      return Response.json({ scheduled: false, enabled, phase: job.phase })
    }
    if (!(await this.ctx.storage.getAlarm()))
      await this.ctx.storage.setAlarm(
        Math.max(Date.now() + 1000, job.nextRunAt ?? 0),
      )
    return Response.json({ scheduled: true })
  }
  async alarm() {
    if (this.env.TI_METADATA_ENRICHMENT_ENABLED !== "true") {
      await this.ctx.storage.deleteAlarm()
      return
    }
    const job = (await this.ctx.storage.get<Job>("job")) ?? initial()
    if (job.phase === "complete") {
      await this.ctx.storage.deleteAlarm()
      return
    }
    if ((job.nextRunAt ?? 0) > Date.now()) {
      await this.ctx.storage.setAlarm(job.nextRunAt!)
      return
    }
    if (job.budgetResetAt <= Date.now()) {
      job.requestsToday = 0
      job.budgetResetAt = Date.now() + DAY
    }
    // Watchdog: retries use a saved R2 page or the gateway's cached response.
    await this.ctx.storage.setAlarm(Date.now() + 120_000)
    const reserve = async () => {
      if (job.requestsToday >= DAILY_REQUESTS) {
        job.nextRunAt = job.budgetResetAt
        throw new Error("Daily enrichment request budget reached")
      }
      job.requestsToday++
      await this.ctx.storage.put("job", job)
    }
    try {
      if (job.phase === "catalog") {
        const key = `metadata/v1/pages/${job.page}.json`
        const saved = await this.env.TI_CATALOG.get(key)
        let page: Awaited<ReturnType<TiClient["discover"]>>
        if (saved) page = await saved.json()
        else {
          await reserve()
          page = await this.client().discover(undefined, job.page * 100)
          await this.env.TI_CATALOG.put(key, JSON.stringify(page), {
            httpMetadata: { contentType: "application/json" },
          })
        }
        await updateMetadata(
          this.env,
          page.information.map((information) => ({
            pn: String(information.Identifier),
            information,
          })),
        )
        job.total = page.total
        job.pagesApplied++
        if (page.nextOffset === null) job.phase = "missing"
        else job.page = page.nextOffset / 100
      } else {
        const information = job.phase === "missing"
        const row = await this.env.DB.prepare(
          `SELECT ti_product_number FROM parts WHERE ${information ? "information_status" : "specification_status"}='pending' ORDER BY ti_product_number LIMIT 1`,
        ).first<{ ti_product_number: string }>()
        if (!row) {
          job.phase = information ? "specifications" : "complete"
          if (job.phase === "complete") job.completedAt = Date.now()
        } else {
          await reserve()
          try {
            const record = information
              ? {
                  pn: row.ti_product_number,
                  information: await this.client().information(
                    row.ti_product_number,
                  ),
                }
              : {
                  pn: row.ti_product_number,
                  parametrics: await this.client().specifications(
                    row.ti_product_number,
                  ),
                }
            await updateMetadata(this.env, [record])
          } catch (error) {
            if (!(error instanceof TiApiError) || error.status !== 404)
              throw error
            await this.env.DB.prepare(
              `UPDATE parts SET ${information ? "information_status='unavailable',information_checked_at" : "specification_status='unavailable',metadata_checked_at"}=? WHERE ti_product_number=?`,
            )
              .bind(Date.now(), row.ti_product_number)
              .run()
          }
          if (information) job.targeted++
          else job.specsChecked++
        }
      }
      delete job.lastError
      job.nextRunAt = job.phase === "complete" ? null : Date.now() + 2000
    } catch (error) {
      job.lastError =
        error instanceof Error ? error.message : "Metadata enrichment failed"
      const retry = error instanceof TiApiError ? error.retryAfter : null
      const delay =
        retry && /^\d+$/.test(retry)
          ? Number(retry) * 1000
          : retry
            ? Date.parse(retry) - Date.now()
            : 0
      job.nextRunAt = Math.max(
        job.nextRunAt ?? 0,
        Date.now() + Math.max(60_000, Number.isFinite(delay) ? delay : 0),
      )
      if (error instanceof TiApiError && [401, 403].includes(error.status))
        job.nextRunAt = Date.now() + DAY
      console.warn("TI metadata enrichment waiting", job.lastError)
    }
    await this.ctx.storage.put("job", job)
    if (job.nextRunAt) await this.ctx.storage.setAlarm(job.nextRunAt)
    else await this.ctx.storage.deleteAlarm()
  }
}
