/* data.test.js: the Aegean dataset meets spec §6 and its own documented guarantees.
   Run with `node js/data.test.js`. Checks use plain JS over the raw generated tables. */
import { AEGEAN, AEGEAN_MESSY, AEGEAN_TABLES, serialToISO, formatAs, formatOf, DATASETS } from "./data.js";
import { evaluate } from "./engine.js";
import { createSuite, eq, assert } from "./testkit.js";

const s = createSuite("data (Aegean)");
const { orders, products, reps, tiers } = AEGEAN.raw;
const col = { id: 0, date: 1, product: 2, region: 3, rep: 4, channel: 5, qty: 6, disc: 7 };
const iso = o => serialToISO(o[col.date]);

s.group("spec §6 shape");
s.test("150–200 order rows", () => assert(orders.length >= 150 && orders.length <= 200, `${orders.length}`));
s.test("order columns: OrderID, Date, ProductID, Region, Rep, Channel, Quantity, Discount", () =>
  eq(AEGEAN_TABLES.orders.header, ["OrderID", "Date", "ProductID", "Region", "Rep", "Channel", "Quantity", "Discount"]));
s.test("dates are real date values (Excel serial numbers) spanning all 12 months of 2025", () => {
  assert(orders.every(o => Number.isInteger(o[col.date])), "integers");
  eq([...new Set(orders.map(o => iso(o).slice(0, 7)))].length, 12);
  assert(orders.every(o => iso(o).startsWith("2025-")), "all in 2025");
});
s.test("dates are sorted and every order falls on a weekday", () => {
  assert(orders.every((o, i) => i === 0 || o[col.date] >= orders[i - 1][col.date]), "sorted");
  assert(orders.every(o => { const d = new Date(iso(o)).getUTCDay(); return d > 0 && d < 6; }), "weekdays");
});
s.test("4–5 regions, 6–8 reps, 3 channels", () => {
  const n = k => new Set(orders.map(o => o[k])).size;
  assert(n(col.region) >= 4 && n(col.region) <= 5, `${n(col.region)} regions`);
  assert(n(col.rep) >= 6 && n(col.rep) <= 8, `${n(col.rep)} reps`);
  eq([...new Set(orders.map(o => o[col.channel]))].sort(), ["Field", "Online", "Partner"]);
});
s.test("OrderIDs are unique and sequential", () => eq(orders.map(o => o[col.id]), orders.map((_, i) => `O${1001 + i}`)));
s.test("products: ID, Name, Category, UnitCost, ListPrice; IDs unique and sorted; cost < price", () => {
  eq(AEGEAN_TABLES.products.header, ["ProductID", "ProductName", "Category", "UnitCost", "ListPrice"]);
  assert(products.every((p, i) => i === 0 || p[0] > products[i - 1][0]), "sorted IDs");
  assert(products.every(p => p[3] > 0 && p[3] < p[4]), "cost below price");
});
s.test("reps: RepID, RepName, Region, HireDate, Target", () => {
  eq(AEGEAN_TABLES.reps.header, ["RepID", "RepName", "Region", "HireDate", "Target"]);
  assert(reps.every(r => r[4] > 0 && Number.isInteger(r[3])), "targets and hire dates");
});

s.group("documented guarantees");
const tierFor = q => [...tiers].reverse().find(t => q >= t[0]);
s.test("tiers are sorted ascending (approximate match needs this)", () => assert(tiers.every((t, i) => i === 0 || t[0] > tiers[i - 1][0]), "sorted"));
s.test("every order's discount is its quantity's tier", () => assert(orders.every(o => o[col.disc] === tierFor(o[col.qty])[2]), "discount = tier"));
s.test("every order's region is its rep's home region", () => assert(orders.every(o => reps.find(r => r[1] === o[col.rep])[2] === o[col.region]), "region = rep's"));
s.test("quantities of exactly 10, 25 and 50 exist (boundaries matter)", () => [10, 25, 50].forEach(q => assert(orders.some(o => o[col.qty] === q), `no order of ${q}`)));
s.test("exactly one order uses P015, which is NOT in the price list", () => {
  eq(orders.filter(o => o[col.product] === "P015").length, 1);
  assert(!products.some(p => p[0] === "P015"), "P015 must be missing from Products");
  assert(orders.filter(o => o[col.product] !== "P015").every(o => products.some(p => p[0] === o[col.product])), "every other ID exists");
});
s.test("the rep targets make a story: some reps beat their target, some miss it", () => {
  const rev = name => orders.filter(o => o[col.rep] === name).reduce((t, o) => { const p = products.find(x => x[0] === o[col.product]); return t + (p ? o[col.qty] * p[4] * (1 - o[col.disc]) : 0); }, 0);
  const met = reps.map(r => rev(r[1]) >= r[4]);
  assert(met.includes(true) && met.includes(false), JSON.stringify(met));
});

