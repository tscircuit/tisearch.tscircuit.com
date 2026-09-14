# TI Parts Search

Search Texas Instruments parts, browse product families, and check stock,
pricing, packages, and datasheets.

**[tisearch.tscircuit.com](https://tisearch.tscircuit.com)**

An unofficial service maintained by tscircuit, powered by TI's official APIs.
Built with TypeScript, Cloudflare Workers, and D1.

## Searching

- Search an exact orderable part number, such as `TPS62160DSGR`, or a base part
  number, such as `TPS62160`.
- Browse categories or search the beginning of a TI product family name, such
  as `DC/DC converters` or `Comparators`.
- Filter by inventory, package, pin count, lifecycle, and product parameters.
- View recently retrieved parts on the homepage.

Listings include out-of-stock parts by default. Select **In stock** to hide
parts with zero available inventory. TI groups buck, boost, and buck-boost
converters under the broader **DC/DC converters** family.

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
accepts 1–20 results (default 20 for searches, 5 for categories); `offset` must
be a multiple of `limit`. `total` counts matches on the current page;
`upstream_total` is TI's count before local filtering. Follow `next_offset`
for subsequent pages, including when filters leave a page empty.

Keyword searches use the local index, return `partial: true`, and do not
search TI's entire catalog. Other endpoints include `/categories/list`,
`/package_index/list`, and `/health`.

## Data freshness

Results are cached for 24 hours. Expired results may be served for seven more
days while refreshing in the background; responses include `cached`, `stale`,
and `cache_expires_at` metadata. A scheduled job refreshes popular expired
queries every six hours with bounded requests and throttling checks.

The homepage reads cached parts updated within the last 24 hours without
making additional TI requests. Stock and prices can change between refreshes.

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

`wrangler.toml` configures the production Worker, domain, D1 database, and
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
