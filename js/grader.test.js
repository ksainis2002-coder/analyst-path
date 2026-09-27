/* grader.test.js: run with `node js/grader.test.js` */
import { grade, referencesCells, usesFunction, hasAbsolute, stripStrings, hasLockedRange, callArgs, parseAnswerNumber } from "./grader.js";
import { evaluate } from "./engine.js";
import { V1_SAMPLE } from "./data.js";
import { createSuite, eq, assert } from "./testkit.js";

const s = createSuite("grader");
const sub = f => ({ formula: f, result: evaluate(f, V1_SAMPLE.cells) });
const g = (f, check) => grade(sub(f), check);

s.group("helpers");
s.test("stripStrings removes quoted text", () => eq(stripStrings('SUMIFS(F2:F25,D2:D25,"SUM(")'), 'SUMIFS(F2:F25,D2:D25,"")'));
s.test("referencesCells: refs, ranges, $ locks; not numbers, not text", () => {
  eq(["F2", "SUM(F2:F25)", "$J$3*2", "241", '"F2"', "ROUND(10.04,1)", "SUM(1,2)"].map(referencesCells), [true, true, true, false, false, false, false]);
});
s.test("usesFunction ignores look-alikes and strings", () => {
  assert(usesFunction("sumifs(F2:F25,D2:D25,1)", "SUMIFS"), "case-insensitive");
  assert(!usesFunction("SUMIFS(F2:F25,D2:D25,1)", "SUMIF"), "SUMIF is not SUMIFS");
  assert(!usesFunction('IF(F2>1,"SUMIF(","x")', "SUMIF"), "inside quotes doesn't count");
  assert(usesFunction("COUNT (F2:F25)", "COUNT"), "space before bracket");
});
s.test("hasAbsolute needs both $ signs on exactly that cell", () => {
  eq(["F3*$J$3", "F3*J$3", "F3*$J3", "F3*$J$30", "SUM($H$2:$J$3)", 'F3*"$J$3"'].map(f => hasAbsolute(f, "J3")), [true, false, false, false, true, false]);
});

s.group("value");
s.test("correct number passes", () => eq(g("SUM(F2:F25)", { type: "value", expect: 241 }).pass, true));
s.test("wrong number fails with what it returned", () => {
  const r = g("SUM(F2:F24)", { type: "value", expect: 241 });
  eq([r.pass, r.reason], [false, "wrong-value"]); assert(r.message.includes("232"), r.message);
});
s.test("typed-in answer is refused by default", () => eq(g("241", { type: "value", expect: 241 }).reason, "no-reference"));
s.test("allowLiteral permits it", () => eq(g("241", { type: "value", expect: 241, allowLiteral: true }).pass, true));
s.test("text: case-insensitive and trimmed, like Excel =", () => {
  eq(g('IF(F2>10,"HIGH","ok")', { type: "value", expect: "OK" }).pass, true);
  eq(g('IF(F2>10,"HIGH","OK ")', { type: "value", expect: "OK" }).pass, true);
});
s.test("a number is not its text", () => eq(g('IF(F2>1,"3",0)', { type: "value", expect: 3 }).pass, false));
s.test("booleans compare with TRUE/FALSE", () => eq(g("F2>2", { type: "value", expect: true }).pass, true));
s.test("tolerance for rounding drills", () => {
  eq(g("AVERAGE(F2:F25)", { type: "value", expect: 10.04 }).pass, false);
  eq(g("AVERAGE(F2:F25)", { type: "value", expect: 10.04, tolerance: 0.005 }).pass, true);
});
s.test("Excel errors explain themselves", () => {
  const r = g("F2/G2", { type: "value", expect: 0 });
  eq(r.reason, "error"); assert(r.message.includes("#DIV/0!") && r.message.includes("divided"), r.message);
});
s.test("empty formula", () => { const r = g("", { type: "value", expect: 1 }); eq([r.reason, r.message], ["empty", "No formula yet."]); });
s.test("leading = is fine", () => eq(g("=SUM(F2:F25)", { type: "value", expect: 241 }).pass, true));

