import { SearchInputError } from "../search-request"
import {
  SPEC_FILTERS,
  NUMERIC_SPEC_FILTERS,
  matchesSpecFilter,
} from "../jlc-compat"
import { hydratePart } from "../catalog"
import { CATEGORY_DEFINITIONS } from "../categories"
import type { Env, NormalizedPart } from "../types"
import { compatibilityFields } from "./ti-fields"
import {
  ROUTE_TO_TABLE,
  TABLE_CONFIGS,
  TABLE_RESPONSE_KEY,
  normalizeTableQueryParams,
  type FilterOptions,
} from "./contracts"
import columns from "./columns.json"
import { buildSearchTokenGroups } from "./search-query"
import { createDisplayDriverMaxResolutionResolver } from "./display-driver-resolution"
import {
  getTftDisplayDriverFamily,
  TFT_DISPLAY_DRIVER_FAMILIES,
} from "./tft-display-drivers"
import taxonomy from "./taxonomy.json"
import subcategoryTables from "./subcategory-tables.json"

const SPECIAL_TABLES: Record<string, string> = {
  "/analog_switches/list": "analog_switch",
  "/arm_processors/list": "arm_processor",
  "/risc_v_processors/list": "risc_v_processor",
  "/microphones/list": "microphone",
  "/lcd_drivers/list": "lcd_driver",
  "/tft_display_drivers/list": "tft_display_driver",
}
export const COMPATIBLE_ROUTES = [
  ...Object.keys(ROUTE_TO_TABLE),
  ...Object.keys(SPECIAL_TABLES),
]
const family = (...keys: string[]) =>
  CATEGORY_DEFINITIONS.filter((c) => keys.includes(c.responseKey)).map(
    (c) => c.query,
  )
const mcuFamilies = family(
  "general_purpose_mcus",
  "low_power_mcus",
  "real_time_mcus",
)
// An absent mapping is an empty category, never an unfiltered catalog query.
export const TI_ROUTE_FAMILIES: Record<string, string[]> = {
  ...Object.fromEntries(
    CATEGORY_DEFINITIONS.map((category) => [
      category.responseKey,
      [category.query],
    ]),
  ),
  op_amp: family("general_purpose_op_amps", "precision_op_amps"),
  battery_management: family(
    "battery_chargers",
    "fuel_gauges",
    "battery_monitors",
    "battery_protection",
  ),
  motor_driver: family(
    "brushed_dc_drivers",
    "brushless_dc_drivers",
    "stepper_drivers",
  ),
  logic_gate: family(
    "logic_gates",
    "or_gates",
    "nand_gates",
    "nor_gates",
    "xor_gates",
    "inverters",
  ),
  temperature_sensor: family(
    "temperature_sensors",
    "analog_temperature_sensors",
  ),
  magnetic_sensor: family("magnetic_sensors", "linear_hall_sensors"),
  gate_driver: family(
    "gate_drivers",
    "half_bridge_drivers",
    "isolated_gate_drivers",
  ),
  dc_dc: family("dcdc_converters"),
  adc: family("adcs", "high_speed_adcs", "audio_adcs"),
  dac: family("dacs", "high_speed_dacs", "audio_dacs"),
  analog_multiplexer: family("signal_multiplexers"),
  analog_switch: family("analog_switches"),
  microcontroller: mcuFamilies,
  arm_processor: mcuFamilies,
  risc_v_processor: mcuFamilies,
  ldo: family("ldos"),
  voltage_regulator: family("ldos"),
  boost_converter: family("dcdc_converters"),
  buck_boost_converter: family("dcdc_converters"),
  led_driver: family("led_drivers", "led_backlight_drivers"),
  ble_chip: family("bluetooth"),
  ble_module: family("bluetooth"),
  wifi_module: family("wifi"),
  io_expander: [
    "I2C & SPI general-purpose I/Os (GPIOs)",
    "I2C general-purpose I/Os (GPIOs)",
  ],
  lcd_driver: ["LCD & OLED display power & drivers"],
  tft_display_driver: [
    ...family("led_drivers", "led_backlight_drivers"),
    "LCD & OLED display power & drivers",
  ],
  linux_capable_processor: ["Arm-based processors"],
  npu_chip: ["Arm-based processors"],
}
const specialColumns: Record<string, string[]> = {
  analog_switch: [
    "lcsc",
    "mfr",
    "package",
    "num_channels",
    "on_resistance_ohms",
    "supply_voltage_min",
    "supply_voltage_max",
    "has_spi",
    "has_i2c",
    "has_parallel_interface",
    "channel_type",
    "stock",
    "price1",
  ],
  arm_processor: [
    "lcsc",
    "mfr",
    "package",
    "cpu_core",
    "cpu_speed_hz",
    "flash_size_bytes",
    "ram_size_bytes",
    "eeprom_size_bytes",
    "gpio_count",
    "has_uart",
    "has_i2c",
    "has_spi",
    "has_can",
    "has_usb",
    "stock",
    "price1",
  ],
  microphone: [
    "lcsc",
    "mfr",
    "package",
    "microphone_type",
    "description",
    "stock",
    "price1",
  ],
  lcd_driver: [
    "lcsc",
    "mfr",
    "package",
    "max_resolution",
    "description",
    "is_basic",
    "is_preferred",
    "stock",
    "price1",
    "attributes",
  ],
  tft_display_driver: [
    "lcsc",
    "mfr",
    "package",
    "driver_type",
    "catalog_type",
    "max_resolution",
    "description",
    "is_basic",
    "is_preferred",
    "stock",
    "price1",
    "attributes",
  ],
}
specialColumns.risc_v_processor = specialColumns.arm_processor
const specialFilters: Record<
  string,
  Record<
    string,
    { field: string; type: "string" | "number" | "boolean"; operator?: ">=" }
  >
