import {
  CATEGORY_DEFINITIONS,
  COMMON_FILTERS,
  type CategoryDefinition,
} from "./categories"
import type { TiFilterOptions, NormalizedPart, SearchPayload } from "./types"

const escapeHtml = (value: unknown): string =>
  String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;")

const titleCase = (value: string): string =>
  value
    .split(/[_/]+/)
    .filter(Boolean)
    .map((segment) => segment.charAt(0).toUpperCase() + segment.slice(1))
    .join(" ")

const renderBreadcrumbs = (pathname: string): string =>
  pathname
    .split("/")
    .filter(Boolean)
    .map(
      (part, index, parts) =>
        `<span><span class="px-0.5 text-gray-500">/</span>${
          index === parts.length - 1
            ? `<a href="/${parts.slice(0, index + 1).join("/")}">${escapeHtml(part)}</a>`
            : `<span class="px-0.5 text-gray-500">${escapeHtml(part)}</span>`
        }</span>`,
    )
    .join("")

const jsonUrl = (requestUrl: string, pathname: string): string => {
  const url = new URL(requestUrl)
  if (!url.pathname.endsWith(".json")) url.pathname = `${pathname}.json`
  return url.pathname + url.search
}

const renderShell = (
  pathname: string,
  body: string,
  title = "TI Parts Search",
  requestUrl?: string,
): string => `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(title)}</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <style type="text/tailwindcss">
a { @apply underline text-blue-600 hover:text-blue-800 visited:text-purple-600 m-1 }
h2 { @apply text-xl font-bold my-2 }
input, select { @apply border border-gray-300 rounded p-1 ml-0.5 }
form { @apply inline-flex max-w-full flex-col gap-2 border border-gray-300 rounded p-2 m-2 text-xs }
button { @apply bg-blue-500 hover:bg-blue-700 text-white font-bold py-0.5 px-3 rounded }
.wrapper { @apply min-h-screen flex flex-col }
.content { @apply flex-grow min-w-0 }
.footer { @apply text-center py-2 text-xs text-gray-600 border-t border-gray-300 mt-4 }
    </style>
  </head>
  <body>
    <div class="wrapper">
      <div class="border-b border-gray-300 py-1 flex flex-wrap justify-between items-center gap-2">
        <div>
          <span class="px-1 pr-2">TI Parts Search (Unofficial)</span>
          <span><a href="/">home</a></span>
          ${renderBreadcrumbs(pathname)}
        </div>
        <div class="flex flex-row flex-wrap items-center gap-2">
          <form action="/components/list" method="GET" class="flex flex-row border-none py-0 my-0">
            <input type="text" name="search" placeholder="Search TI Part Number or Family" class="border m-0 mr-2" autocomplete="on" />
            <button type="submit" class="border px-3 py-1 m-0">Search</button>
          </form>
          <a href="https://github.com/tscircuit/tisearch.tscircuit.com">GitHub</a>
          ${requestUrl && pathname.includes("/list") ? `<a href="${escapeHtml(jsonUrl(requestUrl, pathname))}">json</a>` : ""}
          <a href="https://tscircuit.com">tscircuit</a>
        </div>
      </div>
      <main class="flex flex-col text-xs p-1 content">${body}</main>
      <footer class="footer">© ${new Date().getFullYear()} tscircuit. All rights reserved. By using this site, you agree to the<a href="https://tscircuit.com/legal/terms-of-service.html">terms of service</a>. This site is from tscircuit, not TI; we are customers helping other customers.</footer>
    </div>
  </body>
</html>`

export const renderHomePage = (parts: NormalizedPart[] = []): string => {
  const groups = [...new Set(CATEGORY_DEFINITIONS.map((c) => c.group))]
  const links = groups
    .map(
      (group) => `<section class="border border-gray-200 rounded p-3">
    <h2>${escapeHtml(group)}</h2><ul class="space-y-1">${CATEGORY_DEFINITIONS.filter(
      (c) => c.group === group,
    )
      .map(
        ({ path, label }) =>
          `<li><a href="${escapeHtml(path)}">${escapeHtml(label)}</a></li>`,
      )
      .join("")}</ul></section>`,
    )
    .join("")

  return renderShell(
    "/",
    `<div><p class="my-2"><a href="/categories/list">All categories</a> · <a href="/footprint_index/list">Package index</a></p><div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">${links}</div><h2>Recently retrieved parts</h2><p>Cached TI stock and pricing from the last 24 hours. Browse a category or search a part number to find more.</p>${parts.length ? renderPartsTable(parts) : "<p>No parts retrieved yet. Select a category above to load parts from TI.</p>"}</div>`,
  )
}

