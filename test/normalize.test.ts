import { describe, expect, it } from "vitest"
import { normalizeCatalog, normalizeProduct } from "../src/normalize"
import catalog from "./fixtures/catalog.json"

describe("TI Store V2 normalization", () => {
  it("keeps OPN and GPN distinct and records price break quantities", () => {
    const part = normalizeProduct(catalog.catalog[1])
    expect(part.mfr).toBe("TPS62160DSGT")
    expect(part.generic_part_number).toBe("TPS62160")
    expect(part.price_quantity).toBe(250)
    expect(part.categories).toContain("buck_converters")
    expect(part.cad.status).toBe("lookup_required")
  })
  it("does not turn absent prices or another currency into a free USD part", () => {
    expect(normalizeProduct(catalog.catalog[2]).price).toBeNull()
    expect(normalizeProduct(catalog.catalog[2], "EUR").price).toBe(0.2)
  })
  it("preserves slash suffixes and encodes links", () => {
    const part = normalizeProduct(catalog.catalog[3])
    expect(part.ti_part_number).toBe("LP2982AIM5-3.3/NOPB")
    expect(part.product_url).toContain("%2FNOPB")
    expect(part.cad.lookup_url).toContain("%2FNOPB")
  })
  it("retains a valid TI link and excludes executable/off-domain links", () => {
    const raw = catalog.catalog[0]
    expect(normalizeProduct(raw).product_url).toBe(raw.buyNowURL)
    expect(
      normalizeProduct({ ...raw, buyNowURL: "javascript:alert(1)" })
        .product_url,
    ).toMatch(/^https:\/\/www.ti.com\//)
    expect(
      normalizeProduct({ ...raw, buyNowURL: "https://ti.com.evil.test/" })
        .product_url,
    ).not.toContain("evil.test")
  })
  it("rejects empty, duplicate and malformed catalogs before publishing", () => {
    expect(() => normalizeCatalog({ catalog: [] })).toThrow("empty")
    expect(() =>
      normalizeCatalog({ catalog: [catalog.catalog[0], catalog.catalog[0]] }),
    ).toThrow("Duplicate")
    expect(() =>
      normalizeProduct({ ...catalog.catalog[0], quantity: null }),
    ).toThrow("inventory")
    expect(normalizeCatalog(catalog)).toHaveLength(5)
  })
})
