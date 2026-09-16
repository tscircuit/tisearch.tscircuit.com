import {
  env,
  runInDurableObject,
  createExecutionContext,
  waitOnExecutionContext,
} from "cloudflare:test"
import { afterEach, expect, it, vi } from "vitest"
import { MetadataEnricher } from "../src/metadata-enricher"
import { TiClient } from "../src/ti-client"
import { enrichPart, updateMetadata } from "../src/metadata-store"
import { normalizeProduct } from "../src/normalize"
import { saveParts } from "../src/parts-store"
import { refreshInventory } from "../src/catalog-sync"
import {
  queryCompatibleCategory,
  queryCompatibleSearch,
} from "../src/jlc/catalog"
import worker from "../src/index"
import catalog from "./fixtures/catalog.json"
import parametrics from "./fixtures/parametrics.json"

const info = {
  Identifier: "TPS62160DSGR",
  GenericProductIdentifier: "TPS62160",
  ProductFamilyDescription: "DC/DC converters",
  Description: "TI verified description",
  PackageGroup: "WSON",
  PackageType: "DSG",
  Pin: 8,
  LifeCycleStatus: "ACTIVE",
  DatasheetUrl: "https://www.ti.com/lit/gpn/TPS62160",
  Price: { Value: 900 },
}
const seed = () =>
  saveParts(
    env,
    [normalizeProduct({ store: catalog.catalog[0] })],
    Date.now() - 2 * 86400_000,
  )
afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

it("enriches existing rows without inserting unknown parts or altering inventory and indexes the metadata", async () => {
  await seed()
  const before = await env.DB.prepare(
    "SELECT stock,unit_price,updated_at,first_seen_at FROM parts",
  ).first()
  await updateMetadata(env, [
    { pn: info.Identifier, information: info, parametrics },
    { pn: "UNKNOWN", information: { ...info, Identifier: "UNKNOWN" } },
  ])
  const row = await env.DB.prepare(
    "SELECT *,count(*) AS n FROM parts",
  ).first<any>()
  expect(row.n).toBe(1)
  expect(row).toMatchObject(before!)
  expect(row.information_status).toBe("available")
  expect(row.specification_status).toBe("available")
  const part = JSON.parse(row.raw_json)
  expect(part).toMatchObject({
    description: info.Description,
    package: "WSON",
    num_pins: 8,
    ti_family: info.ProductFamilyDescription,
    category_mapping_status: "mapped",
    ti_information: info,
  })
  expect(part.category_routes).toContain("/dcdc_converters/list")
  expect(part.price).not.toBe(900)
  expect(part.parameters["Vout (V)"]).toBe("0.9–6")
  expect(
    await env.DB.prepare(
      "SELECT count(*) AS n FROM parts_fts WHERE parts_fts MATCH 'verified'",
    ).first(),
  ).toEqual({ n: 1 })
  const result = await queryCompatibleCategory(
    env,
    "/boost_converters/list",
    {},
  )
  expect(JSON.stringify(result.data)).not.toContain(info.Identifier)
  await updateMetadata(env, [
    {
      pn: info.Identifier,
      parametrics: { ...parametrics, Topology: { Value: "Boost" } },
    },
  ])
  expect(
    JSON.stringify(
      (await queryCompatibleCategory(env, "/boost_converters/list", {})).data,
    ),
  ).toContain(info.Identifier)
})

it("retains enriched TI information and route mappings after an inventory refresh", async () => {
  await seed()
  await updateMetadata(env, [
    { pn: info.Identifier, information: info, parametrics },
  ])
  vi.stubGlobal(
    "fetch",
    vi
      .fn()
      .mockImplementation(async (input: string | URL) =>
        String(input).includes("oauth")
          ? Response.json({ access_token: "test", expires_in: 3600 })
          : Response.json({ ...catalog.catalog[0], quantity: 321 }),
      ),
  )
  await refreshInventory({ ...env, TI_GATEWAY: undefined })
  const row = await env.DB.prepare(
    "SELECT stock,raw_json FROM parts",
  ).first<any>()
  expect(row.stock).toBe(321)
  expect(JSON.parse(row.raw_json)).toMatchObject({
    ti_information: info,
    category_mapping_status: "mapped",
    stock: 321,
    description: info.Description,
  })
})

it("uses existing category rules and reports unknown families without guessing", () => {
  const old = normalizeProduct({ store: catalog.catalog[0] })
  const part = enrichPart(old, {
    ...info,
    ProductFamilyDescription: "Unknown TI family",
  })
  expect(part.category_routes).toEqual([])
  expect(part.category_mapping_status).toBe("unresolved")
  const arm = enrichPart(
    old,
    { ...info, ProductFamilyDescription: "General-purpose MCUs" },
    { CPU: { Value: "Cortex-M0+" } },
  )
  expect(arm.category_routes).toContain("/arm_processors/list")
  expect(arm.category_routes).not.toContain("/risc_v_processors/list")
})