s.group("sheet layout");
s.test("tables sit at A:H, J:N, P:T, V:X with one empty gap column between", () => {
  const c = AEGEAN.cells;
  eq([c.A1, c.H1, c.J1, c.N1, c.P1, c.T1, c.V1, c.X1], ["OrderID", "Discount", "ProductID", "ListPrice", "RepID", "Target", "MinQty", "Discount"]);
  assert(!("I1" in c) && !("O1" in c) && !("U1" in c), "gap columns empty");
});
s.test("the engine reads it: COUNT(B:B) counts dates as numbers; SUM of quantities; lookups work", () => {
  eq(evaluate("COUNT(B2:B181)", AEGEAN.cells).value, orders.length);
  eq(evaluate(`SUM(G2:G${AEGEAN.lastOrderRow})`, AEGEAN.cells).value, orders.reduce((t, o) => t + o[col.qty], 0));
  eq(evaluate('VLOOKUP("P005",$J$2:$N$15,2,FALSE)', AEGEAN.cells).value, products[4][1]);
  eq(evaluate("VLOOKUP(25,$V$2:$X$5,2,TRUE)", AEGEAN.cells).value, "Trade");
});
s.test("display formats: dates and percentages", () => {
  eq(formatAs(AEGEAN.cells.B2, "date"), iso(orders[0])); eq(formatAs(0.05, "percent"), "5%");
  eq([formatOf(AEGEAN, "B7"), formatOf(AEGEAN, "H3"), formatOf(AEGEAN, "G3")], ["date", "percent", null]);
});
s.test("registered by id", () => assert(DATASETS.aegean === AEGEAN && DATASETS["aegean-messy"] === AEGEAN_MESSY, "registry"));

s.group("messy copy (Level 3)");
const messy = AEGEAN.raw.messy.orders, defects = AEGEAN_MESSY.defects;
s.test("every defect is documented with a label, and the kinds cover spec §6", () => {
  assert(defects.every(d => d.id && d.label && d.kind), "documented");
  const kinds = new Set(defects.map(d => d.kind));
  ["duplicate", "blank", "text-standardise", "number-as-text", "misspelling", "future-date"].forEach(k => assert(kinds.has(k), `missing ${k}`));
});
s.test("each documented defect is really in the messy data", () => {
  for (const d of defects) {
    const rowsFor = messy.filter(r => r[0] === d.orderId);
    if (d.kind === "duplicate") { eq(rowsFor.length, 2, d.id); continue; }
    const f = { Region: 3, Quantity: 6, ProductID: 2, Date: 1 }[d.field];
    eq(rowsFor[0][f], d.bad, d.id);
    eq(orders.find(o => o[0] === d.orderId)[f], d.good, `${d.id} good value`);
  }
});
s.test("apart from the documented defects, the messy copy equals the clean orders", () => {
  const touched = new Set(defects.map(d => d.orderId));
  const dedup = messy.filter((r, i) => !(i > 0 && JSON.stringify(r) === JSON.stringify(messy[i - 1])));
  eq(dedup.length, orders.length);
  dedup.forEach((r, i) => { if (!touched.has(r[0])) eq(r, orders[i], r[0]); });
});
s.test("messy dataset range covers the extra duplicate rows and the reference tables", () => eq(AEGEAN_MESSY.range, `A1:X${messy.length + 1}`));
s.test("messy sheet: the export in A:H, the clean reference tables unchanged in J:X", () => {
  eq(AEGEAN_MESSY.cells.A35, AEGEAN_MESSY.cells.A36, "duplicate O1034 sits on rows 35 and 36");
  for (const k of Object.keys(AEGEAN.cells).filter(k => /^[J-X]\d+$/.test(k))) eq(AEGEAN_MESSY.cells[k], AEGEAN.cells[k], k);
  eq(AEGEAN_MESSY.orders.rows, messy);
});

s.report();
