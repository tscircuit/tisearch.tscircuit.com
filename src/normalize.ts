import { classifyPart } from "./categories"
import type { NormalizedPart, PriceBreak } from "./types"

const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid TI product object")
  return value as Record<string, unknown>
}
const text = (value: unknown): string =>
  typeof value === "string" ? value.trim() : ""
const number = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : null
const integer = (value: unknown): number | null => {
  const n = number(value)
  return n !== null && Number.isSafeInteger(n) ? n : null
}

export const normalizeProduct = (
  value: unknown,
  currency = "USD",
): NormalizedPart => {
  const product = object(value)
  const pn = text(product.tiPartNumber)
  if (!pn || !/^[A-Za-z0-9][A-Za-z0-9./+_-]{0,99}$/.test(pn))
    throw new Error("Invalid TI part number")
  const stock = integer(product.quantity)
  if (stock === null) throw new Error(`Missing or invalid inventory for ${pn}`)
  const gpn = text(product.genericPartNumber)
  const pricing = Array.isArray(product.pricing) ? product.pricing : []
  const selected = pricing.map(object).find((p) => p.currency === currency)
  const breaks: PriceBreak[] = []
  for (const raw of Array.isArray(selected?.priceBreaks)
    ? selected.priceBreaks
    : []) {
    const item = object(raw)
    const quantity = integer(item.priceBreakQuantity)
    const price = number(item.price)
    if (quantity !== null && quantity > 0 && price !== null)
      breaks.push({ quantity, price })
  }
  breaks.sort((a, b) => a.quantity - b.quantity)
  const description = text(product.description)
  const canonicalUrl = `https://www.ti.com/product/${encodeURIComponent(gpn || pn)}/part-details/${encodeURIComponent(pn)}`
  let productUrl = canonicalUrl
  try {
    const url = new URL(text(product.buyNowURL))
    if (
      url.protocol === "https:" &&
      (url.hostname === "ti.com" || url.hostname.endsWith(".ti.com")) &&
      !url.username &&
      !url.password
    )
      productUrl = url.href
  } catch {
    /* Use the canonical TI URL when the upstream link is missing/invalid. */
  }
  return {
    ti_part_number: pn,
    supplier_part_number: pn,
    mfr: pn,
    generic_part_number: gpn,
    manufacturer: "Texas Instruments",
    description,
    package: text(product.packageType),
    pin_count: integer(product.pinCount),
    stock,
    price: breaks[0]?.price ?? null,
    price_quantity: breaks[0]?.quantity ?? null,
    currency,
    price_breaks: breaks,
    minimum_order_quantity: integer(product.minimumOrderQuantity),
    standard_pack_quantity: integer(product.standardPackQuantity),
    order_limit: integer(product.limit),
    lifecycle: text(product.lifeCycle),
    product_url: productUrl,
    // TI's generic product datasheet resolver; not a CAD model URL.
    datasheet_url: gpn
      ? `https://www.ti.com/lit/gpn/${encodeURIComponent(gpn)}`
      : "",
    categories: classifyPart(description),
    cad: {
      status: "lookup_required",
      source: "easyeda",
      lookup_url: `https://jlcsearch.tscircuit.com/api/search?q=${encodeURIComponent(pn)}&limit=50`,
    },
  }
}

export const normalizeCatalog = (
  value: unknown,
  currency = "USD",
): NormalizedPart[] => {
  if (!/^[A-Z]{3}$/.test(currency)) throw new Error("Invalid currency code")
  const catalog = object(value).catalog
  if (!Array.isArray(catalog) || catalog.length === 0)
    throw new Error(
      "TI returned an empty or invalid catalog; keeping the previous snapshot",
    )
  const seen = new Set<string>()
  return catalog.map((raw) => {
    const part = normalizeProduct(raw, currency)
    const key = part.ti_part_number.toUpperCase()
    if (seen.has(key))
      throw new Error(`Duplicate TI part: ${part.ti_part_number}`)
    seen.add(key)
    return part
  })
}
