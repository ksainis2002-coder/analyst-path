/* =========================================================================
   content.test.js: "no wrong answers ship" (spec §5.4, §12)
   Run with `node js/content.test.js`.

   For every lesson and gate listed in content/curriculum.json:
     1. the JSON matches the schema (the same validator the app uses)
     2. every drill/task solution really passes its answerCheck
     3. every expected value equals an INDEPENDENT oracle: plain JS over the
        raw generated tables (js/data/aegean.generated.js), never the engine
     4. worked examples evaluate to their stated `expect`
     5. quiz questions with `verify` have the engine's value as the marked option
     6. common wrong answers (the traps each lesson teaches) FAIL
     7. every {{=…}} number in prose evaluates, and every formula shown in
        prose runs (Phase 5 QA)
     8. every drill and task has an oracle, so nothing new ships unchecked
     9. Level 3 (workbench): every solution — cleaning moves, pivot layout,
        chart + sentence — really passes; every pivot figure and sentence
        answer equals an independent oracle; the traps fail; prose facts hold
   ========================================================================= */
import { readFileSync, readdirSync } from "node:fs";
import { validateLesson, validateGate, validateKey, validateCase, drillTaskId, findTemplates, templateValue } from "./content.js";
import { grade } from "./grader.js";
import { gradeAssignment, keyWorkspace } from "./ui/assignment.js";
import { workbenchSubmission } from "./ui/workbench.js";
import { deriveRows, computePivot, pivotState } from "./ui/pivot.js";
import { replay, cellsOf } from "./ui/cleaning.js";
import { evaluate } from "./engine.js";
import { DATASETS } from "./data.js";
import RAW from "./data/aegean.generated.js";
import { createSuite, eq, assert } from "./testkit.js";

const root = new URL("../content/", import.meta.url);
const readJSON = p => JSON.parse(readFileSync(new URL(p, root), "utf8"));
const curriculum = readJSON("curriculum.json");
const s = createSuite("content");

/* ---------- independent oracle over the raw Aegean tables ---------- */
const O = RAW.orders, PROD = RAW.products, REPS = RAW.reps, TIERS = RAW.tiers;
const o = { id: 0, date: 1, product: 2, region: 3, rep: 4, channel: 5, qty: 6, disc: 7 };
const byRow = r => O[r - 2];                                    // sheet row → order
const byId = id => O.find(x => x[o.id] === id);
const at = (id, row) => { const x = byRow(row); assert(x[o.id] === id, `row ${row} should be ${id}, is ${x[o.id]}`); return x; };
const prod = pid => PROD.find(p => p[0] === pid);
const rep = name => REPS.find(r => r[1] === name);
const sum = a => a.reduce((x, y) => x + y, 0);
const rows = pred => O.filter(pred);
const qtys = pred => rows(pred).map(x => x[o.qty]);
const allQty = O.map(x => x[o.qty]);
const round = (v, d) => Math.round((v + Number.EPSILON) * 10 ** d) / 10 ** d; // positive values only
const band = q => [...TIERS].reverse().find(t => q >= t[0]);
const revenue = x => x[o.qty] * prod(x[o.product])[4] * (1 - x[o.disc]);
const margin = x => revenue(x) - x[o.qty] * prod(x[o.product])[3];
const needs = (cond, why) => { assert(cond, why); };

const ORACLE = {
  // ---- Level 0
  "l0-cells-ranges:read-a-cell": () => at("O1001", 2)[o.qty],
  "l0-cells-ranges:product-name": () => PROD[7 - 2][1],
  "l0-cells-ranges:add-two": () => byRow(2)[o.qty] + byRow(3)[o.qty],
  "l0-cells-ranges:sum-range": () => sum([2, 3, 4, 5, 6].map(r => byRow(r)[o.qty])),
  "l0-formulas-values:order-value": () => { const x = at("O1005", 6); needs(x[o.product] === "P001", "O1005 must be a Laptop order"); return x[o.qty] * prod("P001")[4]; },
  "l0-formulas-values:brackets": () => (byRow(2)[o.qty] + byRow(3)[o.qty]) * 2,
  "l0-formulas-values:difference": () => at("O1011", 12)[o.qty] - at("O1007", 8)[o.qty],
  "l0-formulas-values:after-discount": () => { const x = at("O1001", 2); needs(x[o.product] === "P001", "O1001 must be a Laptop order"); return x[o.qty] * prod("P001")[4] * (1 - x[o.disc]); },
  "l0-absolute-refs:lock-price": () => at("O1011", 12)[o.qty] * prod("P001")[4],
  "l0-absolute-refs:lock-price-2": () => at("O1128", 129)[o.qty] * prod("P001")[4],
  "l0-absolute-refs:lock-range": () => sum(allQty),
  // ---- Level 1
  "l1-daily-four:total-qty": () => sum(allQty),
  "l1-daily-four:count-orders": () => O.length,
  "l1-daily-four:avg-qty": () => round(sum(allQty) / O.length, 2),
  "l1-daily-four:count-numbers": () => PROD.length * 2,               // UnitCost + ListPrice columns
  "l1-daily-four:count-dates": () => O.length,
  "l1-daily-four:first-ten": () => sum(O.slice(0, 10).map(x => x[o.qty])),
  "l1-if:label-row8": () => (at("O1007", 8)[o.qty] > 10 ? "HIGH" : "OK"),
  "l1-if:is-attica": () => (at("O1005", 6)[o.region] === "Attica" ? "Yes" : "No"),
  "l1-if:at-least-15": () => { const q = at("O1004", 5)[o.qty]; needs(q === 15, "O1004 must be exactly 15 so > vs >= matters"); return q >= 15 ? q * 2 : 0; },
  "l1-if:not-online": () => (at("O1003", 4)[o.channel] !== "Online" ? "Other" : "Online"),
  "l1-sumif-sumifs:crete-sumif": () => sum(qtys(x => x[o.region] === "Crete")),
  "l1-sumif-sumifs:crete-sumifs": () => sum(qtys(x => x[o.region] === "Crete")),
  "l1-sumif-sumifs:makri-online": () => sum(qtys(x => x[o.rep] === "Eleni Makri" && x[o.channel] === "Online")),
  "l1-sumif-sumifs:mouse-macedonia": () => sum(qtys(x => x[o.product] === "P004" && x[o.region] === "Macedonia")),
  "l1-sumif-sumifs:attica-big": () => { needs(rows(x => x[o.region] === "Attica" && x[o.qty] === 25).length, "needs an Attica order of exactly 25"); return sum(qtys(x => x[o.region] === "Attica" && x[o.qty] >= 25)); },
  "l1-countif-countifs:thessaly-count": () => rows(x => x[o.region] === "Thessaly").length,
  "l1-countif-countifs:under-5": () => rows(x => x[o.qty] < 5).length,
  "l1-countif-countifs:attica-partner": () => rows(x => x[o.region] === "Attica" && x[o.channel] === "Partner").length,
  "l1-countif-countifs:makri-10": () => { needs(rows(x => x[o.rep] === "Eleni Makri" && x[o.qty] === 10).length, "needs a Makri order of exactly 10"); return rows(x => x[o.rep] === "Eleni Makri" && x[o.qty] >= 10).length; },
  "l1-countif-countifs:same-region": () => rows(x => x[o.region] === O[0][o.region]).length,
  "l1-iferror:epirus-zero": () => { needs(!rows(x => x[o.region] === "Epirus").length, "Epirus must have no orders"); return 0; },
  "l1-iferror:no-orders-text": () => "No orders",
  "l1-iferror:thessaly-avg": () => round(sum(qtys(x => x[o.region] === "Thessaly")) / rows(x => x[o.region] === "Thessaly").length, 2),
  // ---- Level 2
  "l2-vlookup:name-row2": () => prod(at("O1001", 2)[o.product])[1],
  "l2-vlookup:price-row3": () => prod(at("O1002", 3)[o.product])[4],
  "l2-vlookup:category-p009": () => prod("P009")[2],
  "l2-vlookup:cost-row12": () => prod(at("O1011", 12)[o.product])[3],
  "l2-vlookup:rep-target": () => REPS.find(r => r[0] === "R07")[4],
  "l2-exact-approx:band-row12": () => band(at("O1011", 12)[o.qty])[1],
  "l2-exact-approx:band-boundary": () => { const q = at("O1015", 16)[o.qty]; needs(q === 25, "O1015 must be exactly 25 (a boundary)"); return band(q)[1]; },
  "l2-exact-approx:tier-discount": () => band(at("O1004", 5)[o.qty])[2],
  "l2-exact-approx:missing-id": () => { needs(!prod("P016"), "P016 must not exist"); return "Not found"; },
  "l2-xlookup:xl-price": () => prod(at("O1003", 4)[o.product])[4],
  "l2-xlookup:xl-left": () => PROD.find(p => p[1] === "LED Desk Lamp")[0],
  "l2-xlookup:xl-not-found": () => { needs(!prod(at("O1141", 142)[o.product]), "O1141's product must be missing from the price list"); return "Not in price list"; },
  "l2-xlookup:xl-rep-id": () => rep(at("O1001", 2)[o.rep])[0],
  "l2-index-match:match-pos": () => PROD.findIndex(p => p[0] === "P010") + 1,
  "l2-index-match:reverse-rep": () => rep("Maria Ioannou")[0],
  "l2-index-match:row-rep-id": () => rep(at("O1003", 4)[o.rep])[0],
  "l2-index-match:index-2d": () => prod("P012")[3],
  "l2-index-match:hire-date": () => rep("Kostas Alexiou")[3],
  "l2-lookup-math:rev-row3": () => revenue(at("O1002", 3)),
  "l2-lookup-math:rev-discount": () => { const x = at("O1016", 17); needs(x[o.disc] > 0, "O1016 must have a discount"); return revenue(x); },
  "l2-lookup-math:margin-row2": () => margin(at("O1001", 2)),
  "l2-lookup-math:rev-missing": () => { needs(!prod(at("O1141", 142)[o.product]), "O1141's product must be missing"); return 0; },
  // ---- Level 3 (formula bar in the cleaning lab, on the messy export)
  "l3-duplicates-blanks:count-dup": () => RAW.messy.orders.filter(x => x[o.id] === "O1121").length,
  "l3-duplicates-blanks:count-blank": () => RAW.messy.orders.filter(x => x[o.region] === "").length,
  "l3-standardise:test-standardise": () => { const v = RAW.messy.orders[78 - 2][o.region]; needs(RAW.messy.orders[78 - 2][o.id] === "O1076" && v === "CRETE", "row 78 must be O1076, CRETE"); return "Crete"; },
};

