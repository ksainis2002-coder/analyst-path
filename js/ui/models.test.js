/* models.test.js: the pure halves of the Level 3 components (Node + browser).
   Run with `node js/ui/models.test.js`.
     cleaning.js  every move, the audit (fixed / wrong / damage), formula fill-down
     pivot.js     grouping, filters, Show Values As, against an INDEPENDENT oracle
     story.js     series, ordering, sentence blanks
   The oracle below is plain JS over the raw generated tables, never the pivot code. */
import { initialState, applyOp, replay, audit, cellsOf, shiftFormula, parseTyped, cleaningSubmission, CleaningError } from "./cleaning.js";
import { deriveRows, computePivot, pivotState, fieldItems, formatPivotValue } from "./pivot.js";
import { seriesOptions, chartData, sentenceParts, fillSentence, parseAnswerNumber, GRAND } from "./story.js";
import { AEGEAN, AEGEAN_MESSY } from "../data.js";
import { grade } from "../grader.js";
import RAW from "../data/aegean.generated.js";
import { createSuite, eq, assert } from "../testkit.js";

const s = createSuite("models (cleaning · pivot · story)");
const M = AEGEAN_MESSY, CLEAN = RAW.orders;
const run = (ops, st = initialState(M)) => ops.reduce((x, op) => applyOp(x, op, { dataset: M }).state, st);
const row = (st, id) => st.rows.find(r => r[0] === id);
const near = (a, b, t = 1e-6) => Math.abs(a - b) <= t;

/* ---------- independent oracle ---------- */
const price = pid => RAW.products.find(p => p[0] === pid);
const qtr = serial => `Qtr${Math.floor(new Date(Date.UTC(1899, 11, 30) + serial * 864e5).getUTCMonth() / 3) + 1}`;
const rev = o => (price(o[2]) ? o[6] * price(o[2])[4] * (1 - o[7]) : 0);
const sumBy = (rows, keyFn, valFn) => rows.reduce((m, o) => { const k = keyFn(o); m[k] = (m[k] || 0) + valFn(o); return m; }, {});

s.group("cleaning: shiftFormula (fill-down)");
s.test("relative rows move; $ rows stay; quotes and whole columns are untouched", () => {
  eq(shiftFormula("=TRIM(PROPER(D2))", 3), "=TRIM(PROPER(D5))");
  eq(shiftFormula("=VLOOKUP(E2,$Q$2:$R$8,2,FALSE)", 10), "=VLOOKUP(E12,$Q$2:$R$8,2,FALSE)");
  eq(shiftFormula("=VLOOKUP(E2,P2:R8,3,FALSE)", 10), "=VLOOKUP(E12,P12:R18,3,FALSE)"); // the drifting table
  eq(shiftFormula("=D$2&A2", 1), "=D$2&A3");
  eq(shiftFormula('=COUNTIF(A:A,"A2")', 5), '=COUNTIF(A:A,"A2")');
  eq(shiftFormula("=LOG10(A2)", 1), "=LOG10(A3)");
});
s.test("moving above row 1 is a #REF!", () => { let e; try { shiftFormula("=A2", -2); } catch (x) { e = x; } assert(e instanceof CleaningError && e.detail.code === "#REF!", "throws"); });
s.test("typed entries: numbers and ISO dates become numbers; everything else stays text as typed", () => {
  eq(parseTyped("14"), 14); eq(parseTyped("2025-12-12", "date"), 46003); eq(parseTyped("5%", "percent"), 0.05);
  eq(parseTyped(" attica "), " attica "); eq(parseTyped("O1001"), "O1001"); eq(parseTyped(""), null);
});

