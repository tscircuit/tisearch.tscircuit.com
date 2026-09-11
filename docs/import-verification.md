# Live TI part import verification

Verified on 2026-09-11 using tscircuit CLI **0.0.2506**.

## Result and scope

Texas Instruments **TPS62160DSGR**, an eight-pin WSON/DSG buck converter, was
matched exactly to **JLC/EasyEDA C324077**, converted to TSX, and compiled to
Circuit JSON with exit code 0. This confirms the TI-OPN → existing CAD → TSX
path. It does not establish full TI catalog coverage or a direct TI CAD API.

The repository helper was exercised against the live JLC/EasyEDA service:

```sh
bun run import:part TPS62160DSGR --out ./imports
```

It resolves the exact orderable part and delegates CAD conversion to:

```sh
tsci import C324077 --use-exact-footprint
```

The generated component retains `manufacturerPartNumber="TPS62160DSGR"`,
`jlcpcb: ["C324077"]` CAD provenance, pin labels, explicit SMT pad geometry,
silkscreen, courtyard, and OBJ/STEP URL references. Model URLs were present;
downloading or rendering the 3D models was not part of this test.

## Compilation fixture

This is a component compilation check, not a complete functional regulator circuit.

```tsx
import { TPS62160DSGR } from "./imports/TPS62160DSGR"

export default () => (
  <board width="10mm" height="10mm" routingDisabled>
    <TPS62160DSGR
      name="U1"
      connections={{ VIN: "net.VCC", PGND: "net.GND", AGND: "net.GND", PAD: "net.GND" }}
    />
  </board>
)
```

```sh
tsci build verify.circuit.tsx --disable-parts-engine --routing-disabled
```

The output contained one source component, one schematic component, one PCB
component, **9 source ports, 9 schematic ports, and 9 SMT pads**. The ninth pad
is the exposed thermal pad. No build errors were emitted. The fixture emitted
a schematic-sheet styling warning because it did not declare a drawing sheet.
This check does not establish regulator functionality, routing, thermal design,
or manufacturing readiness.

## Datasheet identity check

The imported signal pin mapping agrees with page 4 of
[TI's TPS62160 datasheet, Rev. E](https://www.ti.com/lit/ds/symlink/tps62160.pdf):

| Pin | Imported label |
| --- | --- |
| 1 | PGND |
| 2 | VIN |
| 3 | EN |
| 4 | AGND |
| 5 | FB |
| 6 | VOS |
| 7 | SW |
| 8 | PG |
| 9 (CAD numbering) | PAD / exposed thermal pad |

TI identifies the exposed pad separately and requires its connection to AGND.
The converter labels it pin9; it is not a ninth signal pin.

SHA-256 of the directly imported, unformatted TSX:
`952ffd11a2f61a80041000abe7e5fc6edd5dca30d4c22d23692144b1ca7074c8`.
The source CAD asset is not vendored into this service. Repeat the commands to
retrieve it from the provider. Unit tests also cover rejection of family-only,
suffix-mismatched, ambiguous, and inconsistent converted identities.
