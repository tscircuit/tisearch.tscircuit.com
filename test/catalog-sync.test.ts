import { env } from "cloudflare:test"
import { afterEach, expect, it, vi } from "vitest"
import {
  discoverCatalog,
  refreshInventory,
  refreshSpecifications,
} from "../src/catalog-sync"
import { normalizeProduct } from "../src/normalize"
import { saveParts } from "../src/parts-store"
import { queryCatalog } from "../src/catalog"
import type { Env } from "../src/types"
import catalog from "./fixtures/catalog.json"
import parametrics from "./fixtures/parametrics.json"
const runtime = () =>
  ({
    ...env,
    TI_GATEWAY: undefined,
    TI_CLIENT_ID: "fixture",
    TI_CLIENT_SECRET: "fixture",
  }) as Env
afterEach(() => vi.unstubAllGlobals())
const respond = (url: URL) =>
  url.pathname.includes("oauth")
    ? Response.json({ access_token: "token", expires_in: 3600 })
    : url.pathname.endsWith("/parametrics")
      ? Response.json(parametrics)
      : Response.json(catalog.catalog[0])
it("discovers into D1 and retains its cursor when TI later throttles", async () => {
  const target = runtime()
  const fetcher = vi.fn().mockImplementation(async (input: string | URL) => {
    const url = new URL(String(input))
    return url.pathname === "/v1/products"
      ? Response.json({
          Content: [
            {
              Identifier: "TPS62160DSGR",
              ProductFamilyDescription: url.searchParams.get(
                "ProductFamilyDescription",
              ),
            },
          ],
          TotalElements: 200,
        })
      : respond(url)
  })
  vi.stubGlobal("fetch", fetcher)
  await discoverCatalog(target)
  const row = await env.DB.prepare(
    "SELECT * FROM catalog_sync WHERE last_success_at IS NOT NULL",
  ).first<any>()
  expect(row.next_offset).toBe(100)
  expect(
    fetcher.mock.calls.filter(([url]) => String(url).includes("/v2/store/")),
  ).toHaveLength(0)
  expect(
    (
      await env.DB.prepare(
        "SELECT count(*) AS n FROM catalog_pending",
      ).first<any>()
    ).n,
  ).toBe(1)
  await refreshInventory(target)
  expect(
    (
      await queryCatalog(
        target,
        new URL("https://test/api/search?q=TPS62160DSGR"),
      )
    ).components,
  ).toHaveLength(1)
  await env.DB.prepare("UPDATE catalog_sync SET next_sync_at=?")
    .bind(Date.now() + 86400_000)
    .run()
  await env.DB.prepare("UPDATE catalog_sync SET next_sync_at=0 WHERE family=?")
    .bind(row.family)
    .run()
  fetcher.mockImplementation(async (input: string | URL) =>
    String(input).includes("oauth")
      ? respond(new URL(String(input)))
      : new Response(null, { status: 429 }),
  )
  await discoverCatalog(target)
  const paused = await env.DB.prepare(
    "SELECT * FROM catalog_sync WHERE family=?",
  )
    .bind(row.family)
    .first<any>()
  expect(paused.next_offset).toBe(100)
  expect(paused.last_error).toBe("TI HTTP 429")
  expect(paused.next_sync_at).toBeGreaterThan(Date.now())
  expect(
    (
      await queryCatalog(
        target,
        new URL("https://test/api/search?q=TPS62160DSGR"),
      )
    ).components,
  ).toHaveLength(1)
})
it("refreshes only stale Store inventory and preserves indexed metadata", async () => {
  const target = runtime()
  const part = normalizeProduct({
    store: catalog.catalog[0],
    information: { ProductFamilyDescription: "DC/DC converters" },
    parametrics,
  })
  await saveParts(target, [part], Date.now() - 2 * 86400_000)
  const fetcher = vi
    .fn()
    .mockImplementation(async (input: string | URL) =>
      String(input).includes("oauth")
        ? respond(new URL(String(input)))
        : Response.json({ ...catalog.catalog[0], quantity: 999 }),
    )
  vi.stubGlobal("fetch", fetcher)
  await refreshInventory(target)
  expect(
    fetcher.mock.calls.some(([url]) => String(url).includes("/v1/products")),
  ).toBe(false)
  const result = await queryCatalog(
    target,
    new URL("https://test/api/search?q=TPS62160DSGR"),
  )
  expect(result.components[0]).toMatchObject({
    stock: 999,
    category: "DC/DC converters",
    output_voltage_max: 6,
  })
  const calls = fetcher.mock.calls.length
  await refreshInventory(target)
  expect(fetcher).toHaveBeenCalledTimes(calls)
})
it("retains inventory and does not advance its freshness on a failed refresh", async () => {
  const target = runtime()
  const time = Date.now() - 2 * 86400_000
  await saveParts(
    target,
    [normalizeProduct({ store: catalog.catalog[0] })],
    time,
  )
  vi.stubGlobal(
    "fetch",
    vi
      .fn()
      .mockImplementation(async (input: string | URL) =>
        String(input).includes("oauth")
          ? respond(new URL(String(input)))
          : new Response(null, { status: 429 }),
      ),
  )
  await refreshInventory(target)
  const row = await env.DB.prepare(
    "SELECT stock,updated_at FROM parts",
  ).first<any>()
  expect(row).toEqual({ stock: 1200, updated_at: time })
})

it("queues a full 100-product metadata page without inventory fan-out", async () => {
  const fetcher = vi.fn().mockImplementation(async (input: string | URL) =>
    String(input).includes("oauth")
      ? respond(new URL(String(input)))
      : Response.json({
          Content: Array.from({ length: 100 }, (_, i) => ({
            Identifier: `TEST${i}`,
          })),
          TotalElements: 200,
        }),
  )
  vi.stubGlobal("fetch", fetcher)
  await discoverCatalog(runtime())
  expect(fetcher).toHaveBeenCalledTimes(2)
  expect(
    (
      await env.DB.prepare(
        "SELECT count(*) AS n FROM catalog_pending",
      ).first<any>()
    ).n,
  ).toBe(100)
  expect(
    (await env.DB.prepare("SELECT count(*) AS n FROM parts").first<any>()).n,
  ).toBe(0)
})
it("enriches stored specs without advancing inventory freshness", async () => {
  const target = runtime()
  const timestamp = Date.now() - 2 * 86400_000
  await saveParts(
    target,
    [normalizeProduct({ store: catalog.catalog[0] })],
    timestamp,
  )
  const fetcher = vi
    .fn()
    .mockImplementation(async (input: string | URL) =>
      respond(new URL(String(input))),
    )
  vi.stubGlobal("fetch", fetcher)
  await refreshSpecifications(target)
  const row = await env.DB.prepare(
    "SELECT raw_json,updated_at,metadata_checked_at FROM parts",
  ).first<any>()
  expect(row.updated_at).toBe(timestamp)
  expect(row.metadata_checked_at).toBeGreaterThan(timestamp)
  expect(JSON.parse(row.raw_json).parameters["Vout (V)"]).toBe("0.9–6")
  expect(
    fetcher.mock.calls.some(([url]) => String(url).includes("/v2/store")),
  ).toBe(false)
  const calls = fetcher.mock.calls.length
  await refreshSpecifications(target)
  expect(fetcher).toHaveBeenCalledTimes(calls)
})
