/* =========================================================================
   ui/case.js: a case study (spec §9), e.g. Case A "Q3 sales review for the boss"
   -------------------------------------------------------------------------
   One narrative piece of work in ordered steps (clean → enrich with lookups →
   pivot → decide → write it up), on ONE workspace (ui/workbench.js), so
   every step builds on the data the learner actually produced:
     • a workspace step (cleaning / pivot / story) is graded by its Check
       button against the workspace as it is right now;
     • a formula step is typed in the step's own box and runs against the
       learner's CURRENT working sheet: a lookup on a still-mistyped ID is #N/A.
   Each step records "<case>:<step>" when passed; all steps → "<case>".
   After 2 wrong checks a step offers its solution; using it marks the step
   (and so the case) "with help", like drills. Work in progress is a draft.
   When every step is done, the deliverable (chart + title + the finding) is
   assembled from the learner's own work.
   ========================================================================= */

import { createWorkbench } from "./workbench.js";
import { fillSentence } from "./story.js";
import { formatValue } from "./console.js";
import { markdown, inline } from "./md.js";
import { grade } from "../grader.js";
import { evaluate } from "../engine.js";
import { DATASETS } from "../data.js";
import { isFormulaCheck } from "../content.js";

const esc = v => String(v ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

/* ---------- pure ---------- */
export const stepTaskId = (c, st) => `${c.id}:${st.id}`;
/** "=G{row:O1088}" → "=G89": the row that order is on in the working data right now. */
export function resolveRowRefs(formula, rows) {
  return String(formula).replace(/\{row:([^}]+)\}/g, (_, id) => {
    const i = rows.findIndex(r => r[0] === id);
    if (i < 0) throw new Error(`Order ${id} isn't in the data.`);
    return String(i + 2);
  });
}
/** Grade one step against the workspace (and, for a formula step, the formula run on the working sheet). */
export function gradeStep(step, { workspace = {}, formula = "", cells = {} } = {}) {
  if (isFormulaCheck(step.answerCheck)) {
    const f = String(formula || "").trim();
    return grade({ formula: f, result: f ? evaluate(f, cells) : null }, step.answerCheck);
  }
  return grade(workspace, step.answerCheck);
}
export const caseProgress = (c, isPassed) => { const done = c.steps.filter(s => isPassed(stepTaskId(c, s))).length; return { done, total: c.steps.length, complete: done === c.steps.length }; };

