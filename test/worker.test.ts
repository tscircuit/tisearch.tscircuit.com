import { env } from "cloudflare:test"
import { beforeEach, describe, expect, it } from "vitest"
import worker from "../src/index"
import { claimCatalogRequestSql, createSnapshotSql } from "../src/catalog-sql"
import { normalizeCatalog } from "../src/normalize"
import catalog from "./fixtures/catalog.json"

const get = (path: string, options?: RequestInit) =>
  worker.fetch(new Request(`https://example.test${path}`, options), env)
const seed = async (id = "snapshot-1", time = Date.now()) => {
  await env.DB.exec(
    createSnapshotSql(normalizeCatalog(catalog), id, time, "USD"),
  )
}

describe("routes before catalog sync", () => {
  it("serves the compact TI home and category JSON", async () => {
    expect(await (await get("/")).text()).toContain("TI In-Stock Parts Engine")
    expect(
      ((await (await get("/categories/list.json")).json()) as any).categories
        .length,
    ).toBeGreaterThan(10)
    expect(await (await get("/health")).json()).toEqual({ ok: true })
  })
  it("returns a useful 503 instead of a misleading empty result", async () => {
    const response = await get("/api/search?q=TPS62160")
    expect(response.status).toBe(503)
    expect(response.headers.get("cache-control")).toBe("no-store")
    expect(await response.text()).toContain("not been synchronized")
  })
  it.each([
    "",
    "?q=%22%22",
    "?q=test&limit=NaN",
    "?q=test&offset=-1",
    "?q=test&limit=101",
    "?q=test&in_stock=maybe",
  ])("rejects invalid search %s before DB access", async (query) => {
    expect((await get(`/api/search${query}`)).status).toBe(400)
  })
  it("handles CORS, unsupported methods and unknown API routes", async () => {
    const preflight = await get("/api/search", { method: "OPTIONS" })
    expect(preflight.status).toBe(204)
    expect(preflight.headers.get("access-control-allow-origin")).toBe("*")
    expect((await get("/api/search", { method: "POST" })).status).toBe(405)
    const missing = await get("/api/missing")
    expect(missing.status).toBe(404)
    expect(missing.headers.get("content-type")).toContain("application/json")
  })
})

describe("search against real D1 migrations and FTS", () => {
  beforeEach(async () => {
    await seed()
  })
  it("finds keywords and ranks exact OPNs above stock", async () => {
    const body = (await (await get("/api/search?q=TPS62160DSGR")).json()) as any
    expect(body.components[0].ti_part_number).toBe("TPS62160DSGR")
    const prefix = (await (await get("/api/search?q=TPS62160")).json()) as any
    expect(prefix.total).toBe(2)
    expect(prefix.components[0].ti_part_number).toBe("TPS62160DSGT")
    expect(body.source).toBe("ti")
    expect(body.stale).toBe(false)
    expect(body.components[0].cad).toEqual({
      status: "not_provided_by_ti_api",
      source: "ti_api",
    })
  })
  it("paginates category filters and counts the complete matching set", async () => {
    const body = (await (
      await get(
        "/buck_converters/list.json?package=WSON&pin_count=8&limit=1&offset=1",
      )
    ).json()) as any
    expect(body.buck_converters).toHaveLength(1)
    expect(body.meta.total).toBe(2)
    expect(body.buck_converters[0].ti_part_number).toBe("TPS62160DSGR")
  })
  it("preserves exact /NOPB parts and treats FTS syntax as literal tokens", async () => {
    const body = (await (
      await get("/api/search?q=LP2982AIM5-3.3%2FNOPB")
    ).json()) as any
    expect(body.components[0].ti_part_number).toBe("LP2982AIM5-3.3/NOPB")
    expect((await get("/api/search?q=TPS62160%20OR%20%22")).status).toBe(200)
    expect((await get("/api/search?q=buck&package=%25")).status).toBe(200)
  })
  it("defaults to in-stock and supports opt-in out-of-stock discovery", async () => {
    const a = (await (await get("/adcs/list.json")).json()) as any
    const b = (await (
      await get("/adcs/list.json?in_stock=false")
    ).json()) as any
    expect(a.adcs).toHaveLength(0)
    expect(b.adcs[0].stock).toBe(0)
  })
  it("supports Accept and json=true, package index and readiness", async () => {
    expect(
      (
        (await (
          await get("/components/list?q=amplifier&json=true")
        ).json()) as any
      ).components,
    ).toHaveLength(1)
    expect(
      (
        await get("/components/list?q=buck", {
          headers: { accept: "application/json" },
        })
      ).headers.get("content-type"),
    ).toContain("application/json")
    expect(
      ((await (await get("/footprint_index/list.json")).json()) as any)
        .footprints,
    ).toHaveLength(3)
    expect(((await (await get("/api/status")).json()) as any).part_count).toBe(
      5,
    )
  })
  it("escapes search HTML and keeps query filters in pagination links", async () => {
    const html = await (
      await get("/buck_converters/list?package=WSON&limit=1")
    ).text()
    expect(html).toContain("package=WSON&amp;limit=1&amp;offset=1")
    expect(html).toContain("TSX conversion unavailable")
    const escaped = await (
      await get("/components/list?q=%3Cscript%3Ealert(1)%3C%2Fscript%3E")
    ).text()
    expect(escaped).not.toContain("<script>alert(1)</script>")
    expect(escaped).toContain("&lt;script&gt;")
  })
  it("marks old snapshots stale and refuses excessively old prices", async () => {
    await env.DB.prepare("UPDATE catalog_snapshots SET imported_at=?")
      .bind(Date.now() - 86400000)
      .run()
    const stale = await get("/api/search?q=buck")
    expect(stale.headers.get("x-cache")).toBe("STALE")
    await env.DB.prepare("UPDATE catalog_snapshots SET imported_at=?")
      .bind(0)
      .run()
    expect((await get("/api/search?q=buck")).status).toBe(503)
  })
  it("activates complete snapshots and removes vanished parts from results", async () => {
    const next = { catalog: [catalog.catalog[2]] }
    await env.DB.exec(
      createSnapshotSql(
        normalizeCatalog(next),
        "snapshot-2",
        Date.now(),
        "USD",
      ),
    )
    expect(
      ((await (await get("/api/search?q=TPS62160")).json()) as any).total,
    ).toBe(0)
  })
  it("leaves the old snapshot active when staging an incomplete replacement", async () => {
    await env.DB.prepare(
      "INSERT INTO catalog_snapshots VALUES ('incomplete',?,5,'USD')",
    )
      .bind(Date.now())
      .run()
    await env.DB.exec(
      "UPDATE catalog_state SET active_snapshot='incomplete' WHERE (SELECT COUNT(*) FROM parts WHERE snapshot_id='incomplete')=5;",
    )
    expect(
      ((await (await get("/api/search?q=buck")).json()) as any).total,
    ).toBe(2)
  })
  it("allows only one catalog attempt per four hours, across concurrent jobs", async () => {
    const now = Date.now()
    expect(
      (await env.DB.prepare(claimCatalogRequestSql(now)).all()).results,
    ).toHaveLength(1)
    expect(
      (await env.DB.prepare(claimCatalogRequestSql(now + 1)).all()).results,
    ).toHaveLength(0)
    expect(
      (await env.DB.prepare(claimCatalogRequestSql(now + 14400000)).all())
        .results,
    ).toHaveLength(1)
  })
})