s.group("formula-uses");
s.test("required function present / missing", () => {
  eq(g('SUMIFS(F2:F25,D2:D25,"North")', { type: "formula-uses", functions: ["SUMIFS"] }).pass, true);
  eq(g('SUMIF(D2:D25,"North",F2:F25)', { type: "formula-uses", functions: ["SUMIFS"] }).reason, "missing-function");
});
s.test("absolute lock required", () => {
  eq(g("F3*$J$3", { type: "formula-uses", absolute: ["J3"] }).pass, true);
  const r = g("F3*J3", { type: "formula-uses", absolute: ["J3"] });
  eq(r.reason, "missing-absolute"); assert(r.message.includes("$J$3"), r.message);
});

s.test("refs: must point at that cell (typed text doesn't count)", () => {
  eq(g("COUNTIF(D2:D25,D2)", { type: "formula-uses", refs: ["D2"] }).pass, true);
  eq(g("COUNTIF(D2:D25,$D$2)", { type: "formula-uses", refs: ["D2"] }).pass, true);
  eq(g('COUNTIF(D2:D25,"West")', [{ type: "value", expect: 6 }, { type: "formula-uses", refs: ["D2"] }]).reason, "missing-ref");
  eq(g("COUNTIF(D2:D25,D20)", { type: "formula-uses", refs: ["D2"] }).pass, false);
});

s.group("combined checks (array = all must pass)");
const SUMIFS_NORTH = [{ type: "value", expect: 74 }, { type: "formula-uses", functions: ["SUMIFS"] }];
s.test("right value + right method passes", () => eq(g('SUMIFS(F2:F25,D2:D25,"North")', SUMIFS_NORTH).pass, true));
s.test("right value, wrong method: gentle 'Right answer, but…'", () => {
  const r = g('SUMIF(D2:D25,"North",F2:F25)', SUMIFS_NORTH);
  eq(r.reason, "missing-function"); assert(r.message.startsWith("Right answer, but"), r.message);
});
s.test("wrong value is reported before method", () => eq(g('SUMIF(D2:D25,"South",F2:F25)', SUMIFS_NORTH).reason, "wrong-value"));
s.test("the SUMIF-vs-SUMIFS argument-order trap is caught", () => {
  // sum range written last, SUMIF-style, inside SUMIFS → criteria pair is misaligned
  const r = g('SUMIFS(D2:D25,"North",F2:F25)', SUMIFS_NORTH);
  eq(r.pass, false);
});
s.test("unknown check type throws (content can't use checks that don't exist)", () => {
  let t = false; try { g("SUM(F2:F3)", { type: "chart-state" }); } catch { t = true; } assert(t, "should throw");
});

s.group("formula-uses: oneOf");
const EITHER = [{ type: "value", expect: 50 }, { type: "formula-uses", oneOf: ["SUMIF", "SUMIFS"] }];
s.test("either function passes", () => {
  eq(g('SUMIF(D2:D25,"West",F2:F25)', EITHER).pass, true);
  eq(g('SUMIFS(F2:F25,D2:D25,"West")', EITHER).pass, true);
});
s.test("neither → names both", () => {
  const r = g("F2+F4+F5+F12+F16+F22", EITHER);
  eq(r.reason, "missing-function"); assert(r.message.includes("SUMIF or SUMIFS") && r.message.startsWith("Right answer, but"), r.message);
});

s.group("formula-uses: lockedRanges");
s.test("hasLockedRange: fully locked table, any rows, or locked whole columns", () => {
  const f = x => hasLockedRange(x, "H:J");
  eq(["VLOOKUP(C2,$H$2:$J$9,2,FALSE)", "VLOOKUP(C2,$H$1:$J$30,2,FALSE)", "VLOOKUP(C2,$H:$J,2,FALSE)",
      "VLOOKUP(C2,H2:J9,2,FALSE)", "VLOOKUP(C2,$H2:$J9,2,FALSE)", "VLOOKUP(C2,$H$2:$I$9,2,FALSE)", 'VLOOKUP(C2,H2:J9,"$H$2:$J$9")'].map(f),
     [true, true, true, false, false, false, false]);
});
s.test("unlocked table: 'Right answer, but lock the lookup table…'", () => {
  const chk = [{ type: "value", expect: "Webcam" }, { type: "formula-uses", lockedRanges: ["H:J"] }];
  const r = g("VLOOKUP(C2,H2:J9,2,FALSE)", chk);
  eq(r.reason, "missing-lock"); assert(r.message.startsWith("Right answer, but lock the lookup table") && r.message.includes("$H$2:$J$"), r.message);
  eq(g("VLOOKUP(C2,$H$2:$J$9,2,FALSE)", chk).pass, true);
});

