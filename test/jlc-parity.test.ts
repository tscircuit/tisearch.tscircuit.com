import taxonomy from "../src/jlc/taxonomy.json"
import {
  createExecutionContext,
  env,
  waitOnExecutionContext,
} from "cloudflare:test"
import { afterEach, expect, it, vi } from "vitest"
import worker from "../src/index"
import { matchesFilters, supportsTiCategoryRoute } from "../src/jlc/catalog"
import { TABLE_CONFIGS } from "../src/jlc/contracts"
import { compatibilityFields } from "../src/jlc/ti-fields"
import { normalizeProduct } from "../src/normalize"
import { saveParts } from "../src/parts-store"
import catalog from "./fixtures/catalog.json"
import reference from "./fixtures/jlc/reference.json"
import type { NormalizedPart } from "../src/types"

const contexts: ExecutionContext[] = []
const get = async (path: string, headers: Record<string, string> = {}) => {
  const context = createExecutionContext()
  contexts.push(context)
  return worker.fetch(
    new Request(`https://test${path}`, { headers }),
    env,
    context,
  )
}
const json = async (path: string): Promise<any> => (await get(path)).json()
const seed = async (
  family: string,
  mpn: string,
  extra: Record<string, unknown> = {},
) => {
  const part = normalizeProduct({
    store: { ...catalog.catalog[0], tiPartNumber: mpn, genericPartNumber: mpn },
    information: { ProductFamilyDescription: family },
  })
  await saveParts(env, [{ ...part, ...extra }])
}
afterEach(async () => {
  for (const ctx of contexts.splice(0)) await waitOnExecutionContext(ctx)
  vi.unstubAllGlobals()
})

it("preserves reference contracts and shows only TI-supported homepage tiles in order", async () => {
  expect(TABLE_CONFIGS).toEqual(reference.configs)
  const home = await (await get("/")).text()
  const tiles = [
    ...home.matchAll(/<a href="(\/[^"?]+\/list)">([^<]+)<\/a>/g),
  ].map((m) => [m[1], m[2]])
  expect(tiles).toEqual(
    Object.entries(reference.routes)
      .filter(
        ([path]) =>
          ["/categories/list", "/footprint_index/list"].includes(path) ||
          supportsTiCategoryRoute(path),
      )
      .map(([path, route]) => [path, route.label.replaceAll("&", "&amp;")]),
  )
  expect(home).not.toContain("fuel_gauges/list")
  expect(home).not.toContain("posthog")
  expect(home).not.toContain('href="/barrel_jacks/list"')
  expect(home).not.toContain('href="/switches/list"')
  expect(home).not.toContain('href="/risc_v_processors/list"')
  expect(home).toContain('href="/analog_switches/list"')
})

it("serves every reference page, exact response key, and form parameter without upstream access", async () => {
  const fetcher = vi
    .fn()
    .mockRejectedValue(new Error("No supplier calls allowed"))
  vi.stubGlobal("fetch", fetcher)
  for (const [path, route] of Object.entries(reference.routes)) {
    const result = await get(`${path}.json`)
    expect(result.status, path).toBe(200)
    expect(await result.json(), path).toEqual({
      [route.responseKey]:
        path === "/categories/list" ? taxonomy.categories : [],
    })
    const htmlResponse = await get(path)
    expect(htmlResponse.status, path).toBe(200)
    const html = await htmlResponse.text()
    for (const param of route.filters)
      expect(html, `${path}:${param}`).toContain(`name="${param}"`)
    expect(html).not.toContain(">Next</a>")
    expect(html).not.toContain('name="limit"')
    const params = new URLSearchParams(
      Object.fromEntries(route.filters.map((name) => [name, "All"])),
    )
    expect((await get(`${path}.json?${params}`)).status, path).toBe(200)
  }
  for (const context of contexts.splice(0))
    await waitOnExecutionContext(context)
  expect(fetcher).not.toHaveBeenCalled()
})

