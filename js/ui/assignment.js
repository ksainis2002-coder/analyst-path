/* =========================================================================
   ui/assignment.js: a graded assignment (spec §7, §8)
   -------------------------------------------------------------------------
   It works like a practical test, not a drill:
     • Each task has its own formula box. Running a formula shows its RESULT
       and lights up the sheet, but NOT whether it's right.
     • "Submit assignment" grades every task at once (grader.js). Each wrong
       task gets a specific message plus that task's hint. Nothing is recorded
       unless the pass mark is met.
     • Passing records the level's gate (e.g. "a1-sales-summary"), which
       unlocks the next level (progress.levelStates).
     • The answer key is a separate file, fetched only after a submission
       attempt (spec §8 no-cheese). Opening it before passing marks a later
       pass as { assisted: true }, "passed with help", like drills.
     • Work in progress (formulas, attempts, key opened, start time) is kept as
       a draft, so a reload loses nothing. A draft never counts as progress.
   ========================================================================= */

import { createSheet } from "./sheet.js";
import { describeOp } from "./cleaning.js";
import { valueCaption } from "./pivot.js";
import { CHART_TYPES, fillSentence } from "./story.js";
import { formatValue } from "./console.js";
import { markdown, inline } from "./md.js";
import { grade, formatSeconds } from "../grader.js";
import { evaluate } from "../engine.js";
import { DATASETS } from "../data.js";
import { createWorkbench, workbenchSubmission } from "./workbench.js";
import { isFormulaCheck } from "../content.js";

const esc = v => String(v ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fmtDate = ts => new Date(ts).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });

/** Pure: grade every task. answers: { taskId: formula }; workspace: the workbench submission (Level 3). */
export function gradeAssignment(assignment, answers, workspace = {}) {
  const results = assignment.tasks.map(t => {
    if (!isFormulaCheck(t.answerCheck)) return { id: t.id, formula: "", ...grade(workspace || {}, t.answerCheck) };
    const cells = DATASETS[t.dataset || assignment.dataset].cells; // a task can name its own sheet (the mock test's Part 1)
    const formula = String(answers?.[t.id] ?? "").trim();
    const verdict = grade({ formula, result: formula ? evaluate(formula, cells) : null }, t.answerCheck);
    return { id: t.id, formula, ...verdict };
  });
  const score = results.filter(r => r.pass).length;
  const passMark = assignment.passMark ?? assignment.tasks.length;
  return { results, score, total: assignment.tasks.length, passMark, passed: score >= passMark };
}

/** The workspace an answer key describes: every task's cleaning steps in order, then its pivot and chart. */
export function keyWorkspace(assignment, key) {
  const sols = assignment.tasks.map(t => key.solutions[t.id]).filter(x => x && typeof x === "object");
  return workbenchSubmission(DATASETS[assignment.dataset], assignment.lab?.panels || [], {
    ops: sols.flatMap(x => x.steps || []),
    pivot: sols.map(x => x.pivot).filter(Boolean).at(-1),
    story: Object.assign({}, ...sols.map(x => x.story).filter(Boolean).map(st => ({ ...st, blanks: undefined })),
      { blanks: Object.assign({}, ...sols.map(x => x.story?.blanks || {})) }),
  });
}
export const keyText = (sol, t) => {
  if (typeof sol === "string") return `<code class="fx-chip">${esc(sol)}</code>`;
  const bits = [];
  if (sol.steps) bits.push(`<ol class="key__steps">${sol.steps.map(o => `<li>${esc(describeOp(o, ["OrderID", "Date", "ProductID", "Region", "Rep", "Channel", "Quantity", "Discount"]))}</li>`).join("")}</ol>`);
  if (sol.pivot) bits.push(`<p>Rows <strong>${esc(sol.pivot.rows)}</strong>, Columns <strong>${esc(sol.pivot.columns || "(none)")}</strong>, Values <strong>${esc(valueCaption(sol.pivot))}</strong>${sol.pivot.showAs && sol.pivot.showAs !== "none" ? `, shown as ${esc(sol.pivot.showAs)}` : ""}, refreshed after cleaning.</p>`);
  if (sol.story?.chart) bits.push(`<p>${esc(CHART_TYPES[sol.story.chart])} of <strong>${esc(sol.story.series)}</strong>${sol.story.sort === "desc" ? ", largest first" : ""}, titled “${esc(sol.story.title)}”.</p>`);
  if (sol.story?.blanks && t.story) bits.push(`<p>“${esc(fillSentence(t.story.sentence, sol.story.blanks))}”</p>`);
  return bits.join("");
};

/**
 * ctx: { assignment, level, store, locked, lockedReason, next, hrefs: { level, next }, loadKey: () => Promise<key>, now?: () => number }
 * Returns { update(), destroy() }.
 */