const renderStaticFilters = (
  category: CategoryDefinition | undefined,
  url: URL,
): string =>
  (category?.filters ?? COMMON_FILTERS)
    .map(
      (filter) => `<div>
        <label>${escapeHtml(filter.label)}:</label>
        <input name="${escapeHtml(filter.name)}" value="${escapeHtml(url.searchParams.get(filter.name) ?? "")}" placeholder="${escapeHtml(filter.placeholder ?? "")}" autocomplete="on" />
      </div>`,
    )
    .join("")

const renderManufacturerFilter = (
  options: TiFilterOptions,
  url: URL,
): string => {
  const manufacturers = (options.Manufacturers ?? []).slice(0, 100)
  if (manufacturers.length === 0) return ""
  const selected = url.searchParams.get("manufacturer") ?? ""
  return `<div><label>Manufacturer:</label><select name="manufacturer">
    <option value="">All</option>
    ${manufacturers
      .map(
        (manufacturer) =>
          `<option value="${escapeHtml(manufacturer.Id)}"${String(manufacturer.Id) === selected ? " selected" : ""}>${escapeHtml(manufacturer.Value ?? manufacturer.Id)} (${Number(manufacturer.ProductCount ?? 0).toLocaleString("en-US")})</option>`,
      )
      .join("")}
  </select></div>`
}

const renderParametricFilters = (options: TiFilterOptions, url: URL): string =>
  (options.ParametricFilters ?? [])
    .filter(
      (filter) =>
        filter.Category?.Id &&
        filter.ParameterId &&
        filter.ParameterName &&
        (filter.FilterValues?.length ?? 0) > 0,
    )
    .slice(0, 12)
    .map((filter) => {
      const name = `param_${filter.Category?.Id}_${filter.ParameterId}`
      const selected = url.searchParams.get(name) ?? ""
      return `<div><label>${escapeHtml(filter.ParameterName)}:</label><select name="${escapeHtml(name)}">
        <option value="">All</option>
        ${(filter.FilterValues ?? [])
          .slice(0, 100)
          .map(
            (value) =>
              `<option value="${escapeHtml(value.ValueId)}"${value.ValueId === selected ? " selected" : ""}>${escapeHtml(value.ValueName)} (${Number(value.ProductCount ?? 0).toLocaleString("en-US")})</option>`,
          )
          .join("")}
      </select></div>`
    })
    .join("")

const renderFilters = (
  category: CategoryDefinition | undefined,
  payload: SearchPayload,
  url: URL,
): string => {
  const queryField = `<div><label>${category ? "Family prefix" : "Search"}:</label><input name="q" value="${escapeHtml(payload.query)}" /></div>
    <div><label>Search by:</label><select name="mode"><option value="">Auto</option><option value="part"${url.searchParams.get("mode") === "part" ? " selected" : ""}>Part number</option><option value="family"${url.searchParams.get("mode") === "family" || (category && !url.searchParams.get("mode")) ? " selected" : ""}>Family prefix</option></select></div>
    <div><label>Inventory:</label><select name="in_stock"><option value="true">In stock</option><option value="false"${url.searchParams.get("in_stock") !== "true" ? " selected" : ""}>All store listings</option></select></div><input type="hidden" name="limit" value="${payload.limit}">`
  const filters = [
    queryField,
    renderStaticFilters(category, url),
    renderManufacturerFilter(payload.filter_options, url),
    renderParametricFilters(payload.filter_options, url),
  ].join("")

  return `<form method="GET" class="flex flex-row flex-wrap gap-4">${filters}<button type="submit">Filter</button></form>`
}

const formatPrice = (part: NormalizedPart): string =>
  part.price === null
    ? "—"
    : `${part.currency} ${part.price.toLocaleString("en-US", { maximumFractionDigits: 6 })} @ ${part.price_quantity}`

const renderParameters = (parameters: Record<string, string>): string => {
  const entries = Object.entries(parameters)
  if (entries.length === 0) return ""
  return `<details><summary>${entries.length} params</summary><dl class="mt-1">${entries
    .map(
      ([name, value]) =>
        `<div><dt class="font-semibold inline">${escapeHtml(name)}:</dt> <dd class="inline">${escapeHtml(value)}</dd></div>`,
    )
    .join("")}</dl></details>`
}