> = {
  analog_switch: {
    package: { field: "package", type: "string" },
    channels: { field: "num_channels", type: "number" },
  },
  arm_processor: TABLE_CONFIGS.microcontroller.filters as any,
  risc_v_processor: TABLE_CONFIGS.microcontroller.filters as any,
  microphone: {
    package: { field: "package", type: "string" },
    microphone_type: { field: "microphone_type", type: "string" },
  },
  lcd_driver: {
    package: { field: "package", type: "string" },
    max_resolution: { field: "max_resolution", type: "string" },
    is_basic: { field: "is_basic", type: "boolean" },
    is_preferred: { field: "is_preferred", type: "boolean" },
  },
}
specialFilters.tft_display_driver = {
  ...specialFilters.lcd_driver,
  driver_type: { field: "driver_type", type: "string" },
}
export const routeFilters = (path: string) => {
  const table = ROUTE_TO_TABLE[path] ?? SPECIAL_TABLES[path]
  return TABLE_CONFIGS[table]?.filters ?? specialFilters[table] ?? {}
}

const compare = (actual: any, expected: any, op = "=") =>
  actual != null &&
  (op === ">="
    ? actual >= expected
    : op === "<="
      ? actual <= expected
      : op === ">"
        ? actual > expected
        : op === "<"
          ? actual < expected
          : actual === expected)