s.group("cleaning: the moves");
s.test("the export starts with 182 rows (2 duplicates) and 11 open issues", () => {
  const st = initialState(M); eq(st.rows.length, 182);
  const a = audit(st, M, CLEAN); eq(a.open.length, 11); eq(a.fixed, []); eq(a.damage, []);
});
s.test("Remove Duplicates on every column removes exactly the 2 duplicate rows", () => {
  const r = applyOp(initialState(M), { op: "dedupe" }, { dataset: M });
  eq(r.state.rows.length, 180); assert(r.message.startsWith("2 duplicate rows removed; 180 unique"), r.message);
  eq(audit(r.state, M, CLEAN).fixed, ["dup-o1034", "dup-o1121"]);
});
s.test("Remove Duplicates keyed on OrderID alone also works", () => eq(run([{ op: "dedupe", columns: ["A"] }]).rows.length, 180));
s.test("Remove Duplicates keyed on Region deletes real orders → damage", () => {
  const st = run([{ op: "dedupe", columns: ["D"] }]); const a = audit(st, M, CLEAN);
  assert(st.rows.length < 20, `${st.rows.length} rows left`);
  assert(a.damage.length > 150 && a.damage[0].text.includes("is missing"), a.damage[0]?.text);
});
s.test("the Reps table is keyed by RepID, so looking up a rep NAME in P:R is #N/A (search the name column Q)", () => {
  let e; try { applyOp(initialState(M), { op: "fill", formula: "=VLOOKUP(E2,$P$2:$R$8,3,FALSE)", column: "D", scope: "blanks" }, { dataset: M }); } catch (x) { e = x; }
  assert(e && e.detail.code === "#N/A" && e.message.startsWith("Row 59"), e?.message);
});
s.test("fill blanks with the rep's region (VLOOKUP, table locked) fixes both blanks and nothing else", () => {
  const r = applyOp(initialState(M), { op: "fill", formula: "=VLOOKUP(E2,$Q$2:$R$8,2,FALSE)", column: "D", scope: "blanks" }, { dataset: M });
  assert(r.message.startsWith("Filled 2 blank cells in column D"), r.message);
  const a = audit(r.state, M, CLEAN);
  eq(a.fixed, ["blank-region-o1057", "blank-region-o1098"]); eq(a.damage, []);
});
s.test("fill with an UNLOCKED table drifts off the Reps table and is refused, naming the row", () => {
  let e; try { applyOp(initialState(M), { op: "fill", formula: "=VLOOKUP(E2,Q2:R8,2,FALSE)", column: "D", scope: "all" }, { dataset: M }); } catch (x) { e = x; }
  assert(e instanceof CleaningError && e.detail.code === "#N/A" && /^Row \d+ gives #N\/A/.test(e.message), e?.message);
});
s.test("filling the whole Region column from the rep fixes blanks AND casing in one move (region = rep's region)", () => {
  const a = audit(run([{ op: "fill", formula: "=VLOOKUP(E2,$Q$2:$R$8,2,FALSE)", column: "D" }]), M, CLEAN);
  eq(a.fixed.sort(), ["blank-region-o1057", "blank-region-o1098", "caps-o1076", "lower-o1140", "spaces-o1012"]); eq(a.damage, []);
});
s.test("=TRIM(PROPER(D2)) filled down column D fixes the 3 text issues; blanks stay blank-issues", () => {
  const a = audit(run([{ op: "fill", formula: "=TRIM(PROPER(D2))", column: "D" }]), M, CLEAN);
  eq(a.fixed.sort(), ["caps-o1076", "lower-o1140", "spaces-o1012"]); eq(a.damage, []);
  eq(a.statuses.find(x => x.id === "blank-region-o1057").status, "open");
});
s.test("TRIM alone leaves the case wrong: reported as 'wrong', not fixed", () => {
  const a = audit(run([{ op: "fill", formula: "=TRIM(D2)", column: "D" }]), M, CLEAN);
  eq(a.statuses.find(x => x.id === "spaces-o1012").status, "wrong"); eq(a.statuses.find(x => x.id === "spaces-o1012").have, '"attica"');
});
s.test("Convert to Number fixes the two text quantities only", () => {
  const r = applyOp(initialState(M), { op: "convert", column: "G" }, { dataset: M });
  assert(r.message.startsWith("Converted 2 cells"), r.message);
  eq(audit(r.state, M, CLEAN).fixed, ["text-qty-o1045", "text-qty-o1150"]);
  assert(applyOp(initialState(M), { op: "convert", column: "D" }, { dataset: M }).message.includes("no numbers stored as text"), "words don't convert");
});
s.test("=VALUE(G2) filled down G is the formula route to the same fix", () => eq(audit(run([{ op: "fill", formula: "=VALUE(G2)", column: "G" }]), M, CLEAN).fixed, ["text-qty-o1045", "text-qty-o1150"]));
s.test("Find & Replace P0O2 → P002 (match entire cell) fixes the typo", () => {
  const r = applyOp(initialState(M), { op: "replace", find: "P0O2", replace: "P002", column: "C", entire: true }, { dataset: M });
  eq(r.changed, 1); eq(audit(r.state, M, CLEAN).fixed, ["typo-product-o1088"]);
});
s.test("Find & Replace 'O' → '0' across all columns wrecks every OrderID (Excel re-reads them as numbers)", () => {
  const st = run([{ op: "replace", find: "O", replace: "0" }]);
  eq(row(st, "O1001"), undefined); assert(st.rows.some(r => r[0] === 1001), "O1001 became the number 1001");
  const a = audit(st, M, CLEAN); assert(a.damage.length > 100, `${a.damage.length}`);
  assert(a.damage.some(d => d.text.includes("isn't in the export")), "unknown IDs reported");
});
s.test("Find & Replace in a date column works on the date as shown (2026 → 2025)", () => {
  const a = audit(run([{ op: "replace", find: "2026", replace: "2025", column: "B" }]), M, CLEAN);
  eq(a.fixed, ["future-date-o1170"]); eq(a.damage, []);
});
s.test("editing a cell: a date typed as YYYY-MM-DD, a region typed by hand", () => {
  let st = run([{ op: "set", orderId: "O1170", column: "B", value: "2025-12-12" }]);
  eq(row(st, "O1170")[1], 46003);
  st = run([{ op: "set", row: 59, column: "D", value: "Macedonia" }], st);
  eq(row(st, "O1057")[3], "Macedonia");
  st = run([{ op: "set", row: 100, column: "D", value: "Crete" }], st);
  const a = audit(st, M, CLEAN);
  assert(a.fixed.includes("blank-region-o1057") && a.fixed.includes("future-date-o1170"), a.fixed.join());
  eq(a.statuses.find(x => x.id === "blank-region-o1098").status, "wrong"); // guessed the wrong region
});
s.test("a cell edit can be a formula; its value is stored", () => eq(row(run([{ op: "set", orderId: "O1057", column: "D", value: "=VLOOKUP(E59,$Q$2:$R$8,2,FALSE)" }]), "O1057")[3], "Macedonia"));
s.test("Sort by Date, newest first, brings the 2026 typo to the top (blanks last); no damage", () => {
  const st = run([{ op: "sort", column: "B", dir: "desc" }]);
  eq(st.rows[0][0], "O1170"); eq(audit(st, M, CLEAN).damage, []);
  const byRegion = run([{ op: "sort", column: "D", dir: "asc" }]); eq(byRegion.rows.slice(-2).map(r => r[3]), ["", ""]);
});
s.test("errors are friendly and change nothing", () => {
  for (const op of [{ op: "fill", formula: "", column: "D" }, { op: "replace", find: "" }, { op: "set", row: 999, column: "D", value: "x" }, { op: "sort", column: "Z" }, { op: "nope" }]) {
    let e; try { applyOp(initialState(M), op, { dataset: M }); } catch (x) { e = x; } assert(e instanceof CleaningError && e.message.length > 5, JSON.stringify(op));
  }
});
s.test("moves never mutate the state they're given", () => {
  const st = initialState(M), snap = JSON.stringify(st);
  [{ op: "dedupe" }, { op: "convert", column: "G" }, { op: "replace", find: "a", replace: "b" }, { op: "sort", column: "A", dir: "desc" }, { op: "set", row: 2, column: "D", value: "x" }, { op: "fill", formula: "=TRIM(D2)", column: "D" }]
    .forEach(op => applyOp(st, op, { dataset: M }));
  eq(JSON.stringify(st), snap);
});

s.group("cleaning: the full clean-up");
const FULL = [
  { op: "dedupe" },
  { op: "fill", formula: "=VLOOKUP(E2,$Q$2:$R$8,2,FALSE)", column: "D", scope: "blanks" },
  { op: "fill", formula: "=TRIM(PROPER(D2))", column: "D" },
  { op: "convert", column: "G" },
  { op: "replace", find: "P0O2", replace: "P002", column: "C", entire: true },
  { op: "set", orderId: "O1170", column: "B", value: "2025-12-12" },
];
s.test("these six moves fix all 11 issues with no damage, and the result IS the clean order log", () => {
  const st = replay(M, FULL), a = audit(st, M, CLEAN);
  eq(a.fixed.length, 11); eq(a.damage, []); eq(st.rows, CLEAN);
});
s.test("order of moves doesn't matter for these fixes", () => eq(audit(replay(M, [...FULL].reverse()), M, CLEAN).fixed.length, 11));
s.test("cleaningSubmission feeds the grader's cleaning-done check", () => {
  const sub = cleaningSubmission(replay(M, FULL), M, CLEAN);
  eq(grade({ cleaning: sub }, { type: "cleaning-done", defects: M.defects.map(d => d.id) }).pass, true);
  const half = cleaningSubmission(replay(M, FULL.slice(0, 2)), M, CLEAN);
  eq(grade({ cleaning: half }, { type: "cleaning-done", defects: M.defects.map(d => d.id) }).reason, "cleaning-incomplete");
});
s.test("cellsOf keeps the reference tables beside the working export", () => {
  const c = cellsOf(replay(M, FULL), M); eq(c.A2, "O1001"); eq(c.J2, "P001"); eq(c.P2, "R01"); eq(c.A182, undefined);
});

s.group("pivot: helper columns");
const recs = deriveRows(CLEAN, AEGEAN);
s.test("Revenue, Margin, Quarter, Month, Year, Product and Category per order", () => {
  const o = CLEAN[0], r = recs[0], p = price(o[2]);
  assert(near(r.Revenue, o[6] * p[4] * (1 - o[7])), "revenue"); assert(near(r.Margin, r.Revenue - o[6] * p[3]), "margin");
  eq([r.Quarter, r.Month, r.Year, r.Product, r.Category], [qtr(o[1]), "Jan", 2025, p[1], p[2]]);
});
s.test("an unknown product (P015) counts as 0 revenue, flagged as a missing price", () => {
  const r = recs.find(x => x.ProductID === "P015"); eq([r.Revenue, r.Margin, r.priceMissing], [0, 0, true]);
});
s.test("a quantity stored as text still multiplies (Excel coerces it in arithmetic)", () => {
  const r = deriveRows([["X", 45700, "P004", "Attica", "a", "Online", "10", 0]], AEGEAN)[0]; eq(r.Revenue, 290);
});

s.group("pivot: compute vs the independent oracle");
const RQ = { rows: "Region", columns: "Quarter", value: "Revenue", agg: "sum", showAs: "none", filter: null };
const res = computePivot(recs, RQ);
s.test("Region × Quarter, Sum of Revenue: every cell, row total and column total", () => {
  const cell = sumBy(CLEAN, o => `${o[3]}|${qtr(o[1])}`, rev), rt = sumBy(CLEAN, o => o[3], rev), ct = sumBy(CLEAN, o => qtr(o[1]), rev);
  for (const [k, v] of Object.entries(cell)) { const [r, c] = k.split("|"); assert(near(res.cells[r][c], v), k); }
  for (const [k, v] of Object.entries(rt)) assert(near(res.rowTotals[k], v), k);
  for (const [k, v] of Object.entries(ct)) assert(near(res.colTotals[k], v), k);
  assert(near(res.grand, CLEAN.reduce((t, o) => t + rev(o), 0)), "grand");
});
s.test("labels sorted A→Z; quarters in calendar order", () => { eq(res.rowKeys, ["Attica", "Crete", "Macedonia", "Peloponnese", "Thessaly"]); eq(res.colKeys, ["Qtr1", "Qtr2", "Qtr3", "Qtr4"]); });
s.test("% of Grand Total / Column Total / Row Total", () => {
  const g = computePivot(recs, { ...RQ, showAs: "pct-grand" }), c = computePivot(recs, { ...RQ, showAs: "pct-col" }), r = computePivot(recs, { ...RQ, showAs: "pct-row" });
  assert(near(g.cells.Macedonia.Qtr4, res.cells.Macedonia.Qtr4 / res.grand), "grand"); eq(g.grand, 1);
  assert(near(c.cells.Macedonia.Qtr4, res.cells.Macedonia.Qtr4 / res.colTotals.Qtr4), "col"); eq(c.colTotals.Qtr4, 1);
  assert(near(c.rowTotals.Attica, res.rowTotals.Attica / res.grand), "total column under % of column");
  assert(near(r.cells.Attica.Qtr1, res.cells.Attica.Qtr1 / res.rowTotals.Attica), "row"); eq(r.rowTotals.Attica, 1);
  const shares = c.rowKeys.map(k => c.cells[k].Qtr4); assert(near(shares.reduce((a, b) => a + b, 0), 1), "Q4 column adds to 100%");
});
s.test("Count of OrderID, Average and Max of Quantity", () => {
  const n = computePivot(recs, { rows: "Rep", value: "OrderID", agg: "count" });
  for (const [rep, k] of Object.entries(sumBy(CLEAN, o => o[4], () => 1))) eq(n.rowTotals[rep], k, rep);
  eq(n.grand, 180);
  const avg = computePivot(recs, { rows: "Category", value: "Quantity", agg: "average" });
  const cat = pid => price(pid)?.[2] ?? null;
  const q = CLEAN.filter(o => cat(o[2]) === "Printing").map(o => o[6]);
  assert(near(avg.rowTotals.Printing, q.reduce((a, b) => a + b, 0) / q.length), "average");
  eq(computePivot(recs, { rows: "Region", value: "Quantity", agg: "max" }).grand, Math.max(...CLEAN.map(o => o[6])));
});
s.test("Filter keeps only the ticked items (Channel = Online)", () => {
  const f = computePivot(recs, { rows: "Region", value: "Revenue", agg: "sum", filter: { field: "Channel", values: ["Online"] } });
  const want = sumBy(CLEAN.filter(o => o[5] === "Online"), o => o[3], rev);
  for (const [k, v] of Object.entries(want)) assert(near(f.rowTotals[k], v), k);
  eq(f.count, CLEAN.filter(o => o[5] === "Online").length);
});
s.test("not ready without Rows and Values", () => { eq(computePivot(recs, { rows: "Region" }).ready, false); eq(computePivot(recs, { value: "Revenue" }).ready, false); });
s.test("fieldItems lists a field's items in pivot order", () => eq(fieldItems(recs, "Quarter"), ["Qtr1", "Qtr2", "Qtr3", "Qtr4"]));
s.test("formatting: thousands and 2-decimal percentages", () => { eq(formatPivotValue(48781.8), "48,781.8"); eq(formatPivotValue(0.42866, { percent: true }), "42.87%"); eq(formatPivotValue(undefined), ""); });

s.group("pivot: on the messy export (why you clean first)");
const mrecs = deriveRows(M.orders.rows, M);
const mres = computePivot(mrecs, RQ);
s.test("blank regions become a (blank) row, listed last; ' attica ' is its own row; CRETE/crete merge with Crete", () => {
  eq(mres.rowKeys, [" attica ", "Attica", "Crete", "Macedonia", "Peloponnese", "Thessaly", "(blank)"]);
});
s.test("the typo'd product has no price: counted as 0 and flagged", () => assert(mres.missingPrices.includes("P0O2") && mres.missingPrices.includes("P015"), mres.missingPrices.join()));
s.test("messy Macedonia total differs from clean (the dirty pivot is wrong)", () => assert(!near(mres.rowTotals.Macedonia, res.rowTotals.Macedonia, 1), "differs"));
s.test("pivotState: what the grader reads, with the stale flag", () => {
  const p = pivotState(RQ, res, { stale: true });
  eq([p.rows, p.columns, p.value, p.agg, p.showAs, p.stale], ["Region", "Quarter", "Revenue", "sum", "none", true]);
  assert(near(p.cells["Macedonia|Qtr4"], res.cells.Macedonia.Qtr4) && near(p.totals["Grand Total"], res.grand), "figures");
  const check = { type: "pivot-state", expect: { rows: "Region", columns: "Quarter", value: "Revenue", agg: "sum", showAs: "none" }, totals: res.rowTotals, tolerance: 0.01 };
  eq(grade({ pivot: pivotState(RQ, res) }, check).pass, true);
  eq(grade({ pivot: pivotState(RQ, mres, { stale: true }) }, check).reason, "pivot-stale");
  eq(grade({ pivot: pivotState(RQ, mres) }, check).reason, "pivot-totals");
});

s.group("story");
s.test("series: each pivot column + Grand Total; a one-dimensional pivot has only Grand Total", () => {
  eq(seriesOptions(res), ["Qtr1", "Qtr2", "Qtr3", "Qtr4", GRAND]);
  eq(seriesOptions(computePivot(recs, { rows: "Region", value: "Revenue" })), [GRAND]);
  eq(seriesOptions({ ready: false }), []);
});
s.test("chartData: a column over the row labels, sorted largest first", () => {
  const d = chartData(res, "Qtr4", "desc"); eq(d[0].label, "Macedonia"); assert(near(d[0].value, res.cells.Macedonia.Qtr4), "value");
  assert(d.every((x, i) => i === 0 || d[i - 1].value >= x.value), "sorted");
  eq(chartData(res, "Qtr4").map(x => x.label), res.rowKeys);
});
s.test("sentence templates", () => {
  const t = "In Q4, {top} led with €{amount}.";
  eq(sentenceParts(t), [{ text: "In Q4, " }, { blank: "top" }, { text: " led with €" }, { blank: "amount" }, { text: "." }]);
  eq(fillSentence(t, { top: "Macedonia", amount: "48,782" }), "In Q4, Macedonia led with €48,782.");
  eq(parseAnswerNumber("48,782"), 48782);
});

export const done = s.report();
