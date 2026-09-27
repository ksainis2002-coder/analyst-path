/* =========================================================================
   ui/pivot.js: the pivot table builder (ported from v1 buildPivot)
   -------------------------------------------------------------------------
   v1 had four dropdowns over 24 orders. v2 keeps that drag-free idea and adds
   what a hiring test asks for: date grouping (Quarter / Month / Year),
   Summarize Values By, a Filter, Show Values As (% of totals) and, above all,
   REFRESH. Like Excel, the pivot reads a snapshot (its cache) of the source
   data. If the data changes afterwards, the pivot keeps showing the old
   numbers until you press Refresh. (Google Sheets pivots update by
   themselves; the lessons say so.)

   PURE part (Node-testable):
     deriveRows(orderRows, dataset) → records with the export's fields plus the
         helper columns an analyst adds before pivoting:
           Product, Category              looked up from Products (J:N)
           Year, Quarter, Month           grouped from Date ("Qtr1", "Jan", as Excel labels them)
           Revenue = IFERROR(Quantity × ListPrice × (1 − Discount), 0)
           Margin  = IFERROR(Revenue − Quantity × UnitCost, 0)
     computePivot(records, config) → the table: row/column labels, cells, totals
     pivotState(config, result, { stale }) → what the grader's pivot-state check reads
     FIELDS, AGGS, SHOW_AS: the choices, with their Excel names

   config: { rows, columns ("" = none), value, agg: "sum"|"count"|"average"|"max"|"min",
             showAs: "none"|"pct-grand"|"pct-col"|"pct-row", filter: null | { field, values: [...] } }

   Excel behaviours kept on purpose:
     • Items group case-insensitively ("CRETE" joins "Crete"), but " attica "
       with spaces is its own item, and an empty cell is "(blank)".
     • Sum/Average/Max/Min use numbers only: a quantity stored as text adds 0.
       Count counts every non-empty value.
     • Row labels sort A→Z with (blank) last; quarters and months in calendar order.

   DOM part: createPivotBuilder(host, opts), further down.
   ========================================================================= */

export const FIELDS = Object.freeze([
  { id: "Region", kind: "text" }, { id: "Rep", kind: "text" }, { id: "Channel", kind: "text" },
  { id: "Category", kind: "text" }, { id: "Product", kind: "text" }, { id: "ProductID", kind: "text" },
  { id: "Quarter", kind: "date-group", label: "Date → Quarters" }, { id: "Month", kind: "date-group", label: "Date → Months" }, { id: "Year", kind: "date-group", label: "Date → Years" },
  { id: "OrderID", kind: "text" }, { id: "Quantity", kind: "number" }, { id: "Discount", kind: "number" },
  { id: "Revenue", kind: "number" }, { id: "Margin", kind: "number" },
]);
export const ROW_FIELDS = FIELDS.filter(f => f.kind !== "number").map(f => f.id).filter(id => id !== "OrderID");
export const VALUE_FIELDS = ["Revenue", "Margin", "Quantity", "Discount", "OrderID"];
export const AGGS = Object.freeze({ sum: "Sum", count: "Count", average: "Average", max: "Max", min: "Min" });
export const SHOW_AS = Object.freeze({ none: "No Calculation", "pct-grand": "% of Grand Total", "pct-col": "% of Column Total", "pct-row": "% of Row Total" });
export const DEFAULT_CONFIG = Object.freeze({ rows: "", columns: "", value: "", agg: "sum", showAs: "none", filter: null });

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const isBlank = v => v === undefined || v === null || v === "";
const asNumber = v => (typeof v === "number" ? v : typeof v === "string" && /^\s*[+-]?\d+(\.\d+)?\s*$/.test(v) ? Number(v) : NaN); // Excel's arithmetic coerces "14" to 14

