// Parse one catalog record at a time; the full TI JSON response can exceed a
// Worker's memory limit. Strings/escapes and nested objects span network chunks.
export async function* catalogRecords(body: ReadableStream<Uint8Array>) {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let prefix = ""
  let record = ""
  let tail = ""
  let state: "prefix" | "item" | "record" | "comma" | "tail" = "prefix"
  let depth = 0
  let quoted = false
  let escaped = false
  let afterComma = false
  try {
    while (true) {
      const { value, done } = await reader.read()
      const text = decoder.decode(value, { stream: !done })
      for (const char of text) {
        if (state === "prefix") {
          prefix += char
          if (prefix.length > 4096) throw new Error("Invalid catalog envelope")
          if (char === "[") {
            if (!/^\s*\{\s*"catalog"\s*:\s*\[$/.test(prefix))
              throw new Error("Invalid catalog envelope")
            state = "item"
          }
        } else if (state === "tail") {
          tail += char
          if (tail.length > 4096) throw new Error("Invalid catalog trailer")
        } else if (state === "item") {
          if (/\s/.test(char)) continue
          if (char === "]" && !afterComma) {
            state = "tail"
            continue
          }
          if (char !== "{") throw new Error("Invalid catalog record")
          record = char
          depth = 1
          quoted = escaped = false
          state = "record"
        } else if (state === "comma") {
          if (/\s/.test(char)) continue
          if (char === ",") {
            state = "item"
            afterComma = true
          } else if (char === "]") state = "tail"
          else throw new Error("Invalid catalog separator")
        } else {
          record += char
          if (record.length > 2_000_000)
            throw new Error("Catalog record too large")
          if (quoted) {
            if (escaped) escaped = false
            else if (char === "\\") escaped = true
            else if (char === '"') quoted = false
          } else if (char === '"') quoted = true
          else if (char === "{" || char === "[") depth++
          else if (char === "}" || char === "]") depth--
          if (depth === 0) {
            yield JSON.parse(record) as Record<string, unknown>
            record = ""
            state = "comma"
            afterComma = false
          }
        }
      }
      if (done) break
    }
    if (state !== "tail" || !/^\s*\}\s*$/.test(tail))
      throw new Error("Incomplete catalog response")
  } finally {
    await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}
