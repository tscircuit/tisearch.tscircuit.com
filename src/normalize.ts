import { validatePartNumber } from "./part-number"
import type {
  NormalizedPart,
  SearchRequest,
  TiFilterOptions,
  TiProductRecord,
  TiSearchResponse,
} from "./types"

const text = (value: unknown): string =>
  typeof value === "string" ? value.replace(/\s+/g, " ").trim() : ""
const number = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : null
const integer = (value: unknown): number | null => {
  const n = number(value)
  return n !== null && Number.isSafeInteger(n) ? n : null
}
const tiUrl = (value: unknown, fallback = ""): string => {
  try {
    const url = new URL(text(value))
    if (
      (url.protocol === "https:" || url.protocol === "http:") &&
      (url.hostname === "ti.com" || url.hostname.endsWith(".ti.com")) &&
      !url.username &&
      !url.password
    ) {
      url.protocol = "https:"
      return url.href
    }
  } catch {}
  return fallback
}

export const normalizeProduct = (
  { store: product, information: info = {}, parametrics = {} }: TiProductRecord,
  currency = "USD",
): NormalizedPart => {
  const pn = validatePartNumber(product.tiPartNumber)
  const stock = integer(product.quantity)
  if (stock === null)
    throw new Error("TI returned missing or invalid inventory")
  const gpn = text(product.genericPartNumber)
  const selected = (Array.isArray(product.pricing) ? product.pricing : []).find(
    (p) => p?.currency === currency,
  )
  const priceBreaks: NormalizedPart["price_breaks"] = []
  for (const b of Array.isArray(selected?.priceBreaks)
    ? selected.priceBreaks
    : []) {
    const quantity = integer(b?.priceBreakQuantity)
    const price = number(b?.price)
    if (quantity !== null && quantity > 0 && price !== null)
      priceBreaks.push({ quantity, price })
  }
  priceBreaks.sort((a, b) => a.quantity - b.quantity)
  const description = text(product.description) || text(info.Description)
  const packageName = text(product.packageType)
  const pins = integer(product.pinCount)
  const lifecycle = text(product.lifeCycle)
  const parameters: Record<string, string> = {}
  for (const [key, value] of Object.entries({
    "Package / Case": packageName,
    "Pin Count": pins,
    Lifecycle: lifecycle,
    "TI Package": info.PackageType,
    "Pitch (mm)": info.Pitch,
    "Length (mm)": info.Length,
    "Width (mm)": info.Width,
    "Maximum Height (mm)": info.MaxHeight,
    "Lead Time (weeks)": info.LeadTimeWeeks,
  })) {
    if (typeof value === "string" && value.trim())
      parameters[key] = value.trim()
    if (typeof value === "number" && Number.isFinite(value))
      parameters[key] = String(value)
  }
  const paramText = (value: unknown) => {
    const result = text(value)
    return /^(null|undefined|n\/a)$/i.test(result) ? "" : result
  }
  for (const [name, raw] of Object.entries(parametrics)) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue
    const spec = raw as Record<string, unknown>
    const unit = paramText(spec.Unit)
    const range =
      spec.Range && typeof spec.Range === "object"
        ? (spec.Range as Record<string, unknown>)
        : {}
    const min = paramText(range.Min)
    const max = paramText(range.Max)
    const value =
      paramText(spec.Value) ||
      (min && max ? `${min}–${max}` : min ? `≥ ${min}` : max ? `≤ ${max}` : "")
    if (value) parameters[unit ? `${name} (${unit})` : name] = value
  }
  return {
    ti_product_number: pn,
    parametrics,
    ti_part_number: pn,
    supplier_part_number: pn,
    mfr: pn,
    generic_part_number: gpn,
    manufacturer: "Texas Instruments",
    package: packageName,
    pin_count: pins,
    description,
    detailed_description: text(info.Description) || description,
    stock,
    price: priceBreaks[0]?.price ?? null,
    price_quantity: priceBreaks[0]?.quantity ?? null,
    price_breaks: priceBreaks,
    currency,
    category: text(info.ProductFamilyDescription),
    subcategory: text(info.ProductFamilyDescription),
    product_url: tiUrl(
      product.buyNowUrl,
      `https://www.ti.com/product/${encodeURIComponent(gpn || pn)}/part-details/${encodeURIComponent(pn)}`,
    ),
    datasheet_url: tiUrl(
      info.DatasheetUrl,
      gpn ? `https://www.ti.com/lit/gpn/${encodeURIComponent(gpn)}` : "",
    ),
    photo_url: "",
    normally_stocking: stock > 0,
    discontinued: /obsolete|discontinued/i.test(lifecycle),
    marketplace: false,
    lifecycle,
    parameters,
  }
}

