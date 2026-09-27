/* =========================================================================
   ui/console.js: the live formula console (spec §10.2, the signature element)
   -------------------------------------------------------------------------
   Ported from v1 makeConsole(). One call embeds a complete lab: the sheet on
   the left, the console on the right (stacked on mobile):

     import { createConsole } from "./ui/console.js";
     import { V1_SAMPLE } from "./data.js";
     const lab = createConsole(host, {
       dataset: V1_SAMPLE,                                  // { cells, range?, headerRows?, label? }
       starter: "VLOOKUP(C2,H2:J9,2,FALSE)",                 // optional, runs on mount
       examples: [{ formula: "SUM(F2:F25)", note: "total quantity" }],
       onResult: (result, formula) => { … },               // hook for drills / the grader (Phase 3–4)
     });

   Flow on every run: formula → engine.evaluate() → render result + trace →
   sheet.highlight(result.highlights). The console never decides which cells
   light up. It passes along exactly what the engine returned.

   Not ported from v1 on purpose: the built-in "challenge" checker. Checking
   answers is the grader's job (spec §8, Phase 4). Drills hook in via onResult.
   ========================================================================= */

import { evaluate } from "../engine.js";
import { createSheet } from "./sheet.js";
import { formatAs, formatOf } from "../data.js";

/* User-facing text in one place (easy to review, and to translate later: spec §14.3). */
export const TEXT = Object.freeze({
  title: "Formula console",
  placeholder: "type a formula, press Enter",
  run: "Run",
  result: "Result",
  from: "from",
  failed: "Didn't resolve",
  examples: "Try these: click to load and run",
  rounded: exact => `Shown to 2 decimals. Exact value: ${exact}`,
  stored: (shown, raw) => `Shown as ${shown} because that cell is formatted that way. Excel stores it as the number ${raw}.`,
  legend: { search: "searching", match: "matched", return: "returned" },
});

/* A specific "what to check" for each Excel error (spec §8: never just "wrong"). */
export const ERROR_HINTS = Object.freeze({
  "#N/A": "The value wasn't found. Check it really exists in the first column of the table, that the spelling matches, and that you ended an exact lookup with FALSE (or 0).",
  "#REF!": "A position points outside the range: a column number wider than the table, or a row/column past the end for INDEX.",
  "#NAME?": "Excel didn't recognise something: a misspelled function, or text that needs \"double quotes\" around it.",
  "#DIV/0!": "Something was divided by zero or by an empty cell, or AVERAGE found no numbers to average.",
  "#VALUE!": "A piece of text was used where a number was needed.",
  "": "Type a formula in the box, then press Enter.",
  null: "The engine couldn't read this formula. Check the brackets, commas and cell references (use capital letters, e.g. F2).",
});

/** Format a result value for display. Numbers: max 2 decimals, en-US digits (formulas use "," between arguments, so "1,330.5" style keeps "." as the decimal point). */
export function formatValue(v) {
  if (typeof v === "number") {
    if (!Number.isFinite(v)) return { text: String(v), rounded: false };
    const text = v.toLocaleString("en-US", { maximumFractionDigits: 2 });
    const rounded = Math.round(v * 100) / 100 !== v;
    return { text, rounded, exact: rounded ? String(v) : undefined };
  }
  return { text: String(v), rounded: false };
}