s.group("formula-uses: exactMatch");
s.test("callArgs splits each call's top-level args, ignoring commas in quotes and nested calls", () => {
  eq(callArgs('IFERROR(VLOOKUP("a,b",H2:J9,2,FALSE),VLOOKUP(C2,H2:J9,MATCH(1,J2:J9,0)))', "VLOOKUP"),
     [['"___"', "H2:J9", "2", "FALSE"], ["C2", "H2:J9", "MATCH(1,J2:J9,0)"]]);
});
const EXACT = [{ type: "value", expect: "Webcam" }, { type: "formula-uses", exactMatch: true }];
s.test("VLOOKUP with FALSE or 0 passes; omitted or TRUE is 'Right answer, but end the VLOOKUP with FALSE…'", () => {
  eq(g("VLOOKUP(C2,H2:J9,2,FALSE)", EXACT).pass, true); eq(g("VLOOKUP(C2,H2:J9,2,0)", EXACT).pass, true);
  const r = g("VLOOKUP(C2,H2:J9,2)", EXACT);
  eq(r.reason, "not-exact"); assert(r.message.startsWith("Right answer, but end the VLOOKUP with FALSE"), r.message);
  eq(g("VLOOKUP(C2,H2:J9,2,TRUE)", EXACT).reason, "not-exact");
});
s.test("MATCH needs match_type 0", () => {
  const c = [{ type: "value", expect: "P002" }, { type: "formula-uses", exactMatch: true }];
  eq(g('INDEX(H2:H9,MATCH("Monitor",I2:I9,0))', c).pass, true);
  eq(g("INDEX(H2:H9,MATCH(190,J2:J9))", c).reason, "wrong-value"); // unsorted prices: approximate MATCH silently returns the wrong product
});
s.test("XLOOKUP is exact by default, so it passes", () =>
  eq(g('XLOOKUP("P006",H2:H9,I2:I9)', EXACT).pass, true));

