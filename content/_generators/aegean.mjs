/* =========================================================================
   Aegean Supplies dataset generator (spec §6)
   -------------------------------------------------------------------------
   Run:  node content/_generators/aegean.mjs
   Writes js/data/aegean.generated.js (a plain ES module, so the browser can
   import it with no build step). Same seed → byte-for-byte same output.

   Aegean Supplies: a B2B office-equipment distributor in Greece, 2025.
     Orders    180 rows: OrderID, Date (Excel date serial), ProductID, Region,
               Rep (name), Channel, Quantity, Discount (decimal, e.g. 0.05)
     Products  14 rows: ProductID, ProductName, Category, UnitCost, ListPrice
     Reps      7 rows:  RepID, RepName, Region, HireDate (date serial), Target (€ revenue)
     Tiers     4 rows:  MinQty, Band, Discount. Sorted ascending, for approximate match
     Messy     a copy of Orders with seeded, documented defects (Level 3)

   Rules the data guarantees (checked in js/data.test.js):
     • Discount on every order = its quantity's tier, i.e. VLOOKUP(Quantity, Tiers, 3, TRUE)
     • Region on every order = its rep's home region
     • Quantities of exactly 10, 25 and 50 exist, so tier boundaries (and > vs >=) matter
     • Exactly one order uses P015, a new product not yet in the price list
       (a realistic #N/A for lookup + IFERROR practice)
     • Derived fields are never stored: Revenue = Quantity × ListPrice × (1 − Discount),
       Margin = Revenue − Quantity × UnitCost
   ========================================================================= */
import { writeFileSync, mkdirSync, readFileSync } from "node:fs";

