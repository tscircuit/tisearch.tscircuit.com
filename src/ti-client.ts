import { validatePartNumber } from "./part-number"
import type {
  Env,
  SearchRequest,
  TiProductRecord,
  UpstreamSearchResult,
} from "./types"

// TI can reject default HTTP client identities before OAuth validation.
export const TI_USER_AGENT =
  "tisearch.tscircuit.com/0.1 (+https://tisearch.tscircuit.com)"

export class TiApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public retryAfter: string | null = null,
  ) {
    super(message)
  }
}

export class TiClient {
  private token?: { value: string; expiresAt: number }
  private tokenRequest?: Promise<string>
  private fetcher: typeof fetch
  constructor(
    private env: Env,
    fetcher: typeof fetch = fetch,
    private now = Date.now,
  ) {
    this.fetcher = (input, init) => fetcher(input, init)
  }

  private async accessToken(): Promise<string> {
    if (this.token && this.token.expiresAt > this.now()) return this.token.value
    if (this.tokenRequest) return this.tokenRequest
    this.tokenRequest = this.authenticate()
    try {
      return await this.tokenRequest
    } finally {
      this.tokenRequest = undefined
    }
  }

  private async authenticate(): Promise<string> {
    if (!this.env.TI_CLIENT_ID || !this.env.TI_CLIENT_SECRET)
      throw new TiApiError(
        "TI credentials are not configured on this Worker",
        503,
      )
    const response = await this.fetcher(
      "https://transact.ti.com/v1/oauth/accesstoken",
      {
        method: "POST",
        redirect: "manual",
        signal: AbortSignal.timeout(30_000),
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          "user-agent": TI_USER_AGENT,
        },
        body: new URLSearchParams({
          grant_type: "client_credentials",
          client_id: this.env.TI_CLIENT_ID,
          client_secret: this.env.TI_CLIENT_SECRET,
        }),
      },
    )
    if (!response.ok)
      throw new TiApiError(
        "TI authentication failed",
        response.status >= 300 && response.status < 400 ? 502 : response.status,
        response.headers.get("retry-after"),
      )
    const data = (await response.json().catch(() => {
      throw new TiApiError("Invalid TI OAuth JSON response", 502)
    })) as {
      access_token?: unknown
      expires_in?: unknown
    }
    const expires = Number(data?.expires_in)
    if (
      typeof data?.access_token !== "string" ||
      !data.access_token ||
      !Number.isFinite(expires) ||
      expires <= 0
    )
      throw new TiApiError("Invalid TI OAuth response", 502)
    this.token = {
      value: data.access_token,
      expiresAt: this.now() + Math.max(0, expires - 60) * 1000,
    }
    return data.access_token
  }

  private async getJson(
    url: URL,
  ): Promise<{ data: unknown; remaining: number | null; expiresAt?: number }> {
    const token = this.env.TI_GATEWAY ? undefined : await this.accessToken()
    const response = await this.fetcher(url, {
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        accept: "application/json",
        "user-agent": TI_USER_AGENT,
      },
      signal: AbortSignal.timeout(30_000),
      redirect: "manual",
    })
    if (!response.ok)
      throw new TiApiError(
        response.status === 429 && response.headers.has("x-ti-throttle-scope")
          ? `TI ${response.headers.get("x-ti-throttle-scope")} API is rate limited`
          : "TI product request failed",
        response.status >= 300 && response.status < 400 ? 502 : response.status,
        response.headers.get("retry-after"),
      )
    const data = await response.json().catch(() => {
      throw new TiApiError("Invalid TI product JSON response", 502)
    })
    const header =
      response.headers.get("x-ratelimit-remaining") ??
      response.headers.get("ratelimit-remaining")
    const n = header === null ? NaN : Number(header)
    const expiry = Number(response.headers.get("x-ti-cache-expires-at"))
    return {
      data,
      remaining: Number.isSafeInteger(n) && n >= 0 ? n : null,
      expiresAt: Number.isFinite(expiry) && expiry > 0 ? expiry : undefined,
    }
  }

  async discover(family: string, offset: number) {
    const url = new URL("https://transact.ti.com/v1/products")
    url.searchParams.set("ProductFamilyDescription", family)
    url.searchParams.set("Page", String(offset / 100))
    url.searchParams.set("Size", "100")
    const { data } = await this.getJson(url)
    const body = data as { Content?: unknown; TotalElements?: unknown }
    if (
      !body ||
      !Array.isArray(body.Content) ||
      body.Content.length > 100 ||
      typeof body.TotalElements !== "number" ||
      !Number.isSafeInteger(body.TotalElements) ||
      body.TotalElements < 0 ||
      (body.Content.length > 0 &&
        body.TotalElements < offset + body.Content.length)
    )
      throw new TiApiError("Invalid TI discovery page", 502)
    const information = body.Content as Record<string, unknown>[]
    for (const item of information) validatePartNumber(item?.Identifier)
    return {
      information,
      nextOffset:
        information.length && offset + information.length < body.TotalElements
          ? offset + 100
          : null,
    }
  }

  async specifications(partNumber: string) {
    const pn = validatePartNumber(partNumber)
    const { data } = await this.getJson(
      new URL(
        `https://transact.ti.com/v1/products/${encodeURIComponent(pn)}/parametrics`,
      ),
    )
    if (!data || typeof data !== "object" || Array.isArray(data))
      throw new TiApiError("Invalid TI parametrics", 502)
    return data as Record<string, unknown>
  }

  async inventory(partNumber: string) {
    const pn = validatePartNumber(partNumber)
    const url = new URL(
      `https://transact.ti.com/v2/store/products/${encodeURIComponent(pn)}`,
    )
    url.searchParams.set("currency", this.env.TI_CURRENCY ?? "USD")
    url.searchParams.set("exclude-evms", "true")
    const response = await this.getJson(url)
    const store = response.data as Record<string, unknown>
    if (
      !store ||
      typeof store.tiPartNumber !== "string" ||
      store.tiPartNumber.toUpperCase() !== pn.toUpperCase()
    )
      throw new TiApiError("TI returned a different orderable part number", 502)
    return {
      store,
      updatedAt: response.expiresAt
        ? response.expiresAt - 86400_000
        : this.now(),
    }
  }

  async search(request: SearchRequest): Promise<UpstreamSearchResult> {
    const currency = this.env.TI_CURRENCY ?? "USD"
    if (!/^[A-Z]{3}$/.test(currency))
      throw new TiApiError("Invalid TI currency configuration", 503)
    let inventoryUpdatedAt: number | undefined
    let partial = false
    let expiresAt: number | undefined
    let remaining: number | null = null
    const get = async (url: URL) => {
      const response = await this.getJson(url)
      if (url.pathname.startsWith("/v2/store/"))
        inventoryUpdatedAt = Math.min(
          inventoryUpdatedAt ?? Infinity,
          response.expiresAt ? response.expiresAt - 86400_000 : this.now(),
        )
      if (response.expiresAt)
        expiresAt = Math.min(expiresAt ?? Infinity, response.expiresAt)
      if (response.remaining !== null)
        remaining =
          remaining === null
            ? response.remaining
            : Math.min(remaining, response.remaining)
      return response.data
    }
    const storeUrl = (suffix: string) => {
      const url = new URL(`https://transact.ti.com/v2/store/products${suffix}`)
      url.searchParams.set("currency", currency)
      url.searchParams.set("exclude-evms", "true")
      return url
    }
    const object = (value: unknown): Record<string, unknown> => {
      if (!value || typeof value !== "object" || Array.isArray(value))
        throw new TiApiError("Invalid TI product response", 502)
      return value as Record<string, unknown>
    }
    const product = async (pn: string) => {
      validatePartNumber(pn)
      const raw = object(await get(storeUrl(`/${encodeURIComponent(pn)}`)))
      if (
        typeof raw.tiPartNumber !== "string" ||
        raw.tiPartNumber.toUpperCase() !== pn.toUpperCase()
      )
        throw new TiApiError(
          "TI returned a different orderable part number",
          502,
        )
      return raw
    }
    const enrich = async (
      record: TiProductRecord,
    ): Promise<TiProductRecord> => {
      if (partial) return record
      const pn = validatePartNumber(record.store.tiPartNumber)
      try {
        record.parametrics = object(
          await get(
            new URL(
              `https://transact.ti.com/v1/products/${encodeURIComponent(pn)}/parametrics`,
            ),
          ),
        )
      } catch (error) {
        // TI has no parametric record for some Store listings.
        if (error instanceof TiApiError && error.status === 429) {
          // Electrical specs are optional; retain the actual Store stock/prices.
          // Stop enrichment after throttling rather than repeating failed calls.
          partial = true
          expiresAt = Math.min(expiresAt ?? Infinity, this.now() + 3600_000)
          return record
        }
        if (!(error instanceof TiApiError) || error.status !== 404) throw error
        record.parametrics = {}
      }
      return record
    }
    // Translate arbitrary public offsets into TI's integer page/size contract.
    const collection = async (url: URL, info: boolean) => {
      const pageKey = info ? "Page" : "page"
      const sizeKey = info ? "Size" : "size"
      const contentKey = info ? "Content" : "content"
      const totalKey = info ? "TotalElements" : "totalElements"
      const page = Math.floor(request.offset / request.limit)
      const skip = request.offset % request.limit
      const read = async (index: number) => {
        url.searchParams.set(pageKey, String(index))
        url.searchParams.set(sizeKey, String(request.limit))
        const body = object(await get(new URL(url)))
        const content = body[contentKey]
        const total = body[totalKey]
        if (
          !Array.isArray(content) ||
          content.length > request.limit ||
          typeof total !== "number" ||
          !Number.isSafeInteger(total) ||
          total < 0 ||
          (content.length > 0 && total < index * request.limit + content.length)
        )
          throw new TiApiError(
            info
              ? "Invalid TI product information page"
              : "Invalid TI product page",
            502,
          )
        return { content, total }
      }
      const first = await read(page)
      let content = first.content.slice(skip)
      if (
        skip &&
        content.length < request.limit &&
        (page + 1) * request.limit < first.total
      ) {
        const second = await read(page + 1)
        content = content.concat(
          second.content.slice(0, request.limit - content.length),
        )
      }
      return { content, total: first.total }
    }
    let products: TiProductRecord[] = []
    let total: number
    let count: number
    if (request.mode === "part") {
      const pn = validatePartNumber(request.query)
      try {
        const store = await product(pn)
        return {
          response: {
            products: request.offset === 0 ? [await enrich({ store })] : [],
            expiresAt,
            inventoryUpdatedAt,
            ...(partial ? { partial: true } : {}),
            upstreamTotal: 1,
            nextOffset: null,
          },
          rateLimitRemaining: remaining,
        }
      } catch (error) {
        if (!(error instanceof TiApiError) || error.status !== 404) throw error
      }
      // Store V2 supports exact base-part queries, not arbitrary keyword searches.
      const url = storeUrl("")
      url.searchParams.set("gpn", pn)
      const body = await collection(url, false)
      products = body.content.map((raw) => ({ store: object(raw) }))
      for (const { store } of products) {
        if (
          typeof store.genericPartNumber !== "string" ||
          store.genericPartNumber.toUpperCase() !== pn.toUpperCase()
        )
          throw new TiApiError("TI returned a different base part number", 502)
      }
      total = body.total
      count = body.content.length
    } else {
      const url = new URL("https://transact.ti.com/v1/products")
      url.searchParams.set("ProductFamilyDescription", request.query)
      if (request.postFilters.num_pins)
        url.searchParams.set("Pin", request.postFilters.num_pins)
      if (request.postFilters.lifecycle)
        url.searchParams.set(
          "LifeCycleStatus",
          request.postFilters.lifecycle.toUpperCase(),
        )
      if (request.postFilters.package_code)
        url.searchParams.set(
          "PackageType",
          request.postFilters.package_code.toUpperCase(),
        )
      const body = await collection(url, true)
      count = body.content.length
      total = body.total
      // Fetch at most 20 Store listings; each is enriched once below.
      // Product Information's InventoryStatus is explicitly unsupported by TI.
      for (const raw of body.content) {
        const information = object(raw)
        const pn = validatePartNumber(information.Identifier)
        try {
          products.push({ store: await product(pn), information })
        } catch (error) {
          if (!(error instanceof TiApiError) || error.status !== 404)
            throw error
          // A product without a TI Store listing is not available for this search.
        }
      }
    }
    if (
      !Number.isSafeInteger(total) ||
      total < 0 ||
      (count > 0 && total < request.offset + count)
    )
      throw new TiApiError("Invalid TI product count", 502)
    for (let i = 0; i < products.length; i++)
      products[i] = await enrich(products[i])
    return {
      response: {
        products,
        ...(inventoryUpdatedAt !== undefined ? { inventoryUpdatedAt } : {}),
        ...(partial ? { partial: true } : {}),
        ...(expiresAt ? { expiresAt } : {}),
        upstreamTotal: total,
        nextOffset:
          count > 0 && request.offset + count < total
            ? request.offset + request.limit
            : null,
      },
      rateLimitRemaining: remaining,
    }
  }
}
