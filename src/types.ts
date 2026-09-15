import type { MetadataEnricher } from "./metadata-enricher"
import type { BulkCatalogImporter } from "./bulk-catalog"
import type { TiGateway } from "./ti-gateway"
export interface Env {
  METADATA_ENRICHMENT: DurableObjectNamespace<MetadataEnricher>
  TI_METADATA_ENRICHMENT_ENABLED?: string
  TI_CATALOG: R2Bucket
  BULK_IMPORT: DurableObjectNamespace<BulkCatalogImporter>
  DB: D1Database
  TI_GATEWAY?: DurableObjectNamespace<TiGateway>
  TI_CLIENT_ID: string
  TI_CLIENT_SECRET: string
  TI_CATALOG_POPULATION_ENABLED?: string
  TI_CURRENCY?: string
  TI_CACHE_TTL_SECONDS?: string
  TI_STALE_TTL_SECONDS?: string
  TI_MIN_REMAINING?: string
}

export interface TiFilterOptions {
  Manufacturers?: Array<{ Id?: string; Value?: string; ProductCount?: number }>
  ParametricFilters?: Array<{
    Category?: { Id?: string; Value?: string }
    ParameterId?: number
    ParameterName?: string
    FilterValues?: Array<{
      ValueId?: string
      ValueName?: string
      ProductCount?: number
    }>
  }>
}

export interface SearchRequest {
  query: string
  mode: "part" | "family"
  limit: number
  offset: number
  responseKey: string
  sourceKind: "search" | "category"
  inStock: boolean
  postFilters: Record<string, string>
  manufacturerNames: string[]
  parametricFilters: Array<{
    categoryId: string
    parameterId: number
    valueIds: string[]
  }>
}

export interface NormalizedPart {
  [key: string]: unknown
  price1: number | null
  num_pins: number | null
  ti_product_number: string
  ti_part_number: string
  supplier_part_number: string
  mfr: string
  generic_part_number: string
  manufacturer: string
  package: string
  pin_count: number | null
  description: string
  detailed_description: string
  stock: number
  price: number | null
  price_quantity: number | null
  price_breaks: Array<{ quantity: number; price: number }>
  currency: string
  category: string
  subcategory: string
  product_url: string
  datasheet_url: string
  photo_url: string
  normally_stocking: boolean
  discontinued: boolean
  marketplace: boolean
  lifecycle: string
  parameters: Record<string, string>
  parametrics?: Record<string, unknown>
}

export interface TiProductRecord {
  store: Record<string, unknown>
  information?: Record<string, unknown>
  parametrics?: Record<string, unknown>
}

export interface TiSearchResponse {
  inventoryUpdatedAt?: number
  partial?: boolean
  expiresAt?: number
  products: TiProductRecord[]
  upstreamTotal: number
  nextOffset: number | null
}

export interface UpstreamSearchResult {
  response: TiSearchResponse
  rateLimitRemaining: number | null
}

export interface SearchPayload {
  partial?: boolean
  warnings?: string[]
  filter_scope?: "page" | "catalog"
  last_updated_at?: string | null
  catalog_complete?: boolean
  query: string
  components: NormalizedPart[]
  total: number
  upstream_total: number | null
  limit: number
  offset: number
  next_offset: number | null
  filter_options: TiFilterOptions
  source: "ti" | "ti-d1-index"
  cached: boolean
  stale: boolean
  cache_expires_at: string
}

export interface SearchCacheRow {
  cache_key: string
  query: string
  request_json: string
  response_json: string
  response_key: string
  source_kind: "search" | "category"
  created_at: number
  refreshed_at: number
  expires_at: number
  stale_until: number
  last_accessed_at: number
  access_count: number
  api_rate_limit_remaining: number | null
}