it("aggregates TI ADC families, projects the category schema, and filters all stored matches", async () => {
  const parts: NormalizedPart[] = []
  for (let i = 0; i < 125; i++) {
    parts.push({
      ...normalizeProduct({
        store: {
          ...catalog.catalog[0],
          tiPartNumber: `ADC${i}`,
          buyNowUrl: `https://www.ti.com/product/ADC${i}/part-details/ADC${i}`,
          quantity: 125 - i,
        },
        information: {
          ProductFamilyDescription:
            i % 2 ? "High-speed ADCs (≥10 MSPS)" : "Precision ADCs",
        },
      }),
      resolution_bits: i === 124 ? 24 : 16,
      num_channels: i === 124 ? 4 : 2,
    })
  }
  await saveParts(env, parts)
  expect((await json("/adcs/list.json?limit=1&offset=100")).adcs).toHaveLength(
    125,
  )
  const { adcs } = await json(
    "/adcs/list.json?resolution_bits=24&num_channels=4",
  )
  expect(adcs).toHaveLength(1)
  expect(adcs[0]).toMatchObject({
    mfr: "ADC124",
    lcsc: null,
    has_i2c: null,
    resolution_bits: 24,
    num_channels: 4,
  })
  expect(adcs[0]).toHaveProperty("sampling_rate_hz")
  const html = await (await get("/adcs/list?resolution_bits=24")).text()
  expect(html).toContain('name="resolution_bits" value="24"')
  expect(html).toContain(
    "https://www.ti.com/product/ADC124/part-details/ADC124",
  )
  expect(html).not.toContain("jlcpcb.com/partdetail")
  expect(
    (await json("/resistors/list.json?resistance=10000&is_basic=false"))
      .resistors,
  ).toEqual([])
})

it("matches JLC numeric, boolean, range, alias and exclusion operators including unknown values", () => {
  const path = "/photo_diodes/list"
  const row = {
    spectral_range_min_nm: 300,
    spectral_range_max_nm: 1100,
    peak_wavelength_nm: 850,
    reverse_voltage: 30,
    dark_current_a: 1e-9,
  }
  expect(matchesFilters(row, path, { wavelength_min: "355" })).toBe(true)
  expect(
    matchesFilters(row, path, { wavelength: "355", peak_distance_max: "100" }),
  ).toBe(false)
  expect(
    matchesFilters(row, path, { excluded_peak_bands: "700-1100, 532" }),
  ).toBe(false)
  expect(
    matchesFilters(row, path, {
      excluded_peak_bands: "355-400",
      reverse_voltage_min: "25",
      dark_current_max: "2e-9",
    }),
  ).toBe(true)
  expect(
    matchesFilters({ ...row, spectral_range_min_nm: null }, path, {
      wavelength: "850",
    }),
  ).toBe(true)
  expect(
    matchesFilters({ resistance: 10000 }, "/resistors/list", {
      resistance: "10000.5",
    }),
  ).toBe(true)
  expect(
    matchesFilters({ resistance: 10000 }, "/resistors/list", {
      resistance: "10003",
    }),
  ).toBe(false)
  expect(
    matchesFilters({ is_basic: null }, "/resistors/list", {
      is_basic: "false",
    }),
  ).toBe(false)
  expect(
    matchesFilters({ has_spi: true }, "/ble_chips/list", { has_spi: "1" }),
  ).toBe(true)
  expect(
    matchesFilters({ drain_source_voltage: 12 }, "/mosfets/list", {
      drain_source_voltage_min: "13",
    }),
  ).toBe(false)
  expect(
    matchesFilters(
      { output_voltage_min: 0.9, output_voltage_max: 6 },
      "/boost_converters/list",
      { output_voltage_min: "1", output_voltage_max: "5" },
    ),
  ).toBe(true)
})