const SEED = 20250101;
function mulberry32(a) { return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const rnd = mulberry32(SEED);
const pick = arr => arr[Math.floor(rnd() * arr.length)];
const weighted = pairs => { const total = pairs.reduce((s, [, w]) => s + w, 0); let r = rnd() * total; for (const [v, w] of pairs) { if ((r -= w) < 0) return v; } return pairs.at(-1)[0]; };
const int = (lo, hi) => lo + Math.floor(rnd() * (hi - lo + 1));

/** Excel date serial (days since 1899-12-30), so dates behave like numbers, exactly as in Excel. */
export const serial = (y, m, d) => (Date.UTC(y, m - 1, d) - Date.UTC(1899, 11, 30)) / 86400000;

const PRODUCTS = [
  ["P001", "Laptop Pro 14", "Computers", 980, 1299],
  ["P002", "Monitor 27in", "Computers", 175, 249],
  ["P003", "Mechanical Keyboard", "Peripherals", 48, 89],
  ["P004", "Wireless Mouse", "Peripherals", 14, 29],
  ["P005", "Docking Station", "Peripherals", 95, 159],
  ["P006", "Webcam HD", "Peripherals", 38, 69],
  ["P007", "Headset Pro", "Peripherals", 72, 129],
  ["P008", "USB-C Hub", "Peripherals", 18, 39],
  ["P009", "Ergonomic Chair", "Furniture", 160, 329],
  ["P010", "Standing Desk", "Furniture", 290, 549],
  ["P011", "Laser Printer", "Printing", 210, 299],
  ["P012", "Toner Cartridge", "Printing", 34, 79],
  ["P013", "A4 Paper Box", "Printing", 19, 32],
  ["P014", "LED Desk Lamp", "Furniture", 21, 45],
];
const TIERS = [[1, "Standard", 0], [10, "Bulk", 0.05], [25, "Trade", 0.1], [50, "Wholesale", 0.15]];
const tierOf = q => [...TIERS].reverse().find(t => q >= t[0]);

// [id, name, region, hireDate, targetFactor]. Targets are set from each rep's actual 2025 revenue × factor,
// so the story is designed: some reps beat their target and some miss it.
const REPS = [
  ["R01", "Eleni Makri", "Attica", serial(2019, 3, 4), 0.9],
  ["R02", "Nikos Petrou", "Attica", serial(2021, 9, 13), 1.2],
  ["R03", "Maria Ioannou", "Macedonia", serial(2018, 5, 21), 0.95],
  ["R04", "Giorgos Nikolaou", "Macedonia", serial(2023, 1, 16), 1.1],
  ["R05", "Dimitra Georgiou", "Crete", serial(2020, 11, 2), 0.85],
  ["R06", "Kostas Alexiou", "Thessaly", serial(2022, 6, 6), 1.3],
  ["R07", "Sofia Papadaki", "Peloponnese", serial(2017, 2, 27), 0.92],
];
const REP_WEIGHTS = [["R01", 16], ["R02", 12], ["R03", 15], ["R04", 11], ["R05", 13], ["R06", 9], ["R07", 12]];
const PRODUCT_WEIGHTS = [["P001", 9], ["P002", 12], ["P003", 10], ["P004", 14], ["P005", 8], ["P006", 8], ["P007", 9], ["P008", 10],
                         ["P009", 7], ["P010", 5], ["P011", 4], ["P012", 9], ["P013", 9], ["P014", 5]];
const QTY = { P001: [1, 12], P002: [1, 20], P009: [1, 14], P010: [1, 8], P011: [1, 6], P014: [1, 18], P012: [5, 60], P013: [10, 80] };
const qtyFor = pid => {
  const [lo, hi] = QTY[pid] || [1, 40];
  if (!QTY[pid] && rnd() < 0.08) return int(50, 60);            // the odd wholesale order of accessories
  return int(lo, hi);
};
const CHANNELS = [["Online", 45], ["Field", 35], ["Partner", 20]];
const MONTH_WEIGHTS = [["1", 7], ["2", 7], ["3", 9], ["4", 8], ["5", 8], ["6", 8], ["7", 7], ["8", 5], ["9", 9], ["10", 10], ["11", 11], ["12", 11]];
const DAYS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

// ---------- orders ----------
const raw = [];
for (let i = 0; i < 180; i++) {
  const m = Number(weighted(MONTH_WEIGHTS));
  let d = int(1, DAYS[m - 1]);
  let dt = new Date(Date.UTC(2025, m - 1, d));
  while (dt.getUTCDay() === 0 || dt.getUTCDay() === 6) { d = d > 2 ? d - 1 : d + 2; dt = new Date(Date.UTC(2025, m - 1, d)); } // weekdays only
  const repId = weighted(REP_WEIGHTS), rep = REPS.find(r => r[0] === repId);
  const pid = weighted(PRODUCT_WEIGHTS);
  raw.push({ date: serial(2025, m, d), pid, rep: rep[1], region: rep[2], channel: weighted(CHANNELS), qty: qtyFor(pid) });
}
raw.sort((a, b) => a.date - b.date || a.rep.localeCompare(b.rep));
// Guarantee the teaching boundaries exist: quantities of exactly 10, 25 and 50 on accessory orders.
const accessoryRows = raw.map((o, i) => (!QTY[o.pid] ? i : -1)).filter(i => i >= 0);
[[10, 3], [25, 2], [50, 1]].forEach(([q, n]) => { for (let k = 0; k < n; k++) raw[accessoryRows[(q * 7 + k * 31) % accessoryRows.length]].qty = q; });
// One order for a new product that isn't in the price list yet (row ~ November).
const newIdx = raw.findIndex(o => o.date >= serial(2025, 11, 10));
raw[newIdx].pid = "P015"; raw[newIdx].qty = 6;

const ORDERS = raw.map((o, i) => {
  const disc = tierOf(o.qty)[2];
  return [`O${1001 + i}`, o.date, o.pid, o.region, o.rep, o.channel, o.qty, disc];
});

// ---------- rep targets from actual revenue ----------
const price = pid => PRODUCTS.find(p => p[0] === pid)?.[4];
const revenue = o => (price(o[2]) ? o[6] * price(o[2]) * (1 - o[7]) : 0);
const REPS_OUT = REPS.map(([id, name, region, hire, factor]) => {
  const rev = ORDERS.filter(o => o[4] === name).reduce((s, o) => s + revenue(o), 0);
  return [id, name, region, hire, Math.round((rev * factor) / 5000) * 5000];
});

// ---------- messy copy with documented defects (spec §6) ----------
const messy = ORDERS.map(r => [...r]);
const at = id => messy.findIndex(r => r[0] === id);
const defects = [];
function defect(id, kind, orderId, field, label, apply) {
  const i = at(orderId); const before = messy[i].slice();
  apply(i);
  defects.push({ id, kind, orderId, field, label, bad: field ? messy[i][FIELDS.indexOf(field)] : null, good: field ? before[FIELDS.indexOf(field)] : null });
}
const FIELDS = ["OrderID", "Date", "ProductID", "Region", "Rep", "Channel", "Quantity", "Discount"];
defect("dup-o1034", "duplicate", "O1034", null, "O1034 appears twice (exact duplicate row)", i => messy.splice(i + 1, 0, messy[i].slice()));
defect("dup-o1121", "duplicate", "O1121", null, "O1121 appears twice (exact duplicate row)", i => messy.splice(i + 1, 0, messy[i].slice()));
defect("blank-region-o1057", "blank", "O1057", "Region", "O1057 has a blank Region", i => { messy[i][3] = ""; });
defect("blank-region-o1098", "blank", "O1098", "Region", "O1098 has a blank Region", i => { messy[i][3] = ""; });
defect("spaces-o1012", "text-standardise", "O1012", "Region", "O1012 Region has stray spaces and lower case", i => { messy[i][3] = ` ${messy[i][3].toLowerCase()} `; });
defect("caps-o1076", "text-standardise", "O1076", "Region", "O1076 Region is in capitals", i => { messy[i][3] = messy[i][3].toUpperCase(); });
defect("lower-o1140", "text-standardise", "O1140", "Region", "O1140 Region is in lower case", i => { messy[i][3] = messy[i][3].toLowerCase(); });
defect("text-qty-o1045", "number-as-text", "O1045", "Quantity", "O1045 Quantity is stored as text", i => { messy[i][6] = String(messy[i][6]); });
defect("text-qty-o1150", "number-as-text", "O1150", "Quantity", "O1150 Quantity is stored as text", i => { messy[i][6] = String(messy[i][6]); });
defect("typo-product-o1088", "misspelling", "O1088", "ProductID", "O1088 ProductID has a letter O instead of a zero", i => { messy[i][2] = messy[i][2].replace(/0(?=\d$)/, "O"); });
defect("future-date-o1170", "future-date", "O1170", "Date", "O1170 is dated 2026: a typo for 2025", i => { messy[i][1] += serial(2026, 1, 1) - serial(2025, 1, 1); });

const out = {
  seed: SEED,
  note: "GENERATED by content/_generators/aegean.mjs. Do not edit by hand: change the generator and re-run it.",
  products: PRODUCTS, reps: REPS_OUT, tiers: TIERS, orders: ORDERS,
  messy: { orders: messy, defects },
};
const path = new URL("../../js/data/aegean.generated.js", import.meta.url);
const text = `// GENERATED by content/_generators/aegean.mjs (seed ${SEED}). Do not edit by hand.\n// Re-generate with: node content/_generators/aegean.mjs\nexport default ${JSON.stringify(out)};\n`;
if (process.argv.includes("--check")) {
  // Used by `npm test`: the shipped file must be exactly what the generator produces.
  let current = ""; try { current = readFileSync(path, "utf8"); } catch {}
  if (current !== text) { console.error("✗ js/data/aegean.generated.js is out of date or was edited by hand. Re-run: node content/_generators/aegean.mjs"); process.exit(1); }
  console.log("✓ aegean.generated.js matches its generator (reproducible)");
} else {
  mkdirSync(new URL("../../js/data/", import.meta.url), { recursive: true });
  writeFileSync(path, text);
  console.log(`wrote ${path.pathname}: ${ORDERS.length} orders, ${PRODUCTS.length} products, ${REPS_OUT.length} reps, ${defects.length} messy defects`);
}
