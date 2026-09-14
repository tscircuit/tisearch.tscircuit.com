import { describe, expect, it } from "vitest"
import {
  normalizeProduct,
  buildTiFilterOptions,
  applyPostFilters,
} from "../src/normalize"
import { createSearchRequest } from "../src/search-request"
import catalog from "./fixtures/catalog.json"
const parse = (q: string) =>
  createSearchRequest(new URL(`https://test/api/search?q=TPS62160&${q}`))
describe("TI common part schema", () => {
  it("preserves supplier identity and prices at the correct quantity", () => {
    const p = normalizeProduct({ store: catalog.catalog[1] })
    expect(p).toMatchObject({
      ti_product_number: "TPS62160DSGT",
      ti_part_number: "TPS62160DSGT",
      mfr: "TPS62160DSGT",
      generic_part_number: "TPS62160",
      price: 1.8,
      price_quantity: 250,
      currency: "USD",
      manufacturer: "Texas Instruments",
    })
    expect(p).not.toHaveProperty("cad")
    expect(normalizeProduct({ store: catalog.catalog[2] }).price).toBeNull()
    expect(normalizeProduct({ store: catalog.catalog[2] }, "EUR").price).toBe(
      0.2,
    )
  })
  it("uses official links and rejects off-domain or executable URLs", () => {
    const raw = {
      ...catalog.catalog[0],
      buyNowUrl: "https://www.ti.com/product/TPS62160?test=1",
    }
    expect(normalizeProduct({ store: raw }).product_url).toBe(raw.buyNowUrl)
    expect(
      normalizeProduct({ store: { ...raw, buyNowUrl: "javascript:alert(1)" } })
        .product_url,
    ).toContain("https://www.ti.com/product/")
    expect(
      normalizeProduct({ store: catalog.catalog[3] }).product_url,
    ).toContain("%2FNOPB")
  })
  it("adds supplied family/package fields without treating V1 data as stock", () => {
    const p = normalizeProduct({
      store: catalog.catalog[0],
      information: {
        ProductFamilyDescription: "Buck converters",
        Pitch: 0.5,
        PackageType: "DSG",
        InventoryStatus: "No stock",
      },
    })
    expect(p.category).toBe("Buck converters")
    expect(p.parameters["Pitch (mm)"]).toBe("0.5")
    expect(p.stock).toBe(1200)
  })
  it("filters missing parameters strictly and derives selectable options", () => {
    const parts = catalog.catalog.map((store) => normalizeProduct({ store }))
    expect(
      applyPostFilters(parts, parse("package=WSON&num_pins=8")),
    ).toHaveLength(2)
    expect(
      applyPostFilters(parts, parse("package=SOIC&num_pins=5")),
    ).toHaveLength(0)
    const options = buildTiFilterOptions(parts)
    const pins = options.ParametricFilters?.find(
      (p) => p.ParameterName === "Pin Count",
    )
    expect(pins).toBeDefined()
    expect(
      applyPostFilters(parts, parse(`param_1_${pins?.ParameterId}=5`)),
    ).toHaveLength(1)
    expect(applyPostFilters(parts, parse("param_1_999=5"))).toHaveLength(0)
    expect(applyPostFilters(parts, parse("in_stock=false"))).toHaveLength(5)
  })
  it("rejects absent or malformed stock", () => {
    expect(() =>
      normalizeProduct({ store: { ...catalog.catalog[0], quantity: null } }),
    ).toThrow("inventory")
  })
})