it("resumes a saved information page with zero TI requests and advances only after applying it", async () => {
  await seed()
  await env.TI_CATALOG.put(
    "metadata/v1/pages/0.json",
    JSON.stringify({
      information: [info, { ...info, Identifier: "UNKNOWN" }],
      total: 2,
      nextOffset: null,
    }),
  )
  const fetcher = vi.fn()
  vi.stubGlobal("fetch", fetcher)
  const stub = env.METADATA_ENRICHMENT.get(
    env.METADATA_ENRICHMENT.newUniqueId(),
  )
  await runInDurableObject(stub, async (instance: MetadataEnricher, state) => {
    await instance.alarm()
    expect(await state.storage.get("job")).toMatchObject({
      phase: "mapping",
      pagesApplied: 1,
      requestsToday: 0,
    })
    expect(
      (await env.DB.prepare("SELECT count(*) AS n FROM parts").first<any>()).n,
    ).toBe(1)
    await state.storage.deleteAlarm()
  })
  expect(fetcher).not.toHaveBeenCalled()
})

it("backs off on throttling, retains its cursor, and enforces a persistent daily budget", async () => {
  const fetcher = vi.fn().mockImplementation(async (request: Request) =>
    request.url.includes("oauth")
      ? Response.json({ access_token: "token", expires_in: 3600 })
      : new Response(null, {
          status: 429,
          headers: { "retry-after": "3600" },
        }),
  )
  vi.stubGlobal("fetch", fetcher)
  const stub = env.METADATA_ENRICHMENT.get(
    env.METADATA_ENRICHMENT.newUniqueId(),
  )
  await runInDurableObject(stub, async (instance: MetadataEnricher, state) => {
    await instance.alarm()
    const job = await state.storage.get<any>("job")
    expect(job.page).toBe(0)
    expect(job.pagesApplied).toBe(0)
    expect(job.nextRunAt).toBeGreaterThan(Date.now() + 3500_000)
    const calls = fetcher.mock.calls.length
    await state.storage.put("job", {
      ...job,
      nextRunAt: 0,
      requestsToday: 1500,
    })
    await instance.alarm()
    expect(fetcher).toHaveBeenCalledTimes(calls)
    expect((await state.storage.get<any>("job")).nextRunAt).toBe(
      job.budgetResetAt,
    )
    await state.storage.deleteAlarm()
  })
})

it("disabled enrichment clears alarms and read-only status cannot start work", async () => {
  const stub = env.METADATA_ENRICHMENT.get(
    env.METADATA_ENRICHMENT.newUniqueId(),
  )
  await runInDurableObject(stub, async (_instance, state) => {
    const instance = new MetadataEnricher(state, {
      ...env,
      TI_METADATA_ENRICHMENT_ENABLED: "false",
    })
    await state.storage.setAlarm(Date.now() + 60000)
    await instance.alarm()
    expect(await state.storage.getAlarm()).toBeNull()
    await instance.fetch(
      new Request("https://metadata/tick", { method: "POST" }),
    )
    expect(await state.storage.getAlarm()).toBeNull()
  })
  const context = createExecutionContext()
  const response = await worker.fetch(
    new Request("https://test/api/enrichment/status"),
    env,
    context,
  )
  expect(response.headers.get("cache-control")).toBe("no-store")
  expect(await response.json()).toMatchObject({
    coverage: { total_parts: 0 },
    job: { phase: "catalog" },
  })
  await waitOnExecutionContext(context)
})

it("preserves metadata applied while the inventory request is in flight", async () => {
  await seed()
  vi.stubGlobal(
    "fetch",
    vi.fn().mockImplementation(async (input: string | URL) => {
      if (String(input).includes("oauth"))
        return Response.json({ access_token: "test", expires_in: 3600 })
      await updateMetadata(env, [
        { pn: info.Identifier, information: info, parametrics },
      ])
      return Response.json({ ...catalog.catalog[0], quantity: 987 })
    }),
  )
  await refreshInventory({ ...env, TI_GATEWAY: undefined })
  const row = await env.DB.prepare(
    "SELECT stock,description,raw_json FROM parts",
  ).first<any>()
  expect(row.stock).toBe(987)
  expect(row.description).toBe(info.Description)
  expect(JSON.parse(row.raw_json)).toMatchObject({
    ti_information: info,
    topology: "Buck",
  })
})