const esc = v => String(v ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
let uid = 0;

/**
 * @param {HTMLElement} host
 * @param {{
 *   dataset: {cells: Object, range?: string, headerRows?: number, label?: string},
 *   starter?: string, examples?: {formula: string, note?: string}[],
 *   title?: string, animate?: boolean,
 *   onResult?: (result: object, formula: string) => void
 * }} opts
 */
export function createConsole(host, opts = {}) {
  const { dataset, starter = "", examples = [], title = TEXT.title, animate = true, onResult, slot } = opts;
  if (!dataset?.cells) throw new Error("createConsole needs { dataset: { cells } }");
  const id = `fx-${++uid}`;

  host.innerHTML = `
    <div class="lab lab-layout">
      <div class="lab__sheet">
        <div data-sheet></div>
        <ul class="legend lab__legend" role="list" aria-label="Highlight colours">
          <li><span class="legend__swatch legend__swatch--search" aria-hidden="true"></span>${TEXT.legend.search}</li>
          <li><span class="legend__swatch legend__swatch--match" aria-hidden="true"></span>${TEXT.legend.match}</li>
          <li><span class="legend__swatch legend__swatch--return" aria-hidden="true"></span>${TEXT.legend.return}</li>
        </ul>
      </div>
      <section class="console" aria-labelledby="${id}-title">
        <h2 class="console__title" id="${id}-title">${esc(title)}</h2>
        <form class="fx" data-form>
          <label class="visually-hidden" for="${id}-input">Formula</label>
          <span class="fx__eq" aria-hidden="true">=</span>
          <input class="fx__input" id="${id}-input" data-input type="text" spellcheck="false" autocomplete="off"
                 autocapitalize="characters" autocorrect="off" placeholder="${esc(TEXT.placeholder)}" aria-describedby="${id}-result">
          <button class="fx__run" type="submit">${TEXT.run} <kbd aria-hidden="true">Enter</kbd></button>
        </form>
        <div class="console__result" id="${id}-result" data-result aria-live="polite"></div>
        <ol class="trace" data-trace aria-label="Steps the formula took" hidden></ol>
        ${examples.length ? `<div class="examples">
          <p class="examples__label" id="${id}-ex">${TEXT.examples}</p>
          <ul class="examples__list" role="list" aria-labelledby="${id}-ex">${examples.map((ex, i) => `
            <li><button type="button" class="example" data-example="${i}">
              <code class="example__formula">=${esc(ex.formula.replace(/^=/, ""))}</code>${ex.note ? `<span class="example__note">${esc(ex.note)}</span>` : ""}
            </button></li>`).join("")}
          </ul></div>` : ""}
      </section>
    </div>`;

  const sheet = createSheet(host.querySelector("[data-sheet]"), {
    cells: dataset.cells, range: dataset.range, headerRows: dataset.headerRows ?? 1, label: dataset.label || "Sheet", formats: dataset.formats || {},
  });
  const input = host.querySelector("[data-input]");
  const resultEl = host.querySelector("[data-result]");
  const traceEl = host.querySelector("[data-trace]");
  // Optional slot above the formula bar, e.g. a lesson's drill panel ("here's the task, type below").
  if (slot instanceof HTMLElement) host.querySelector("[data-form]").before(slot);
  let last = null;

  function renderResult(r) {
    if (r.ok) {
      // A value that came straight from a formatted cell (a date, a percentage) is shown the way Excel would show it.
      const cellFmt = r.ref ? formatOf(dataset, r.ref) : null;
      const pretty = cellFmt ? formatAs(r.value, cellFmt) : null;
      const f = pretty ? { text: pretty, rounded: false, note: TEXT.stored(pretty, r.value) } : formatValue(r.value);
      resultEl.innerHTML = `<div class="rbox rbox--ok">
        <span class="rbox__label">${TEXT.result}${r.ref ? ` · ${TEXT.from} <span class="mono">${esc(r.ref)}</span>` : ""}</span>
        <output class="rbox__value" for="${id}-input"${f.rounded ? ` title="${esc(TEXT.rounded(f.exact))}"` : ""}>${esc(f.text)}</output>
        ${f.rounded ? `<span class="rbox__note">${esc(TEXT.rounded(f.exact))}</span>` : ""}
        ${f.note ? `<span class="rbox__note">${esc(f.note)}</span>` : ""}
      </div>`;
    } else {
      const code = r.error?.code ?? null;
      const hint = ERROR_HINTS[code] ?? ERROR_HINTS.null;
      const showMsg = r.error?.message && code !== "";
      resultEl.innerHTML = `<div class="rbox rbox--err" role="alert">
        <span class="rbox__label">${TEXT.failed}</span>
        ${code ? `<span class="rbox__code">${esc(code)}</span>` : ""}
        ${showMsg ? `<span class="rbox__msg">${esc(r.error.message)}</span>` : ""}
        <span class="rbox__hint">${esc(hint)}</span>
      </div>`;
    }
    traceEl.innerHTML = (r.trace || []).map(t => `<li>${esc(t)}</li>`).join("");
    traceEl.hidden = !(r.trace && r.trace.length);
    traceEl.classList.toggle("trace--err", !r.ok); // last dot: green for a result, red for an error (green means "matched")
  }

  /**
   * Run a formula (defaults to what's in the box). Returns the engine result.
   * `source` tells onResult who ran it: "user" (typed + Run/Enter), "example", "starter" or "worked".
   * Only "user" runs should be graded. Clicking an example isn't solving a drill.
   */
  function run(formula = input.value, { source = "api" } = {}) {
    const f = String(formula).trim();
    input.value = f.replace(/^=/, "");
    const r = evaluate(f, dataset.cells);
    last = r;
    renderResult(r);
    const painted = sheet.highlight(r.highlights, { animate });
    if (typeof onResult === "function") { try { onResult(r, f, { source }); } catch (e) { console.error("onResult handler failed:", e); } }
    return Object.assign(r, { painted }); // `painted` resolves when the highlight playback finishes
  }

  host.querySelector("[data-form]").addEventListener("submit", e => { e.preventDefault(); run(input.value, { source: "user" }); });
  input.addEventListener("keydown", e => {
    if (e.key === "Escape") { input.value = ""; sheet.clear(); resultEl.innerHTML = ""; traceEl.innerHTML = ""; traceEl.hidden = true; }
  });
  host.querySelectorAll("[data-example]").forEach(b => b.addEventListener("click", () => {
    run(examples[Number(b.dataset.example)].formula, { source: "example" });
    input.focus();
  }));

  if (starter) run(starter, { source: "starter" });

  return {
    run,
    setFormula(f) { input.value = String(f ?? "").replace(/^=/, ""); },
    clearOutput() { sheet.clear(); resultEl.innerHTML = ""; traceEl.innerHTML = ""; traceEl.hidden = true; },
    focus() { input.focus(); },
    lastResult: () => last,
    sheet,
    destroy() { sheet.destroy(); host.innerHTML = ""; },
  };
}
