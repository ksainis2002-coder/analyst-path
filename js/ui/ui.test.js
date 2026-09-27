/* ui.test.js: pure (no-DOM) tests for data.js, ui/sheet.js and ui/console.js helpers.
   Run with `node js/ui/ui.test.js`. The DOM behaviour is covered by ui.dom.test.js (browser: dev/test.html). */
import { parseRange, rangeOf, displayValue, planHighlights, stepDelay, ROLE_CLASS } from "./sheet.js";
import { formatValue, ERROR_HINTS } from "./console.js";
import { toCells, colToIndex, indexToCol, V1_SAMPLE, DATASETS } from "../data.js";
import { evaluate } from "../engine.js";
import { markdown, inline } from "./md.js";
import { scoreQuiz } from "./quiz.js";
import { renderSignature } from "./lesson.js";
import { countdown, formatClock, crossed } from "./timer.js";
import { createSuite, eq, assert } from "../testkit.js";

const s = createSuite("ui (pure)");

s.group("data.js: toCells");
s.test("column letters round-trip", () => { eq([1, 26, 27, 52, 703].map(indexToCol), ["A", "Z", "AA", "AZ", "AAA"]); eq(["A", "Z", "AA", "AZ", "AAA"].map(colToIndex), [1, 26, 27, 52, 703]); });
s.test("header + rows placed from the origin", () =>
  eq(toCells([{ origin: "B2", header: ["x", "y"], rows: [[1, 2], [3, null]] }]), { B2: "x", C2: "y", B3: 1, C3: 2, B4: 3 }));
s.test("empty values are left out (blank cells)", () => eq(Object.keys(toCells([{ origin: "A1", rows: [["", null, undefined, 0]] }])), ["D1"]));
s.test("overlapping tables are rejected", () => {
  let threw = false; try { toCells([{ origin: "A1", rows: [[1, 2]] }, { origin: "B1", rows: [[3]] }]); } catch { threw = true; }
  assert(threw, "should throw");
});
s.test("result is frozen", () => assert(Object.isFrozen(toCells([{ origin: "A1", rows: [[1]] }])), "frozen"));

s.group("data.js: V1_SAMPLE");
s.test("matches the v1 layout: headers, first/last rows, product table", () => {
  const c = V1_SAMPLE.cells;
  eq([c.A1, c.F1, c.H1, c.J1], ["OrderID", "Quantity", "ProductID", "UnitPrice"]);
  eq([c.A2, c.C2, c.F2, c.A25, c.F25], ["O1000", "P006", 3, "O1023", 9]);
  eq([c.H9, c.I9, c.J9], ["P008", "USB Hub", 35]);
  assert(!("G2" in c) && !("A26" in c), "G is empty and there is no row 26");
});
s.test("the engine gets the v1 answers from it (SUM 241, North 74, VLOOKUP Webcam)", () => {
  eq(evaluate("SUM(F2:F25)", V1_SAMPLE.cells).value, 241);
  eq(evaluate('SUMIFS(F2:F25,D2:D25,"North")', V1_SAMPLE.cells).value, 74);
  eq(evaluate("VLOOKUP(C2,H2:J9,2,FALSE)", V1_SAMPLE.cells).value, "Webcam");
  eq(evaluate('SUMIFS(F2:F25,D2:D25,"North",C2:C25,"P002")', V1_SAMPLE.cells).value, 26); // the fixed v1 chip
});
s.test("registered by id", () => assert(DATASETS["v1-sample"] === V1_SAMPLE, "registry"));
s.test("declared range covers every cell", () => eq(rangeOf(V1_SAMPLE.cells), V1_SAMPLE.range));

s.group("sheet.js helpers");
s.test("parseRange normalises order and strips $", () => { eq(parseRange("A1:J25"), { c1: 1, r1: 1, c2: 10, r2: 25 }); eq(parseRange("$J$25:$A$1"), { c1: 1, r1: 1, c2: 10, r2: 25 }); });
s.test("parseRange rejects junk", () => { let t = false; try { parseRange("A1"); } catch { t = true; } assert(t, "should throw"); });
s.test("rangeOf finds the extent from A1", () => eq(rangeOf({ B3: 1, D2: "x" }), "A1:D3"));
s.test("displayValue: raw like Excel General", () => eq([displayValue(1330), displayValue(true), displayValue(undefined), displayValue("P001")], ["1330", "TRUE", "", "P001"]));
s.test("planHighlights keeps engine order, drops unknown roles, off-sheet cells and exact repeats", () => {
  const hl = [{ cell: "C2", role: "search" }, { cell: "H2", role: "scan" }, { cell: "H2", role: "scan" }, { cell: "H2", role: "match" },
              { cell: "Z99", role: "return" }, { cell: "I2", role: "glow" }, { cell: "I2", role: "return" }];
  eq(planHighlights(hl, k => k !== "Z99"), [{ cell: "C2", role: "search" }, { cell: "H2", role: "scan" }, { cell: "H2", role: "match" }, { cell: "I2", role: "return" }]);
});
s.test("every engine role has a class", () => eq(Object.keys(ROLE_CLASS), ["scan", "search", "match", "return"]));
s.test("stepDelay: a full 24-row scan plays in under a second", () => { assert(stepDelay(30) * 30 <= 900, "too slow"); eq(stepDelay(1), 0); assert(stepDelay(1000) >= 8, "floor"); });

