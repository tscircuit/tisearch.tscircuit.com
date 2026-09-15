import { expect, it } from "vitest"
import { isAnalogSwitch } from "../src/jlc/analog-switch"

it.each([
  ["1:1 SPST", true],
  ["2:1 SPDT", true],
  ["1 : 2", true],
  ["DPDT", true],
  ["4:1", false],
  ["8:1", false],
  ["16:1", false],
  ["8:8", false],
  ["Other", false],
])("classifies TI configuration %s", (channel_type, expected) => {
  expect(isAnalogSwitch({ channel_type, num_channels: 1 })).toBe(expected)
})

it("uses explicit descriptions only when configuration is missing", () => {
  expect(isAnalogSwitch({ description: "Quad bilateral analog switch" })).toBe(
    true,
  )
  expect(
    isAnalogSwitch({ description: "Single analog switch", num_channels: 4 }),
  ).toBe(true)
  expect(isAnalogSwitch({ description: "Analog switches & muxes" })).toBe(false)
  expect(isAnalogSwitch({ description: "8-channel analog multiplexer" })).toBe(
    false,
  )
  expect(isAnalogSwitch({ num_channels: 1 })).toBe(false)
  expect(
    isAnalogSwitch({
      channel_type: "8:1",
      description: "Digitally controlled analog switches",
    }),
  ).toBe(false)
})
