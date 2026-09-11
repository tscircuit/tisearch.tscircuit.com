import { describe, expect, it, vi } from "vitest"
import { importTiPart, TSX_UNSUPPORTED_REASON } from "../src/import-ti-part"
import { TiApiError, TiClient } from "../src/ti-client"
import catalog from "./fixtures/catalog.json"

const mockTi = (response: Response) =>
  vi
    .fn()
    .mockResolvedValueOnce(
      Response.json({ access_token: "test-token", expires_in: 3600 }),
    )
    .mockResolvedValueOnce(response)

describe("direct TI API part import", () => {
  it("imports an exact /NOPB part through TI OAuth and Store V2 with provenance", async () => {
    const fetcher = mockTi(Response.json(catalog.catalog[3]))
    const document = await importTiPart(
      new TiClient("id", "secret", fetcher),
      "LP2982AIM5-3.3/NOPB",
    )
    const url =
      "https://transact.ti.com/v2/store/products/LP2982AIM5-3.3%2FNOPB?currency=USD&exclude-evms=true"
    expect(fetcher.mock.calls.map(([url]) => String(url))).toEqual([
      "https://transact.ti.com/v1/oauth/accesstoken",
      url,
    ])
    expect(fetcher.mock.calls[1][1]).toMatchObject({
      headers: {
        authorization: "Bearer test-token",
        accept: "application/json",
      },
      redirect: "error",
    })
    expect(document).toMatchObject({
      source: "ti_api",
      source_url: url,
      part: {
        ti_part_number: "LP2982AIM5-3.3/NOPB",
        pin_count: 5,
        package: "SOT-23 (DBV)",
      },
      tsx: { supported: false },
    })
    expect(JSON.stringify(document)).not.toContain("test-token")
  })

  it("selects the requested currency and reuses the token across TI endpoints", async () => {
    const fetcher = mockTi(
      Response.json(catalog.catalog[2]),
    ).mockResolvedValueOnce(Response.json(catalog))
    const client = new TiClient("id", "secret", fetcher)
    const document = await importTiPart(client, "lm358dr", { currency: "EUR" })
    await client.getCatalog("EUR")
    expect(document.part).toMatchObject({
      ti_part_number: "LM358DR",
      price: 0.2,
      currency: "EUR",
    })
    expect(document.source_url).toContain("currency=EUR")
    expect(fetcher).toHaveBeenCalledTimes(3)
  })

  it.each(["TPS62160", "TPS62160DSGT", "TPS62160DSGR/NOPB"])(
    "rejects a response for a different orderable part: %s",
    async (tiPartNumber) => {
      const fetcher = mockTi(
        Response.json({ ...catalog.catalog[0], tiPartNumber }),
      )
      await expect(
        importTiPart(new TiClient("id", "secret", fetcher), "TPS62160DSGR"),
      ).rejects.toThrow("different orderable part number")
      expect(fetcher).toHaveBeenCalledTimes(2)
    },
  )

  it.each([401, 403, 404, 429, 500])(
    "propagates TI HTTP %s without a fallback or retry",
    async (status) => {
      const fetcher = mockTi(
        new Response("private upstream details", {
          status,
          headers: { "retry-after": "60" },
        }),
      )
      const error = await importTiPart(
        new TiClient("id", "secret", fetcher),
        "TPS62160DSGR",
      ).catch((e) => e)
      expect(error).toBeInstanceOf(TiApiError)
      expect(error).toMatchObject({
        status,
        message: "TI product request failed",
        retryAfter: "60",
      })
      expect(fetcher).toHaveBeenCalledTimes(2)
    },
  )

  it("rejects malformed product JSON without exposing its body", async () => {
    const fetcher = mockTi(new Response("private upstream details"))
    await expect(
      importTiPart(new TiClient("id", "secret", fetcher), "TPS62160DSGR"),
    ).rejects.toThrow("Invalid TI product JSON response")
  })

  it.each([
    "",
    "catalog",
    "../catalog",
    "TPS62160?currency=EUR",
    "TPS62160\nDSGR",
  ])(
    "rejects invalid or reserved part names before any request: %s",
    async (part) => {
      const fetcher = vi.fn()
      await expect(
        importTiPart(new TiClient("id", "secret", fetcher), part),
      ).rejects.toThrow("exact TI orderable")
      expect(fetcher).not.toHaveBeenCalled()
    },
  )

  it("refuses unsupported TSX output without spending quota", async () => {
    const fetcher = vi.fn()
    await expect(
      importTiPart(new TiClient("id", "secret", fetcher), "TPS62160DSGR", {
        format: "tsx",
      }),
    ).rejects.toThrow(TSX_UNSUPPORTED_REASON)
    expect(fetcher).not.toHaveBeenCalled()
  })

  it("rejects unknown formats and invalid currency before any request", async () => {
    const fetcher = vi.fn()
    const client = new TiClient("id", "secret", fetcher)
    await expect(
      importTiPart(client, "TPS62160DSGR", { format: "svg" }),
    ).rejects.toThrow("Supported import format: json")
    await expect(
      importTiPart(client, "TPS62160DSGR", { currency: "US" }),
    ).rejects.toThrow("Invalid currency")
    expect(fetcher).not.toHaveBeenCalled()
  })
})
