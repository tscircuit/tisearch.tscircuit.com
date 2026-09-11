import { validatePartNumber } from "./part-number"
import type {
  Env,
  SearchRequest,
  TiProductRecord,
  UpstreamSearchResult,
} from "./types"

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
        redirect: "error",
        signal: AbortSignal.timeout(30_000),
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "client_credentials",
          client_id: this.env.TI_CLIENT_ID,
          client_secret: this.env.TI_CLIENT_SECRET,
        }),
      },
    )
    if (!response.ok)
      throw new TiApiError("TI authentication failed", response.status)
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
  ): Promise<{ data: unknown; remaining: number | null }> {
    const token = await this.accessToken()
    const response = await this.fetcher(url, {
      headers: { authorization: `Bearer ${token}`, accept: "application/json" },
      signal: AbortSignal.timeout(30_000),
      redirect: "error",
    })
    if (!response.ok)
      throw new TiApiError(
        "TI product request failed",
        response.status,
        response.headers.get("retry-after"),
      )
    const data = await response.json().catch(() => {
      throw new TiApiError("Invalid TI product JSON response", 502)
    })
    const header =
      response.headers.get("x-ratelimit-remaining") ??
      response.headers.get("ratelimit-remaining")
    const n = header === null ? NaN : Number(header)
    return { data, remaining: Number.isSafeInteger(n) && n >= 0 ? n : null }
  }

  async search(request: SearchRequest): Promise<UpstreamSearchResult> {
    const currency = this.env.TI_CURRENCY ?? "USD"
    if (!/^[A-Z]{3}$/.test(currency))
      throw new TiApiError("Invalid TI currency configuration", 503)
    let remaining: number | null = null
    const get = async (url: URL) => {
      const response = await this.getJson(url)
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
    const page = request.offset / request.limit
    let products: TiProductRecord[] = []
    let total: number
    let count: number
    if (request.mode === "part") {
      const pn = validatePartNumber(request.query)
      try {
        const store = await product(pn)
        return {
          response: {
            products: request.offset === 0 ? [{ store }] : [],
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
      url.searchParams.set("page", String(page))
      url.searchParams.set("size", String(request.limit))
      const body = object(await get(url))
      if (!Array.isArray(body.content) || body.content.length > request.limit)
        throw new TiApiError("Invalid TI product page", 502)
      products = body.content.map((raw) => ({ store: object(raw) }))
      for (const { store } of products) {
        if (
          typeof store.genericPartNumber !== "string" ||
          store.genericPartNumber.toUpperCase() !== pn.toUpperCase()
        )
          throw new TiApiError("TI returned a different base part number", 502)
      }
      total = typeof body.totalElements === "number" ? body.totalElements : NaN
      count = body.content.length
    } else {
      const url = new URL("https://transact.ti.com/v1/products")
      url.searchParams.set("ProductFamilyDescription", request.query)
      url.searchParams.set("Page", String(page))
      url.searchParams.set("Size", String(request.limit))
      if (request.postFilters.num_pins)
        url.searchParams.set("Pin", request.postFilters.num_pins)
      if (request.postFilters.lifecycle)
        url.searchParams.set("LifeCycleStatus", request.postFilters.lifecycle)
      if (request.postFilters.package_code)
        url.searchParams.set("PackageType", request.postFilters.package_code)
      const body = object(await get(url))
      if (!Array.isArray(body.Content) || body.Content.length > request.limit)
        throw new TiApiError("Invalid TI product information page", 502)
      count = body.Content.length
      total = typeof body.TotalElements === "number" ? body.TotalElements : NaN
      // Bound fan-out to one Store lookup per result, at most 20 per page.
      // Product Information's InventoryStatus is explicitly unsupported by TI.
      for (const raw of body.Content) {
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
    return {
      response: {
        products,
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