s.group("console.js helpers");
s.test("formatValue: integers and grouping (en-US)", () => eq(formatValue(1330).text, "1,330"));
s.test("formatValue: rounding to 2 dp is flagged, with the exact value", () => {
  const f = formatValue(241 / 24); eq([f.text, f.rounded], ["10.04", true]); assert(f.exact.startsWith("10.041666"), f.exact);
});
s.test("formatValue: exact values aren't flagged", () => eq(formatValue(10.04).rounded, false));
s.test("formatValue: text passes through", () => eq(formatValue("Webcam").text, "Webcam"));
s.test("every error code the engine can return has a hint", () => {
  for (const code of ["#N/A", "#REF!", "#NAME?", "#DIV/0!", "#VALUE!", "", null]) assert(typeof ERROR_HINTS[code] === "string" && ERROR_HINTS[code].length > 10, `missing hint for ${code}`);
});
s.test("the codes the engine actually produces are all hinted", () => {
  const codes = ['VLOOKUP("P999",H2:J9,2,FALSE)', "INDEX(H2:H9,99)", "FOO(1)", "F2/0", 'SUM("abc")', ""].map(f => evaluate(f, V1_SAMPLE.cells).error.code);
  codes.forEach(c => assert(c in ERROR_HINTS || String(c) in ERROR_HINTS, `no hint for ${c}`));
});

s.group("md.js (lesson Markdown)");
s.test("escapes HTML before anything else (content can't inject markup)", () => {
  eq(inline('<img src=x onerror="alert(1)"> **b**'), '&lt;img src=x onerror=&quot;alert(1)&quot;&gt; <strong>b</strong>');
  assert(!markdown("<script>alert(1)</script>").includes("<script>"), "script escaped");
});
s.test("code spans keep * and $ untouched", () => eq(inline("`=F3*$J$3` and *em*"), '<code class="fx-chip">=F3*$J$3</code> and <em>em</em>'));
s.test("paragraphs, bullets, numbered lists", () => {
  const h = markdown("One\ntwo\n\n- a\n- b\n\n1. x\n2. y");
  eq(h, "<p>One two</p>\n<ul><li>a</li><li>b</li></ul>\n<ol><li>x</li><li>y</li></ol>");
});
s.test("typed callouts", () => {
  const h = markdown("> [!warn] Careful **now**");
  assert(h.includes('class="callout callout--warn"') && h.includes("Watch out") && h.includes("<strong>now</strong>"), h);
});
s.test("a line starting with ** is a paragraph, not a list", () => eq(markdown("**Bold** start"), "<p><strong>Bold</strong> start</p>"));

s.group("quiz scoring");
const QS = [{ answer: 0 }, { answer: 2 }, { answer: 1 }];
s.test("all right", () => eq(scoreQuiz(QS, [0, 2, 1]), { score: 3, total: 3, passed: true, correct: [true, true, true] }));
s.test("pass mark respected", () => { eq(scoreQuiz(QS, [0, 2, 0], 2).passed, true); eq(scoreQuiz(QS, [0, 2, 0]).passed, false); });
s.test("unanswered counts as wrong", () => eq(scoreQuiz(QS, [null, 2, 1]).score, 2));

s.group("syntax chip");
s.test("each argument gets its own colour, in order; ellipsis stays plain", () => {
  const h = renderSignature("=SUMIFS(sum_range, criteria_range1, criteria1, …)");
  assert(h.includes('syn-arg--1">sum_range') && h.includes('syn-arg--2">criteria_range1') && h.includes('syn-arg--3">criteria1') && h.includes('syn-ellipsis">…'), h);
});
s.test("non-function signatures are shown as-is, escaped", () => eq(renderSignature("=F2*$J$3<b>"), "<span>=F2*$J$3&lt;b&gt;</span>"));

s.group("timer (Phase 7)");
const T0 = 1_000_000;
s.test("counts down from the start timestamp, whole seconds, never below 0", () => {
  eq(countdown({ durationSec: 2700, startedAt: T0, now: T0 }), { elapsed: 0, remaining: 2700, expired: false, warning: false, final: false });
  eq(countdown({ durationSec: 2700, startedAt: T0, now: T0 + 1999 }).remaining, 2699);
  const end = countdown({ durationSec: 2700, startedAt: T0, now: T0 + 99e6 }); eq([end.remaining, end.elapsed, end.expired], [0, 2700, true]);
});
s.test("a reload doesn't reset it (it's anchored to when you started)", () => eq(countdown({ durationSec: 600, startedAt: T0, now: T0 + 400e3 }).remaining, 200));
s.test("warning in the last 5 minutes, final in the last minute", () => {
  eq(countdown({ durationSec: 2700, startedAt: T0, now: T0 + (2700 - 300) * 1000 }).warning, true);
  eq(countdown({ durationSec: 2700, startedAt: T0, now: T0 + (2700 - 301) * 1000 }).warning, false);
  eq(countdown({ durationSec: 2700, startedAt: T0, now: T0 + (2700 - 60) * 1000 }).final, true);
});
s.test("formatClock", () => { eq(formatClock(2700), "45:00"); eq(formatClock(65), "1:05"); eq(formatClock(0), "0:00"); eq(formatClock(3725), "1:02:05"); });
s.test("announcements only when a threshold is crossed", () => { eq(crossed(601, 599), [600]); eq(crossed(599, 598), []); eq(crossed(2700, 30), [600, 300, 60]); });

s.report();
