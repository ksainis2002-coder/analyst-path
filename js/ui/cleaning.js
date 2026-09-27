/* =========================================================================
   ui/cleaning.js: the cleaning simulator (ported from v1 buildCleaning)
   -------------------------------------------------------------------------
   v1 was a click-to-fix queue: pressing "Fix" marked an issue done. That
   breaks the honesty rule (spec §3: progress is earned by doing), so v2 is a
   small working copy of Excel instead. You fix the export with the real
   moves, each shown with its Excel and Google Sheets menu path:

     Remove Duplicates · Go To Special ▸ Blanks · formula fill (helper column →
     paste as values) · Convert to Number · Find & Replace · Sort · edit a cell

   and the app works out what is fixed by looking at the DATA, never at which
   buttons were pressed. A move that breaks good data (Remove Duplicates keyed
   on the wrong column, a Find & Replace that hits every OrderID) is reported
   as damage, with Undo to recover.

   PURE part (Node-testable, used by the grader tests):
     initialState(dataset) → { header, rows }            the export as a table
     applyOp(state, op, ctx) → { state, message }        one move; throws CleaningError
     replay(dataset, ops) → state                        rebuild from a list of moves
     cellsOf(state, dataset) → cell map for the engine   (export in A:H + reference tables)
     audit(state, dataset, cleanRows) → { fixed, wrong, open, damage, statuses }
     shiftFormula(formula, rows)                         "=TRIM(D2)" → "=TRIM(D5)" (respects $)

   An op is plain data, so a sequence of moves can be saved as a draft,
   replayed, and shipped in an answer key:
     { op: "dedupe",  columns: ["A",…] }                       Data ▸ Remove Duplicates
     { op: "fill",    formula: "=…", column: "D", scope: "all"|"blanks" }
                                                               written for row 2, filled down, pasted as values
     { op: "convert", column: "G" }                            ⚠ ▸ Convert to Number
     { op: "replace", find, replace, column: "all"|"C", entire?: bool, matchCase?: bool }
     { op: "set",     row: 59 | orderId: "O1057", column: "D", value: "typed text" }
     { op: "sort",    column: "B", dir: "asc"|"desc" }

   DOM part: createCleaningLab(host, opts), further down.
   ========================================================================= */

import { evaluate, textToNumber } from "../engine.js";
import { toCells, indexToCol, colToIndex, formatAs } from "../data.js";
import { createSheet } from "./sheet.js";

export class CleaningError extends Error {
  constructor(message, detail = {}) { super(message); this.detail = detail; }
}

const isBlank = v => v === undefined || v === null || v === "";
const LETTERS = n => Array.from({ length: n }, (_, i) => indexToCol(i + 1));

/** The export (A:H) as an editable table. */
export function initialState(dataset) {
  const o = dataset.orders;
  if (!o) throw new Error(`dataset "${dataset.id}" has no orders table to clean`);
  return { header: [...o.header], rows: o.rows.map(r => [...r]) };
}

/** Cell map for the engine: the working export in A:H plus the dataset's reference tables. */
export function cellsOf(state, dataset) {
  return toCells([{ origin: "A1", header: state.header, rows: state.rows }, ...(dataset.refTables || [])]);
}

/* ---------- formulas filled down a column ---------- */
/**
 * Move every relative row reference by `rows`, as Excel does when a formula is
 * copied down: D2 → D5, $P$2:$R$8 stays, P2:R8 → P5:R11 (it drifts!).
 * Whole-column references (A:A) and text in "quotes" are never changed.
 */
