# TI Parts Search

Search Texas Instruments parts, browse product families, and check stock,
pricing, packages, and datasheets.

**[tisearch.tscircuit.com](https://tisearch.tscircuit.com)**

An unofficial service maintained by tscircuit, powered by TI's official APIs.
Built with TypeScript, Cloudflare Workers, D1, and a shared Durable Object.

## Searching

- Search an exact orderable part number, such as `TPS62160DSGR`, or a base part
  number, such as `TPS62160`.
- Browse categories or search the beginning of a TI product family name, such
  as `DC/DC converters` or `Comparators`.
- Filter by inventory, package, pin count, lifecycle, and product parameters.
- Browse all category shortcuts from the compact homepage.

Listings include out-of-stock parts by default. Select **In stock** to hide
parts with zero available inventory. TI groups buck, boost, and buck-boost
converters under the broader **DC/DC converters** family. The buck, boost, and
buck-boost URLs apply a topology filter to TI specifications.

## Categories

Browse 66 category links organized into 14 groups: power management, battery
management, amplifiers, data converters, interface, logic and voltage
translation, switches and multiplexers, motor drivers, sensors, isolation,
embedded processing, audio, clocks and timing, and wireless connectivity.

Links use verified TI API family names. Broad topics are split into specific
families where needed, such as precision/high-speed ADCs, USB hubs/USB-C Power
Delivery, and individual logic gate types. Some links share an API family;
for example, analog switches and signal multiplexers. Each page identifies
its TI family. This is a curated directory, not TI's complete taxonomy.

Category definitions and representative part numbers are in
`src/category-data.json`. Opening the directory does not call TI; product data
is loaded only when searching or opening a category, five products at a time.

## API

```sh
# Orderable part number
curl 'https://tisearch.tscircuit.com/api/search?q=TPS62160DSGR'

# Base part number
curl 'https://tisearch.tscircuit.com/api/search?q=TPS62160'

# Product family, in-stock only
curl 'https://tisearch.tscircuit.com/dcdc_converters/list.json?in_stock=true'

# Keyword search over previously retrieved in-stock parts
curl 'https://tisearch.tscircuit.com/api/index/search?q=buck'
```

`/api/search` returns a `components` array with part numbers, descriptions,
stock, currency, quantity-based price breaks, packages, and product/datasheet
links. A missing price is `null`. Category endpoints return their category key
and a `meta` object. Listing pages support `.json`, `?json=true`, or an
`Accept: application/json` header.

Use `mode=part` or `mode=family` to select a search mode explicitly. `limit`
accepts 1–20 results (default 20 for searches, 5 for categories); `offset`
accepts any nonnegative integer up to 100000. The adapter converts offsets
to TI integer pages, fetching a second page only when required. `total` counts matches on the current page;
`upstream_total` is TI's count before local filtering. Follow `next_offset`
for subsequent pages, including when filters leave a page empty.

Keyword searches use the local index, return `partial: true`, and do not
search TI's entire catalog. Other endpoints include `/categories/list`,
`/package_index/list`, and `/health`.

Each result includes specifications returned by TI's Product Information
parametrics endpoint, alongside Store inventory and pricing. The `parameters`
map contains readable values with units and ranges; `parametrics` preserves
TI's original specification objects, including descriptions and range bounds.
Filter dropdowns cover all parameters present on the current page.

A family page makes at most two discovery requests, one Store request per
product, and one parametrics request per Store listing. Default category pages
remain limited to five products; cached searches make no upstream requests.
TI listings without parametric records still appear with their available
package information. An upstream rate-limit response stops the refresh.

Named filters include `resolution_bits`, `num_channels`, `channel_count`,
`output_type`, `output_voltage`, `output_voltage_min`, `output_voltage_max`,
`core`, `flash_min`, and `ram_min`. Pin count becomes TI's `Pin`,
`package_code` becomes `PackageType`, and lifecycle becomes `LifeCycleStatus`.
Electrical filters run locally against TI parametrics; they are not sent as
unsupported query parameters to TI. Filters apply to the fetched page, not
TI's entire catalog. Missing specifications do not match a filter.

`output_voltage_min` selects parts with a rated minimum at or below the
requested value; `output_voltage_max` selects parts with a rated maximum at
or above it. Memory thresholds use bytes. Responses include normalized
numeric fields, `num_pins`, and `price1` (null unless TI quotes quantity one).
`subcategory_name` accepts the configured category names. Compatibility routes
include `/voltage_regulators/list.json` (key `regulators`),
`/analog_multiplexers/list.json`, and `/microcontrollers/list.json`.
Supplier inventory flags `is_basic`, `is_preferred`, and `lcsc` are unavailable
for TI and return a validation error.

## Data freshness

Results are cached for 24 hours. Expired results may be served for seven more
days while refreshing in the background; responses include `cached`, `stale`,
and `cache_expires_at` metadata. A scheduled job refreshes popular expired
queries every six hours with bounded requests and throttling checks.

The `TiGateway` Durable Object shares raw TI responses across all Worker
instances and query/filter variants. Uncached requests are serialized at
most twice per second. On HTTP 429 it persists a cooldown of at least 60
seconds (or longer when TI supplies `Retry-After`) and makes no automatic
retries. Cached URLs remain available during the cooldown. A cold throttled
request returns HTTP 429 with `Retry-After`, rather than a misleading 503.
OAuth tokens are shared only in memory; credentials and tokens are never
written to the gateway's persistent storage.

Gateway responses expire after 24 hours, with one-hour negative caching for
missing products. D1 freshness never extends beyond its source responses'
expiry. Expired gateway entries are cleaned up daily.

The homepage and category directory do not call TI. Stock and prices can
change between refreshes.

## Local development

Requires Bun and TI credentials with access to the Store inventory/pricing API
and Product Information API.

```sh
bun install
cp .dev.vars.example .dev.vars
# Set TI_CLIENT_ID and TI_CLIENT_SECRET in .dev.vars.
bun run db:migrate
bun run dev
```

Run checks with:

```sh
bun run test
bun run typecheck
bun run format:check
bun run build
```

`bun run build` performs a Worker dry run. Tests use fixtures and a local D1
database; they do not call TI's APIs.

## Deployment

`wrangler.toml` configures the production Worker, domain, D1 database, Durable
Object binding/migration, and
scheduled refresh in the tscircuit Cloudflare account. For a separate
installation, create a D1 database with `bun x wrangler d1 create tisearch`
and update the account, database, and domain configuration first.

Store credentials as Worker secrets, then apply migrations and deploy:

```sh
bun x wrangler secret put TI_CLIENT_ID
bun x wrangler secret put TI_CLIENT_SECRET
bun run deploy
```

The optional GitHub Actions deployment workflow requires the
`CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN` repository secrets and the
`TI_DEPLOY_ENABLED=true` repository variable.

## License

The source code is licensed under the [MIT License](LICENSE).
TI product data is subject to [TI's API terms](https://www.ti.com/developer-api/store-api/reference/api-terms-of-use.html).
