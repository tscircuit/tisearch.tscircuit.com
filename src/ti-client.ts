import { validatePartNumber } from "./part-number"

export const getTiProductUrl = (partNumber: string, currency = "USD"): URL => {
  const pn = validatePartNumber(partNumber)
  if (!/^[A-Z]{3}$/.test(currency)) throw new Error("Invalid currency code")
  const url = new URL(
    `https://transact.ti.com/v2/store/products/${encodeURIComponent(pn)}`,
  )
  url.searchParams.set("currency", currency)
  url.searchParams.set("exclude-evms", "true")
  return url
}

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
  constructor(
    private clientId: string,
    private clientSecret: string,
    private fetcher: typeof fetch = fetch,
    private now = Date.now,
  ) {}

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
    if (!this.clientId || !this.clientSecret)
      throw new Error("TI_CLIENT_ID and TI_CLIENT_SECRET are required")
    const response = await this.fetcher(
      "https://transact.ti.com/v1/oauth/accesstoken",
      {
        method: "POST",
        redirect: "error",
        signal: AbortSignal.timeout(30_000),
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "client_credentials",
          client_id: this.clientId,
          client_secret: this.clientSecret,
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

  async getCatalog(currency = "USD"): Promise<unknown> {
    if (!/^[A-Z]{3}$/.test(currency)) throw new Error("Invalid currency code")
    const url = new URL("https://transact.ti.com/v2/store/products/catalog")
    url.searchParams.set("currency", currency)
    url.searchParams.set("exclude-evms", "true")
    return this.getJson(url, "catalog", 180_000)
  }

  async getProduct(partNumber: string, currency = "USD"): Promise<unknown> {
    return this.getJson(
      getTiProductUrl(partNumber, currency),
      "product",
      30_000,
    )
  }

  private async getJson(
    url: URL,
    resource: "catalog" | "product",
    timeout: number,
  ): Promise<unknown> {
    const token = await this.accessToken()
    const response = await this.fetcher(url, {
      headers: { authorization: `Bearer ${token}`, accept: "application/json" },
      signal: AbortSignal.timeout(timeout),
      redirect: "error",
    })
    // Never automatically retry a catalog request: TI allows only one per four hours.
    // Do not log upstream bodies, which may contain account or credential details.
    if (!response.ok)
      throw new TiApiError(
        `TI ${resource} request failed`,
        response.status,
        response.headers.get("retry-after"),
      )
    return response.json().catch(() => {
      throw new TiApiError(`Invalid TI ${resource} JSON response`, 502)
    })
  }
}