export function shiftFormula(formula, rows) {
  const f = String(formula);
  let out = "", i = 0;
  const re = /(\$?)([A-Z]{1,3})(\$?)(\d+)/gy;
  while (i < f.length) {
    if (f[i] === '"') { const j = f.indexOf('"', i + 1); const end = j < 0 ? f.length : j + 1; out += f.slice(i, end); i = end; continue; }
    re.lastIndex = i;
    const m = re.exec(f);
    const prev = i > 0 ? f[i - 1] : "";
    if (m && !/[A-Za-z0-9_$.]/.test(prev) && !/[A-Za-z0-9_(]/.test(f[re.lastIndex] || "")) {
      const [, d1, col, d2, row] = m;
      const r = d2 ? Number(row) : Number(row) + rows;
      if (r < 1) throw new CleaningError(`Copying this formula down would point above row 1 (${col}${row} → row ${r}).`, { code: "#REF!" });
      out += `${d1}${col}${d2}${r}`; i = re.lastIndex; continue;
    }
    out += f[i]; i++;
  }
  return out;
}

/** What a typed entry becomes, the way Excel reads a cell you type into. */
export function parseTyped(text, format) {
  const s = String(text ?? "");
  if (s.trim() === "") return null;
  if (format === "percent" && /%\s*$/.test(s)) { const n = textToNumber(s.trim()); if (n !== null) return n; }
  const n = textToNumber(s.trim());
  // Only plain numbers and ISO dates turn into numbers; "O1001" or " attica " stay text, exactly as typed.
  if (n !== null && /^[\s+\-\d.,%eE]+$|^\s*\d{4}-\d{1,2}-\d{1,2}\s*$/.test(s)) return n;
  return s;
}

/** How a cell looks in Find & Replace: dates as YYYY-MM-DD, everything else as its value. */
function asText(v, format) { if (v === null || v === undefined) return ""; if (format === "date" && typeof v === "number") return formatAs(v, "date"); return String(v); }
const escRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/* Excel's sort order: numbers, then text (A→Z, case-insensitive), then TRUE/FALSE; blanks always last. */
function rank(v) { return isBlank(v) ? 3 : typeof v === "number" ? 0 : typeof v === "string" ? 1 : 2; }
function cmp(a, b) {
  const ra = rank(a), rb = rank(b); if (ra !== rb) return ra - rb;
  if (ra === 1) return a.toLowerCase().localeCompare(b.toLowerCase());
  if (ra === 3) return 0;
  return a === b ? 0 : a < b ? -1 : 1;
}
// Remove Duplicates compares values the way Excel does: text case-insensitively.
const dupKey = v => (isBlank(v) ? "∅" : typeof v === "string" ? "s:" + v.toLowerCase() : typeof v + ":" + v);

/**
 * Apply one move. Returns { state, message, changed }. Never mutates `state`.
 * ctx: { dataset } (needed for formulas and number formats).
 */
export function applyOp(state, op, ctx = {}) {
  const dataset = ctx.dataset || {};
  const formats = dataset.formats || {};
  const cols = LETTERS(state.header.length);
  const colIdx = c => { const i = cols.indexOf(String(c || "").toUpperCase()); if (i < 0) throw new CleaningError(`Pick a column from ${cols[0]} to ${cols.at(-1)}.`); return i; };
  const rows = state.rows.map(r => [...r]);
  const next = { header: state.header, rows };
  const plural = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;

  switch (op?.op) {
    case "dedupe": {
      const use = (op.columns?.length ? op.columns : cols).map(colIdx);
      const seen = new Set(), kept = [];
      for (const r of rows) { const k = use.map(i => dupKey(r[i])).join("|"); if (!seen.has(k)) { seen.add(k); kept.push(r); } }
      const removed = rows.length - kept.length;
      return { state: { header: state.header, rows: kept }, changed: removed,
        message: removed ? `${plural(removed, "duplicate row")} removed; ${kept.length} unique rows remain.` : "No duplicate rows found with those columns. Nothing removed." };
    }
    case "fill": {
      const ci = colIdx(op.column);
      const f = String(op.formula || "").trim();
      if (!f) throw new CleaningError("Type the formula for row 2 first.");
      const scopeBlanks = op.scope === "blanks";
      const cells = cellsOf(state, dataset);
      const out = [];
      for (let i = 0; i < rows.length; i++) {
        if (scopeBlanks && !isBlank(rows[i][ci])) continue;
        const r = i + 2, shifted = shiftFormula(f, r - 2);
        const res = evaluate(shifted, cells);
        if (!res.ok) throw new CleaningError(`Row ${r} gives ${res.error.code || "an error"} (${shifted.replace(/^=?/, "=")}), so nothing was filled.`, { row: r, code: res.error.code, formula: shifted, message: res.error.message });
        out.push([i, res.value]);
      }
      if (!out.length) return { state, changed: 0, message: scopeBlanks ? `Column ${cols[ci]} has no blank cells. Nothing filled.` : "Nothing to fill." };
      for (const [i, v] of out) rows[i][ci] = v;
      return { state: next, changed: out.length, message: `Filled ${plural(out.length, scopeBlanks ? "blank cell" : "cell")} in column ${cols[ci]} (pasted as values).` };
    }
    case "convert": {
      const ci = colIdx(op.column);
      let n = 0;
      rows.forEach(r => {
        const v = r[ci];
        // Only "numbers stored as text" (the green-triangle cells) convert; words and date-text stay as they are.
        if (typeof v === "string" && /^\s*[+-]?[\d.,]+%?\s*$/.test(v)) { const x = textToNumber(v); if (x !== null) { r[ci] = x; n++; } }
      });
      return { state: n ? next : state, changed: n, message: n ? `Converted ${plural(n, "cell")} in column ${cols[ci]} to numbers.` : `Column ${cols[ci]} has no numbers stored as text. Nothing changed.` };
    }
    case "replace": {
      const find = String(op.find ?? "");
      if (!find) throw new CleaningError("Type what to find.");
      const repl = String(op.replace ?? "");
      const scope = !op.column || op.column === "all" ? cols.map((_, i) => i) : [colIdx(op.column)];
      const flags = op.matchCase ? "g" : "gi";
      let n = 0;
      rows.forEach(r => scope.forEach(ci => {
        const v = r[ci]; if (isBlank(v)) return;
        const fmt = formats[cols[ci]], text = asText(v, fmt);
        let nt, hits = 0;
        if (op.entire) { if (op.matchCase ? text === find : text.toLowerCase() === find.toLowerCase()) { nt = repl; hits = 1; } }
        else { nt = text.replace(new RegExp(escRe(find), flags), () => { hits++; return repl; }); }
        if (!hits) return;
        n += hits;
        // Excel re-enters the cell after a replace: a result that looks like a number or a date becomes one.
        r[ci] = parseTyped(nt, fmt);
      }));
      return { state: n ? next : state, changed: n, message: n ? `Made ${plural(n, "replacement")}${scope.length === 1 ? ` in column ${cols[scope[0]]}` : " across all columns"}.` : `Couldn't find "${find}". Nothing replaced.` };
    }
    case "set": {
      const ci = colIdx(op.column);
      let i = op.orderId !== undefined ? rows.findIndex(r => r[0] === op.orderId) : Number(op.row) - 2;
      if (!(i >= 0 && i < rows.length)) throw new CleaningError(op.orderId ? `There's no row for ${op.orderId}.` : `Row ${op.row} isn't part of the export (rows 2–${rows.length + 1}).`);
      const raw = String(op.value ?? "");
      let v;
      if (/^\s*=/.test(raw)) {
        const res = evaluate(raw, cellsOf(state, dataset));
        if (!res.ok) throw new CleaningError(`That formula gives ${res.error.code || "an error"}. Nothing was changed.`, { code: res.error.code });
        v = res.value;
      } else v = parseTyped(raw, formats[cols[ci]]);
      rows[i][ci] = v;
      const shown = v === null ? "empty" : typeof v === "number" ? (formatAs(v, formats[cols[ci]]) ?? String(v)) : `"${v}"`;
      return { state: next, changed: 1, message: `${cols[ci]}${i + 2} is now ${shown}.` };
    }
    case "sort": {
      const ci = colIdx(op.column), dir = op.dir === "desc" ? -1 : 1;
      const sorted = rows.map((r, i) => [r, i]).sort((a, b) => {
        const x = a[0][ci], y = b[0][ci];
        if (isBlank(x) !== isBlank(y)) return isBlank(x) ? 1 : -1; // blanks last either way, as in Excel
        return dir * cmp(x, y) || a[1] - b[1];
      }).map(p => p[0]);
      return { state: { header: state.header, rows: sorted }, changed: rows.length, message: `Sorted by ${state.header[ci]} (${dir === 1 ? "smallest to largest / A→Z" : "largest to smallest / Z→A"}).` };
    }
    default: throw new CleaningError(`Unknown cleaning move "${op?.op}".`);
  }
}

/** Rebuild the working copy from the original export and a list of moves. */
export function replay(dataset, ops = []) {
  let s = initialState(dataset);
  for (const op of ops) s = applyOp(s, op, { dataset }).state;
  return s;
}

/* ---------- audit: what's fixed, judged from the data ---------- */
const same = (a, b) => (typeof a === "number" && typeof b === "number" ? Math.abs(a - b) < 1e-9 : a === b || (isBlank(a) && isBlank(b)));
function show(v, format) { if (isBlank(v)) return "empty"; if (typeof v === "number") return format ? (formatAs(v, format) ?? String(v)) : String(v); return `"${v}"`; }

/**
 * Compare the working copy with the clean orders.
 * @returns {{
 *   statuses: {id, kind, label, status: "fixed"|"open"|"wrong", have?}[],
 *   fixed: string[], open: string[], wrong: string[],
 *   damage: {orderId?, field?, text}[]      good data that was changed or deleted
 * }}
 */
export function audit(state, dataset, cleanRows) {
  const header = state.header, formats = dataset.formats || {}, cols = LETTERS(header.length);
  const byId = new Map();
  state.rows.forEach(r => { const k = r[0]; if (!byId.has(k)) byId.set(k, []); byId.get(k).push(r); });
  const cleanById = new Map(cleanRows.map(r => [r[0], r]));
  const defectCells = new Set();
  const statuses = dataset.defects.map(d => {
    const rs = byId.get(d.orderId) || [];
    if (d.kind === "duplicate") {
      const status = rs.length === 1 ? "fixed" : rs.length > 1 ? "open" : "wrong";
      return { id: d.id, kind: d.kind, label: d.label, status, have: rs.length };
    }
    const fi = header.indexOf(d.field);
    if (!rs.length) return { id: d.id, kind: d.kind, label: d.label, status: "wrong", have: "deleted" };
    const v = rs[0][fi];
    const status = same(v, d.good) ? "fixed" : same(v, d.bad) ? "open" : "wrong";
    if (status !== "fixed") defectCells.add(`${d.orderId}|${fi}`);
    return { id: d.id, kind: d.kind, label: d.label, status, have: show(v, formats[cols[fi]]) };
  });
  const damage = [];
  for (const [id, want] of cleanById) {
    const rs = byId.get(id);
    if (!rs) { damage.push({ orderId: id, text: `${id} is missing: its row was deleted, or its OrderID was changed` }); continue; }
    rs.forEach(r => want.forEach((w, fi) => {
      if (same(r[fi], w) || defectCells.has(`${id}|${fi}`)) return;
      damage.push({ orderId: id, field: header[fi], text: `${id} ${header[fi]} was changed from ${show(w, formats[cols[fi]])} to ${show(r[fi], formats[cols[fi]])}` });
    }));
  }
  const unknown = state.rows.filter(r => !cleanById.has(r[0]));
  if (unknown.length) damage.push({ text: `${unknown.length} row${unknown.length === 1 ? " has" : "s have"} an OrderID that isn't in the export (for example ${show(unknown[0][0])})` });
  const pick = s => statuses.filter(x => x.status === s).map(x => x.id);
  return { statuses, fixed: pick("fixed"), open: pick("open"), wrong: pick("wrong"), damage };
}

/** What the grader's cleaning-done check reads. */
export function cleaningSubmission(state, dataset, cleanRows) {
  const a = audit(state, dataset, cleanRows);
  return { fixed: a.fixed, wrong: a.wrong, damage: a.damage.map(d => d.text) };
}

/* =========================================================================
   DOM: createCleaningLab(host, opts)
   opts: {
     dataset,                         AEGEAN_MESSY (orders + refTables + defects + formats)
     ops = [],                        moves already made (a draft); replayed on mount
     locked,                          read-only preview (a locked level)
     onChange(state, ops, info),      after every move / undo / start over
     onTest(result, formula, {source}) after "Test on row" (formula drills grade these)
   }
   Returns { state(), ops(), setFormula(f), test(f), applySteps(ops), focusFormula(), destroy() }
   ========================================================================= */
export const TOOLS = Object.freeze([
  { id: "dedupe", label: "Remove duplicates", excel: "Data ▸ Remove Duplicates", sheets: "Data ▸ Data cleanup ▸ Remove duplicates" },
  { id: "blanks", label: "Find blanks", excel: "Home ▸ Find & Select ▸ Go To Special ▸ Blanks (or F5 ▸ Special ▸ Blanks)", sheets: "Data ▸ Create a filter, then filter the column by condition ▸ Is empty" },
  { id: "fill", label: "Formula fill", excel: "Type the formula in row 2 of a helper column, double-click the fill handle, then Copy ▸ Paste Special ▸ Values over the column. For blanks only: select them with Go To Special ▸ Blanks, type the formula, press Ctrl+Enter", sheets: "Same idea: fill the formula down, then Edit ▸ Paste special ▸ Values only (Ctrl+Shift+V)" },
  { id: "convert", label: "Convert to number", excel: "Select the cells ▸ click the ⚠ warning icon ▸ Convert to Number (or Data ▸ Text to Columns ▸ Finish)", sheets: "=VALUE(G2) in a helper column, then paste as values" },
  { id: "replace", label: "Find & Replace", excel: "Home ▸ Find & Select ▸ Replace (Ctrl+H) ▸ Options ▸ Match entire cell contents", sheets: "Edit ▸ Find and replace (Ctrl+H) ▸ Match entire cell contents" },
  { id: "sort", label: "Sort", excel: "Data ▸ Sort", sheets: "Data ▸ Sort range" },
  { id: "edit", label: "Edit a cell", excel: "Click the cell, type, press Enter", sheets: "Click the cell, type, press Enter" },
]);

const escH = v => String(v ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
let labUid = 0;

/** Words for a move, as listed under "Your moves". */
export function describeOp(op, header = []) {
  const name = c => { const i = colToIndex(String(c).toUpperCase()) - 1; return header[i] ? `${String(c).toUpperCase()} (${header[i]})` : String(c).toUpperCase(); };
  switch (op.op) {
    case "dedupe": return `Remove Duplicates on ${op.columns?.length && op.columns.length < header.length ? op.columns.map(name).join(", ") : "all columns"}`;
    case "fill": return `Fill ${op.scope === "blanks" ? "the blank cells of" : ""} ${name(op.column)} with ${op.formula} (as values)`.replace("  ", " ");
    case "convert": return `Convert ${name(op.column)} to numbers`;
    case "replace": return `Replace "${op.find}" with "${op.replace}" in ${!op.column || op.column === "all" ? "all columns" : name(op.column)}${op.entire ? ", whole cells only" : ""}${op.matchCase ? ", match case" : ""}`;
    case "set": return `Type ${JSON.stringify(op.value)} into ${op.orderId ? `${op.orderId}'s ${name(op.column)}` : `${String(op.column).toUpperCase()}${op.row}`}`;
    case "sort": return `Sort by ${name(op.column)}, ${op.dir === "desc" ? "largest/Z first" : "smallest/A first"}`;
    default: return op.op;
  }
}

export function createCleaningLab(host, opts = {}) {
  const { dataset, locked = false, onChange, onTest } = opts;
  const id = `clean-${++labUid}`;
  let ops = [...(opts.ops || [])];
  let state;
  try { state = replay(dataset, ops); } catch { ops = []; state = initialState(dataset); } // a stale draft never breaks the page
  const cols = LETTERS(state.header.length);
  const colOptions = (withAll = false) => (withAll ? `<option value="all">All columns</option>` : "") + cols.map(c => `<option value="${c}">${c}: ${escH(state.header[colToIndex(c) - 1])}</option>`).join("");
  let tool = "dedupe";

  host.innerHTML = `
  <div class="clean" id="${id}">
    <div class="clean__bar">
      <div class="clean__tools" role="tablist" aria-label="Cleaning tools">
        ${TOOLS.map(t => `<button type="button" role="tab" class="clean__tool" id="${id}-tab-${t.id}" data-tool="${t.id}" aria-controls="${id}-panel" aria-selected="${t.id === tool}">${escH(t.label)}</button>`).join("")}
      </div>
      <div class="clean__undo">
        <button type="button" class="btn btn--quiet" data-undo disabled>↶ Undo</button>
        <button type="button" class="btn btn--quiet" data-reset disabled>Start over</button>
      </div>
    </div>
    <div class="clean__panel" id="${id}-panel" role="tabpanel" data-panel></div>
    <p class="clean__msg" data-msg aria-live="polite"></p>
    <details class="clean__history" data-history hidden><summary data-history-sum></summary><ol data-history-list></ol></details>
    <div class="clean__sheet" data-sheet></div>
    <p class="clean__legend muted"><span class="clean__tri" aria-hidden="true"></span> green corner = a number stored as text (Excel's warning triangle). Click an export cell to edit it.</p>
  </div>`;
  const $ = s => host.querySelector(s);
  let sheet = null;

  const say = (text, kind = "") => { const m = $("[data-msg]"); m.className = `clean__msg${kind ? ` is-${kind}` : ""}`; m.textContent = text; };

  function renderSheet() {
    const keep = sheet?.el ? { top: sheet.el.scrollTop, left: sheet.el.scrollLeft } : null;
    sheet?.destroy();
    const n = state.rows.length + 1;
    sheet = createSheet($("[data-sheet]"), { cells: cellsOf(state, dataset), range: `A1:X${Math.max(n, 15)}`, headerRows: 1, label: "Order export (A:H) and reference tables (J:X)", formats: dataset.formats || {} });
    // Excel's green triangle: numbers stored as text
    state.rows.forEach((r, i) => r.forEach((v, ci) => {
      if (typeof v === "string" && /^\s*[+-]?[\d.,]+\s*$/.test(v)) { const td = sheet.cell(`${cols[ci]}${i + 2}`); if (td) { td.classList.add("is-textnum"); td.title = "Number stored as text"; } }
    }));
    if (keep) { sheet.el.scrollTop = keep.top; sheet.el.scrollLeft = keep.left; }
  }

  function renderHistory() {
    const h = $("[data-history]");
    h.hidden = ops.length === 0;
    $("[data-history-sum]").textContent = `Your moves (${ops.length})`;
    $("[data-history-list]").innerHTML = ops.map(o => `<li>${escH(describeOp(o, state.header))}</li>`).join("");
    $("[data-undo]").disabled = locked || ops.length === 0;
    $("[data-reset]").disabled = locked || ops.length === 0;
  }

  function commit(op) {
    if (locked) { say("This level is locked: you can look around, but moves aren't applied.", "err"); return false; }
    try {
      const r = applyOp(state, op, { dataset });
      if (r.changed) { state = r.state; ops = [...ops, op]; renderSheet(); renderHistory(); onChange?.(state, ops, { op, message: r.message }); }
      say(r.message, r.changed ? "ok" : "");
      return true;
    } catch (e) {
      if (!(e instanceof CleaningError)) throw e;
      say(e.message + (e.detail?.code === "#N/A" ? " Is the lookup value in the table's first column, and is the table locked with $?" : ""), "err");
      if (e.detail?.formula) { const r = evaluate(e.detail.formula, cellsOf(state, dataset)); sheet.highlight(r.highlights, { animate: false }); sheet.reveal(`A${e.detail.row}`); }
      return false;
    }
  }

  const PANELS = {
    dedupe: () => `
      <p class="clean__hint">Rows whose ticked columns all match are duplicates. Excel keeps the first and deletes the rest.</p>
      <fieldset class="clean__cols"><legend>Columns to compare</legend>
        ${cols.map(c => `<label><input type="checkbox" name="dcol" value="${c}" checked> ${c}: ${escH(state.header[colToIndex(c) - 1])}</label>`).join("")}
      </fieldset>
      <div class="clean__row"><button type="button" class="btn btn--quiet" data-all>Select all</button><button type="button" class="btn btn--quiet" data-none>Unselect all</button><button type="button" class="btn btn--primary" data-apply>Remove duplicates</button></div>`,
    blanks: () => `
      <p class="clean__hint">Selects the empty cells of a column, so you can see what's missing before you fill it.</p>
      <div class="clean__row"><label>Column <select data-f="column">${colOptions()}</select></label><button type="button" class="btn btn--primary" data-apply>Find blanks</button></div>`,
    fill: () => `
      <p class="clean__hint">Write the formula <strong>for row 2</strong>. It's copied down (relative references move, <code>$</code> ones stay) and the results replace the column as plain values.</p>
      <div class="fx clean__fx"><span class="fx__eq" aria-hidden="true">=</span>
        <label class="visually-hidden" for="${id}-fx">Formula for row 2</label>
        <input class="fx__input" id="${id}-fx" data-f="formula" type="text" spellcheck="false" autocomplete="off" autocapitalize="characters" placeholder="e.g. TRIM(PROPER(D2))"></div>
      <div class="clean__row">
        <label>Test on row <input data-f="row" type="number" min="2" value="2" class="clean__num"></label>
        <button type="button" class="btn btn--secondary" data-test>Test</button>
        <label>Put results in <select data-f="column"><option value="">(choose a column)</option>${colOptions()}</select></label>
        <label>Cells <select data-f="scope"><option value="all">every row</option><option value="blanks">only the blank ones</option></select></label>
        <button type="button" class="btn btn--primary" data-apply>Fill down</button>
      </div>
      <div class="clean__result" data-result aria-live="polite"></div>`,
    convert: () => `
      <p class="clean__hint">Turns numbers stored as text (left-aligned, green corner) into real numbers. Words are left alone.</p>
      <div class="clean__row"><label>Column <select data-f="column">${colOptions()}</select></label><button type="button" class="btn btn--primary" data-apply>Convert to Number</button></div>`,
    replace: () => `
      <div class="clean__row">
        <label>Find what <input data-f="find" type="text" class="clean__text" spellcheck="false" autocomplete="off"></label>
        <label>Replace with <input data-f="replace" type="text" class="clean__text" spellcheck="false" autocomplete="off"></label>
        <label>Within <select data-f="column">${colOptions(true)}</select></label>
      </div>
      <div class="clean__row">
        <label><input type="checkbox" data-f="entire"> Match entire cell contents</label>
        <label><input type="checkbox" data-f="matchCase"> Match case</label>
        <button type="button" class="btn btn--primary" data-apply>Replace All</button>
      </div>
      <p class="clean__hint">Dates are matched as they're shown (YYYY-MM-DD).</p>`,
    sort: () => `
      <div class="clean__row"><label>Sort by <select data-f="column">${colOptions()}</select></label>
        <label>Order <select data-f="dir"><option value="asc">Smallest to largest / A→Z</option><option value="desc">Largest to smallest / Z→A</option></select></label>
        <button type="button" class="btn btn--primary" data-apply>Sort</button></div>`,
    edit: () => `
      <p class="clean__hint">Click a cell in the export, or type its address. Type dates as YYYY-MM-DD. Starting with = runs a formula and stores its value.</p>
      <div class="clean__row">
        <label>Cell <input data-f="cell" type="text" class="clean__addr" spellcheck="false" autocomplete="off" autocapitalize="characters" placeholder="D59"></label>
        <span class="muted" data-current></span>
      </div>
      <div class="clean__row">
        <label>New value <input data-f="value" type="text" class="clean__text" spellcheck="false" autocomplete="off"></label>
        <button type="button" class="btn btn--primary" data-apply>Enter</button>
      </div>`,
  };

  function field(name) { return $(`[data-panel] [data-f="${name}"]`); }
  function showTool(t, { focus = false } = {}) {
    tool = t;
    host.querySelectorAll("[data-tool]").forEach(b => { const on = b.dataset.tool === t; b.setAttribute("aria-selected", on); b.tabIndex = on ? 0 : -1; });
    const info = TOOLS.find(x => x.id === t);
    const panel = $("[data-panel]");
    panel.setAttribute("aria-labelledby", `${id}-tab-${t}`);
    panel.innerHTML = PANELS[t]() + `<p class="clean__path"><span class="clean__app">Excel</span> ${escH(info.excel)}<br><span class="clean__app">Sheets</span> ${escH(info.sheets)}</p>`;
    if (focus) panel.querySelector("input, select, button")?.focus();
  }

  function cellAddress() {
    const m = /^\s*\$?([A-Z]+)\$?(\d+)\s*$/i.exec(field("cell")?.value || "");
    return m ? { col: m[1].toUpperCase(), row: Number(m[2]) } : null;
  }
  function showCurrent() {
    const a = cellAddress(), out = $("[data-current]"); if (!out) return;
    if (!a) { out.textContent = ""; return; }
    const ci = cols.indexOf(a.col), r = state.rows[a.row - 2];
    out.textContent = ci < 0 || !r ? "That cell isn't part of the export (A:H)." : `Now: ${r[ci] === "" || r[ci] == null ? "(empty)" : typeof r[ci] === "number" ? (formatAs(r[ci], dataset.formats?.[a.col]) ?? r[ci]) : JSON.stringify(r[ci])}`;
  }

  function test(formula = field("formula")?.value ?? "", { source = "user" } = {}) {
    if (tool !== "fill") showTool("fill");
    const input = field("formula"); input.value = String(formula).replace(/^=/, "");
    const row = Math.max(2, Number(field("row").value) || 2);
    const f = "=" + input.value.trim();
    let shifted, res;
    try { shifted = shiftFormula(f, row - 2); res = evaluate(shifted, cellsOf(state, dataset)); }
    catch (e) { res = { ok: false, value: null, error: { code: e.detail?.code || null, message: e.message }, highlights: [], trace: [] }; shifted = f; }
    const out = $("[data-result]");
    out.innerHTML = res.ok
      ? `<div class="rbox rbox--ok"><span class="rbox__label">Row ${row}: <span class="mono">${escH(shifted)}</span></span><output class="rbox__value">${escH(typeof res.value === "string" ? JSON.stringify(res.value) : res.value)}</output></div>`
      : `<div class="rbox rbox--err" role="alert"><span class="rbox__label">Row ${row}: <span class="mono">${escH(shifted)}</span></span>${res.error.code ? `<span class="rbox__code">${escH(res.error.code)}</span>` : ""}<span class="rbox__msg">${escH(res.error.message || "")}</span></div>`;
    sheet.highlight(res.highlights);
    try { onTest?.(res, row === 2 ? f : shifted, { source }); } catch (e) { console.error(e); }
    return res;
  }

  host.addEventListener("click", e => {
    const b = e.target.closest("button"); if (!b || !host.contains(b)) return;
    if (b.dataset.tool) { showTool(b.dataset.tool); return; }
    if (b.hasAttribute("data-undo")) { ops = ops.slice(0, -1); state = replay(dataset, ops); renderSheet(); renderHistory(); say("Undid the last move.", ""); onChange?.(state, ops, { undo: true }); return; }
    if (b.hasAttribute("data-reset")) { ops = []; state = initialState(dataset); renderSheet(); renderHistory(); say("Back to the original export.", ""); onChange?.(state, ops, { reset: true }); return; }
    if (b.hasAttribute("data-all") || b.hasAttribute("data-none")) { host.querySelectorAll('[name="dcol"]').forEach(x => { x.checked = b.hasAttribute("data-all"); }); return; }
    if (b.hasAttribute("data-test")) { test(); return; }
    if (!b.hasAttribute("data-apply")) return;
    if (tool === "dedupe") {
      const columns = [...host.querySelectorAll('[name="dcol"]:checked')].map(x => x.value);
      if (!columns.length) { say("Tick at least one column to compare.", "err"); return; }
      commit({ op: "dedupe", columns: columns.length === cols.length ? undefined : columns });
    } else if (tool === "blanks") {
      const c = field("column").value, ci = cols.indexOf(c);
      const hits = state.rows.map((r, i) => (isBlank(r[ci]) ? `${c}${i + 2}` : null)).filter(Boolean);
      sheet.highlight(hits.map(cell => ({ cell, role: "search" })), { animate: false });
      if (hits.length) sheet.reveal(hits[0]);
      say(hits.length ? `${hits.length} blank cell${hits.length === 1 ? "" : "s"} in ${state.header[ci]}: ${hits.join(", ")}.` : `No blank cells in ${state.header[ci]}.`, hits.length ? "ok" : "");
    } else if (tool === "fill") {
      if (!field("column").value) { say("Choose the column the results go into.", "err"); field("column").focus(); return; }
      commit({ op: "fill", formula: "=" + field("formula").value.trim().replace(/^=/, ""), column: field("column").value, scope: field("scope").value });
    } else if (tool === "convert") commit({ op: "convert", column: field("column").value });
    else if (tool === "replace") commit({ op: "replace", find: field("find").value, replace: field("replace").value, column: field("column").value, entire: field("entire").checked, matchCase: field("matchCase").checked });
    else if (tool === "sort") commit({ op: "sort", column: field("column").value, dir: field("dir").value });
    else if (tool === "edit") {
      const a = cellAddress();
      if (!a) { say("Type a cell address such as D59.", "err"); return; }
      if (commit({ op: "set", row: a.row, column: a.col, value: field("value").value })) showCurrent();
    }
  });
  // Arrow keys move between tool tabs (ARIA tabs pattern)
  host.querySelector("[role=tablist]").addEventListener("keydown", e => {
    if (!["ArrowRight", "ArrowLeft", "Home", "End"].includes(e.key)) return;
    const i = TOOLS.findIndex(t => t.id === tool);
    const j = e.key === "Home" ? 0 : e.key === "End" ? TOOLS.length - 1 : (i + (e.key === "ArrowRight" ? 1 : -1) + TOOLS.length) % TOOLS.length;
    showTool(TOOLS[j].id); host.querySelector(`[data-tool="${TOOLS[j].id}"]`).focus(); e.preventDefault();
  });
  host.addEventListener("keydown", e => {
    if (e.key !== "Enter" || !e.target.matches?.("[data-panel] input[type=text], [data-panel] input[type=number]")) return;
    e.preventDefault();
    if (tool === "fill" && e.target.dataset.f !== "formula" && e.target.dataset.f !== "row") return;
    if (tool === "fill") test(); else host.querySelector("[data-panel] [data-apply]")?.click();
  });
  host.addEventListener("input", e => { if (e.target.dataset?.f === "cell") showCurrent(); });
  // Click an export cell to edit it
  host.querySelector("[data-sheet]").addEventListener("click", e => {
    const td = e.target.closest("td[data-cell]"); if (!td) return;
    const m = /^([A-Z]+)(\d+)$/.exec(td.dataset.cell); if (!m || !cols.includes(m[1]) || Number(m[2]) < 2 || Number(m[2]) > state.rows.length + 1) return;
    showTool("edit");
    field("cell").value = td.dataset.cell; showCurrent();
    const v = state.rows[Number(m[2]) - 2][cols.indexOf(m[1])];
    field("value").value = v == null ? "" : typeof v === "number" ? (formatAs(v, dataset.formats?.[m[1]]) ?? String(v)) : String(v);
    field("value").focus(); field("value").select();
  });

  showTool(tool);
  renderSheet();
  renderHistory();

  return {
    state: () => state,
    ops: () => [...ops],
    setFormula(f) { showTool("fill"); field("formula").value = String(f ?? "").replace(/^=/, ""); },
    test: (f, o) => test(f, o),
    /** Apply a list of moves (e.g. a revealed solution). Returns the messages. */
    applySteps(list) { const msgs = []; for (const op of list) { if (!commit(op)) break; msgs.push($("[data-msg]").textContent); } return msgs; },
    focusFormula() { showTool("fill"); field("formula").focus(); },
    sheet: () => sheet,
    destroy() { sheet?.destroy(); host.innerHTML = ""; },
  };
}
