import { env, runInDurableObject } from "cloudflare:test"
import { afterEach, describe, expect, it, vi } from "vitest"
import { TiGateway } from "../src/ti-gateway"

const stub = () => env.TI_GATEWAY!.get(env.TI_GATEWAY!.newUniqueId())
const url =
  "https://transact.ti.com/v1/products?ProductFamilyDescription=Battery+fuel+gauges&Page=0&Size=5"
afterEach(() => vi.unstubAllGlobals())

describe("shared TI gateway", () => {
  it("paces requests across URLs and serves cached responses without upstream calls", async () => {
    const gateway = stub()
    await runInDurableObject(gateway, async (instance: TiGateway, state) => {
      const times: number[] = []
      const fetcher = vi.fn().mockImplementation(async () => {
        times.push(Date.now())
        return Response.json({ Content: [], TotalElements: 0 })
      })
      vi.stubGlobal("fetch", fetcher)
      const results = await Promise.all([
        instance.fetch(new Request(url)),
        instance.fetch(new Request(`${url}&Pin=8`)),
      ])
      expect(results.map((r) => r.status)).toEqual([200, 200])
      expect(times[1] - times[0]).toBeGreaterThanOrEqual(490)
      const cached = await instance.fetch(new Request(url))
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
      await instance.fetch(new Request(url))
      const limited = await instance.fetch(new Request(`${url}&Pin=8`))
      expect(limited.status).toBe(429)
      expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(110)
      expect(await state.storage.get<number>("cooldown")).toBeGreaterThan(
        Date.now() + 110_000,
      )
      expect((await instance.fetch(new Request(`${url}&Pin=16`))).status).toBe(
        429,
      )
      expect((await instance.fetch(new Request(url))).status).toBe(200)
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