s.group("pivot-state");
const PIV = { type: "pivot-state", expect: { rows: "Region", columns: "", value: "Revenue", agg: "sum" }, totals: { North: 100, South: 50 } };
const pv = pivot => grade({ pivot }, PIV);
s.test("matching layout + totals passes (no formula needed)", () => eq(pv({ rows: "Region", columns: null, value: "Revenue", agg: "Sum", totals: { North: 100, South: 50, East: 7 } }).pass, true));
s.test("wrong rows field names both sides", () => {
  const r = pv({ rows: "Rep", columns: "", value: "Revenue", agg: "sum", totals: {} });
  eq(r.reason, "pivot-config"); assert(r.message.includes('Rows is "Rep"') && r.message.includes('"Region"'), r.message);
});
s.test("an extra Columns field is caught", () => eq(pv({ rows: "Region", columns: "Month", value: "Revenue", agg: "sum" }).reason, "pivot-config"));
s.test("right layout, stale pivot (data changed since the last Refresh) → the Refresh hint", () => {
  const r = pv({ rows: "Region", columns: "", value: "Revenue", agg: "sum", totals: { North: 90, South: 50 }, stale: true });
  eq(r.reason, "pivot-stale"); assert(r.message.includes("North") && r.message.includes("old numbers") && r.hint.includes("Refresh"), r.message);
});
s.test("right layout, fresh pivot, wrong totals → points at the data, not at Refresh (P6)", () => {
  const r = pv({ rows: "Region", columns: "", value: "Revenue", agg: "sum", totals: { North: 90, South: 50 }, stale: false });
  eq(r.reason, "pivot-totals"); assert(r.hint.includes("cleaning") && !r.hint.includes("Refresh"), r.hint);
});
s.test("no pivot at all", () => eq(pv(undefined).reason, "pivot-missing"));
s.test("Show Values As defaults to No Calculation; a % pivot fails a plain-sum task", () => {
  const C = { type: "pivot-state", expect: { rows: "Region", columns: "", value: "Revenue", agg: "sum", showAs: "none" } };
  eq(grade({ pivot: { rows: "Region", columns: "", value: "Revenue", agg: "sum" } }, C).pass, true);
  const r = grade({ pivot: { rows: "Region", columns: "", value: "Revenue", agg: "sum", showAs: "pct-grand" } }, C);
  assert(r.message.includes('Show Values As is "% of Grand Total"') && r.message.includes('"No Calculation"'), r.message);
});
s.test("filter: field and items must match (order-insensitive); no filter wanted = none allowed", () => {
  const C = { type: "pivot-state", expect: { rows: "Region", value: "Revenue", filter: { field: "Channel", values: ["Online", "Partner"] } } };
  eq(grade({ pivot: { rows: "Region", value: "Revenue", filter: { field: "channel", values: ["partner", "Online"] } } }, C).pass, true);
  eq(grade({ pivot: { rows: "Region", value: "Revenue", filter: { field: "Channel", values: ["Online"] } } }, C).reason, "pivot-config");
  const r = grade({ pivot: { rows: "Region", value: "Revenue", filter: null } }, C); assert(r.message.includes("there's no filter"), r.message);
  const N = { type: "pivot-state", expect: { rows: "Region", value: "Revenue", filter: null } };
  eq(grade({ pivot: { rows: "Region", value: "Revenue", filter: null } }, N).pass, true);
  assert(grade({ pivot: { rows: "Region", value: "Revenue", filter: { field: "Channel", values: ["Online"] } } }, N).message.includes("is filtered"), "filter where none is wanted");
});
s.test("cells and column totals are checked too", () => {
  const C = { type: "pivot-state", expect: { rows: "Region", columns: "Quarter", value: "Revenue", agg: "sum" }, cells: { "North|Qtr4": 10 }, colTotals: { Qtr4: 30 }, tolerance: 0.01 };
  const base = { rows: "Region", columns: "Quarter", value: "Revenue", agg: "sum" };
  eq(grade({ pivot: { ...base, cells: { "North|Qtr4": 10.004 }, colTotals: { Qtr4: 30 } } }, C).pass, true);
  const r = grade({ pivot: { ...base, cells: { "North|Qtr4": 9 }, colTotals: { Qtr4: 30 } } }, C);
  assert(r.message.includes("North × Qtr4"), r.message);
});

s.group("cleaning-done");
const CLEAN = { type: "cleaning-done", defects: [{ id: "dup", label: "duplicate O1012" }, { id: "blank", label: "blank region on O1019" }, "casing"] };
s.test("all fixed passes", () => eq(grade({ cleaning: { fixed: ["dup", "blank", "casing", "extra"] } }, CLEAN).pass, true));
s.test("lists what's left, by label", () => {
  const r = grade({ cleaning: { fixed: ["casing"] } }, CLEAN);
  eq(r.reason, "cleaning-incomplete"); assert(r.message.startsWith("2 issues still to fix") && r.message.includes("duplicate O1012") && r.message.includes("blank region"), r.message);
});
s.test("nothing submitted = nothing fixed", () => eq(grade({}, CLEAN).failures[0].detail, ["dup", "blank", "casing"]));
s.test("damage to good data fails even when every issue is fixed, and is reported first (P6)", () => {
  const r = grade({ cleaning: { fixed: ["dup", "blank", "casing"], damage: ["O1001 is missing", "O1002 is missing", "O1003 is missing"] } }, CLEAN);
  eq(r.reason, "cleaning-damage"); assert(r.message.includes("O1001 is missing") && r.message.includes("and 1 more") && r.hint.includes("Undo"), r.message);
  eq(grade({ cleaning: { fixed: ["dup", "blank", "casing"], damage: ["x"] } }, { ...CLEAN, noDamage: false }).pass, true);
});
s.test("an issue changed to the wrong value says so", () => {
  const r = grade({ cleaning: { fixed: ["dup", "casing"], wrong: ["blank"] } }, CLEAN);
  assert(r.message.includes("blank region on O1019 (changed, but not to the right value)"), r.message);
});

s.group("story (P6)");
const STORY = { type: "story", series: "Qtr4", chart: ["column", "bar"], sort: "desc", titleMentions: ["Macedonia"],
  blanks: { top: "Macedonia", amount: { expect: 48781.8, tolerance: 1, label: "Q4 revenue" }, share: { expect: 42.87, tolerance: 0.5 } } };
