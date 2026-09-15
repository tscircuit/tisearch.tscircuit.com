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