/* Wrong answers that MUST fail: the traps each lesson teaches. */
const MUST_FAIL = {
  "l0-cells-ranges:sum-range": ["=SUM(G2,G6)", "=62", "=G2+G3+G4+G5+G6"],                          // comma not colon · typed · no SUM
  "l0-formulas-values:brackets": ["=G2+G3*2", "=44"],                                                // precedence · typed
  "l0-formulas-values:after-discount": ["=G2*N2*1-H2", "=G2*N2*H2", "=G2*N2"],                        // missing brackets · kept only the discount · no discount
  "l0-absolute-refs:lock-price": ["=G12*N2", "=G12*$N2", "=G12*N$2", "=31176"],                      // not locked · half-locked · typed
  "l0-absolute-refs:lock-range": ["=SUM(G2:G181)", "=SUM($G$2:G181)"],
  "l1-daily-four:count-orders": ["=COUNT(A2:A181)", "=COUNTA(A1:A181)", "=180"],                     // COUNT on text · header counted · typed
  "l1-daily-four:avg-qty": ["=AVERAGE(G2:G181)", "=ROUND(AVERAGE(G2:G181),1)"],                       // unrounded · wrong digits
  "l1-daily-four:count-numbers": ["=COUNTA(J1:N15)", "=COUNT(J2:J15)"],
  "l1-if:label-row8": ["=IF(G8>10,HIGH,OK)", "=\"OK\""],                                            // unquoted → #NAME? · typed text
  "l1-if:at-least-15": ["=IF(G5>15,G5*2,0)", "=30"],                                                // > instead of >= · typed
  "l1-sumif-sumifs:crete-sumifs": ['=SUMIF(D2:D181,"Crete",G2:G181)', '=SUMIFS(D2:D181,"Crete",G2:G181)', "=SUMIFS(G2:G181,D2:D181,Crete)"], // wrong fn · SUMIF order · unquoted
  "l1-sumif-sumifs:attica-big": ['=SUMIFS(G2:G181,D2:D181,"Attica",G2:G181,">25")', '=SUMIFS(G2:G181,D2:D181,"Attica",G2:G181,>=25)'],     // > vs >= · unquoted
  "l1-countif-countifs:makri-10": ['=COUNTIFS(E2:E181,"Eleni Makri",G2:G181,">10")', '=COUNTIF(E2:E181,"Eleni Makri")'],
  "l1-countif-countifs:same-region": ['=COUNTIF(D2:D181,"Attica")'],                                // right number, typed criteria
  "l1-iferror:epirus-zero": ['=SUMIF(D2:D181,"Epirus",G2:G181)/COUNTIF(D2:D181,"Epirus")', "=0", "=IFERROR(1/0,0)"],
  // Level 2: the lookup traps
  "l2-vlookup:name-row2": ["=VLOOKUP(C2,$J$2:$N$15,11,FALSE)", "=VLOOKUP(C2,$J$2:$N$15,3,FALSE)", "=VLOOKUP(C2,$J$2:$N$15,2)", "=VLOOKUP(C2,$J$2:$N$15,2,TRUE)", "=K2"], // sheet column count · wrong column · forgot FALSE ×2 · pointed at a cell
  "l2-vlookup:price-row3": ["=VLOOKUP(C3,J2:N15,5,FALSE)", "=VLOOKUP(C3,$J2:$N15,5,FALSE)", "=VLOOKUP(C3,$J$2:$N$15,4,FALSE)", "=N7"], // unlocked · half-locked · cost not price · hand-picked cell
  "l2-vlookup:rep-target": ['=VLOOKUP("Sofia Papadaki",$P$2:$T$8,5,FALSE)', '=VLOOKUP("R07",$P$2:$T$8,4,FALSE)'], // name isn't the first column · HireDate column
  "l2-vlookup:category-p009": ['=VLOOKUP("P009",$J$2:$N$15,2,FALSE)', '=VLOOKUP("P009",$J$2:$N$15,3)'],       // name not category · forgot FALSE
  "l2-vlookup:cost-row12": ["=VLOOKUP(C12,$J$2:$N$15,5,FALSE)", "=VLOOKUP(C12,$J$2:$N$15,4)"],               // price not cost · forgot FALSE
  "l2-exact-approx:band-boundary": ["=VLOOKUP(G16,$V$2:$X$5,3,TRUE)", "=VLOOKUP(G16,$V$2:$X$5,1,TRUE)"],    // discount not band · MinQty
  "l2-exact-approx:tier-discount": ["=H5", "=VLOOKUP(G5,$V$2:$X$5,3,FALSE)"],                                // just read H5 · exact on a band → #N/A
  "l2-xlookup:xl-price": ["=XLOOKUP(C4,$J$2:$J$15,$M$2:$M$15)", "=VLOOKUP(C4,$J$2:$N$15,5,FALSE)"],         // cost · not XLOOKUP
  "l2-xlookup:xl-rep-id": ["=XLOOKUP(E2,$P$2:$P$8,$Q$2:$Q$8)"],                                              // arrays swapped
  "l2-index-match:match-pos": ['=MATCH("P010",$J$2:$J$15)', '=MATCH("P010",$J$1:$J$15,0)'],                 // no 0 (right by luck) · header shifts position
  "l2-index-match:row-rep-id": ["=INDEX($Q$2:$Q$8,MATCH(E4,$Q$2:$Q$8,0))", "=INDEX($P$2:$P$8,MATCH(E4,$Q$2:$Q$8))"], // returns the name · no 0
  "l2-index-match:hire-date": ['=INDEX($S$2:$S$8,MATCH("Kostas Alexiou",$Q$3:$Q$9,0))', '=INDEX($T$2:$T$8,MATCH("Kostas Alexiou",$Q$2:$Q$8,0))'], // misaligned · Target column
  "l2-lookup-math:rev-row3": ["=G3*VLOOKUP(C3,$J$2:$N$15,5,FALSE)", "=G3*VLOOKUP(C3,$J$2:$N$15,4,FALSE)*(1-H3)"], // no discount · cost
  "l2-lookup-math:margin-row2": ["=G2*VLOOKUP(C2,$J$2:$N$15,5,FALSE)*(1-H2)", "=G2*VLOOKUP(C2,$J$2:$N$15,5,FALSE)-G2*VLOOKUP(C2,$J$2:$N$15,4,FALSE)"], // revenue only · ignored discount
  "l2-exact-approx:band-row12": ["=VLOOKUP(G12,$V$2:$X$5,2,FALSE)", "=VLOOKUP(G12,$V$2:$X$5,3,TRUE)"],        // exact on a band · wrong column
  "l2-exact-approx:missing-id": ['=IFERROR(VLOOKUP("P016",$J$2:$N$15,2),"Not found")', '=IFERROR(VLOOKUP("P016",$J$2:$N$15,2,TRUE),"Not found")'], // the silent-wrong-answer trap
  "l2-xlookup:xl-not-found": ["=XLOOKUP(C142,$J$2:$J$15,$K$2:$K$15)"],
  "l2-xlookup:xl-left": ['=VLOOKUP("LED Desk Lamp",$J$2:$N$15,1,FALSE)', '=XLOOKUP("LED Desk Lamp",$J$2:$J$15,$K$2:$K$15)'], // VLOOKUP can't look left · arrays swapped
  "l2-index-match:reverse-rep": ['=INDEX($P$2:$P$8,MATCH("Maria Ioannou",$Q$2:$Q$8))', '=MATCH("Maria Ioannou",$Q$2:$Q$8,0)', '=INDEX($Q$2:$Q$8,MATCH("Maria Ioannou",$Q$2:$Q$8,0))'], // no 0 · position not value · wrong return column
  "l2-index-match:index-2d": ['=INDEX($J$2:$N$15,MATCH("P012",$J$2:$J$15,0),5)', '=INDEX($J$2:$N$15,MATCH("P012",$J$3:$J$16,0),4)'], // price not cost · misaligned ranges
  "l2-lookup-math:rev-discount": ["=G17*VLOOKUP(C17,$J$2:$N$15,5,FALSE)", "=G17*VLOOKUP(C17,$J$2:$N$15,5,FALSE)*H17", "=G17*VLOOKUP(C17,$J$2:$N$15,4,FALSE)*(1-H17)"], // no discount · kept the discount · cost
  "l2-lookup-math:rev-missing": ["=G142*VLOOKUP(C142,$J$2:$N$15,5,FALSE)*(1-H142)", "=0"],
  "l3-duplicates-blanks:count-dup": ["=2", "=COUNTA(A:A)", '=COUNTIF(A2:A100,"O1121")'],      // typed · counts every row · range stops before row 123
  "l3-duplicates-blanks:count-blank": ["=2", "=COUNTA(D2:D183)", '=COUNTIF(D2:D183," ")'],     // typed · counts the filled ones · a space isn't empty
  "l3-standardise:test-standardise": ["=D78", "=PROPER(D78)", "=UPPER(D78)"],                    // unchanged · right text, TRIM missing · wrong case
};


/* =========================================================================
   Level 3 oracle: plain JS over RAW (never the pivot / cleaning code).
   Revenue follows the helper column the lessons describe:
   IFERROR(Quantity × ListPrice × (1 − Discount), 0), so an unpriced product is 0.
   ========================================================================= */
const MESSY_ROWS = RAW.messy.orders;
const qtrOf = serial => `Qtr${Math.floor(new Date(Date.UTC(1899, 11, 30) + serial * 864e5).getUTCMonth() / 3) + 1}`;
const numQ = q => (typeof q === "number" ? q : Number(q));                 // Excel coerces "14" in arithmetic
const rev3 = x => (prod(x[o.product]) ? numQ(x[o.qty]) * prod(x[o.product])[4] * (1 - x[o.disc]) : 0);
const mar3 = x => (prod(x[o.product]) ? rev3(x) - numQ(x[o.qty]) * prod(x[o.product])[3] : 0);
const groupSum = (list, key, val) => list.reduce((m, x) => { const k = key(x); m[k] = (m[k] || 0) + val(x); return m; }, {});
const repRegion = name => rep(name)[2];
const catOf = x => prod(x[o.product])?.[2] ?? "(blank)";
const baseRows = ds => (ds === "aegean-messy" ? MESSY_ROWS : O);
const pct = (m, total) => Object.fromEntries(Object.entries(m).map(([k, v]) => [k, v / total]));
const avgBy = (list, key) => { const s = groupSum(list, key, x => x[o.qty]), n = groupSum(list, key, () => 1); return Object.fromEntries(Object.keys(s).map(k => [k, s[k] / n[k]])); };
const withGrand = (m, g) => ({ ...m, "Grand Total": g });
const ALLREV = sum(O.map(rev3));
const q4 = O.filter(x => qtrOf(x[o.date]) === "Qtr4");
const byRQ = groupSum(O, x => `${x[o.region]}|${qtrOf(x[o.date])}`, rev3);
const byQ = groupSum(O, x => qtrOf(x[o.date]), rev3);
const byRegion = groupSum(O, x => x[o.region], rev3);
const q4ByRegion = Object.fromEntries(Object.entries(byRQ).filter(([k]) => k.endsWith("|Qtr4")).map(([k, v]) => [k.split("|")[0], v]));
const top = m => Object.keys(m).reduce((a, b) => (m[a] >= m[b] ? a : b));
const marginByChannel = groupSum(O, x => x[o.channel], mar3);