const good = { series: "Qtr4", chart: "column", sort: "desc", title: "Macedonia now leads", blanks: { top: "macedonia", amount: "€48,782", share: "42.9%" } };
s.test("a right chart + finding title + right blanks passes (numbers parsed leniently)", () => eq(grade({ story: good }, STORY).pass, true));
s.test("wrong series", () => eq(grade({ story: { ...good, series: "Grand Total" } }, STORY).reason, "story-series"));
s.test("a line chart for categories explains why", () => { const r = grade({ story: { ...good, chart: "line" } }, STORY); eq(r.reason, "story-chart"); assert(r.message.includes("trend"), r.message); });
s.test("a pie for five regions explains why", () => assert(grade({ story: { ...good, chart: "pie" } }, STORY).message.includes("angles"), "pie"));
s.test("unsorted bars", () => eq(grade({ story: { ...good, sort: "none" } }, STORY).reason, "story-sort"));
s.test("time data must stay in order", () => {
  const T = { type: "story", chart: ["line", "column"], data: "time", sort: "none" };
  eq(grade({ story: { chart: "line", sort: "none" } }, T).pass, true);
  assert(grade({ story: { chart: "line", sort: "desc" } }, T).message.includes("scrambles time"), "sort");
  assert(grade({ story: { chart: "pie", sort: "none" } }, T).message.includes("no order"), "pie over time");
});
s.test("an axis-label title isn't a finding", () => { const r = grade({ story: { ...good, title: "Revenue by region, Q4" } }, STORY); eq(r.reason, "story-title"); assert(r.message.includes("describes the chart"), r.message); });
s.test("empty title", () => assert(grade({ story: { ...good, title: " " } }, STORY).message.includes("no title"), "title"));
s.test("each wrong blank is named", () => {
  const r = grade({ story: { ...good, blanks: { top: "Attica", amount: "17139.75", share: "" } } }, STORY);
  eq(r.failures.filter(f => f.reason === "story-blank").map(f => f.detail), ["top", "amount", "share"]);
  assert(r.message.includes('"Attica"'), r.message);
  assert(r.failures.find(f => f.detail === "share").message.includes("missing the share"), "missing blank");
});
s.test("no chart yet", () => eq(grade({}, STORY).reason, "story-missing"));
s.test("parseAnswerNumber", () => { eq(parseAnswerNumber("€48,781.80"), 48781.8); eq(parseAnswerNumber(" 42.9 % "), 42.9); assert(Number.isNaN(parseAnswerNumber("about 40")), "text"); });

s.group("whole-column references count as pointing at cells (P6)");
s.test("=COUNTIF(A:A,\"O1034\") is not a typed-in answer", () => { eq(referencesCells('COUNTIF(A:A,"O1034")'), true); eq(referencesCells('COUNTIF($A:$A,"x")'), true); eq(referencesCells('"A:A"'), false); });

s.group("timed");
s.test("under time passes; over time says by how much", () => {
  eq(grade({ seconds: 119 }, { type: "timed", maxSeconds: 120 }).pass, true);
  const r = grade({ seconds: 192 }, { type: "timed", maxSeconds: 120 });
  eq(r.reason, "too-slow"); assert(r.message.includes("3:12") && r.message.includes("2:00"), r.message);
});
s.test("correct answer but slow → 'Correct, but…'", () => {
  const r = grade({ formula: "SUM(F2:F25)", result: evaluate("SUM(F2:F25)", V1_SAMPLE.cells), seconds: 300 }, [{ type: "value", expect: 241 }, { type: "timed", maxSeconds: 60 }]);
  assert(r.message.startsWith("Correct, but it took 5:00"), r.message);
});
s.test("wrong AND slow → the wrong answer is reported first", () => {
  const r = grade({ formula: "SUM(F2:F24)", result: evaluate("SUM(F2:F24)", V1_SAMPLE.cells), seconds: 300 }, [{ type: "value", expect: 241 }, { type: "timed", maxSeconds: 60 }]);
  eq(r.reason, "wrong-value");
});
s.test("missing time", () => eq(grade({}, { type: "timed", maxSeconds: 60 }).reason, "no-time"));

s.report();