export function matchesFilters(
  row: Record<string, any>,
  path: string,
  params: Record<string, string>,
): boolean {
  const table = ROUTE_TO_TABLE[path] ?? SPECIAL_TABLES[path]
  params = normalizeTableQueryParams(table, params)
  for (const [name, config] of Object.entries(routeFilters(path))) {
    const value = params[name]
    if (
      value === undefined ||
      value === "" ||
      value === "All" ||
      (name === "microphone_type" && value === "all")
    )
      continue
    // JLC's custom display forms only enable these flags when checked.
    if (
      ["lcd_driver", "tft_display_driver"].includes(table) &&
      ["is_basic", "is_preferred"].includes(name) &&
      !["true", "1"].includes(value)
    )
      continue
    const actual = row[config.field]
    if (
      name === "driver_type" &&
      !TFT_DISPLAY_DRIVER_FAMILIES.some((family) => family.value === value)
    )
      continue
    if (config.type === "string") {
      if (!compare(actual, value, config.operator)) return false
    } else if (config.type === "boolean") {
      if (actual == null || Boolean(actual) !== ["true", "1"].includes(value))
        return false
    } else if (config.type === "number_excludes_ranges") {
      for (const range of value
        .split(",")
        .map((v) => v.trim())
        .filter(Boolean)) {
        const match =
          /^(\d+(?:\.\d+)?)\s*(?:-|–|—|\.\.)\s*(\d+(?:\.\d+)?)$/.exec(range)
        const bounds = match
          ? [Number(match[1]), Number(match[2])].sort((a, b) => a - b)
          : [Number(range), Number(range)]
        if (
          bounds.every(Number.isFinite) &&
          (actual == null || (actual >= bounds[0] && actual <= bounds[1]))
        )
          return false
      }
    } else {
      const n = SPECIAL_TABLES[path] ? Number(value) : Number.parseFloat(value)
      if (!Number.isFinite(n)) continue
      if (config.type === "number_distance_from_param") {
        const target = Number.parseFloat(
          params[config.relativeToParam ?? ""] ?? "",
        )
        if (
          n >= 0 &&
          Number.isFinite(target) &&
          (actual == null || Math.abs(actual - target) > n)
        )
          return false
      } else if (config.type === "number_range_contains") {
        const max = row[config.maxField ?? ""]
        if (actual == null || max == null) {
          if (!config.fallbackField || !compare(row[config.fallbackField], n))
            return false
        } else if (actual > n || max < n) return false
      } else if (config.type === "number_tolerance") {
        if (actual == null || Math.abs(actual - n) > n * 0.0001) return false
      } else if (!compare(actual, n, config.operator)) return false
    }
  }
  if (
    ["arm_processor", "risc_v_processor"].includes(table) &&
    ["uart", "i2c", "spi", "can", "usb"].includes(params.interface) &&
    row[`has_${params.interface}`] !== true
  )
    return false
  return true
}

const escapeLike = (value: string) => value.replace(/[\\%_]/g, "\\$&")
export interface SearchScan {
  after?: { stock: number; mfr: string }
  done: boolean
}
async function readParts(
  env: Env,
  selectedFamilies?: string[],
  params: Record<string, string> = {},
  scan?: SearchScan,
): Promise<NormalizedPart[]> {
  if (scan) scan.done = true
  if (selectedFamilies?.length === 0) return []
  const conditions = ["json_extract(raw_json,'$.currency')=?"]
  const binds: unknown[] = [env.TI_CURRENCY ?? "USD"]
  if (selectedFamilies) {
    conditions.push(
      `(${selectedFamilies.map(() => "category LIKE ? ESCAPE '\\'").join(" OR ")})`,
    )
    binds.push(...selectedFamilies.map((v) => `${escapeLike(v)}%`))
  }
  if (params.package) {
    conditions.push("package=?")
    binds.push(params.package)
  }
  if (params.subcategory_name) {
    const value =
      CATEGORY_DEFINITIONS.find((c) =>
        [c.responseKey.replaceAll("_", " "), c.query, c.label].some(
          (v) => v.toLowerCase() === params.subcategory_name.toLowerCase(),
        ),
      )?.query ?? params.subcategory_name
    conditions.push("subcategory=?")
    binds.push(value)
  }
  const query = params.q ?? params.search
  if (query?.trim()) {
    const tokens = buildSearchTokenGroups(query.trim())
    if (/^c?\d+$/i.test(query.trim())) return [] // TI has no LCSC identifier mapping.
    if (tokens.length) {
      const longerTokens = tokens
        .map((group) => group.filter((token) => token.length > 1))
        .filter((group) => group.length)
      const groups = (longerTokens.length ? longerTokens : tokens).map(
        (group) => [
          ...new Set(
            group.flatMap((token) =>
              token.endsWith("mhz")
                ? [token, token.replace(/mhz$/, "m")]
                : [token],
            ),
          ),
        ],
      )
      conditions.push(
        `rowid IN (SELECT rowid FROM parts_substring_fts WHERE ${groups.map((group) => `(${group.map(() => "search_text LIKE ?").join(" OR ")})`).join(" AND ")})`,
      )
      binds.push(...groups.flat().map((token) => `%${token}%`))
    } else return []
  }
  if (scan?.after) {
    conditions.push(
      "(stock < ? OR (stock = ? AND manufacturer_part_number > ?))",
    )
    binds.push(scan.after.stock, scan.after.stock, scan.after.mfr)
  }
  const rows = await env.DB.prepare(
    `SELECT raw_json,updated_at FROM parts WHERE ${conditions.join(" AND ")} ORDER BY stock DESC,manufacturer_part_number${scan ? " LIMIT 500" : ""}`,
  )
    .bind(...binds)
    .all<{ raw_json: string; updated_at: number }>()
  const parts = rows.results.map((row) => ({
    ...hydratePart(row.raw_json),
    inventory_updated_at: new Date(row.updated_at).toISOString(),
  }))
  if (scan) {
    scan.done = parts.length < 500
    const last = parts.at(-1)
    if (last) scan.after = { stock: last.stock, mfr: last.mfr }
  }
  return parts
}
const belongs = (row: Record<string, any>, table: string) => {
  if (table === "analog_switch")
    return typeof row.num_channels === "number" && row.num_channels <= 2
  if (table === "boost_converter") return /^boost$/i.test(String(row.topology))
  if (table === "buck_boost_converter")
    return /^buck[ -]boost$/i.test(String(row.topology))
  if (table === "arm_processor")
    return /^ARM|^Cortex-/i.test(String(row.cpu_core))
  if (table === "risc_v_processor")
    return /^RISC-V$/i.test(String(row.cpu_core))
  if (table === "wifi_module")
    return /module/i.test(`${row.package} ${row.description}`)
  if (table === "ble_module")
    return (
      /module/i.test(`${row.package} ${row.description}`) &&
      /bluetooth|\bBLE\b/i.test(
        `${row.description} ${JSON.stringify(row.parameters)}`,
      )
    )
  if (table === "ble_chip")
    return (
      !/module/i.test(`${row.package} ${row.description}`) &&
      /bluetooth|\bBLE\b/i.test(
        `${row.description} ${JSON.stringify(row.parameters)}`,
      )
    )
  if (table === "linux_capable_processor")
    return (
      typeof row.architecture === "string" &&
      typeof row.chip_family === "string"
    )
  if (table === "npu_chip")
    return (
      typeof row.npu_performance_tops === "number" &&
      row.npu_performance_tops > 0
    )
  if (table === "tft_display_driver")
    return Boolean(getTftDisplayDriverFamily(String(row.mfr)))
  return true
}

