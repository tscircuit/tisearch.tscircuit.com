import { CATEGORY_BY_PATH, CATEGORY_DEFINITIONS } from "./categories"
import { queryCatalog } from "./catalog"
import { syncMetadata, refreshInventory } from "./catalog-sync"
import { getIndexedCategories, getPackageIndex } from "./parts-store"
import { SearchInputError } from "./search-request"
import {
  renderErrorPage,
  renderHomePage,
  renderSearchPage,
  renderSimpleTablePage,
} from "./render"
import type { Env, SearchPayload } from "./types"

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
  const indexed = await getIndexedCategories(env)
  const categories = CATEGORY_DEFINITIONS.map((category) => ({
    group: category.group,
    category: category.label,
    subcategory: category.query,
    path: category.path,
  }))
  if (isJsonRequest(request, url)) {
    return jsonResponse({ categories, indexed_categories: indexed }, origin, {
      cacheStatus: "INDEX",
    })
  }
  return htmlResponse(
    renderSimpleTablePage(
      "/categories/list",
      "Categories",
      categories,
      url.toString(),
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
  const footprints = await getPackageIndex(env)
  if (isJsonRequest(request, url)) {
    return jsonResponse({ footprints }, origin, { cacheStatus: "INDEX" })
  }
  return htmlResponse(
    renderSimpleTablePage(
      "/footprint_index/list",
      "Package Index",
      footprints,
      url.toString(),
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
    return jsonResponse({ error: { message: "Method Not Allowed" } }, origin, {
      status: 405,
    })
  }

  const pathname = url.pathname.replace(/\.json$/, "")
  if (pathname === "/robots.txt")
    return new Response("User-agent: *\nDisallow: /api/\n", {
      headers: { "content-type": "text/plain; charset=utf-8" },
    })
  if (pathname === "/health") {
    return jsonResponse({ ok: true }, origin)
  }
  if (pathname === "/") {
    return htmlResponse(renderHomePage(), origin)
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
    ? jsonResponse({ error: { message: "Not Found" } }, origin, { status: 404 })
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
      return await handleFetch(request, env, ctx)
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
      controller.cron === "17 */6 * * *"
        ? syncMetadata(env)
        : refreshInventory(env),
    )
  },
}
