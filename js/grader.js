/* =========================================================================
   grader.js: answer checking (spec §8)
   -------------------------------------------------------------------------
   grade(submission, answerCheck) → { pass, reason, message, hint, failures }
     submission   what the learner produced. Fields used by the check types:
                    formula, result   a formula and evaluate(formula, dataset)
                    pivot             the pivot builder's state (ui/pivot.js pivotState)
                    cleaning          { fixed, wrong, damage } from the cleaning lab (ui/cleaning.js)
                    story             { series, chart, sort, highlight, title, blanks } (ui/story.js)
                    seconds           time taken (timer.js, Phase 7)
     answerCheck  one check, or an array of checks that must ALL pass.

   CHECK TYPES (every type in spec §5.3, plus "story" for Level 3's one-slide answer):
     { type: "value", expect, tolerance?, allowLiteral? }
         The formula's result must equal `expect`: numbers within `tolerance`
         (default 1e-9); text case-insensitive and trimmed, like Excel's "=".
         The formula must point at cells unless allowLiteral: true, so typing
         "=241" doesn't pass.
     { type: "formula-uses", functions?, oneOf?, absolute?, refs?, lockedRanges?, exactMatch? }
         Structure: every `functions` entry must be called; at least one of
         `oneOf` must be called (e.g. SUMIF or SUMIFS); every `absolute` cell
         must appear fully locked ($J$3); every `refs` cell must be referenced
         on its own (not as a range endpoint); every `lockedRanges` entry such
         as "J:N" needs a fully locked range over exactly those columns
         ($J$2:$N$15, any rows, or $J:$N), the "lock the lookup table" habit.
         exactMatch: true means every VLOOKUP must end with FALSE or 0, and
         every MATCH must have match_type 0 (spec §5.3: "an exact-match arg").
         Text in "quotes" is ignored.
     { type: "pivot-state", expect: { rows, columns, value, agg, showAs?, filter? }, totals?, colTotals?, cells?, tolerance? }
         The pivot's configuration must match every field in `expect` (case-
         insensitive; "" or null means "none"; filter is { field, values }).
         Then any figures given must match: totals { rowLabel | "Grand Total": n },
         colTotals { colLabel: n }, cells { "row|col": n }. If they don't and
         the pivot is stale (its data changed since the last Refresh), the
         verdict says to Refresh.
     { type: "cleaning-done", defects: [id | { id, label }], noDamage? }
         Every seeded defect must be in submission.cleaning.fixed, and (unless
         noDamage: false) submission.cleaning.damage must be empty: a fix that
         breaks good data doesn't count.
     { type: "story", series?, chart?: [types], data?: "categories"|"time", sort?,
       highlight?, titleMentions?: [words], blanks?: { name: value | { expect, tolerance?, label? } } }
         The one-slide answer (submission.story from ui/story.js): the chart
         plots the right series, is a fitting type, ordered to make the point,
         titled with the finding (names the answer), and each blank of the
         insight sentence is right (numbers within tolerance).
     { type: "timed", maxSeconds }
         submission.seconds must be <= maxSeconds. Usually combined with
         other checks, so the verdict can say "Correct, but over time".
   Unknown types throw, so content can't silently use a check that doesn't exist.

   Pure: no DOM, no storage. The UI decides what to do with the verdict.
   ========================================================================= */

export const CHECK_TYPES = Object.freeze(["value", "formula-uses", "pivot-state", "cleaning-done", "story", "timed"]);
const FORMULA_TYPES = new Set(["value", "formula-uses"]);

/* Short, specific explanations (spec §8: never just "wrong"). */
const ERROR_TEXT = {
  "#N/A": "the value it looked for wasn't found",
  "#REF!": "a position points outside the range",
  "#NAME?": "Excel didn't recognise a name. Check the spelling, and put text in \"quotes\"",
  "#DIV/0!": "something was divided by zero or an empty cell",
  "#VALUE!": "text was used where a number was needed",
};

