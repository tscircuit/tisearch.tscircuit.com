// TI Product Information descriptions are already stored even when the
// separate parametrics request is pending. Extract explicit DAC channel counts
// only; a part number, bit depth, interface width or supply count is not evidence.
export function dacChannelsFromDescription(
  category: string,
  description: string,
): number | null {
  if (
    !/^(?:Precision DACs|High-speed DACs|Audio DACs)(?:\b|\s)/i.test(category)
  )
    return null
  if (/\bADCs?\b|analog[ -]to[ -]digital/i.test(description)) return null
  const text = description.replace(/[‐‑–—]/g, "-")
  const words: Record<string, number> = {
    single: 1,
    mono: 1,
    dual: 2,
    stereo: 2,
    quad: 4,
    octal: 8,
  }
  const counts = new Set<number>()
  for (const pattern of [
    /\b(\d+|single|dual|quad|octal)[ -]+(?:channels?|ch)\b/gi,
    /\b(single|mono|dual|stereo|quad|octal)[ -]+(?:audio[ -]+)?(?:DACs?|digital[ -]to[ -]analog converters?)\b/gi,
  ]) {
    for (const match of text.matchAll(pattern)) {
      const n = words[match[1].toLowerCase()] ?? Number(match[1])
      if (Number.isSafeInteger(n) && n > 0) counts.add(n)
    }
  }
  return counts.size === 1 ? [...counts][0] : null
}