export async function queryCompatibleCategory(
  env: Env,
  path: string,
  params: Record<string, string>,
) {
  const table = ROUTE_TO_TABLE[path] ?? SPECIAL_TABLES[path]
  const parts = await readParts(env, TI_ROUTE_FAMILIES[table] ?? [])
  const rows = parts
    .map(compatibilityFields)
    .filter((row) => belongs(row, table))
  if (table === "npu_chip")
    for (const row of rows) row.chip_family = row.npu_chip_family
  if (["lcd_driver", "tft_display_driver"].includes(table)) {
    const resolve = createDisplayDriverMaxResolutionResolver(
      rows.map((row) => ({
        mfr: String(row.mfr),
        description: String(row.description),
        extra: JSON.stringify({ attributes: row.parameters }),
      })),
    )
    for (const row of rows)
      row.max_resolution = resolve({
        mfr: String(row.mfr),
        description: String(row.description),
        extra: JSON.stringify({ attributes: row.parameters }),
      })
  }
  if (table === "tft_display_driver")
    for (const row of rows) {
      row.driver_type =
        getTftDisplayDriverFamily(String(row.mfr))?.value ?? null
      row.catalog_type = row.category
    }
  const options: FilterOptions = {}
  for (const [name, config] of Object.entries(routeFilters(path)))
    options[name] = [
      ...new Set(
        rows
          .map((row) => row[config.field])
          .filter((v) => v != null)
          .map(String),
      ),
    ].sort()
  const selected = rows.filter((row) => matchesFilters(row, path, params))
  const config = TABLE_CONFIGS[table]
  const normalized = normalizeTableQueryParams(table, params)
  if (
    config?.targetSort &&
    Number.isFinite(
      Number.parseFloat(normalized[config.targetSort.param] ?? ""),
    )
  ) {
    const target = Number.parseFloat(normalized[config.targetSort.param])
    selected.sort(
      (a, b) =>
        Math.abs(Number(a[config.targetSort!.field] ?? Infinity) - target) -
          Math.abs(Number(b[config.targetSort!.field] ?? Infinity) - target) ||
        Number(b.stock) - Number(a.stock),
    )
  }
  if (["lcd_driver", "tft_display_driver"].includes(table)) {
    for (const row of selected)
      if (table === "tft_display_driver")
        row.driver_type =
          getTftDisplayDriverFamily(String(row.mfr))?.label ?? null
  }
  const fields =
    specialColumns[table] ?? (columns as Record<string, string[]>)[table] ?? []
  const responseKey =
    TABLE_RESPONSE_KEY[table] ??
    (table === "analog_switch" ? "switches" : `${table}s`)
  return {
    data: {
      [responseKey]: selected.map((row) =>
        Object.fromEntries(fields.map((field) => [field, row[field] ?? null])),
      ),
    },
    productUrls: Object.fromEntries(
      parts.map((part) => [part.mfr, part.product_url]),
    ),
    filterOptions: options,
  }
}

