import categoryData from "./category-data.json"

export interface CategoryDefinition {
  path: string
  label: string
  group: string
  query: string
  responseKey: string
  filters?: Array<{ name: string; label: string; placeholder?: string }>
}

export const COMMON_FILTERS = [
  { name: "package", label: "Package", placeholder: "WSON" },
]

// Family names verified against TI Product Information on 2026-09-14.
// Broad website categories are represented by explicit API subfamilies.
export const CATEGORY_DEFINITIONS: CategoryDefinition[] = categoryData.map(
  ({ key, label, group, family }) => ({
    path: `/${key}/list`,
    label,
    group,
    query: family,
    responseKey: key,
    filters: COMMON_FILTERS,
  }),
)

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
