/* =========================================================================
   engine.js — The Analyst Path formula engine
   -------------------------------------------------------------------------
   Ported from v1 (excel_analyst_path.html, "ENGINE (tested)" block).
   The evaluation logic is kept as-is. Phase 0 made only these changes:

     1. DOM removed. v1 called hi()/clearHi() to paint <td> elements. The
        engine now records each highlight as data ({cell, role}) and returns
        the list. The UI (js/ui/sheet.js, Phase 2) decides how to paint it.
     2. No shared state between calls. v1 used module-level CELL and trace.
        Each evaluate() call now gets its own sheet, trace and highlight list.
     3. The result shape follows spec §5.2:
          evaluate(formula, dataset) →
            { ok, value, ref, trace, error, highlights }

   Excel-correctness fix pass (after Phase 0 review). Each item below is
   tested in engine.test.js under "Fixed divergences":
     D1/D2  VLOOKUP: 4th arg omitted, TRUE or non-zero → approximate match.
            A trailing empty argument ("...,2,)") counts as 0, i.e. exact.
     D3     MATCH: match_type omitted → 1 (approximate).
            Approximate match is a sorted (binary) search: correct on sorted
            data, unreliable on unsorted data, as in Excel.
     D5     An empty cell is blank: 0 in arithmetic, "" against text,
            and 0 when it is the final result.
     D6/D7  Division by zero, and AVERAGE over no numbers → #DIV/0!.
     D8     Numbers stored as text inside ranges are ignored by SUM, COUNT,
            AVERAGE, SUMIF and SUMIFS, and by >, <, >=, <= criteria.
            Numbers typed directly as SUM arguments are still counted.
     D9/D10 ROUND rounds half away from zero at 15 significant digits.
   Phase 5 extensions (for real-world lookups):
     • Whole-column ranges: J:N and $J:$N mean rows 1 to the last row with data.
     • Approximate match skips cells of a different type, so a text header on
       top of a sorted number column doesn't break it.
   Phase 6 extensions (for data cleaning):
     • TRIM, PROPER, UPPER, LOWER and VALUE, with Excel's rules (TRIM removes
       ordinary spaces only; PROPER capitalises a letter after any non-letter).
     • COUNTIF/COUNTIFS/SUMIF(S) criteria "" and "<>" match empty / non-empty cells.
     • textToNumber() is exported so the cleaning lab's "Convert to Number"
       follows exactly the same rule as VALUE().

   All other v1 behaviour is unchanged. The remaining differences from Excel
   are pinned in engine.test.js under "Known divergences" so that any future
   fix has to be deliberate.
   ========================================================================= */

/**
 * Highlight roles. These carry the app's search → match → return colours
 * (spec §10.1). They map one-to-one to the v1 CSS classes:
 *   scan   → h-scan   (faint clay: a cell the engine looked at while searching)
 *   search → h-search (clay:  the value being looked up)
 *   match  → h-match  (green: where the lookup / criterion matched)
 *   return → h-return (blue:  the cell whose value was returned / summed)
 */
export const ROLES = Object.freeze(["scan", "search", "match", "return"]);

/** Every function the engine can run. The test suite checks each one is covered. */
export const FUNCTIONS = Object.freeze([
  "VLOOKUP", "XLOOKUP", "MATCH", "INDEX", "IF",
  "SUM", "AVERAGE", "COUNT", "COUNTA",
  "COUNTIF", "SUMIF", "SUMIFS", "COUNTIFS",
  "IFERROR", "ROUND",
  "TRIM", "PROPER", "UPPER", "LOWER", "VALUE",
]);

/* ---------- pure helpers (unchanged from v1) ---------- */
function stripDollar(r) { return r.replace(/\$/g, ""); }
function colLetter(r) { return stripDollar(r).match(/[A-Z]+/)[0]; }
function rowNum(r) { return parseInt(stripDollar(r).match(/\d+/)[0], 10); }
function colIndex(l) { let n = 0; for (const ch of l) n = n * 26 + (ch.charCodeAt(0) - 64); return n; }
function idxToCol(n) { let s = ""; while (n > 0) { s = String.fromCharCode(65 + (n - 1) % 26) + s; n = Math.floor((n - 1) / 26); } return s; }
// D8: only true numbers in a range count. Text such as "15" is ignored, as in Excel.
function nums(arr) { return arr.filter(v => typeof v === "number" && !isNaN(v)); }
function eq(a, b) { if (typeof a === "number" && typeof b === "number") return a === b; return String(a).toLowerCase() === String(b).toLowerCase(); }
const isBlank = v => v === null || v === undefined;
// D5: a blank is 0 in arithmetic.
const num = v => isBlank(v) ? 0 : Number(v);

