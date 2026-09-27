/* =========================================================================
   engine.test.js — runnable test suite for js/engine.js
   -------------------------------------------------------------------------
   Run headless:   node js/engine.test.js      (or: npm test)
   In a browser:   import it as a module; results go to the console.

   Wherever possible, expected values are computed directly from the raw v1
   tables below, independently of the engine, so the engine is never
   grading its own answers.

   Sections
     1. Functions (all 20)          5. $ locks
     2. Arithmetic                  6. Nesting
     3. Comparisons                 7. Excel errors (#N/A, #REF!, #NAME?)
     4. Highlights & trace          8. Purity / headless
     9a. Fixed divergences: D1–D3, D5–D10 now match Excel; Phase 5–6 extensions
     9b. Known divergences: v1 behaviour still pinned on purpose (LATER)
     9c. v1 console examples: every formula the v1 app shipped, with the
         "East + Monitor" example (which returned 0) replaced
    10. Coverage guard (every function is exercised by a passing test)
   ========================================================================= */

import { evaluate, FUNCTIONS, ROLES } from "./engine.js";

/* ---------- fixture: the v1 dataset, copied as-is ---------- */
const PRODUCTS = [["P001","Laptop",720],["P002","Monitor",190],["P003","Keyboard",45],["P004","Mouse",25],["P005","Docking Station",130],["P006","Webcam",60],["P007","Headset",85],["P008","USB Hub",35]];
const ORDERS = [["O1000","2024-01-20","P006","West","A. Ioannou",3],["O1001","2024-02-16","P002","North","E. Makris",7],["O1002","2024-01-12","P001","West","D. Georgiou",3],["O1003","2024-01-12","P004","West","A. Ioannou",19],["O1004","2024-01-29","P002","North","E. Makris",19],["O1005","2024-03-04","P007","East","B. Petrou",12],["O1006","2024-02-19","P001","South","C. Nikolaou",8],["O1007","2024-01-08","P003","North","D. Georgiou",5],["O1008","2024-03-22","P005","East","A. Ioannou",14],["O1009","2024-02-02","P002","South","E. Makris",2],["O1010","2024-01-25","P008","West","B. Petrou",16],["O1011","2024-03-11","P004","North","C. Nikolaou",9],["O1012","2024-02-27","P001","East","D. Georgiou",6],["O1013","2024-01-17","P006","South","A. Ioannou",11],["O1014","2024-03-30","P002","West","E. Makris",4],["O1015","2024-02-13","P007","North","B. Petrou",18],["O1016","2024-01-05","P003","East","C. Nikolaou",13],["O1017","2024-03-08","P005","South","D. Georgiou",7],["O1018","2024-02-21","P001","North","A. Ioannou",10],["O1019","2024-01-30","P004","East","E. Makris",15],["O1020","2024-03-15","P002","West","B. Petrou",5],["O1021","2024-02-08","P008","South","C. Nikolaou",20],["O1022","2024-01-19","P006","North","D. Georgiou",6],["O1023","2024-03-26","P007","East","A. Ioannou",9]];

const SHEET = {};
ORDERS.forEach((row, i) => row.forEach((v, c) => { SHEET["ABCDEF"[c] + (i + 2)] = v; }));
PRODUCTS.forEach((row, i) => row.forEach((v, c) => { SHEET["HIJ"[c] + (i + 2)] = v; }));
Object.assign(SHEET, { A1:"OrderID", B1:"Date", C1:"ProductID", D1:"Region", E1:"Rep", F1:"Quantity", H1:"ProductID", I1:"ProductName", J1:"UnitPrice" });
// Test-only addition: a sorted commission-tier table (L1:M5) so approximate
// match (VLOOKUP ...,TRUE / MATCH ...,1) can be tested on data where it is meaningful.
Object.assign(SHEET, { L1:"MinSales", M1:"Tier", L2:0, M2:"Bronze", L3:100, M3:"Silver", L4:500, M4:"Gold", L5:1000, M5:"Platinum" });
Object.freeze(SHEET);

/* ---------- independent oracle (plain JS over the raw arrays) ---------- */
const qty = ORDERS.map(o => o[5]);
const sum = a => a.reduce((s, x) => s + x, 0);
const where = pred => ORDERS.filter(pred);
const price = id => PRODUCTS.find(p => p[0] === id)[2];
const name = id => PRODUCTS.find(p => p[0] === id)[1];
const row = orderId => ORDERS.findIndex(o => o[0] === orderId) + 2;       // sheet row of an order
const prow = productId => PRODUCTS.findIndex(p => p[0] === productId) + 2; // sheet row of a product

/* ---------- tiny harness (no framework) ---------- */
const results = [];
const evaluated = [];   // [{formula, passed}] feeds the coverage guard
let current = null;
let currentGroup = "";

function group(name) { currentGroup = name; }
function test(name, fn, { divergence = false } = {}) {
  current = { group: currentGroup, name, divergence, formulas: [], ok: true, err: null };
  try { fn(); } catch (e) { current.ok = false; current.err = e.message || String(e); }
  current.formulas.forEach(f => evaluated.push({ formula: f, passed: current.ok }));
  results.push(current);
}
function ev(formula, dataset = SHEET) { current.formulas.push(formula); return evaluate(formula, dataset); }
function fmt(x) { return JSON.stringify(x); }
function assert(cond, msg) { if (!cond) throw new Error(msg); }
function same(a, b) { return a === b || (typeof a === "number" && typeof b === "number" && Math.abs(a - b) < 1e-9); }

/** Formula must evaluate OK to `expected`; optionally check the ref it came from. */
function expectValue(formula, expected, { ref, dataset } = {}) {
  const r = ev(formula, dataset);
  assert(r.ok, `${formula} → expected ${fmt(expected)} but got error ${r.error && r.error.code} (${r.error && r.error.message})`);
  assert(same(r.value, expected), `${formula} → expected ${fmt(expected)} but got ${fmt(r.value)}`);
  if (ref !== undefined) assert(r.ref === ref, `${formula} → expected ref ${ref} but got ${r.ref}`);
  return r;
}
/** Formula must fail with the given Excel error code. */
function expectError(formula, code, { dataset } = {}) {
  const r = ev(formula, dataset);
  assert(!r.ok, `${formula} → expected ${code} but it evaluated to ${fmt(r.value)}`);
  assert(r.error.code === code, `${formula} → expected ${code} but got ${fmt(r.error.code)} (${r.error.message})`);
  assert(r.value === null, `${formula} → an error result must have value null`);
  return r;
}

