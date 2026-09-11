# tisearch.tscircuit.com

Unofficial Texas Instruments parts search for tscircuit. Follows
[digikeysearch.tscircuit.com](https://github.com/tscircuit/digikeysearch.tscircuit.com):
a TypeScript Cloudflare Worker, D1/FTS index, compact server-rendered tables,
category routes, `.json` discovery, Bun, Vitest, Biome, and GitHub Actions.

TI's Store API supports a full catalog rather than general keyword search.
A scheduled job imports that catalog into D1; user searches query the index.
The Worker has no TI credentials and never spends TI quota on user traffic.

## API

```sh
curl 'https://tisearch.tscircuit.com/api/search?q=TPS62160&limit=10'
curl 'https://tisearch.tscircuit.com/buck_converters/list.json?package=WSON&pin_count=8'
curl 'https://tisearch.tscircuit.com/ldos/list.json?in_stock=false'
curl 'https://tisearch.tscircuit.com/footprint_index/list.json'
curl 'https://tisearch.tscircuit.com/api/status'
```

These URLs require the service to be deployed and its first catalog synchronized.
`/health` is a liveness check; `/api/status` reports catalog readiness. An empty or
excessively old catalog returns 503 instead of a misleading zero-result search.

`/api/search` and its `/api/index/search` alias return:

```json
{
  "query": "TPS62160",
  "components": [],
  "total": 0,
  "limit": 10,
  "offset": 0,
  "source": "ti",
  "cached": true,
  "stale": false,
  "catalog_updated_at": "2026-09-11T00:00:00.000Z",
  "cache_expires_at": "2026-09-11T06:00:00.000Z",
  "currency": "USD"
}
```

This is an illustrative empty response, not live inventory. Each component has
`ti_part_number`, `supplier_part_number`, `mfr` (the exact orderable part number),
`generic_part_number`, `manufacturer`, `description`, `package`, `pin_count`,
`stock`, `price`, `price_quantity`, `currency`, `price_breaks`, `lifecycle`,
`product_url`, `datasheet_url`, order quantities, and `cad` lookup metadata.

- `price` is the first available quantity break, and **must** be interpreted with
  `price_quantity` and `currency`; unavailable pricing is `null`, never zero.
- OPNs stay distinct from GPNs, including packing suffixes and `/NOPB`.
- Category routes return `{ [categoryKey]: [...], meta: {...} }`. For example,
  `/voltage_regulators/list.json` uses `regulators`, matching the existing service
  convention. `/categories/list.json` lists every route and response key.
- HTML routes also accept `?json=true` or `Accept: application/json`.
- Search: `q` or `search`, `limit` (1–100), `offset`, `package` (literal substring),
  `pin_count` / `num_pins`, `lifecycle`, `gpn`, and `in_stock` (defaults to `true`).
- Keyword terms are ANDed, with prefix matching. Results sort exact OPN first,
  then stock descending, then part number. Pagination and totals apply after
  all filters to the entire active catalog.
- Category membership is a description-based heuristic, not TI's official
  parametric taxonomy. No voltage/current limits or pin mappings are inferred.
- `/footprint_index/list` is a **package-name index**, not downloadable footprints.

## Local development

Requires Bun 1.3.14+ and Node.js 22+.

```sh
bun install
bun run db:migrate
bun run sync:local --catalog test/fixtures/catalog.json
bun run dev
```

The fixture is explicitly synthetic and has no live stock/price guarantees.
File/fixture ingestion is refused with `--remote`.

For actual TI data, copy `.env.example` to `.env`, fill your approved TI
credentials, and run `bun run sync:local`. Bun loads `.env`; the file is ignored.
Never commit or embed keys in client-side code. Authenticated TI responses have
not been verified for this initialization without an approved account's keys.

```sh
bun run test
bun run typecheck
bun run format:check
bun run build
```

Tests run in workerd against real D1 migrations and FTS, including snapshot
activation, filtered counts/pagination, stale data, slash-suffixed OPNs,
OAuth/rate-limit failures, currency handling, and exact CAD matching.

## Catalog synchronization

The job uses `POST /v1/oauth/accesstoken` (OAuth client credentials) followed by
`GET /v2/store/products/catalog?currency=USD&exclude-evms=true`.

- A six-hour GitHub Actions schedule runs the full import outside Worker memory
  and execution limits. This intentionally differs from DigiKey's small
  per-query refreshes because TI supplies a full catalog.
- A D1 lease permits at most one catalog attempt every four hours, shared by
  scheduled and manual jobs against that database. A failed attempt retains the
  lease; there is no automatic retry, including on 429. Separate databases or
  other applications using the same TI credentials must coordinate their quota.
- The whole catalog is validated before SQL generation. Empty catalogs, invalid
  inventory, and duplicate OPNs fail the job and preserve the active catalog.
- Each import writes an immutable snapshot. A final pointer switch occurs only
  when its expected row count is present. Old snapshots are retained for 24 hours
  for in-flight readers and removed on later successful syncs.
- After six hours the API labels data stale. After seven days it returns 503.
  These are configurable via `TI_CATALOG_TTL_SECONDS` and
  `TI_CATALOG_MAX_AGE_SECONDS`, subject to the data-use agreement.
- Inventory reflects the catalog's fetch time; confirm current availability and
  purchase quantities on TI.com. Product Information V1 is not used as a stock API.

## TI parts to TSX

**Confirmed for TI parts with an exact supported EasyEDA/JLC CAD match.** The
buying API itself supplies neither pad geometry nor schematic pin mappings.

Install the tscircuit CLI (`npm install -g tscircuit`), then:

```sh
bun run import:part TPS62160DSGR
# Or choose a destination directory:
bun run import:part TPS62160DSGR --out ./my-circuit/imports
```

The helper searches JLC by exact OPN, rejects absent/ambiguous matches, invokes
`tsci import C... --use-exact-footprint`, checks the resulting TSX part identity,
and writes the component plus a provenance JSON file. Existing files are not
silently overwritten. Electrical/package suitability still needs datasheet review.

The catalog's `cad.status: "lookup_required"` is intentional: being present in
TI's catalog does not prove that importable CAD exists. TI-only parts without a
CAD match remain searchable. Broader coverage requires another authorized CAD
provider or a separately verified component definition.

See [live import verification](docs/import-verification.md) for the tested
TPS62160DSGR conversion, compiled pad/port counts, and its datasheet pin check.

This repository initializes the **search service and a standalone import helper**.
It does not modify `@tscircuit/cli`; `tsci search --ti` and `tsci import --ti`
need a follow-up CLI PR. The existing `tsci import` path is used for conversion.

## Deployment

Before publicly serving TI API data, obtain TI's written consent for the intended
public display, caching/indexing, and JSON redistribution. Access credentials
alone do not grant that permission: see [API terms §2(i)](https://www.ti.com/developer-api/store-api/reference/api-terms-of-use.html)
and the [third-party developer addendum](https://www.ti.com/developer-api/store-api/reference/api-third-party-developer-terms.html).

```sh
bun x wrangler d1 create tisearch
# Replace the placeholder database_id in wrangler.toml with this new D1 ID.
bun run deploy
```

Configure GitHub Actions secrets:

- `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN` for this Worker and D1.
- `TI_CLIENT_ID` and `TI_CLIENT_SECRET` for the catalog sync job only.

After configuring D1, set repository variable `TI_DEPLOY_ENABLED=true` to enable
the main-branch/manual deploy workflow. It runs validation before deploying.
Set `TI_SYNC_ENABLED=true` and manually run **Sync TI catalog** for the first
import; subsequent runs occur every six hours. Both workflows share concurrency
so migrations, deployments, and syncs cannot overlap in GitHub Actions.
CI runs on PRs without credentials. No production data or credentials are included.

## References

- [TI inventory/pricing OpenAPI](https://www.ti.com/content/dam/developer-api/inventory-pricing-api.yaml)
- [TI authentication](https://www.ti.com/developer-api/product-information-api-suite/authentication.html)
- [TI rate limits](https://www.ti.com/developer-api/store-api/reference/response-codes-rate-limits.html)
- [TI's CAD/Ultra Librarian workflow](https://e2e.ti.com/support/logic-group/logic/f/logic-forum/1027781/faq-where-can-i-get-a-cad-symbol-soldering-footprint-or-3d-model-for-my-device)
- [Existing tscircuit JLC importer](https://github.com/tscircuit/cli/blob/main/lib/import/import-component-from-jlcpcb.ts)