/** The order export (rows of the A:H table) → records with helper columns. */
export function deriveRows(orderRows, dataset) {
  const products = dataset.refTables?.[0]?.rows || dataset.raw?.products || [];
  const byId = new Map(products.map(p => [String(p[0]).toLowerCase(), p])); // VLOOKUP exact match ignores case
  return orderRows.map(r => {
    const [OrderID, Date, ProductID, Region, Rep, Channel, Quantity, Discount] = r;
    const p = typeof ProductID === "string" ? byId.get(ProductID.toLowerCase()) : undefined;
    const q = asNumber(Quantity), d = isBlank(Discount) ? 0 : asNumber(Discount);
    const ok = p && Number.isFinite(q) && Number.isFinite(d);
    const Revenue = ok ? q * p[4] * (1 - d) : 0;
    const Margin = ok ? Revenue - q * p[3] : 0;
    let Year = null, Quarter = null, Month = null;
    if (typeof Date === "number") {
      const dt = new globalThis.Date(globalThis.Date.UTC(1899, 11, 30) + Math.round(Date) * 86400000);
      Year = dt.getUTCFullYear(); Month = MONTHS[dt.getUTCMonth()]; Quarter = `Qtr${Math.floor(dt.getUTCMonth() / 3) + 1}`;
    }
    return { OrderID, Date, ProductID, Region, Rep, Channel, Quantity, Discount, Product: p ? p[1] : null, Category: p ? p[2] : null, Year, Quarter, Month, Revenue, Margin, priceMissing: !p };
  });
}

const keyOf = v => (isBlank(v) ? "\u0000blank" : typeof v === "string" ? "s:" + v.toLowerCase() : "n:" + v);
export const labelOf = v => (isBlank(v) ? "(blank)" : String(v));
function sortKeys(field, keys) {
  const order = field === "Quarter" ? ["Qtr1", "Qtr2", "Qtr3", "Qtr4"] : field === "Month" ? MONTHS : null;
  return keys.sort((a, b) => {
    if (a.label === "(blank)" || b.label === "(blank)") return (a.label === "(blank)") - (b.label === "(blank)");
    if (order) return order.indexOf(a.label) - order.indexOf(b.label);
    if (typeof a.raw === "number" && typeof b.raw === "number") return a.raw - b.raw;
    return a.label.toLowerCase().localeCompare(b.label.toLowerCase());
  });
}

function aggregate(values, agg) {
  if (agg === "count") return values.filter(v => !isBlank(v)).length;
  const n = values.filter(v => typeof v === "number" && Number.isFinite(v));
  if (agg === "sum") return n.reduce((s, x) => s + x, 0);
  if (agg === "average") return n.length ? n.reduce((s, x) => s + x, 0) / n.length : "#DIV/0!";
  if (agg === "max") return n.length ? Math.max(...n) : 0;
  if (agg === "min") return n.length ? Math.min(...n) : 0;
  throw new Error(`Unknown aggregation "${agg}"`);
}
const ratio = (v, base) => (typeof v !== "number" || typeof base !== "number" ? v : base === 0 ? "#DIV/0!" : v / base);

/** Is the pivot complete enough to show numbers? (Rows and Values are required, as in Excel's field list.) */
export const pivotReady = c => !!(c && c.rows && c.value);

/**
 * @returns {{ ready, rowKeys: string[], colKeys: string[], cells: {[r]: {[c]: number|string}},
 *   rowTotals, colTotals, grand, percent: boolean, count: number, missingPrices: string[] }}
 */
