/* =========================================================================
   ui/lesson.js: renders a lesson (and a level gate) from content JSON
   -------------------------------------------------------------------------
   Sections, in order (spec §5.3): concept · syntax · worked example ·
   common mistakes · practice (drills in the live console) · checkpoint quiz ·
   honesty lines (claimAfter / notYet) · lesson pager.

   Progress rules (spec §3: earned by doing):
     • A drill counts only when a formula YOU typed and ran passes the
       grader. Clicking the worked example or loading a solution never counts
       on its own. If you reveal the solution and then run it, the pass is
       recorded as { assisted: true } and shown as "solved with help".
     • The checkpoint counts when the quiz is passed.
     • In a locked level you can read and experiment, but drills and quizzes
       don't record anything.
   ========================================================================= */

import { createConsole } from "./console.js";
import { createWorkbench } from "./workbench.js";
import { createQuiz } from "./quiz.js";
import { markdown, inline } from "./md.js";
import { grade } from "../grader.js";
import { DATASETS } from "../data.js";
import { drillTaskId, checkpointTaskId, lessonProgress } from "../content.js";

const esc = v => String(v ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fmtDate = ts => new Date(ts).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });

/** Split "a, b, [c], …" at top-level commas (brackets/quotes respected). */
function topLevelArgs(s) {
  const out = []; let d = 0, q = false, cur = "";
  for (const ch of s) {
    if (ch === '"') q = !q;
    if (!q && "([".includes(ch)) d++;
    if (!q && ")]".includes(ch)) d--;
    if (ch === "," && d === 0 && !q) { out.push(cur); cur = ""; continue; }
    cur += ch;
  }
  out.push(cur);
  return out;
}

/** "=SUMIFS(sum_range, range1, criteria1)" → HTML with each argument in its own colour. */
export function renderSignature(sig) {
  const m = /^(=?)\s*([A-Z][A-Z0-9.]*)\s*\(([\s\S]*)\)\s*$/i.exec(sig.trim());
  if (!m) return `<span>${esc(sig)}</span>`;
  const args = topLevelArgs(m[3]).map((a, i) => {
    const t = a.trim();
    return t === "…" || t === "..." ? `<span class="syn-ellipsis">${esc(t)}</span>` : `<span class="syn-arg syn-arg--${(i % 4) + 1}">${esc(t)}</span>`;
  });
  return `${esc(m[1])}<span class="syn-fn">${esc(m[2].toUpperCase())}</span>(${args.join(", ")})`;
}

function syntaxBlock(s) {
  const argNames = (topLevelArgs((/\(([\s\S]*)\)/.exec(s.signature) || [, ""])[1])).map(a => a.trim());
  return `<div class="syntax">
    <div class="syntax__sig mono" role="text">${renderSignature(s.signature)}</div>
    ${s.args?.length ? `<dl class="syntax__args">${s.args.map(a => {
      const i = argNames.findIndex(n => n.replace(/^\[|\]$/g, "") === a.name.replace(/^\[|\]$/g, ""));
      return `<div class="syntax__arg"><dt><span class="syn-swatch syn-arg--${i >= 0 ? (i % 4) + 1 : 0}" aria-hidden="true"></span><code>${esc(a.name)}</code></dt><dd>${inline(a.desc)}</dd></div>`;
    }).join("")}</dl>` : ""}
  </div>`;
}

function statusText(pr) {
  const parts = [];
  if (pr.drillsTotal) parts.push(`${pr.drillsDone}/${pr.drillsTotal} drills`);
  if (pr.hasCheckpoint) parts.push(pr.checkpoint ? "checkpoint passed" : "checkpoint to go");
  return parts.join(" · ");
}

/**
 * Render a lesson into `host`. Returns a controller: { update(), destroy() }.
 * ctx: { lesson, level (curriculum entry), order, total, store, locked, lockedReason, hrefs: { level, lesson(n), gate } , hasGate }
 */