/* =========================================================================
   1. FUNCTIONS
   ========================================================================= */
group("SUM");
test("totals a range", () => expectValue("SUM(F2:F25)", sum(qty)));
test("hand-checked total is 241", () => expectValue("=SUM(F2:F25)", 241));
test("several arguments: range + cell + number", () => expectValue("SUM(F2:F3,F4,10)", 3 + 7 + 3 + 10));
test("skips text cells in a mixed range", () => expectValue("SUM(A2:A25)", 0));

group("AVERAGE");
test("mean of a range", () => expectValue("AVERAGE(F2:F25)", sum(qty) / qty.length));
test("sub-range", () => expectValue("AVERAGE(F2:F4)", (3 + 7 + 3) / 3));

group("COUNT");
test("counts numeric cells", () => expectValue("COUNT(F2:F25)", 24));
test("ignores text IDs", () => expectValue("COUNT(A2:A25)", 0));

group("COUNTA");
test("counts non-empty cells (order IDs)", () => expectValue("COUNTA(A2:A25)", 24));
test("includes the header row when asked", () => expectValue("COUNTA(A1:A25)", 25));
test("skips empty cells (column G is blank)", () => expectValue("COUNTA(G1:G25)", 0));

group("IF");
test("false branch: F2=3 is not > 10", () => expectValue('IF(F2>10,"HIGH","OK")', "OK"));
test("true branch: F5=19 > 10", () => expectValue('IF(F5>10,"HIGH","OK")', "HIGH"));
test("returns numbers from branches", () => expectValue("IF(F2=3,1,0)", 1));
test("text test, case-insensitive like Excel", () => expectValue('IF(D2="west","yes","no")', "yes"));
test("only the chosen branch is evaluated (bad branch not touched)", () => expectValue('IF(1>0,"safe",NOPE(1))', "safe"));

group("SUMIF");
test("sum_range last: North quantity", () =>
  expectValue('SUMIF(D2:D25,"North",F2:F25)', sum(where(o => o[3] === "North").map(o => o[5]))));
test("hand-checked North total is 74", () => expectValue('SUMIF(D2:D25,"North",F2:F25)', 74));
test("no sum_range sums the criteria range itself", () =>
  expectValue('SUMIF(F2:F25,">=15")', sum(qty.filter(q => q >= 15))));

group("SUMIFS");
test("sum_range first: North quantity", () => expectValue('SUMIFS(F2:F25,D2:D25,"North")', 74));
test("two conditions: West AND qty > 5", () =>
  expectValue('SUMIFS(F2:F25,D2:D25,"West",F2:F25,">5")', sum(where(o => o[3] === "West" && o[5] > 5).map(o => o[5]))));
test("two text conditions: North AND product P002", () =>
  expectValue('SUMIFS(F2:F25,D2:D25,"North",C2:C25,"P002")', sum(where(o => o[3] === "North" && o[2] === "P002").map(o => o[5]))));
test("every region adds back to the grand total", () => {
  const t = ["North", "South", "East", "West"].map(r => ev(`SUMIFS(F2:F25,D2:D25,"${r}")`).value);
  assert(sum(t) === sum(qty), `regions sum to ${sum(t)}, expected ${sum(qty)}`);
});

group("COUNTIF");
test('quoted comparison ">10"', () => expectValue('COUNTIF(F2:F25,">10")', qty.filter(q => q > 10).length));
test("text criterion", () => expectValue('COUNTIF(D2:D25,"South")', where(o => o[3] === "South").length));
test("case-insensitive criterion", () => expectValue('COUNTIF(D2:D25,"north")', where(o => o[3] === "North").length));
test('not-equal "<>North"', () => expectValue('COUNTIF(D2:D25,"<>North")', where(o => o[3] !== "North").length));
test("criterion taken from a cell (D2 = West)", () => expectValue("COUNTIF(D2:D25,D2)", where(o => o[3] === "West").length));
test('"<=" and "<" and "="', () => {
  expectValue('COUNTIF(F2:F25,"<=5")', qty.filter(q => q <= 5).length);
  expectValue('COUNTIF(F2:F25,"<5")', qty.filter(q => q < 5).length);
  expectValue('COUNTIF(F2:F25,"=19")', qty.filter(q => q === 19).length);
});

group("COUNTIFS");
test("single condition", () => expectValue('COUNTIFS(D2:D25,"South")', 5));
test('quoted ">=15"', () => expectValue('COUNTIFS(F2:F25,">=15")', qty.filter(q => q >= 15).length));
test("two conditions: North AND qty >= 10", () =>
  expectValue('COUNTIFS(D2:D25,"North",F2:F25,">=10")', where(o => o[3] === "North" && o[5] >= 10).length));

group("IFERROR");
test("passes a good value straight through", () => expectValue('IFERROR(VLOOKUP("P001",H2:J9,2,FALSE),"Not found")', "Laptop"));
test("catches #N/A and uses the fallback", () => expectValue('IFERROR(VLOOKUP("P999",H2:J9,2,FALSE),"Not found")', "Not found"));
test("numeric fallback", () => expectValue('IFERROR(MATCH("zzz",H2:H9,0),0)', 0));
test("catches #NAME? too (as Excel does)", () => expectValue('IFERROR(FOO(1),"caught")', "caught"));
test("catches #REF! too", () => expectValue('IFERROR(INDEX(H2:H9,99),"caught")', "caught"));

group("ROUND");
test("to 1 decimal", () => expectValue("ROUND(AVERAGE(F2:F25),1)", 10));
test("to 2 decimals", () => expectValue("ROUND(3.14159,2)", 3.14));
test("to 0 decimals", () => expectValue("ROUND(7.6,0)", 8));
test("negative digits round to hundreds", () => expectValue("ROUND(1234.5678,-2)", 1200));

