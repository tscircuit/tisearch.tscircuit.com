import { describe, expect, it } from "vitest"
import { CATEGORY_BY_PATH } from "../src/categories"
import {
  createSearchRequest,
  upstreamRequest,
  getSearchCacheKey,
} from "../src/search-request"
import { normalizeProduct, applyPostFilters } from "../src/normalize"
import catalog from "./fixtures/catalog.json"
import parametrics from "./fixtures/parametrics.json"
const parse = (path: string) => {
  const url = new URL(`https://test${path}`)
  return createSearchRequest(
    url,
    CATEGORY_BY_PATH.get(url.pathname.replace(/\.json$/, "")),
  )
}
describe("public query translation", () => {
  it("maps friendly category names and subcategory_name to official TI families", () => {
    expect(parse("/components/list?subcategory_name=fuel+gauges").query).toBe(
      "Battery fuel gauges",
    )
    expect(parse("/components/list?search=ldos").query).toBe(
      "Linear & low-dropout (LDO) regulators",
    )
    expect(parse("/fuel_gauges/list?search=BQ27441-G1").mode).toBe("part")
  })
  it("preserves common category routes and keys", () => {
    expect(
      parse("/voltage_regulators/list.json?output_type=Adjustable"),
    ).toMatchObject({
      responseKey: "regulators",
      postFilters: { output_type: "Adjustable" },
    })
    expect(parse("/analog_multiplexers/list.json?num_channels=4").query).toBe(
      CATEGORY_BY_PATH.get("/signal_multiplexers/list")!.query,
    )
  })
  it("accepts offset pagination and sends only TI-supported filters upstream", async () => {
    const r = parse(
      "/adcs/list.json?offset=3&limit=5&num_pins=8&resolution_bits=12&package=All&num_channels=2",
    )
    expect(r).toMatchObject({ offset: 3, limit: 5 })
    expect(upstreamRequest(r).postFilters).toEqual({ num_pins: "8" })
    const other = parse(
      "/adcs/list.json?offset=3&limit=5&num_pins=8&resolution_bits=16&in_stock=true",
    )
    expect(await getSearchCacheKey(upstreamRequest(r))).toBe(
      await getSearchCacheKey(upstreamRequest(other)),
    )
  })
  it("adds standard numeric fields, preserves quantity-one prices, and applies range operators", () => {
    const p = normalizeProduct({ store: catalog.catalog[0], parametrics })
    expect(p).toMatchObject({
      num_pins: 8,
      price1: 2.03,
      output_voltage_min: 0.9,
      output_voltage_max: 6,
      topology: "Buck",
    })
    expect(normalizeProduct({ store: catalog.catalog[1] }).price1).toBeNull()
    expect(
      applyPostFilters(
        [p],
        parse(
          "/buck_converters/list.json?output_voltage_min=1&output_voltage_max=5",
        ),
      ),
    ).toHaveLength(1)
    expect(
      applyPostFilters([p], parse("/boost_converters/list.json")),
    ).toHaveLength(0)
    expect(
      applyPostFilters(
        [p],
        parse("/dcdc_converters/list.json?output_voltage_max=12"),
      ),
    ).toHaveLength(0)
    expect(
      applyPostFilters([p], parse("/adcs/list.json?resolution_bits=12")),
    ).toHaveLength(0)
  })
  it("matches ADC specs and rejects unsupported supplier flags and invalid numeric filters", () => {
    const p = normalizeProduct({
      store: catalog.catalog[0],
      parametrics: {
        Resolution: { Value: "12", Unit: "Bits" },
        "Number of channels": { Value: "2" },
      },
    })
    expect(
      applyPostFilters(
        [p],
        parse("/adcs/list.json?resolution_bits=12&num_channels=2"),
      ),
    ).toHaveLength(1)
    expect(
      applyPostFilters([p], parse("/adcs/list.json?resolution_bits=16")),
    ).toHaveLength(0)
    expect(() => parse("/adcs/list.json?resolution_bits=NaN")).toThrow(
      "numeric filter",
    )
    expect(() => parse("/adcs/list.json?is_basic=true")).toThrow(
      "not available",
    )
  })
})
