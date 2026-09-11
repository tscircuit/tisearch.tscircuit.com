export interface Env {
  DB: D1Database
  TI_CATALOG_TTL_SECONDS?: string
  TI_CATALOG_MAX_AGE_SECONDS?: string
}

export interface PriceBreak {
  quantity: number
  price: number
}

export interface NormalizedPart {
  ti_part_number: string
  supplier_part_number: string
  mfr: string
  generic_part_number: string
  manufacturer: "Texas Instruments"
  description: string
  package: string
  pin_count: number | null
  stock: number
  price: number | null
  price_quantity: number | null
  currency: string
  price_breaks: PriceBreak[]
  minimum_order_quantity: number | null
  standard_pack_quantity: number | null
  order_limit: number | null
  lifecycle: string
  product_url: string
  datasheet_url: string
  categories: string[]
  cad: {
    status: "lookup_required"
    source: "easyeda"
    lookup_url: string
  }
}

export interface SearchRequest {
  query: string
  limit: number
  offset: number
  package: string
  pinCount: number | null
  lifecycle: string
  genericPartNumber: string
  inStock: boolean
  category?: string
}

export interface CatalogSnapshot {
  id: string
  imported_at: number
  part_count: number
  currency: string
}

export interface SearchPayload {
  query: string
  components: NormalizedPart[]
  total: number
  limit: number
  offset: number
  source: "ti"
  cached: true
  stale: boolean
  catalog_updated_at: string
  cache_expires_at: string
  currency: string
}
