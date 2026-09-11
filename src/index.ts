import { CATEGORY_BY_PATH, CATEGORY_DEFINITIONS } from "./categories"
import {
  CatalogUnavailable,
  getPackageIndex,
  getSnapshot,
  searchIndexedParts,
} from "./search-cache"
import { createSearchRequest, RequestError } from "./search-request"
import {
  renderHomePage,
  renderSearchPage,
  renderErrorPage,
  renderSimpleTablePage,
} from "./render"
import type { Env } from "./types"

const jsonWanted = (request: Request, url: URL) =>
  url.pathname.startsWith("/api/") ||
  url.pathname.endsWith(".json") ||
  url.searchParams.get("json") === "true" ||
  Boolean(request.headers.get("accept")?.includes("application/json"))

const respond = (
  body: unknown,
  json: boolean,
  status = 200,
  extra: Record<string, string> = {},
): Response =>
  new Response(json ? JSON.stringify(body) : String(body), {
    status,
    headers: {
      "content-type": json
        ? "application/json; charset=utf-8"
        : "text/html; charset=utf-8",
      "cache-control": status === 200 ? "public, max-age=60" : "no-store",
      "x-data-source": "d1+ti",
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "GET, OPTIONS",
      "access-control-allow-headers": "accept, content-type",
      vary: "Accept",
      "x-content-type-options": "nosniff",
      ...extra,
    },
  })

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)
    const pathname = url.pathname.replace(/\.json$/, "")
    const json = jsonWanted(request, url)
    if (request.method === "OPTIONS")
      return new Response(null, {
        status: 204,
        headers: {
          "access-control-allow-origin": "*",
          "access-control-allow-methods": "GET, OPTIONS",
          "access-control-allow-headers": "accept, content-type",
        },
      })
    if (request.method !== "GET")
      return respond({ error: { message: "Method Not Allowed" } }, true, 405, {
        allow: "GET, OPTIONS",
      })
    try {
      if (pathname === "/health")
        return respond({ ok: true }, true, 200, { "cache-control": "no-store" })
      if (pathname === "/") return respond(renderHomePage(), false)
      if (pathname === "/api/status") {
        const snapshot = await getSnapshot(env)
        return respond(
          {
            ready: true,
            source: "ti",
            catalog_updated_at: new Date(snapshot.imported_at).toISOString(),
            part_count: snapshot.part_count,
            currency: snapshot.currency,
          },
          true,
          200,
          { "cache-control": "no-store" },
        )
      }
      if (pathname === "/categories/list") {
        const categories = CATEGORY_DEFINITIONS.map(
          ({ path, label, responseKey }) => ({
            category: label,
            path,
            response_key: responseKey,
          }),
        )
        return respond(
          json
            ? { categories }
            : renderSimpleTablePage(pathname, "Categories", categories, url),
          json,
        )
      }
      if (
        pathname === "/footprint_index/list" ||
        pathname === "/package_index/list"
      ) {
        const footprints = await getPackageIndex(env)
        return respond(
          json
            ? { footprints }
            : renderSimpleTablePage(pathname, "Package Index", footprints, url),
          json,
        )
      }
      const category = CATEGORY_BY_PATH.get(pathname)
      if (
        category ||
        ["/api/search", "/api/index/search", "/components/list"].includes(
          pathname,
        )
      ) {
        const searchRequest = createSearchRequest(url, category?.responseKey)
        const payload = await searchIndexedParts(env, searchRequest)
        const { components, ...meta } = payload
        const body = pathname.startsWith("/api/")
          ? payload
          : { [category?.responseKey ?? "components"]: components, meta }
        return respond(
          json
            ? body
            : renderSearchPage(
                pathname,
                category?.label ?? "TI Component Search",
                payload,
                url,
                Boolean(category),
              ),
          json,
          200,
          { "x-cache": payload.stale ? "STALE" : "INDEX" },
        )
      }
      return respond(
        json
          ? { error: { message: "Not Found" } }
          : renderErrorPage(404, "Not Found"),
        json,
        404,
      )
    } catch (error) {
      const status =
        error instanceof RequestError
          ? 400
          : error instanceof CatalogUnavailable
            ? 503
            : 500
      const message =
        status === 500
          ? "Unable to query the catalog"
          : (error as Error).message
      return respond(
        json ? { error: { message } } : renderErrorPage(status, message),
        json,
        status,
        status === 503 ? { "retry-after": "3600" } : {},
      )
    }
  },
}
