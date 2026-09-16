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
    unit?: "V" | "A" | "Hz" | "ohm" | "bytes" | "us" | "nA" | "uV" | "lsb",
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
      us: { s: 1e6, ms: 1e3, us: 1, µs: 1, ns: 0.001 },
      nA: { a: 1e9, ma: 1e6, ua: 1e3, µa: 1e3, na: 1 },
      uV: { v: 1e6, mv: 1e3, uv: 1, µv: 1, uvrms: 1, µvrms: 1 },
      lsb: { lsb: 1, "±lsb": 1 },
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
  const protocols =
    [
      "Interface",
      "Interface type",
      "Digital interface",
      "Control interface",
      "Communication interface",
    ]
      .map((name) => text(name))
      .filter(Boolean)
      .join(", ") || null
  const has = (protocol: string) => {
    const direct = number([protocol, `Number of ${protocol}s`])
    if (direct !== null) return direct > 0
    const explicit = text(protocol)
    if (explicit && /^(none|no|not supported)$/i.test(explicit)) return false
    if (explicit && new RegExp(`\\b${protocol}\\b`, "i").test(explicit))
      return true
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
        "Sample/update rate",
        "Sample rate (max) (Msps)",
        "Sample rate (max) (ksps)",
      ],
      undefined,
      "Hz",
    ),
    supply_voltage_min: number(
      ["Supply voltage", "Vs", "Vcc", "VDD", "Supply voltage (VCC)"],
      "Min",
      "V",
    ),
    supply_voltage_max: number(
      ["Supply voltage", "Vs", "Vcc", "VDD", "Supply voltage (VCC)"],
      "Max",
      "V",
    ),
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
    settling_time_us: number(["Settling time"], undefined, "us"),
    nonlinearity_lsb: number(["INL", "Integral nonlinearity"], "Max", "lsb"),
    leakage_current_na: number(
      ["ON-state leakage current", "Leakage current"],
      "Max",
      "nA",
    ),
    dropout_voltage: number(
      ["Dropout voltage (Vdo)", "Dropout voltage"],
      undefined,
      "V",
    ),
    quiescent_current: number(
      ["Iq", "Quiescent current (Iq)", "Supply current"],
      undefined,
      "A",
    ),
    power_supply_rejection_db: number(["PSRR at 100 KHz", "PSRR"], undefined),
    output_noise_uvrms: number(["Noise", "Output noise"], undefined, "uV"),
    switching_frequency: number(["Switching frequency"], undefined, "Hz"),
    number_of_outputs: number(["Regulated outputs", "Number of outputs"]),
    efficiency_percent: number(["Peak efficiency", "Efficiency"]),
    dimming_method: text("Dimming method"),
    has_smbus: has("SMBus"),
    operating_system: text("Operating system"),
  }
  // These are explicit TI feature declarations, not defaults for missing data.
  const features = [text("Features"), text("Peripherals")]
    .filter(Boolean)
    .join(", ")
  for (const feature of [
    "PWM",
    "DMA",
    "RTC",
    "ADC",
    "DAC",
    "Comparator",
    "Watchdog",
  ]) {
    const count = number([feature, `Number of ${feature} channels`])
    const type = text(`${feature} type`)
    fields[`has_${feature.toLowerCase()}`] =
      count !== null
        ? count > 0
        : type && !/^(none|no)$/i.test(type)
          ? true
          : features && new RegExp(`\\b${feature}\\b`, "i").test(features)
            ? true
            : null
  }
  for (const converter of ["adc", "dac"]) {
    const bits = text(`${converter} type`)?.match(/\b(\d+)[ -]bit\b/i)
    fields[`${converter}_resolution_bits`] =
      number([`${converter} resolution`]) ?? (bits ? Number(bits[1]) : null)
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
        fields.cpu_core ??= core
        fields.core_processor ??= core
        fields.architecture = architecture
      }
    }
    // For families beyond the legacy prefix list, require TI to explicitly
    // declare Linux support and a recognized application CPU architecture.
    const cpu = String(fields.cpu_core ?? "")
    if (
      /\bLinux\b/i.test(String(fields.operating_system)) &&
      /Cortex[ -]A\d+/i.test(cpu)
    ) {
      const core = cpu.match(/Cortex[ -]A(\d+)/i)![1]
      if (["5", "7", "8", "9", "15", "17", "32"].includes(core))
        fields.architecture = "ARM32"
      else if (
        ["35", "53", "55", "57", "72", "73", "75", "76", "78"].includes(core)
      )
        fields.architecture = "ARM64"
      if (fields.architecture) fields.chip_family ??= `TI ${mpn}`
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
