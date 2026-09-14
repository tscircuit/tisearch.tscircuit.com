import {
  createExecutionContext,
  env,
  waitOnExecutionContext,
} from "cloudflare:test"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import worker from "../src/index"
import { CATEGORY_DEFINITIONS } from "../src/categories"
import { normalizeProduct } from "../src/normalize"
import { saveParts } from "../src/parts-store"
import type { Env } from "../src/types"
import catalog from "./fixtures/catalog.json"
import parametrics from "./fixtures/parametrics.json"

let runtime: Env
let fetcher: ReturnType<typeof vi.fn>
const contexts: ExecutionContext[] = []
const get = async (path: string, options?: RequestInit) => {
  const ctx = createExecutionContext()
  contexts.push(ctx)
  return worker.fetch(
    new Request(`https://example.test${path}`, options),
    runtime,
    ctx,
  )
}
const body = async (path: string) => (await (await get(path)).json()) as any
const seed = async (count = 1, updatedAt = Date.now()) => {
  await saveParts(
    runtime,
    Array.from({ length: count }, (_, i) =>
      normalizeProduct({
        store: {
          ...catalog.catalog[0],
          tiPartNumber: `TEST${i}`,
          genericPartNumber: "TEST",
          quantity: count - i,
        },
        information: {
          ProductFamilyDescription: "DC/DC converters",
          PackageType: "DSG",
        },
        parametrics:
          i === count - 1
            ? {
                ...parametrics,
                Vout: { Unit: "V", Range: { Min: "1", Max: "20" } },
              }
            : parametrics,
      }),
    ),
    updatedAt,
  )
}
beforeEach(() => {
  runtime = {
    ...env,
    TI_CLIENT_ID: "",
    TI_CLIENT_SECRET: "",
    TI_GATEWAY: undefined,
  }
  fetcher = vi
    .fn()
    .mockRejectedValue(new Error("Public requests must never contact TI"))
  vi.stubGlobal("fetch", fetcher)
})
afterEach(async () => {
  for (const ctx of contexts.splice(0)) await waitOnExecutionContext(ctx)
  expect(fetcher).not.toHaveBeenCalled()
  vi.unstubAllGlobals()
})

describe("D1-only public catalog", () => {
  it("serves every category including empty ones while TI is unavailable", async () => {
    for (const category of CATEGORY_DEFINITIONS) {
      const response = await get(`${category.path}.json`)
      expect(response.status).toBe(200)
      expect(((await response.json()) as any)[category.responseKey]).toEqual([])
    }
    expect((await get("/api/search?q=MISSING123")).status).toBe(200)
    expect((await get("/components/list")).status).toBe(200)
  })
  it("shows all stored parts on one page, even with old pagination parameters", async () => {
    await seed(45)
    const result = await body("/dcdc_converters/list.json?limit=5&offset=5")
    expect(result.dcdc_converters).toHaveLength(45)
    expect(result.meta).toMatchObject({
      total: 45,
      filter_scope: "catalog",
      next_offset: null,
      offset: 0,
      upstream_total: null,
      source: "ti-d1-index",
    })
    const html = await (
      await get("/dcdc_converters/list?limit=5&offset=5")
    ).text()
    expect(html).toContain("TEST0")
    expect(html).toContain("TEST44")
    expect(html).not.toContain(">Next</a>")
    expect(html).not.toContain(">Previous</a>")
    expect(html).not.toContain("Results per page")
  })
  it("filters the full category, including matches beyond the former page boundary", async () => {
    await seed(45)
    const result = await body(
      "/dcdc_converters/list.json?output_voltage_max=12",
    )
    expect(result.dcdc_converters.map((p: any) => p.mfr)).toEqual(["TEST44"])
    expect(
      (await body("/dcdc_converters/list.json?num_pins=16")).dcdc_converters,
    ).toHaveLength(0)
    expect(
      (await body("/boost_converters/list.json")).boost_converters,
    ).toHaveLength(0)
  })
  it("uses full-text, exact part, base-part and category indexes", async () => {
    await seed(3)
    expect(
      (await body("/components/list.json?search=buck")).components,
    ).toHaveLength(3)
    expect(
      (await body("/api/search?q=TEST1")).components.map((p: any) => p.mfr),
    ).toEqual(["TEST1"])
    expect(
      (await body("/components/list.json?subcategory_name=dcdc+converters"))
        .components,
    ).toHaveLength(3)
    const more = normalizeProduct({ store: catalog.catalog[0], parametrics })
    await saveParts(runtime, [more])
    expect((await body("/api/search?q=TPS62160")).components[0].mfr).toBe(
      "TPS62160DSGR",
    )
    const indexes = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type='index'",
    ).all<{ name: string }>()
    expect(indexes.results.map((row) => row.name)).toContain(
      "parts_category_nocase_idx",
    )
    expect(
      (await body("/api/index/search?q=buck&limit=1")).components,
    ).toHaveLength(1)
  })
  it("keeps stored parts available after inventory becomes stale and never queues a refresh", async () => {
    await seed(2, Date.now() - 2 * 86400_000)
    const result = await body("/dcdc_converters/list.json")
    expect(result.dcdc_converters).toHaveLength(2)
    expect(result.meta.stale).toBe(true)
    const html = await (await get("/dcdc_converters/list")).text()
    expect(html).toContain("Inventory refresh is pending")
  })
  it("serves crawlers, directories and JSON negotiation from D1", async () => {
    await seed()
    expect(
      (
        await get("/dcdc_converters/list", {
          headers: { "user-agent": "GPTBot/1.4" },
        })
      ).status,
    ).toBe(200)
    expect(
      (await get("/dcdc_converters/list?json=true")).headers.get(
        "content-type",
      ),
    ).toContain("application/json")
    expect(
      (
        await get("/dcdc_converters/list", {
          headers: { accept: "application/json" },
        })
      ).headers.get("content-type"),
    ).toContain("application/json")
    expect((await body("/categories/list.json")).categories).toHaveLength(66)
    expect(
      (await body("/package_index/list.json")).footprints[0].num_components,
    ).toBe(1)
    expect(await body("/health")).toEqual({ ok: true })
  })
  it("validates filters, escapes HTML, and preserves HTTP method handling", async () => {
    expect((await get("/api/search?q=x&num_pins=-1")).status).toBe(400)
    expect((await get("/api/search?q=x&output_voltage_max=NaN")).status).toBe(
      400,
    )
    expect((await get("/api/index/search?q=x&limit=NaN")).status).toBe(400)
    expect((await get("/api/search", { method: "OPTIONS" })).status).toBe(204)
    expect((await get("/api/search", { method: "POST" })).status).toBe(405)
    expect((await get("/api/nope")).status).toBe(404)
    const html = await (
      await get("/components/list?search=%3Cscript%3Ealert(1)%3C%2Fscript%3E")
    ).text()
    expect(html).not.toContain("<script>alert(1)</script>")
    expect(html).toContain("&lt;script&gt;")
  })
})