it("separates analog switches from muxes using configuration in JSON and HTML", async () => {
  const switches = [
    ["1P1G66QDBVRG4Q1", "1:1 SPST", "1"],
    ["1P1G3157QDBVRQ1", "2:1 SPDT", "1"],
    ["CD4066BE", "1:1 SPST", "4"],
  ]
  const muxes = [
    ["CD4052BPWRG4", "4:1", "2"],
    ["CD4051BM96G3", "8:1", "1"],
    ["CD4067BPW", "16:1", "1"],
  ]
  for (const [mpn, configuration, channels] of [...switches, ...muxes]) {
    await seed("Analog & precision switches & muxes", mpn, {
      parametrics: {
        Configuration: { Value: configuration },
        "Number of channels": { Value: channels },
      },
    })
  }
  await seed("Analog & precision switches & muxes", "UNKNOWN", {
    description: "Analog switches & muxes",
    parametrics: { "Number of channels": { Value: "1" } },
  })
  const result = await json("/analog_switches/list.json")
  expect(result.switches.map((p: any) => p.mfr).sort()).toEqual(
    switches.map(([mpn]) => mpn).sort(),
  )
  expect(
    (await json("/analog_switches/list.json?channels=4")).switches.map(
      (p: any) => p.mfr,
    ),
  ).toEqual(["CD4066BE"])
  const html = await (await get("/analog_switches/list")).text()
  for (const [mpn] of switches) expect(html).toContain(mpn)
  for (const [mpn] of muxes) expect(html).not.toContain(mpn)
  expect(html).not.toContain("UNKNOWN")
  const multiplexers = (await json("/analog_multiplexers/list.json"))
    .multiplexers
  for (const [mpn] of muxes)
    expect(multiplexers.map((p: any) => p.mfr)).toContain(mpn)
})

it("handles switch channel and processor interface filters with TI field/unit translation", async () => {
  await seed("Precision ADCs", "ADC08100", {
    parametrics: {
      "Number of input channels": { Value: "1" },
      "Interface type": { Value: "Parallel CMOS, TTL" },
    },
  })
  const adc = (await json("/adcs/list.json?num_channels=1")).adcs
  expect(adc).toHaveLength(1)
  expect(adc[0]).toMatchObject({
    num_channels: 1,
    has_parallel_interface: true,
  })
  await seed("Analog & precision switches & muxes", "MUX1", {
    parametrics: {
      Configuration: { Value: "1:1 SPST" },
      "Number of channels": { Value: "1" },
      Ron: { Value: "250", Unit: "mohm" },
    },
  })
  await seed("Analog & precision switches & muxes", "MUX8", {
    parametrics: { "Number of channels": { Value: "8" } },
  })
  const { switches } = await json("/analog_switches/list.json?channels=1")
  expect(switches.map((p: any) => p.mfr)).toEqual(["MUX1"])
  expect(switches[0].on_resistance_ohms).toBe(0.25)
  expect(
    (
      await json("/analog_multiplexers/list.json?num_channels=8")
    ).multiplexers.map((p: any) => p.mfr),
  ).toEqual(["MUX8"])
  await seed("General-purpose MCUs", "MCU1", {
    parametrics: {
      CPU: { Value: "ARM Cortex-M0+" },
      RAM: { Value: "32", Unit: "kB" },
      Interface: { Value: "I2C, SPI" },
    },
  })
  expect(
    (await json("/arm_processors/list.json?ram_min=32768&interface=spi"))
      .arm_processors,
  ).toHaveLength(1)
  expect(
    (await json("/arm_processors/list.json?interface=usb")).arm_processors,
  ).toHaveLength(0)
  expect(
    (await json("/risc_v_processors/list.json")).risc_v_processors,
  ).toHaveLength(0)
})

it("keeps supplier identifiers/classifications unknown and classifies only documented TI processor families", () => {
  const base = normalizeProduct({ store: catalog.catalog[0] })
  expect(compatibilityFields(base)).toMatchObject({
    lcsc: null,
    is_basic: null,
    is_preferred: null,
  })
  const cpu = compatibilityFields({ ...base, generic_part_number: "AM6254" })
  expect(cpu).toMatchObject({
    chip_family: "TI Sitara AM62x",
    architecture: "ARM64",
    cpu_core: "Cortex-A53",
  })
  expect(
    compatibilityFields({ ...base, generic_part_number: "AM2434" })
      .architecture,
  ).toBeUndefined()
  expect(
    compatibilityFields({ ...base, generic_part_number: "AM62A7" }),
  ).toMatchObject({ npu_performance_tops: 2 })
})

