import { env, runInDurableObject } from "cloudflare:test"
import { afterEach, describe, expect, it, vi } from "vitest"
import { TiGateway } from "../src/ti-gateway"

const stub = () => env.TI_GATEWAY!.get(env.TI_GATEWAY!.newUniqueId())
const url =
  "https://transact.ti.com/v1/products?ProductFamilyDescription=Battery+fuel+gauges&Page=0&Size=5"
afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe("shared TI gateway", () => {
  it("paces requests across URLs and serves cached responses without upstream calls", async () => {
    const gateway = stub()
    await runInDurableObject(gateway, async (instance: TiGateway, state) => {
      // Advance a logical clock only when the gateway requests a delay.
      // Real elapsed time includes variable Durable Object storage latency.
      let now = Date.now()
      vi.spyOn(Date, "now").mockImplementation(() => now)
      const sleep = vi.fn((callback: () => void, delay: number) => {
        now += delay
        callback()
        return 0
      })
      vi.stubGlobal("setTimeout", sleep)
      const times: number[] = []
      const fetcher = vi.fn().mockImplementation(async () => {
        times.push(Date.now())
        return Response.json({ Content: [], TotalElements: 0 })
      })
      vi.stubGlobal("fetch", fetcher)
      const results = await Promise.all([
        instance.fetch(
          new Request(url, { headers: { authorization: "Bearer fixture" } }),
        ),
        instance.fetch(
          new Request(`${url}&Pin=8`, {
            headers: { authorization: "Bearer fixture" },
          }),
        ),
      ])
      expect(results.map((r) => r.status)).toEqual([200, 200])
      expect(sleep).toHaveBeenCalledTimes(1)
      expect(sleep.mock.calls[0][1]).toBe(500)
      expect(times[1] - times[0]).toBe(500)
      const cached = await instance.fetch(
        new Request(url, { headers: { authorization: "Bearer fixture" } }),
      )
      expect(cached.headers.get("x-ti-cache-expires-at")).toBe(
        results[0].headers.get("x-ti-cache-expires-at"),
      )
      expect(await cached.json()).toEqual({ Content: [], TotalElements: 0 })
      expect(fetcher).toHaveBeenCalledTimes(2)
      // Persisted responses can be reused after object eviction/restart.
      expect((await state.storage.list({ prefix: "response:" })).size).toBe(2)
    })
  })
  it("persists 429 cooldown, honours Retry-After and keeps cached URLs available", async () => {
    await runInDurableObject(stub(), async (instance: TiGateway, state) => {
      vi.stubGlobal(
        "fetch",
        vi
          .fn()
          .mockResolvedValueOnce(Response.json({ ok: true }))
          .mockResolvedValueOnce(
            new Response(null, {
              status: 429,
              headers: { "retry-after": "120" },
            }),
          ),
      )
      await instance.fetch(
        new Request(url, { headers: { authorization: "Bearer fixture" } }),
      )
      const limited = await instance.fetch(
        new Request(`${url}&Pin=8`, {
          headers: { authorization: "Bearer fixture" },
        }),
      )
      expect(limited.status).toBe(429)
      expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(110)
      expect(
        await state.storage.get<number>("cooldown:information"),
      ).toBeGreaterThan(Date.now() + 110_000)
      expect(
        (
          await instance.fetch(
            new Request(`${url}&Pin=16`, {
              headers: { authorization: "Bearer fixture" },
            }),
          )
        ).status,
      ).toBe(429)
      expect(
        (
          await instance.fetch(
            new Request(url, { headers: { authorization: "Bearer fixture" } }),
          )
        ).status,
      ).toBe(200)
      expect(fetch).toHaveBeenCalledTimes(2)
    })
  })
  it("shares OAuth in memory without persisting credentials or tokens", async () => {
    await runInDurableObject(stub(), async (instance: TiGateway, state) => {
      vi.stubGlobal(
        "fetch",
        vi
          .fn()
          .mockResolvedValue(
            Response.json({ access_token: "secret-token", expires_in: 3600 }),
          ),
      )
      const auth = () =>
        new Request("https://transact.ti.com/v1/oauth/accesstoken", {
          method: "POST",
          body: "client_secret=private",
        })
      expect((await instance.fetch(auth())).status).toBe(200)
      expect(
        Number(
          ((await (await instance.fetch(auth())).json()) as any).expires_in,
        ),
      ).toBeLessThanOrEqual(3540)
      expect(fetch).toHaveBeenCalledTimes(1)
      expect(JSON.stringify([...(await state.storage.list())])).not.toMatch(
        /secret-token|private/,
      )
    })
  })
  it("serves cached products without OAuth even after token eviction and during cooldown", async () => {
    await runInDurableObject(stub(), async (instance: TiGateway, state) => {
      const fetcher = vi.fn()
      vi.stubGlobal("fetch", fetcher)
      await state.storage.put(`response:${url}`, {
        body: JSON.stringify({ Content: [{ Identifier: "TPS62160DSGR" }] }),
        status: 200,
        expiresAt: Date.now() + 60000,
      })
      await state.storage.put("cooldown:oauth", Date.now() + 60000)
      const response = await instance.fetch(new Request(url))
      expect(response.status).toBe(200)
      expect(fetcher).not.toHaveBeenCalled()
    })
  })
  it("does not block the Store API when Product Information is cooling down", async () => {
    await runInDurableObject(stub(), async (instance: TiGateway, state) => {
      await state.storage.put("cooldown:information", Date.now() + 60000)
      vi.stubGlobal(
        "fetch",
        vi
          .fn()
          .mockResolvedValue(Response.json({ tiPartNumber: "TPS62160DSGR" })),
      )
      const r = await instance.fetch(
        new Request("https://transact.ti.com/v2/store/products/TPS62160DSGR", {
          headers: { authorization: "Bearer fixture" },
        }),
      )
      expect(r.status).toBe(200)
      expect(fetch).toHaveBeenCalledTimes(1)
    })
  })
  it("authenticates internally only for an uncached product", async () => {
    await runInDurableObject(stub(), async (instance: TiGateway) => {
      const fetcher = vi
        .fn()
        .mockImplementation(async (request: Request) =>
          request.url.includes("oauth")
            ? Response.json({ access_token: "test-token", expires_in: 3600 })
            : Response.json({ Content: [], TotalElements: 0 }),
        )
      vi.stubGlobal("fetch", fetcher)
      expect((await instance.fetch(new Request(url))).status).toBe(200)
      expect(fetcher.mock.calls.map(([request]) => request.url)).toEqual([
        "https://transact.ti.com/v1/oauth/accesstoken",
        url,
      ])
      expect(fetcher.mock.calls[1][0].headers.get("authorization")).toBe(
        "Bearer test-token",
      )
      expect((await instance.fetch(new Request(url))).status).toBe(200)
      expect(fetcher).toHaveBeenCalledTimes(2)
    })
  })
  it("retains metadata for 30 days without extending inventory or resetting fetch time", async () => {
    await runInDurableObject(stub(), async (instance: TiGateway, state) => {
      const oldExpiry = Date.now() - 3600_000
      const entry = { body: "{}", status: 200, expiresAt: oldExpiry }
      await state.storage.put(`response:${url}`, entry)
      const storeUrl = "https://transact.ti.com/v2/store/products/TPS62160DSGR"
      await state.storage.put(`response:${storeUrl}`, entry)
      await state.storage.put("cooldown:store", Date.now() + 60000)
      vi.stubGlobal("fetch", vi.fn())
      const response = await instance.fetch(new Request(url))
      expect(response.status).toBe(200)
      expect(Number(response.headers.get("x-ti-cache-expires-at"))).toBe(
        oldExpiry + 29 * 86400_000,
      )
      const migrated = await state.storage.get<{ fetchedAt: number }>(
        `response:${url}`,
      )
      expect(migrated?.fetchedAt).toBe(oldExpiry - 86400_000)
      const second = await instance.fetch(new Request(url))
      expect(second.headers.get("x-ti-cache-expires-at")).toBe(
        response.headers.get("x-ti-cache-expires-at"),
      )
      expect((await instance.fetch(new Request(storeUrl))).status).toBe(429)
      expect(fetch).not.toHaveBeenCalled()
    })
  })
  it("rejects non-TI URLs and removes expired cached products", async () => {
    await runInDurableObject(stub(), async (instance: TiGateway, state) => {
      const fetcher = vi.fn()
      vi.stubGlobal("fetch", fetcher)
      expect(
        (await instance.fetch(new Request("https://example.com/v1/products")))
          .status,
      ).toBe(400)
      await state.storage.put("response:old", {
        body: "{}",
        status: 200,
        expiresAt: 0,
      })
      await instance.alarm()
      expect(await state.storage.get("response:old")).toBeUndefined()
      expect(fetcher).not.toHaveBeenCalled()
    })
  })
})

it("forwards large metadata pages without exceeding the Durable Object value limit", async () => {
  const gateway = stub()
  const body = JSON.stringify({
    Content: [{ Description: "x".repeat(150_000) }],
    TotalElements: 1,
  })
  vi.stubGlobal(
    "fetch",
    vi.fn().mockImplementation(async () => new Response(body)),
  )
  await runInDurableObject(gateway, async (instance: TiGateway, state) => {
    const response = await instance.fetch(
      new Request(url, { headers: { authorization: "Bearer fixture" } }),
    )
    expect(response.status).toBe(200)
    expect(await response.text()).toBe(body)
    expect(await state.storage.get(`response:${url}`)).toBeUndefined()
  })
})