// D9/D10: Excel's ROUND works at 15 significant digits and rounds half away from zero.
function shiftDecimal(x, e) { const [m, ex] = String(x).split("e"); return Number(`${m}e${Number(ex || 0) + e}`); }
function excelRound(v, digits) {
  if (!Number.isFinite(v)) return v;
  const d = Math.trunc(digits);
  const a = Number(Math.abs(v).toPrecision(15));
  const r = shiftDecimal(Math.round(shiftDecimal(a, d)), -d);
  return r === 0 ? 0 : Math.sign(v) * r;
}

/** A value as text, the way Excel's text functions see it (TRIM(5) is "5"; a blank is ""). */
function toText(v) {
  if (isBlank(v)) return "";
  if (typeof v === "boolean") return v ? "TRUE" : "FALSE";
  if (typeof v === "number") return String(Number(v.toPrecision(15)));
  return String(v);
}
/**
 * Read text as a number the way Excel's VALUE() and "Convert to Number" do:
 * "15" → 15, " 15 " → 15, "1,250.5" → 1250.5, "5%" → 0.05, "2025-03-04" → its date serial.
 * Numbers pass through; a blank is 0. Anything else → null (Excel: #VALUE!).
 */
export function textToNumber(v) {
  if (typeof v === "number") return v;
  if (isBlank(v)) return 0;
  if (typeof v !== "string") return null;
  const s = v.replace(/^ +| +$/g, "");
  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s);
  if (iso) {
    const [y, m, d] = iso.slice(1).map(Number), t = Date.UTC(y, m - 1, d), dt = new Date(t);
    if (dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
    return (t - Date.UTC(1899, 11, 30)) / 86400000;
  }
  if (!/^[+-]?(\d+|\d{1,3}(,\d{3})+)?(\.\d+)?(e[+-]?\d+)?%?$/i.test(s) || !/\d/.test(s)) return null;
  const pct = s.endsWith("%");
  const n = Number(s.replace(/[,%]/g, ""));
  return Number.isFinite(n) ? (pct ? n / 100 : n) : null;
}

// Excel's sort order for approximate match: numbers < text < booleans.
// Text compares case-insensitively.
function typeRank(v) { return typeof v === "number" ? 0 : typeof v === "string" ? 1 : typeof v === "boolean" ? 2 : 3; }
function cmpExcel(a, b) {
  const ra = typeRank(a), rb = typeRank(b);
  if (ra !== rb) return ra - rb;
  if (ra === 1) { const x = a.toLowerCase(), y = b.toLowerCase(); return x < y ? -1 : x > y ? 1 : 0; }
  return a === b ? 0 : (a < b ? -1 : 1);
}

function matchCrit(val, crit) {
  crit = String(crit);
  const m = crit.match(/^(>=|<=|<>|>|<|=)?([\s\S]*)$/);
  const op = m[1] || "=", raw = m[2];
  // P6: an empty criterion matches empty cells ("" or "="); "<>" matches cells that aren't empty, as in Excel.
  if (raw === "" && (op === "=" || op === "<>")) { const empty = isBlank(val) || val === ""; return op === "=" ? empty : !empty; }
  // D8: >, <, >=, <= only match real numbers. Text "15" is not > 10 in Excel.
  const rn = parseFloat(raw), vn = (typeof val === "number") ? val : NaN;
  const bn = !isNaN(rn) && !isNaN(vn);
  switch (op) {
    case ">": return bn && vn > rn;
    case "<": return bn && vn < rn;
    case ">=": return bn && vn >= rn;
    case "<=": return bn && vn <= rn;
    case "<>": return !eq(val, raw);
    default: return eq(val, raw);
  }
}

