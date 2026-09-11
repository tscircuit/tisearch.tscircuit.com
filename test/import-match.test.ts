import { describe, expect, it } from "vitest"
import {
  findExactJlcPart,
  validateImportedTsx,
  validatePartNumber,
} from "../src/import-match"

describe("TI to EasyEDA matching", () => {
  const match = { lcsc: 324077, mfr: "TPS62160DSGR", package: "WSON-8-EP(2x2)" }
  it("selects the exact OPN, not a family or packing suffix substitution", () => {
    expect(
      findExactJlcPart("tps62160dsgr", {
        components: [{ ...match, mfr: "TPS62160DSGT" }, match],
      }),
    ).toEqual(match)
    expect(() => findExactJlcPart("TPS62160", { components: [match] })).toThrow(
      "No exact",
    )
    expect(() =>
      findExactJlcPart("TPS62160DSGT", { components: [match] }),
    ).toThrow("No exact")
  })
  it("refuses ambiguous CAD and preserves NOPB identity", () => {
    expect(() =>
      findExactJlcPart(match.mfr, {
        components: [match, { ...match, lcsc: 123 }],
      }),
    ).toThrow("Multiple")
    expect(validatePartNumber("LP2982AIM5-3.3/NOPB")).toBe(
      "LP2982AIM5-3.3/NOPB",
    )
    expect(() => validatePartNumber("--help")).toThrow()
  })
  it("checks the converted TSX identity and required CAD fields", () => {
    const tsx =
      '<chip manufacturerPartNumber="TPS62160DSGR" supplierPartNumbers={{jlcpcb:["C324077"]}} pinLabels={pins} footprint={pads}/>'
    expect(() => validateImportedTsx(tsx, match.mfr, match.lcsc)).not.toThrow()
    expect(() => validateImportedTsx(tsx, "TPS62160DSGT", match.lcsc)).toThrow(
      "does not match",
    )
    expect(() =>
      validateImportedTsx(
        tsx.replace("footprint=", "x="),
        match.mfr,
        match.lcsc,
      ),
    ).toThrow("missing")
  })
})
