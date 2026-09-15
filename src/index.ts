import { searchResponseBody } from "./jlc/search-stream"
import taxonomy from "./jlc/taxonomy.json"
import { COMPATIBLE_ROUTES, queryCompatibleCategory } from "./jlc/catalog"
import {
  renderD1TablePage,
  renderHomePage as renderReferenceHomePage,
} from "./jlc/render"
import { CATEGORY_BY_PATH } from "./categories"
import { queryCatalog } from "./catalog"
import { syncMetadata, refreshInventory } from "./catalog-sync"
import { getPackageIndex } from "./parts-store"
import { SearchInputError } from "./search-request"
import { renderErrorPage, renderSearchPage } from "./render"
import type { Env, SearchPayload } from "./types"

export { BulkCatalogImporter } from "./bulk-catalog"
export { TiGateway } from "./ti-gateway"

const addCorsHeaders = (headers: Headers, origin: string | null): void => {
  headers.set("access-control-allow-origin", origin ?? "*")
  headers.set("access-control-allow-methods", "GET, OPTIONS")
  headers.set("access-control-allow-headers", "accept, content-type")
  headers.set("vary", "Accept, Origin")
}

const isJsonRequest = (request: Request, url: URL): boolean =>
  url.pathname.startsWith("/api/") ||
  url.pathname.endsWith(".json") ||
  url.searchParams.get("json") === "true" ||
  Boolean(request.headers.get("accept")?.includes("application/json"))

const jsonResponse = (
  value: unknown,
  origin: string | null,
  options: {
    status?: number
    cacheStatus?: "HIT" | "MISS" | "STALE" | "INDEX"
    retryAfter?: string | null
  } = {},
): Response => {
  const headers = new Headers({
    "content-type": "application/json; charset=utf-8",
    "cache-control":
      (options.status ?? 200) >= 400 ? "no-store" : "public, max-age=60",
    "x-data-source": "d1",
  })
  if (options.cacheStatus) headers.set("x-cache", options.cacheStatus)
  if (options.retryAfter) headers.set("retry-after", options.retryAfter)
  addCorsHeaders(headers, origin)
  return new Response(JSON.stringify(value), {
    status: options.status ?? 200,
    headers,
  })
}

const htmlResponse = (
  html: string,
  origin: string | null,
  options: {
    status?: number
    cacheStatus?: "HIT" | "MISS" | "STALE" | "INDEX"
    retryAfter?: string | null
  } = {},
): Response => {
  const headers = new Headers({
    "content-type": "text/html; charset=utf-8",
    "cache-control":
      (options.status ?? 200) >= 400 ? "no-store" : "public, max-age=60",
    "x-data-source": "d1",
  })
  if (options.cacheStatus) headers.set("x-cache", options.cacheStatus)
  if (options.retryAfter) headers.set("retry-after", options.retryAfter)
  addCorsHeaders(headers, origin)
  return new Response(html, { status: options.status ?? 200, headers })
}

const payloadForResponseKey = (
  payload: SearchPayload,
  responseKey: string,
): Record<string, unknown> => ({
  [responseKey]: payload.components,
  meta: {
    query: payload.query,
    ...(payload.partial ? { partial: true, warnings: payload.warnings } : {}),
    filter_scope: "catalog",
    catalog_complete: false,
    last_updated_at: payload.last_updated_at,
    total: payload.total,
    upstream_total: payload.upstream_total,
    limit: payload.limit,
    offset: payload.offset,
    next_offset: payload.next_offset,
    source: payload.source,
    cached: payload.cached,
    stale: payload.stale,
    cache_expires_at: payload.cache_expires_at,
    filter_options: payload.filter_options,
  },
})

const handleSearchRoute = async (
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  url: URL,
  pathname: string,
  origin: string | null,
): Promise<Response> => {
  const category = CATEGORY_BY_PATH.get(pathname)
  const json = pathname === "/api/search" || isJsonRequest(request, url)
  const payload = await queryCatalog(env, url, category)
  const cacheStatus = "INDEX" as const

  if (json) {
    const body =
      pathname === "/api/search"
        ? payload
        : payloadForResponseKey(payload, category?.responseKey ?? "components")
    return jsonResponse(body, origin, { cacheStatus })
  }

  const label =
    category?.label ??
    (pathname === "/components/list"
      ? `TI Component Search${payload.query ? `: ${payload.query}` : ""}`
      : "TI Component Search")
  return htmlResponse(
    renderSearchPage(pathname, label, category, payload, url.toString()),
    origin,
    { cacheStatus },
  )
}