group("VLOOKUP");
test("exact: product name for order 1 (C2 = P006)", () => expectValue("VLOOKUP(C2,H2:J9,2,FALSE)", name("P006"), { ref: "I" + prow("P006") }));
test("exact: price column", () => expectValue("VLOOKUP(C2,H2:J9,3,FALSE)", price("P006"), { ref: "J" + prow("P006") }));
test("literal lookup value", () => expectValue('VLOOKUP("P002",H2:J9,3,FALSE)', 190));
test("column 1 returns the key itself", () => expectValue('VLOOKUP("P008",H2:J9,1,FALSE)', "P008"));
test("FALSE written as 0 is exact", () => expectValue('VLOOKUP("P004",H2:J9,2,0)', "Mouse"));
test("case-insensitive match, like Excel", () => expectValue('VLOOKUP("p003",H2:J9,2,FALSE)', "Keyboard"));
test("every order's product name matches the product table", () => {
  ORDERS.forEach((o, i) => expectValue(`VLOOKUP(C${i + 2},$H$2:$J$9,2,FALSE)`, name(o[2])));
});
test("approximate (TRUE): 250 falls in the Silver tier", () => expectValue("VLOOKUP(250,L2:M5,2,TRUE)", "Silver", { ref: "M3" }));
test("approximate: exact boundary 1000 → Platinum", () => expectValue("VLOOKUP(1000,L2:M5,2,TRUE)", "Platinum"));
test("approximate: 99 → Bronze", () => expectValue("VLOOKUP(99,L2:M5,2,TRUE)", "Bronze"));

group("XLOOKUP");
test("basic: no column counting", () => expectValue('XLOOKUP("P002",H2:H9,I2:I9)', "Monitor", { ref: "I3" }));
test("looks LEFT: name → ID", () => expectValue('XLOOKUP("Monitor",I2:I9,H2:H9)', "P002", { ref: "H3" }));
test("lookup value from a cell", () => expectValue("XLOOKUP(C3,H2:H9,J2:J9)", price(ORDERS[1][2])));
test("if_not_found fallback", () => expectValue('XLOOKUP("P999",H2:H9,I2:I9,"Not found")', "Not found"));
test("if_not_found is ignored when there is a match", () => expectValue('XLOOKUP("P001",H2:H9,I2:I9,"Not found")', "Laptop"));

group("MATCH");
test("exact position", () => expectValue('MATCH("P005",H2:H9,0)', 5));
test("exact numeric", () => expectValue("MATCH(190,J2:J9,0)", 2));
test("FALSE as match_type is exact", () => expectValue('MATCH("P008",H2:H9,FALSE)', 8));
test("approximate (1) on sorted tiers", () => expectValue("MATCH(250,L2:L5,1)", 2));

group("INDEX");
test("single column", () => expectValue("INDEX(H2:H9,3)", "P003", { ref: "H4" }));
test("row + column in a 2-D table", () => expectValue("INDEX(H2:J9,3,2)", "Keyboard", { ref: "I4" }));
test("column omitted defaults to 1", () => expectValue("INDEX(H2:J9,2)", "P002"));
test("position computed by an expression", () => expectValue("INDEX(I2:I9,1+1)", "Monitor"));

/* =========================================================================
   2. ARITHMETIC
   ========================================================================= */
group("Arithmetic");
test("precedence: * before +", () => expectValue("2+3*4", 14));
test("precedence: * before + (other side)", () => expectValue("2*3+4", 10));
test("parentheses override precedence", () => expectValue("(2+3)*4", 20));
test("subtraction is left-associative", () => expectValue("10-4-3", 3));
test("division is left-associative", () => expectValue("8/2/2", 2));
test("decimals", () => expectValue("1.5*4", 6));
test("negative literal", () => expectValue("-5+2", -3));
test("multiply by a negative", () => expectValue("2*-3", -6));
test("subtract a negative", () => expectValue("5--1", 6));
test("cell × cell", () => expectValue("F2*F3", qty[0] * qty[1]));
test("function result in arithmetic", () => expectValue("SUM(F2:F3)+1", qty[0] + qty[1] + 1));
test("revenue = qty × looked-up price (v1 chip)", () => expectValue("F2*VLOOKUP(C2,H2:J9,3,FALSE)", ORDERS[0][5] * price(ORDERS[0][2])));
test("revenue for every order", () => {
  ORDERS.forEach((o, i) => expectValue(`F${i + 2}*VLOOKUP(C${i + 2},$H$2:$J$9,3,FALSE)`, o[5] * price(o[2])));
});
test("function ÷ function", () => expectValue("SUM(F2:F25)/COUNT(F2:F25)", sum(qty) / 24));

/* =========================================================================
   3. COMPARISONS (booleans come back as "TRUE"/"FALSE")
   ========================================================================= */
group("Comparisons");
test(">", () => { expectValue("F2>2", "TRUE"); expectValue("F2>3", "FALSE"); });
test("<", () => { expectValue("F2<4", "TRUE"); expectValue("F2<3", "FALSE"); });
test(">=", () => { expectValue("F2>=3", "TRUE"); expectValue("F2>=4", "FALSE"); });
test("<=", () => { expectValue("F2<=3", "TRUE"); expectValue("F2<=2", "FALSE"); });
test("=", () => { expectValue("F2=3", "TRUE"); expectValue("F2=4", "FALSE"); });
test("<>", () => { expectValue("F2<>4", "TRUE"); expectValue("F2<>3", "FALSE"); });
test("text = is case-insensitive", () => expectValue('D2="WEST"', "TRUE"));
test("text <>", () => expectValue('D2<>"East"', "TRUE"));
test("arithmetic binds tighter than comparison", () => expectValue("1+2=3", "TRUE"));
test("comparison of two functions", () => expectValue('SUMIFS(F2:F25,D2:D25,"North")>SUMIFS(F2:F25,D2:D25,"South")', "TRUE"));

/* =========================================================================
   4. HIGHLIGHTS & TRACE (returned as data, not painted)
   ========================================================================= */