export function renderLesson(host, ctx) {
  const { lesson, level, order, total, store, locked, lockedReason = "", hrefs, hasGate } = ctx;
  const dataset = DATASETS[lesson.dataset];
  const syntax = lesson.syntax ? (Array.isArray(lesson.syntax) ? lesson.syntax : [lesson.syntax]) : [];
  const hasDrills = lesson.drills.length > 0;
  // Level 3: a lesson can use the workbench (cleaning / pivot / chart) instead of the plain console.
  const panels = lesson.lab?.panels || null;
  const isWB = !!panels;
  const byFormula = d => (Array.isArray(d.answerCheck) ? d.answerCheck : [d.answerCheck]).every(c => c.type === "value" || c.type === "formula-uses");
  const w = lesson.worked;
  const workedAction = !isWB ? "Run it in the console ↓" : w.formula ? "Try it in the formula bar ↓" : w.pivot ? "Show it in the pivot ↓" : "";

  host.innerHTML = `
  <article class="container view lesson stack stack-lg">
    <header class="lesson-head">
      <p class="eyebrow">${esc(level.label)} · Lesson ${order} of ${total} · ${esc(lesson.estMinutes)} min</p>
      <h1 tabindex="-1">${esc(lesson.title)}</h1>
      <p class="lesson-head__status" data-status></p>
    </header>
    ${locked ? `<div class="notice notice--locked"><div><span class="notice__tag">Locked level</span>${lockedReason} You can read this lesson and try formulas in the console, but drills and the checkpoint won't count until the level unlocks.</div></div>` : ""}

    <section class="prose" aria-labelledby="concept-h"><h2 id="concept-h" class="section-title">The idea</h2>${markdown(lesson.concept)}</section>

    ${syntax.length ? `<section aria-labelledby="syntax-h"><h2 id="syntax-h" class="section-title">Syntax</h2>${syntax.map(syntaxBlock).join("")}</section>` : ""}

    <section class="card worked prose" aria-labelledby="worked-h">
      <h2 id="worked-h" class="section-title">Worked example</h2>
      <p class="worked__prompt">${inline(w.prompt)}</p>
      ${w.formula ? `<p><code class="fx-chip worked__formula">${esc(w.formula)}</code></p>` : ""}
      ${markdown(w.explain)}
      ${workedAction ? `<p><button class="btn btn--secondary" type="button" data-run-worked>${workedAction}</button></p>` : ""}
    </section>

    ${lesson.mistakes.length ? `<section class="prose" aria-labelledby="mistakes-h"><h2 id="mistakes-h" class="section-title">Common mistakes</h2>
      <ul class="mistakes">${lesson.mistakes.map(m => `<li>${inline(m)}</li>`).join("")}</ul></section>` : ""}

    <section class="practice" aria-labelledby="practice-h" data-practice>
      <h2 id="practice-h" class="section-title">Practice${hasDrills ? ` · ${lesson.drills.length} drill${lesson.drills.length === 1 ? "" : "s"}` : ""}</h2>
      <p class="muted practice__intro">${!hasDrills ? "Try formulas in the console. There are no graded drills in this lesson." : isWB ? "Do each drill in the workspace below, then press <strong>Check</strong>. It looks at the data and the pivot you actually made, not at which buttons you pressed." : "Type each answer as a formula in the console and press Enter. It's checked the moment you run it."}</p>
      <div data-lab></div>
    </section>

    ${lesson.checkpoint ? `<section aria-labelledby="checkpoint-h"><h2 id="checkpoint-h" class="section-title">Checkpoint</h2>
      <p class="muted" data-checkpoint-note></p><div data-quiz></div></section>` : ""}

    <section class="claim" data-claim aria-live="polite"></section>

    <nav class="pager" aria-label="Lessons">
      ${order > 1 ? `<a class="btn btn--secondary" href="${hrefs.lesson(order - 1)}">← Lesson ${order - 1}</a>` : `<a class="btn btn--secondary" href="${hrefs.level}">← ${esc(level.label)}</a>`}
      ${order < total ? `<a class="btn btn--primary" href="${hrefs.lesson(order + 1)}">Lesson ${order + 1} →</a>`
        : hasGate ? `<a class="btn btn--primary" href="${hrefs.gate}">${esc(level.gate.label)} →</a>`
        : `<a class="btn btn--primary" href="${hrefs.level}">Back to ${esc(level.label)} →</a>`}
    </nav>
  </article>`;

  const $ = s => host.querySelector(s);
  const progress = () => lessonProgress(lesson, id => store.isPassed(id));

  /* ---------- drills ---------- */
  const attempts = lesson.drills.map(() => 0);
  const assisted = lesson.drills.map(() => false);
  let active = Math.max(0, lesson.drills.findIndex(d => !store.isPassed(drillTaskId(lesson, d))));
  let panel = null;

  if (hasDrills) {
    panel = document.createElement("div");
    panel.className = "drill";
    panel.innerHTML = `
      <div class="drill__head">
        <span class="drill__label" data-drill-label></span>
        <ol class="drill__dots" role="list" data-dots></ol>
      </div>
      <div class="drill__ask" data-ask></div>
      <div class="drill__feedback" data-feedback aria-live="polite"></div>
      <div class="drill__actions">
        <button type="button" class="btn btn--quiet" data-prev>← Previous</button>
        <button type="button" class="btn btn--primary" data-check hidden>Check</button>
        <button type="button" class="btn btn--quiet" data-solution hidden>Show a solution</button>
        <button type="button" class="btn btn--secondary drill__next" data-next>Next drill →</button>
      </div>`;
  }

  let lab = null, wb = null;
  if (isWB) {
    if (panel) $("[data-lab]").append(panel);
    const wbHost = document.createElement("div"); $("[data-lab]").append(wbHost);
    wb = createWorkbench(wbHost, {
      dataset, panels, locked,
      onTest: (r, formula, { source }) => { if (source === "user" && hasDrills && byFormula(lesson.drills[active])) onUserRun(r, formula); },
    });
  } else {
    lab = createConsole($("[data-lab]"), {
      dataset, title: hasDrills ? "Your console" : "Formula console", slot: panel || undefined,
      onResult: (r, formula, { source }) => { if (source === "user") onUserRun(r, formula); },
    });
  }

  function renderDots() {
    const pr = progress();
    panel.querySelector("[data-dots]").innerHTML = lesson.drills.map((d, i) => {
      const pass = store.getPass(drillTaskId(lesson, d));
      const state = pass ? (pass.assisted ? "helped" : "done") : "todo";
      const label = `Drill ${i + 1}: ${state === "done" ? "solved" : state === "helped" ? "solved with help" : "not solved yet"}`;
      return `<li><button type="button" class="drill__dot is-${state}${i === active ? " is-active" : ""}" data-go="${i}" aria-label="${label}"${i === active ? ' aria-current="step"' : ""}>${state === "done" ? "✓" : state === "helped" ? "◐" : i + 1}</button></li>`;
    }).join("");
    panel.querySelector("[data-drill-label]").textContent = `Drill ${active + 1} of ${lesson.drills.length} · ${pr.drillsDone} solved`;
  }

  function showDrill(i, { focus = false } = {}) {
    active = i;
    const d = lesson.drills[i];
    panel.querySelector("[data-ask]").innerHTML = markdown(d.ask);
    const pass = store.getPass(drillTaskId(lesson, d));
    const fb = panel.querySelector("[data-feedback]");
    fb.className = "drill__feedback";
    fb.innerHTML = locked ? `<p>Locked level: you can try this drill, but it won't be recorded.</p>`
      : pass ? `<p class="drill__ok">✓ Already solved${pass.assisted ? " (with help)" : ""}. Run it again anytime.</p>` : "";
    panel.querySelector("[data-prev]").disabled = i === 0;
    panel.querySelector("[data-next]").disabled = i === lesson.drills.length - 1;
    panel.querySelector("[data-solution]").hidden = attempts[i] < 2;
    panel.querySelector("[data-check]").hidden = !isWB || byFormula(d);
    if (lab) { lab.setFormula(d.starter || ""); lab.clearOutput(); }
    if (wb) { wb.setSpec(d.story || null); if (wb.cleaning && byFormula(d)) wb.cleaning.setFormula(d.starter || ""); }
    renderDots();
    if (focus) { if (lab) lab.focus(); else if (wb.cleaning && byFormula(d)) wb.cleaning.focusFormula(); else panel.querySelector(byFormula(d) ? "[data-next]" : "[data-check]").focus(); }
  }

  /** Grade the active drill: a formula run (console / formula bar), or the workbench as it stands (Check). */
  function onUserRun(result, formula) {
    if (!hasDrills) return;
    const d = lesson.drills[active];
    const v = grade(isWB && !byFormula(d) ? wb.submission() : { formula, result }, d.answerCheck);
    const fb = panel.querySelector("[data-feedback]");
    if (v.reason === "empty") return;
    if (v.pass) {
      fb.className = "drill__feedback is-pass";
      const already = store.isPassed(drillTaskId(lesson, d));
      const upgrade = already && store.getPass(drillTaskId(lesson, d)).assisted && !assisted[active]; // solved alone after "with help"
      if (!locked && (!already || upgrade)) store.recordPass(drillTaskId(lesson, d), { assisted: assisted[active], tries: attempts[active] + 1 });
      const pr = progress();
      const next = lesson.drills.findIndex((x, i) => i > active && !store.isPassed(drillTaskId(lesson, x)));
      fb.innerHTML = `<p class="drill__ok"><strong>Correct.</strong>${assisted[active] ? " Counted as solved with help." : ""}${locked ? " (Not recorded: this level is locked.)" : ""}</p>
        ${pr.drillsDone === pr.drillsTotal && !locked ? `<p>All drills solved.${lesson.checkpoint && !pr.checkpoint ? " Now try the checkpoint below." : ""}</p>` : ""}`;
      renderDots();
      if (next > active) { const btn = panel.querySelector("[data-next]"); btn.focus({ preventScroll: true }); }
    } else {
      attempts[active]++;
      fb.className = "drill__feedback is-fail";
      const specific = (v.reason === "wrong-value" || v.reason === "error" || v.reason === "pivot-totals" || v.reason === "cleaning-incomplete") && d.hint ? d.hint : v.hint;
      fb.innerHTML = `<p><strong>Not yet.</strong> ${esc(v.message)}</p>${specific ? `<p class="drill__hint">${inline(specific)}</p>` : ""}`;
      panel.querySelector("[data-solution]").hidden = attempts[active] < 2;
    }
  }

  if (panel) {
    panel.addEventListener("click", e => {
      const b = e.target.closest("button"); if (!b) return;
      if (b.dataset.go !== undefined) showDrill(Number(b.dataset.go), { focus: true });
      else if (b.hasAttribute("data-prev") && active > 0) showDrill(active - 1, { focus: true });
      else if (b.hasAttribute("data-next") && active < lesson.drills.length - 1) showDrill(active + 1, { focus: true });
      else if (b.hasAttribute("data-check")) onUserRun(null, "");
      else if (b.hasAttribute("data-solution")) {
        const d = lesson.drills[active];
        assisted[active] = true;
        const fb = panel.querySelector("[data-feedback]");
        fb.className = "drill__feedback";
        if (typeof d.solution === "string") {
          if (lab) { lab.setFormula(d.solution); lab.focus(); } else { wb.cleaning.setFormula(d.solution); wb.cleaning.focusFormula(); }
          fb.innerHTML = `<p>Here's one solution, loaded into the ${lab ? "console" : "formula bar"}. ${lab ? "Press Enter to run it" : "Press Test to run it"} and see why it works. It will count as <em>solved with help</em>.</p>`;
        } else {
          // Workbench solutions are the moves themselves: applied for you, then you press Check.
          if (d.solution.steps && wb.cleaning) wb.cleaning.applySteps(d.solution.steps);
          if (d.solution.pivot && wb.pivot) wb.pivot.setConfig(d.solution.pivot, { source: "solution" });
          if (d.solution.story && wb.story) wb.story.setState(d.solution.story);
          if (d.solution.refresh && wb.pivot) wb.pivot.refresh();
          fb.innerHTML = `<p>One solution has been applied in the workspace${d.solution.explain ? `: ${inline(d.solution.explain)}` : "."} Look at what changed, then press <strong>Check</strong>. It will count as <em>solved with help</em>.</p>`;
          panel.querySelector("[data-check]").focus();
        }
      }
    });
    showDrill(active);
  }

  /* ---------- worked example ---------- */
  $("[data-run-worked]")?.addEventListener("click", () => {
    if (lab) lab.run(w.formula, { source: "worked" });
    else if (w.formula && wb.cleaning) wb.cleaning.test(w.formula, { source: "worked" });
    else if (w.pivot && wb.pivot) { wb.pivot.setConfig(w.pivot, { source: "worked" }); if (w.story && wb.story) wb.story.setState(w.story); }
    $("[data-practice]").scrollIntoView({ behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "start" });
  });

  /* ---------- checkpoint ---------- */
  if (lesson.checkpoint) {
    createQuiz($("[data-quiz]"), {
      id: `${lesson.id}-cp`, questions: lesson.checkpoint.questions,
      passMark: lesson.checkpoint.passMark ?? lesson.checkpoint.questions.length,
      reveal: "always", disabled: locked,
      onSubmit: (score, passed) => { if (passed && !locked && !store.isPassed(checkpointTaskId(lesson))) store.recordPass(checkpointTaskId(lesson), { score }); },
    });
  }

  /* ---------- status + honesty lines ---------- */
  function update() {
    const pr = progress();
    $("[data-status]").innerHTML = `<span class="pill pill--${pr.complete ? "complete" : "open"}">${pr.complete ? "Lesson complete" : "In progress"}</span> <span class="muted">${esc(statusText(pr))}</span>`;
    const cpNote = $("[data-checkpoint-note]");
    if (cpNote) {
      const p = store.getPass(checkpointTaskId(lesson));
      cpNote.textContent = p ? `✓ Passed ${fmtDate(p.at)}. You can retake it anytime; a retake never removes a pass.` : "Answer every question, then check. Explanations appear after you submit.";
    }
    const claim = $("[data-claim]");
    claim.classList.toggle("is-earned", pr.complete);
    claim.innerHTML = pr.complete
      ? `<p class="claim__q">You can now honestly say</p><p class="claim__text">“${esc(lesson.claimAfter)}”</p><p class="claim__note"><strong>Not yet:</strong> ${inline(lesson.notYet)}</p>`
      : `<p class="claim__q">Finish the drills${lesson.checkpoint ? " and the checkpoint" : ""}, and you'll be able to say</p><p class="claim__text">“${esc(lesson.claimAfter)}”</p><p class="claim__note"><strong>Not covered here:</strong> ${inline(lesson.notYet)}</p>`;
    if (panel) renderDots();
  }
  update();

  return { update, console: lab, workbench: wb, destroy() { lab?.destroy(); wb?.destroy(); host.innerHTML = ""; } };
}