export function renderAssignment(host, ctx) {
  const { assignment: A, level, store, locked, lockedReason = "", next, hrefs, loadKey } = ctx;
  const now = ctx.now || (() => Date.now());
  const dataset = DATASETS[A.dataset];
  const draftId = A.id;
  const draft = Object.assign({ answers: {}, attempts: 0, keyViewed: false, startedAt: null, lastResult: null, workspace: null }, store.getDraft(draftId) || {});
  const saveDraft = () => { if (!locked) store.setDraft(draftId, draft); };
  const passMark = A.passMark ?? A.tasks.length;
  const hasLab = !!A.lab;
  const isF = t => isFormulaCheck(t.answerCheck);
  const taskHTML = (t, i) => `
          <li class="task${isF(t) ? "" : " task--workspace"}" data-task="${esc(t.id)}">
            <div class="task__head"><span class="task__num" aria-hidden="true">${i + 1}</span><div class="task__ask" id="${esc(A.id)}-${esc(t.id)}-ask">${markdown(t.ask)}</div></div>
            ${isF(t) ? `<div class="fx task__fx">
              <label class="visually-hidden" for="${esc(A.id)}-${esc(t.id)}">Formula for task ${i + 1}</label>
              <span class="fx__eq" aria-hidden="true">=</span>
              <input class="fx__input" id="${esc(A.id)}-${esc(t.id)}" data-input="${esc(t.id)}" type="text" spellcheck="false" autocomplete="off"
                     autocapitalize="characters" autocorrect="off" placeholder="your formula" aria-describedby="${esc(A.id)}-${esc(t.id)}-ask">
              <button class="fx__run" type="button" data-run="${esc(t.id)}">Run</button>
            </div>
            <p class="task__value" data-value="${esc(t.id)}" aria-live="polite"></p>` : ""}
            <div class="task__verdict" data-verdict="${esc(t.id)}" hidden></div>
          </li>`;

  host.innerHTML = `
  <article class="container view stack stack-lg assignment">
    <header class="lesson-head">
      <p class="eyebrow">${esc(level.label)} · Assignment · ${A.tasks.length} tasks · pass with ${passMark}/${A.tasks.length}</p>
      <h1 tabindex="-1">${esc(A.title)}</h1>
      <p class="lesson-head__status" data-status></p>
    </header>
    ${locked ? `<div class="notice notice--locked"><div><span class="notice__tag">Locked</span>${lockedReason} You can read the brief and try formulas, but submissions won't count until then.</div></div>` : ""}
    <section class="prose">${markdown(A.intro)}</section>

    ${hasLab ? `
    <form class="tasks assignment__tasks" data-tasks novalidate aria-label="Tasks">
      <h2 class="section-title">The tasks</h2>
      <ol class="tasks__list tasks__list--compact" role="list">${A.tasks.map(taskHTML).join("")}</ol>
      <div data-workbench class="assignment__workbench"></div>
      <div class="tasks__submit">
        <button class="btn btn--primary" type="submit"${locked ? " disabled" : ""}>Submit assignment</button>
        <span class="muted" data-progress-note></span>
      </div>
      <div class="tasks__result" data-result aria-live="polite" tabindex="-1"></div>
      <div data-key-area></div>
    </form>` : `
    <section class="lab-layout assignment__lab" aria-label="Assignment workspace">
      <div class="lab__sheet">
        <div data-sheet></div>
        <ul class="legend lab__legend" role="list" aria-label="Highlight colours">
          <li><span class="legend__swatch legend__swatch--search" aria-hidden="true"></span>searching</li>
          <li><span class="legend__swatch legend__swatch--match" aria-hidden="true"></span>matched</li>
          <li><span class="legend__swatch legend__swatch--return" aria-hidden="true"></span>returned</li>
        </ul>
      </div>
      <form class="tasks" data-tasks novalidate>
        <ol class="tasks__list" role="list">${A.tasks.map(taskHTML).join("")}</ol>
        <div class="tasks__submit">
          <button class="btn btn--primary" type="submit"${locked ? " disabled" : ""}>Submit assignment</button>
          <span class="muted" data-progress-note></span>
        </div>
        <div class="tasks__result" data-result aria-live="polite" tabindex="-1"></div>
        <div data-key-area></div>
      </form>
    </section>`}

    <div data-after></div>
    <nav class="pager" aria-label="Levels"><a class="btn btn--secondary" href="${hrefs.level}">← ${esc(level.label)}</a></nav>
  </article>`;

  const $ = s => host.querySelector(s);
  const sheet = hasLab ? null : createSheet($("[data-sheet]"), { cells: dataset.cells, range: dataset.range, headerRows: dataset.headerRows ?? 1, label: dataset.label || "Sheet", formats: dataset.formats || {} });
  const wb = hasLab ? createWorkbench($("[data-workbench]"), {
    dataset, panels: A.lab.panels, draft: draft.workspace || {}, locked, spec: A.tasks.find(t => t.story)?.story,
    onChange: () => { if (!draft.startedAt) draft.startedAt = now(); draft.workspace = wb.draft(); saveDraft(); },
  }) : null;

  function showValue(id, formula, { highlight = true } = {}) {
    const out = host.querySelector(`[data-value="${CSS.escape(id)}"]`);
    if (!formula.trim()) { out.textContent = ""; return; }
    const r = evaluate(formula, dataset.cells);
    out.className = `task__value ${r.ok ? "" : "is-error"}`;
    out.innerHTML = r.ok ? `Result: <strong class="mono">${esc(formatValue(r.value).text)}</strong>` : `Result: <strong class="mono">${esc(r.error.code || "error")}</strong> <span class="muted">${esc(r.error.message || "")}</span>`;
    if (highlight && sheet) sheet.highlight(r.highlights);
  }

  function answersFromInputs() {
    const a = {};
    host.querySelectorAll("[data-input]").forEach(el => { a[el.dataset.input] = el.value.trim() ? "=" + el.value.trim().replace(/^=/, "") : ""; });
    return a;
  }

  // Restore the draft
  host.querySelectorAll("[data-input]").forEach(el => {
    const v = draft.answers[el.dataset.input] || "";
    el.value = v.replace(/^=/, "");
    if (v) showValue(el.dataset.input, v, { highlight: false });
    el.addEventListener("input", () => {
      // The shown result belongs to the old formula now: clear it so it can never contradict the box.
      const out = host.querySelector(`[data-value="${CSS.escape(el.dataset.input)}"]`); out.textContent = ""; out.className = "task__value";
      if (!draft.startedAt) draft.startedAt = now();
      draft.answers[el.dataset.input] = el.value.trim() ? "=" + el.value.trim().replace(/^=/, "") : "";
      saveDraft();
    });
    el.addEventListener("keydown", e => { if (e.key === "Enter") { e.preventDefault(); showValue(el.dataset.input, el.value); } });
  });
  host.querySelectorAll("[data-run]").forEach(b => b.addEventListener("click", () => {
    const el = host.querySelector(`[data-input="${CSS.escape(b.dataset.run)}"]`); showValue(b.dataset.run, el.value); el.focus();
  }));

  function renderVerdicts(g) {
    g.results.forEach(r => {
      const t = A.tasks.find(x => x.id === r.id);
      const li = host.querySelector(`[data-task="${CSS.escape(r.id)}"]`), box = li.querySelector("[data-verdict]");
      li.classList.toggle("is-pass", r.pass); li.classList.toggle("is-fail", !r.pass);
      const specific = ["wrong-value", "error", "empty", "cleaning-incomplete", "pivot-totals", "story-blank"].includes(r.reason) ? t.hint : r.hint;
      box.hidden = false;
      box.innerHTML = r.pass ? `<p class="task__ok">✓ Correct</p>`
        : `<p><strong>✗ ${esc(r.message)}</strong></p>${specific ? `<p class="task__hint">${inline(specific)}</p>` : ""}`;
    });
  }

  function renderKeyArea() {
    const area = $("[data-key-area]");
    if (draft.attempts < 1 || locked) { area.innerHTML = ""; return; }
    const passed = store.isPassed(A.id);
    if (draft.keyShown) { if (!area.querySelector(".key")) showKey(); return; } // opened before: show it again after a reload
    area.innerHTML = `<div class="key-offer">
      <button type="button" class="btn btn--secondary" data-show-key>Show the answer key</button>
      <p class="muted">${passed ? "You've passed, so opening the key changes nothing." : "Opening it before you pass means your pass will be recorded as <em>passed with help</em>."}</p></div>`;
    area.querySelector("[data-show-key]").addEventListener("click", showKey);
  }

  async function showKey() {
    const area = $("[data-key-area]");
    area.innerHTML = `<p class="muted">Loading the answer key…</p>`;
    let key;
    try { key = await loadKey(); } catch (e) { area.innerHTML = `<div class="notice notice--warn"><div><span class="notice__tag">Couldn't load the key</span>${esc(e.message)}</div></div>`; return; }
    if (!store.isPassed(A.id)) draft.keyViewed = true;
    draft.keyShown = true; saveDraft();
    area.innerHTML = `<section class="key card" aria-labelledby="${esc(A.id)}-key-h"><h2 class="section-title" id="${esc(A.id)}-key-h">Answer key</h2>
      <ol class="key__list">${A.tasks.map(t => `<li>${keyText(key.solutions[t.id], t)}<div class="key__explain">${markdown(key.explain[t.id])}</div></li>`).join("")}</ol></section>`;
    update();
  }

  $("[data-tasks]").addEventListener("submit", e => {
    e.preventDefault();
    if (locked) return;
    const answers = answersFromInputs();
    Object.assign(draft.answers, answers);
    draft.attempts += 1;
    if (wb) draft.workspace = wb.draft();
    const g = gradeAssignment(A, answers, wb ? wb.submission() : {});
    for (const [id, f] of Object.entries(answers)) showValue(id, f, { highlight: false }); // results always match the graded formulas
    draft.lastResult = { score: g.score, at: now(), results: g.results.map(r => ({ id: r.id, pass: r.pass })) };
    saveDraft();
    renderVerdicts(g);
    const already = store.isPassed(A.id);
    if (g.passed && !already) {
      const seconds = draft.startedAt ? (now() - draft.startedAt) / 1000 : null;
      store.recordPass(A.id, { score: g.score, total: g.total, submissions: draft.attempts, seconds, assisted: !!draft.keyViewed });
    }
    const res = $("[data-result]");
    res.innerHTML = g.passed
      ? `<p class="tasks__msg is-pass">${g.score}/${g.total} correct. <strong>Passed.</strong>${already ? " (You'd already passed. A resubmission never removes a pass.)" : ""}</p>`
      : `<p class="tasks__msg is-fail">${g.score}/${g.total} correct. You need ${g.passMark}. <strong>Not passed yet.</strong> Fix the tasks marked ✗ and submit again.</p>`;
    renderKeyArea();
    update();
    const firstWrong = g.results.find(r => !r.pass);
    const firstInput = firstWrong && host.querySelector(`[data-input="${CSS.escape(firstWrong.id)}"]`);
    if (firstInput) firstInput.focus({ preventScroll: false });
    else if (firstWrong) host.querySelector(`[data-task="${CSS.escape(firstWrong.id)}"]`).scrollIntoView({ block: "center" });
    else res.focus?.();
  });

  function update() {
    const p = store.getPass(A.id);
    $("[data-status]").innerHTML = p
      ? `<span class="pill pill--complete">Passed ${esc(fmtDate(p.at))}${p.assisted ? " · with help" : ""}</span>`
      : `<span class="pill pill--${locked ? "locked" : "open"}">${locked ? "Locked" : "Not passed yet"}</span>${draft.attempts ? ` <span class="muted">${draft.attempts} submission${draft.attempts === 1 ? "" : "s"}${draft.lastResult ? ` · last: ${draft.lastResult.score}/${A.tasks.length}` : ""}</span>` : ""}`;
    const nF = A.tasks.filter(isF).length;
    $("[data-progress-note]").textContent = nF === A.tasks.length ? `${Object.values(answersFromInputs()).filter(Boolean).length}/${A.tasks.length} answered` : nF ? `${Object.values(answersFromInputs()).filter(Boolean).length}/${nF} formulas typed` : "Every task is checked from your workspace when you submit.";
    $("[data-after]").innerHTML = p ? `
      <section class="claim is-earned">
        <p class="claim__q">You can now honestly say${p.assisted ? " (passed with help)" : ""}</p>
        <p class="claim__text">“${esc(level.claimAfter)}”</p>
        <p class="claim__note">${p.seconds ? `Completed in ${esc(formatSeconds(p.seconds))} over ${p.submissions} submission${p.submissions === 1 ? "" : "s"}. ` : ""}${next ? `${esc(next.label)}: ${esc(next.title)} is unlocked.` : ""}${p.assisted ? " You opened the answer key before passing. Consider redoing it later without the key." : ""}</p>
      </section>
      ${next ? `<p><a class="btn btn--primary" href="${hrefs.next}">Go to ${esc(next.label)}: ${esc(next.title)} →</a></p>` : ""}` : "";
  }

  host.querySelectorAll("[data-input]").forEach(el => el.addEventListener("input", () => update()));
  // Re-show last verdicts after a reload, so feedback isn't lost.
  if (draft.lastResult && draft.attempts) {
    renderVerdicts(gradeAssignment(A, draft.answers, wb ? wb.submission() : {}));
    $("[data-result]").innerHTML = `<p class="tasks__msg">Your last submission: ${draft.lastResult.score}/${A.tasks.length}.</p>`;
  }
  renderKeyArea();
  update();
  return { update, workbench: wb, destroy() { sheet?.destroy(); wb?.destroy(); host.innerHTML = ""; } };
}