export function computePivot(records, config) {
  const c = { ...DEFAULT_CONFIG, ...config };
  if (!pivotReady(c)) return { ready: false, rowKeys: [], colKeys: [], cells: {}, rowTotals: {}, colTotals: {}, grand: null, percent: false, count: 0, missingPrices: [] };
  let recs = records;
  if (c.filter?.field && Array.isArray(c.filter.values)) {
    const keep = new Set(c.filter.values.map(v => keyOf(v === "(blank)" ? null : v)));
    recs = recs.filter(r => keep.has(keyOf(r[c.filter.field])));
  }
  const rowMap = new Map(), colMap = new Map();
  const note = (map, v) => { const k = keyOf(v); if (!map.has(k)) map.set(k, { key: k, label: labelOf(v), raw: v }); return k; };
  const groups = new Map(), rowVals = new Map(), colVals = new Map(), all = [];
  for (const r of recs) {
    const rk = note(rowMap, r[c.rows]);
    const ck = c.columns ? note(colMap, r[c.columns]) : "";
    const v = r[c.value];
    const gk = rk + "\u0001" + ck;
    if (!groups.has(gk)) groups.set(gk, []);
    groups.get(gk).push(v);
    if (!rowVals.has(rk)) rowVals.set(rk, []); rowVals.get(rk).push(v);
    if (!colVals.has(ck)) colVals.set(ck, []); colVals.get(ck).push(v);
    all.push(v);
  }
  const rows = sortKeys(c.rows, [...rowMap.values()]), cols = c.columns ? sortKeys(c.columns, [...colMap.values()]) : [];
  const raw = { cells: {}, rowTotals: {}, colTotals: {}, grand: aggregate(all, c.agg) };
  for (const r of rows) {
    raw.rowTotals[r.label] = aggregate(rowVals.get(r.key), c.agg);
    raw.cells[r.label] = {};
    for (const col of cols) { const g = groups.get(r.key + "\u0001" + col.key); if (g) raw.cells[r.label][col.label] = aggregate(g, c.agg); }
  }
  for (const col of cols) raw.colTotals[col.label] = aggregate(colVals.get(col.key), c.agg);

  // Show Values As
  const out = { cells: {}, rowTotals: {}, colTotals: {}, grand: raw.grand };
  const pct = c.showAs && c.showAs !== "none";
  for (const r of rows) {
    out.cells[r.label] = {};
    for (const col of cols) {
      const v = raw.cells[r.label][col.label]; if (v === undefined) continue;
      out.cells[r.label][col.label] = c.showAs === "pct-grand" ? ratio(v, raw.grand) : c.showAs === "pct-col" ? ratio(v, raw.colTotals[col.label]) : c.showAs === "pct-row" ? ratio(v, raw.rowTotals[r.label]) : v;
    }
    const t = raw.rowTotals[r.label];
    out.rowTotals[r.label] = c.showAs === "pct-grand" || c.showAs === "pct-col" ? ratio(t, raw.grand) : c.showAs === "pct-row" ? ratio(t, t) : t;
  }
  for (const col of cols) {
    const t = raw.colTotals[col.label];
    out.colTotals[col.label] = c.showAs === "pct-grand" || c.showAs === "pct-row" ? ratio(t, raw.grand) : c.showAs === "pct-col" ? ratio(t, t) : t;
  }
  if (pct) out.grand = ratio(raw.grand, raw.grand);
  const missingPrices = [...new Set(recs.filter(r => r.priceMissing).map(r => String(r.ProductID ?? "(blank)")))];
  return { ready: true, rowKeys: rows.map(r => r.label), colKeys: cols.map(x => x.label), ...out, raw, percent: pct, count: recs.length, missingPrices };
}

/** The distinct items of a field (for the Filter checklist), in pivot order. */
export function fieldItems(records, field) {
  const m = new Map(); records.forEach(r => { const k = keyOf(r[field]); if (!m.has(k)) m.set(k, { key: k, label: labelOf(r[field]), raw: r[field] }); });
  return sortKeys(field, [...m.values()]).map(x => x.label);
}

/** The pivot as the grader sees it (spec §8: "compare the builder's config + resulting totals"). */
export function pivotState(config, result, { stale = false } = {}) {
  const c = { ...DEFAULT_CONFIG, ...config };
  const cells = {};
  for (const r of result.rowKeys) for (const col of result.colKeys) if (result.cells[r]?.[col] !== undefined) cells[`${r}|${col}`] = result.cells[r][col];
  return { rows: c.rows, columns: c.columns, value: c.value, agg: c.agg, showAs: c.showAs || "none", filter: c.filter || null,
    totals: { ...result.rowTotals, ...(result.ready ? { "Grand Total": result.grand } : {}) }, colTotals: { ...result.colTotals }, cells, stale: !!stale };
}