const handleCategories = async (
  request: Request,
  env: Env,
  url: URL,
  origin: string | null,
): Promise<Response> => {
  const categoryName = url.searchParams.get("category_name")
  const categories = categoryName
    ? taxonomy.subcategories.filter((row) => row.category === categoryName)
    : taxonomy.categories
  return isJsonRequest(request, url)
    ? jsonResponse({ categories }, origin, { cacheStatus: "INDEX" })
    : htmlResponse(
        renderD1TablePage(
          "/categories/list",
          { categories },
          Object.fromEntries(url.searchParams),
          url.pathname + url.search,
        ),
        origin,
        { cacheStatus: "INDEX" },
      )
}

const handlePackageIndex = async (
  request: Request,
  env: Env,
  url: URL,
  origin: string | null,
): Promise<Response> => {
  const footprints = (await getPackageIndex(env))
    .filter(
      (p) =>
        url.pathname.startsWith("/package_index/") || p.num_components > 10,
    )
    .map(({ stock, ...part }) => part)
    .sort((a, b) => b.num_components - a.num_components)
  if (isJsonRequest(request, url)) {
    return jsonResponse({ footprints }, origin, { cacheStatus: "INDEX" })
  }
  return htmlResponse(
    renderD1TablePage(
      "/footprint_index/list",
      { footprints },
      {},
      url.pathname + url.search,
    ),
    origin,
    { cacheStatus: "INDEX" },
  )
}

const handleIndexedSearch = async (
  env: Env,
  url: URL,
  origin: string | null,
): Promise<Response> => {
  const query = url.searchParams.get("q")?.trim() ?? ""
  const limit = Number(url.searchParams.get("limit") || "10")
  if (
    query.length > 200 ||
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > 50
  )
    throw new SearchInputError("Invalid index query or limit")
  const components = query
    ? (await queryCatalog(env, url)).components.slice(0, limit)
    : []
  return jsonResponse(
    { query, components, source: "ti-d1-index", partial: true },
    origin,
    { cacheStatus: "INDEX" },
  )
}