/** Remove "string literals" so structural checks only look at the formula itself. */
export function stripStrings(formula) { return String(formula).replace(/"[^"]*"/g, '""'); }

/** Does the formula point at at least one cell or range (outside quotes)? */
export function referencesCells(formula) {
  const f = stripStrings(formula);
  // A1-style cells and ranges, or whole columns such as A:A / $J:$N.
  return /(^|[^A-Z0-9_$])\$?[A-Z]{1,3}\$?[0-9]+(?![A-Z0-9_(])/i.test(f) || /(^|[^A-Z0-9_$])\$?[A-Z]{1,3}:\$?[A-Z]{1,3}(?![A-Z0-9_(])/i.test(f);
}
export function usesFunction(formula, name) {
  return new RegExp(`(^|[^A-Z0-9_.])${name}\\s*\\(`, "i").test(stripStrings(formula));
}
export function hasAbsolute(formula, cell) {
  const m = /^\$?([A-Z]+)\$?(\d+)$/i.exec(cell); if (!m) return false;
  return new RegExp(`(^|[^A-Z0-9$])\\$${m[1]}\\$${m[2]}(?![0-9])`, "i").test(stripStrings(formula));
}
export function referencesCell(formula, cell) {
  const m = /^\$?([A-Z]+)\$?(\d+)$/i.exec(cell); if (!m) return false;
  // Standalone reference only: the D2 in the range "D2:D25" is not a reference to the cell D2.
  return new RegExp(`(^|[^A-Z0-9$:])\\$?${m[1]}\\$?${m[2]}(?![0-9:])`, "i").test(stripStrings(formula));
}

/** Is there a fully locked range spanning exactly these columns ("J:N")? $J$2:$N$15 or $J:$N. */
export function hasLockedRange(formula, cols) {
  const m = /^\$?([A-Z]+):\$?([A-Z]+)$/i.exec(cols); if (!m) return false;
  const [a, b] = [m[1].toUpperCase(), m[2].toUpperCase()];
  const f = stripStrings(formula).toUpperCase();
  return new RegExp(`(^|[^A-Z0-9$])\\$${a}\\$\\d+:\\$${b}\\$\\d+(?![0-9])`).test(f) || new RegExp(`(^|[^A-Z0-9$])\\$${a}:\\$${b}(?![A-Z0-9$])`).test(f);
}

/** Top-level argument lists of every call to `name` in the formula (quotes respected). */
export function callArgs(formula, name) {
  const f = String(formula), out = [], re = new RegExp(`(^|[^A-Z0-9_.])${name}\\s*\\(`, "gi");
  let m;
  const src = f.replace(/"[^"]*"/g, q => '"' + "_".repeat(q.length - 2) + '"'); // mask quoted text, keep positions
  while ((m = re.exec(src))) {
    let i = m.index + m[0].length, depth = 1, cur = "", args = [];
    for (; i < src.length && depth > 0; i++) {
      const ch = src[i];
      if (ch === "(") depth++;
      if (ch === ")") { depth--; if (depth === 0) break; }
      if (ch === "," && depth === 1) { args.push(cur.trim()); cur = ""; continue; }
      cur += ch;
    }
    args.push(cur.trim());
    out.push(args);
  }
  return out;
}
const isExactFlag = a => /^(FALSE|0)$/i.test(String(a ?? "").trim());

function fmt(v) {
  if (typeof v === "number") return Number.isInteger(v) ? String(v) : String(Math.round(v * 1e6) / 1e6);
  return typeof v === "string" ? `"${v}"` : String(v);
}
export function formatSeconds(s) {
  const t = Math.max(0, Math.round(s)); const m = Math.floor(t / 60), r = t % 60;
  return `${m}:${String(r).padStart(2, "0")}`;
}
function sameValue(actual, expect, tolerance = 1e-9) {
  if (typeof expect === "boolean") expect = expect ? "TRUE" : "FALSE";
  if (typeof expect === "number") return typeof actual === "number" && Math.abs(actual - expect) <= tolerance;
  return typeof actual === "string" && actual.trim().toLowerCase() === String(expect).trim().toLowerCase();
}
const norm = v => (v === null || v === undefined ? "" : String(v).trim().toLowerCase());

/* ---------- checkers: each returns a list of failures { reason, message, hint } ---------- */
function checkValue(sub, c) {
  const r = sub.result, fails = [];
  if (!c.allowLiteral && !referencesCells(sub.formula)) {
    fails.push({ reason: "no-reference", message: "That's an answer typed in, not a formula that works it out.", hint: "Point the formula at the cells (e.g. F2:F25) so it would still be right if the data changed." });
  }
  if (!r || !r.ok) {
    const code = r?.error?.code;
    fails.push({ reason: "error", message: code ? `Your formula returned ${code}: ${ERROR_TEXT[code] || "it didn't resolve"}.` : "The formula couldn't be read.", hint: code === "" ? "Type a formula first." : "Check the function name, brackets, commas and cell references." });
  } else if (!sameValue(r.value, c.expect, c.tolerance)) {
    fails.push({ reason: "wrong-value", message: `Your formula returned ${fmt(r.value)}. That's not the answer yet.`, hint: "Check the ranges and the condition against the question." });
  }
  return fails;
}

function checkUses(sub, c) {
  const fails = [];
  for (const fn of c.functions || []) {
    if (!usesFunction(sub.formula, fn)) fails.push({ reason: "missing-function", message: `This one is meant to be solved with ${fn}.`, hint: `Start with =${fn}( …`, detail: fn });
  }
  if (c.oneOf?.length && !c.oneOf.some(fn => usesFunction(sub.formula, fn))) {
    const list = c.oneOf.length === 2 ? c.oneOf.join(" or ") : `${c.oneOf.slice(0, -1).join(", ")} or ${c.oneOf.at(-1)}`;
    fails.push({ reason: "missing-function", message: `This one is meant to be solved with ${list}.`, hint: `Use ${list} so the formula applies the condition itself.`, detail: c.oneOf });
  }
  for (const cell of c.absolute || []) {
    if (!hasAbsolute(sub.formula, cell)) fails.push({ reason: "missing-absolute", message: `Lock ${cell.replace(/\$/g, "")} as $${cell.replace(/\$/g, "").replace(/(\d+)/, "$$$1")} so it stays put when the formula is copied.`, hint: "In Excel, click the reference and press F4 to add the $ signs.", detail: cell });
  }
  for (const cols of c.lockedRanges || []) {
    if (!hasLockedRange(sub.formula, cols)) {
      const [a, b] = cols.toUpperCase().split(":");
      fails.push({ reason: "missing-lock", message: `Lock the ${a === b ? `${a} column` : "lookup table"} with $ signs (e.g. $${a}$2:$${b}$…, or $${a}:$${b}) so it doesn't drift when you copy the formula down.`, hint: "Select the range in the formula bar and press F4.", detail: cols });
    }
  }
  if (c.exactMatch) {
    const loose = callArgs(sub.formula, "VLOOKUP").some(a => !isExactFlag(a[3])) ? "VLOOKUP"
      : callArgs(sub.formula, "MATCH").some(a => !isExactFlag(a[2])) ? "MATCH" : null;
    if (loose) fails.push({ reason: "not-exact", message: loose === "VLOOKUP"
        ? "end the VLOOKUP with FALSE (or 0) for an exact match. Without it Excel does an approximate match, which only gives the right answer here by luck."
        : "give MATCH a match_type of 0 for an exact match. Without it Excel does an approximate match.",
      hint: "IDs and names always need an exact match.", detail: loose });
  }
  for (const cell of c.refs || []) {
    if (!referencesCell(sub.formula, cell)) fails.push({ reason: "missing-ref", message: `Use the cell ${cell} in the formula, not the value typed in.`, hint: `Point at ${cell} so the formula follows the data if it changes.`, detail: cell });
  }
  return fails;
}

const PIVOT_LABEL = { rows: "Rows", columns: "Columns", value: "Values field", agg: "Summarize Values By", showAs: "Show Values As", filter: "Filter" };
const PIVOT_WORD = { sum: "Sum", count: "Count", average: "Average", max: "Max", min: "Min", none: "No Calculation", "pct-grand": "% of Grand Total", "pct-col": "% of Column Total", "pct-row": "% of Row Total" };
const pw = v => PIVOT_WORD[v] || v;
const sameSet = (a, b) => { const x = new Set((a || []).map(norm)), y = new Set((b || []).map(norm)); return x.size === y.size && [...x].every(v => y.has(v)); };
const within = (have, want, tol) => typeof have === "number" && Math.abs(have - want) <= tol;
function checkPivot(sub, c) {
  const p = sub.pivot;
  if (!p || !p.rows) return [{ reason: "pivot-missing", message: "There's no pivot to check yet.", hint: "Build the pivot first: at least a Rows field and a Values field." }];
  const fails = [];
  for (const [k, want] of Object.entries(c.expect || {})) {
    const label = PIVOT_LABEL[k] || k;
    if (k === "filter") {
      const hf = p.filter?.field ? p.filter : null, wf = want?.field ? want : null;
      const ok = !wf ? !hf : !!hf && norm(hf.field) === norm(wf.field) && sameSet(hf.values, wf.values);
      if (!ok) fails.push({ reason: "pivot-config", message: wf ? `The Filter should keep only ${wf.field} = ${wf.values.join(", ")}${hf ? `; yours keeps ${hf.field} = ${hf.values.join(", ") || "nothing"}` : ", but there's no filter"}.` : `This question is about all the data, but the pivot is filtered to ${hf.field} = ${hf.values.join(", ")}.`,
        hint: wf ? "Put the field in the Filter box and tick only the items the question asks about." : "Clear the filter (tick every item, or remove the field from Filters).", detail: k });
      continue;
    }
    if (norm(p[k] ?? (k === "showAs" ? "none" : "")) !== norm(want)) {
      const have = norm(p[k]) ? `"${pw(p[k])}"` : "empty";
      fails.push({ reason: "pivot-config", message: `${label} is ${have}, but this question needs ${norm(want) ? `"${pw(want)}"` : "it empty"}.`, hint: `Set ${label} to match the question.`, detail: k });
    }
  }
  if (fails.length) return fails;
  const tol = c.tolerance ?? 1e-9, wrong = [];
  for (const [k, v] of Object.entries(c.totals || {})) if (!within(p.totals?.[k], v, tol)) wrong.push(k);
  for (const [k, v] of Object.entries(c.colTotals || {})) if (!within(p.colTotals?.[k], v, tol)) wrong.push(k);
  for (const [k, v] of Object.entries(c.cells || {})) if (!within(p.cells?.[k], v, tol)) wrong.push(k.replace("|", " × "));
  if (wrong.length) {
    const what = wrong.length === 1 ? `the figure for ${wrong[0]} doesn't` : `${wrong.length} figures don't`;
    fails.push(p.stale
      ? { reason: "pivot-stale", message: `The layout is right, but the pivot is showing old numbers: the data changed after you built it, and ${what} match the data now.`, hint: "Pivots don't update on their own. Refresh it: right-click the pivot ▸ Refresh (or PivotTable Analyze ▸ Refresh).", detail: wrong }
      : { reason: "pivot-totals", message: `The layout is right, but ${what} match the correct data.`, hint: "The data under the pivot isn't right yet. Is every cleaning issue fixed, and is nothing filtered out?", detail: wrong });
  }
  return fails;
}

function checkCleaning(sub, c) {
  const fails = [];
  const damage = sub.cleaning?.damage || [];
  if (damage.length && c.noDamage !== false) {
    const list = damage.slice(0, 2).join("; ") + (damage.length > 2 ? `; and ${damage.length - 2} more` : "");
    fails.push({ reason: "cleaning-damage", message: `Your changes also broke data that was fine: ${list}.`, hint: "Undo that step (or Start over) and redo it more carefully: check which columns Remove Duplicates compares, and which cells a Find & Replace reaches.", detail: damage });
  }
  const fixed = new Set(sub.cleaning?.fixed || []), wrong = new Set(sub.cleaning?.wrong || []);
  const left = (c.defects || []).map(d => (typeof d === "string" ? { id: d, label: d } : d)).filter(d => !fixed.has(d.id));
  if (left.length) {
    const names = left.slice(0, 3).map(d => d.label + (wrong.has(d.id) ? " (changed, but not to the right value)" : "")).join("; ") + (left.length > 3 ? `; and ${left.length - 3} more` : "");
    fails.push({ reason: "cleaning-incomplete", message: `${left.length} issue${left.length === 1 ? "" : "s"} still to fix: ${names}.`, hint: "Every formula built on this data is only as right as the data. Fix each issue before you summarise.", detail: left.map(d => d.id) });
  }
  return fails;
}

/* ---------- story: chart choice, order, title, one-sentence insight ---------- */
const CHART_NAME = { column: "column", bar: "bar", line: "line", pie: "pie" };
const CHART_WHY = {
  categories: {
    line: "A line joins points in order, which reads as a trend over time. These are separate categories: compare them with bars or columns.",
    pie: "A pie makes the reader compare angles, which is hard past two or three slices. Bars or columns compare sizes at a glance.",
  },
  time: {
    pie: "A pie can't show change over time: it has no order. Use a line (or columns) left to right in time order.",
    bar: "Horizontal bars read top to bottom, which hides the time order. For change over time, use a line (or columns).",
  },
};
/** "€48,781.80" / "42.9%" → number, or NaN. */
export function parseAnswerNumber(text) {
  const s = String(text ?? "").replace(/[€$£%\s ]/g, "").replace(/,/g, "");
  return /^[+-]?(\d+\.?\d*|\.\d+)$/.test(s) ? Number(s) : NaN;
}
function checkStory(sub, c) {
  const st = sub.story;
  if (!st || !st.chart) return [{ reason: "story-missing", message: "There's no chart yet.", hint: "Pick a chart type for your pivot's data first." }];
  const fails = [];
  if (c.series !== undefined && norm(st.series) !== norm(c.series)) {
    fails.push({ reason: "story-series", message: `The chart shows ${st.series ? `"${st.series}"` : "nothing"}, but the question is about ${c.series}.`, hint: `Chart the ${c.series} figures${c.series === "Grand Total" ? "" : `: your pivot needs them as a column (${c.series})`}.` });
  }
  if (c.chart && !c.chart.includes(st.chart)) {
    const why = CHART_WHY[c.data || "categories"]?.[st.chart] || `A ${CHART_NAME[st.chart] || st.chart} chart isn't the best fit for this question.`;
    fails.push({ reason: "story-chart", message: why, hint: `For this question, use ${c.chart.map(x => `a ${CHART_NAME[x] || x} chart`).join(" or ")}.` });
  }
  if (c.sort !== undefined && norm(st.sort || "none") !== norm(c.sort)) {
    fails.push({ reason: "story-sort", message: c.sort === "none" ? "Keep the categories in their natural order (quarters stay Qtr1 → Qtr4): sorting by value scrambles time." : `Sort the ${st.chart === "bar" ? "bars" : "columns"} ${c.sort === "desc" ? "largest first" : "smallest first"}, so the ranking is obvious at a glance.`, hint: "Sort order is part of the message." });
  }
  if (c.highlight !== undefined && norm(st.highlight) !== norm(c.highlight)) {
    fails.push({ reason: "story-highlight", message: `Highlight the bar the sentence is about (${c.highlight}), and leave the rest quiet.`, hint: "One accent colour, on the finding." });
  }
  if (c.titleMentions?.length) {
    const t = String(st.title || "").trim();
    const missing = c.titleMentions.filter(w => !t.toLowerCase().includes(String(w).toLowerCase()));
    if (!t) fails.push({ reason: "story-title", message: "The chart has no title.", hint: "Title it with the finding: what should the reader take away?" });
    else if (missing.length) fails.push({ reason: "story-title", message: `"${t}" describes the chart, not the finding. Say what it shows: who or what stands out.`, hint: "A finding-title names the answer (e.g. \"X leads …\"), not just the axes (\"Revenue by …\")." });
  }
  for (const [name, spec] of Object.entries(c.blanks || {})) {
    const want = spec && typeof spec === "object" && "expect" in spec ? spec : { expect: spec };
    const have = st.blanks?.[name];
    const label = want.label || name;
    let ok;
    if (typeof want.expect === "number") ok = within(parseAnswerNumber(have), want.expect, want.tolerance ?? 1e-9);
    else ok = norm(have) === norm(want.expect);
    if (!ok) fails.push({ reason: "story-blank", message: String(have ?? "").trim() ? `In your sentence, "${String(have).trim()}" isn't right for the ${label}.` : `Your sentence is missing the ${label}.`, hint: typeof want.expect === "number" ? "Read it off your pivot (and its totals); round the way the sentence asks." : "Check the pivot again: which one does the question point to?", detail: name });
  }
  return fails;
}

function checkTimed(sub, c) {
  if (typeof sub.seconds !== "number") return [{ reason: "no-time", message: "No time was recorded for this attempt.", hint: "Start the timer, then submit." }];
  if (sub.seconds <= c.maxSeconds) return [];
  return [{ reason: "too-slow", message: `It took ${formatSeconds(sub.seconds)}, over the ${formatSeconds(c.maxSeconds)} target.`, hint: "Speed comes from repetition. Redo it until the steps are automatic.", detail: sub.seconds }];
}

const CHECKERS = { value: checkValue, "formula-uses": checkUses, "pivot-state": checkPivot, "cleaning-done": checkCleaning, story: checkStory, timed: checkTimed };

// When several things are wrong, report the most useful one first.
const PRIORITY = ["empty", "error", "no-reference", "wrong-value", "pivot-missing", "pivot-config", "pivot-stale", "pivot-totals", "cleaning-damage", "cleaning-incomplete",
                  "story-missing", "story-series", "story-chart", "story-sort", "story-highlight", "story-title", "story-blank",
                  "not-exact", "missing-function", "missing-absolute", "missing-lock", "missing-ref", "no-time", "too-slow"];
// Failures that mean "the answer itself is right, but…": they get a gentler lead-in.
const METHOD_ONLY = new Set(["not-exact", "missing-function", "missing-absolute", "missing-lock", "missing-ref", "too-slow"]);

/**
 * @param {{formula?: string, result?: object, pivot?: object, cleaning?: {fixed: string[], wrong?: string[], damage?: string[]}, story?: object, seconds?: number}} submission
 * @param {object|object[]} answerCheck
 * @returns {{pass: boolean, reason: string, message: string, hint: string, failures: object[]}}
 */
export function grade(submission, answerCheck) {
  const checks = Array.isArray(answerCheck) ? answerCheck : [answerCheck];
  for (const c of checks) if (!CHECKERS[c?.type]) throw new Error(`Unknown answerCheck type "${c?.type}". Known: ${CHECK_TYPES.join(", ")}`);
  const formula = String(submission?.formula ?? "").trim().replace(/^=/, "");
  if (!formula && checks.some(c => FORMULA_TYPES.has(c.type))) return { pass: false, reason: "empty", message: "No formula yet.", hint: "Type a formula first.", failures: [] };
  const sub = { ...submission, formula };
  const failures = checks.flatMap(c => CHECKERS[c.type](sub, c));
  if (!failures.length) return { pass: true, reason: "ok", message: "Correct.", hint: "", failures };
  failures.sort((a, b) => PRIORITY.indexOf(a.reason) - PRIORITY.indexOf(b.reason));
  const top = failures[0];
  const onlyMethod = failures.every(f => METHOD_ONLY.has(f.reason));
  const lead = top.reason === "too-slow" ? "Correct, but" : "Right answer, but";
  const message = onlyMethod ? `${lead} ${top.message[0].toLowerCase()}${top.message.slice(1)}` : top.message[0].toUpperCase() + top.message.slice(1);
  return { pass: false, reason: top.reason, message, hint: top.hint, failures };
}