/** How a pivot value is shown: 12,345.68 or 42.87%. */
export function formatPivotValue(v, { percent = false } = {}) {
  if (v === undefined || v === null) return "";
  if (typeof v !== "number") return String(v);
  if (percent) return `${(v * 100).toFixed(2)}%`;
  return v.toLocaleString("en-US", { maximumFractionDigits: 2 });
}
/** Field name as Excel shows it in the Values area: "Sum of Revenue". */
export const valueCaption = c => (c.value ? `${AGGS[c.agg] || "Sum"} of ${c.value}` : "Values");
export const fieldLabel = id => FIELDS.find(f => f.id === id)?.label || id;

/* =========================================================================
   DOM: createPivotBuilder(host, opts)
   opts: {
     getRecords(): records     the source right now (deriveRows of the working data)
     sourceKey(): string       changes whenever the source data changes
     inserted = false          true: the pivot already exists (clean-data lessons)
     cache = null              { key, records } restored from a draft
     config                    starting layout
     locked                    read-only
     onChange(config, result, { stale, source })   source: "user" | "refresh" | "insert" | "api"
   }
   Like Excel, the pivot reads its CACHE (a snapshot taken on Insert and on
   Refresh), not the live data. Nothing on screen says it's out of date;
   finding that out is the lesson.
   ========================================================================= */