export const normalizeSearchResponse = (
  response: TiSearchResponse,
  currency = "USD",
): NormalizedPart[] => {
  const parts = response.products.map((record) =>
    normalizeProduct(record, currency),
  )
  return [
    ...new Map(
      parts.map((p) => [p.ti_product_number.toUpperCase(), p]),
    ).values(),
  ].sort((a, b) => b.stock - a.stock || a.mfr.localeCompare(b.mfr))
}

export const toSearchText = (part: NormalizedPart): string =>
  [
    part.mfr,
    part.generic_part_number,
    part.description,
    part.package,
    part.category,
    ...Object.entries(part.parameters).flat(),
  ]
    .join(" ")
    .toLowerCase()

const parameterId = (value: string): number => {
  let hash = 2166136261
  for (const char of value)
    hash = Math.imul(hash ^ char.charCodeAt(0), 16777619)
  return hash >>> 0
}

export const buildTiFilterOptions = (
  parts: NormalizedPart[],
): TiFilterOptions => {
  const attributes = new Map<string, Map<string, number>>()
  for (const part of parts)
    for (const [name, value] of Object.entries(part.parameters)) {
      const values = attributes.get(name) ?? new Map()
      values.set(value, (values.get(value) ?? 0) + 1)
      attributes.set(name, values)
    }
  return {
    Manufacturers: [
      {
        Id: "Texas Instruments",
        Value: "Texas Instruments",
        ProductCount: parts.length,
      },
    ],
    ParametricFilters: [...attributes.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, values]) => ({
        Category: { Id: "1", Value: "TI" },
        ParameterId: parameterId(name),
        ParameterName: name,
        FilterValues: [...values.entries()]
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([value, ProductCount]) => ({
            ValueId: String(parameterId(value)),
            ValueName: value,
            ProductCount,
          })),
      })),
  }
}

export const applyPostFilters = (
  parts: NormalizedPart[],
  request: SearchRequest,
): NormalizedPart[] =>
  parts.filter((part) => {
    if (request.inStock && part.stock <= 0) return false
    if (
      request.manufacturerNames.length &&
      !request.manufacturerNames.some(
        (v) => v.toLowerCase() === part.manufacturer.toLowerCase(),
      )
    )
      return false
    for (const [key, expected] of Object.entries(request.postFilters)) {
      if (
        key === "package" &&
        !part.package.toLowerCase().includes(expected.toLowerCase())
      )
        return false
      if (key === "num_pins" && part.pin_count !== Number(expected))
        return false
      if (
        key === "lifecycle" &&
        part.lifecycle.toLowerCase() !== expected.toLowerCase()
      )
        return false
      if (
        key === "package_code" &&
        (
          part.parameters["TI Package"] ??
          part.package.match(/\(([^)]+)\)/)?.[1] ??
          ""
        ).toLowerCase() !== expected.toLowerCase()
      )
        return false
    }
    return request.parametricFilters.every(
      (filter) =>
        filter.categoryId === "1" &&
        Object.entries(part.parameters).some(
          ([name, value]) =>
            parameterId(name) === filter.parameterId &&
            (filter.valueIds.includes(String(parameterId(value))) ||
              filter.valueIds.includes(value)),
        ),
    )
  })