/**
 * Render a level gate (Level 0 checkpoint). Returns { update() }.
 * ctx: { gate, level, store, locked, lockedReason, next (curriculum entry or null), hrefs: { level, next } }
 */
export function renderGate(host, ctx) {
  const { gate, level, store, locked, lockedReason = "", next, hrefs } = ctx;
  host.innerHTML = `
  <article class="container view stack stack-lg">
    <header class="lesson-head">
      <p class="eyebrow">${esc(level.label)} · ${esc(gate.kind === "checkpoint" ? "Checkpoint" : gate.kind)}</p>
      <h1 tabindex="-1">${esc(gate.title)}</h1>
      <p class="lesson-head__status" data-status></p>
    </header>
    ${locked ? `<div class="notice notice--locked"><div><span class="notice__tag">Locked</span>${lockedReason}</div></div>` : ""}
    <section class="prose">${markdown(gate.intro)}</section>
    <section><div data-quiz></div></section>
    <div data-after></div>
    <nav class="pager" aria-label="Levels"><a class="btn btn--secondary" href="${hrefs.level}">← ${esc(level.label)}</a></nav>
  </article>`;
  const $ = s => host.querySelector(s);
  createQuiz($("[data-quiz]"), {
    id: gate.id, questions: gate.questions, passMark: gate.passMark, reveal: "on-pass", disabled: locked,
    onSubmit: (score, passed) => { if (passed && !locked && !store.isPassed(gate.id)) store.recordPass(gate.id, { score }); },
  });
  function update() {
    const p = store.getPass(gate.id);
    $("[data-status]").innerHTML = p ? `<span class="pill pill--complete">Passed ${esc(fmtDate(p.at))}</span>` : `<span class="pill pill--${locked ? "locked" : "open"}">${locked ? "Locked" : `Pass with ${gate.passMark}/${gate.questions.length}`}</span>`;
    $("[data-after]").innerHTML = p ? `
      <section class="claim is-earned"><p class="claim__q">You can now honestly say</p><p class="claim__text">“${esc(level.claimAfter)}”</p>
        ${next ? `<p class="claim__note">${esc(next.label)} is unlocked.</p>` : ""}</section>
      ${next ? `<p><a class="btn btn--primary" href="${hrefs.next}">Start ${esc(next.label)}: ${esc(next.title)} →</a></p>` : ""}` : "";
  }
  update();
  return { update, destroy() { host.innerHTML = ""; } };
}