export const PIVOT_PATHS = Object.freeze([
  ["Insert a pivot", "Insert ▸ PivotTable ▸ OK", "Insert ▸ Pivot table"],
  ["Rows / Columns / Values", "Drag fields into the Rows, Columns and Values boxes of the PivotTable Fields pane", "Add fields under Rows, Columns and Values in the pivot table editor"],
  ["Group dates", "Right-click a date in the pivot ▸ Group ▸ Quarters (or Months, Years)", "Right-click a date ▸ Create pivot date group ▸ Quarter"],
  ["Summarize Values By", "Right-click a value ▸ Summarize Values By ▸ Sum / Count / Average", "Values ▸ Summarize by"],
  ["Show Values As", "Right-click a value ▸ Show Values As ▸ % of Grand Total", "Values ▸ Show as ▸ % of grand total"],
  ["Filter", "Drag a field into Filters (or Insert ▸ Slicer)", "Filters ▸ Add"],
  ["Refresh", "Right-click the pivot ▸ Refresh, or PivotTable Analyze ▸ Refresh (Alt+F5)", "Sheets pivots update on their own"],
]);
const escP = v => String(v ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
let pvUid = 0;

export function createPivotBuilder(host, opts = {}) {
  const { getRecords, sourceKey = () => "", locked = false, onChange } = opts;
  const id = `pv-${++pvUid}`;
  let config = { ...DEFAULT_CONFIG, ...(opts.config || {}) };
  let inserted = !!opts.inserted || !!opts.cache;
  let cache = opts.cache ? { ...opts.cache } : inserted ? { key: sourceKey(), records: getRecords() } : null;
  let result = null;

  const opt = (v, label, sel) => `<option value="${escP(v)}"${v === sel ? " selected" : ""}>${escP(label)}</option>`;
  host.innerHTML = `
  <div class="pivot" id="${id}">
    <div class="pivot__insert" data-insert-box ${inserted ? "hidden" : ""}>
      <p>No pivot yet. A pivot reads the data <strong>as it is when you insert it</strong>.</p>
      <button type="button" class="btn btn--primary" data-insert${locked ? " disabled" : ""}>Insert ▸ PivotTable</button>
      <p class="clean__path"><span class="clean__app">Excel</span> Insert ▸ PivotTable ▸ OK <br><span class="clean__app">Sheets</span> Insert ▸ Pivot table</p>
    </div>
    <div class="pivot__body" data-body ${inserted ? "" : "hidden"}>
      <div class="pivot__fields" role="group" aria-label="PivotTable fields">
        <label class="pv-field"><span>Rows</span><select data-k="rows">${opt("", "(none)")}${ROW_FIELDS.map(f => opt(f, fieldLabel(f))).join("")}</select></label>
        <label class="pv-field"><span>Columns</span><select data-k="columns">${opt("", "(none)")}${ROW_FIELDS.map(f => opt(f, fieldLabel(f))).join("")}</select></label>
        <label class="pv-field"><span>Values</span><select data-k="value">${opt("", "(none)")}${VALUE_FIELDS.map(f => opt(f, f)).join("")}</select></label>
        <label class="pv-field"><span>Summarize Values By</span><select data-k="agg">${Object.entries(AGGS).map(([k, v]) => opt(k, v)).join("")}</select></label>
        <label class="pv-field"><span>Show Values As</span><select data-k="showAs">${Object.entries(SHOW_AS).map(([k, v]) => opt(k, v)).join("")}</select></label>
        <label class="pv-field"><span>Filter</span><select data-k="filterField">${opt("", "(none)")}${ROW_FIELDS.map(f => opt(f, fieldLabel(f))).join("")}</select></label>
      </div>
      <fieldset class="pivot__items" data-items hidden><legend>Show items</legend><div data-items-list></div></fieldset>
      <div class="pivot__actions">
        <button type="button" class="btn btn--secondary" data-refresh${locked ? " disabled" : ""}>↻ Refresh</button>
        <span class="muted pivot__caption" data-caption></span>
      </div>
      <div class="pivot__out" data-out tabindex="0" role="region" aria-label="Pivot table"></div>
      <p class="pivot__note muted" data-note></p>
      <details class="pivot__paths"><summary>Where these are in Excel and Sheets</summary>
        <dl>${PIVOT_PATHS.map(([w, x, g]) => `<dt>${escP(w)}</dt><dd><span class="clean__app">Excel</span> ${escP(x)}<br><span class="clean__app">Sheets</span> ${escP(g)}</dd>`).join("")}</dl></details>
    </div>
  </div>`;
  const $ = s => host.querySelector(s);
  const stale = () => !!cache && cache.key !== sourceKey();

  function syncControls() {
    host.querySelectorAll("[data-k]").forEach(sel => {
      const k = sel.dataset.k;
      sel.value = k === "filterField" ? (config.filter?.field || "") : (config[k] ?? "");
      sel.disabled = locked;
    });
    const f = config.filter?.field;
    const box = $("[data-items]");
    box.hidden = !f;
    if (f && cache) {
      const items = fieldItems(cache.records, f), on = new Set((config.filter.values || []).map(v => String(v).toLowerCase()));
      $("[data-items-list]").innerHTML = items.map(it => `<label><input type="checkbox" value="${escP(it)}"${on.has(it.toLowerCase()) ? " checked" : ""}${locked ? " disabled" : ""}> ${escP(it)}</label>`).join("");
    }
  }

  function renderTable() {
    const out = $("[data-out]");
    if (!cache) { out.innerHTML = ""; return; }
    result = computePivot(cache.records, config);
    $("[data-caption]").textContent = pivotReady(config) ? valueCaption(config) + (config.showAs !== "none" ? ` (${SHOW_AS[config.showAs]})` : "") : "";
    if (!result.ready) {
      out.innerHTML = `<p class="pivot__empty">Choose a <strong>Rows</strong> field and a <strong>Values</strong> field to build the pivot.</p>`;
      $("[data-note]").textContent = ""; return;
    }
    const f = v => formatPivotValue(v, { percent: result.percent });
    const cols = result.colKeys;
    let html = `<table class="pivot__table"><caption class="visually-hidden">${escP(valueCaption(config))} by ${escP(fieldLabel(config.rows))}${config.columns ? ` and ${escP(fieldLabel(config.columns))}` : ""}</caption><thead><tr><th scope="col">${escP(config.rows)}</th>`;
    html += cols.length ? cols.map(c => `<th scope="col">${escP(c)}</th>`).join("") + `<th scope="col" class="is-total">Grand Total</th>` : `<th scope="col">${escP(valueCaption(config))}</th>`;
    html += `</tr></thead><tbody>`;
    for (const r of result.rowKeys) {
      html += `<tr><th scope="row">${escP(r)}</th>`;
      if (cols.length) html += cols.map(c => `<td>${escP(f(result.cells[r][c]))}</td>`).join("") + `<td class="is-total">${escP(f(result.rowTotals[r]))}</td>`;
      else html += `<td>${escP(f(result.rowTotals[r]))}</td>`;
      html += `</tr>`;
    }
    html += `<tr class="is-grand"><th scope="row">Grand Total</th>${cols.length ? cols.map(c => `<td>${escP(f(result.colTotals[c]))}</td>`).join("") : ""}<td class="is-total">${escP(f(result.grand))}</td></tr></tbody></table>`;
    out.innerHTML = html;
    const notes = [];
    if (config.filter?.field) notes.push(`Filtered: ${config.filter.field} = ${config.filter.values.join(", ") || "(nothing)"}.`);
    if (result.missingPrices.length && ["Revenue", "Margin"].includes(config.value)) notes.push(`${result.missingPrices.length === 1 ? "One product ID" : `${result.missingPrices.length} product IDs`} (${result.missingPrices.join(", ")}) ${result.missingPrices.length === 1 ? "isn't" : "aren't"} in the price list, so ${result.missingPrices.length === 1 ? "its" : "their"} ${config.value} counts as 0 (the helper column uses IFERROR).`);
    $("[data-note]").textContent = notes.join(" ");
  }

  function emit(source) { renderTable(); onChange?.(config, result, { stale: stale(), source }); }

  host.addEventListener("change", e => {
    if (locked) return;
    const k = e.target.dataset?.k;
    if (k === "filterField") {
      const field = e.target.value;
      config = { ...config, filter: field ? { field, values: fieldItems(cache.records, field) } : null };
      syncControls(); emit("user"); return;
    }
    if (k) {
      config = { ...config, [k]: e.target.value };
      // Excel's default: a text field dropped into Values is counted, not summed.
      if (k === "value" && ["OrderID"].includes(e.target.value) && config.agg === "sum") { config.agg = "count"; syncControls(); }
      emit("user"); return;
    }
    if (e.target.closest("[data-items]")) {
      const values = [...host.querySelectorAll("[data-items-list] input:checked")].map(x => x.value);
      config = { ...config, filter: { field: config.filter.field, values } };
      emit("user");
    }
  });
  host.addEventListener("click", e => {
    const b = e.target.closest("button"); if (!b || locked) return;
    if (b.hasAttribute("data-insert")) api.insert();
    if (b.hasAttribute("data-refresh")) api.refresh();
  });

  const api = {
    insert() { inserted = true; cache = { key: sourceKey(), records: getRecords() }; $("[data-insert-box]").hidden = true; $("[data-body]").hidden = false; syncControls(); emit("insert"); host.querySelector('[data-k="rows"]').focus(); },
    refresh() { if (!cache) return; cache = { key: sourceKey(), records: getRecords() }; syncControls(); emit("refresh"); },
    setConfig(c, { source = "api" } = {}) { config = { ...DEFAULT_CONFIG, ...c }; if (!inserted) api.insert(); syncControls(); emit(source); },
    /** The source data changed (a cleaning move). The pivot does NOT change: it's now stale. */
    sourceChanged() { if (cache) onChange?.(config, result, { stale: stale(), source: "source" }); },
    config: () => ({ ...config }),
    result: () => result,
    inserted: () => inserted,
    stale,
    state: () => (inserted && result ? pivotState(config, result, { stale: stale() }) : null),
    serialize: () => ({ config: { ...config }, inserted, cacheKey: cache?.key ?? null }),
    destroy() { host.innerHTML = ""; },
  };
  if (inserted) { syncControls(); renderTable(); }
  return api;
}
