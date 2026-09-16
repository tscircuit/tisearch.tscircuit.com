import { expect, it } from "vitest"
import { env } from "cloudflare:test"
import { compatibilityFields } from "../src/jlc/ti-fields"
import { hydratePart } from "../src/catalog"
import { normalizeProduct } from "../src/normalize"
import {
  categoryRoutesForPart,
  queryCompatibleCategory,
} from "../src/jlc/catalog"
import { saveParts } from "../src/parts-store"
import fixtures from "./fixtures/ti-column-metadata.json"
import catalog from "./fixtures/catalog.json"

// TI Product Information/parametrics sampled from D1 on 2026-09-16.
const parts = fixtures.map((fixture) => ({
  ...normalizeProduct({
    store: { ...catalog.catalog[0], tiPartNumber: fixture.mfr },
  }),
  ...fixture,
}))
const fields = (mfr: string) =>
  compatibilityFields(
    hydratePart(JSON.stringify(parts.find((p) => p.mfr === mfr))),
  )

it("hydrates TI's DAC channel key and projects/filter it through the category API", async () => {
  await saveParts(env, parts)
  const result = await queryCompatibleCategory(env, "/dacs/list", {
    num_channels: "1",
  })
  expect(result.data.dacs).toEqual([
    expect.objectContaining({
      mfr: "DAC3171IRGCR",
      num_channels: 1,
      resolution_bits: 14,
      operating_temp_min: -40,
      operating_temp_max: 85,
    }),
  ])
  expect(fields("DAC3171IRGCR").sampling_rate_hz).toBe(500e6)
  expect(
    (await queryCompatibleCategory(env, "/dacs/list", { num_channels: "2" }))
      .data.dacs,
  ).toEqual([])
})

it("includes actual TI Sitara families in Linux and ARM categories without MCU false positives", async () => {
  await saveParts(env, parts)
  const linux = await queryCompatibleCategory(
    env,
    "/linux_capable_processors/list",
    {},
  )
  expect(linux.data.linux_capable_processors).toEqual([
    expect.objectContaining({
      mfr: "AM3354BZCZD80",
      chip_family: "TI Sitara AM335x",
      cpu_core: "Cortex-A8",
      architecture: "ARM32",
    }),
  ])
  expect(categoryRoutesForPart(parts[0])).toContain(
    "/linux_capable_processors/list",
  )
  expect(
    (
      await queryCompatibleCategory(env, "/arm_processors/list", {})
    ).data.arm_processors.map((r) => r.mfr),
  ).toContain("AM3354BZCZD80")
})

it("maps real MCU and regulator specs with units, keeping ambiguous package-dependent counts unknown", () => {
  expect(fields("MSPM0C1104SDSGR")).toMatchObject({
    cpu_speed_hz: 24e6,
    flash_size_bytes: 16384,
    ram_size_bytes: 1024,
    has_i2c: true,
    has_spi: true,
    has_uart: true,
    has_dma: true,
    has_adc: true,
    adc_resolution_bits: 12,
    gpio_count: null,
  })
  expect(fields("5962-1222402VHA")).toMatchObject({
    dropout_voltage: 0.27,
    quiescent_current: 0.001,
    output_noise_uvrms: 50,
    power_supply_rejection_db: 45,
    number_of_outputs: 1,
    input_voltage_min: 2.3,
    input_voltage_max: 20,
  })
  expect(fields("LM36274YFFR")).toMatchObject({
    channel_count: 4,
    efficiency_percent: 92,
    switching_frequency: 1050000,
  })
})

it("maps DAC settling time, INL, and interface metadata without replacing missing supply ratings with output ratings", () => {
  const row = compatibilityFields(
    normalizeProduct({
      store: catalog.catalog[0],
      parametrics: {
        "Number of DAC channels": { Value: "1" },
        "Settling time": { Value: "10000", Unit: "ns" },
        INL: { Range: { Max: "1" }, Unit: "±LSB" },
        "Interface type": { Value: "I2C" },
        "Output type": { Value: "Buffered Voltage" },
        Vout: { Range: { Min: "0", Max: "5.5" }, Unit: "V" },
      },
    }),
  )
  expect(row).toMatchObject({
    num_channels: 1,
    settling_time_us: 10,
    nonlinearity_lsb: 1,
    has_i2c: true,
    output_type: "Buffered Voltage",
    supply_voltage_min: null,
    supply_voltage_max: null,
  })
})

it("uses explicit Linux/CPU metadata for additional SoCs and does not invent support for MCUs or unknown cores", () => {
  const make = (core: string, os: string) =>
    compatibilityFields(
      normalizeProduct({
        store: {
          ...catalog.catalog[0],
          tiPartNumber: "AMTEST",
          genericPartNumber: "AMTEST",
        },
        information: {
          ProductFamilyDescription: "Multimedia & industrial networking SoCs",
        },
        parametrics: {
          CPU: { Value: core },
          "Operating system": { Value: os },
        },
      }),
    )
  expect(make("4 Arm Cortex-A72", "Linux, RTOS")).toMatchObject({
    architecture: "ARM64",
    chip_family: "TI AMTEST",
  })
  expect(make("Arm Cortex-M4", "RTOS").architecture).toBeUndefined()
  expect(make("Arm Cortex-A999", "Linux").architecture).toBeUndefined()
})
