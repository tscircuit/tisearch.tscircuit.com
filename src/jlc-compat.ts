import type { NormalizedPart } from "./types"

// Public field names/operators follow the overlapping JLCSearch category APIs.
// Only TI's documented family/package/pin/lifecycle filters go upstream.
export const SPEC_FILTERS: Record<
  string,
  { field: string; operator: "=" | "<=" | ">=" }
> = {
  resolution_bits: { field: "resolution_bits", operator: "=" },
  num_channels: { field: "num_channels", operator: "=" },
  channel_count: { field: "num_channels", operator: "=" },
  output_voltage: { field: "output_voltage_min", operator: "<=" },
  output_voltage_min: { field: "output_voltage_min", operator: "<=" },
  output_voltage_max: { field: "output_voltage_max", operator: ">=" },
  output_type: { field: "output_type", operator: "=" },
  core: { field: "cpu_core", operator: "=" },
  flash_min: { field: "flash_size_bytes", operator: ">=" },
  ram_min: { field: "ram_size_bytes", operator: ">=" },
  topology: { field: "topology", operator: "=" },
}

export const NUMERIC_SPEC_FILTERS = new Set(
  Object.keys(SPEC_FILTERS).filter(
    (name) => !["output_type", "core", "topology"].includes(name),
  ),
)

const normalized = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "")
const numeric = (v: unknown): number | null =>
  (typeof v === "number" || (typeof v === "string" && v.trim() !== "")) &&
  Number.isFinite(Number(v))
    ? Number(v)
    : null

// Unknown TI attributes remain null: absence is not a zero rating.
export function standardFields(
  parametrics: Record<string, unknown>,
): Record<string, string | number | null> {
  const entries = Object.entries(parametrics)
  const spec = (...names: string[]): Record<string, any> => {
    const value = entries.find(([name]) =>
      names.some((n) => normalized(n) === normalized(name)),
    )?.[1]
    return value && typeof value === "object"
      ? (value as Record<string, any>)
      : {}
  }
  const number = (s: Record<string, any>, end?: "Min" | "Max") =>
    numeric(end ? (s.Range?.[end] ?? s.Value) : (s.Value ?? s.Range?.Max))
  const text = (s: Record<string, any>) =>
    typeof s.Value === "string" && !/^(null|n\/a)$/i.test(s.Value)
      ? s.Value
      : null
  const bytes = (s: Record<string, any>) => {
    const n = number(s)
    if (n === null) return null
    const unit = normalized(s.Unit ?? "")
    return ["kb", "kbyte", "kbytes"].includes(unit)
      ? n * 1024
      : ["mb", "mbyte", "mbytes"].includes(unit)
        ? n * 1024 * 1024
        : ["b", "byte", "bytes"].includes(unit)
          ? n
          : null
  }
  const vout = spec("Vout", "Output voltage")
  return {
    resolution_bits: number(
      spec("Resolution", "Resolution (Bits)", "Resolution (bits)"),
    ),
    num_channels: number(
      spec(
        "Number of channels",
        "Number of input channels",
        "Number of output channels",
        "Channels",
        "DAC channels",
        "ADC channels",
        "Number of DAC channels",
        "Number of ADC channels",
      ),
    ),
    output_voltage_min: number(vout, "Min"),
    output_voltage_max: number(vout, "Max"),
    output_type: text(spec("Output options", "Output type")),
    cpu_core: text(spec("CPU", "CPU core", "Core")),
    flash_size_bytes: bytes(
      spec("Nonvolatile memory (kB)", "Flash memory", "Flash"),
    ),
    ram_size_bytes: bytes(spec("RAM", "RAM (kB)")),
    topology: text(spec("Topology")),
  }
}

export const matchesSpecFilter = (
  part: NormalizedPart,
  name: string,
  expected: string,
): boolean => {
  const config = SPEC_FILTERS[name]
  if (!config) return true
  const actual = part[config.field as keyof NormalizedPart]
  if (actual === null || actual === undefined) return false
  if (NUMERIC_SPEC_FILTERS.has(name)) {
    if (typeof actual !== "number") return false
    const n = Number(expected)
    return config.operator === "<="
      ? actual <= n
      : config.operator === ">="
        ? actual >= n
        : actual === n
  }
  return String(actual)
    .split(/[,;]/)
    .some((v) => normalized(v) === normalized(expected))
}
