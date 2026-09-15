import type { NormalizedPart } from "../types"

const key = (value: string) => value.toLowerCase().replace(/[^a-z0-9]/g, "")

// Translate TI attributes into the units used by the shared search contracts.
// Missing ratings and supplier-specific classifications stay null.
export function compatibilityFields(
  part: NormalizedPart,
): Record<string, unknown> {
  const specs = Object.entries(part.parametrics ?? {})
  const find = (...names: string[]): Record<string, any> => {
    const raw = specs.find(([name]) =>
      names.some((candidate) => key(name) === key(candidate)),
    )?.[1]
    return raw && typeof raw === "object" ? (raw as Record<string, any>) : {}
  }
  const text = (...names: string[]) => {
    const value = find(...names).Value
    return typeof value === "string" && !/^(null|n\/a)$/i.test(value)
      ? value
      : null
  }
  const number = (
    names: string[],
    edge?: "Min" | "Max",
    unit?: "V" | "A" | "Hz" | "ohm" | "bytes",
  ) => {
    const spec = find(...names)
    const raw = edge
      ? (spec.Range?.[edge] ?? spec.Value)
      : (spec.Value ?? spec.Range?.Max)
    if (
      raw === undefined ||
      raw === null ||
      String(raw).trim() === "" ||
      !Number.isFinite(Number(raw))
    )
      return null
    const units = String(spec.Unit ?? "")
      .toLowerCase()
      .replace(/\s/g, "")
    const factors: Record<string, Record<string, number>> = {
      V: { v: 1, mv: 0.001 },
      A: { a: 1, ma: 0.001, ua: 1e-6, µa: 1e-6 },
      Hz: {
        hz: 1,
        khz: 1e3,
        mhz: 1e6,
        ghz: 1e9,
        sps: 1,
        ksps: 1e3,
        msps: 1e6,
        gsps: 1e9,
      },
      ohm: { ohm: 1, ohms: 1, ω: 1, kohm: 1e3, mohm: 0.001 },
      bytes: {
        b: 1,
        byte: 1,
        bytes: 1,
        kb: 1024,
        kbyte: 1024,
        kbytes: 1024,
        mb: 1048576,
      },
    }
    const factor = unit ? factors[unit][units] : 1
    return factor === undefined ? null : Number(raw) * factor
  }
  const protocols = text(
    "Interface",
    "Interface type",
    "Digital interface",
    "Control interface",
  )
  const has = (protocol: string) => {
    const direct = number([protocol, `Number of ${protocol}s`])
    if (direct !== null) return direct > 0
    return protocols === null
      ? null
      : protocols
          .toLowerCase()
          .split(/[,;/\s]+/)
          .includes(protocol.toLowerCase())
  }
  const fields: Record<string, unknown> = {
    ...part,
    lcsc: null,
    is_basic: null,
    is_preferred: null,
    in_stock: part.stock > 0,
    attributes: JSON.stringify(part.parameters),
    channel_count: part.num_channels ?? null,
    num_gpios: number(["Number of I/Os", "Number of GPIOs", "GPIO"]),
    gpio_count: number(["GPIO", "Number of GPIOs", "Number of I/Os"]),
    num_bits: number(["Bits", "Number of bits"]),
    cpu_speed_hz: number(
      ["Frequency", "CPU speed", "Frequency (MHz)", "CPU speed (MHz)"],
      undefined,
      "Hz",
    ),
    sampling_rate_hz: number(
      [
        "Sample rate",
        "Sampling rate",
        "Sample rate (max) (Msps)",
        "Sample rate (max) (ksps)",
      ],
      undefined,
      "Hz",
    ),
    supply_voltage_min: number(["Supply voltage", "Vs", "Vcc"], "Min", "V"),
    supply_voltage_max: number(["Supply voltage", "Vs", "Vcc"], "Max", "V"),
    input_voltage_min: number(["Vin", "Input voltage"], "Min", "V"),
    input_voltage_max: number(["Vin", "Input voltage"], "Max", "V"),
    output_current_max: number(["Iout", "Output current"], "Max", "A"),
    on_resistance_ohms: number(["Ron", "On resistance"], undefined, "ohm"),
    operating_temp_min: number(
      ["Operating temperature range", "Operating temperature"],
      "Min",
    ),
    operating_temp_max: number(
      ["Operating temperature range", "Operating temperature"],
      "Max",
    ),
    flash_size_bytes:
      part.flash_size_bytes ??
      number(
        ["Nonvolatile memory (kB)", "Flash memory", "Flash"],
        undefined,
        "bytes",
      ),
    ram_size_bytes:
      part.ram_size_bytes ?? number(["RAM", "RAM (kB)"], undefined, "bytes"),
    cpu_core: part.cpu_core ?? text("CPU", "CPU core", "Core"),
    core_processor: part.cpu_core ?? text("CPU", "CPU core", "Core"),
    bluetooth_version: text("Bluetooth version", "Bluetooth"),
    antenna_type: text("Antenna type"),
    channel_type: text("Configuration", "Channel type"),
    has_spi: has("SPI"),
    has_i2c: has("I2C"),
    has_uart: has("UART"),
    has_can: has("CAN"),
    has_usb: has("USB"),
    has_parallel_interface: has("Parallel"),
    has_serial_interface: has("Serial"),
  }
  // Preserve previously imported explicit ratings if the current metadata omits them.
  for (const name of Object.keys(fields)) {
    if (
      fields[name] === null &&
      part[name] !== undefined &&
      !["lcsc", "is_basic", "is_preferred"].includes(name)
    )
      fields[name] = part[name]
  }
  // TI family rules from JLCSearch's documented processor classifiers.
  const mpn = part.generic_part_number || part.mfr
  if (
    !/module|evaluation|development board/i.test(
      `${part.package} ${part.description}`,
    )
  ) {
    for (const [prefix, core, architecture] of [
      ["AM335", "Cortex-A8", "ARM32"],
      ["AM437", "Cortex-A9", "ARM32"],
      ["AM57", "Cortex-A15", "ARM32"],
      ["AM62", "Cortex-A53", "ARM64"],
      ["AM64", "Cortex-A53", "ARM64"],
      ["AM65", "Cortex-A53", "ARM64"],
    ]) {
      if (
        new RegExp(
          `^${prefix}${prefix === "AM62" ? "(?:[0-9]|[AP][0-9])" : "[0-9]"}[A-Z0-9]*(?:-Q1)?$`,
          "i",
        ).test(mpn)
      ) {
        fields.chip_family = `TI Sitara ${prefix}x`
        fields.cpu_core = core
        fields.architecture = architecture
      }
    }
    for (const [prefix, tops, name] of [
      ["TDA4VM", 8, "C7x NPU (MMA)"],
      ["TDA4AH", 32, "C7x NPU (MMAv2)"],
      ["TDA4VEN", 4, "C7x NPU (MMA)"],
      ["TDA4AEN", 4, "C7x NPU (MMA)"],
      ["AM62A7", 2, "C7x NPU (MMA)"],
      ["AM62A3", 1, "C7x NPU (MMA)"],
      ["AM69A", 32, "C7x NPU (MMAv2)"],
    ] as const) {
      if (mpn.toUpperCase().startsWith(prefix)) {
        fields.npu_name = name
        fields.npu_performance_tops = tops
        fields.npu_chip_family = `TI ${prefix}`
      }
    }
  }
  return fields
}
