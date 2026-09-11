export interface CategoryDefinition {
  path: string
  label: string
  responseKey: string
  matches: RegExp
}

// Description-based discovery groups, not TI's official parametric taxonomy.
// A part can appear in several groups. No electrical specifications are inferred.
const definitions: Array<[string, string, string, RegExp]> = [
  ["amplifiers", "Amplifiers", "amplifiers", /\bamplifier/i],
  [
    "opamps",
    "Operational Amplifiers",
    "opamps",
    /operational amplifier|op[- ]?amp/i,
  ],
  ["comparators", "Comparators", "comparators", /\bcomparator/i],
  ["adcs", "ADCs", "adcs", /analog.to.digital|\bADC\b/i],
  ["dacs", "DACs", "dacs", /digital.to.analog|\bDAC\b/i],
  [
    "voltage_regulators",
    "Voltage Regulators",
    "regulators",
    /regulator|\bLDO\b|\bbuck\b|\bboost\b/i,
  ],
  ["ldos", "LDO Regulators", "ldos", /\bLDO\b|low.dropout|linear.*regulator/i],
  [
    "buck_converters",
    "Buck Converters",
    "buck_converters",
    /\bbuck\b|step.down/i,
  ],
  [
    "boost_converters",
    "Boost Converters",
    "boost_converters",
    /\bboost\b|step.up/i,
  ],
  [
    "buck_boost_converters",
    "Buck-Boost Converters",
    "buck_boost_converters",
    /buck[- /]boost|step.up.and.down/i,
  ],
  ["led_drivers", "LED Drivers", "led_drivers", /LED.*driver|driver.*LED/i],
  [
    "motor_drivers",
    "Motor Drivers",
    "motor_drivers",
    /motor.*driver|driver.*motor/i,
  ],
  [
    "gate_drivers",
    "Gate Drivers",
    "gate_drivers",
    /gate.*driver|driver.*gate/i,
  ],
  [
    "battery_chargers",
    "Battery Chargers",
    "battery_chargers",
    /battery.*charg|charg.*battery/i,
  ],
  [
    "microcontrollers",
    "Microcontrollers",
    "microcontrollers",
    /microcontroller|\bMCU\b/i,
  ],
  ["processors", "Processors", "processors", /\bprocessor|\bDSP\b/i],
  [
    "logic",
    "Logic",
    "logic",
    /logic|flip.flop|shift.register|\b[ANDORX]+ gate/i,
  ],
  [
    "interface",
    "Interface ICs",
    "interface",
    /transceiver|RS.?485|RS.?232|I2C|I²C|CAN bus|USB/i,
  ],
  [
    "analog_multiplexers",
    "Analog Muxes",
    "multiplexers",
    /analog.*multiplex|analog.*mux/i,
  ],
]

export const CATEGORY_DEFINITIONS: CategoryDefinition[] = definitions.map(
  ([slug, label, responseKey, matches]) => ({
    path: `/${slug}/list`,
    label,
    responseKey,
    matches,
  }),
)
export const CATEGORY_BY_PATH = new Map(
  CATEGORY_DEFINITIONS.map((c) => [c.path, c]),
)
export const classifyPart = (description: string): string[] =>
  CATEGORY_DEFINITIONS.filter((c) => c.matches.test(description)).map(
    (c) => c.responseKey,
  )