export async function queryCompatibleSearch(
  env: Env,
  params: Record<string, string>,
  api = false,
  scan?: SearchScan,
) {
  for (const name of ["num_pins", ...NUMERIC_SPEC_FILTERS]) {
    if (
      params[name] &&
      params[name] !== "All" &&
      (!Number.isFinite(Number(params[name])) || Number(params[name]) < 0)
    )
      throw new SearchInputError(`Invalid numeric filter: ${name}`)
  }
  const subcategoryTable = (subcategoryTables as Record<string, string>)[
    params.subcategory_name
  ]
  const isReferenceSubcategory = taxonomy.subcategories.some(
    (row) => row.subcategory === params.subcategory_name,
  )
  const searchParams: Record<string, string> = {
    ...params,
    q: params.q ?? params.search,
  }
  if (isReferenceSubcategory) delete searchParams.subcategory_name
  let parts = await readParts(
    env,
    isReferenceSubcategory
      ? (TI_ROUTE_FAMILIES[subcategoryTable] ?? [])
      : undefined,
    searchParams,
    scan,
  )
  if (isReferenceSubcategory && subcategoryTable)
    parts = parts.filter((part) =>
      belongs(compatibilityFields(part), subcategoryTable),
    )
  parts = parts.filter(
    (p) =>
      p.stock > 0 &&
      (!params.num_pins ||
        params.num_pins === "All" ||
        p.pin_count === Number(params.num_pins)) &&
      Object.keys(SPEC_FILTERS).every(
        (name) =>
          !params[name] ||
          params[name] === "All" ||
          matchesSpecFilter(p, name, params[name]),
      ),
  )
  if (
    [params.is_basic, params.is_preferred].some(
      (v) => v === "true" || v === "1",
    )
  )
    parts = []
  // List pages show every match. The programmatic API retains JLC's explicit limit.
  if (api && params.limit) {
    const limit = Number.parseInt(params.limit, 10)
    if (limit > 0) parts = parts.slice(0, limit)
  }
  return {
    components: parts.map((p) => ({
      lcsc: null,
      mfr: p.mfr,
      package: p.package,
      description: p.description,
      stock: p.stock,
      price: api
        ? p.price
        : JSON.stringify(p.price_breaks.map((tier) => ({ ...tier }))),
      ...(!api
        ? taxonomyForPart(
            p,
            isReferenceSubcategory ? params.subcategory_name : undefined,
          )
        : {}),
      is_basic: null,
      is_preferred: null,
      ti_product_number: p.ti_product_number,
      supplier_part_number: p.supplier_part_number,
      manufacturer: p.manufacturer,
      datasheet_url: p.datasheet_url,
      product_url: p.product_url,
    })),
  }
}

function taxonomyForPart(part: NormalizedPart, selected?: string) {
  const subcategory =
    selected ??
    Object.entries(subcategoryTables).find(([, table]) =>
      TI_ROUTE_FAMILIES[table]?.some((family) =>
        part.category.startsWith(family),
      ),
    )?.[0]
  const entry = taxonomy.subcategories.find(
    (row) => row.subcategory === subcategory,
  )
  return {
    category: entry?.category ?? part.category,
    subcategory: entry?.subcategory ?? part.subcategory,
  }
}
