import {
  createExecutionContext,
  env,
  waitOnExecutionContext,
} from "cloudflare:test"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import worker from "../src/index"
import { CATEGORY_DEFINITIONS } from "../src/categories"
import type { Env } from "../src/types"
import parametrics from "./fixtures/parametrics.json"
import catalog from "./fixtures/catalog.json"

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
const drain = async () => {
  for (const ctx of contexts.splice(0)) await waitOnExecutionContext(ctx)
}
const body = async (path: string) => (await (await get(path)).json()) as any
const respond = (url: string | URL) => {
  const u = new URL(url)
  if (u.pathname.endsWith("/parametrics")) return Response.json(parametrics)
  if (u.pathname.includes("oauth"))
    return Response.json({ access_token: "test-token", expires_in: 3600 })
  const pn = decodeURIComponent(u.pathname.split("/").at(-1) ?? "")
  const part = catalog.catalog.find((p) => p.tiPartNumber === pn)
  if (part) return Response.json(part)
  if (u.pathname === "/v2/store/products")
    return Response.json({
      content: catalog.catalog.slice(0, 2),
      totalElements: 2,
    })
  if (u.pathname === "/v1/products")
    return Response.json({
      Content: [
        {
          Identifier: "TPS62160DSGR",
          ProductFamilyDescription: "Buck converters",
          PackageType: "DSG",
        },
      ],
      TotalElements: 1,
    })
  return new Response(null, { status: 404 })
}
beforeEach(() => {
  runtime = {
    ...env,
    TI_GATEWAY: undefined,
    TI_CLIENT_ID: "fixture-id",
    TI_CLIENT_SECRET: "fixture-secret",
  }
  fetcher = vi
    .fn()
    .mockImplementation((url: string | URL) => Promise.resolve(respond(url)))
  vi.stubGlobal("fetch", fetcher)
})
afterEach(async () => {
  await drain()
  vi.unstubAllGlobals()
})