const handleFetch = async (
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> => {
  const url = new URL(request.url)
  const origin = request.headers.get("origin")
  if (request.method === "OPTIONS") {
    const headers = new Headers()
    addCorsHeaders(headers, origin)
    return new Response(null, { status: 204, headers })
  }
  if (request.method !== "GET") {
    return jsonResponse(
      {
        error: {
          error_code: "method_not_allowed",
          message: "Method Not Allowed",
        },
      },
      origin,
      {
        status: 405,
      },
    )
  }

  const pathname = url.pathname.replace(/\.json$/, "")
  if (pathname === "/robots.txt")
    return new Response("User-agent: *\nDisallow: /api/\n", {
      headers: { "content-type": "text/plain; charset=utf-8" },
    })
  if (pathname === "/_d1/health") {
    const rows = await env.DB.prepare(
      "SELECT ti_product_number FROM parts LIMIT 1",
    ).all()
    return jsonResponse(
      { ok: true, d1: true, use_d1: "true", rows: rows.results.length },
      origin,
    )
  }
  if (
    pathname.startsWith("/api/footprinter_strings/") ||
    pathname.startsWith("/api/easyeda_components/")
  ) {
    const id = pathname.split("/").at(-1) ?? ""
    const valid =
      /^c?[0-9]+$/i.test(id) &&
      Number.isSafeInteger(Number(id.replace(/^c/i, ""))) &&
      Number(id.replace(/^c/i, "")) > 0
    if (valid && pathname.startsWith("/api/easyeda_components/"))
      return jsonResponse(
        {
          easyeda_component_details: {
            lcsc: Number(id.replace(/^c/i, "")),
            easyeda_uuid: null,
            fetched_at: null,
            easyeda_json: null,
          },
          error: {
            error_code: "component_not_found",
            message: "No EasyEDA data is provided by the TI API",
          },
        },
        origin,
        { status: 404 },
      )
    return jsonResponse(
      valid
        ? {
            ok: false,
            error: { error_code: "not_found", message: "Not Found" },
          }
        : {
            error: {
              error_code: "invalid_lcsc",
              message:
                "LCSC must be a positive integer with an optional C prefix",
            },
          },
      origin,
      { status: valid ? 404 : 400 },
    )
  }
  if (pathname === "/api/catalog/status") {
    const status = await env.BULK_IMPORT.get(
      env.BULK_IMPORT.idFromName("ti-catalog"),
    ).fetch("https://bulk/status")
    const response = jsonResponse(await status.json(), origin)
    response.headers.set("cache-control", "no-store")
    return response
  }
  if (pathname === "/health") {
    return jsonResponse({ ok: true }, origin)
  }
  if (pathname === "/") {
    return htmlResponse(renderReferenceHomePage(), origin)
  }
  if (pathname === "/components/list" || pathname === "/api/search") {
    const json = isJsonRequest(request, url)
    const body = await searchResponseBody(
      env,
      pathname,
      Object.fromEntries(url.searchParams),
      json,
      url.pathname + url.search,
    )
    const template = json
      ? jsonResponse({}, origin, { cacheStatus: "INDEX" })
      : htmlResponse("", origin, { cacheStatus: "INDEX" })
    const response = new Response(body, { headers: template.headers })
    response.headers.set("x-catalog-complete", "false")
    return response
  }
  if (COMPATIBLE_ROUTES.includes(pathname)) {
    const params = Object.fromEntries(url.searchParams)
    const result = await queryCompatibleCategory(env, pathname, params)
    const response = isJsonRequest(request, url)
      ? jsonResponse(result.data, origin, { cacheStatus: "INDEX" })
      : htmlResponse(
          renderD1TablePage(
            pathname,
            result.data,
            params,
            url.pathname.replace(/\.json$/, "") + url.search,
            result.filterOptions,
            "productUrls" in result ? result.productUrls : {},
          ),
          origin,
          { cacheStatus: "INDEX" },
        )
    response.headers.set("x-catalog-complete", "false")
    return response
  }
  if (pathname === "/categories/list") {
    return handleCategories(request, env, url, origin)
  }
  if (
    pathname === "/footprint_index/list" ||
    pathname === "/package_index/list"
  ) {
    return handlePackageIndex(request, env, url, origin)
  }
  if (pathname === "/api/index/search") {
    return handleIndexedSearch(env, url, origin)
  }
  if (
    pathname === "/api/search" ||
    pathname === "/components/list" ||
    CATEGORY_BY_PATH.has(pathname)
  ) {
    return handleSearchRoute(request, env, ctx, url, pathname, origin)
  }

  const json = isJsonRequest(request, url)
  return json
    ? jsonResponse(
        { ok: false, error: { error_code: "not_found", message: "Not Found" } },
        origin,
        { status: 404 },
      )
    : htmlResponse(renderErrorPage(pathname, 404, "Not Found"), origin, {
        status: 404,
      })
}

export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<Response> {
    try {
      const response = await handleFetch(request, env, ctx)
      if (
        ["1", "true"].includes(
          new URL(request.url).searchParams.get("cachebust")?.toLowerCase() ??
            "",
        )
      ) {
        response.headers.set("cache-control", "no-store")
        response.headers.set("x-cache-bust", "1")
      }
      return response
    } catch (error) {
      const status = error instanceof SearchInputError ? 400 : 500
      const message =
        error instanceof SearchInputError
          ? error.message
          : "TI search service unavailable"
      const origin = request.headers.get("origin")
      const url = new URL(request.url)
      return isJsonRequest(request, url)
        ? jsonResponse({ error: { message } }, origin, { status })
        : htmlResponse(renderErrorPage(url.pathname, status, message), origin, {
            status,
          })
    }
  },
  async scheduled(
    controller: ScheduledController,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<void> {
    ctx.waitUntil(
      env.BULK_IMPORT.get(env.BULK_IMPORT.idFromName("ti-catalog")).fetch(
        "https://bulk/tick",
        { method: "POST" },
      ),
    )
    if (controller.cron === "2-57/5 * * * *") return
    ctx.waitUntil(
      controller.cron === "17 */6 * * *"
        ? syncMetadata(env)
        : refreshInventory(env),
    )
  },
}
