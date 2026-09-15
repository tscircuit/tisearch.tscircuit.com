import type { Env } from "../types"
import { queryCompatibleSearch, type SearchScan } from "./catalog"
import { renderD1TablePage, renderTable } from "./render"

// Keep the public one-page/one-array contract while scanning D1 in bounded
// batches. The full bulk catalog must not be materialized in Worker memory.
export async function searchResponseBody(
  env: Env,
  path: string,
  params: Record<string, string>,
  json: boolean,
  requestUrl: string,
) {
  const api = path === "/api/search"
  const requested = api ? Number.parseInt(params.limit ?? "", 10) : NaN
  const limit = requested > 0 ? requested : Infinity
  const scan: SearchScan = { done: false }
  let emitted = 0
  const next = async () => {
    while (!scan.done && emitted < limit) {
      const result = await queryCompatibleSearch(env, params, api, scan)
      const rows = result.components.slice(0, limit - emitted)
      if (rows.length) {
        emitted += rows.length
        return rows
      }
    }
    return []
  }
  // Validate filters and perform the initial D1 read before committing HTTP 200.
  const first = await next()
  const page = json
    ? ""
    : renderD1TablePage(path, { components: first }, params, requestUrl)
  const close = page.indexOf("</tbody>")
  const encoder = new TextEncoder()
  let started = false
  let done = false
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (done) return controller.close()
      if (!started) {
        started = true
        controller.enqueue(
          encoder.encode(
            json
              ? '{"components":[' + JSON.stringify(first).slice(1, -1)
              : close < 0
                ? page
                : page.slice(0, close),
          ),
        )
        if (!first.length) {
          if (json) controller.enqueue(encoder.encode("]}"))
          done = true
        }
        return
      }
      const rows = await next()
      if (!rows.length) {
        controller.enqueue(encoder.encode(json ? "]}" : page.slice(close)))
        done = true
        return
      }
      if (json)
        controller.enqueue(
          encoder.encode("," + JSON.stringify(rows).slice(1, -1)),
        )
      else {
        const table = renderTable(rows, {})
        controller.enqueue(
          encoder.encode(
            table.slice(
              table.indexOf("<tbody>") + 7,
              table.indexOf("</tbody>"),
            ),
          ),
        )
      }
    },
    cancel() {
      done = true
      scan.done = true
    },
  })
}