/* What each workbench drill's check must contain: the figures (totals / colTotals / cells / blanks) or the defects. */
const WB_ORACLE = {
  "l3-duplicates-blanks:remove-dupes": () => ({ defects: RAW.messy.defects.filter(d => d.kind === "duplicate").map(d => d.id) }),
  "l3-duplicates-blanks:fill-blanks": () => ({ defects: RAW.messy.defects.filter(d => d.kind === "blank").map(d => d.id) }),
  "l3-standardise:standardise": () => ({ defects: RAW.messy.defects.filter(d => d.kind === "text-standardise").map(d => d.id) }),
  "l3-standardise:text-numbers": () => ({ defects: RAW.messy.defects.filter(d => d.kind === "number-as-text").map(d => d.id) }),
  "l3-standardise:fix-typo": () => ({ defects: ["typo-product-o1088"] }),
  "l3-standardise:future-date": () => ({ defects: ["future-date-o1170"] }),
  "l3-pivot-build:by-channel": () => ({ totals: withGrand(groupSum(O, x => x[o.channel], rev3), ALLREV) }),
  "l3-pivot-build:orders-per-rep": () => ({ totals: withGrand(groupSum(O, x => x[o.rep], () => 1), O.length) }),
  "l3-pivot-build:avg-qty-category": () => ({ totals: withGrand(avgBy(O, catOf), sum(allQty) / O.length) }),
  "l3-pivot-build:region-quarter": () => ({ totals: withGrand(byRegion, ALLREV), colTotals: byQ }),
  "l3-pivot-filter-pct:online-only": () => { const on = O.filter(x => x[o.channel] === "Online"); return { totals: withGrand(groupSum(on, x => x[o.region], rev3), sum(on.map(rev3))) }; },
  "l3-pivot-filter-pct:share-of-year": () => ({ totals: withGrand(pct(byRegion, ALLREV), 1) }),
  "l3-pivot-filter-pct:share-in-quarter": () => ({ cells: { "Macedonia|Qtr4": byRQ["Macedonia|Qtr4"] / byQ.Qtr4, "Attica|Qtr1": byRQ["Attica|Qtr1"] / byQ.Qtr1 } }),
  "l3-pivot-filter-pct:q4-orders-by-channel": () => ({ totals: withGrand(groupSum(q4, x => x[o.channel], () => 1), q4.length) }),
  "l3-pivot-refresh:raw-pivot": () => ({ totals: { "(blank)": sum(MESSY_ROWS.filter(x => x[o.region] === "").map(rev3)), " attica ": sum(MESSY_ROWS.filter(x => x[o.region] === " attica ").map(rev3)) } }),
  "l3-pivot-refresh:clean-regions": () => ({ defects: RAW.messy.defects.filter(d => d.field === "Region").map(d => d.id) }),
  "l3-pivot-refresh:refresh": () => ({ defects: RAW.messy.defects.filter(d => d.field === "Region").map(d => d.id), totals: { Attica: sum(MESSY_ROWS.filter(x => repRegion(x[o.rep]) === "Attica").map(rev3)) } }),
  "l3-story:trend": () => ({}),
  "l3-story:rank-regions": () => ({ titleMentions: [top(byRegion)] }),
  "l3-story:margin-sentence": () => { const t = top(marginByChannel); return { blanks: { top: t, amount: marginByChannel[t], share: marginByChannel[t] / sum(Object.values(marginByChannel)) * 100 } }; },
};
/* Wrong workspaces that MUST fail: { ops, pivot, story, cacheOps (a pivot left stale at those moves) }. */
const DEDUPE = { op: "dedupe" }, FILL_BLANKS = { op: "fill", formula: "=VLOOKUP(E2,$Q$2:$R$8,2,FALSE)", column: "D", scope: "blanks" }, STANDARDISE = { op: "fill", formula: "=TRIM(PROPER(D2))", column: "D" };
const PVC = (rows, value, extra = {}) => ({ rows, columns: "", value, agg: "sum", showAs: "none", filter: null, ...extra });
const WB_MUST_FAIL = {
  "l3-duplicates-blanks:remove-dupes": [{ ops: [{ op: "dedupe", columns: ["D"] }] }, { ops: [] }],
  "l3-duplicates-blanks:fill-blanks": [{ ops: [{ op: "set", row: 59, column: "D", value: "Attica" }, { op: "set", row: 100, column: "D", value: "Attica" }] }, { ops: [{ op: "fill", formula: "=VLOOKUP(E2,$Q$2:$R$8,2,FALSE)", column: "C", scope: "blanks" }] }],
  "l3-standardise:standardise": [{ ops: [{ op: "fill", formula: "=TRIM(D2)", column: "D" }] }, { ops: [{ op: "fill", formula: "=PROPER(D2)", column: "D" }] }],
  "l3-standardise:text-numbers": [{ ops: [{ op: "convert", column: "D" }] }, { ops: [{ op: "replace", find: "14", replace: "14", column: "G" }] }],
  "l3-standardise:fix-typo": [{ ops: [{ op: "replace", find: "O", replace: "0" }] }, { ops: [{ op: "replace", find: "P0O2", replace: "P002", column: "A" }] }],
  "l3-standardise:future-date": [{ ops: [{ op: "set", orderId: "O1170", column: "B", value: "2025-12-13" }] }, { ops: [{ op: "sort", column: "B", dir: "desc" }] }],
  "l3-pivot-build:by-channel": [{ pivot: PVC("Channel", "Quantity") }, { pivot: PVC("Region", "Revenue") }],
  "l3-pivot-build:orders-per-rep": [{ pivot: PVC("Rep", "OrderID") }, { pivot: PVC("Rep", "Quantity", { agg: "count" }) }],
  "l3-pivot-build:avg-qty-category": [{ pivot: PVC("Category", "Quantity") }, { pivot: PVC("Product", "Quantity", { agg: "average" }) }],
  "l3-pivot-build:region-quarter": [{ pivot: PVC("Quarter", "Revenue", { columns: "Region" }) }, { pivot: PVC("Region", "Revenue", { columns: "Month" }) }],
  "l3-pivot-filter-pct:online-only": [{ pivot: PVC("Region", "Revenue") }, { pivot: PVC("Region", "Revenue", { filter: { field: "Channel", values: ["Online", "Field"] } }) }],
  "l3-pivot-filter-pct:share-of-year": [{ pivot: PVC("Region", "Revenue") }, { pivot: PVC("Region", "Revenue", { showAs: "pct-col" }) }],
  "l3-pivot-filter-pct:share-in-quarter": [{ pivot: PVC("Region", "Revenue", { columns: "Quarter", showAs: "pct-grand" }) }, { pivot: PVC("Region", "Revenue", { columns: "Quarter", showAs: "pct-row" }) }],
  "l3-pivot-filter-pct:q4-orders-by-channel": [{ pivot: PVC("Channel", "OrderID", { agg: "count", filter: { field: "Quarter", values: ["Qtr3"] } }) }, { pivot: PVC("Channel", "OrderID", { agg: "count" }) }],
  "l3-pivot-refresh:raw-pivot": [{ ops: [FILL_BLANKS], pivot: PVC("Region", "Revenue") }, { pivot: PVC("Rep", "Revenue") }],
  "l3-pivot-refresh:clean-regions": [{ ops: [STANDARDISE] }, { ops: [FILL_BLANKS] }],
  "l3-pivot-refresh:refresh": [{ ops: [FILL_BLANKS, STANDARDISE], pivot: PVC("Region", "Revenue"), cacheOps: [] }, { ops: [FILL_BLANKS], pivot: PVC("Region", "Revenue") }],
  "l3-story:trend": [{ story: { chart: "pie" } }, { story: { sort: "desc" } }, { pivot: PVC("Month", "Revenue") }],
  "l3-story:rank-regions": [{ story: { title: "Revenue by region" } }, { story: { sort: "none" } }, { story: { chart: "line" } }],
  "l3-story:margin-sentence": [{ story: { blanks: { top: "Partner" } } }, { story: { blanks: { share: "53" } } }, { story: { chart: "pie" } }],
};
/** The submission a workspace produces; cacheOps leaves the pivot stale at an earlier point. */
function workspaceOf(ds, panels, { ops = [], pivot, story, cacheOps } = {}) {
  const sub = workbenchSubmission(ds, panels, { ops, pivot, story });
  if (pivot && cacheOps) {
    const rows = panels.includes("cleaning") ? replay(ds, cacheOps).rows : baseRows(ds.id);
    sub.pivot = pivotState(pivot, computePivot(deriveRows(rows, ds), pivot), { stale: JSON.stringify(cacheOps) !== JSON.stringify(ops) });
  }
  return sub;
}
const mergeTrap = (sol, trap) => ({ ops: trap.ops ?? sol.steps ?? [], pivot: trap.pivot ?? sol.pivot, cacheOps: trap.cacheOps,
  story: sol.story || trap.story ? { ...(sol.story || {}), ...(trap.story || {}), blanks: { ...(sol.story?.blanks || {}), ...(trap.story?.blanks || {}) } } : undefined });
const checksOf = c => (Array.isArray(c) ? c : [c]);
const keyWorkspaceOps = (a, key) => a.tasks.map(t => key.solutions[t.id]).filter(x => x && typeof x === "object").flatMap(x => x.steps || []);

/* ---------- load everything listed in the curriculum ---------- */
const lessonsByLevel = curriculum.levels.map(lv => ({ lv, lessons: lv.lessons.map((id, i) => ({ id, order: i + 1, json: (() => { try { return readJSON(`lessons/${id}.json`); } catch (e) { return { __error: e.message }; } })() })) }));
const allLessons = lessonsByLevel.flatMap(x => x.lessons.map(l => ({ ...l, level: x.lv.number })));
const gates = curriculum.levels.filter(lv => lv.gate.content).map(lv => ({ lv, g: readJSON(lv.gate.content) }));

