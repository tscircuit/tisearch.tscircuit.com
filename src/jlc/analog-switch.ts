// TI's channel count is the number of independent switch/mux banks. An 8:1
// mux can have one channel, while a quad SPST switch has four channels.
export function isAnalogSwitch(row: Record<string, unknown>): boolean {
  const configuration = String(row.channel_type ?? "").trim()
  if (configuration) {
    const ratios = [...configuration.matchAll(/(\d+)\s*:\s*(\d+)/g)]
    if (ratios.length) {
      return ratios.every(([, inputs, outputs]) =>
        ["1:1", "2:1", "1:2"].includes(`${Number(inputs)}:${Number(outputs)}`),
      )
    }
    return /\b(?:SPST|SPDT|DPST|DPDT)\b/i.test(configuration)
  }

  // Older records may lack Configuration. Require an explicit switch
  // description; the shared "switches & muxes" product family is insufficient.
  const description = String(row.description ?? "")
  return (
    !/\b(?:multiplexer|demultiplexer|mux|crosspoint)/i.test(description) &&
    /\b(?:analog|bilateral)\s+switch(?:es)?\b/i.test(description)
  )
}