group("Highlights & trace");
test("VLOOKUP: search → scan → match → return, in order", () => {
  const r = expectValue("VLOOKUP(C2,H2:J9,2,FALSE)", "Webcam");
  const p = prow("P006"); // 7
  const expected = [{ cell: "C2", role: "search" }];
  for (let k = 2; k <= p; k++) expected.push({ cell: "H" + k, role: "scan" });
  expected.push({ cell: "H" + p, role: "match" }, { cell: "I" + p, role: "return" });
  assert(fmt(r.highlights) === fmt(expected), `highlights were ${fmt(r.highlights)}`);
});
test("INDEX/MATCH: match on search column, return on result column", () => {
  const r = expectValue("INDEX(H2:H9,MATCH(190,J2:J9,0))", "P002");
  assert(r.highlights.some(h => h.cell === "J3" && h.role === "match"), "J3 should be marked match");
  assert(r.highlights.at(-1).cell === "H3" && r.highlights.at(-1).role === "return", "last highlight should be H3 return");
});
test("SUMIFS marks summed cells as return", () => {
  const r = expectValue('SUMIFS(F2:F25,D2:D25,"South")', 48);
  const ret = r.highlights.filter(h => h.role === "return").map(h => h.cell);
  const exp = where(o => o[3] === "South").map(o => "F" + row(o[0]));
  assert(fmt(ret) === fmt(exp), `return cells ${fmt(ret)}`);
});
test("every highlight role is a known role", () => {
  const r = ev("INDEX(H2:J9,MATCH(C2,H2:H9,0),3)");
  assert(r.ok && r.highlights.length > 0 && r.highlights.every(h => ROLES.includes(h.role)), fmt(r.highlights));
});
test("trace explains a VLOOKUP", () => {
  const r = expectValue("VLOOKUP(C2,H2:J9,2,FALSE)", "Webcam");
  assert(r.trace[0].startsWith('VLOOKUP: searching "P006"'), r.trace[0]);
  assert(r.trace.some(t => t.includes("Matched at H7")), fmt(r.trace));
});
test("IFERROR trace records the caught error", () => {
  const r = expectValue('IFERROR(VLOOKUP("P999",H2:J9,2,FALSE),"x")', "x");
  assert(r.trace.some(t => t.includes("IFERROR caught #N/A")), fmt(r.trace));
});
test("an error result still returns the trace and highlights so far", () => {
  const r = expectError('VLOOKUP("P999",H2:J9,2,FALSE)', "#N/A");
  assert(r.trace.length === 1 && r.highlights.filter(h => h.role === "scan").length === 8, fmt(r));
});

/* =========================================================================
   5. $ LOCKS: same result, highlight keys have no "$"
   ========================================================================= */
group("$ locks");
test("fully locked range", () => expectValue("SUM($F$2:$F$25)", sum(qty)));
test("mixed locks: $F2 and F$25", () => expectValue("SUM($F2:F$25)", sum(qty)));
test("locked lookup table", () => expectValue("VLOOKUP(C2,$H$2:$J$9,3,FALSE)", 60, { ref: "J7" }));
test("locked lookup value", () => expectValue("VLOOKUP($C$2,$H$2:$J$9,2,FALSE)", "Webcam"));
test("locked criteria ranges in SUMIFS", () => expectValue('SUMIFS($F$2:$F$25,$D$2:$D$25,"North")', 74));
test("locked single cell in arithmetic", () => expectValue("$F$2*2", 6));
test("highlights never contain $", () => {
  const r = ev("VLOOKUP($C$2,$H$2:$J$9,2,FALSE)");
  assert(r.highlights.every(h => !h.cell.includes("$")), fmt(r.highlights));
});
test("locked and unlocked forms give identical results", () => {
  const a = ev("INDEX(H2:J9,MATCH(C2,H2:H9,0),3)"), b = ev("INDEX($H$2:$J$9,MATCH($C2,$H$2:$H$9,0),3)");
  assert(a.ok && b.ok && a.value === b.value && a.ref === b.ref, `${fmt(a.value)} vs ${fmt(b.value)}`);
});

/* =========================================================================
   6. NESTING
   ========================================================================= */
group("Nesting");
test("INDEX/MATCH reverse lookup (v1 chip)", () => expectValue("INDEX(H2:H9,MATCH(190,J2:J9,0))", "P002", { ref: "H3" }));
test("two-way INDEX/MATCH", () => expectValue('INDEX(H2:J9,MATCH("P007",H2:H9,0),3)', 85));
test("ROUND(AVERAGE)", () => expectValue("ROUND(AVERAGE(F2:F25),2)", Math.round(sum(qty) / 24 * 100) / 100));
test("ROUND(SUM/COUNT)", () => expectValue("ROUND(SUM(F2:F25)/COUNT(F2:F25),2)", 10.04));
test("IF on a SUMIFS result", () => expectValue('IF(SUMIFS(F2:F25,D2:D25,"North")>70,"big","small")', "big"));
test("IF on a VLOOKUP result", () => expectValue('IF(VLOOKUP(C2,H2:J9,3,FALSE)>100,"premium","standard")', "standard"));
test("nested IF (three bands)", () => {
  const f = r => `IF(F${r}>=15,"L",IF(F${r}>=10,"M","S"))`;
  expectValue(f(5), "L");   // 19
  expectValue(f(7), "M");   // 12
  expectValue(f(2), "S");   // 3
});
test("IFERROR around INDEX/MATCH", () => expectValue('IFERROR(INDEX(H2:H9,MATCH(999,J2:J9,0)),"none")', "none"));
test("IF inside arithmetic", () => expectValue("IF(F2>1,10,0)*2", 20));
test("parenthesised function inside arithmetic", () => expectValue("(SUM(F2:F3)+1)*2", (qty[0] + qty[1] + 1) * 2));

/* =========================================================================
   7. EXCEL ERRORS
   ========================================================================= */
group("#N/A");
test("VLOOKUP: ID not in table", () => expectError('VLOOKUP("P999",H2:J9,2,FALSE)', "#N/A"));
test("VLOOKUP: approximate below the lowest tier", () => expectError("VLOOKUP(-1,L2:M5,2,TRUE)", "#N/A"));
test("XLOOKUP: no match and no if_not_found", () => expectError('XLOOKUP("P999",H2:H9,I2:I9)', "#N/A"));
test("MATCH: not found", () => expectError('MATCH("zzz",H2:H9,0)', "#N/A"));
test("#N/A propagates through ROUND", () => expectError('ROUND(VLOOKUP("P999",H2:J9,3,FALSE),0)', "#N/A"));
test("#N/A propagates through arithmetic", () => expectError('F2*VLOOKUP("P999",H2:J9,3,FALSE)', "#N/A"));