function splitArgs(s) {
  const out = []; let d = 0, cur = "", q = false;
  for (const ch of s) {
    if (ch === '"') q = !q;
    if (!q) {
      if (ch === "(") d++;
      if (ch === ")") d--;
      if (ch === "," && d === 0) { out.push(cur); cur = ""; continue; }
    }
    cur += ch;
  }
  if (cur.trim() !== "") out.push(cur);
  return out.map(x => x.trim());
}

function splitTopComparison(s) {
  let d = 0, q = false;
  const ops = [">=", "<=", "<>", ">", "<", "="];
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '"') q = !q;
    if (q) continue;
    if (ch === "(") d++;
    if (ch === ")") d--;
    if (d !== 0) continue;
    for (const op of ops) {
      if (s.substr(i, op.length) === op) return { op, left: s.slice(0, i), right: s.slice(i + op.length) };
    }
  }
  return null;
}

function splitTopArith(s) {
  let d = 0, q = false;
  // + and - first (lowest precedence), scanning right-to-left for left associativity
  for (let i = s.length - 1; i >= 0; i--) {
    const ch = s[i];
    if (ch === '"') q = !q;
    if (q) continue;
    if (ch === ")") d++;
    if (ch === "(") d--;
    if (d !== 0) continue;
    if ((ch === "+" || ch === "-") && i > 0) {
      const prev = s[i - 1];
      if (!/[\+\-\*\/\(]/.test(prev)) return { op: ch, left: s.slice(0, i), right: s.slice(i + 1) };
    }
  }
  d = 0; q = false;
  for (let i = s.length - 1; i >= 0; i--) {
    const ch = s[i];
    if (ch === '"') q = !q;
    if (q) continue;
    if (ch === ")") d++;
    if (ch === "(") d--;
    if (d !== 0) continue;
    if (ch === "*" || ch === "/") return { op: ch, left: s.slice(0, i), right: s.slice(i + 1) };
  }
  return null;
}

/* ---------- per-evaluation context ----------
   Everything that touched v1's globals (CELL, trace, hi) lives in here, so
   one evaluate() call cannot leak state into the next. Function bodies match
   v1; only hi()/log() now write to local arrays. */
function createEvaluator(CELL) {
  const trace = [];
  const highlights = [];
  const log = t => { trace.push(t); };
  const hi = (cell, cls) => { highlights.push({ cell, role: cls.replace(/^h-/, "") }); };

  // Last row that holds any data (for whole-column ranges such as J:N).
  let maxRowCache = null;
  function maxRow() {
    if (maxRowCache === null) { maxRowCache = 1; for (const k of Object.keys(CELL)) { const m = /\d+$/.exec(k); if (m) maxRowCache = Math.max(maxRowCache, Number(m[0])); } }
    return maxRowCache;
  }

  function expandRange(rng) {
    // Whole-column range, e.g. "J:N" or "$J:$N" → J1:N<last row with data> (P5 extension).
    const whole = /^\$?([A-Z]+):\$?([A-Z]+)$/.exec(String(rng).trim());
    if (whole) rng = `${whole[1]}1:${whole[2]}${maxRow()}`;
    const [a, b] = rng.split(":").map(stripDollar);
    const c1 = colIndex(colLetter(a)), c2 = colIndex(colLetter(b));
    const r1 = rowNum(a), r2 = rowNum(b);
    const lo = Math.min(c1, c2), hiC = Math.max(c1, c2), rlo = Math.min(r1, r2), rhi = Math.max(r1, r2);
    const grid = [];
    for (let r = rlo; r <= rhi; r++) {
      const ra = [];
      for (let c = lo; c <= hiC; c++) { const k = idxToCol(c) + r; ra.push({ key: k, val: CELL[k] }); }
      grid.push(ra);
    }
    return { grid };
  }
  function flatCells(rng) { return expandRange(rng).grid.flat(); }

  function resolveArg(tok) {
    tok = tok.trim();
    if (/^".*"$/.test(tok)) return { value: tok.slice(1, -1) };
    if (/^-?\d+(\.\d+)?$/.test(tok)) return { value: parseFloat(tok) };
    if (/^(TRUE|FALSE)$/i.test(tok)) return { value: tok.toUpperCase() === "TRUE" };
    const c = stripDollar(tok);
    if (/^[A-Z]+\d+$/.test(c)) {
      // D5: an empty cell is a blank (null), not an error.
      if (CELL[c] === undefined) return { value: null, ref: c };
      return { value: CELL[c], ref: c };
    }
    throw { msg: `Couldn't read "${tok}".`, code: "#NAME?" };
  }

  function evalScalar(expr) {
    expr = expr.trim();
    const cmp = splitTopComparison(expr);
    if (cmp) {
      let l = evalScalar(cmp.left).value, r = evalScalar(cmp.right).value;
      // D5: a blank takes the other side's type: 0 against a number, "" against text, FALSE against a boolean.
      const blankAs = o => typeof o === "string" ? "" : typeof o === "boolean" ? false : 0;
      if (isBlank(l) && isBlank(r)) { l = 0; r = 0; }
      else if (isBlank(l)) l = blankAs(r);
      else if (isBlank(r)) r = blankAs(l);
      const ln = parseFloat(l), rn = parseFloat(r), bn = !isNaN(ln) && !isNaN(rn);
      let res;
      switch (cmp.op) {
        case ">": res = bn && ln > rn; break;
        case "<": res = bn && ln < rn; break;
        case ">=": res = bn && ln >= rn; break;
        case "<=": res = bn && ln <= rn; break;
        case "<>": res = !eq(l, r); break;
        case "=": res = eq(l, r); break;
      }
      return { value: res };
    }
    const ar = splitTopArith(expr);
    if (ar) {
      const l = num(evalScalar(ar.left).value), r = num(evalScalar(ar.right).value);
      let res;
      switch (ar.op) {
        case "+": res = l + r; break;
        case "-": res = l - r; break;
        case "*": res = l * r; break;
        case "/":
          // D6
          if (r === 0) throw { msg: "Division by zero: the divisor is 0 or an empty cell.", code: "#DIV/0!" };
          res = l / r; break;
      }
      return { value: res };
    }
    return evalNode(expr);
  }

  /* ---------- approximate match (D1/D3) ----------
     Excel's approximate match is a binary search. It assumes the column is
     sorted ascending and returns the last value that is <= the lookup value.
     On sorted data this matches Excel exactly. On unsorted data Excel's
     result is officially unreliable, and so is this one.
     Only values of the same TYPE as the lookup value take part: blanks, and
     a text header above a numeric column (as in a whole-column range like
     V:X), are skipped, so they can't derail the search.
     Each probed cell is marked "scan", so the UI shows it jumping, not reading every row. */
  function approxIndex(cells, lv) {
    if (isBlank(lv)) return -1;
    const rank = typeRank(lv);
    const idx = []; cells.forEach((c, i) => { if (!isBlank(c.val) && typeRank(c.val) === rank) idx.push(i); });
    let lo = 0, up = idx.length - 1, best = -1;
    while (lo <= up) {
      const mid = (lo + up) >> 1;
      const cell = cells[idx[mid]];
      hi(cell.key, "h-scan");
      if (cmpExcel(cell.val, lv) <= 0) { best = idx[mid]; lo = mid + 1; }
      else up = mid - 1;
    }
    return best;
  }
  // A trailing empty argument, as in "VLOOKUP(C2,H2:J9,2,)", counts as 0 in Excel.
  // splitArgs drops it, so check the raw text.
  const endsWithEmptyArg = a => /,\s*$/.test(a);

  /* ---------- functions ---------- */
  function fnVLOOKUP(a) {
    const args = splitArgs(a);
    if (args.length < 3) throw { msg: "VLOOKUP needs value, table, column number.", code: "#N/A" };
    const lvA = resolveArg(args[0]); const lv = lvA.value;
    if (lvA.ref) hi(lvA.ref, "h-search");
    const R = expandRange(args[1]);
    const colN = Number(resolveArg(args[2]).value);
    // D1/D2: omitted → TRUE (approximate). FALSE or 0 → exact. Any other value → approximate.
    const omitted = args[3] === undefined && !endsWithEmptyArg(a);
    const rl = args[3] !== undefined ? resolveArg(args[3]).value : (omitted ? true : 0);
    const approx = !(rl === false || rl === 0);
    if (colN < 1 || colN > R.grid[0].length) throw { msg: `Column ${colN} is outside the table.`, code: "#REF!" };
    log(`VLOOKUP: searching "${lv}" down the first column of ${args[1]}.`);
    if (approx) {
      log(omitted
        ? "No 4th argument, so Excel uses APPROXIMATE match (TRUE): it assumes the first column is sorted. Add FALSE for an exact match."
        : "Approximate match (TRUE): finds the largest value ≤ the lookup value. The first column must be sorted ascending.");
      const col = R.grid.map(r => r[0]);
      const best = approxIndex(col, lv);
      if (best < 0) throw { code: "#N/A", msg: `Nothing in the first column is ≤ "${lv}".` };
      hi(col[best].key, "h-match");
      const ret = R.grid[best][colN - 1];
      hi(ret.key, "h-return");
      log(`Largest value ≤ "${lv}" is at ${col[best].key}; moved to column ${colN} → ${ret.key}.`);
      return { value: ret.val, ref: ret.key };
    }
    for (let i = 0; i < R.grid.length; i++) {
      hi(R.grid[i][0].key, "h-scan");
      if (eq(R.grid[i][0].val, lv)) {
        hi(R.grid[i][0].key, "h-match");
        const ret = R.grid[i][colN - 1];
        hi(ret.key, "h-return");
        log(`Matched at ${R.grid[i][0].key}; moved to column ${colN} → ${ret.key}.`);
        return { value: ret.val, ref: ret.key };
      }
    }
    throw { msg: `No exact match for "${lv}".`, code: "#N/A" };
  }

  function fnXLOOKUP(a) {
    const args = splitArgs(a);
    if (args.length < 3) throw { msg: "XLOOKUP needs value, lookup column, return column.", code: "#N/A" };
    const lvA = resolveArg(args[0]); const lv = lvA.value;
    if (lvA.ref) hi(lvA.ref, "h-search");
    const L = expandRange(args[1]).grid.map(r => r[0]);
    const Rr = expandRange(args[2]).grid.map(r => r[0]);
    const nf = args[3] !== undefined ? resolveArg(args[3]).value : undefined;
    log(`XLOOKUP: searching "${lv}" in ${args[1]}, returning from ${args[2]}.`);
    for (let i = 0; i < L.length; i++) {
      hi(L[i].key, "h-scan");
      if (eq(L[i].val, lv)) {
        hi(L[i].key, "h-match");
        if (Rr[i]) hi(Rr[i].key, "h-return");
        log(`Matched at ${L[i].key}; returned ${Rr[i] ? Rr[i].key : "?"}.`);
        return { value: Rr[i] ? Rr[i].val : "", ref: Rr[i] ? Rr[i].key : undefined };
      }
    }
    if (nf !== undefined) { log("No match — used the if_not_found value."); return { value: nf }; }
    throw { msg: `No match for "${lv}".`, code: "#N/A" };
  }

  function fnMATCH(a) {
    const args = splitArgs(a);
    const lv = resolveArg(args[0]).value;
    const flat = expandRange(args[1]).grid.map(r => r[0]);
    // D3: match_type omitted → 1 (approximate). A trailing empty argument → 0 (exact).
    const t = args[2] !== undefined ? resolveArg(args[2]).value : (endsWithEmptyArg(a) ? 0 : 1);
    log(`MATCH: position of "${lv}" down ${args[1]}.`);
    if (t === 0 || t === false) {
      for (let i = 0; i < flat.length; i++) {
        hi(flat[i].key, "h-scan");
        if (eq(flat[i].val, lv)) {
          hi(flat[i].key, "h-match");
          log(`Found at position ${i + 1} (${flat[i].key}).`);
          return { value: i + 1, matchKey: flat[i].key };
        }
      }
      throw { msg: `No match for "${lv}".`, code: "#N/A" };
    }
    // Approximate. Note: -1 (descending) is still treated like 1; see divergence D4.
    if (args[2] === undefined) log("No match_type, so Excel uses 1 (APPROXIMATE): it assumes the range is sorted. Use 0 for an exact match.");
    const best = approxIndex(flat, lv);
    if (best < 0) throw { code: "#N/A", msg: `Nothing in ${args[1]} is ≤ "${lv}".` };
    hi(flat[best].key, "h-match");
    log(`Largest value ≤ "${lv}" is at position ${best + 1} (${flat[best].key}).`);
    return { value: best + 1, matchKey: flat[best].key };
  }

  function fnINDEX(a) {
    const args = splitArgs(a);
    const R = expandRange(args[0]);
    const rp = Number(evalScalar(args[1]).value);
    const cp = args[2] !== undefined ? Number(evalScalar(args[2]).value) : 1;
    if (rp < 1 || rp > R.grid.length) throw { msg: `Row position ${rp} out of range.`, code: "#REF!" };
    const cell = R.grid[rp - 1][cp - 1];
    if (!cell) throw { msg: `Column position ${cp} out of range.`, code: "#REF!" };
    hi(cell.key, "h-return");
    log(`INDEX: value at row ${rp}, col ${cp} → ${cell.key}.`);
    return { value: cell.val, ref: cell.key };
  }

  function fnIF(a) {
    const args = splitArgs(a);
    const cond = evalScalar(args[0]).value;
    log(`IF: the test is ${cond ? "TRUE" : "FALSE"} → ${cond ? "first" : "second"} result.`);
    return { value: evalScalar(cond ? args[1] : args[2]).value };
  }

  // D8: Excel treats ranges and cell references differently from values typed into the formula.
  //   From a range or reference: only real numbers count ("15" as text, TRUE and blanks are ignored).
  //   Typed as an argument:      numbers, number-like text ("15") and TRUE/FALSE count;
  //                              other text is #VALUE!.
  function literalNumber(v) {
    if (typeof v === "number") return v;
    if (typeof v === "boolean") return v ? 1 : 0;
    const s = String(v).trim();
    if (s !== "" && Number.isFinite(Number(s))) return Number(s);
    throw { msg: `"${v}" is text, not a number.`, code: "#VALUE!" };
  }

  function fnSUM(a) {
    const cells = splitArgs(a).flatMap(x => {
      try { return flatCells(x); }
      catch (e) {
        const r = resolveArg(x);
        return [r.ref ? { val: r.value } : { val: literalNumber(r.value) }];
      }
    });
    cells.forEach(c => { if (c.key) hi(c.key, "h-scan"); });
    const v = nums(cells.map(c => c.val)).reduce((s, x) => s + x, 0);
    log(`SUM: added ${nums(cells.map(c => c.val)).length} numbers.`);
    return { value: v };
  }

  function fnAVERAGE(a) {
    const cells = splitArgs(a).flatMap(x => flatCells(x));
    cells.forEach(c => { if (c.key) hi(c.key, "h-scan"); });
    const n = nums(cells.map(c => c.val));
    // D7
    if (n.length === 0) throw { msg: "AVERAGE found no numbers to average (text and blanks don't count).", code: "#DIV/0!" };
    log(`AVERAGE: sum ÷ ${n.length} values.`);
    return { value: n.reduce((s, x) => s + x, 0) / n.length };
  }

  function fnCOUNT(a) {
    const cells = splitArgs(a).flatMap(x => flatCells(x));
    cells.forEach(c => { if (c.key) hi(c.key, "h-scan"); });
    return { value: nums(cells.map(c => c.val)).length };
  }

  function fnCOUNTA(a) {
    const cells = splitArgs(a).flatMap(x => flatCells(x));
    return { value: cells.map(c => c.val).filter(v => v !== "" && v !== undefined).length };
  }

  function fnCOUNTIF(a) {
    const args = splitArgs(a);
    const cells = flatCells(args[0]);
    const crit = resolveArg(args[1]).value;
    let c = 0;
    cells.forEach(cell => { hi(cell.key, "h-scan"); if (matchCrit(cell.val, crit)) { hi(cell.key, "h-match"); c++; } });
    log(`COUNTIF: ${c} cells met "${crit}".`);
    return { value: c };
  }

  function fnSUMIF(a) {
    const args = splitArgs(a);
    const critCells = flatCells(args[0]);
    const crit = resolveArg(args[1]).value;
    const sumCells = args[2] !== undefined ? flatCells(args[2]) : critCells;
    let s = 0;
    for (let i = 0; i < critCells.length; i++) {
      hi(critCells[i].key, "h-scan");
      if (matchCrit(critCells[i].val, crit)) {
        hi(critCells[i].key, "h-match");
        if (sumCells[i]) {
          hi(sumCells[i].key, "h-return");
          const sv = sumCells[i].val;
          if (typeof sv === "number") s += sv; // D8: text in the sum range is ignored
        }
      }
    }
    log("SUMIF: summed rows where the condition held.");
    return { value: s };
  }

  function fnSUMIFS(a) {
    const args = splitArgs(a);
    const sumCells = flatCells(args[0]);
    const pairs = [];
    for (let i = 1; i < args.length; i += 2) pairs.push([flatCells(args[i]), resolveArg(args[i + 1]).value]);
    let s = 0;
    for (let r = 0; r < sumCells.length; r++) {
      let ok = true;
      for (const [cells, crit] of pairs) if (!matchCrit(cells[r].val, crit)) { ok = false; break; }
      if (ok) {
        hi(sumCells[r].key, "h-return");
        const sv = sumCells[r].val;
        if (typeof sv === "number") s += sv; // D8: text in the sum range is ignored
      }
    }
    log("SUMIFS: summed rows meeting every condition.");
    return { value: s };
  }

  function fnCOUNTIFS(a) {
    const args = splitArgs(a);
    const pairs = [];
    for (let i = 0; i < args.length; i += 2) pairs.push([flatCells(args[i]), resolveArg(args[i + 1]).value]);
    const n = pairs[0][0].length;
    let c = 0;
    for (let r = 0; r < n; r++) {
      let ok = true;
      for (const [cells, crit] of pairs) if (!matchCrit(cells[r].val, crit)) { ok = false; break; }
      if (ok) { hi(pairs[0][0][r].key, "h-match"); c++; }
    }
    return { value: c };
  }

  function fnIFERROR(a) {
    const args = splitArgs(a);
    try { return { value: evalScalar(args[0]).value }; }
    catch (e) {
      log(`IFERROR caught ${e.code || "an error"} → used the fallback.`);
      return { value: resolveArg(args[1]).value };
    }
  }

  function fnROUND(a) {
    const args = splitArgs(a);
    const v = num(evalScalar(args[0]).value);
    const d = num(resolveArg(args[1]).value);
    return { value: excelRound(v, d) }; // D9/D10
  }

  /* ---------- P6: text-cleaning functions ----------
     Each takes one argument (a cell, text or a nested formula). */
  function oneArg(a, name) {
    const args = splitArgs(a);
    if (args.length !== 1) throw { msg: `${name} takes one argument: the text to clean.`, code: "#N/A" };
    const r = evalScalar(args[0]);
    if (r.ref) hi(r.ref, "h-return");
    return r.value;
  }
  function fnTRIM(a) {
    const s = toText(oneArg(a, "TRIM"));
    // Excel's TRIM removes ordinary spaces only: at both ends, and repeats in the middle.
    const out = s.replace(/^ +| +$/g, "").replace(/ {2,}/g, " ");
    log(`TRIM: "${s}" → "${out}".`);
    return { value: out };
  }
  function fnPROPER(a) {
    const s = toText(oneArg(a, "PROPER"));
    // Capitalise any letter that starts the text or follows a non-letter; lower-case the rest.
    let out = "", prevLetter = false;
    for (const ch of s) { const letter = /\p{L}/u.test(ch); out += letter ? (prevLetter ? ch.toLowerCase() : ch.toUpperCase()) : ch; prevLetter = letter; }
    log(`PROPER: "${s}" → "${out}".`);
    return { value: out };
  }
  function fnUPPER(a) { const s = toText(oneArg(a, "UPPER")); log(`UPPER: "${s}" → "${s.toUpperCase()}".`); return { value: s.toUpperCase() }; }
  function fnLOWER(a) { const s = toText(oneArg(a, "LOWER")); log(`LOWER: "${s}" → "${s.toLowerCase()}".`); return { value: s.toLowerCase() }; }
  function fnVALUE(a) {
    const v = oneArg(a, "VALUE");
    const n = textToNumber(v);
    if (n === null) throw { msg: `"${toText(v)}" can't be read as a number.`, code: "#VALUE!" };
    log(`VALUE: "${toText(v)}" → the number ${n}.`);
    return { value: n };
  }

  const TABLE = {
    VLOOKUP: fnVLOOKUP, XLOOKUP: fnXLOOKUP, MATCH: fnMATCH, INDEX: fnINDEX, IF: fnIF,
    SUM: fnSUM, AVERAGE: fnAVERAGE, COUNT: fnCOUNT, COUNTA: fnCOUNTA,
    COUNTIF: fnCOUNTIF, SUMIF: fnSUMIF, SUMIFS: fnSUMIFS, COUNTIFS: fnCOUNTIFS,
    IFERROR: fnIFERROR, ROUND: fnROUND,
    TRIM: fnTRIM, PROPER: fnPROPER, UPPER: fnUPPER, LOWER: fnLOWER, VALUE: fnVALUE,
  };

  function evalNode(expr) {
    expr = expr.trim();
    if (/^\(.*\)$/.test(expr)) {
      let d = 0, ok = true;
      for (let i = 0; i < expr.length; i++) {
        if (expr[i] === "(") d++;
        if (expr[i] === ")") d--;
        if (d === 0 && i < expr.length - 1) { ok = false; break; }
      }
      if (ok) return evalScalar(expr.slice(1, -1));
    }
    const m = expr.match(/^([A-Z]+)\s*\(([\s\S]*)\)$/i);
    if (m) {
      const fn = m[1].toUpperCase(), inner = m[2];
      if (TABLE[fn]) return TABLE[fn](inner);
      throw { msg: `${fn} isn't wired into this lab yet.`, code: "#NAME?" };
    }
    return resolveArg(expr);
  }

  return { evalScalar, trace, highlights };
}

/**
 * Evaluate one formula against a dataset. Pure: it never touches the DOM
 * and never changes the dataset.
 *
 * @param {string} formula  e.g. "=VLOOKUP(C2,$H$2:$J$9,3,FALSE)" (the leading "=" is optional)
 * @param {Object<string, string|number|boolean>} dataset
 *        A1-style cell map, e.g. { A1: "OrderID", F2: 3, H2: "P001" }.
 *        Empty cells are simply missing keys.
 * @returns {{
 *   ok: boolean,
 *   value: (string|number|null),     // booleans come back as "TRUE"/"FALSE", as in v1
 *   ref: (string|null),              // the cell the value came from, if there was one
 *   trace: string[],                 // plain-English steps, in order
 *   error: ({code: string|null, message: string}|null),
 *                                    // code is "#N/A" | "#REF!" | "#NAME?" | "#DIV/0!" | "#VALUE!",
 *                                    // "" for an empty formula, or null for an internal failure
 *                                    // with no Excel code
 *   highlights: {cell: string, role: "scan"|"search"|"match"|"return"}[]
 *                                    // in the order v1 painted them; the UI applies them
 * }}
 */
export function evaluate(formula, dataset = {}) {
  const f = String(formula ?? "").trim().replace(/^=/, "");
  if (!f) {
    return { ok: false, value: null, ref: null, trace: [], error: { code: "", message: "Type a formula first." }, highlights: [] };
  }
  const ctx = createEvaluator(dataset);
  try {
    const res = ctx.evalScalar(f);
    let v = res.value;
    if (typeof v === "boolean") v = v ? "TRUE" : "FALSE";
    if (isBlank(v)) v = 0; // D5: a formula that returns an empty cell shows 0, as in Excel
    return { ok: true, value: v, ref: res.ref ?? null, trace: [...ctx.trace], error: null, highlights: [...ctx.highlights] };
  } catch (e) {
    // Excel-style errors are thrown as {code, msg}. Anything else (such as a JS
    // TypeError from input the parser doesn't understand) gets code null.
    const error = (e && typeof e === "object" && "code" in e)
      ? { code: e.code ?? null, message: e.msg || "" }
      : { code: null, message: (e && e.message) ? e.message : String(e) };
    return { ok: false, value: null, ref: null, trace: [...ctx.trace], error, highlights: [...ctx.highlights] };
  }
}