it("records missing TI metadata, finishes the specs pass, and stops its alarm", async () => {
  await seed()
  const fetcher = vi
    .fn()
    .mockImplementation(async (request: Request) =>
      request.url.includes("oauth")
        ? Response.json({ access_token: "test", expires_in: 3600 })
        : request.url.endsWith("/parametrics")
          ? Response.json(parametrics)
          : new Response(null, { status: 404 }),
    )
  vi.stubGlobal("fetch", fetcher)
  const stub = env.METADATA_ENRICHMENT.get(
    env.METADATA_ENRICHMENT.newUniqueId(),
  )
  await runInDurableObject(stub, async (instance: MetadataEnricher, state) => {
    const initial = await (
      await instance.fetch(new Request("https://metadata/status"))
    ).json<any>()
    await state.storage.put("job", { ...initial, phase: "missing" })
    for (let i = 0; i < 4; i++) {
      const job = await state.storage.get<any>("job")
      await state.storage.put("job", { ...job, nextRunAt: 0 })
      await instance.alarm()
    }
    expect(await state.storage.get("job")).toMatchObject({
      phase: "complete",
      targeted: 1,
      specsChecked: 1,
    })
    expect(await state.storage.getAlarm()).toBeNull()
    await instance.fetch(
      new Request("https://metadata/tick", { method: "POST" }),
    )
    expect(await state.storage.getAlarm()).toBeNull()
  })
  expect(
    await env.DB.prepare(
      "SELECT information_status,specification_status,count(*) AS n FROM parts",
    ).first(),
  ).toEqual({
    information_status: "unavailable",
    specification_status: "available",
    n: 1,
  })
})

it("prioritizes stocked mapped specifications while still resolving missing information", async () => {
  await seed()
  const visible = Array.from({ length: 5 }, (_, i) => ({
    ...normalizeProduct({
      store: {
        ...catalog.catalog[0],
        tiPartNumber: `VISIBLE${i}`,
        quantity: 100 - i,
      },
      information: { ProductFamilyDescription: "Precision DACs (≤10 MSPS)" },
    }),
    category_routes: ["/dacs/list"],
  }))
  await saveParts(env, visible)
  await env.DB.prepare(
    "UPDATE parts SET information_status='available' WHERE ti_product_number LIKE 'VISIBLE%'",
  ).run()
  const specifications = vi
    .spyOn(TiClient.prototype, "specifications")
    .mockResolvedValue({ "Number of DAC channels": { Value: "1" } })
  const information = vi
    .spyOn(TiClient.prototype, "information")
    .mockResolvedValue(info)
  const stub = env.METADATA_ENRICHMENT.get(
    env.METADATA_ENRICHMENT.newUniqueId(),
  )
  await runInDurableObject(stub, async (instance: MetadataEnricher, state) => {
    const initial = await (
      await instance.fetch(new Request("https://metadata/status"))
    ).json<any>()
    await state.storage.put("job", { ...initial, phase: "missing" })
    for (let i = 0; i < 5; i++) {
      const job = await state.storage.get<any>("job")
      await state.storage.put("job", { ...job, nextRunAt: 0 })
      await instance.alarm()
    }
    expect(specifications.mock.calls.map(([pn]) => pn)).toEqual([
      "VISIBLE0",
      "VISIBLE1",
      "VISIBLE2",
      "VISIBLE3",
    ])
    expect(information).toHaveBeenCalledWith(info.Identifier)
    expect(await state.storage.get("job")).toMatchObject({
      requestsToday: 5,
      specsChecked: 4,
      targeted: 1,
    })
    const job = await state.storage.get<any>("job")
    await state.storage.put("job", {
      ...job,
      requestsToday: 1500,
      nextRunAt: 0,
    })
    await instance.alarm()
    expect(specifications).toHaveBeenCalledTimes(4)
    expect((await state.storage.get<any>("job")).nextRunAt).toBe(
      job.budgetResetAt,
    )
    await state.storage.deleteAlarm()
  })
  expect(
    await env.DB.prepare("SELECT count(*) AS n FROM parts").first(),
  ).toEqual({ n: 6 })
})

it("does not report an empty TI spec response as available or discard saved ratings", async () => {
  await seed()
  await updateMetadata(env, [{ pn: info.Identifier, parametrics }])
  await updateMetadata(env, [{ pn: info.Identifier, parametrics: {} }])
  const row = await env.DB.prepare(
    "SELECT specification_status,raw_json FROM parts",
  ).first<any>()
  expect(row.specification_status).toBe("unavailable")
  expect(JSON.parse(row.raw_json).parametrics).toEqual(parametrics)
})

it("maps TI-only family names into existing general-list categories", async () => {
  await seed()
  await updateMetadata(env, [
    {
      pn: info.Identifier,
      information: { ...info, ProductFamilyDescription: "AC/DC controllers" },
    },
  ])
  const row = await env.DB.prepare("SELECT raw_json FROM parts").first<any>()
  expect(JSON.parse(row.raw_json).category_routes).toContain(
    "/components/list?subcategory_name=AC-DC+Controllers+%26+Regulators",
  )
  const result = await queryCompatibleSearch(
    env,
    { subcategory_name: "AC-DC Controllers & Regulators" },
    false,
  )
  expect(result.components).toHaveLength(1)
  expect(result.components[0].subcategory).toBe(
    "AC-DC Controllers & Regulators",
  )
})