group("#REF!");
test("VLOOKUP: column number wider than the table", () => expectError("VLOOKUP(C2,H2:J9,4,FALSE)", "#REF!"));
test("INDEX: row past the end", () => expectError("INDEX(H2:H9,9)", "#REF!"));
test("INDEX: column past the edge", () => expectError("INDEX(H2:J9,1,4)", "#REF!"));

group("#NAME?");
test("unknown function", () => expectError("FOO(1)", "#NAME?"));
test("real Excel function the engine doesn't support yet", () => expectError('CONCAT("a","b")', "#NAME?"));
test("unquoted text", () => expectError("North", "#NAME?"));
test("unquoted text as a lookup value", () => expectError("VLOOKUP(Monitor,H2:J9,2,FALSE)", "#NAME?"));
test("the message names the function", () => {
  const r = expectError("XLOOKUPP(1,H2:H9,I2:I9)", "#NAME?");
  assert(r.error.message.includes("XLOOKUPP"), r.error.message);
});

group("Empty input");
test('empty formula → ok:false, code ""', () => {
  const r = evaluate("", SHEET);
  assert(!r.ok && r.error.code === "" && r.error.message === "Type a formula first.", fmt(r));
});
test('"=" alone is also empty', () => assert(evaluate("=", SHEET).error.code === "", "expected empty-formula error"));

/* =========================================================================
   8. PURITY / HEADLESS
   ========================================================================= */
group("Purity");
test("result has exactly the spec §5.2 shape (+ highlights)", () => {
  const r = evaluate("SUM(F2:F3)", SHEET);
  assert(fmt(Object.keys(r).sort()) === fmt(["error", "highlights", "ok", "ref", "trace", "value"]), fmt(Object.keys(r)));
});
test("no state leaks between calls", () => {
  evaluate("VLOOKUP(C2,H2:J9,2,FALSE)", SHEET);
  const r = evaluate("1+1", SHEET);
  assert(r.trace.length === 0 && r.highlights.length === 0, fmt(r));
});
test("dataset is never mutated (fixture is frozen; also check a copy)", () => {
  const copy = { ...SHEET };
  ["VLOOKUP(C2,H2:J9,2,FALSE)", 'SUMIFS(F2:F25,D2:D25,"North")', "INDEX(H2:J9,MATCH(C2,H2:H9,0),3)", "G2"].forEach(f => evaluate(f, copy));
  assert(fmt(copy) === fmt(SHEET), "dataset changed");
});
test("works against any dataset, not a built-in sheet", () => {
  expectValue("SUM(A1:A3)*B1", 12, { dataset: { A1: 1, A2: 2, A3: 3, B1: 2 } });
  expectValue("A1", 0, { dataset: {} });   // blank cell shows 0 (D5)
});
const IN_NODE = typeof process !== "undefined" && !!(process.versions && process.versions.node);
let SOURCE_CHECKED = "skipped (not running in Node)";
if (IN_NODE) {
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("./engine.js", import.meta.url), "utf8");
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, ""); // strip comments
  test("engine source has no DOM access", () => {
    const hits = ["document", "window", "querySelector", "classList", "innerHTML", "localStorage", "clearHi"].filter(w => new RegExp(`\\b${w}\\b`).test(code));
    assert(hits.length === 0, `found: ${hits.join(", ")}`);
  });
  SOURCE_CHECKED = "checked";
}

/* =========================================================================
   9a. FIXED DIVERGENCES: these now match real Excel
   Each test name carries its original D-number. The old v1 result is noted
   so the change stays traceable.
   ========================================================================= */
const TIER = { L2: 0, M2: "Bronze", L3: 100, M3: "Silver", L4: 500, M4: "Gold" };

group("Fixed D1/D2 VLOOKUP");
test("D1 4th arg omitted → approximate: 250 → Silver (v1: #N/A)", () =>
  expectValue("VLOOKUP(250,L2:M4,2)", "Silver", { dataset: TIER }));
test("D1 the classic trap: forget FALSE and a missing ID silently returns the wrong product (v1: #N/A)", () => {
  // Excel: approximate match on the sorted ID column returns the largest ID ≤ "P999", which is P008.
  const r = expectValue('VLOOKUP("P999",H2:J9,2)', name("P008"));
  assert(r.trace.some(t => t.includes("No 4th argument")), "trace should explain the missing FALSE");
  expectError('VLOOKUP("P999",H2:J9,2,FALSE)', "#N/A");                       // with FALSE: the honest #N/A
});
test("D1 omitted 4th arg on the SORTED ID column gives the right name for all 24 orders", () => {
  ORDERS.forEach((o, i) => expectValue(`VLOOKUP(C${i + 2},$H$2:$J$9,2)`, name(o[2])));
});
test("D1 a trailing empty 4th argument counts as 0, so exact", () =>
  expectError('VLOOKUP("P999",H2:J9,2,)', "#N/A"));
test("D1 below the smallest value → #N/A", () => expectError("VLOOKUP(-1,L2:M5,2)", "#N/A"));
test("D1 oversized range with blank rows below the data still works", () => {
  expectValue('VLOOKUP("P005",H2:J30,2)', "Docking Station");
  expectValue("VLOOKUP(250,L2:M30,2)", "Silver");
  expectValue("VLOOKUP(5000,L2:M30,2)", "Platinum");
});
test("D1 a text lookup value never matches a numeric column", () => expectError('VLOOKUP("abc",L2:M5,2)', "#N/A"));
test("D2 4th arg 1 → approximate, like TRUE (v1: exact → #N/A)", () =>
  expectValue("VLOOKUP(250,L2:M4,2,1)", "Silver", { dataset: TIER }));
test("D1/D2 approximate search jumps (binary), it doesn't read every row", () => {
  const r = expectValue("VLOOKUP(250,L2:M5,2,TRUE)", "Silver");
  const scans = r.highlights.filter(h => h.role === "scan").length;
  assert(scans < 4, `expected fewer than 4 probes, got ${scans}`);
});

group("Fixed D3 MATCH");
test("D3 match_type omitted → 1 (approximate): 250 → position 2 (v1: #N/A)", () =>
  expectValue("MATCH(250,L2:L4)", 2, { dataset: TIER }));