s.group("files & schema");
s.test("every lesson file in content/lessons/ is listed in curriculum.json (no orphans)", () => {
  const listed = new Set(allLessons.map(l => l.id));
  const files = readdirSync(new URL("lessons/", root)).filter(f => f.endsWith(".json")).map(f => f.replace(/\.json$/, ""));
  eq(files.filter(f => !listed.has(f)), []);
});
for (const l of allLessons) {
  s.test(`${l.id}: loads and matches the schema`, () => {
    assert(!l.json.__error, l.json.__error);
    const p = validateLesson(l.json, { level: l.level, order: l.order });
    assert(p.length === 0, p.join("; "));
  });
}
s.test("lesson ids are unique across the course", () => { const ids = allLessons.map(l => l.id); eq(ids.length, new Set(ids).size); });
s.test("Levels 0–3 have content; the capstone is empty for now", () =>
  eq(lessonsByLevel.map(x => x.lessons.length > 0), [true, true, true, true, false]));
s.test("all course content uses the Aegean dataset (spec §6); only the cleaning labs use the messy export", () => {
  eq([...new Set([...allLessons.map(l => l.json.dataset), ...gates.map(x => x.g.dataset)])].sort(), ["aegean", "aegean-messy"]);
  const messy = [...allLessons.map(l => l.json), ...gates.map(x => x.g)].filter(x => x.dataset === "aegean-messy");
  assert(messy.every(x => x.lab?.panels?.includes("cleaning")), messy.filter(x => !x.lab?.panels?.includes("cleaning")).map(x => x.id).join());
});
for (const { lv, g } of gates) {
  s.test(`${lv.id} gate (${lv.gate.content}) matches the schema`, () => {
    const p = validateGate(g, { taskId: lv.gate.taskId, level: lv.number }); assert(p.length === 0, p.join("; "));
  });
}

s.group("drills: solutions & oracle");
const closeTo = (a, b) => (typeof a === "number" ? Math.abs(a - b) < 1e-6 : String(a).toLowerCase() === String(b).toLowerCase());
for (const l of allLessons) {
  if (l.json.__error) continue;
  const ds = DATASETS[l.json.dataset].cells;
  for (const d of l.json.drills) {
    const key = drillTaskId(l.json, d);
    if (typeof d.solution !== "string") continue; // workbench drills: see "Level 3" below
    s.test(`${key}: solution passes`, () => {
      const v = grade({ formula: d.solution, result: evaluate(d.solution, ds) }, d.answerCheck);
      assert(v.pass, `${d.solution} → ${v.message}`);
    });
    s.test(`${key}: expected value matches the independent oracle`, () => {
      assert(ORACLE[key], `no oracle for ${key}: add one before shipping this drill`);
      const expect = (Array.isArray(d.answerCheck) ? d.answerCheck : [d.answerCheck]).find(c => c.type === "value")?.expect;
      const truth = ORACLE[key]();
      assert(closeTo(truth, expect), `content says ${JSON.stringify(expect)}, oracle says ${JSON.stringify(truth)}`);
    });
    if (d.starter) s.test(`${key}: starter alone does not pass`, () => eq(grade({ formula: d.starter, result: evaluate(d.starter, ds) }, d.answerCheck).pass, false));
  }
}
s.test("every oracle belongs to a real drill (no stale oracles)", () => {
  const keys = new Set(allLessons.flatMap(l => (l.json.drills || []).map(d => drillTaskId(l.json, d))));
  eq([...Object.keys(ORACLE), ...Object.keys(WB_ORACLE)].filter(k => !keys.has(k)), []);
});

s.group("drills: wrong answers fail");
for (const [key, wrongs] of Object.entries(MUST_FAIL)) {
  const [lid, did] = key.split(":");
  const l = allLessons.find(x => x.id === lid)?.json, d = l?.drills.find(x => x.id === did);
  for (const f of wrongs) s.test(`${key}: ${f} fails`, () => {
    assert(d, `drill ${key} not found`);
    eq(grade({ formula: f, result: evaluate(f, DATASETS[l.dataset].cells) }, d.answerCheck).pass, false, `${f} should not pass`);
  });
}
s.test("every Level 2 drill has at least one trap (make-or-break level: extra QA)", () => {
  const l2 = allLessons.filter(l => l.level === 2).flatMap(l => l.json.drills.map(d => drillTaskId(l.json, d)));
  eq(l2.filter(k => !MUST_FAIL[k]), []);
});


s.group("Level 3: workbench drills");
for (const l of allLessons.filter(x => x.json.lab)) {
  const ds = DATASETS[l.json.dataset], panels = l.json.lab.panels;
  for (const d of l.json.drills.filter(x => typeof x.solution !== "string")) {
    const key = drillTaskId(l.json, d), sol = d.solution;
    const good = workspaceOf(ds, panels, { ops: sol.steps || [], pivot: sol.pivot, story: sol.story });
    s.test(`${key}: solution passes`, () => { const v = grade(good, d.answerCheck); assert(v.pass, v.message); });
    s.test(`${key}: figures match the independent oracle`, () => {
      assert(WB_ORACLE[key], `no oracle for ${key}: add one before shipping this drill`);
      const want = WB_ORACLE[key](), checks = checksOf(d.answerCheck);
      if (want.defects) eq(checks.filter(c => c.type === "cleaning-done").flatMap(c => c.defects.map(x => x.id || x)).sort(), [...want.defects].sort());
      for (const part of ["totals", "colTotals", "cells"]) if (want[part]) {
        const got = checks.find(c => c.type === "pivot-state")?.[part]; assert(got, `check has no ${part}`);
        eq(Object.keys(got).sort(), Object.keys(want[part]).sort(), part);
        for (const [k, v] of Object.entries(want[part])) assert(Math.abs(got[k] - v) <= (checks.find(c => c.type === "pivot-state").tolerance ?? 1e-9), `${part}.${k}: content ${got[k]}, oracle ${v}`);
      }
      const st = checks.find(c => c.type === "story");
      if (want.titleMentions) eq(st.titleMentions, want.titleMentions);
      for (const [k, v] of Object.entries(want.blanks || {})) {
        const b = st.blanks[k], e = typeof b === "object" ? b.expect : b;
        assert(typeof v === "number" ? Math.abs(e - v) <= (b.tolerance ?? 0) : e === v, `blank ${k}: content ${e}, oracle ${v}`);
      }
    });
    for (const [i, trap] of (WB_MUST_FAIL[key] || []).entries()) s.test(`${key}: trap ${i + 1} (${JSON.stringify(trap).slice(0, 70)}) fails`, () => {
      eq(grade(workspaceOf(ds, panels, mergeTrap(sol, trap)), d.answerCheck).pass, false);
    });
  }
}
s.test("every Level 3 workbench drill has an oracle and at least one trap", () => {
  const keys = allLessons.filter(l => l.json.lab).flatMap(l => l.json.drills.filter(d => typeof d.solution !== "string").map(d => drillTaskId(l.json, d)));
  eq(keys.filter(k => !WB_ORACLE[k] || !(WB_MUST_FAIL[k] || []).length), []);
});
s.test("Level 3 formula drills (formula bar in the cleaning lab) are trapped too", () => {
  const f = allLessons.filter(l => l.json.lab).flatMap(l => l.json.drills.filter(d => typeof d.solution === "string").map(d => drillTaskId(l.json, d)));
  eq(f.filter(k => !MUST_FAIL[k]), []);
});
s.test("a worked example never passes a drill by itself (showing ≠ doing)", () => {
  for (const l of allLessons.filter(x => x.json.lab && x.json.worked.pivot)) {
    const ws = workspaceOf(DATASETS[l.json.dataset], l.json.lab.panels, { pivot: l.json.worked.pivot, story: l.json.worked.story });
    for (const d of l.json.drills) assert(!grade(ws, d.answerCheck).pass || l.id === "l3-pivot-refresh" && d.id === "raw-pivot", `${l.id} worked example passes ${d.id}`);
  }
});
s.test("prose facts in Level 3 are true", () => {
  eq(top(byRegion), "Attica");                                              // rank-regions title
  eq(top(groupSum(O, x => x[o.channel], rev3)), "Online");                   // "Online has by far the biggest one"
  const ch = groupSum(O, x => x[o.channel], rev3); assert(ch.Online > 2 * Math.max(ch.Field, ch.Partner), "by far");
  const byMonth = groupSum(O, x => new Date(Date.UTC(1899, 11, 30) + x[o.date] * 864e5).getUTCMonth(), rev3);
  eq([top(byMonth), top(Object.fromEntries(Object.entries(byMonth).map(([k, v]) => [k, -v])))], ["2", "7"]); // "peaked in March and slumped in August"
  eq(top(q4ByRegion), "Macedonia");                                          // "Macedonia overtook Attica in Qtr4" (quiz example) / A3
  assert(q4ByRegion.Macedonia > q4ByRegion.Attica && byRQ["Attica|Qtr1"] > byRQ["Macedonia|Qtr1"], "Macedonia overtook Attica");
  eq(MESSY_ROWS.filter(x => x[o.id] === "O1057" || x[o.id] === "O1098").map(x => x[o.rep]), ["Giorgos Nikolaou", "Giorgos Nikolaou"]); // A3 key text
  eq(repRegion("Giorgos Nikolaou"), "Macedonia");
  eq(RAW.messy.defects.length, 11); eq(new Set(RAW.messy.defects.map(d => d.kind)).size, 6);   // "11 problems of six kinds"
  eq(MESSY_ROWS.findIndex(x => x[o.id] === "O1034") + 2, 35); eq(MESSY_ROWS.findIndex(x => x[o.id] === "O1012") + 2, 13); eq(MESSY_ROWS.findIndex(x => x[o.id] === "O1076") + 2, 78);
  eq(MESSY_ROWS.findIndex(x => x[o.id] === "O1057") + 2, 59); eq(MESSY_ROWS.findIndex(x => x[o.id] === "O1121") + 3, 124);
});

s.group("worked examples");
for (const l of allLessons) {
  if (l.json.__error) continue;
  if (!l.json.worked.formula) {
    s.test(`${l.id}: worked pivot builds`, () => assert(computePivot(deriveRows(baseRows(l.json.dataset), DATASETS[l.json.dataset]), l.json.worked.pivot).ready, "pivot not ready"));
    continue;
  }
  s.test(`${l.id}: worked example evaluates to its stated result`, () => {
    const r = evaluate(l.json.worked.formula, DATASETS[l.json.dataset].cells);
    assert(r.ok, `${l.json.worked.formula} → ${r.error?.code}`);
    if ("expect" in l.json.worked) assert(closeTo(r.value, l.json.worked.expect), `got ${r.value}`);
  });
}

