import categoryData from "./category-data.json"

export interface CategoryDefinition {
  path: string
  label: string
  group: string
  query: string
  responseKey: string
  defaultFilters?: Record<string, string>
  filters?: Array<{ name: string; label: string; placeholder?: string }>
}

export const COMMON_FILTERS = [
  { name: "package", label: "Package", placeholder: "WSON" },
  { name: "num_pins", label: "Pin count", placeholder: "8" },
]

const categoryFilters = (key: string): typeof COMMON_FILTERS => {
  const names = /adcs|dacs/.test(key)
    ? ["resolution_bits", "num_channels"]
    : /ldos/.test(key)
      ? ["output_type", "output_voltage"]
      : /led.*drivers/.test(key)
        ? ["channel_count"]
        : /analog_switches|signal_multiplexers/.test(key)
          ? ["num_channels"]
          : /mcus/.test(key)
            ? ["core", "flash_min", "ram_min"]
            : []
  return names.map((name) => ({
    name,
    label: name.replaceAll("_", " "),
    placeholder: "",
  }))
}

// Family names verified against TI Product Information on 2026-09-14.
// Broad website categories are represented by explicit API subfamilies.
export const CATEGORY_DEFINITIONS: CategoryDefinition[] = categoryData.map(
  ({ key, label, group, family }) => ({
    path: `/${key}/list`,
    label,
    group,
    query: family,
    responseKey: key,
    filters: [...COMMON_FILTERS, ...categoryFilters(key)],
  }),
)

export const CATEGORY_BY_PATH = new Map(
  CATEGORY_DEFINITIONS.map((c) => [c.path, c]),
)

// Shared public routes map to TI families; topology is evaluated from TI specs.
for (const [key, topology] of Object.entries({
  buck_converters: "Buck",
  boost_converters: "Boost",
  buck_boost_converters: "Buck-Boost",
})) {
  CATEGORY_BY_PATH.set(`/${key}/list`, {
    ...CATEGORY_DEFINITIONS[0],
    path: `/${key}/list`,
    responseKey: key,
    label: key.replaceAll("_", " "),
    defaultFilters: { topology },
    filters: [
      ...COMMON_FILTERS,
      ...["output_voltage_min", "output_voltage_max"].map((name) => ({
        name,
        label: name.replaceAll("_", " "),
      })),
    ],
  })
}
for (const [alias, target, responseKey] of [
  ["voltage_regulators", "ldos", "regulators"],
  ["analog_multiplexers", "signal_multiplexers", "analog_multiplexers"],
  ["microcontrollers", "general_purpose_mcus", "microcontrollers"],
]) {
  const source = CATEGORY_BY_PATH.get(`/${target}/list`)!
  CATEGORY_BY_PATH.set(`/${alias}/list`, {
    ...source,
    path: `/${alias}/list`,
    responseKey,
  })
}
