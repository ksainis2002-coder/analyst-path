/* =========================================================================
   ui/cheatsheet.js: the printable one-page cheat-sheet (spec §5.1, Phase 9)
   -------------------------------------------------------------------------
   Content: content/cheatsheet.json. Every formula on it is run against the
   practice data by js/content.test.js, so the sheet can't print a formula
   that doesn't work. Print styles (components.css) fit it on ONE A4/Letter
   page; the browser tests check the PDF page count.
   ========================================================================= */
import { renderSignature } from "./lesson.js";

const esc = v => String(v ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

export function validateCheatsheet(c) {
  const p = [];
  if (!c?.title || !Array.isArray(c.blocks) || !c.blocks.length) return ["cheatsheet.json needs title and blocks"];
  c.blocks.forEach((b, i) => {
    if (!b.title || !Array.isArray(b.rows) || !b.rows.length) p.push(`blocks[${i}] needs title and rows`);
    (b.rows || []).forEach((r, j) => { if (!(r.formula || r.menu) || !r.what) p.push(`blocks[${i}].rows[${j}] needs formula or menu, and what`); });
  });
  if (!Array.isArray(c.mistakes) || !c.mistakes.every(m => m.length === 3)) p.push("mistakes must be [mistake, what happens, fix] rows");
  return p;
}

export function renderCheatsheet(host, { sheet: C, hrefs }) {
  host.innerHTML = `
  <article class="container view cheat" aria-labelledby="cheat-h">
    <p class="cheat__actions no-print"><button class="btn btn--primary" type="button" data-print>Print / save as PDF</button>
      <span class="muted">Fits on one page. In the print dialog, choose “Save as PDF” to keep a copy.</span></p>
    <header class="cheat__head">
      <h1 id="cheat-h" tabindex="-1">${esc(C.title)}</h1>
      <p class="cheat__sub">${esc(C.subtitle)}</p>
    </header>
    <div class="cheat__grid">
      ${C.blocks.map(b => `<section class="cheat__block" aria-label="${esc(b.title)}">
        <h2 class="cheat__tag">${esc(b.title)}</h2>
        <table class="cheat__tbl"><tbody>${b.rows.map(r => `<tr><th scope="row" class="cheat__f">${r.formula ? `<code class="mono">${renderSignature(r.formula)}</code>` : `<span class="cheat__menu">${esc(r.menu)}</span>`}</th><td class="cheat__d">${esc(r.what)}</td></tr>`).join("")}</tbody></table>
      </section>`).join("")}
    </div>
    <section class="cheat__block cheat__block--wide" aria-label="Common mistakes">
      <h2 class="cheat__tag cheat__tag--warn">Common mistakes</h2>
      <table class="cheat__tbl cheat__tbl--mistakes"><thead><tr><th scope="col">Mistake</th><th scope="col">What happens</th><th scope="col">Fix</th></tr></thead>
        <tbody>${C.mistakes.map(m => `<tr><th scope="row">${esc(m[0])}</th><td>${esc(m[1])}</td><td>${esc(m[2])}</td></tr>`).join("")}</tbody></table>
    </section>
    <footer class="cheat__foot">
      <p><strong>Keys:</strong> ${C.keys.map(k => `<kbd>${esc(k[0])}</kbd> ${esc(k[1])}`).join(" · ")}</p>
      <p>${esc(C.honest)} Practice data: orders A:H · products J:N · reps P:T · tiers V:X.</p>
    </footer>
    <nav class="pager no-print" aria-label="Back"><a class="btn btn--secondary" href="${hrefs.home}">← The path</a></nav>
  </article>`;
  host.querySelector("[data-print]").addEventListener("click", () => window.print());
  return { update() {}, destroy() { host.innerHTML = ""; } };
}
