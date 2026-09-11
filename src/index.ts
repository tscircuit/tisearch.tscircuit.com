import { CATEGORY_BY_PATH, CATEGORY_DEFINITIONS } from "./categories"
import { TiApiError, TiClient } from "./ti-client"
import {
  applyPostFilters,
  buildTiFilterOptions,
  normalizeSearchResponse,
} from "./normalize"
import {
  buildSearchPayload,
  getCachedSearch,
  getIndexedCategories,
  getPackageIndex,
  getRefreshCandidates,
  putCachedSearch,
  searchIndexedParts,
} from "./search-cache"
import {
  createSearchRequest,
  getSearchCacheKey,
  SearchInputError,
} from "./search-request"
import {
  renderErrorPage,
  renderHomePage,
  renderSearchPage,
  renderSimpleTablePage,
} from "./render"
import type { Env, SearchCacheRow, SearchPayload, SearchRequest } from "./types"

const clients = new WeakMap<Env, TiClient>()
const getClient = (env: Env): TiClient => {
  let client = clients.get(env)
  if (!client) {
    client = new TiClient(env, (input, init) => fetch(input, init))
    clients.set(env, client)
  }
  return client
}
const inFlight = new WeakMap<
  Env,
  Map<string, Promise<{ row: SearchCacheRow; payload: SearchPayload }>>
>()

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
    "x-data-source": "d1+ti",
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
    "x-data-source": "d1+ti",
  })
  if (options.cacheStatus) headers.set("x-cache", options.cacheStatus)
  if (options.retryAfter) headers.set("retry-after", options.retryAfter)
  addCorsHeaders(headers, origin)
  return new Response(html, { status: options.status ?? 200, headers })
}

const performRefresh = async (
  env: Env,
  cacheKey: string,
  searchRequest: SearchRequest,
): Promise<{
  row: SearchCacheRow
  payload: SearchPayload
}> => {
  const upstream = await getClient(env).search(searchRequest)
  const normalized = normalizeSearchResponse(
    upstream.response,
    env.TI_CURRENCY ?? "USD",
  )
  const filterOptions = buildTiFilterOptions(normalized)
  const components = applyPostFilters(normalized, searchRequest)
  const cached = await putCachedSearch(
    env,
    cacheKey,
    searchRequest,
    upstream.response,
    components,
    filterOptions,
    upstream.rateLimitRemaining,
    normalized,
  )
  return {
    row: cached.row,
    payload: buildSearchPayload(cached.row, cached.document, false, false),
  }
}

const refreshSearch = (env: Env, cacheKey: string, request: SearchRequest) => {
  let pending = inFlight.get(env)
  if (!pending) {
    pending = new Map()
    inFlight.set(env, pending)
  }
  const existing = pending.get(cacheKey)
  if (existing) return existing
  const task = performRefresh(env, cacheKey, request).finally(() =>
    pending.delete(cacheKey),
  )
  pending.set(cacheKey, task)
  return task
}

const refreshInBackground = async (
  env: Env,
  cacheKey: string,
  searchRequest: SearchRequest,
): Promise<void> => {
  try {
    await refreshSearch(env, cacheKey, searchRequest)
  } catch (error) {
    console.warn(
      "Background TI refresh failed",
      error instanceof TiApiError ? error.status : "upstream error",
    )
  }
}

const payloadForResponseKey = (
  payload: SearchPayload,
  responseKey: string,
): Record<string, unknown> => ({
  [responseKey]: payload.components,
  meta: {
    query: payload.query,
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
  const searchRequest = createSearchRequest(url, category)
  const json = pathname === "/api/search" || isJsonRequest(request, url)

  if (!searchRequest.query) {
    const message = "A non-empty q or search parameter is required"
    return json
      ? jsonResponse({ error: { message } }, origin, { status: 400 })
      : htmlResponse(renderErrorPage(pathname, 400, message), origin, {
          status: 400,
        })
  }

  const cacheKey = await getSearchCacheKey(
    searchRequest,
    env.TI_CURRENCY ?? "USD",
  )
  const cached = await getCachedSearch(env, cacheKey)
  const now = Date.now()

  let payload: SearchPayload
  let cacheStatus: "HIT" | "MISS" | "STALE"

  if (cached && cached.row.expires_at > now) {
    payload = buildSearchPayload(cached.row, cached.document, true, false)
    cacheStatus = "HIT"
  } else if (cached && cached.row.stale_until > now) {
    payload = buildSearchPayload(cached.row, cached.document, true, true)
    cacheStatus = "STALE"
    ctx.waitUntil(refreshInBackground(env, cacheKey, searchRequest))
  } else {
    try {
      const refreshed = await refreshSearch(env, cacheKey, searchRequest)
      payload = refreshed.payload
      cacheStatus = "MISS"
    } catch (error) {
      const apiError =
        error instanceof TiApiError
          ? error
          : new TiApiError("TI search failed", 502)
      const status = [401, 403, 429].includes(apiError.status)
        ? 503
        : apiError.status
      return json
        ? jsonResponse(
            {
              error: {
                message: apiError.message,
                upstream_status: apiError.status,
              },
            },
            origin,
            { status, retryAfter: apiError.retryAfter },
          )
        : htmlResponse(
            renderErrorPage(pathname, status, apiError.message),
            origin,
            { status, retryAfter: apiError.retryAfter },
          )
    }
  }

  if (json) {
    const body =
      pathname === "/api/search"
        ? payload
        : payloadForResponseKey(payload, searchRequest.responseKey)
    return jsonResponse(body, origin, { cacheStatus })
  }

  const label =
    category?.label ??
    (pathname === "/components/list"
      ? `TI Component Search: ${searchRequest.query}`
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
  const components = query ? await searchIndexedParts(env, query, limit) : []
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

const handleScheduled = async (env: Env): Promise<void> => {
  const candidates = await getRefreshCandidates(env, 20)
  const minimumRemaining = Number.parseInt(env.TI_MIN_REMAINING ?? "25", 10)
  // Leave room for D1 and OAuth within a 50-subrequest Worker invocation.
  let requestBudget = 44

  for (const row of candidates) {
    const searchRequest = JSON.parse(row.request_json) as SearchRequest
    const cost =
      (searchRequest.mode === "family" ? searchRequest.limit + 1 : 2) + 1
    if (cost > requestBudget) break
    requestBudget -= cost
    try {
      const cacheKey = await getSearchCacheKey(
        searchRequest,
        env.TI_CURRENCY ?? "USD",
      )
      const refreshed = await refreshSearch(env, cacheKey, searchRequest)
      if (
        refreshed.row.api_rate_limit_remaining !== null &&
        refreshed.row.api_rate_limit_remaining <= minimumRemaining
      )
        break
    } catch (error) {
      if (
        error instanceof TiApiError &&
        [401, 403, 429, 503].includes(error.status)
      )
        break
      console.warn("Scheduled TI refresh failed")
    }
  }
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
    _controller: ScheduledController,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<void> {
    ctx.waitUntil(handleScheduled(env))
  },
}
