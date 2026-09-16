import { expect, it } from "vitest"
import { dacChannelsFromDescription } from "../src/dac-channels"
import { hydratePart } from "../src/catalog"
import { env } from "cloudflare:test"
import { normalizeProduct } from "../src/normalize"
import { saveParts } from "../src/parts-store"
import { queryCompatibleCategory } from "../src/jlc/catalog"
import catalog from "./fixtures/catalog.json"

it("shows and filters description-derived counts in stored DAC category rows", async () => {
  await saveParts(env, [
    normalizeProduct({
      store: {
        ...catalog.catalog[0],
        tiPartNumber: "DAC8564ICPWR",
        description: "16-bit, quad-channel, ultra-low glitch, Vout DAC",
      },
      information: { ProductFamilyDescription: "Precision DACs (≤10 MSPS)" },
    }),
  ])
  expect(
    (await queryCompatibleCategory(env, "/dacs/list", { num_channels: "4" }))
      .data.dacs,
  ).toEqual([expect.objectContaining({ mfr: "DAC8564ICPWR", num_channels: 4 })])
  expect(
    (await queryCompatibleCategory(env, "/dacs/list", { num_channels: "1" }))
      .data.dacs,
  ).toEqual([])
})

it.each([
  ["8-bit 1-channel voltage-output smart DAC with comparator, GPIO", 1],
  ["16-bit, quad-channel, Vout DAC with 2.5-V reference", 4],
  ["113dB SNR Stereo DAC (H/W Control)", 2],
  ["113dB SNR Stereo Audio DAC (S/W Control)", 2],
  ["105dB SNR 8-Channel Audio DAC with TDM Mode", 8],
  ["10-Bit Micro Power DUAL Digital-to-Analog Converter", 2],
  ["True 16-bit, 1-ch, SPI/I2C, voltage-output DAC", 1],
  ["Octal-channel DAC", 8],
  ["12-Bit, Parallel Input, Multiplying DAC", null],
  ["DAC with dual supply and 16-bit interface", null],
  ["2-channel ADC with single DAC", null],
  ["1-channel or 2-channel DAC", null],
])(
  "reads only explicit counts from TI description: %s",
  (description, count) => {
    expect(
      dacChannelsFromDescription("Precision DACs (≤10 MSPS)", description),
    ).toBe(count)
  },
)

it("does not classify other families or override known specifications", () => {
  expect(
    dacChannelsFromDescription("General-purpose MCUs", "4-channel ADC"),
  ).toBeNull()
  const raw = {
    category: "Audio DACs",
    description: "Stereo DAC",
    parametrics: {},
    num_channels: null,
  }
  expect(hydratePart(JSON.stringify(raw)).num_channels).toBe(2)
  expect(
    hydratePart(JSON.stringify({ ...raw, num_channels: 4 })).num_channels,
  ).toBe(4)
  expect(
    hydratePart(
      JSON.stringify({
        ...raw,
        parametrics: { "Number of DAC channels": { Value: "8" } },
      }),
    ).num_channels,
  ).toBe(8)
})
