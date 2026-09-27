/* =========================================================================
   ui/sheet.js: rendered spreadsheet + search → match → return highlighting
   -------------------------------------------------------------------------
   Ported from v1 buildSheet() and the h-* highlight classes.
   Split of responsibilities (spec §5.2):
     engine.js  decides WHICH cells to highlight: evaluate().highlights = [{cell, role}]
     sheet.js   decides HOW they look: adds `cell--<role>` classes (styled in
                components.css from the role tokens in tokens.css)

   Usage:
     const sheet = createSheet(host, { cells, range: "A1:J25", headerRows: 1 });
     await sheet.highlight(result.highlights);   // animated in order, unless reduced motion
     sheet.clear();

   Number formats: pass `formats: { B: "date", H: "percent" }` to SHOW a
   column's numbers as dates or percentages. The cell still holds the raw
   number, as in Excel.

   The pure helpers (parseRange, rangeOf, displayValue, planHighlights) are
   exported for the Node tests. The rest needs a DOM.
   ========================================================================= */

import { colToIndex, indexToCol, formatAs } from "../data.js";

export const ROLE_CLASS = Object.freeze({ scan: "cell--scan", search: "cell--search", match: "cell--match", return: "cell--return" });
const ALL_ROLE_CLASSES = Object.values(ROLE_CLASS);

/* ---------- pure helpers ---------- */

/** "A1:J25" → { c1: 1, r1: 1, c2: 10, r2: 25 } (normalised so c1<=c2, r1<=r2). */
export function parseRange(range) {
  const m = /^\$?([A-Z]+)\$?(\d+):\$?([A-Z]+)\$?(\d+)$/.exec(String(range).toUpperCase());
  if (!m) throw new Error(`Bad range "${range}", expected e.g. "A1:J25"`);
  const [a, b] = [colToIndex(m[1]), colToIndex(m[3])], [r, s] = [Number(m[2]), Number(m[4])];
  return { c1: Math.min(a, b), r1: Math.min(r, s), c2: Math.max(a, b), r2: Math.max(r, s) };
}

/** Smallest range starting at A1 that covers every non-empty cell. */
export function rangeOf(cells) {
  let c2 = 1, r2 = 1;
  for (const key of Object.keys(cells)) {
    const m = /^([A-Z]+)(\d+)$/.exec(key); if (!m) continue;
    c2 = Math.max(c2, colToIndex(m[1])); r2 = Math.max(r2, Number(m[2]));
  }
  return `A1:${indexToCol(c2)}${r2}`;
}

/** How a raw cell value is shown in the grid: raw like Excel's General format (no thousands separators),
 *  unless its column has a number format ("date", "percent"). */
export function displayValue(v, format) {
  if (v === undefined || v === null) return "";
  if (typeof v === "boolean") return v ? "TRUE" : "FALSE";
  return formatAs(v, format) ?? String(v);
}

/**
 * Turn the engine's ordered highlight list into playback steps.
 * Drops cells outside the rendered range and exact repeats, but keeps order,
 * so a cell can be "scan" then "match", as the engine reported it.
 */
export function planHighlights(highlights, visible) {
  const seen = new Set(), steps = [];
  for (const h of highlights || []) {
    if (!h || !ROLE_CLASS[h.role] || !visible(h.cell)) continue;
    const k = h.cell + "|" + h.role;
    if (seen.has(k)) continue;
    seen.add(k); steps.push({ cell: h.cell, role: h.role });
  }
  return steps;
}

/** Delay between steps: quick enough that a 24-row scan takes under a second. */
export function stepDelay(n, { perStep = 45, maxTotal = 900 } = {}) {
  return n <= 1 ? 0 : Math.max(8, Math.min(perStep, Math.floor(maxTotal / n)));
}

const esc = v => String(v).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
let uid = 0;

/* ---------- DOM ---------- */

/**
 * @param {HTMLElement} host
 * @param {{cells: Object, range?: string, headerRows?: number, label?: string}} opts
 */
