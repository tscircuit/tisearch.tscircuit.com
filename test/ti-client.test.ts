import { describe, expect, it, vi } from "vitest"
import { TiClient } from "../src/ti-client"
import { createSearchRequest } from "../src/search-request"
import type { Env } from "../src/types"
import catalog from "./fixtures/catalog.json"
import parametrics from "./fixtures/parametrics.json"

const env = { TI_CLIENT_ID: "a+b", TI_CLIENT_SECRET: "c&d" } as Env
const request = (query: string) =>
  createSearchRequest(new URL(`https://test/api/search?${query}`))
const auth = () =>
  Response.json({ access_token: "secret-token", expires_in: 3600 })
const mock = (...responses: Response[]) => {
  const queue = [auth(), ...responses]
  return vi
    .fn()
    .mockImplementation((url: string | URL) =>
      Promise.resolve(
        String(url).endsWith("/parametrics")
          ? Response.json({})
          : queue.shift()!,
      ),
    )
}

describe("TI on-demand adapter", () => {
  it("rejects OAuth and product redirects without forwarding credentials", async () => {
    for (const stage of ["oauth", "product"]) {
      const redirect = new Response(null, {
        status: 302,
        headers: { location: "https://example.com/redirect" },
      })
      const fetcher =
        stage === "oauth"
          ? vi.fn().mockResolvedValueOnce(redirect)
          : mock(redirect)
      await expect(
        new TiClient(env, fetcher).search(request("q=NE555P")),
      ).rejects.toMatchObject({ status: 502 })
      expect(fetcher).toHaveBeenCalledTimes(stage === "oauth" ? 1 : 2)
      for (const [, init] of fetcher.mock.calls) {
        expect(init.redirect).toBe("manual")
      }
    }
  })
  it("uses TI OAuth and encodes the exact /NOPB OPN", async () => {
    const fetcher = mock(Response.json(catalog.catalog[3]))
    const result = await new TiClient(env, fetcher).search(
      request("q=LP2982AIM5-3.3%2FNOPB"),
    )
    expect(result.response.products[0].store.tiPartNumber).toBe(
      "LP2982AIM5-3.3/NOPB",
    )
    expect(fetcher.mock.calls.map(([u]) => String(u))).toEqual([
      "https://transact.ti.com/v1/oauth/accesstoken",
      "https://transact.ti.com/v2/store/products/LP2982AIM5-3.3%2FNOPB?currency=USD&exclude-evms=true",
      "https://transact.ti.com/v1/products/LP2982AIM5-3.3%2FNOPB/parametrics",
    ])
    for (const [, init] of fetcher.mock.calls) {
      expect(new Headers(init.headers).get("user-agent")).toBe(
        "tisearch.tscircuit.com/0.1 (+https://tisearch.tscircuit.com)",
      )
    }
    expect(fetcher.mock.calls[0][1].body.toString()).toContain(
      "client_secret=c%26d",
    )
    expect(fetcher.mock.calls[1][1]).toMatchObject({
      redirect: "manual",
      headers: { authorization: "Bearer secret-token" },
    })
  })
  it("falls back only from an OPN 404 to TI's paginated GPN operation", async () => {
    const fetcher = mock(
      new Response(null, { status: 404 }),
      Response.json({ content: [catalog.catalog[1]], totalElements: 2 }),
    )
    const result = await new TiClient(env, fetcher).search(
      request("q=TPS62160&limit=1&offset=1"),
    )
    expect(String(fetcher.mock.calls[2][0])).toBe(
      "https://transact.ti.com/v2/store/products?currency=USD&exclude-evms=true&gpn=TPS62160&page=1&size=1",
    )
    expect(result.response).toMatchObject({
      upstreamTotal: 2,
      nextOffset: null,
    })
  })
  it("discovers a family with V1 filters, then gets actual inventory from V2", async () => {
    const fetcher = mock(
      Response.json({
        Content: [
          {
            Identifier: "TPS62160DSGR",
            InventoryStatus: "unsupported",
            ProductFamilyDescription: "Buck converters",
          },
        ],
        TotalElements: 3,
      }),
      Response.json({ ...catalog.catalog[0], quantity: 0 }),
    )
    const result = await new TiClient(env, fetcher).search(
      request(
        "q=Buck&mode=family&num_pins=8&package_code=DSG&lifecycle=ACTIVE&limit=1",
      ),
    )
    const url = new URL(fetcher.mock.calls[1][0])
    expect(url.pathname).toBe("/v1/products")
    expect(Object.fromEntries(url.searchParams)).toEqual({
      ProductFamilyDescription: "Buck",
      Page: "0",
      Size: "1",
      Pin: "8",
      LifeCycleStatus: "ACTIVE",
      PackageType: "DSG",
    })
    expect(result.response).toMatchObject({ nextOffset: 1, upstreamTotal: 3 })
    expect(result.response.products[0].store.quantity).toBe(0)
  })
  it("skips family products without a Store listing and preserves continuation", async () => {
    const fetcher = mock(
      Response.json({
        Content: [{ Identifier: "TPS62160DSGR" }],
        TotalElements: 2,
      }),
      new Response(null, { status: 404 }),
    )
    expect(
      (await new TiClient(env, fetcher).search(request("q=Buck&limit=1")))
        .response,
    ).toEqual({ products: [], upstreamTotal: 2, nextOffset: 1 })
  })
  it("enriches exact, base-part and family results from TI parametrics", async () => {
    for (const query of [
      "q=TPS62160DSGR",
      "q=TPS62160",
      "q=DC%2FDC&mode=family",
    ]) {
      const fetcher = vi.fn().mockImplementation(async (url: string | URL) => {
        const u = new URL(url)
        if (u.pathname.includes("oauth")) return auth()
        if (u.pathname.endsWith("/parametrics"))
          return Response.json(parametrics)
        if (u.pathname.endsWith("/TPS62160"))
          return new Response(null, { status: 404 })
        if (u.pathname === "/v2/store/products")
          return Response.json({
            content: [catalog.catalog[0]],
            totalElements: 1,
          })
        if (u.pathname === "/v1/products")
          return Response.json({
            Content: [{ Identifier: "TPS62160DSGR" }],
            TotalElements: 1,
          })
        return Response.json(catalog.catalog[0])
      })
      const result = await new TiClient(env, fetcher).search(request(query))
      expect(result.response.products[0].parametrics).toEqual(parametrics)
      expect(
        fetcher.mock.calls.filter(([u]) => String(u).endsWith("/parametrics")),
      ).toHaveLength(1)
    }
  })
  it.each([404, 429])(
    "handles parametric HTTP %s without retries",
    async (status) => {
      const fetcher = vi
        .fn()
        .mockImplementation(async (url: string | URL) =>
          String(url).includes("oauth")
            ? auth()
            : String(url).endsWith("/parametrics")
              ? new Response(null, { status, headers: { "retry-after": "60" } })
              : Response.json(catalog.catalog[0]),
        )
      const search = new TiClient(env, fetcher).search(
        request("q=TPS62160DSGR"),
      )
      if (status === 404)
        expect((await search).response.products[0].parametrics).toEqual({})
      else
        await expect(search).rejects.toMatchObject({
          status: 429,
          retryAfter: "60",
        })
      expect(fetcher).toHaveBeenCalledTimes(3)
    },
  )
  it("reuses and refreshes OAuth tokens", async () => {
    let now = 0
    const fetcher = vi
      .fn()
      .mockImplementation((url: string | URL) =>
        Promise.resolve(
          String(url).includes("oauth")
            ? auth()
            : Response.json(catalog.catalog[0]),
        ),
      )
    const client = new TiClient(env, fetcher, () => now)
    await client.search(request("q=TPS62160DSGR"))
    await client.search(request("q=TPS62160DSGR"))
    expect(
      fetcher.mock.calls.filter(([url]) => String(url).includes("oauth")),
    ).toHaveLength(1)
    now = 3600000
    await client.search(request("q=TPS62160DSGR"))
    expect(
      fetcher.mock.calls.filter(([url]) => String(url).includes("oauth")),
    ).toHaveLength(2)
  })
  it.each([401, 403, 429, 500])(
    "does not retry or fall back on HTTP %s",
    async (status) => {
      const fetcher = mock(
        new Response("private upstream data", {
          status,
          headers: { "retry-after": "60" },
        }),
      )
      await expect(
        new TiClient(env, fetcher).search(request("q=TPS62160DSGR")),
      ).rejects.toMatchObject({
        status,
        retryAfter: "60",
        message: "TI product request failed",
      })
      expect(fetcher).toHaveBeenCalledTimes(2)
    },
  )
  it("rejects a different OPN or base-part family", async () => {
    const f = mock(Response.json(catalog.catalog[1]))
    await expect(
      new TiClient(env, f).search(request("q=TPS62160DSGR")),
    ).rejects.toThrow("different orderable")
    const g = mock(
      new Response(null, { status: 404 }),
      Response.json({ content: [catalog.catalog[3]], totalElements: 1 }),
    )
    await expect(
      new TiClient(env, g).search(request("q=TPS62160")),
    ).rejects.toThrow("different base")
  })
  it("sanitizes malformed authentication and product bodies", async () => {
    const f = vi.fn().mockResolvedValue(new Response("private credentials"))
    await expect(
      new TiClient(env, f).search(request("q=TPS62160")),
    ).rejects.toThrow("Invalid TI OAuth JSON")
    const g = mock(new Response("private account details"))
    await expect(
      new TiClient(env, g).search(request("q=TPS62160")),
    ).rejects.toThrow("Invalid TI product JSON")
  })
  it("refuses oversized discovery pages before issuing Store lookups", async () => {
    const f = mock(
      Response.json({
        Content: [
          { Identifier: "TPS62160DSGR" },
          { Identifier: "TPS62160DSGT" },
        ],
        TotalElements: 2,
      }),
    )
    await expect(
      new TiClient(env, f).search(request("q=Buck&limit=1")),
    ).rejects.toThrow("Invalid TI product information page")
    expect(f).toHaveBeenCalledTimes(2)
  })
  it("uses configured currency and reports remaining quota", async () => {
    const f = mock(
      Response.json(catalog.catalog[2], {
        headers: { "x-ratelimit-remaining": "12" },
      }),
    )
    const result = await new TiClient({ ...env, TI_CURRENCY: "EUR" }, f).search(
      request("q=LM358DR"),
    )
    expect(String(f.mock.calls[1][0])).toContain("currency=EUR")
    expect(result.rateLimitRemaining).toBe(12)
  })
})
