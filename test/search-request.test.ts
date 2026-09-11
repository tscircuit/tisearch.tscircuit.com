import { describe, expect, it } from "vitest"
import { CATEGORY_BY_PATH } from "../src/categories"
import { createSearchRequest, getSearchCacheKey } from "../src/search-request"
const parse = (q: string) =>
  createSearchRequest(new URL(`https://test/api/search?${q}`))
describe("TI search request", () => {
  it("selects exact/base part queries or family prefixes", () => {
    expect(parse("q=TPS62160").mode).toBe("part")
    expect(parse("q=Buck").mode).toBe("family")
    expect(parse("q=RF123&mode=family").mode).toBe("family")
    expect(
      createSearchRequest(
        new URL("https://test/buck_converters/list"),
        CATEGORY_BY_PATH.get("/buck_converters/list"),
      ),
    ).toMatchObject({
      query: "Buck converters",
      responseKey: "buck_converters",
      mode: "family",
    })
  })
  it.each([
    "",
    "q=x&limit=NaN",
    "q=x&limit=21",
    "q=x&limit=2&offset=1",
    "q=x&mode=keyword",
    "q=x&num_pins=-1",
    "q=x&in_stock=yes",
    "q=..%2Fcatalog&mode=part",
  ])("rejects invalid query %s", (q) => expect(() => parse(q)).toThrow())
  it("canonicalizes cache keys and separates mode, pagination and currency", async () => {
    const a = parse("q=TPS62160&limit=1&package=WSON&num_pins=8")
    const b = parse("q=tps62160&num_pins=8&package=WSON&limit=1")
    expect(await getSearchCacheKey(a)).toBe(await getSearchCacheKey(b))
    expect(await getSearchCacheKey(a, "EUR")).not.toBe(
      await getSearchCacheKey(a),
    )
    expect(await getSearchCacheKey({ ...a, offset: 1 })).not.toBe(
      await getSearchCacheKey(a),
    )
    expect(await getSearchCacheKey({ ...a, mode: "family" })).not.toBe(
      await getSearchCacheKey(a),
    )
  })
})
