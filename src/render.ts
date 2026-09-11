import { CATEGORY_DEFINITIONS } from "./categories"
import type { NormalizedPart, SearchPayload } from "./types"

export const escapeHtml = (value: unknown): string =>
  String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;")

// Relative links avoid reflecting an untrusted Host header into the page.
const jsonUrl = (url: URL): string =>
  `${url.pathname.replace(/\.json$/, "")}.json${url.search}`
const shell = (
  title: string,
  body: string,
  url?: URL,
): string => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)} - TI Parts Search</title>
<meta name="description" content="Search Texas Instruments parts, packages, inventory, and prices with tscircuit.">
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='5' fill='%231d4ed8'/%3E%3Cpath d='M7 9h12v4h-4v11h-4V13H7zm15 0h4v15h-4z' fill='white'/%3E%3C/svg%3E">
<style>
*{box-sizing:border-box}body{margin:0;font:13px Arial,sans-serif;color:#171717}a{color:#1d4ed8;text-decoration:underline}a:visited{color:#6b21a8}header{border-bottom:1px solid #d1d5db;padding:8px;display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap}header nav{display:flex;gap:10px;align-items:center;flex-wrap:wrap}h1{font-size:20px;margin:12px 0}h2{font-size:18px}main{padding:8px;min-height:85vh}input,select{font:inherit;border:1px solid #9ca3af;border-radius:3px;padding:5px;max-width:100%}button{font:inherit;background:#2563eb;color:white;border:0;border-radius:3px;padding:6px 12px;cursor:pointer}.search{display:flex;gap:5px}.search input{width:260px}.categories{display:flex;flex-wrap:wrap;gap:16px;margin:8px 0}.categories a{border:1px solid #d1d5db;border-radius:4px;padding:12px;width:150px;text-align:center}.filters{display:flex;flex-wrap:wrap;align-items:end;gap:12px;border:1px solid #d1d5db;border-radius:4px;padding:10px;margin:8px 0}.filters label{display:flex;flex-direction:column;gap:4px}.filters input{width:140px}.table-wrap{overflow:auto}table{border-collapse:collapse;font-size:12px}th,td{border:1px solid #d1d5db;padding:5px;text-align:left}th{background:#f9fafb}td.number{text-align:right;white-space:nowrap}td.part{white-space:nowrap}.muted{color:#525252}.stale{color:#92400e}.paging{display:flex;gap:16px;margin:14px 0}footer{text-align:center;border-top:1px solid #d1d5db;padding:12px;color:#525252;font-size:12px}code{font-size:12px}summary{cursor:pointer}@media(max-width:600px){header nav{width:100%}.search{flex:1}.search input{width:100%}.filters label{flex:1}.categories a{width:calc(50% - 8px)}}
</style></head><body><header><div>TI In-Stock Parts Engine (Unofficial) <a href="/">home</a></div><nav>
<form action="/components/list" method="GET" class="search"><input aria-label="Search TI parts" name="search" placeholder="Search Description or TI Part Number"><button>Search</button></form>
<a href="https://github.com/tscircuit/tisearch.tscircuit.com">GitHub</a>${url ? `<a href="${escapeHtml(jsonUrl(url))}">json</a>` : ""}<a href="https://tscircuit.com">tscircuit</a></nav></header>
<main>${body}</main><footer>© ${new Date().getFullYear()} tscircuit. An independent tscircuit service. Texas Instruments product data and links belong to TI. <a href="https://tscircuit.com/legal/terms-of-service.html">Terms of service</a></footer></body></html>`

export const renderHomePage = (): string =>
  shell(
    "TI",
    `<div class="categories">${[{ path: "/categories/list", label: "Categories" }, { path: "/footprint_index/list", label: "Package Index" }, ...CATEGORY_DEFINITIONS].map((c) => `<a href="${c.path}">${escapeHtml(c.label)}</a>`).join("")}</div><p class="muted">Search TI orderable part numbers and descriptions. Inventory and prices reflect the latest catalog refresh; confirm availability on TI.com.</p>`,
  )

const renderPart = (part: NormalizedPart): string => `<tr>
<td class="part"><a href="${escapeHtml(part.product_url)}">${escapeHtml(part.ti_part_number)}</a></td>
<td>${escapeHtml(part.generic_part_number)}</td><td>${escapeHtml(part.package)}</td><td class="number">${part.pin_count ?? ""}</td>
<td>${escapeHtml(part.description)}${part.datasheet_url ? ` <a href="${escapeHtml(part.datasheet_url)}">datasheet</a>` : ""}</td>
<td class="number">${part.stock.toLocaleString("en-US")}</td><td class="number">${part.price === null ? "—" : `${escapeHtml(part.currency)} ${part.price.toLocaleString("en-US", { maximumFractionDigits: 6 })} @ ${part.price_quantity}`}<details><summary>Breaks</summary>${part.price_breaks.map((b) => `${b.quantity}: ${escapeHtml(part.currency)} ${b.price}`).join("<br>")}</details></td>
<td>${escapeHtml(part.lifecycle)}</td><td><span class="muted">Not supplied by TI API</span><br>TSX conversion unavailable</td></tr>`

export const renderSearchPage = (
  pathname: string,
  title: string,
  payload: SearchPayload,
  url: URL,
  category: boolean,
): string => {
  const value = (key: string) => escapeHtml(url.searchParams.get(key) ?? "")
  const pageLink = (offset: number, text: string) => {
    const next = new URL(url)
    next.searchParams.set("offset", String(offset))
    return `<a href="${escapeHtml(next.pathname + next.search)}">${text}</a>`
  }
  return shell(
    title,
    `<h1>${escapeHtml(title)}</h1>${category ? '<p class="muted">Grouped by product description. Check the datasheet for electrical specifications.</p>' : ""}
<form class="filters" action="${pathname}" method="GET">
<label>Search<input name="q" value="${escapeHtml(payload.query)}"></label><label>Package<input name="package" value="${value("package")}" placeholder="WSON"></label>
<label>Pins<input type="number" min="1" max="10000" name="pin_count" value="${escapeHtml(url.searchParams.get("pin_count") ?? url.searchParams.get("num_pins") ?? "")}"></label>
<label>Lifecycle<input name="lifecycle" value="${value("lifecycle")}" placeholder="ACTIVE"></label><label>Base part<input name="gpn" value="${value("gpn")}"></label>
<label>Inventory<select name="in_stock"><option value="true">In stock</option><option value="false"${url.searchParams.get("in_stock") === "false" ? " selected" : ""}>All parts</option></select></label><input type="hidden" name="limit" value="${payload.limit}"><button>Filter</button></form>
<p class="${payload.stale ? "stale" : "muted"}">${payload.stale ? "Catalog refresh overdue. " : ""}Catalog updated ${escapeHtml(payload.catalog_updated_at)}. ${payload.total.toLocaleString("en-US")} matching parts.</p>
${payload.components.length ? `<div class="table-wrap"><table><thead><tr>${["TI PN", "Base Part", "Package", "Pins", "Description", "Stock", "Unit Price @ Qty", "Lifecycle", "CAD / TSX"].map((c) => `<th>${c}</th>`).join("")}</tr></thead><tbody>${payload.components.map(renderPart).join("")}</tbody></table></div>` : "<p>No matching parts found. Try a base part number or fewer filters.</p>"}
<div class="paging">${payload.offset > 0 ? pageLink(Math.max(0, payload.offset - payload.limit), "Previous") : ""}${payload.offset + payload.limit < payload.total ? pageLink(payload.offset + payload.limit, "Next") : ""}</div>`,
    url,
  )
}

export const renderSimpleTablePage = (
  _path: string,
  title: string,
  rows: Record<string, unknown>[],
  url: URL,
): string => {
  const columns = Object.keys(rows[0] ?? {})
  return shell(
    title,
    `<h1>${escapeHtml(title)}</h1>${rows.length ? `<div class="table-wrap"><table><thead><tr>${columns.map((c) => `<th>${escapeHtml(c)}</th>`).join("")}</tr></thead><tbody>${rows.map((row) => `<tr>${columns.map((c) => `<td>${c === "path" ? `<a href="${escapeHtml(row[c])}">${escapeHtml(row[c])}</a>` : escapeHtml(row[c])}</td>`).join("")}</tr>`).join("")}</tbody></table></div>` : "<p>No packages with stock in the current catalog.</p>"}`,
    url,
  )
}
export const renderErrorPage = (status: number, message: string): string =>
  shell(`${status}`, `<h1>${status}</h1><p>${escapeHtml(message)}</p>`)