describe("reference-pattern Worker and D1 cache", () => {
  it("serves home, health, categories and an empty index without upstream calls", async () => {
    expect(await body("/health")).toEqual({ ok: true })
    expect(await (await get("/")).text()).toContain("TI Parts Engine")
    expect(
      (await body("/categories/list.json")).categories.length,
    ).toBeGreaterThan(5)
    expect(await body("/api/index/search?q=buck")).toMatchObject({
      components: [],
      partial: true,
      source: "ti-d1-index",
    })
    expect(fetcher).not.toHaveBeenCalled()
  })
  it("lists all grouped categories without fetching TI and routes each family with a five-product cap", async () => {
    const home = await (await get("/")).text()
    const listing = await body("/categories/list.json")
    expect(new Set(listing.categories.map((c: any) => c.group)).size).toBe(14)
    for (const category of CATEGORY_DEFINITIONS) {
      expect(home).toContain(`href="${category.path}"`)
      expect(listing.categories).toContainEqual({
        group: category.group,
        category: category.label,
        subcategory: category.query,
        path: category.path,
      })
    }
    expect(fetcher).not.toHaveBeenCalled()
    fetcher.mockImplementation((url: string | URL) =>
      Promise.resolve(
        new URL(url).pathname.includes("oauth")
          ? respond(url)
          : Response.json({ Content: [], TotalElements: 0 }),
      ),
    )
    for (const category of CATEGORY_DEFINITIONS) {
      const r = await get(`${category.path}.json`)
      expect(r.status).toBe(200)
      const result = (await r.json()) as any
      expect(result[category.responseKey]).toEqual([])
      expect(result.meta.limit).toBe(5)
      const upstream = fetcher.mock.calls
        .map(([url]) => new URL(url))
        .find(
          (url) =>
            url.searchParams.get("ProductFamilyDescription") === category.query,
        )!
      expect(upstream.pathname).toBe("/v1/products")
      expect(upstream.searchParams.get("ProductFamilyDescription")).toBe(
        category.query,
      )
      expect(upstream.searchParams.get("Size")).toBe("5")
    }
  })
  it("fetches on a cold search, then serves a cache hit and learns an FTS part", async () => {
    const first = await get("/api/search?q=TPS62160DSGR")
    expect(first.headers.get("x-cache")).toBe("MISS")
    expect((await first.json()) as any).toMatchObject({
      cached: false,
      source: "ti",
      total: 1,
      upstream_total: 1,
    })
    const calls = fetcher.mock.calls.length
    expect(
      (await get("/api/search?q=TPS62160DSGR")).headers.get("x-cache"),
    ).toBe("HIT")
    expect(fetcher).toHaveBeenCalledTimes(calls)
    expect((await body("/api/index/search?q=buck")).components[0].mfr).toBe(
      "TPS62160DSGR",
    )
    expect(
      (await body("/footprint_index/list.json")).footprints[0],
    ).toMatchObject({ package: "WSON (DSG)", tscircuit_accepts: false })
    const row = await env.DB.prepare(
      "SELECT response_json,request_json FROM search_cache",
    ).first<any>()
    expect(JSON.stringify(row)).not.toMatch(/fixture-secret|test-token/)
  })
  it("reuses TI data for public filters and preserves standard JSON and HTML controls", async () => {
    const initial = await body("/dcdc_converters/list.json")
    expect(initial.dcdc_converters[0]).toMatchObject({
      mfr: "TPS62160DSGR",
      output_voltage_max: 6,
      num_pins: 8,
    })
    const calls = fetcher.mock.calls.length
    const matched = await body(
      "/buck_converters/list.json?output_voltage_max=5",
    )
    expect(matched.buck_converters).toHaveLength(1)
    const excluded = await body("/boost_converters/list.json")
    expect(excluded.boost_converters).toHaveLength(0)
    expect(excluded.meta.cached).toBe(true)
    expect(fetcher).toHaveBeenCalledTimes(calls)
    const html = await (
      await get("/buck_converters/list?output_voltage_max=5")
    ).text()
    expect(html).toContain('name="output_voltage_max" value="5"')
    expect(html).toContain(".json?output_voltage_max=5")
    expect(fetcher).toHaveBeenCalledTimes(calls)
  })
  it("does not extend cached TI stock freshness when building a new D1 response", async () => {
    const expiry = Date.now() + 120_000
    fetcher.mockImplementation((url: string | URL) => {
      const response = respond(url)
      response.headers.set("x-ti-cache-expires-at", String(expiry))
      return Promise.resolve(response)
    })
    const result = await body("/api/search?q=TPS62160DSGR")
    expect(new Date(result.cache_expires_at).getTime()).toBe(expiry)
  })
  it("does not spend TI quota for crawlers, including stale-cache refreshes", async () => {
    const options = { headers: { "user-agent": "GPTBot/1.4" } }
    expect((await get("/dcdc_converters/list.json", options)).status).toBe(503)
    expect(fetcher).not.toHaveBeenCalled()
    await get("/dcdc_converters/list.json")
    const calls = fetcher.mock.calls.length
    await env.DB.prepare("UPDATE search_cache SET expires_at=0").run()
    expect(
      (await get("/dcdc_converters/list.json", options)).headers.get("x-cache"),
    ).toBe("STALE")
    await drain()
    expect(fetcher).toHaveBeenCalledTimes(calls)
    expect(await (await get("/robots.txt")).text()).toContain(
      "Disallow: /*/list",
    )
  })
  it("reuses compatible pages written before a cache-key change without contacting TI", async () => {
    await get("/dcdc_converters/list.json")
    await env.DB.prepare("UPDATE search_cache SET cache_key='legacy-key'").run()
    const calls = fetcher.mock.calls.length
    fetcher.mockResolvedValue(new Response(null, { status: 429 }))
    const response = await get("/dcdc_converters/list.json")
    expect(response.status).toBe(200)
    expect(response.headers.get("x-cache")).toBe("HIT")
    expect(((await response.json()) as any).dcdc_converters[0].mfr).toBe(
      "TPS62160DSGR",
    )
    expect(fetcher).toHaveBeenCalledTimes(calls)
  })
  it("never treats a legacy filtered page as a complete unfiltered result", async () => {
    await get("/dcdc_converters/list.json")
    await env.DB.prepare(
      `UPDATE search_cache SET cache_key='legacy-filtered', request_json=json_set(request_json,'$.inStock',json('true'))`,
    ).run()
    fetcher.mockResolvedValue(new Response(null, { status: 429 }))
    expect((await get("/dcdc_converters/list.json")).status).toBe(429)
  })
  it("keeps actual stock and prices when optional electrical enrichment is throttled", async () => {
    fetcher.mockImplementation((url: string | URL) =>
      Promise.resolve(
        String(url).endsWith("/parametrics")
          ? new Response(null, { status: 429 })
          : respond(url),
      ),
    )
    const response = await get("/dcdc_converters/list.json")
    expect(response.status).toBe(200)
    const result = (await response.json()) as any
    expect(result.dcdc_converters[0].stock).toBe(1200)
    expect(result.meta.partial).toBe(true)
    expect(result.meta.warnings[0]).toContain("electrical specifications")
    const html = await (await get("/dcdc_converters/list")).text()
    expect(html).toContain("temporarily incomplete")
  })
  it("uses the reference category-tile homepage without fetching parts", async () => {
    const html = await (await get("/")).text()
    expect(html).toContain("flex flex-wrap gap-4")
    expect(html).not.toContain("Recently retrieved parts")
    expect(html).not.toContain("<section")
    expect(fetcher).not.toHaveBeenCalled()
  })
  it("shares simultaneous cold refreshes within the Worker", async () => {
    const results = await Promise.all([
      get("/api/search?q=TPS62160DSGR"),
      get("/api/search?q=TPS62160DSGR"),
    ])
    expect(results.every((r) => r.status === 200)).toBe(true)
    expect(fetcher).toHaveBeenCalledTimes(3)
  })
  it("returns stale cache immediately and replaces it after background refresh", async () => {
    await get("/api/search?q=TPS62160DSGR")
    await env.DB.prepare("UPDATE search_cache SET expires_at=?")
      .bind(Date.now() - 1)
      .run()
    fetcher.mockImplementation((url: string | URL) =>
      Promise.resolve(
        String(url).includes("oauth")
          ? respond(url)
          : Response.json({ ...catalog.catalog[0], quantity: 999 }),
      ),
    )
    const stale = await get("/api/search?q=TPS62160DSGR")
    expect(stale.headers.get("x-cache")).toBe("STALE")
    expect(((await stale.json()) as any).components[0].stock).toBe(1200)
    await drain()
    expect((await body("/api/search?q=TPS62160DSGR")).components[0].stock).toBe(
      999,
    )
  })
  it("retains stale results when refresh is throttled", async () => {
    await get("/api/search?q=TPS62160DSGR")
    await env.DB.prepare("UPDATE search_cache SET expires_at=?")
      .bind(Date.now() - 1)
      .run()
    fetcher.mockResolvedValue(new Response("account details", { status: 429 }))
    expect(
      (await get("/api/search?q=TPS62160DSGR")).headers.get("x-cache"),
    ).toBe("STALE")
    await drain()
    expect(
      (
        await env.DB.prepare(
          "SELECT response_json FROM search_cache",
        ).first<any>()
      ).response_json,
    ).toContain("1200")
  })
  it("forwards Retry-After on a cold throttled response without caching the error", async () => {
    fetcher.mockImplementation((url: string | URL) =>
      Promise.resolve(
        String(url).includes("oauth")
          ? respond(url)
          : new Response("private body", {
              status: 429,
              headers: { "retry-after": "60" },
            }),
      ),
    )
    const r = await get("/api/search?q=TPS62160DSGR")
    expect(r.status).toBe(429)
    expect(r.headers.get("retry-after")).toBe("60")
    expect(r.headers.get("cache-control")).toBe("no-store")
    expect(await r.text()).not.toContain("private body")
    expect(
      await env.DB.prepare("SELECT * FROM search_cache").first(),
    ).toBeNull()
  })
  it("preserves category keys, discovered filters and JSON negotiation", async () => {
    const b = await body("/buck_converters/list.json?package=WSON")
    expect(b.buck_converters[0].mfr).toBe("TPS62160DSGR")
    expect(b.meta.filter_options.ParametricFilters.length).toBeGreaterThan(1)
    expect(
      (await get("/buck_converters/list?json=true")).headers.get(
        "content-type",
      ),
    ).toContain("application/json")
    expect(
      (
        await get("/buck_converters/list", {
          headers: { accept: "application/json" },
        })
      ).headers.get("content-type"),
    ).toContain("application/json")
  })
  it("learns out-of-stock updates even when filtered out of search results", async () => {
    await get("/api/search?q=TPS62160DSGR&in_stock=true")
    await env.DB.prepare(
      "UPDATE search_cache SET expires_at=0, stale_until=0",
    ).run()
    fetcher.mockImplementation((url: string | URL) =>
      Promise.resolve(
        String(url).endsWith("/parametrics")
          ? Response.json({})
          : Response.json({ ...catalog.catalog[0], quantity: 0 }),
      ),
    )
    expect(
      (await body("/api/search?q=TPS62160DSGR&in_stock=true")).components,
    ).toHaveLength(0)
    expect(
      (await body("/api/index/search?q=TPS62160DSGR")).components,
    ).toHaveLength(0)
  })
  it("keeps next-page links when all products on a family page are filtered out", async () => {
    fetcher.mockImplementation((url: string | URL) => {
      const u = new URL(url)
      return Promise.resolve(
        u.pathname === "/v1/products"
          ? Response.json({
              Content: [{ Identifier: "TPS62160DSGR" }],
              TotalElements: 2,
            })
          : u.pathname.includes("oauth")
            ? respond(url)
            : Response.json({ ...catalog.catalog[0], quantity: 0 }),
      )
    })
    const b = await body("/buck_converters/list.json?limit=1&in_stock=true")
    expect(b.meta).toMatchObject({
      total: 0,
      upstream_total: 2,
      next_offset: 1,
    })
    const html = await (
      await get("/buck_converters/list?limit=1&in_stock=true")
    ).text()
    expect(html).toContain("offset=1")
    expect(html).toContain("Next")
  })
  it("validates input and HTTP methods before upstream access", async () => {
    for (const path of [
      "/api/search",
      "/api/search?q=x&limit=NaN",
      "/api/index/search?q=x&limit=NaN",
    ])
      expect((await get(path)).status).toBe(400)
    expect((await get("/api/search", { method: "OPTIONS" })).status).toBe(204)
    expect((await get("/api/search", { method: "POST" })).status).toBe(405)
    expect((await get("/api/nope")).status).toBe(404)
    expect(fetcher).not.toHaveBeenCalled()
  })
  it("escapes HTML and renders the common table without an import workflow", async () => {
    const html = await (await get("/components/list?q=TPS62160DSGR")).text()
    expect(html).toContain("Price")
    expect(html).toContain("Texas Instruments")
    expect(html).not.toMatch(/CAD|TSX|jlcsearch|EasyEDA/)
    const escaped = await (
      await get(
        "/components/list?q=%3Cscript%3Ealert(1)%3C%2Fscript%3E&mode=family",
      )
    ).text()
    expect(escaped).not.toContain("<script>alert(1)</script>")
    expect(escaped).toContain("&lt;script&gt;")
  })
  it("cron refreshes popular expired queries and stops on reported quota", async () => {
    await get("/api/search?q=TPS62160DSGR")
    await get("/api/search?q=TPS62160DSGT")
    await env.DB.prepare("UPDATE search_cache SET expires_at=0").run()
    fetcher.mockImplementation((url: string | URL) =>
      Promise.resolve(
        Response.json(
          catalog.catalog.find((p) => String(url).includes(p.tiPartNumber))!,
          { headers: { "x-ratelimit-remaining": "10" } },
        ),
      ),
    )
    const previous = fetcher.mock.calls.length
    const ctx = createExecutionContext()
    await worker.scheduled({} as ScheduledController, runtime, ctx)
    await waitOnExecutionContext(ctx)
    expect(fetcher.mock.calls.length - previous).toBe(2)
    expect(
      (
        await env.DB.prepare(
          "SELECT count(*) as n FROM search_cache WHERE expires_at=0",
        ).first<any>()
      ).n,
    ).toBe(1)
  })
  it("rejects expired cache and excludes excessively old indexed stock", async () => {
    await get("/api/search?q=TPS62160DSGR")
    await env.DB.prepare(
      "UPDATE search_cache SET expires_at=0, stale_until=0",
    ).run()
    await env.DB.prepare("UPDATE parts SET updated_at=0").run()
    fetcher.mockResolvedValue(new Response(null, { status: 503 }))
    expect((await get("/api/search?q=TPS62160DSGR")).status).toBe(503)
    expect((await body("/api/index/search?q=buck")).components).toHaveLength(0)
  })
  it("bounds scheduled family refresh work within the invocation budget", async () => {
    await get("/api/search?q=Buck&mode=family")
    await get("/api/search?q=Boost&mode=family")
    await get("/api/search?q=Linear&mode=family")
    await env.DB.prepare("UPDATE search_cache SET expires_at=0").run()
    const ctx = createExecutionContext()
    await worker.scheduled({} as ScheduledController, runtime, ctx)
    await waitOnExecutionContext(ctx)
    expect(
      (
        await env.DB.prepare(
          "SELECT count(*) as n FROM search_cache WHERE expires_at=0",
        ).first<any>()
      ).n,
    ).toBe(2)
  })
})
