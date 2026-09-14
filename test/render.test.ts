import { describe, expect, it } from "vitest"
import { renderHomePage, renderSearchPage } from "../src/render"
import { normalizeProduct, buildTiFilterOptions } from "../src/normalize"
import { CATEGORY_BY_PATH } from "../src/categories"
import catalog from "./fixtures/catalog.json"
import parametrics from "./fixtures/parametrics.json"

describe("reference page interface", () => {
  it("renders all parameter filters and preserves query controls across form submission", () => {
    const part = normalizeProduct({ store: catalog.catalog[0], parametrics })
    const options = buildTiFilterOptions([part])
    const payload = {
      query: "DC/DC converters",
      components: [part],
      total: 1,
      upstream_total: 2,
      limit: 5,
      offset: 0,
      next_offset: 5,
      filter_options: options,
      source: "ti" as const,
      cached: true,
      stale: false,
      cache_expires_at: "2026-09-15T00:00:00Z",
    }
    const html = renderSearchPage(
      "/dcdc_converters/list",
      "DC/DC converters",
      CATEGORY_BY_PATH.get("/dcdc_converters/list"),
      payload,
      "https://test/dcdc_converters/list?q=DC%2FDC+converters&num_pins=8&limit=5&in_stock=true",
    )
    expect(options.ParametricFilters!.length).toBeGreaterThan(12)
    for (const f of options.ParametricFilters!) {
      expect(html).toContain(`name="param_1_${f.ParameterId}"`)
    }
    expect(html).toContain('name="num_pins" value="8"')
    expect(html).toContain('name="q" value="DC/DC converters"')
    expect(html).toContain('value="true" selected')
    expect(html).toContain("/dcdc_converters/list.json?")
    expect(html).toContain("offset=5")
    expect(html).toContain("Vin (V)")
    expect(html).toContain("3–17")
    expect(html).not.toContain("Family prefix:")
  })
  it("uses flat category tiles and no homepage data table", () => {
    const html = renderHomePage()
    expect(html).toContain("Categories</a>")
    expect(html).toContain("Package Index</a>")
    expect(html).toContain("*:w-32")
    expect(html).not.toContain("<table")
    expect(html).not.toContain("<section")
  })
})
