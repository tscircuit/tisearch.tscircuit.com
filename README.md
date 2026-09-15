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

- **Bulk catalog import** downloads the TI Store catalog once daily using
  `/v2/store/products/catalog?currency=USD&exclude-evms=true`. The shared gateway
  reserves a separate four-hour-plus-one-minute interval before sending a request,
  including failed attempts, across currencies and restarts. It streams the response
  into private R2 chunks; no full-catalog JSON is buffered in Worker memory or the
  gateway cache. Only a fully downloaded, validated snapshot is imported.
- **Resumable D1 import** processes 500 saved records per Durable Object alarm,
  using batches of 50 writes. Retrying a chunk is safe. Existing metadata and newer
  inventory are preserved, and known categories can be reused for variants of the
  same base product. Missing categories/specifications remain unknown until enriched.
  Invalid records are counted as rejected. The previous snapshot is removed when
  starting the next download; existing parts absent from a snapshot are retained.
- **Bulk progress** is available at `/api/catalog/status`. `downloaded` and
  `processed` count snapshot records, not unique D1 rows. The five-minute cron
  wakes the importer; durable alarms handle progress and daily refreshes. The
  status endpoint is read-only and cannot initiate TI requests.

- **D1** stores normalized parts, specifications, prices, and inventory. FTS5
  indexes keyword searches; category, orderable/base part, and freshness indexes
  support catalog reads and refresh selection. Existing stored parts are retained
  when applying migrations.
- **Scheduled discovery**, every six hours, queues up to 100 family products
  with one metadata request. A D1 cursor and lease preserve progress across runs. Successful runs
  advance the cursor; throttled runs retain data and back off. A completed family
  is revisited after 30 days.
- **Scheduled inventory refresh**, every 15 minutes, updates up to 20 of the
  pending imports or oldest listings whose inventory is at least 24 hours old. It uses the Store
  API only and preserves indexed specifications. Failed refreshes retain the
  last successful inventory timestamp.
- **Scheduled specification refresh**, every six hours, enriches up to five
  indexed parts whose specifications have not been checked in 30 days. Inventory
  timestamps are preserved.
- **TiGateway**, a shared Durable Object, authenticates only for cache misses,
  spaces uncached calls, and honours independent TI API cooldowns. Product
  Information metadata is cached for 30 days and Store inventory for 24 hours.
  Tokens are kept only in memory.

Only scheduled jobs and the bulk importer contact TI. Public searches cannot exhaust TI quota.
TI's [published limits](https://www.ti.com/developer-api/store-api/reference/response-codes-rate-limits.html)
include 2,000 Product Information requests per month, so discovery is deliberately
bounded. Quota exhaustion can delay new imports, but existing pages remain
available from D1.

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