test("D3 omitted type on a sorted text column", () => expectValue('MATCH("P005",H2:H9)', 5));
test("D3 trailing empty match_type counts as 0, so exact", () => expectError('MATCH("P999",H2:H9,)', "#N/A"));
test("D3 approximate below the smallest value → #N/A", () => expectError("MATCH(-5,L2:L5)", "#N/A"));
test("D3 explicit 0 is still exact", () => expectError("MATCH(250,L2:L5,0)", "#N/A"));

group("Fixed D5 blanks");
test("D5 blank cell is 0 in arithmetic: F2+G2 = 3 (v1: #REF!)", () => expectValue("F2+G2", qty[0]));
test("D5 a blank cell on its own shows 0", () => expectValue("G2", 0));
test('D5 blank = "" and blank = 0 are both TRUE', () => { expectValue('G2=""', "TRUE"); expectValue("G2=0", "TRUE"); });
test("D5 blank is FALSE as an IF test", () => expectValue('IF(G2,"y","n")', "n"));
test("D5 SUM of a blank cell is 0", () => expectValue("SUM(G2)", 0));
test("D5 ROUND of a blank cell is 0", () => expectValue("ROUND(G2,0)", 0));
test("D5 INDEX landing on a blank cell returns 0", () => expectValue("INDEX(G2:G5,1)", 0));
test("D5 blank lookup value → #N/A", () => expectError("VLOOKUP(G2,H2:J9,2,FALSE)", "#N/A"));

group("Fixed D6/D7 #DIV/0!");
test("D6 divide by zero → #DIV/0! (v1: Infinity)", () => expectError("F2/0", "#DIV/0!"));
test("D6 divide by a blank cell → #DIV/0!", () => expectError("F2/G2", "#DIV/0!"));
test("D6 zero divided by something is fine", () => expectValue("0/5", 0));
test("D6 IFERROR catches #DIV/0!", () => expectValue('IFERROR(F2/0,"n/a")', "n/a"));
test("D7 AVERAGE of a range with no numbers → #DIV/0! (v1: NaN)", () => {
  expectError("AVERAGE(A2:A25)", "#DIV/0!");
  expectError("AVERAGE(G2:G9)", "#DIV/0!");
  expectValue("IFERROR(AVERAGE(G2:G9),0)", 0);
});

group("Fixed D8 text-numbers");
// Number stored as text (A1), real number (A2), boolean (A3): the Level 3 cleaning trap.
const TXT = { A1: "15", A2: 5, A3: true, B1: "North", B2: "North", B3: "North" };
test("D8 SUM over a range ignores text '15' and TRUE → 5 (v1: 20)", () => expectValue("SUM(A1:A3)", 5, { dataset: TXT }));
test("D8 COUNT over a range counts only real numbers → 1 (v1: 2)", () => expectValue("COUNT(A1:A3)", 1, { dataset: TXT }));
test("D8 AVERAGE ignores the text number → 5", () => expectValue("AVERAGE(A1:A3)", 5, { dataset: TXT }));
test("D8 COUNTA still counts every non-empty cell", () => expectValue("COUNTA(A1:A3)", 3, { dataset: TXT }));
test("D8 a single cell reference to text is ignored by SUM", () => expectValue("SUM(A1)", 0, { dataset: TXT }));
test("D8 typed-in arguments ARE converted: SUM(\"15\",5)=20, SUM(TRUE,1)=2", () => {
  expectValue('SUM("15",5)', 20, { dataset: TXT });
  expectValue("SUM(TRUE,1)", 2, { dataset: TXT });
});
test('D8 typed-in non-numeric text in SUM → #VALUE!', () => expectError('SUM("abc")', "#VALUE!", { dataset: TXT }));
test("D8 SUMIF / SUMIFS skip text in the sum range → 5", () => {
  expectValue('SUMIF(B1:B3,"North",A1:A3)', 5, { dataset: TXT });
  expectValue('SUMIFS(A1:A3,B1:B3,"North")', 5, { dataset: TXT });
});
test('D8 ">", ">=" criteria don\'t match text numbers', () => {
  expectValue('COUNTIF(A1:A3,">10")', 0, { dataset: TXT });
  expectValue('COUNTIFS(A1:A3,">=5")', 1, { dataset: TXT });
});

group("Fixed D9/D10 ROUND");
test("D9 halves round away from zero: ROUND(-2.5,0) = -3 (v1: -2)", () => expectValue("ROUND(-2.5,0)", -3));
test("D9 ROUND(2.5,0) = 3", () => expectValue("ROUND(2.5,0)", 3));
test("D9 ROUND(-1.005,2) = -1.01", () => expectValue("ROUND(-1.005,2)", -1.01));
test("D9 ROUND(-0.4,0) = 0 (not -0)", () => { const r = expectValue("ROUND(-0.4,0)", 0); assert(!Object.is(r.value, -0), "got -0"); });
test("D10 float-safe: ROUND(1.005,2) = 1.01 (v1: 1)", () => expectValue("ROUND(1.005,2)", 1.01));
test("D10 ROUND(2.345,2)=2.35, ROUND(1.255,2)=1.26, ROUND(0.285,2)=0.29", () => {
  expectValue("ROUND(2.345,2)", 2.35);
  expectValue("ROUND(1.255,2)", 1.26);
  expectValue("ROUND(0.285,2)", 0.29);
});
test("D10 unchanged cases still hold", () => {
  expectValue("ROUND(1234.5678,-2)", 1200);
  expectValue("ROUND(3.14159,2)", 3.14);
  expectValue("ROUND(AVERAGE(F2:F25),2)", 10.04);
});

group("Phase 5: whole columns & header-safe approximate");
test("VLOOKUP over whole columns H:J (exact)", () => expectValue("VLOOKUP(C2,H:J,2,FALSE)", "Webcam", { ref: "I7" }));
test("locked whole columns $H:$J", () => expectValue("VLOOKUP(C2,$H:$J,3,FALSE)", 60));
test("SUM / COUNTIF over a whole column (header text ignored)", () => {
  expectValue("SUM(F:F)", sum(qty)); expectValue('COUNTIF(D:D,"North")', 7); expectValue("COUNTA(A:A)", 25);
});
test("XLOOKUP and INDEX/MATCH with whole columns", () => {
  expectValue('XLOOKUP("P002",H:H,I:I)', "Monitor");
  expectValue('INDEX(H:H,MATCH("Monitor",I:I,0))', "P002");
});
test("approximate match over a whole column with a text header on top", () => {
  // L1 is the header "MinSales"; L2:L5 = 0, 100, 500, 1000
  expectValue("VLOOKUP(5,L:M,2,TRUE)", "Bronze");
  expectValue("VLOOKUP(250,L:M,2)", "Silver");
  expectValue("VLOOKUP(1000,L:M,2)", "Platinum");
  expectValue("VLOOKUP(99999,L:M,2)", "Platinum");
  expectValue("MATCH(250,L:L)", 3); // position within L:L, counting the header row
});
test("approximate match ignores blanks and other types in the middle", () =>
  expectValue("VLOOKUP(60,A1:B6,2,TRUE)", "c", { dataset: { A1: "Min", A2: 0, B2: "a", A3: null, A4: 50, B4: "c", A5: "note", A6: 100, B6: "d" } }));