s.group("quizzes");
const allQuizzes = [
  ...allLessons.filter(l => l.json.checkpoint).map(l => ({ where: `${l.id} checkpoint`, qs: l.json.checkpoint.questions, ds: l.json.dataset })),
  ...gates.filter(x => x.g.kind === "checkpoint").map(x => ({ where: x.g.id, qs: x.g.questions, ds: x.g.dataset })),
];
for (const q of allQuizzes) for (const item of q.qs.filter(x => x.verify)) {
  s.test(`${q.where} · ${item.id}: marked answer equals what the engine returns for ${item.verify}`, () => {
    const r = evaluate(item.verify, DATASETS[q.ds].cells);
    eq(item.options[item.answer].replace(/`/g, "").toLowerCase(), (r.ok ? String(r.value) : r.error.code).toLowerCase());
  });
}
s.test("gates reveal hints (not answers) on failure: every gate question has a hint", () => {
  for (const { g } of gates.filter(x => x.g.kind === "checkpoint")) for (const q of g.questions) assert(q.hint, `${g.id}.${q.id} needs a hint`);
});
s.test("answers aren't always the same option position (no pattern to game)", () => {
  const positions = allQuizzes.flatMap(q => q.qs.map(x => x.answer));
  assert(new Set(positions).size >= 3, `answers only at positions ${[...new Set(positions)]}`);
  assert(positions.filter(p => p === 0).length / positions.length < 0.6, "too many answers in position 1");
});

/* ---------- Phase 5 QA: numbers and formulas in prose ---------- */
s.group("prose: live numbers & formulas");
const withDataset = [...allLessons.map(l => ({ where: l.id, obj: l.json, ds: l.json.dataset })),
  ...gates.map(({ g }) => ({ where: g.id, obj: g, ds: g.dataset })),
  ...gates.filter(x => x.g.kind === "assignment").map(({ g }) => ({ where: `${g.id} key`, obj: readJSON(g.key), ds: g.dataset }))];
for (const { where, obj, ds } of withDataset) {
  const tpls = findTemplates(obj);
  if (tpls.length) s.test(`${where}: all ${tpls.length} {{=…}} numbers evaluate`, () => {
    const bad = tpls.filter(f => !templateValue(f, DATASETS[ds]).ok); eq(bad, []);
  });
  // every `=FORMULA` shown in a code span must at least be readable by the engine (no internal errors);
  // Excel error codes are allowed, because some examples show #N/A or #NAME? on purpose.
  const noDistractors = JSON.parse(JSON.stringify(obj, (k, v) => (k === "options" ? undefined : v))); // wrong quiz options are wrong on purpose
  const shown = [...JSON.stringify(noDistractors).matchAll(/`(=[^`]+)`/g)].map(m => JSON.parse(`"${m[1]}"`)).filter(f => !/[…]/.test(f) && /^=[A-Z$(]/i.test(f));
  if (shown.length) s.test(`${where}: all ${shown.length} formulas shown in prose run`, () => {
    const unreadable = shown.filter(f => { const r = evaluate(f.replace(/\{\{=[^}]+\}\}/g, "1"), DATASETS[ds].cells); return !r.ok && r.error.code === null; });
    eq(unreadable, []);
  });
}

/* =========================================================================
   Assignments: every key solution passes; every expected value matches the oracle;
   the traps fail; answers never sit in the task file.
   ========================================================================= */
const A_ORACLE = {
  "a1-sales-summary:total-region": () => sum(qtys(x => x[o.region] === "Macedonia")),
  "a1-sales-summary:orders-partner": () => rows(x => x[o.channel] === "Partner").length,
  "a1-sales-summary:rep-units": () => sum(qtys(x => x[o.rep] === "Nikos Petrou")),
  "a1-sales-summary:big-orders": () => { needs(rows(x => x[o.qty] === 12).length, "needs an order of exactly 12 so > vs >= matters"); return rows(x => x[o.qty] > 12).length; },
  "a1-sales-summary:mouse-not-attica": () => { needs(rows(x => x[o.product] === "P004" && x[o.region] === "Attica").length, "needs an Attica mouse order so <> matters"); return sum(qtys(x => x[o.product] === "P004" && x[o.region] !== "Attica")); },
  "a1-sales-summary:avg-peloponnese": () => round(sum(qtys(x => x[o.region] === "Peloponnese")) / rows(x => x[o.region] === "Peloponnese").length, 1),
  "a1-sales-summary:share-25plus": () => { needs(rows(x => x[o.qty] === 25).length, "needs an order of exactly 25 so > vs >= matters"); return round(rows(x => x[o.qty] >= 25).length / O.length, 2); },
  "a1-sales-summary:rep-target": () => { const u = sum(qtys(x => x[o.rep] === "Maria Ioannou")), n = rows(x => x[o.rep] === "Maria Ioannou").length; needs(u >= 550 && n < 550, "units must meet 550 while the order count doesn't, so counting orders gives the wrong verdict"); return u >= 550 ? "Target met" : "Below target"; },
  "a2-enrich-orders:name-vlookup": () => prod(at("O1020", 21)[o.product])[1],
  "a2-enrich-orders:price-xlookup": () => prod(at("O1047", 48)[o.product])[4],
  "a2-enrich-orders:category": () => prod(at("O1090", 91)[o.product])[2],
  "a2-enrich-orders:revenue": () => { const x = at("O1100", 101); needs(x[o.disc] > 0, "needs a discount so forgetting it fails"); return revenue(x); },
  "a2-enrich-orders:band": () => { const q = at("O1065", 66)[o.qty]; needs(!TIERS.some(t => t[0] === q), "quantity must not be a tier boundary, so an exact match fails"); return band(q)[1]; },
  "a2-enrich-orders:missing-price": () => { needs(!prod(at("O1141", 142)[o.product]), "O1141's product must be missing"); return "Price missing"; },
  "a2-enrich-orders:rep-id": () => rep(at("O1120", 121)[o.rep])[0],
  "a2-enrich-orders:margin": () => margin(at("O1015", 16)),
};
const A_MUST_FAIL = {
  "a1-sales-summary:total-region": ['=COUNTIF(D2:D181,"Macedonia")', "=1031"],
  "a1-sales-summary:orders-partner": ['=SUMIF(F2:F181,"Partner",G2:G181)', "=COUNTA(F2:F181)"],
  "a1-sales-summary:rep-units": ['=SUMIF(E2:E181,"Nikos  Petrou",G2:G181)', '=COUNTIF(E2:E181,"Nikos Petrou")'],
  "a1-sales-summary:big-orders": ['=COUNTIF(G2:G181,">=12")', "=COUNTIF(G2:G181,>12)"],
  "a1-sales-summary:mouse-not-attica": ['=SUMIF(C2:C181,"P004",G2:G181)', '=SUMIFS(G2:G181,C2:C181,"P004",D2:D181,"Attica")'],
  "a1-sales-summary:avg-peloponnese": ['=SUMIF(D2:D181,"Peloponnese",G2:G181)/COUNTIF(D2:D181,"Peloponnese")', '=ROUND(SUMIF(D2:D181,"Peloponnese",G2:G181)/COUNTA(D2:D181),1)'],
  "a1-sales-summary:share-25plus": ['=ROUND(COUNTIF(G2:G181,">25")/COUNTA(A2:A181),2)', '=COUNTIF(G2:G181,">=25")/COUNTA(A2:A181)', "=ROUND(56/180,2)"],
  "a1-sales-summary:rep-target": ['=IF(COUNTIF(E2:E181,"Maria Ioannou")>=550,"Target met","Below target")', '="Target met"'],
  "a2-enrich-orders:name-vlookup": ["=VLOOKUP(C21,J2:N15,2,FALSE)", "=VLOOKUP(C21,$J$2:$N$15,2)", "=XLOOKUP(C21,$J$2:$J$15,$K$2:$K$15)", "=VLOOKUP(C21,$J$2:$N$15,3,FALSE)"], // unlocked · no FALSE · wrong function · wrong column
  "a2-enrich-orders:price-xlookup": ["=XLOOKUP(C48,J2:J15,N2:N15)", "=VLOOKUP(C48,$J$2:$N$15,5,FALSE)", "=XLOOKUP(C48,$J$2:$J$15,$M$2:$M$15)"],     // unlocked · wrong function · cost
  "a2-enrich-orders:category": ["=VLOOKUP(C91,$J$2:$N$15,3)", "=VLOOKUP(C91,$J$2:$N$15,2,FALSE)"],
  "a2-enrich-orders:revenue": ["=G101*VLOOKUP(C101,$J$2:$N$15,5,FALSE)", "=G101*VLOOKUP(C101,$J$2:$N$15,5,FALSE)*H101", "=G101*VLOOKUP(C101,$J$2:$N$15,5)*(1-H101)"],
  "a2-enrich-orders:band": ["=VLOOKUP(G66,$V$2:$X$5,2,FALSE)", "=VLOOKUP(G66,$V$2:$X$5,3,TRUE)", "=VLOOKUP(G66,$V$2:$X$5,2)*0"],
  "a2-enrich-orders:missing-price": ["=G142*VLOOKUP(C142,$J$2:$N$15,5,FALSE)*(1-H142)", "=IFERROR(G142*VLOOKUP(C142,$J$2:$N$15,5,FALSE)*(1-H142),0)", '="Price missing"'],
  "a2-enrich-orders:rep-id": ["=INDEX($P$2:$P$8,MATCH(E121,$Q$2:$Q$8))", "=MATCH(E121,$Q$2:$Q$8,0)", "=XLOOKUP(E121,$Q$2:$Q$8,$P$2:$P$8)"], // no 0 · position · wrong method
  "a2-enrich-orders:margin": ["=G16*VLOOKUP(C16,$J$2:$N$15,5,FALSE)*(1-H16)", "=G16*VLOOKUP(C16,$J$2:$N$15,5,FALSE)-G16*VLOOKUP(C16,$J$2:$N$15,4,FALSE)"], // revenue only · ignored discount
};

const A3_ALL = [DEDUPE, FILL_BLANKS, STANDARDISE, { op: "convert", column: "G" }, { op: "replace", find: "P0O2", replace: "P002", column: "C", entire: true }, { op: "set", orderId: "O1170", column: "B", value: "2025-12-12" }];
const defectsOfKind = (...kinds) => RAW.messy.defects.filter(d => kinds.includes(d.kind)).map(d => d.id);
Object.assign(A_ORACLE, {
  "a3-messy-export:duplicates": () => ({ defects: defectsOfKind("duplicate") }),
  "a3-messy-export:blanks": () => ({ defects: defectsOfKind("blank") }),
  "a3-messy-export:region-text": () => ({ defects: defectsOfKind("text-standardise") }),
  "a3-messy-export:quantities": () => ({ defects: defectsOfKind("number-as-text") }),
  "a3-messy-export:typo-and-date": () => ({ defects: defectsOfKind("misspelling", "future-date") }),
  "a3-messy-export:pivot": () => ({ totals: withGrand(byRegion, ALLREV), colTotals: byQ }),   // the CLEAN log: cleaning the export must give exactly it
  "a3-messy-export:chart": () => ({ titleMentions: [top(q4ByRegion)] }),
  "a3-messy-export:insight": () => { const t = top(q4ByRegion), y = top(byRegion); return { blanks: { top: t, amount: q4ByRegion[t], share: q4ByRegion[t] / byQ.Qtr4 * 100, leader: y, leaderAmount: q4ByRegion[y] } }; },
});
const without = op => A3_ALL.filter(x => x !== op);
const A_WB_MUST_FAIL = {
  "a3-messy-export:duplicates": [{ ops: [...without(DEDUPE), { op: "dedupe", columns: ["D"] }] }, { ops: without(DEDUPE) }],
  "a3-messy-export:blanks": [{ ops: [...without(FILL_BLANKS), { op: "set", orderId: "O1057", column: "D", value: "Attica" }, { op: "set", orderId: "O1098", column: "D", value: "Attica" }] }, { ops: without(FILL_BLANKS) }],
  "a3-messy-export:region-text": [{ ops: [...without(STANDARDISE), { op: "fill", formula: "=TRIM(D2)", column: "D" }] }, { ops: without(STANDARDISE) }],
  "a3-messy-export:quantities": [{ ops: without(A3_ALL[3]) }],
  "a3-messy-export:typo-and-date": [{ ops: without(A3_ALL[4]) }, { ops: [...A3_ALL, { op: "replace", find: "O", replace: "0" }] }],
  "a3-messy-export:pivot": [{ cacheOps: [] }, { cacheOps: A3_ALL.slice(0, 3) }, { pivot: PVC("Quarter", "Revenue", { columns: "Region" }) }, { pivot: PVC("Region", "Revenue", { columns: "Quarter", filter: { field: "Channel", values: ["Online"] } }) }],
  "a3-messy-export:chart": [{ story: { series: "Grand Total" } }, { story: { title: "Qtr4 revenue by region" } }, { story: { chart: "pie" } }, { story: { sort: "none" } }],
  "a3-messy-export:insight": [{ story: { blanks: { top: "Attica" } } }, { story: { blanks: { share: "12.4" } } }, { story: { blanks: { amount: "113,802.50" } } }, { story: { blanks: { leader: "Macedonia" } } }],
};
/** The key's workspace with one thing changed (moves, a stale pivot, a different layout, or chart answers). */
function a3Trap(a, key, trap) {
  const sols = a.tasks.map(t => key.solutions[t.id]).filter(x => x && typeof x === "object");
  const ops = trap.ops ?? sols.flatMap(x => x.steps || []);
  const pivot = trap.pivot ?? sols.map(x => x.pivot).filter(Boolean).at(-1);
  const baseStory = Object.assign({}, ...sols.map(x => x.story).filter(Boolean).map(st => ({ ...st, blanks: undefined })), { blanks: Object.assign({}, ...sols.map(x => x.story?.blanks || {})) });
  const story = { ...baseStory, ...(trap.story || {}), blanks: { ...baseStory.blanks, ...(trap.story?.blanks || {}) } };
  return workspaceOf(DATASETS[a.dataset], a.lab.panels, { ops, pivot, story, cacheOps: trap.cacheOps });
}

s.group("assignments");
const assignments = gates.filter(x => x.g.kind === "assignment");
s.test("Assignments 1–3 are wired as the Level 1–3 gates; A3 gates the capstone", () => {
  eq(assignments.map(x => `${x.lv.id}:${x.g.id}`), ["level-1:a1-sales-summary", "level-2:a2-enrich-orders", "level-3:a3-messy-export"]);
  eq(curriculum.levels.find(l => l.id === "capstone").requires, "a3-messy-export");
});
for (const { lv, g: a } of assignments) {
  const key = readJSON(a.key), ds = DATASETS[a.dataset].cells;
  s.test(`${a.id}: schema valid, key complete`, () => { eq(validateGate(a, { taskId: lv.gate.taskId, level: lv.number }), []); eq(validateKey(key, a), []); });
  if (a.lab) s.test(`${a.id}: cleaning the export with the key's moves gives exactly the clean order log`, () => eq(replay(DATASETS[a.dataset], keyWorkspaceOps(a, key)).rows, O));
  s.test(`${a.id}: 6–8 tasks (spec §7)`, () => assert(a.tasks.length >= 6 && a.tasks.length <= 8, `${a.tasks.length} tasks`));
  s.test(`${a.id}: the task file holds no answers (they're only in the key)`, () => {
    const raw = readFileSync(new URL(lv.gate.content, root), "utf8");
    const formulas = Object.values(key.solutions).flatMap(sol => typeof sol === "string" ? [sol] : (sol.steps || []).map(x => x.formula).filter(Boolean));
    for (const f of formulas) assert(!raw.includes(f.replace(/^=/, "")), `task file contains the solution ${f}`);
  });
  const ws = a.lab ? keyWorkspace(a, key) : {};
  for (const t of a.tasks) {
    const k = `${a.id}:${t.id}`, sol = key.solutions[t.id];
    if (typeof sol !== "string") {
      s.test(`${k}: the key's workspace passes this task`, () => { const v = grade(ws, t.answerCheck); assert(v.pass, v.message); });
      s.test(`${k}: figures match the independent oracle`, () => {
        assert(A_ORACLE[k], `no oracle for ${k}`);
        const want = A_ORACLE[k](), checks = checksOf(t.answerCheck);
        if (want.defects) eq(checks.flatMap(c => (c.defects || []).map(x => x.id || x)).sort(), [...want.defects].sort());
        const pc = checks.find(c => c.type === "pivot-state");
        for (const part of ["totals", "colTotals"]) if (want[part]) { eq(Object.keys(pc[part]).sort(), Object.keys(want[part]).sort()); for (const [x, v] of Object.entries(want[part])) assert(Math.abs(pc[part][x] - v) <= pc.tolerance, `${part}.${x}`); }
        const st = checks.find(c => c.type === "story");
        if (want.titleMentions) eq(st.titleMentions, want.titleMentions);
        for (const [x, v] of Object.entries(want.blanks || {})) { const b = st.blanks[x], e = typeof b === "object" ? b.expect : b; assert(typeof v === "number" ? Math.abs(e - v) <= b.tolerance : e === v, `blank ${x}: content ${e}, oracle ${v}`); }
      });
      for (const [i, trap] of (A_WB_MUST_FAIL[k] || []).entries()) s.test(`${k}: trap ${i + 1} fails`, () => eq(grade(a3Trap(a, key, trap), t.answerCheck).pass, false));
      continue;
    }
    s.test(`${k}: key solution passes`, () => { const v = grade({ formula: sol, result: evaluate(sol, ds) }, t.answerCheck); assert(v.pass, `${sol} → ${v.message}`); });
    s.test(`${k}: expected value matches the independent oracle`, () => {
      assert(A_ORACLE[k], `no oracle for ${k}`);
      const expect = (Array.isArray(t.answerCheck) ? t.answerCheck : [t.answerCheck]).find(c => c.type === "value").expect;
      assert(closeTo(A_ORACLE[k](), expect), `content says ${JSON.stringify(expect)}, oracle says ${JSON.stringify(A_ORACLE[k]())}`);
    });
    for (const f of A_MUST_FAIL[k] || []) s.test(`${k}: ${f} fails`, () => eq(grade({ formula: f, result: evaluate(f, ds) }, t.answerCheck).pass, false));
  }
  s.test(`${a.id}: every task has at least one must-fail trap`, () => eq(a.tasks.filter(t => !(A_MUST_FAIL[`${a.id}:${t.id}`] || A_WB_MUST_FAIL[`${a.id}:${t.id}`] || []).length).map(t => t.id), []));
  s.test(`${a.id}: grading the whole key passes; one trap drops it below the pass mark`, () => {
    const all = gradeAssignment(a, key.solutions, ws); eq([all.passed, all.score], [true, a.tasks.length]);
    const t0 = a.tasks[0], k0 = `${a.id}:${t0.id}`;
    const bad = A_WB_MUST_FAIL[k0] ? gradeAssignment(a, key.solutions, a3Trap(a, key, A_WB_MUST_FAIL[k0][0])) : gradeAssignment(a, { ...key.solutions, [t0.id]: A_MUST_FAIL[k0][0] }, ws);
    assert(!bad.passed && bad.score < a.tasks.length, JSON.stringify([bad.passed, bad.score]));
    eq(gradeAssignment(a, {}, a.lab ? workbenchSubmission(DATASETS[a.dataset], a.lab.panels, {}) : {}).score, 0);
  });
}
s.test("A3 end to end: a messy workspace with no moves, a stale pivot or a wrong sentence can't pass 8/8", () => {
  const a = assignments.find(x => x.g.id === "a3-messy-export").g, key = readJSON(a.key);
  eq(gradeAssignment(a, {}, a3Trap(a, key, { ops: [] })).passed, false);
  eq(gradeAssignment(a, {}, a3Trap(a, key, { cacheOps: [] })).results.find(r => r.id === "pivot").reason, "pivot-stale");
});
s.test("every assignment oracle belongs to a real task", () => {
  const keys = new Set(assignments.flatMap(({ g }) => g.tasks.map(t => `${g.id}:${t.id}`)));
  eq(Object.keys(A_ORACLE).filter(k => !keys.has(k)), []);
});

/* =========================================================================
   Phase 7: the mock test (pool, variants, key) and Case Study A.
   Same rule: every expected answer vs an independent oracle, traps must fail.
   ========================================================================= */
s.group("mock test");
const MOCK = readJSON(curriculum.levels.find(l => l.id === "capstone").gate.content), MKEY = readJSON(MOCK.key);
const partner = O.filter(x => x[o.channel] === "Partner");
const attica = O.filter(x => x[o.region] === "Attica");
const MOCK_ORACLE = {
  "a-sumifs": () => sum(qtys(x => x[o.rep] === "Sofia Papadaki" && x[o.channel] === "Field")),
  "b-sumifs": () => sum(qtys(x => x[o.product] === "P012" && x[o.region] === "Attica")),
  "a-countifs": () => { needs(partner.some(x => x[o.qty] === 10), "needs a Partner order of exactly 10 so > vs >= matters"); return partner.filter(x => x[o.qty] >= 10).length; },
  "b-countifs": () => rows(x => x[o.region] === "Macedonia" && x[o.channel] === "Online").length,
  "a-logic": () => round(sum(attica.map(x => x[o.qty])) / attica.length, 1),
  "b-logic": () => { const u = sum(qtys(x => x[o.region] === "Thessaly")), n = rows(x => x[o.region] === "Thessaly").length; needs(u >= 250 && n < 250, "units must pass 250 while the order count doesn't"); return "Yes"; },
  "a-vlookup": () => prod(at("O1033", 34)[o.product])[2],
  "b-vlookup": () => prod(at("O1077", 78)[o.product])[4],
  "a-approx": () => { const q = at("O1146", 147)[o.qty]; needs(!TIERS.some(t => t[0] === q), "not a boundary, so an exact match fails"); return band(q)[1]; },
  "b-approx": () => { const q = at("O1169", 170)[o.qty]; needs(!TIERS.some(t => t[0] === q), "not a boundary"); return band(q)[1]; },
  "a-index": () => rep(at("O1150", 151)[o.rep])[0],
  "b-index": () => PROD.find(x => x[1] === "Headset Pro")[0],
  "a-lookup-math": () => margin(at("O1060", 61)),
  "b-lookup-math": () => { needs(!prod(at("O1141", 142)[o.product]), "O1141's product must be unpriced"); return 0; },
  "a-pivot-story": () => { const m = withGrand(groupSum(O, catOf, mar3), sum(O.map(mar3))); const t = top(Object.fromEntries(Object.entries(m).filter(([k]) => k !== "Grand Total"))); return { totals: m, top: t, amount: m[t] }; },
  "b-pivot-story": () => { const m = withGrand(groupSum(O, x => x[o.rep], rev3), ALLREV); const t = top(Object.fromEntries(Object.entries(m).filter(([k]) => k !== "Grand Total"))); return { totals: m, top: t, amount: m[t] }; },
  "a-clean-1": () => ({ defects: defectsOfKind("duplicate", "blank") }),
  "a-clean-2": () => ({ defects: defectsOfKind("text-standardise", "number-as-text", "misspelling", "future-date") }),
  "b-clean-1": () => ({ defects: defectsOfKind("text-standardise", "number-as-text") }),
  "b-clean-2": () => ({ defects: defectsOfKind("duplicate", "blank", "misspelling", "future-date") }),
};
const MOCK_MUST_FAIL = {
  "a-sumifs": ['=SUMIF(E2:E181,"Sofia Papadaki",G2:G181)', '=SUMIFS(E2:E181,"Sofia Papadaki",G2:G181,"Field")', "=250"],
  "b-sumifs": ['=SUMIF(C2:C181,"P012",G2:G181)', '=SUMIFS(G2:G181,C2:C181,"P012",D2:D181,Attica)'],
  "a-countifs": ['=COUNTIFS(F2:F181,"Partner",G2:G181,">10")', '=COUNTIF(F2:F181,"Partner")'],
  "b-countifs": ['=COUNTIF(D2:D181,"Macedonia")', '=SUMIFS(G2:G181,D2:D181,"Macedonia",F2:F181,"Online")'],
  "a-logic": ['=ROUND(SUMIF(D2:D181,"Attica",G2:G181)/COUNTIF(D2:D181,"Attica"),0)', '=SUMIF(D2:D181,"Attica",G2:G181)/COUNTIF(D2:D181,"Attica")', '=ROUND(SUMIF(D2:D181,"Attica",G2:G181)/COUNTA(D2:D181),1)'],
  "b-logic": ['=IF(COUNTIF(D2:D181,"Thessaly")>=250,"Yes","No")', '="Yes"'],
  "a-vlookup": ["=VLOOKUP(C34,$J$2:$N$15,2,FALSE)", "=VLOOKUP(C34,$J$2:$N$15,3)", "=VLOOKUP(C34,J2:N15,3,FALSE)"],
  "b-vlookup": ["=VLOOKUP(C78,$J$2:$N$15,4,FALSE)", "=VLOOKUP(C78,$J$2:$N$15,5)", "=VLOOKUP(C78,J2:N15,5,FALSE)"],
  "a-approx": ["=VLOOKUP(G147,$V$2:$X$5,2,FALSE)", "=VLOOKUP(G147,$V$2:$X$5,3,TRUE)"],
  "b-approx": ["=VLOOKUP(G170,$V$2:$X$5,2,FALSE)", "=VLOOKUP(G170,$V$2:$X$5,3,TRUE)"],
  "a-index": ["=INDEX($P$2:$P$8,MATCH(E151,$Q$2:$Q$8))", "=MATCH(E151,$Q$2:$Q$8,0)", '="R02"'],
  "b-index": ['=INDEX($J$2:$J$15,MATCH("Headset Pro",$K$2:$K$15))', '=MATCH("Headset Pro",$K$2:$K$15,0)'],
  "a-lookup-math": ["=G61*VLOOKUP(C61,$J$2:$N$15,5,FALSE)-G61*VLOOKUP(C61,$J$2:$N$15,4,FALSE)", "=G61*VLOOKUP(C61,$J$2:$N$15,5,FALSE)*(1-H61)"],
  "b-lookup-math": ["=G142*VLOOKUP(C142,$J$2:$N$15,5,FALSE)*(1-H142)", "=G142*0", "=0"],
};
const ALL7 = A3_ALL;
const mockWS = (variant, over = {}) => {
  const ws = workbenchSubmission(DATASETS[MOCK.dataset], MOCK.lab.panels, {});
  const sols = MOCK.variants.find(v => v.id === variant).tasks.map(id => MKEY.solutions[id]).filter(x => x && typeof x === "object");
  const base = { ops: sols.flatMap(x => x.steps || []), pivot: sols.find(x => x.pivot)?.pivot, story: sols.find(x => x.story)?.story };
  return workspaceOf(DATASETS[MOCK.dataset], MOCK.lab.panels, { ...base, ...over, story: over.story ? { ...base.story, ...over.story, blanks: { ...base.story.blanks, ...(over.story.blanks || {}) } } : base.story }) || ws;
};
s.test("capstone gate: schema valid, key complete, 2 variants × 10 tasks, same slots, no shared tasks", () => {
  eq(validateGate(MOCK, { taskId: "mock-test", level: null }), []); eq(validateKey(MKEY, MOCK), []);
  eq(MOCK.variants.map(v => v.tasks.length), [10, 10]);
});
s.test("the variants span every level: L1 aggregates, L2 lookups, L3 cleaning + pivot + story", () => {
  const slots = MOCK.variants[0].tasks.map(id => MOCK.pool.find(t => t.id === id).slot);
  for (const x of ["sumifs", "countifs", "logic", "vlookup", "approx", "index-match", "lookup-math", "clean-1", "clean-2", "pivot-story"]) assert(slots.includes(x), x);
});
s.test("the task file holds no answers", () => {
  const raw = readFileSync(new URL(curriculum.levels.find(l => l.id === "capstone").gate.content, root), "utf8");
  for (const sol of Object.values(MKEY.solutions).filter(x => typeof x === "string")) assert(!raw.includes(sol.replace(/^=/, "")), sol);
});
for (const t of MOCK.pool.filter(t => typeof MKEY.solutions[t.id] === "string")) {
  const cells = DATASETS[t.dataset || MOCK.dataset].cells, sol = MKEY.solutions[t.id];
  s.test(`mock ${t.id}: key passes`, () => { const v = grade({ formula: sol, result: evaluate(sol, cells) }, t.answerCheck); assert(v.pass, `${sol} → ${v.message}`); });
  s.test(`mock ${t.id}: expected value matches the independent oracle`, () => { assert(MOCK_ORACLE[t.id], "no oracle"); const e = checksOf(t.answerCheck).find(c => c.type === "value").expect; assert(closeTo(MOCK_ORACLE[t.id](), e), `content ${e}, oracle ${MOCK_ORACLE[t.id]()}`); });
  for (const f of MOCK_MUST_FAIL[t.id] || []) s.test(`mock ${t.id}: ${f} fails`, () => eq(grade({ formula: f, result: evaluate(f, cells) }, t.answerCheck).pass, false));
}
for (const v of MOCK.variants) {
  const tasks = v.tasks.map(id => MOCK.pool.find(t => t.id === id)), ws = mockWS(v.id);
  for (const t of tasks.filter(t => typeof MKEY.solutions[t.id] !== "string")) {
    s.test(`mock ${v.id} · ${t.id}: the variant's key workspace passes`, () => { const r = grade(ws, t.answerCheck); assert(r.pass, r.message); });
    s.test(`mock ${v.id} · ${t.id}: figures match the oracle`, () => {
      const want = MOCK_ORACLE[t.id](), cs = checksOf(t.answerCheck);
      if (want.defects) eq(cs[0].defects.map(d => d.id).sort(), [...want.defects].sort());
      if (want.totals) { const pc = cs.find(c => c.type === "pivot-state"); eq(Object.keys(pc.totals).sort(), Object.keys(want.totals).sort()); for (const [k, x] of Object.entries(want.totals)) assert(Math.abs(pc.totals[k] - x) <= pc.tolerance, k);
        const st = cs.find(c => c.type === "story"); eq(st.blanks.top, want.top); assert(Math.abs(st.blanks.amount.expect - want.amount) <= st.blanks.amount.tolerance, "amount"); }
    });
  }
  const pvTask = tasks.find(t => t.slot === "pivot-story");
  s.test(`mock ${v.id}: a stale pivot, an unclean export or a wrong top answer fails the slide task`, () => {
    eq(grade(mockWS(v.id, { cacheOps: [] }), pvTask.answerCheck).reason, "pivot-stale");
    eq(grade(mockWS(v.id, { ops: [] }), pvTask.answerCheck).pass, false);
    eq(grade(mockWS(v.id, { story: { blanks: { top: v.id === "A" ? "Computers" : "Maria Ioannou" } } }), pvTask.answerCheck).pass, false);
    eq(grade(mockWS(v.id, { story: { sort: "none" } }), pvTask.answerCheck).pass, false);
  });
  s.test(`mock ${v.id}: each cleaning task fails when its moves are left out`, () => {
    for (const t of tasks.filter(t => t.slot.startsWith("clean"))) {
      const own = MKEY.solutions[t.id].steps, others = v.tasks.map(id => MKEY.solutions[id]).filter(x => x?.steps && x.steps !== own).flatMap(x => x.steps);
      eq(grade(mockWS(v.id, { ops: others }), t.answerCheck).pass, false, t.id);
    }
  });
  s.test(`mock ${v.id}: the whole key scores 10/10 in time; the same answers after 45:00 don't pass`, async () => {
    const { gradeMockTest } = await import("./ui/mocktest.js");
    const answers = Object.fromEntries(tasks.filter(t => typeof MKEY.solutions[t.id] === "string").map(t => [t.id, MKEY.solutions[t.id]]));
    const g = gradeMockTest(MOCK, v.id, answers, ws, 30 * 60); eq([g.score, g.passed], [10, true]);
    eq(gradeMockTest(MOCK, v.id, answers, ws, 45 * 60 + 1).passed, false);
    const two = { ...answers }; delete two[tasks[0].id]; delete two[tasks[1].id]; eq(gradeMockTest(MOCK, v.id, two, ws, 600).passed, true);  // 8/10 passes
    delete two[tasks[2].id]; eq(gradeMockTest(MOCK, v.id, two, ws, 600).passed, false);                                                  // 7/10 doesn't
  });
}
s.test("every mock pool task has an oracle; every formula task has a trap", () => {
  eq(MOCK.pool.filter(t => !MOCK_ORACLE[t.id]).map(t => t.id), []);
  eq(MOCK.pool.filter(t => typeof MKEY.solutions[t.id] === "string" && t.id !== "b-lookup-math" && !(MOCK_MUST_FAIL[t.id] || []).length).map(t => t.id), []);
});

s.group("Case A");
const caseEntry = curriculum.cases.find(k => k.id === "case-a"), CASE = readJSON(caseEntry.content), CDS = DATASETS[CASE.dataset];
const q3rows = O.filter(x => qtrOf(x[o.date]) === "Qtr3"), ytdRows = O.filter(x => qtrOf(x[o.date]) !== "Qtr4");
const q3Region = groupSum(q3rows, x => x[o.region], rev3), ytdRep = groupSum(ytdRows, x => x[o.rep], rev3);
const pctTarget = Object.fromEntries(REPS.map(r => [r[1], ytdRep[r[1]] / (r[4] * 0.75) * 100]));
const lowestPct = Object.keys(pctTarget).reduce((a, b) => (pctTarget[a] <= pctTarget[b] ? a : b)), lowestRev = Object.keys(ytdRep).reduce((a, b) => (ytdRep[a] <= ytdRep[b] ? a : b));
const q3Order = Object.keys(q3Region).sort((a, b) => q3Region[b] - q3Region[a]);
const CASE_ORACLE = {
  clean: () => ({ defects: RAW.messy.defects.map(d => d.id) }),
  enrich: () => { const x = byId("O1088"); return revenue(x); },
  "q3-region": () => ({ totals: withGrand(q3Region, sum(q3rows.map(rev3))) }),
  "ytd-rep": () => ({ totals: withGrand(ytdRep, sum(ytdRows.map(rev3))) }),
  target: () => rep("Maria Ioannou")[4] * 0.75,
  finding: () => ({ region: q3Order[0], regionAmount: q3Region[q3Order[0]], runnerUp: q3Order[1], rep: lowestPct, repPct: pctTarget[lowestPct], lowest: lowestRev }),
};
// Replaying the solutions in order = a learner doing the case; each step is checked at that moment.
const { resolveRowRefs, gradeStep } = await import("./ui/case.js");
function caseState(stepsDone) {
  const sols = CASE.steps.slice(0, stepsDone).map(x => x.solution);
  const ops = sols.flatMap(x => x.steps || []), pivot = sols.map(x => x.pivot).filter(Boolean).at(-1), story = sols.map(x => x.story).filter(Boolean).at(-1);
  return { ops, pivot, story, st: replay(CDS, ops) };
}
s.test("Case A: schema valid, listed in curriculum, unlocked by Assignment 3", () => { eq(validateCase(CASE, { id: "case-a" }), []); eq(caseEntry.requires, "a3-messy-export"); });
CASE.steps.forEach((step, i) => {
  s.test(`Case A step ${i + 1} (${step.id}): passes after doing steps 1–${i + 1} in order`, () => {
    const { ops, pivot, story, st } = caseState(i + 1);
    const ws = workspaceOf(CDS, CASE.lab.panels, { ops, pivot, story });
    const formula = step.solution.formula ? resolveRowRefs(step.solution.formula, st.rows) : "";
    const v = gradeStep(step, { workspace: ws, formula, cells: cellsOf(st, CDS) }); assert(v.pass, v.message);
  });
});
s.test("Case A: every figure matches the independent oracle", () => {
  const by = Object.fromEntries(CASE.steps.map(x => [x.id, x]));
  eq(checksOf(by.clean.answerCheck)[0].defects.map(d => d.id).sort(), CASE_ORACLE.clean().defects.sort());
  assert(Math.abs(checksOf(by.enrich.answerCheck)[0].expect - CASE_ORACLE.enrich()) < 1e-6, "enrich");
  for (const k of ["q3-region", "ytd-rep"]) { const pc = checksOf(by[k].answerCheck)[0], want = CASE_ORACLE[k]().totals; eq(Object.keys(pc.totals).sort(), Object.keys(want).sort()); for (const [x, v] of Object.entries(want)) assert(Math.abs(pc.totals[x] - v) <= pc.tolerance, `${k}.${x}`); }
  eq(checksOf(by.target.answerCheck)[0].expect, CASE_ORACLE.target());
  const b = checksOf(by.finding.answerCheck)[0].blanks, w = CASE_ORACLE.finding();
  eq([b.region, b.runnerUp, b.rep, b.lowest].map(x => x.expect ?? x), [w.region, w.runnerUp, w.rep, w.lowest]);
  assert(Math.abs(b.regionAmount.expect - w.regionAmount) <= b.regionAmount.tolerance && Math.abs(b.repPct.expect - w.repPct) <= b.repPct.tolerance, "numbers");
});
s.test("Case A's point: the rep furthest behind target is NOT the rep with the least revenue", () => assert(lowestPct !== lowestRev, `${lowestPct} vs ${lowestRev}`));
s.test("Case A traps: each step fails when done the tempting wrong way", () => {
  const S = Object.fromEntries(CASE.steps.map(x => [x.id, x]));
  const done = caseState(CASE.steps.length), cellsDone = cellsOf(done.st, CDS), raw = replay(CDS, []);
  const f = (step, formula, st) => gradeStep(step, { formula, cells: cellsOf(st, CDS) }).pass;
  eq(f(S.enrich, resolveRowRefs(S.enrich.solution.formula, raw.rows), raw), false);                                      // lookup before the typo is fixed → #N/A
  eq(f(S.enrich, resolveRowRefs("=G{row:O1088}*VLOOKUP(C{row:O1088},$J$2:$N$15,4,FALSE)*(1-H{row:O1088})", done.st.rows), done.st), false); // UnitCost, not ListPrice
  eq(f(S.enrich, resolveRowRefs("=G{row:O1088}*VLOOKUP(C{row:O1088},$J$2:$N$15,5)*(1-H{row:O1088})", done.st.rows), done.st), false);       // no FALSE
  eq(f(S.target, '=VLOOKUP("Maria Ioannou",$Q$2:$T$8,4,FALSE)', done.st), false);                                          // the annual target, not to date
  eq(f(S.target, '=VLOOKUP("Maria Ioannou",$Q$2:$T$8,3,FALSE)*0.75', done.st), false);                                    // HireDate column
  const ws = over => workspaceOf(CDS, CASE.lab.panels, { ops: done.ops, pivot: done.pivot, story: done.story, ...over });
  const cfgQ = S["q3-region"].solution.pivot, cfgY = S["ytd-rep"].solution.pivot;
  eq(grade(ws({ pivot: { ...cfgQ, filter: null } }), S["q3-region"].answerCheck).pass, false);                               // whole year
  eq(grade(ws({ pivot: cfgQ, ops: [] }), S["q3-region"].answerCheck).pass, false);                                        // messy data
  eq(grade(ws({ pivot: cfgQ, cacheOps: [] }), S["q3-region"].answerCheck).reason, "pivot-stale");                          // not refreshed
  eq(grade(ws({ pivot: { ...cfgY, filter: null } }), S["ytd-rep"].answerCheck).pass, false);                               // Qtr4 included
  const fs = S.finding.solution.story;
  eq(grade(ws({ story: { ...fs, blanks: { ...fs.blanks, rep: lowestRev } } }), S.finding.answerCheck).pass, false);        // lowest revenue ≠ furthest behind target
  eq(grade(ws({ story: { ...fs, blanks: { ...fs.blanks, region: "Macedonia", runnerUp: "Attica" } } }), S.finding.answerCheck).pass, false);
  eq(grade(ws({ story: { ...fs, chart: "pie" } }), S.finding.answerCheck).pass, false);
});
s.test("Case A: nothing passes on the untouched export except the target lookup (which only reads the clean Reps table)", () => {
  const raw = replay(CDS, []), ws = workspaceOf(CDS, CASE.lab.panels, {});
  const passing = CASE.steps.filter(x => gradeStep(x, { workspace: ws, formula: x.solution.formula ? resolveRowRefs(x.solution.formula, raw.rows) : "", cells: cellsOf(raw, CDS) }).pass).map(x => x.id);
  eq(passing, ["target"]);
});

s.group("cheat-sheet (Phase 9)");
const CHEAT = readJSON("cheatsheet.json");
s.test("cheatsheet.json is valid", async () => { const { validateCheatsheet } = await import("./ui/cheatsheet.js"); eq(validateCheatsheet(CHEAT), []); });
for (const r of CHEAT.blocks.flatMap(b => b.rows).filter(r => r.formula)) {
  s.test(`cheat-sheet formula runs on the practice data: ${r.formula}`, () => {
    const res = evaluate(r.formula, DATASETS.aegean.cells); assert(res.ok, `${r.formula} → ${res.error?.code} ${res.error?.message}`);
    if ("expect" in r) assert(closeTo(res.value, r.expect), `${res.value}`);
  });
}
s.test("cheat-sheet lookups practise what they preach: exact VLOOKUPs end with FALSE, tables are locked", () => {
  for (const r of CHEAT.blocks.flatMap(b => b.rows).filter(r => /VLOOKUP|INDEX|XLOOKUP/.test(r.formula || ""))) {
    assert(/\$[A-Z]\$\d/.test(r.formula), `unlocked table in ${r.formula}`);
    if (/VLOOKUP/.test(r.formula) && !/TRUE\)$/.test(r.formula) && !/Approximate/.test(r.what)) assert(/FALSE\)/.test(r.formula), `no FALSE in ${r.formula}`);
  }
});
s.test("the cheat-sheet's XLOOKUP line carries the version caveat (spec §13)", () => assert(CHEAT.blocks.flatMap(b => b.rows).find(r => /XLOOKUP/.test(r.formula || "")).what.includes("365"), "caveat"));

s.report();
