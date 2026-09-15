import { env, runInDurableObject } from "cloudflare:test"
import { afterEach, expect, it, vi } from "vitest"
import { catalogRecords } from "../src/catalog-stream"
import { BulkCatalogImporter, importCatalogChunk } from "../src/bulk-catalog"
import { TiGateway } from "../src/ti-gateway"
import { normalizeProduct } from "../src/normalize"
import { saveParts } from "../src/parts-store"
import catalog from "./fixtures/catalog.json"

const stream = (text: string, size = 7) => {
  const bytes = new TextEncoder().encode(text)
  let offset = 0
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset >= bytes.length) return controller.close()
      controller.enqueue(bytes.slice(offset, (offset += size)))
    },
  })
}
const collect = async (text: string) => {
  const rows = []
  for await (const row of catalogRecords(stream(text))) rows.push(row)
  return rows
}
afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

it("streams nested records across UTF-8/escape boundaries and rejects incomplete JSON", async () => {
  const record = {
    tiPartNumber: "TEST",
    description: 'µC "quoted" \\ [}]',
    pricing: [{ x: { v: 1 } }],
  }
  expect(await collect(JSON.stringify({ catalog: [record, record] }))).toEqual([
    record,
    record,
  ])
  for (const text of [
    '{"catalog":[{}',
    '{"catalog":[{},]}',
    '{"catalog":[{}]}junk',
    '{"other":[]}',
  ])
    await expect(collect(text)).rejects.toThrow()
})

it("replays inventory chunks without erasing metadata or overwriting newer inventory", async () => {
  const old = normalizeProduct({
    store: catalog.catalog[0],
    information: { ProductFamilyDescription: "DC/DC converters" },
    parametrics: { Topology: { Value: "Buck" } },
  })
  await saveParts(env, [old], 100)
  await importCatalogChunk(env, [{ ...catalog.catalog[0], quantity: 123 }], 200)
  await importCatalogChunk(env, [{ ...catalog.catalog[0], quantity: 123 }], 200)
  const row = await env.DB.prepare(
    "SELECT raw_json,first_seen_at FROM parts",
  ).first<any>()
  expect(row.first_seen_at).toBe(100)
  expect(JSON.parse(row.raw_json)).toMatchObject({
    stock: 123,
    category: "DC/DC converters",
    topology: "Buck",
    parametrics: { Topology: { Value: "Buck" } },
  })
  await importCatalogChunk(env, [{ ...catalog.catalog[0], quantity: 1 }], 150)
  expect(
    (await env.DB.prepare("SELECT stock FROM parts").first<any>()).stock,
  ).toBe(123)
  const variant = { ...catalog.catalog[0], tiPartNumber: "TPS62160DSGT" }
  const result = await importCatalogChunk(
    env,
    [variant, { tiPartNumber: "BAD" }],
    200,
  )
  expect(result.rejected).toBe(1)
  expect(
    (
      await env.DB.prepare(
        "SELECT category FROM parts WHERE ti_product_number='TPS62160DSGT'",
      ).first<any>()
    ).category,
  ).toBe("DC/DC converters")
})

it("saves the bulk response once and resumes imports from R2 without another TI request", async () => {
  const rows = Array.from({ length: 501 }, (_, i) => ({
    ...catalog.catalog[0],
    tiPartNumber: `TEST${i}`,
  }))
  const fetcher = vi
    .fn()
    .mockImplementation(async (request: Request) =>
      request.url.includes("oauth")
        ? Response.json({ access_token: "test", expires_in: 3600 })
        : new Response(stream(JSON.stringify({ catalog: rows }), 997)),
    )
  vi.stubGlobal("fetch", fetcher)
  const stub = env.BULK_IMPORT.get(env.BULK_IMPORT.newUniqueId())
  await runInDurableObject(
    stub,
    async (instance: BulkCatalogImporter, state) => {
      await instance.alarm()
      expect(await state.storage.get("job")).toMatchObject({
        status: "importing",
        downloaded: 501,
        chunks: 2,
        nextChunk: 0,
      })
      expect(
        (await env.DB.prepare("SELECT count(*) AS n FROM parts").first<any>())
          .n,
      ).toBe(0)
      await instance.alarm()
      expect(await state.storage.get("job")).toMatchObject({
        status: "importing",
        processed: 500,
        nextChunk: 1,
      })
      // Resume from persisted state, not a retained response or an in-memory cursor.
      await instance.alarm()
      expect(await state.storage.get("job")).toMatchObject({
        status: "complete",
        processed: 501,
        rejected: 0,
      })
      await instance.alarm()
      expect(fetcher).toHaveBeenCalledTimes(2) // OAuth plus one full catalog request.
      expect(
        (await env.DB.prepare("SELECT count(*) AS n FROM parts").first<any>())
          .n,
      ).toBe(501)
      await state.storage.deleteAlarm()
    },
  )
})

