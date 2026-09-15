# TI Parts Search

Search Texas Instruments parts, browse product families, and check stored
inventory, pricing, specifications, packages, and datasheets.

**[tisearch.tscircuit.com](https://tisearch.tscircuit.com)**

An unofficial service maintained by tscircuit. Part data comes from TI's official
APIs and is stored in Cloudflare D1.

## Searching

Every page and public API request reads the indexed D1 catalog. Opening a page,
changing filters, or searching never calls TI or queues an upstream refresh.
TI authentication failures and rate limits therefore cannot block browsing.

All matching stored parts appear together on one page. There are no Next or
Previous controls, and legacy listing `limit`/`offset` parameters do not truncate
results. Electrical filters apply to the full stored category. General search
responses stream from D1 in batches, keeping server memory bounded while returning
one complete HTML page or JSON array.

Search by orderable part number, base part number, product family, or keywords.
Shared category pages include stored stock snapshots; general search returns
in-stock matches. Additional TI-specific listings include an **In stock** filter.
Filters include package, pin count, lifecycle, resolution, channels, output
voltage, memory, and the route-specific parameters listed in the API contract.
Unknown specifications do not satisfy a filter. TI-specific routes also expose
raw TI parametric filters. Converter routes filter by topology.

The homepage uses the shared category directory, order, labels, and compact
table/forms interface. The full route and parameter contract is documented in
[API compatibility](docs/api-compatibility.md). Existing TI-specific category
URLs remain available as additional routes.

## API

```sh
# Every stored part in a category
curl 'https://tisearch.tscircuit.com/dcdc_converters/list.json'

# Filter the entire stored category
curl 'https://tisearch.tscircuit.com/dcdc_converters/list.json?output_voltage_max=12'

# Exact/base part or keyword search
curl 'https://tisearch.tscircuit.com/api/search?q=TPS62160'
curl 'https://tisearch.tscircuit.com/components/list.json?search=buck'

# Compact results for programmatic search clients (limit 1–50, default 10)
curl 'https://tisearch.tscircuit.com/api/index/search?q=buck&limit=10'
```

Listing endpoints support `.json`, `?json=true`, or `Accept: application/json`.
Category JSON uses its category key; `/api/search` returns `components` directly.
Shared category endpoints return their established response keys, including
`multiplexers` for analog multiplexers and `switches` for analog switches.
HTML, `.json`, `?json=true`, and `Accept: application/json` are supported.
`cachebust=1` or `cachebust=true` bypasses response caching without contacting TI.
The `x-data-source: d1` and `x-catalog-complete: false` headers identify stored,
incomplete catalog data. TI-specific extension routes retain their richer
metadata envelope.

Categories for which no matching TI products have been imported return empty
arrays with HTTP 200. TI does not provide LCSC identifiers or assembly-library
Basic/Preferred classifications: these fields remain null, and filters requiring
those classifications cannot match. LCSC-addressed CAD endpoints return the
compatible invalid-ID or not-found response; this service does not fetch parts
or CAD data from JLCSearch or EasyEDA.

Parts retain TI identities, stock, currency, price breaks, raw `parametrics`,
readable `parameters`, and product/datasheet links. `price1` is null unless TI
quotes quantity one. TI-specific extension endpoints expose inventory timestamps and freshness.
All stock values are stored snapshots. Older inventory stays visible while
background refreshes are delayed.

Other endpoints include `/categories/list`, `/package_index/list`, and `/health`.

## Storage and background synchronization

Catalog population is disabled with `TI_CATALOG_POPULATION_ENABLED = "false"`.
The existing 67,549 parts are retained. New-part discovery, pending imports for
unknown parts, bulk downloads, and bulk import alarms are disabled. Existing R2
snapshots and discovery queues are retained without importing additional parts.

The bulk importer remains available in the code for an explicit future opt-in.
`/api/catalog/status` exposes the last import's counts and `populationEnabled`;
`nextDownloadAt` is null while disabled. The endpoint cannot start an import.

- **D1** stores normalized parts, specifications, prices, and inventory. FTS5
  indexes keyword searches; category, orderable/base part, and freshness indexes
  support catalog reads and refresh selection. Existing stored parts are retained
  when applying migrations.
- **Scheduled inventory refresh**, every 15 minutes, updates up to 20 existing
  listings. Queued metadata is applied only to parts already in D1; otherwise the
  oldest listings whose inventory is at least 24 hours old are refreshed. Failed
  refreshes retain the last successful inventory timestamp.
- **Scheduled specification refresh**, every six hours, enriches up to five
  indexed parts whose specifications have not been checked in 30 days. Inventory
  timestamps are preserved.
- **TiGateway**, a shared Durable Object, authenticates only for cache misses,
  spaces uncached calls, and honours independent TI API cooldowns. Product
  Information metadata is cached for 30 days and Store inventory for 24 hours.
  Tokens are kept only in memory.

Only background jobs contact TI. Public searches cannot exhaust TI quota.
The one-time metadata enrichment job is enabled with
`TI_METADATA_ENRICHMENT_ENABLED = "true"`, independently of population.

1. Scan TI Product Information (`/v1/products?Page=…&Size=100`), saving pages in
   private R2 storage. Match orderable part numbers and update existing D1 rows only.
2. Look up remaining unmatched orderable parts individually. A TI 404 is recorded
   as unavailable and does not remove the stored part.
3. Fetch missing electrical parametrics per orderable part. Reuse specifications
   already stored; do not assume different package variants have identical ratings.

`ti_information` preserves TI's original product details and `ti_family` preserves
its family. `category_routes` lists matching existing routes using their family
and electrical rules; `category_mapping_status` is `mapped` or `unresolved`.
The existing public category taxonomy is unchanged. Unknown families remain
searchable without guessed category assignments. Metadata is available through
`/api/index/search?q=PART_NUMBER`; category APIs retain their existing schema.

The MetadataEnricher Durable Object persists progress and runs at most 1,500
metadata requests per rolling 24 hours, with two seconds between successful steps.
The shared gateway also paces requests and enforces TI cooldowns. Large metadata
pages are stored in R2 instead of exceeding Durable Object cache value limits.
TI [documents a default Product Information allowance of 3,000 calls per day](https://www.ti.com/developer-api/product-information-api-suite/product-information-api.html);
actual account limits and Retry-After responses take precedence. Full electrical
enrichment can take weeks because it requires individual product requests.

`/api/enrichment/status` reports progress, quota backoff, metadata coverage, and
mapped part counts. It is read-only and cannot start work. Scheduled ticks resume
the job; it stops after all existing rows have been checked. Setting the enrichment
flag to false disables its alarms. The old discovery/import queues remain paused
while enrichment is active. Periodic specification refresh resumes after this job
finishes. Inventory refresh continues throughout; metadata writes preserve stock,
prices, and inventory timestamps and retry concurrent updates safely.

## Development and deployment

Requires Bun. TI credentials are needed for background synchronization, not for
reading an already populated local catalog.

```sh
bun install
cp .dev.vars.example .dev.vars
# Configure TI_CLIENT_ID and TI_CLIENT_SECRET for synchronization.
bun run db:migrate
bun run dev

bun run test
bun run typecheck
bun run format:check
bun run build
```

Tests use fixture data and local Cloudflare storage; they do not contact TI.

`wrangler.toml` configures the Worker, D1 database, Durable Object, domain, and
cron schedules in the tscircuit Cloudflare account. Deployment applies additive
D1 migrations before publishing the Worker:

```sh
bun x wrangler secret put TI_CLIENT_ID
bun x wrangler secret put TI_CLIENT_SECRET
bun run deploy
```

For another installation, create its D1 database and update the account, database,
and domain configuration. The optional GitHub Actions deployment workflow uses
`CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN`, and `TI_DEPLOY_ENABLED=true`.

## License

Source code is licensed under the [MIT License](LICENSE).
TI product data is subject to [TI's API terms](https://www.ti.com/developer-api/store-api/reference/api-terms-of-use.html).