/* ---------- DOM ---------- */
/** ctx: { caseStudy, store, locked, lockedReason, hrefs: { back } } → { update(), destroy() } */
export function renderCase(host, ctx) {
  const { caseStudy: C, store, locked, lockedReason = "", hrefs } = ctx;
  const dataset = DATASETS[C.dataset];
  const draft = Object.assign({ workspace: null, formulas: {}, tries: {}, assisted: {} }, store.getDraft(C.id) || {});
  const save = () => { if (!locked) store.setDraft(C.id, draft); };
  const finding = C.steps.find(s => s.story);

  host.innerHTML = `
  <article class="container view stack stack-lg case">
    <header class="lesson-head">
      <p class="eyebrow">Case study · ${C.steps.length} steps · ${esc(C.estMinutes)} min</p>
      <h1 tabindex="-1">${esc(C.title)}</h1>
      <p class="lesson-head__status" data-status></p>
    </header>
    ${locked ? `<div class="notice notice--locked"><div><span class="notice__tag">Locked</span>${lockedReason} You can read the case and try things in the workspace, but steps won't be recorded until then.</div></div>` : ""}
    <section class="prose">${markdown(C.intro)}</section>
    <section aria-labelledby="steps-h">
      <h2 class="section-title" id="steps-h">The steps</h2>
      <ol class="case__steps" role="list">${C.steps.map((st, i) => `
        <li class="case-step" data-step="${esc(st.id)}">
          <div class="case-step__head"><span class="task__num" aria-hidden="true">${i + 1}</span>
            <h3 class="case-step__title">${esc(st.title)}</h3><span class="case-step__state" data-state></span></div>
          <div class="case-step__ask">${markdown(st.ask)}</div>
          ${isFormulaCheck(st.answerCheck) ? `<div class="fx task__fx"><label class="visually-hidden" for="${esc(C.id)}-${esc(st.id)}">Formula for step ${i + 1}</label><span class="fx__eq" aria-hidden="true">=</span>
            <input class="fx__input" id="${esc(C.id)}-${esc(st.id)}" data-input type="text" spellcheck="false" autocomplete="off" autocapitalize="characters" autocorrect="off" placeholder="your formula, on your working sheet">
            <button class="fx__run" type="button" data-run>Run</button></div>` : ""}
          <div class="case-step__actions">
            ${isFormulaCheck(st.answerCheck) ? "" : `<button class="btn btn--primary" type="button" data-check>Check</button>`}
            <button class="btn btn--quiet" type="button" data-solution hidden>Show a solution</button>
          </div>
          <div class="drill__feedback" data-feedback aria-live="polite"></div>
        </li>`).join("")}</ol>
    </section>
    <section aria-labelledby="ws-h"><h2 class="section-title" id="ws-h">Your workspace</h2><div data-workbench></div></section>
    <div data-deliverable></div>
    <nav class="pager" aria-label="Back"><a class="btn btn--secondary" href="${hrefs.back}">← Back</a></nav>
  </article>`;
  const $ = s => host.querySelector(s);
  const card = st => host.querySelector(`[data-step="${CSS.escape(st.id)}"]`);

  const wb = createWorkbench($("[data-workbench]"), {
    dataset, panels: C.lab.panels, draft: draft.workspace || {}, locked, spec: finding?.story,
    onChange: () => { draft.workspace = wb.draft(); save(); },
  });

  function check(st) {
    const el = card(st), fb = el.querySelector("[data-feedback]");
    const formula = isFormulaCheck(st.answerCheck) ? el.querySelector("[data-input]").value : "";
    const f = formula.trim() ? "=" + formula.trim().replace(/^=/, "") : "";
    const cells = wb.cells();
    if (f) {
      const r = evaluate(f, cells), out = formatValue(r.ok ? r.value : r.error.code || "error").text;
      wb.cleaning?.sheet()?.highlight(r.highlights);
      el.querySelector("[data-feedback]").dataset.value = out;
    }
    const v = gradeStep(st, { workspace: wb.submission(), formula: f, cells });
    if (v.reason === "empty") { fb.className = "drill__feedback"; fb.innerHTML = `<p>Type a formula first.</p>`; return; }
    const id = stepTaskId(C, st);
    if (v.pass) {
      if (!locked && !store.isPassed(id)) store.recordPass(id, { assisted: !!draft.assisted[st.id], tries: (draft.tries[st.id] || 0) + 1 });
      fb.className = "drill__feedback is-pass";
      fb.innerHTML = `<p class="drill__ok"><strong>Correct.</strong>${f ? ` It returns <span class="mono">${esc(fb.dataset.value)}</span>.` : ""}${draft.assisted[st.id] ? " Counted as solved with help." : ""}${locked ? " (Not recorded: locked.)" : ""}</p>`;
    } else {
      draft.tries[st.id] = (draft.tries[st.id] || 0) + 1; save();
      fb.className = "drill__feedback is-fail";
      const specific = ["wrong-value", "error", "pivot-totals", "cleaning-incomplete", "story-blank"].includes(v.reason) ? st.hint : v.hint;
      fb.innerHTML = `<p><strong>Not yet.</strong> ${f && fb.dataset.value ? `It returns <span class="mono">${esc(fb.dataset.value)}</span>. ` : ""}${esc(v.message)}</p>${specific ? `<p class="drill__hint">${inline(specific)}</p>` : ""}`;
    }
    update();
  }

  function reveal(st) {
    draft.assisted[st.id] = true; save();
    const el = card(st), fb = el.querySelector("[data-feedback]"), sol = st.solution;
    fb.className = "drill__feedback";
    if (sol.formula) {
      let f; try { f = resolveRowRefs(sol.formula, wb.rows()); } catch (e) { fb.innerHTML = `<p>${esc(e.message)}</p>`; return; }
      el.querySelector("[data-input]").value = f.replace(/^=/, "");
      draft.formulas[st.id] = f; save();
      fb.innerHTML = `<p>One solution is in the box. Press <strong>Run</strong> to check it. It will count as <em>solved with help</em>.</p>`;
      el.querySelector("[data-input]").focus();
    } else {
      if (sol.steps && wb.cleaning) wb.cleaning.applySteps(sol.steps);
      if (sol.pivot && wb.pivot) wb.pivot.setConfig(sol.pivot, { source: "solution" });
      if (sol.refresh && wb.pivot) wb.pivot.refresh();
      if (sol.story && wb.story) wb.story.setState(sol.story);
      draft.workspace = wb.draft(); save();
      fb.innerHTML = `<p>One solution has been applied in the workspace${sol.explain ? `: ${inline(sol.explain)}` : "."} Look at what changed, then press <strong>Check</strong>. It will count as <em>solved with help</em>.</p>`;
      el.querySelector("[data-check]").focus();
    }
  }

  for (const st of C.steps) {
    const el = card(st);
    const input = el.querySelector("[data-input]");
    if (input) {
      input.value = (draft.formulas[st.id] || "").replace(/^=/, "");
      input.addEventListener("input", () => { draft.formulas[st.id] = input.value.trim() ? "=" + input.value.trim().replace(/^=/, "") : ""; save(); });
      input.addEventListener("keydown", e => { if (e.key === "Enter") { e.preventDefault(); check(st); } });
      el.querySelector("[data-run]").addEventListener("click", () => check(st));
    }
    el.querySelector("[data-check]")?.addEventListener("click", () => check(st));
    el.querySelector("[data-solution]").addEventListener("click", () => reveal(st));
  }

  function deliverable() {
    const figure = host.querySelector(".workbench__panel--chart .chart-frame");
    const st = wb.story?.state() || {};
    return `<section class="deliverable" aria-labelledby="dl-h">
      <p class="eyebrow">Your deliverable</p>
      <h2 id="dl-h" class="deliverable__title">${esc(st.title || C.title)}</h2>
      <div class="deliverable__chart">${figure ? figure.querySelector("[data-chart]").innerHTML : ""}</div>
      ${finding ? `<p class="deliverable__finding">${esc(fillSentence(finding.story.sentence, st.blanks || {}))}</p>` : ""}
      <p class="deliverable__note muted">Built from your own cleaned data, pivots and chart. In Excel this is one slide: the chart, its finding-title, and these two sentences.</p>
    </section>`;
  }

  function update() {
    const pr = caseProgress(C, id => store.isPassed(id));
    for (const st of C.steps) {
      const p = store.getPass(stepTaskId(C, st)), el = card(st);
      el.classList.toggle("is-pass", !!p);
      el.querySelector("[data-state]").innerHTML = p ? `<span class="pill pill--complete">${p.assisted ? "Done with help" : "Done"}</span>` : "";
      el.querySelector("[data-solution]").hidden = !!p || (draft.tries[st.id] || 0) < 2;
    }
    const assisted = C.steps.some(st => store.getPass(stepTaskId(C, st))?.assisted);
    if (pr.complete && !locked && !store.isPassed(C.id)) store.recordPass(C.id, { assisted });
    const whole = store.getPass(C.id);
    $("[data-status]").innerHTML = whole ? `<span class="pill pill--complete">Complete${whole.assisted ? " · with help" : ""}</span>` : `<span class="pill pill--${locked ? "locked" : "open"}">${locked ? "Locked" : "In progress"}</span> <span class="muted">${pr.done}/${pr.total} steps</span>`;
    $("[data-deliverable]").innerHTML = pr.complete ? deliverable() + `<section class="claim is-earned"><p class="claim__q">You can now honestly say${assisted ? " (some steps with help)" : ""}</p><p class="claim__text">“${esc(C.claimAfter)}”</p></section>` : "";
  }
  update();
  return { update, workbench: wb, destroy() { wb.destroy(); host.innerHTML = ""; } };
}