it("reserves the catalog quota across query variants even if a download fails", async () => {
  const stub = env.TI_GATEWAY!.get(env.TI_GATEWAY!.newUniqueId())
  await runInDurableObject(stub, async (instance: TiGateway, state) => {
    const fetcher = vi
      .fn()
      .mockResolvedValue(new Response(null, { status: 503 }))
    vi.stubGlobal("fetch", fetcher)
    const request = (currency: string) =>
      new Request(
        `https://transact.ti.com/v2/store/products/catalog?currency=${currency}`,
        { headers: { authorization: "Bearer test" } },
      )
    expect((await instance.fetch(request("USD"))).status).toBe(503)
    expect((await instance.fetch(request("EUR"))).status).toBe(429)
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(
      await state.storage.get<number>("next-catalog-request"),
    ).toBeGreaterThan(Date.now() + 4 * 3600_000)
    expect((await state.storage.list({ prefix: "response:" })).size).toBe(0)
    expect(await state.storage.get("cooldown:store")).toBeUndefined()
  })
})

it("does not publish a truncated snapshot to D1", async () => {
  vi.stubGlobal(
    "fetch",
    vi
      .fn()
      .mockImplementation(async (request: Request) =>
        request.url.includes("oauth")
          ? Response.json({ access_token: "test", expires_in: 3600 })
          : new Response(stream('{"catalog":[{}')),
      ),
  )
  const stub = env.BULK_IMPORT.get(env.BULK_IMPORT.newUniqueId())
  await runInDurableObject(
    stub,
    async (instance: BulkCatalogImporter, state) => {
      await instance.alarm()
      expect(await state.storage.get("job")).toMatchObject({
        status: "error",
        processed: 0,
      })
      expect(
        (await env.DB.prepare("SELECT count(*) AS n FROM parts").first<any>())
          .n,
      ).toBe(0)
      await state.storage.deleteAlarm()
    },
  )
})

it("streams every matching part across D1 batches and applies API limits globally", async () => {
  const records = Array.from({ length: 1103 }, (_, i) => ({
    ...catalog.catalog[0],
    tiPartNumber: `PART${i}`,
    quantity: 42,
    pinCount: i < 1100 ? 8 : 4,
  }))
  await importCatalogChunk(env, records, Date.now())
  const { default: worker } = await import("../src/index")
  const { createExecutionContext } = await import("cloudflare:test")
  const get = (path: string) =>
    worker.fetch(
      new Request(`https://test${path}`),
      env,
      createExecutionContext(),
    )
  vi.stubGlobal(
    "fetch",
    vi.fn().mockRejectedValue(new Error("No upstream calls during browsing")),
  )
  const all = await (await get("/components/list.json")).json<any>()
  expect(all.components).toHaveLength(1103)
  expect(new Set(all.components.map((p: any) => p.mfr)).size).toBe(1103)
  expect(all.components.map((p: any) => p.mfr)).toEqual(
    records.map((p) => p.tiPartNumber).sort(),
  )
  expect(
    (await (await get("/api/search?limit=550")).json<any>()).components,
  ).toHaveLength(550)
  expect(
    (await (await get("/components/list.json?num_pins=4")).json<any>())
      .components,
  ).toHaveLength(3)
  const html = await (await get("/components/list")).text()
  expect([...html.matchAll(/<tr>/g)]).toHaveLength(1104)
  expect(html).not.toContain(">Next</a>")
  expect(fetch).not.toHaveBeenCalled()
})

it("imports TI orderable names containing spaces and encodes their product URLs", async () => {
  const record = {
    ...catalog.catalog[0],
    tiPartNumber: "LM109K STEEL/NOPB",
    genericPartNumber: "LM109",
    buyNowUrl: undefined,
  }
  expect((await importCatalogChunk(env, [record], Date.now())).rejected).toBe(0)
  const part = JSON.parse(
    (await env.DB.prepare("SELECT raw_json FROM parts").first<any>()).raw_json,
  )
  expect(part.ti_product_number).toBe("LM109K STEEL/NOPB")
  expect(part.product_url).toBe(
    "https://www.ti.com/product/LM109/part-details/LM109K%20STEEL%2FNOPB",
  )
})

it("disabled population cancels saved alarms and cannot be restarted by a tick", async () => {
  const target = { ...env, TI_CATALOG_POPULATION_ENABLED: "false" }
  const fetcher = vi.fn()
  vi.stubGlobal("fetch", fetcher)
  const stub = env.BULK_IMPORT.get(env.BULK_IMPORT.newUniqueId())
  await runInDurableObject(stub, async (_instance, state) => {
    const paused = new BulkCatalogImporter(state, target)
    const job = {
      status: "importing",
      processed: 500,
      nextChunk: 1,
      chunks: 2,
      nextDownloadAt: Date.now() + 86400_000,
    }
    await state.storage.put("job", job)
    await state.storage.setAlarm(Date.now() + 3600_000)
    await paused.alarm()
    expect(await state.storage.getAlarm()).toBeNull()
    expect(await state.storage.get("job")).toEqual(job)
    expect(
      await (
        await paused.fetch(new Request("https://bulk/tick", { method: "POST" }))
      ).json(),
    ).toEqual({ scheduled: false, populationEnabled: false, alarm: null })
    expect(
      await (await paused.fetch(new Request("https://bulk/status"))).json(),
    ).toMatchObject({
      populationEnabled: false,
      nextDownloadAt: null,
      processed: 500,
    })
  })
  await expect(
    importCatalogChunk(target, [catalog.catalog[0]], Date.now()),
  ).rejects.toThrow("Catalog population is disabled")
  expect(fetcher).not.toHaveBeenCalled()
})