export function createSheet(host, { cells, range, headerRows = 1, label = "Sheet", formats = {} } = {}) {
  if (!cells) throw new Error("createSheet needs { cells }");
  const R = parseRange(range || rangeOf(cells));
  const id = `sheet-${++uid}`;
  const cols = []; for (let c = R.c1; c <= R.c2; c++) cols.push(indexToCol(c));
  // A column with nothing in it (like v1's G, between the two tables) is drawn as a quiet gap.
  const gap = new Set(cols.filter(col => { for (let r = R.r1; r <= R.r2; r++) if ((col + r) in cells) return false; return true; }));
  const rangeText = `${cols[0]}${R.r1}:${cols.at(-1)}${R.r2}`;

  let html = `<div class="sheet-wrap" tabindex="0" role="region" aria-label="${esc(label)}, cells ${rangeText}. Scrollable." id="${id}">
    <table class="sheet"><caption class="visually-hidden">${esc(label)} (${rangeText})</caption>
    <thead><tr><th class="sheet__corner" scope="col"><span class="visually-hidden">Row</span></th>`;
  cols.forEach(c => { html += `<th class="sheet__colhead" scope="col">${c}</th>`; });
  html += `</tr></thead><tbody>`;
  for (let r = R.r1; r <= R.r2; r++) {
    html += `<tr${r < R.r1 + headerRows ? ' class="is-header"' : ""}><th class="sheet__rowhead" scope="row">${r}</th>`;
    for (const c of cols) {
      const key = c + r, v = cells[key];
      const fmt = r >= R.r1 + headerRows ? formats[c] : null;
      const cls = [gap.has(c) ? "is-gap" : "", typeof v === "number" ? "is-num" : ""].filter(Boolean).join(" ");
      const shown = displayValue(v, fmt);
      const title = fmt && typeof v === "number" ? ` title="${esc(`${shown} (stored as ${v})`)}"` : "";
      html += `<td data-cell="${key}"${cls ? ` class="${cls}"` : ""}${title}>${esc(shown)}</td>`;
    }
    html += `</tr>`;
  }
  html += `</tbody></table></div>`;
  host.innerHTML = html;

  const wrap = host.querySelector(".sheet-wrap");
  const index = new Map();
  wrap.querySelectorAll("td[data-cell]").forEach(td => index.set(td.dataset.cell, td));
  let playToken = 0;

  const reducedMotion = () => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

  /** Scroll the sheet (only the sheet, never the page) so a box of cells is visible below/right of the sticky headers. */
  function revealBox(box) {
    const head = wrap.querySelector("thead")?.offsetHeight || 0;
    const rowHead = wrap.querySelector(".sheet__rowhead")?.offsetWidth || 0;
    const viewH = wrap.clientHeight - head, viewW = wrap.clientWidth - rowHead;
    const fitV = box.bottom - box.top <= viewH, fitH = box.right - box.left <= viewW;
    // Vertical: bring the box in; if it doesn't fit, favour its bottom edge (where the answer usually is).
    if (box.top - head < wrap.scrollTop || !fitV) wrap.scrollTop = fitV ? box.top - head - 4 : box.bottom - wrap.clientHeight + 4;
    else if (box.bottom > wrap.scrollTop + wrap.clientHeight) wrap.scrollTop = box.bottom - wrap.clientHeight + 4;
    if (box.left - rowHead < wrap.scrollLeft || !fitH) wrap.scrollLeft = fitH ? box.left - rowHead - 4 : box.right - wrap.clientWidth + 4;
    else if (box.right > wrap.scrollLeft + wrap.clientWidth) wrap.scrollLeft = box.right - wrap.clientWidth + 4;
  }
  const boxOf = tds => tds.reduce((b, td) => ({
    top: Math.min(b.top, td.offsetTop), left: Math.min(b.left, td.offsetLeft),
    bottom: Math.max(b.bottom, td.offsetTop + td.offsetHeight), right: Math.max(b.right, td.offsetLeft + td.offsetWidth),
  }), { top: Infinity, left: Infinity, bottom: -Infinity, right: -Infinity });

  function reveal(key) { const td = index.get(key); if (td) revealBox(boxOf([td])); }

  /** After a run: show the whole search → match → return story if it fits; otherwise make sure the answer is visible. */
  function revealStory(steps) {
    const key = s => index.get(s.cell);
    const story = steps.filter(s => s.role !== "scan").map(key);
    if (!story.length) return;
    const box = boxOf(story);
    const head = wrap.querySelector("thead")?.offsetHeight || 0, rowHead = wrap.querySelector(".sheet__rowhead")?.offsetWidth || 0;
    if (box.right - box.left <= wrap.clientWidth - rowHead && box.bottom - box.top <= wrap.clientHeight - head) revealBox(box);
    else {
      const answer = [...steps].reverse().find(s => s.role === "return") || [...steps].reverse().find(s => s.role === "match");
      if (answer) reveal(answer.cell);
    }
  }

  function clear() {
    playToken++; // cancels any playback in progress
    for (const td of index.values()) td.classList.remove(...ALL_ROLE_CLASSES);
  }

  /**
   * Apply engine highlights. Resolves when the last one is painted.
   * @param {{cell:string, role:string}[]} highlights  evaluate().highlights, in engine order
   * @param {{animate?: boolean}} [opts]  animate (default true) plays them in order; it's skipped under reduced motion
   */
  function highlight(highlights, { animate = true } = {}) {
    clear();
    const token = playToken;
    const steps = planHighlights(highlights, key => index.has(key));
    const paint = s => index.get(s.cell).classList.add(ROLE_CLASS[s.role]);
    if (!animate || reducedMotion() || steps.length === 0) {
      steps.forEach(paint);
      revealStory(steps);
      return Promise.resolve(steps);
    }
    const delay = stepDelay(steps.length);
    return new Promise(resolve => {
      let i = 0;
      const tick = () => {
        if (token !== playToken) return resolve(steps.slice(0, i)); // superseded by a newer run
        paint(steps[i]);
        if (steps[i].role !== "scan") reveal(steps[i].cell);
        i++;
        if (i < steps.length) setTimeout(tick, delay);
        else { revealStory(steps); resolve(steps); }
      };
      tick();
    });
  }

  return {
    el: wrap,
    range: rangeText,
    highlight,
    clear,
    reveal,
    cell: key => index.get(key) || null,
    /** Current highlight state, e.g. { H7: ["scan","match"] }. Used by tests and graders. */
    state() {
      const out = {};
      for (const [key, td] of index) {
        const roles = Object.keys(ROLE_CLASS).filter(r => td.classList.contains(ROLE_CLASS[r]));
        if (roles.length) out[key] = roles;
      }
      return out;
    },
    destroy() { clear(); host.innerHTML = ""; },
  };
}