it("preserves directory/query negotiation, no-store cache busting, and missing LCSC resource contracts", async () => {
  await seed("Precision ADCs", "ADS1")
  await seed("Precision DACs (≤10 MSPS)", "DAC1")
  const categories = (
    await json("/categories/list.json?category_name=Analog+ICs")
  ).categories
  expect(categories).toContainEqual({
    category: "Analog ICs",
    subcategory: "Analog To Digital Converters (ADCs)",
  })
  expect(categories.every((r: any) => r.category === "Analog ICs")).toBe(true)
  expect(
    (await json("/categories/list.json?category_name=NoSuchCategory"))
      .categories,
  ).toEqual([])
  expect(
    (
      await json(
        "/components/list.json?subcategory_name=Analog+To+Digital+Converters+(ADCs)",
      )
    ).components.map((p: any) => p.mfr),
  ).toEqual(["ADS1"])
  expect((await json("/api/search?q=ADS&is_basic=true")).components).toEqual([])
  expect(
    (await json("/api/search?q=ADS&is_basic=false")).components,
  ).toHaveLength(1)
  for (const suffix of ["?json=true", ""]) {
    const response = await get(`/adcs/list${suffix}`, {
      accept: "application/json",
    })
    expect(response.headers.get("content-type")).toContain("application/json")
    expect(Object.keys((await response.json()) as object)).toEqual(["adcs"])
  }
  const response = await get("/adcs/list.json?cachebust=true")
  expect(response.headers.get("cache-control")).toBe("no-store")
  expect(response.headers.get("x-cache-bust")).toBe("1")
  expect((await json("/_d1/health")).d1).toBe(true)
  expect((await get("/api/footprinter_strings/C123")).status).toBe(404)
  expect(
    (await json("/api/footprinter_strings/invalid")).error.error_code,
  ).toBe("invalid_lcsc")
  expect((await json("/api/easyeda_components/C123")).error.error_code).toBe(
    "component_not_found",
  )
})

it("matches substrings inside MPNs using the maintained trigram index", async () => {
  await seed("Precision ADCs", "TPS62160DSGR")
  expect((await json("/api/search?q=62160DS")).components).toHaveLength(1)
  await env.DB.prepare(
    "UPDATE parts SET search_text='changedpart' WHERE ti_product_number='TPS62160DSGR'",
  ).run()
  expect((await json("/api/search?q=62160DS")).components).toHaveLength(0)
  expect((await json("/api/search?q=changed")).components).toHaveLength(1)
  await env.DB.prepare("DELETE FROM parts").run()
  expect((await json("/api/search?q=changed")).components).toHaveLength(0)
})

it("preserves the complete taxonomy and maps amplifier directory links to TI data", async () => {
  expect(taxonomy.categories).toHaveLength(93)
  expect(taxonomy.subcategories).toHaveLength(938)
  expect(taxonomy.incomplete_categories).toEqual([])
  await seed("General-purpose op amps", "LM358")
  await seed("Precision op amps (Vos<1mV)", "OPA197")
  const result = await json(
    "/components/list.json?subcategory_name=Operational+Amplifier",
  )
  expect(result.components.map((part: any) => part.mfr).sort()).toEqual([
    "LM358",
    "OPA197",
  ])
  expect(
    result.components.every(
      (part: any) => part.subcategory === "Operational Amplifier",
    ),
  ).toBe(true)
})

it("links category and search MFRs to stored TI URLs without changing category JSON", async () => {
  const productUrl =
    "https://www.ti.com/product/MSP432P401R/part-details/MSP432P401RIPZR"
  await seed("General-purpose MCUs", "MSP432P401RIPZR", {
    product_url: productUrl,
    parametrics: { CPU: { Value: "ARM Cortex-M4F" } },
  })
  for (const path of [
    "/arm_processors/list",
    "/microcontrollers/list",
    "/components/list?search=MSP432",
  ])
    expect(await (await get(path)).text()).toContain(`href="${productUrl}"`)
  const result = await json("/arm_processors/list.json")
  expect(result.arm_processors[0]).not.toHaveProperty("product_url")
})
