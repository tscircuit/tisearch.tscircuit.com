export interface CategoryDefinition {
  path: string
  label: string
  query: string
  responseKey: string
  filters?: Array<{ name: string; label: string; placeholder?: string }>
}

export const COMMON_FILTERS = [
  { name: "package", label: "Package", placeholder: "WSON" },
  { name: "num_pins", label: "Pins", placeholder: "8" },
  { name: "lifecycle", label: "Lifecycle", placeholder: "ACTIVE" },
]

// Shortcuts to TI ProductFamilyDescription prefixes, not an exhaustive taxonomy.
export const CATEGORY_DEFINITIONS: CategoryDefinition[] = [
  ["dcdc_converters", "DC/DC Converters", "DC/DC converters"],
  ["ldos", "Linear & LDO Regulators", "Linear & low-dropout (LDO) regulators"],
  ["comparators", "Comparators", "Comparators"],
  [
    "current_sense_amplifiers",
    "Current Sense Amplifiers",
    "Analog current-sense amplifiers",
  ],
  [
    "instrumentation_amplifiers",
    "Instrumentation Amplifiers",
    "Instrumentation amplifiers",
  ],
  ["battery_chargers", "Battery Chargers", "Battery charger ICs"],
  ["rf_transceivers", "RF Transceivers", "RF transceivers"],
].map(([key, label, query]) => ({
  path: `/${key}/list`,
  label,
  query,
  responseKey: key,
  filters: COMMON_FILTERS,
}))

export const CATEGORY_BY_PATH = new Map(
  CATEGORY_DEFINITIONS.map((c) => [c.path, c]),
)

// TI groups buck, boost and buck-boost devices under one API family.
// Keep old URLs working, but label the broader results accurately.
for (const key of [
  "buck_converters",
  "boost_converters",
  "buck_boost_converters",
]) {
  CATEGORY_BY_PATH.set(`/${key}/list`, {
    ...CATEGORY_DEFINITIONS[0],
    path: `/${key}/list`,
    responseKey: key,
  })
}
