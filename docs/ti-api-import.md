# Direct TI API imports and TSX feasibility

Reviewed against TI's published API specifications on 2026-09-11.

## Supported import

`bun run import:part <TI-OPN>` authenticates with TI and retrieves the exact
orderable part from `GET /v2/store/products/{tiPartNumber}`. It saves normalized
metadata as `<encoded-OPN>.ti.json`, including TI API provenance, inventory,
price breaks, package, pin count, and a `tsx.supported: false` capability flag.
The importer preserves all suffixes, URL-encodes `/NOPB`, rejects a response for
a different OPN, and refuses to overwrite existing files. It uses only TI's API.

Set `TI_CLIENT_ID`, `TI_CLIENT_SECRET`, and optionally `TI_CURRENCY` in the
ignored `.env` file. The script defaults to JSON; `--format tsx` fails before
network access or file writes and explains which CAD data is missing.

## Why the buying API cannot generate a complete TSX component

| TI interface | Documented data | Missing for a complete PCB component |
| --- | --- | --- |
| [Store V2 inventory and pricing](https://www.ti.com/content/dam/developer-api/inventory-pricing-api.yaml) | Exact OPN, GPN, description, stock, price breaks, package type, pin count, lifecycle | Schematic pin mappings and PCB pad geometry |
| [Product Information V1](https://www.ti.com/content/dam/developer-api/product-information-api.yaml) | Product details, datasheet URL, parametrics, package dimensions/pitch, quality data | Signal-to-pad mappings and a complete footprint/land pattern |

Neither reviewed specification documents a CAD download endpoint. A package
name, pin count, or nominal body dimension cannot identify signal assignments,
exposed pads, or a verified solder land pattern. Emitting a generic footprint
from those fields would not confirm a usable imported TSX component.

TI does offer CAD separately through its [CAD/CAE downloads](https://webench.ti.com/cad/)
and [documented model download workflow](https://e2e.ti.com/support/logic-group/logic/f/logic-forum/1027781/faq-where-can-i-get-a-cad-symbol-soldering-footprint-or-3d-model-for-my-device).
Those are separate from the product/buying APIs and are not used by this service.
A future TI-only TSX path needs a supported way to obtain TI CAD or separately
verified pin/land-pattern definitions, then a converter and a compiled component
check. This repository does not claim that path is implemented or verified.

## Verification boundary

The test suite uses synthetic products matching the documented Store V2 schema
and an injected HTTP transport to verify OAuth, encoded exact-part requests,
currency selection, response identity, TI failures without fallback, and refusal
of unsupported TSX output. Search tests run against real D1 migrations and FTS.

No approved TI credentials were available during initialization, so successful
authenticated live imports and full-catalog ingestion are not verified. No
TI API-only TSX conversion has been demonstrated. No external CAD importer or
third-party search is invoked.
