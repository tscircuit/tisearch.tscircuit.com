import { DurableObject } from "cloudflare:workers"
import type { Env } from "./types"

interface Entry {
  body: string
  status: number
  expiresAt: number
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
    if (cached && cached.expiresAt > now)
      return new Response(cached.body, {
        status: cached.status,
        headers: {
          "content-type": "application/json",
          "x-ti-cache-expires-at": String(cached.expiresAt),
        },
      })
    const cooldown = (await this.ctx.storage.get<number>("cooldown")) ?? 0
    if (cooldown > now) return this.throttled(cooldown)
    const nextRequest =
      (await this.ctx.storage.get<number>("next-request")) ?? 0
    if (nextRequest > now)
      await new Promise((resolve) => setTimeout(resolve, nextRequest - now))
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
      await this.ctx.storage.put("cooldown", until)
      await response.body?.cancel()
      return this.throttled(until)
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
          Date.now() + (response.status === 404 ? 3600 : 86400) * 1000
        headers.set("x-ti-cache-expires-at", String(expiresAt))
        await this.ctx.storage.put(key, {
          body,
          status: response.status,
          expiresAt,
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

  private throttled(until: number) {
    return Response.json(
      { error: "TI is rate limited; cached requests remain available" },
      {
        status: 429,
        headers: {
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
