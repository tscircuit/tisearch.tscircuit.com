import { DurableObject } from "cloudflare:workers"
import { TI_USER_AGENT } from "./ti-client"
import type { Env } from "./types"

interface Entry {
  body: string
  status: number
  expiresAt: number
  fetchedAt?: number
}

// All isolates use one object: URL cache, pacing and cooldown are account-wide.
// Credentials and OAuth responses are never persisted in its storage.
export class TiGateway extends DurableObject<Env> {
  private oauthCache?: Entry & { requestBody: string }
  private queue: Promise<unknown> = Promise.resolve()
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)
    const oauth = url.pathname === "/v1/oauth/accesstoken"
    if (
      url.origin !== "https://transact.ti.com" ||
      (oauth ? request.method !== "POST" : request.method !== "GET") ||
      (!oauth &&
        !/^\/(v1\/products|v2\/store\/products)(\/|$)/.test(url.pathname))
    )
      return new Response(null, { status: 400 })
    const task = this.queue.then(() => this.forward(request, oauth))
    this.queue = task.catch(() => {})
    return task
  }

  private async forward(request: Request, oauth: boolean): Promise<Response> {
    const scope = oauth
      ? "oauth"
      : new URL(request.url).pathname.startsWith("/v2/")
        ? "store"
        : "information"
    const requestBody = oauth ? await request.clone().text() : ""
    if (
      oauth &&
      this.oauthCache &&
      this.oauthCache.expiresAt > Date.now() &&
      this.oauthCache.requestBody === requestBody
    )
      return Response.json({
        ...JSON.parse(this.oauthCache.body),
        expires_in: Math.max(
          1,
          Math.floor((this.oauthCache.expiresAt - Date.now()) / 1000),
        ),
      })
    const key = `response:${request.url}`
    const cached = oauth ? undefined : await this.ctx.storage.get<Entry>(key)
    const now = Date.now()
    // Retain previously fetched static metadata when upgrading the one-day cache.
    if (
      cached &&
      scope === "information" &&
      cached.status === 200 &&
      !cached.fetchedAt
    ) {
      cached.fetchedAt = cached.expiresAt - 86400_000
      cached.expiresAt = cached.fetchedAt + 30 * 86400_000
      await this.ctx.storage.put(key, cached)
    }
    if (cached && cached.expiresAt > now)
      return new Response(cached.body, {
        status: cached.status,
        headers: {
          "content-type": "application/json",
          "x-ti-cache-expires-at": String(cached.expiresAt),
        },
      })
    const cooldown = Math.max(
      (await this.ctx.storage.get<number>(`cooldown:${scope}`)) ?? 0,
      (await this.ctx.storage.get<number>("cooldown")) ?? 0,
    )
    if (cooldown > now) return this.throttled(cooldown, scope)
    // Production callers send no token: authentication happens only on a cache miss.
    if (!oauth && !request.headers.has("authorization")) {
      if (!this.env.TI_CLIENT_ID || !this.env.TI_CLIENT_SECRET)
        return Response.json(
          { error: "TI credentials are not configured" },
          { status: 503 },
        )
      const auth = await this.forward(
        new Request("https://transact.ti.com/v1/oauth/accesstoken", {
          method: "POST",
          headers: {
            "content-type": "application/x-www-form-urlencoded",
            "user-agent": TI_USER_AGENT,
          },
          body: new URLSearchParams({
            grant_type: "client_credentials",
            client_id: this.env.TI_CLIENT_ID,
            client_secret: this.env.TI_CLIENT_SECRET,
          }),
        }),
        true,
      )
      if (!auth.ok) return auth
      const data = (await auth.json()) as { access_token?: unknown }
      if (typeof data.access_token !== "string" || !data.access_token)
        return Response.json(
          { error: "Invalid TI OAuth response" },
          { status: 502 },
        )
      const headers = new Headers(request.headers)
      headers.set("authorization", `Bearer ${data.access_token}`)
      request = new Request(request, { headers })
    }
    const nextRequest =
      (await this.ctx.storage.get<number>("next-request")) ?? 0
    if (nextRequest > Date.now())
      await new Promise((resolve) =>
        setTimeout(resolve, nextRequest - Date.now()),
      )
    // Two calls per second, including OAuth, below TI's five/second ceiling.
    await this.ctx.storage.put("next-request", Date.now() + 500)
    const response = await fetch(request, {
      redirect: "manual",
      signal: AbortSignal.timeout(30_000),
    })
    if (response.status === 429) {
      const raw = response.headers.get("retry-after")
      const seconds = raw && /^\d+$/.test(raw) ? Number(raw) : NaN
      const date = raw ? Date.parse(raw) : NaN
      const until = Math.max(
        Date.now() + 60_000,
        Number.isFinite(seconds)
          ? Date.now() + seconds * 1000
          : Number.isFinite(date)
            ? date
            : 0,
      )
      await this.ctx.storage.put(`cooldown:${scope}`, until)
      const detail = (await response
        .clone()
        .json()
        .catch(() => null)) as {
        fault?: { detail?: { errorcode?: string } }
      } | null
      console.warn("TI throttle", {
        scope,
        path: new URL(request.url).pathname,
        retryAfter: raw,
        code: detail?.fault?.detail?.errorcode ?? null,
        remaining: response.headers.get("x-ratelimit-remaining"),
        limit: response.headers.get("x-ratelimit-limit"),
      })
      await response.body?.cancel()
      return this.throttled(until, scope)
    }
    if (oauth && response.ok) {
      const body = await response.text()
      try {
        const data = JSON.parse(body)
        if (
          typeof data.access_token === "string" &&
          Number(data.expires_in) > 60
        )
          this.oauthCache = {
            body,
            status: 200,
            requestBody,
            expiresAt: Date.now() + (Number(data.expires_in) - 60) * 1000,
          }
      } catch {}
      return new Response(body, {
        status: response.status,
        headers: response.headers,
      })
    }
    if (!oauth && (response.ok || response.status === 404)) {
      const body = await response.text()
      // Cache only valid JSON successes; never turn a malformed response into a day-long failure.
      let valid = response.status === 404
      try {
        JSON.parse(body)
        valid = true
      } catch {}
      const headers = new Headers(response.headers)
      if (valid) {
        const expiresAt =
          Date.now() +
          (response.status === 404
            ? 3600
            : scope === "information"
              ? 30 * 86400
              : 86400) *
            1000
        headers.set("x-ti-cache-expires-at", String(expiresAt))
        await this.ctx.storage.put(key, {
          body,
          status: response.status,
          expiresAt,
          fetchedAt: Date.now(),
        } satisfies Entry)
        if (!(await this.ctx.storage.getAlarm()))
          await this.ctx.storage.setAlarm(Date.now() + 86400_000)
      }
      return new Response(body, {
        status: response.status,
        headers,
      })
    }
    return response
  }

  private throttled(until: number, scope: string) {
    console.info("TI cooldown", {
      scope,
      retryAfter: Math.max(1, Math.ceil((until - Date.now()) / 1000)),
    })
    return Response.json(
      {
        error: `TI ${scope} is rate limited; cached requests remain available`,
      },
      {
        status: 429,
        headers: {
          "x-ti-throttle-scope": scope,
          "retry-after": String(
            Math.max(1, Math.ceil((until - Date.now()) / 1000)),
          ),
        },
      },
    )
  }

  async alarm() {
    const entries = await this.ctx.storage.list<Entry>({ prefix: "response:" })
    const expired = [...entries]
      .filter(([, value]) => value.expiresAt <= Date.now())
      .map(([key]) => key)
    for (let i = 0; i < expired.length; i += 128)
      await this.ctx.storage.delete(expired.slice(i, i + 128))
    if (entries.size > expired.length)
      await this.ctx.storage.setAlarm(Date.now() + 86400_000)
  }
}