const renderPartsTable = (parts: NormalizedPart[]): string => {
  if (parts.length === 0)
    return "<p>No matching products on this page. Try the next page or adjust the inventory filter.</p>"
  const rows = parts
    .map(
      (part) => `<tr>
        <td class="border border-gray-300 p-1"><a href="${escapeHtml(part.product_url)}">${escapeHtml(part.ti_product_number)}</a></td>
        <td class="border border-gray-300 p-1">${escapeHtml(part.mfr)}</td>
        <td class="border border-gray-300 p-1">${escapeHtml(part.manufacturer)}</td>
        <td class="border border-gray-300 p-1">${escapeHtml(part.package)}</td>
        <td class="border border-gray-300 p-1">${escapeHtml(part.description)}${part.datasheet_url ? ` <a href="${escapeHtml(part.datasheet_url)}">datasheet</a>` : ""}</td>
        <td class="border border-gray-300 p-1 text-right">${part.stock.toLocaleString("en-US")}</td>
        <td class="border border-gray-300 p-1 text-right">${escapeHtml(formatPrice(part))}</td>
        <td class="border border-gray-300 p-1">${renderParameters(part.parameters)}</td>
      </tr>`,
    )
    .join("")

  return `<table class="border border-gray-300 text-xs border-collapse p-1">
    <thead><tr>
      ${[
        "TI PN",
        "MFR",
        "Manufacturer",
        "Package",
        "Description",
        "Stock",
        "Unit Price @ Qty",
        "Parameters",
      ]
        .map(
          (column) => `<th class="p-1 border border-gray-300">${column}</th>`,
        )
        .join("")}
    </tr></thead>
    <tbody>${rows}</tbody>
  </table>`
}

export const renderSearchPage = (
  pathname: string,
  label: string,
  category: CategoryDefinition | undefined,
  payload: SearchPayload,
  requestUrl: string,
): string => {
  const url = new URL(requestUrl)
  const freshness = payload.stale
    ? `<span class="text-amber-700">Serving stale cache while TI refreshes.</span>`
    : payload.cached
      ? `<span class="text-gray-600">Cached until ${escapeHtml(payload.cache_expires_at)}.</span>`
      : `<span class="text-gray-600">Fresh from TI; cached until ${escapeHtml(payload.cache_expires_at)}.</span>`

  const pageLink = (offset: number, label: string) => {
    const next = new URL(url)
    next.searchParams.set("offset", String(offset))
    next.searchParams.set("limit", String(payload.limit))
    return `<a href="${escapeHtml(next.pathname + next.search)}">${label}</a>`
  }
  const paging = `<div class="my-2">${payload.offset > 0 ? pageLink(Math.max(0, payload.offset - payload.limit), "Previous") : ""}${payload.next_offset !== null ? pageLink(payload.next_offset, "Next") : ""}</div>`
  return renderShell(
    pathname,
    `<div><h2>${escapeHtml(label)}</h2>${category ? `<p class="my-1">TI family: ${escapeHtml(category.query)}. This page covers that API family; some related devices have separate categories.</p>` : ""}${renderFilters(category, payload, url)}<div class="my-1">${freshness} ${payload.total.toLocaleString("en-US")} matching products on this page.</div><p class="text-gray-600 my-1">Search by exact or base part number, or the beginning of a TI product family name. Stock and filters apply to each page.</p><div class="overflow-x-auto">${renderPartsTable(payload.components)}</div>${paging}</div>`,
    `${label} - TI Parts Search`,
    requestUrl,
  )
}

export const renderSimpleTablePage = (
  pathname: string,
  label: string,
  rows: Array<Record<string, unknown>>,
  requestUrl: string,
): string => {
  const columns = Object.keys(rows[0] ?? {})
  const table =
    rows.length === 0
      ? "<p>The on-demand index is empty. Search for parts to populate it.</p>"
      : `<table class="border border-gray-300 text-xs border-collapse p-1"><thead><tr>${columns.map((column) => `<th class="p-1 border border-gray-300">${escapeHtml(titleCase(column))}</th>`).join("")}</tr></thead><tbody>${rows.map((row) => `<tr>${columns.map((column) => `<td class="border border-gray-300 p-1">${escapeHtml(row[column])}</td>`).join("")}</tr>`).join("")}</tbody></table>`
  return renderShell(
    pathname,
    `<div><h2>${escapeHtml(label)}</h2>${table}</div>`,
    `${label} - TI Parts Search`,
    requestUrl,
  )
}

export const renderErrorPage = (
  pathname: string,
  status: number,
  message: string,
): string =>
  renderShell(
    pathname,
    `<div><h2>${status}</h2><p>${escapeHtml(message)}</p></div>`,
    `${status} - TI Parts Search`,
  )