group("Phase 6: text cleaning");
// Test-only sheet with the kinds of mess a real export has.
const MESS = Object.freeze({ A1: " attica ", A2: "CRETE", A3: "o'brien  smith", A4: "14", A5: " 1,250.5 ", A6: "5%", A7: "abc", A8: "P0O2", A9: 12, A10: "2025-12-12", A11: "  two   spaces  ", A12: "", B1: "x", B3: "y" });
test("TRIM removes spaces at both ends and collapses runs in the middle", () => {
  expectValue("TRIM(A1)", "attica", { dataset: MESS });
  expectValue("TRIM(A11)", "two spaces", { dataset: MESS });
  expectValue('TRIM("  a  b ")', "a b");
});
test("TRIM of a number or a blank gives text", () => { expectValue("TRIM(A9)", "12", { dataset: MESS }); expectValue("TRIM(A99)", "", { dataset: MESS }); });
test("PROPER capitalises each word, lower-cases the rest", () => {
  expectValue("PROPER(A2)", "Crete", { dataset: MESS });
  expectValue("PROPER(A1)", " Attica ", { dataset: MESS });
  expectValue("PROPER(A3)", "O'Brien  Smith", { dataset: MESS });   // Excel: a letter after ' is capitalised
});
test("PROPER capitalises a letter after a digit (Excel's rule), so it can't fix P0O2", () => expectValue("PROPER(A8)", "P0O2", { dataset: MESS }));
test("TRIM(PROPER(…)) standardises a region in one go, and highlights the source cell", () => {
  const r = expectValue("TRIM(PROPER(A1))", "Attica", { dataset: MESS });
  assert(r.highlights.some(h => h.cell === "A1"), "source cell highlighted");
  assert(r.trace.length === 2, "one trace step per function");
});
test("UPPER and LOWER", () => { expectValue("UPPER(A1)", " ATTICA ", { dataset: MESS }); expectValue("LOWER(A2)", "crete", { dataset: MESS }); });
test("VALUE turns number-text into a number", () => {
  expectValue("VALUE(A4)", 14, { dataset: MESS });
  expectValue("VALUE(A5)", 1250.5, { dataset: MESS });
  expectValue("VALUE(A6)", 0.05, { dataset: MESS });
  expectValue("VALUE(A9)", 12, { dataset: MESS });
  expectValue("VALUE(A10)", 46003, { dataset: MESS });               // a date typed as text → its serial
  expectValue("VALUE(A4)*2", 28, { dataset: MESS });
});
test("VALUE of real text is #VALUE!", () => { expectError("VALUE(A7)", "#VALUE!", { dataset: MESS }); expectError('VALUE("")', "#VALUE!"); });
test("a converted number counts in SUM; the text form doesn't", () => {
  expectValue("SUM(A4)", 0, { dataset: MESS });
  expectValue("SUM(A4:A4)+VALUE(A4)", 14, { dataset: MESS });
});
test('criteria "" and "<>" count empty and non-empty cells', () => {
  expectValue('COUNTIF(B1:B4,"")', 2, { dataset: MESS });             // B2, B4 are empty
  expectValue('COUNTIF(B1:B4,"<>")', 2, { dataset: MESS });
  expectValue('COUNTIF(A1:A12,"")', 1, { dataset: MESS });            // A12 holds ""
  expectValue('COUNTIFS(B1:B4,"",A1:A4,"<>")', 2, { dataset: MESS });
});
test("text functions need exactly one argument", () => expectError("TRIM(A1,A2)", "#N/A", { dataset: MESS }));

/* =========================================================================
   9b. KNOWN DIVERGENCES FROM EXCEL (still open, LATER)
   These assert v1's CURRENT behaviour, kept on purpose. Each one differs
   from real Excel. Fixing any of them is a deliberate change: update the
   engine and flip the test in the same commit (see 9a for examples).
   ========================================================================= */
group("Known divergences");
const D = (name, fn) => test(name, fn, { divergence: true });
D("D4 MATCH -1 behaves like 1 (Excel: descending-order match)", () =>
  expectValue("MATCH(250,L2:L4,-1)", 2, { dataset: TIER }));                     // Excel → #N/A on ascending data
D("D11 lowercase cell refs fail (Excel accepts them)", () => {
  expectError("f2", "#NAME?");
  expectError("sum(f2:f25)", "#NAME?");        // function names are case-insensitive, ranges are not
  const r = ev("COUNT(f2:f25)"); assert(!r.ok && r.error.code === null, fmt(r.error)); // internal failure, no Excel code
});
D("D12 IF with no value_if_false fails when the test is FALSE (Excel: FALSE)", () => {
  const r = ev("IF(F2>10,1)"); assert(!r.ok && r.error.code === null, fmt(r.error));
});
D("D13 AVERAGE/COUNT/COUNTA reject single cells and numbers (SUM accepts them)", () => {
  const r = ev("AVERAGE(F2,F3)"); assert(!r.ok && r.error.code === null, fmt(r.error));
});
D("D14 VLOOKUP col_index 0 is #REF! (Excel: #VALUE!)", () => expectError("VLOOKUP(C2,H2:J9,0,FALSE)", "#REF!"));
D("D15 arithmetic on text gives NaN (Excel: #VALUE!)", () => assert(Number.isNaN(ev("D2*2").value), "expected NaN"));
D('D16 number = text-number is TRUE (Excel: 3="3" is FALSE)', () => expectValue('F2="3"', "TRUE"));
D("D17 text > / < comparisons are always FALSE (Excel compares alphabetically)", () => expectValue('"b">"a"', "FALSE"));
D("D18 lookup value, IFERROR fallback, col_index and criteria cannot be formulas", () => {
  expectError('IFERROR(FOO(1),VLOOKUP("P001",H2:J9,2,FALSE))', "#NAME?");       // Excel → "Laptop"
  expectError('VLOOKUP(C2,H2:J9,MATCH("ProductName",H1:J1,0),FALSE)', "#NAME?");
});
D("D19 XLOOKUP/MATCH read only the first column (horizontal ranges don't work)", () =>
  expectError('MATCH("UnitPrice",H1:J1,0)', "#N/A"));                            // Excel → 3
