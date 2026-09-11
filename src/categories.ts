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
  ["buck_converters", "Buck Converters", "Buck converters"],
  ["boost_converters", "Boost Converters", "Boost converters"],
  ["buck_boost_converters", "Buck-Boost Converters", "Buck-boost"],
  ["ldos", "Linear Regulators", "Linear"],
  ["comparators", "Comparators", "Comparators"],
  [
    "current_sense_amplifiers",
    "Current Sense Amplifiers",
    "Current sense amplifiers",
  ],
  [
    "instrumentation_amplifiers",
    "Instrumentation Amplifiers",
    "Instrumentation amplifiers",
  ],
  ["battery_chargers", "Battery Chargers", "Battery charger"],
  ["rf_transceivers", "RF Transceivers", "RF-sampling transceivers"],
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
