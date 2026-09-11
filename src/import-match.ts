export interface JlcMatch {
  lcsc: number
  mfr: string
  package: string
}

export const validatePartNumber = (value: string): string => {
  const part = value.trim()
  if (!/^[A-Za-z0-9][A-Za-z0-9./+_-]{0,99}$/.test(part))
    throw new Error("Provide one exact TI orderable part number")
  return part
}

export const findExactJlcPart = (
  partNumber: string,
  value: unknown,
): JlcMatch => {
  const pn = validatePartNumber(partNumber)
  const components = (value as { components?: unknown })?.components
  if (!Array.isArray(components)) throw new Error("Invalid JLC search response")
  const exact = components.filter((candidate): candidate is JlcMatch => {
    if (!candidate || typeof candidate !== "object") return false
    return (
      typeof candidate.mfr === "string" &&
      candidate.mfr.trim().toUpperCase() === pn.toUpperCase() &&
      Number.isSafeInteger(candidate.lcsc) &&
      candidate.lcsc > 0 &&
      typeof candidate.package === "string"
    )
  })
  const unique = [...new Map(exact.map((part) => [part.lcsc, part])).values()]
  if (!unique.length)
    throw new Error(
      `No exact CAD match for ${pn}; family or package substitutions are not imported`,
    )
  if (unique.length > 1)
    throw new Error(
      `Multiple exact CAD matches for ${pn}; select and verify a package manually: ${unique.map((p) => `C${p.lcsc} (${p.package})`).join(", ")}`,
    )
  return unique[0]
}

export const validateImportedTsx = (
  tsx: string,
  partNumber: string,
  lcsc: number,
): void => {
  const pn = validatePartNumber(partNumber)
  const found = tsx.match(/manufacturerPartNumber\s*=\s*["']([^"']+)["']/)?.[1]
  if (found?.toUpperCase() !== pn.toUpperCase())
    throw new Error(
      "Imported CAD manufacturer part number does not match the requested TI part",
    )
  if (
    !tsx.includes(`"C${lcsc}"`) ||
    !tsx.includes("pinLabels=") ||
    !tsx.includes("footprint=")
  )
    throw new Error(
      "Imported TSX is missing supplier identity, pin labels, or footprint",
    )
}
