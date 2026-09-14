# tisearch.tscircuit.com

An unofficial, in-stock TI parts search engine for tscircuit, following
[digikeysearch](https://github.com/tscircuit/digikeysearch.tscircuit.com) and
[mousersearch](https://github.com/tscircuit/mousersearch.tscircuit.com).
The Cloudflare Worker loads TI data on demand, caches requests in D1, indexes
returned parts, and serves the same category routes, JSON discovery, filters,
and compact table UI.

## API

```sh
curl 'https://tisearch.tscircuit.com/api/search?q=TPS62160DSGR'
curl 'https://tisearch.tscircuit.com/api/search?q=TPS62160&limit=20'
curl 'https://tisearch.tscircuit.com/buck_converters/list.json?package=WSON&num_pins=8'
curl 'https://tisearch.tscircuit.com/api/search?q=RF-sampling&mode=family'
curl 'https://tisearch.tscircuit.com/api/index/search?q=buck'
```

Search responses use the same common component fields as the other suppliers:
`ti_product_number`, `supplier_part_number`, `mfr`, `manufacturer`, `package`,
`description`, `stock`, `price`, `category`, `parameters`, and product/datasheet
links. TI-specific fields include the base part number, pin count, currency,
price breaks, and `price_quantity`. Missing prices are `null`; interpret every
price with its quantity and currency. `ti_part_number` aliases the TI OPN.

Every category page supports `.json`, `?json=true`, and `Accept: application/json`.
`/api/search` always returns JSON with `components`, `query`, `total`,
`filter_options`, `source`, `cached`, `stale`, and `cache_expires_at`.
Category responses use their category key and a `meta` object.
`/categories/list` lists the family shortcuts and learned categories;
`/footprint_index/list` (also `/package_index/list`) lists learned package names.
`/health` checks Worker liveness.

## TI search adapter

TI's documented APIs differ from the distributors' keyword endpoints:

- **Part numbers:** an exact Store V2 OPN lookup is attempted first. A 404 falls
  back to Store V2's paginated `gpn` query using the same text. Packing suffixes
  and `/NOPB` remain intact; the returned OPN/GPN is checked. No full catalog
  request is made.
- **Families:** Product Information V1 lists products whose
  `ProductFamilyDescription` starts with the supplied text. Category routes
  supply family prefixes. Each returned OPN is checked against Store V2 for
  inventory and pricing; Product Information's `InventoryStatus` is not used.
  Family shortcuts are editable presets, not an exhaustive TI taxonomy.
- **Local keywords:** `/api/index/search` searches D1/FTS for previously seen
  products. It returns `source: "ti-d1-index"` and `partial: true`; it is not a
  complete TI catalog search and does not call upstream APIs.

`mode=part` or `mode=family` selects the upstream operation. By default,
part-like queries containing a digit use part lookup; other queries use family
prefix search. TI does not document arbitrary description keyword search.

`limit` is 1–20 (default 20), and `offset` must be a multiple of `limit`.
Family requests use at most one discovery request plus 20 Store lookups.
`total` counts matched products **on the current page** after stock and filters;
`upstream_total` is TI's count before local filtering. Use `next_offset` to
continue even if a page has no matching in-stock results. Results sort by stock
within each page; there is no claim of globally sorting the TI catalog.

Filters include `package` (substring), `num_pins`/`pin_count`, `lifecycle`,
`package_code` (TI code such as DSG), `manufacturer`, and the `param_*` choices
shown in the UI. `in_stock=false` includes out-of-stock Store listings.
Pin count, lifecycle, and TI package code are sent upstream for family queries;
other filters apply to the fetched page. Filter choices come from that page's
returned product fields, not a full parametric API crawl.

## Cache and indexing model

- Exact requests are cached in D1 for 24 hours by default.
- Expired responses can be served for seven additional days while the Worker
  refreshes them in the background. Failed refreshes retain the prior cache.
- Every returned Store product updates the `parts` table and FTS index,
  including stock changes for products excluded by the current filters.
- A six-hour Worker cron refreshes up to 20 of the most-used expired requests.
  It bounds Store fan-out per invocation and stops on upstream throttling or
  a reported remaining-quota floor.
- OAuth tokens stay in Worker memory; credentials and tokens are never written
  to D1 or sent to clients. The only supplier requests go to `transact.ti.com`.

## Setup

```sh
bun install
bun x wrangler d1 create tisearch
# Replace the placeholder database_id in wrangler.toml with the new D1 ID.
bun x wrangler secret put TI_CLIENT_ID
bun x wrangler secret put TI_CLIENT_SECRET
bun run deploy
```

The TI application needs approved access to Store inventory/pricing and, for
family searches, Product Information. For local development, copy
`.dev.vars.example` to `.dev.vars`, fill in the credentials, then:

```sh
bun run db:migrate
bun run dev
bun run test
bun run typecheck
bun run format:check
bun run build
```

Tests use synthetic TI responses and real local D1 migrations/FTS. Live
TI authentication and a Store inventory/pricing lookup were verified on
14 September 2026. This repository
is a search service; it does not add CLI import commands or TSX conversion.

## Deployment

The Worker and D1 database are configured in the `tscircuit` Cloudflare account
(`0f355c6f0542dd04cc3fc370c67366a2`). The checked-in D1 ID refers to this
service’s production database.

Set GitHub Actions secrets `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN`,
configure the D1 ID and Worker secrets above, then set `TI_DEPLOY_ENABLED=true`.
The deployment workflow validates the project, applies migrations, and deploys
on main-branch pushes or manual runs. Refresh scheduling is configured in
`wrangler.toml`; no separate catalog-sync workflow or bootstrap import is needed.

This is an independent tscircuit service. Public use of TI data remains subject
to [TI's API agreement](https://www.ti.com/developer-api/store-api/reference/api-terms-of-use.html),
including permission for the intended public display and redistribution.

Upstream contracts: [Store V2](https://www.ti.com/content/dam/developer-api/inventory-pricing-api.yaml),
[Product Information V1](https://www.ti.com/content/dam/developer-api/product-information-api.yaml).
