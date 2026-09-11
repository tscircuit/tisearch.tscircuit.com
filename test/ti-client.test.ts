import { describe, expect, it, vi } from "vitest"
import { TiApiError, TiClient } from "../src/ti-client"

describe("TI catalog client", () => {
  it("does not expose malformed authentication response bodies", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValue(new Response("private account credential"))
    await expect(
      new TiClient("id", "secret", fetcher).getCatalog(),
    ).rejects.toThrow("Invalid TI OAuth JSON response")
    const nullFetcher = vi.fn().mockResolvedValue(Response.json(null))
    await expect(
      new TiClient("id", "secret", nullFetcher).getCatalog(),
    ).rejects.toThrow("Invalid TI OAuth response")
  })
  it("form-encodes credentials, reuses tokens and excludes evaluation modules", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({ access_token: "secret-token", expires_in: 3600 }),
      )
      .mockImplementation(() => Promise.resolve(Response.json({ catalog: [] })))
    const client = new TiClient("a+b", "c&d", fetcher)
    await client.getCatalog()
    await client.getCatalog("EUR")
    expect(fetcher).toHaveBeenCalledTimes(3)
    expect(fetcher.mock.calls[0][0]).toBe(
      "https://transact.ti.com/v1/oauth/accesstoken",
    )
    expect(fetcher.mock.calls[0][1].body.toString()).toContain(
      "client_secret=c%26d",
    )
    expect(String(fetcher.mock.calls[1][0])).toContain("exclude-evms=true")
    expect(String(fetcher.mock.calls[2][0])).toContain("currency=EUR")
  })
  it("propagates throttling without retrying or disclosing the upstream body", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({ access_token: "token", expires_in: 3600 }),
      )
      .mockResolvedValueOnce(
        new Response("private account detail", {
          status: 429,
          headers: { "retry-after": "14400" },
        }),
      )
    const error = await new TiClient("id", "secret", fetcher)
      .getCatalog()
      .catch((e) => e)
    expect(error).toBeInstanceOf(TiApiError)
    if (!(error instanceof TiApiError)) throw new Error("Expected TiApiError")
    expect(error.status).toBe(429)
    expect(error.retryAfter).toBe("14400")
    expect(error.message).not.toContain("private")
    expect(fetcher).toHaveBeenCalledTimes(2)
  })
  it("refreshes an expired token", async () => {
    let now = 0
    const fetcher = vi
      .fn()
      .mockImplementation((url: string | URL) =>
        Promise.resolve(
          Response.json(
            String(url).includes("oauth")
              ? { access_token: "token", expires_in: 3600 }
              : { catalog: [] },
          ),
        ),
      )
    const client = new TiClient("id", "secret", fetcher, () => now)
    await client.getCatalog()
    now = 3600000
    await client.getCatalog()
    expect(fetcher).toHaveBeenCalledTimes(4)
  })
})