D("D20 unary minus on a cell ref fails (Excel: -F2 = -3)", () => expectError("-F2", "#NAME?"));
D("D21 COUNTIF wildcards aren't supported (Excel: * and ? match)", () =>
  expectValue('COUNTIF(D2:D25,"N*")', 0));                                        // Excel → 7
D('D22 exact lookups match a number to its text form (Excel: 3 vs "3" is #N/A)', () =>
  expectValue('VLOOKUP(3,A1:B1,2,FALSE)', "found", { dataset: { A1: "3", B1: "found" } }));  // Excel → #N/A

/* =========================================================================
   9c. v1 CONSOLE EXAMPLES: every formula the v1 app shipped as a click-to-run
   chip or an inline example. These are carried into Phase 3 content.
   FIX: the v1 chip 'SUMIFS(F2:F25,D2:D25,"East",C2:C25,"P002")' ("East +
   Monitor only") returned 0 because there are no East orders for P002. It is
   replaced by "North + Monitor only", which has two matching orders.
   ========================================================================= */
group("v1 examples");
const V1_EXAMPLES = [
  // Stage 1 · Basics
  ["SUM(F2:F25)", sum(qty)],
  ["AVERAGE(F2:F25)", sum(qty) / qty.length],
  ["COUNT(F2:F25)", qty.length],
  ["COUNTA(A2:A25)", ORDERS.length],
  ["ROUND(AVERAGE(F2:F25),1)", 10],                                          // 241/24 = 10.04… → 10.0
  // Stage 2 · Logic
  ['IF(F2>10,"HIGH","OK")', ORDERS[0][5] > 10 ? "HIGH" : "OK"],
  ['SUMIFS(F2:F25,D2:D25,"North")', sum(where(o => o[3] === "North").map(o => o[5]))],
  ['SUMIFS(F2:F25, D2:D25, "North")', sum(where(o => o[3] === "North").map(o => o[5]))],   // spaced, as in the v1 lesson text
  ['SUMIFS(F2:F25,D2:D25,"North",C2:C25,"P002")', sum(where(o => o[3] === "North" && o[2] === "P002").map(o => o[5]))], // FIXED chip
  ['COUNTIFS(D2:D25,"South")', where(o => o[3] === "South").length],
  ['COUNTIFS(F2:F25,">=15")', qty.filter(q => q >= 15).length],
  ['IFERROR(VLOOKUP("P999",H2:J9,2,FALSE),"Not found")', "Not found"],
  // Stage 3 · Lookups
  ["VLOOKUP(C2,H2:J9,2,FALSE)", name(ORDERS[0][2])],
  ["VLOOKUP(C2,$H$2:$J$9,3,FALSE)", price(ORDERS[0][2])],
  ['XLOOKUP("P002",H2:H9,I2:I9)', name("P002")],
  ["INDEX(H2:H9,MATCH(190,J2:J9,0))", PRODUCTS.find(p => p[2] === 190)[0]],
  ["INDEX(H2:H9, MATCH(190, J2:J9, 0))", PRODUCTS.find(p => p[2] === 190)[0]],             // spaced, as in the v1 lesson text
  ["F2*VLOOKUP(C2,H2:J9,3,FALSE)", ORDERS[0][5] * price(ORDERS[0][2])],
];
V1_EXAMPLES.forEach(([f, want]) => test(`${f} → ${fmt(want)}`, () => expectValue(f, want)));
test("FIX: the replacement 'North + Monitor only' chip is non-zero (26)", () => {
  const r = expectValue('SUMIFS(F2:F25,D2:D25,"North",C2:C25,"P002")', 26);
  assert(r.value > 0, "must not be zero");
});
test("why the old 'East + Monitor only' chip was replaced: no East × P002 orders exist", () => {
  assert(where(o => o[3] === "East" && o[2] === "P002").length === 0, "data changed; re-check the chip");
  expectValue('SUMIFS(F2:F25,D2:D25,"East",C2:C25,"P002")', 0);
});

/* =========================================================================
   10. COVERAGE GUARD: each engine function appears in a passing test
   ========================================================================= */
group("Coverage");
test("every function in FUNCTIONS is exercised by a passing (non-divergence) test", () => {
  const passing = results.filter(r => r.ok && !r.divergence).flatMap(r => r.formulas).map(f => f.toUpperCase());
  const missing = FUNCTIONS.filter(fn => !passing.some(f => new RegExp(`\\b${fn}\\(`).test(f)));
  assert(missing.length === 0, `not covered: ${missing.join(", ")}`);
});

/* ---------- report ---------- */
const groups = [...new Set(results.map(r => r.group))];
const lines = [];
for (const g of groups) {
  const rs = results.filter(r => r.group === g);
  const pass = rs.filter(r => r.ok).length;
  lines.push(`${pass === rs.length ? "✓" : "✗"} ${g.padEnd(20)} ${pass}/${rs.length}`);
  rs.filter(r => !r.ok).forEach(r => lines.push(`    ✗ ${r.name}\n      ${r.err}`));
}
const failed = results.filter(r => !r.ok);
const nDiv = results.filter(r => r.divergence).length;
const nFormulas = results.reduce((n, r) => n + r.formulas.length, 0);
lines.push("");
lines.push(`${results.length - failed.length}/${results.length} tests passed · ${nFormulas} formula evaluations · ${nDiv} known divergences pinned · source DOM check: ${SOURCE_CHECKED}`);
lines.push(failed.length ? `FAIL (${failed.length})` : "ALL GREEN");
console.log(lines.join("\n"));

export const summary = { total: results.length, failed: failed.length, results };
if (IN_NODE && failed.length) process.exitCode = 1;
