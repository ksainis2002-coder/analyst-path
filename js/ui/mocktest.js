/* =========================================================================
   ui/mocktest.js: the capstone, a timed mock hiring test (spec §7, §8)
   -------------------------------------------------------------------------
   How an attempt works (it's run like the real thing):
     • The tasks stay hidden until you press Start. The 45-minute clock
       (ui/timer.js) then runs from that timestamp, through reloads, with
       no pause.
     • Part 1: formula tasks on the clean order log. Part 2: clean the raw
       export, pivot it, chart it (ui/workbench.js).
     • ONE submission per attempt. At 0:00 whatever you have is submitted
       automatically. Pass = passMark tasks right AND within time (the
       grader's "timed" check).
     • The key for that variant can be opened after the attempt is
       submitted, never before (spec §8 no-cheese); it's fetched only then.
     • Variants alternate (A, B, A, …) so a retake tests the skills, not your
       memory. Passing a variant whose key you'd already opened is recorded
       as { assisted: true }: "passed with help".
   Draft (store.getDraft("mock-test")): { attempts: [...], current: { variant, startedAt, answers, workspace } | null, keysSeen: [variantId] }
   ========================================================================= */

import { createSheet } from "./sheet.js";
import { createTimer, formatClock } from "./timer.js";
import { createWorkbench } from "./workbench.js";
import { formatValue } from "./console.js";
import { gradeAssignment, keyWorkspace, keyText } from "./assignment.js";
import { markdown, inline } from "./md.js";
import { grade } from "../grader.js";
import { evaluate } from "../engine.js";
import { DATASETS } from "../data.js";
import { isFormulaCheck } from "../content.js";

const esc = v => String(v ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fmtDate = ts => new Date(ts).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });

/* ---------- pure ---------- */
export const variantTasks = (test, variantId) => {
  const v = test.variants.find(x => x.id === variantId);
  if (!v) throw new Error(`No variant "${variantId}"`);
  return v.tasks.map(id => test.pool.find(t => t.id === id));
};
/** Attempt n (0-based) uses variant n mod count: A, B, A, … */
export const variantForAttempt = (test, n) => test.variants[n % test.variants.length].id;
/** Grade one attempt: the tasks, then the clock. */
export function gradeMockTest(test, variantId, answers, workspace, seconds) {
  const tasks = variantTasks(test, variantId);
  const g = gradeAssignment({ ...test, tasks, passMark: test.passMark }, answers, workspace);
  const t = grade({ seconds }, { type: "timed", maxSeconds: test.minutes * 60 });
  return { ...g, variant: variantId, seconds, inTime: t.pass, timeMessage: t.message, passed: g.passed && t.pass };
}
/** The workspace a variant's key describes (for tests and for "why"). */
export const mockKeyWorkspace = (test, key, variantId) => keyWorkspace({ ...test, tasks: variantTasks(test, variantId) }, key);

/* ---------- DOM ---------- */
/**
 * ctx: { test, level, store, locked, lockedReason, next, hrefs: { level, next }, loadKey, now? }
 * Returns { update(), destroy(), submit() }.
 */
export function renderMockTest(host, ctx) {
  const { test: T, level, store, locked, lockedReason = "", next, hrefs, loadKey } = ctx;
  const now = ctx.now || (() => Date.now());
  const ID = T.id, DURATION = T.minutes * 60;
  const draft = Object.assign({ attempts: [], current: null, keysSeen: [] }, store.getDraft(ID) || {});
  const save = () => { if (!locked) store.setDraft(ID, draft); };
  let timer = null, wb = null, sheet = null, confirming = false, openKey = null;
  const partOneDS = DATASETS[T.pool.find(t => isFormulaCheck(t.answerCheck))?.dataset || T.dataset];

  function teardown() { timer?.destroy(); wb?.destroy(); sheet?.destroy(); timer = wb = sheet = null; }

  function paint() {
    teardown();
    if (draft.current) {
      const c = countdownLeft();
      if (c <= 0) return submit({ auto: true, late: true });
      return paintRunning();
    }
    paintIdle();
  }
  const countdownLeft = () => DURATION - Math.floor((now() - draft.current.startedAt) / 1000);

  /* ----- idle: start screen, history, last results ----- */
  function paintIdle() {
    const n = draft.attempts.length, v = variantForAttempt(T, n), vl = T.variants.find(x => x.id === v).label;
    const pass = store.getPass(ID), last = draft.attempts.at(-1);
    host.innerHTML = `
    <article class="container view stack stack-lg mock">
      <header class="lesson-head">
        <p class="eyebrow">${esc(level.label)} · ${T.variants[0] ? `${variantTasks(T, T.variants[0].id).length} tasks` : ""} · ${T.minutes} minutes · pass with ${T.passMark}</p>
        <h1 tabindex="-1">${esc(T.title)}</h1>
        <p class="lesson-head__status" data-status></p>
      </header>
      ${locked ? `<div class="notice notice--locked"><div><span class="notice__tag">Locked</span>${lockedReason} You can read how the test works; you can start it once the level unlocks.</div></div>` : ""}
      <section class="prose">${markdown(T.intro)}</section>
      <section class="card mock__start" aria-labelledby="start-h">
        <h2 class="section-title" id="start-h">${n ? "Retake" : "Ready?"}</h2>
        <p class="mock__next"><strong>Attempt ${n + 1}</strong> · ${esc(vl)} · ${variantTasks(T, v).length} tasks · <span class="mono">${formatClock(DURATION)}</span>${draft.keysSeen.includes(v) ? ` · <span class="mock__warn">you've seen this variant's key, so a pass will count as <em>passed with help</em></span>` : ""}</p>
        <p class="muted">Find ${T.minutes} uninterrupted minutes first. The clock won't stop once it starts.</p>
        <p><button class="btn btn--primary" type="button" data-start${locked ? " disabled" : ""}>Start the ${T.minutes}-minute test</button></p>
      </section>
      ${last ? resultsHTML(last) : ""}
      ${n ? historyHTML() : ""}
      <div data-key-area></div>
      <div data-after></div>
      ${n ? `<p><a class="btn btn--secondary" href="#/report" data-report-link>See your readiness report →</a></p>` : ""}
      <nav class="pager" aria-label="Levels"><a class="btn btn--secondary" href="${hrefs.level}">← ${esc(level.label)}</a></nav>
    </article>`;
    host.querySelector("[data-start]")?.addEventListener("click", start);
    host.querySelectorAll("[data-show-key]").forEach(b => b.addEventListener("click", () => showKey(b.dataset.showKey)));
    if (openKey) showKey(openKey);
    update();
  }

  function resultsHTML(a) {
    const tasks = variantTasks(T, a.variant);
    return `<section class="mock__results" aria-labelledby="res-h" data-results>
      <h2 class="section-title" id="res-h">Attempt ${a.n} results · ${esc(T.variants.find(x => x.id === a.variant).label)}</h2>
      <p class="tasks__msg ${a.passed ? "is-pass" : "is-fail"}" data-result-msg>${a.score}/${a.total} correct in ${formatClock(a.seconds)}${a.auto ? " (time ran out: submitted automatically)" : ""}. <strong>${a.passed ? "Passed." : "Not passed."}</strong> ${a.passed ? "" : a.score < T.passMark ? `You need ${T.passMark}.` : esc(a.timeMessage)}</p>
      <ol class="tasks__list tasks__list--compact" role="list">${tasks.map((t, i) => { const r = a.results.find(x => x.id === t.id) || { pass: false, message: "No answer." }; return `
        <li class="task ${r.pass ? "is-pass" : "is-fail"}" data-task="${esc(t.id)}"><div class="task__head"><span class="task__num" aria-hidden="true">${i + 1}</span><div class="task__ask">${markdown(t.ask)}</div></div>
          <div class="task__verdict" data-verdict="${esc(t.id)}">${r.pass ? `<p class="task__ok">✓ Correct</p>` : `<p><strong>✗ ${esc(r.message)}</strong></p>${r.hint ? `<p class="task__hint">${inline(r.hint)}</p>` : ""}`}</div></li>`; }).join("")}
      </ol>
      <p><button class="btn btn--secondary" type="button" data-show-key="${esc(a.variant)}">Show the answer key for ${esc(T.variants.find(x => x.id === a.variant).label)}</button>
        <span class="muted">${draft.keysSeen.includes(a.variant) ? "" : `Opening it means a later pass on ${esc(a.variant)} counts as <em>passed with help</em>; the other variant stays clean.`}</span></p>
    </section>`;
  }
  function historyHTML() {
    return `<section aria-labelledby="hist-h"><h2 class="section-title" id="hist-h">Your attempts</h2>
      <table class="pivot__table mock__history"><thead><tr><th scope="col">#</th><th scope="col">Variant</th><th scope="col">Score</th><th scope="col">Time</th><th scope="col">Result</th><th scope="col">Date</th></tr></thead>
      <tbody>${draft.attempts.map(a => `<tr><th scope="row">${a.n}</th><td>${esc(a.variant)}</td><td>${a.score}/${a.total}</td><td>${formatClock(a.seconds)}${a.auto ? " (auto)" : ""}</td><td>${a.passed ? (a.assisted ? "Passed with help" : "Passed") : "Not passed"}</td><td>${esc(fmtDate(a.submittedAt))}</td></tr>`).join("")}</tbody></table></section>`;
  }

  async function showKey(variant) {
    const area = host.querySelector("[data-key-area]"); if (!area) return;
    if (!draft.attempts.some(a => a.variant === variant)) return; // only after that variant has been submitted
    area.innerHTML = `<p class="muted">Loading the answer key…</p>`;
    let key;
    try { key = await loadKey(); } catch (e) { area.innerHTML = `<div class="notice notice--warn"><div><span class="notice__tag">Couldn't load the key</span>${esc(e.message)}</div></div>`; return; }
    if (!draft.keysSeen.includes(variant)) { draft.keysSeen.push(variant); save(); }
    openKey = variant;
    const tasks = variantTasks(T, variant);
    area.innerHTML = `<section class="key card" aria-labelledby="key-h"><h2 class="section-title" id="key-h">Answer key · ${esc(T.variants.find(x => x.id === variant).label)}</h2>
      <ol class="key__list">${tasks.map(t => `<li>${keyText(key.solutions[t.id], t)}<div class="key__explain">${markdown(key.explain[t.id])}</div></li>`).join("")}</ol></section>`;
    const nextMsg = host.querySelector(".mock__next");
    if (nextMsg && variantForAttempt(T, draft.attempts.length) === variant && !nextMsg.querySelector(".mock__warn")) nextMsg.insertAdjacentHTML("beforeend", ` · <span class="mock__warn">you've seen this variant's key, so a pass will count as <em>passed with help</em></span>`);
  }

  /* ----- running ----- */
  function start() {
    if (locked || draft.current) return;
    const variant = variantForAttempt(T, draft.attempts.length);
    draft.current = { variant, startedAt: now(), answers: {}, workspace: null, keySeenBefore: draft.keysSeen.includes(variant) };
    openKey = null; save(); paint();
    host.querySelector("h1")?.focus();
  }

  function paintRunning() {
    const cur = draft.current, tasks = variantTasks(T, cur.variant);
    const f = tasks.filter(t => isFormulaCheck(t.answerCheck)), w = tasks.filter(t => !isFormulaCheck(t.answerCheck));
    const num = t => tasks.indexOf(t) + 1;
    host.innerHTML = `
    <article class="container view stack stack-lg mock is-running">
      <header class="lesson-head">
        <p class="eyebrow">${esc(level.label)} · ${esc(T.variants.find(x => x.id === cur.variant).label)} · attempt ${draft.attempts.length + 1}</p>
        <h1 tabindex="-1">${esc(T.title)}</h1>
      </header>
      <div class="mock__bar" role="region" aria-label="Test controls">
        <div data-timer></div>
        <span class="muted mock__count" data-count></span>
        <span class="mock__submit"><button class="btn btn--primary" type="button" data-submit>Submit test</button><button class="btn btn--quiet" type="button" data-cancel hidden>Keep working</button></span>
      </div>
      ${f.length ? `<section aria-labelledby="p1-h">
        <h2 class="section-title" id="p1-h">Part 1 · formulas on the clean order log</h2>
        <div class="lab-layout assignment__lab">
          <div class="lab__sheet"><div data-sheet></div></div>
          <ol class="tasks__list" role="list">${f.map(t => `
            <li class="task" data-task="${esc(t.id)}">
              <div class="task__head"><span class="task__num" aria-hidden="true">${num(t)}</span><div class="task__ask" id="mt-${esc(t.id)}-ask">${markdown(t.ask)}</div></div>
              <div class="fx task__fx"><label class="visually-hidden" for="mt-${esc(t.id)}">Formula for task ${num(t)}</label><span class="fx__eq" aria-hidden="true">=</span>
                <input class="fx__input" id="mt-${esc(t.id)}" data-input="${esc(t.id)}" type="text" spellcheck="false" autocomplete="off" autocapitalize="characters" autocorrect="off" placeholder="your formula" aria-describedby="mt-${esc(t.id)}-ask">
                <button class="fx__run" type="button" data-run="${esc(t.id)}">Run</button></div>
              <p class="task__value" data-value="${esc(t.id)}" aria-live="polite"></p>
            </li>`).join("")}</ol>
        </div></section>` : ""}
      ${w.length ? `<section aria-labelledby="p2-h">
        <h2 class="section-title" id="p2-h">Part 2 · the raw export</h2>
        <ol class="tasks__list tasks__list--compact" role="list">${w.map(t => `<li class="task task--workspace"><div class="task__head"><span class="task__num" aria-hidden="true">${num(t)}</span><div class="task__ask">${markdown(t.ask)}</div></div></li>`).join("")}</ol>
        <div data-workbench class="assignment__workbench"></div></section>` : ""}
    </article>`;
    const $ = s => host.querySelector(s);
    if (f.length) sheet = createSheet($("[data-sheet]"), { cells: partOneDS.cells, range: partOneDS.range, headerRows: 1, label: partOneDS.label, formats: partOneDS.formats || {} });
    if (w.length) wb = createWorkbench($("[data-workbench]"), { dataset: DATASETS[T.dataset], panels: T.lab.panels, draft: cur.workspace || {}, spec: w.find(t => t.story)?.story,
      onChange: () => { cur.workspace = wb.draft(); save(); } });
    const show = (id, formula, hl = true) => {
      const out = host.querySelector(`[data-value="${CSS.escape(id)}"]`);
      if (!formula.trim()) { out.textContent = ""; return; }
      const r = evaluate(formula, partOneDS.cells);
      out.className = `task__value ${r.ok ? "" : "is-error"}`;
      out.innerHTML = r.ok ? `Result: <strong class="mono">${esc(formatValue(r.value).text)}</strong>` : `Result: <strong class="mono">${esc(r.error.code || "error")}</strong> <span class="muted">${esc(r.error.message || "")}</span>`;
      if (hl) sheet?.highlight(r.highlights);
    };
    host.querySelectorAll("[data-input]").forEach(el => {
      const v = cur.answers[el.dataset.input] || ""; el.value = v.replace(/^=/, ""); if (v) show(el.dataset.input, v, false);
      el.addEventListener("input", () => { cur.answers[el.dataset.input] = el.value.trim() ? "=" + el.value.trim().replace(/^=/, "") : ""; host.querySelector(`[data-value="${CSS.escape(el.dataset.input)}"]`).textContent = ""; save(); count(); });
      el.addEventListener("keydown", e => { if (e.key === "Enter") { e.preventDefault(); show(el.dataset.input, el.value); } });
    });
    host.querySelectorAll("[data-run]").forEach(b => b.addEventListener("click", () => { const el = host.querySelector(`[data-input="${CSS.escape(b.dataset.run)}"]`); show(b.dataset.run, el.value); el.focus(); }));
    const submitBtn = $("[data-submit]"), cancel = $("[data-cancel]");
    submitBtn.addEventListener("click", () => {
      if (!confirming) { confirming = true; submitBtn.textContent = "Confirm: submit now"; cancel.hidden = false; $("[data-count]").textContent = "You can't change anything after this."; return; }
      submit({ auto: false });
    });
    cancel.addEventListener("click", () => { confirming = false; submitBtn.textContent = "Submit test"; cancel.hidden = true; count(); });
    function count() { if (confirming) return; $("[data-count]").textContent = `${f.filter(t => cur.answers[t.id]).length}/${f.length} formulas typed · Part 2 is checked from your workspace`; }
    count();
    timer = createTimer($("[data-timer]"), { durationSec: DURATION, startedAt: cur.startedAt, now, onExpire: () => submit({ auto: true }) });
  }

  /* ----- submit (by you, or by the clock) ----- */
  function submit({ auto = false, late = false } = {}) {
    const cur = draft.current; if (!cur) return;
    if (wb) cur.workspace = wb.draft();
    const seconds = Math.min(DURATION, Math.max(0, Math.floor((now() - cur.startedAt) / 1000)));
    const workspace = wb ? wb.submission() : restoredSubmission(cur);
    const g = gradeMockTest(T, cur.variant, cur.answers, workspace, seconds);
    const a = { n: draft.attempts.length + 1, variant: cur.variant, startedAt: cur.startedAt, submittedAt: now(), seconds, auto: auto || late, score: g.score, total: g.total, passed: g.passed, timeMessage: g.timeMessage,
      assisted: !!cur.keySeenBefore, results: g.results.map(r => ({ id: r.id, pass: r.pass, message: r.message, hint: r.pass ? "" : (["wrong-value", "error", "empty", "cleaning-incomplete", "pivot-totals", "story-blank"].includes(r.reason) ? T.pool.find(t => t.id === r.id).hint : r.hint) })) };
    draft.attempts.push(a); draft.current = null; confirming = false; save();
    if (a.passed && (!store.isPassed(ID) || (store.getPass(ID).assisted && !a.assisted))) store.recordPass(ID, { score: a.score, total: a.total, seconds: a.seconds, variant: a.variant, submissions: a.n, assisted: a.assisted });
    teardown();
    paint();
    host.querySelector("[data-results]")?.scrollIntoView({ block: "start" });
    host.querySelector("[data-result-msg]")?.setAttribute("tabindex", "-1");
    host.querySelector("[data-result-msg]")?.focus({ preventScroll: true });
    return a;
  }
  // After a reload past the deadline there is no live workbench: rebuild what it would submit.
  function restoredSubmission(cur) {
    if (!T.lab || !cur.workspace) return {};
    const tmp = document.createElement("div");
    const w = createWorkbench(tmp, { dataset: DATASETS[T.dataset], panels: T.lab.panels, draft: cur.workspace });
    const sub = w.submission(); w.destroy(); return sub;
  }

  function update() {
    const st = host.querySelector("[data-status]"); if (!st) return;
    const p = store.getPass(ID);
    st.innerHTML = p ? `<span class="pill pill--complete">Passed ${esc(fmtDate(p.at))}${p.assisted ? " · with help" : ""}</span> <span class="muted">${p.score}/${p.total} in ${formatClock(p.seconds)} · ${esc(p.variant)}</span>`
      : `<span class="pill pill--${locked ? "locked" : "open"}">${locked ? "Locked" : "Not passed yet"}</span>${draft.attempts.length ? ` <span class="muted">${draft.attempts.length} attempt${draft.attempts.length === 1 ? "" : "s"}</span>` : ""}`;
    const after = host.querySelector("[data-after]");
    if (after) after.innerHTML = p ? `<section class="claim is-earned"><p class="claim__q">You can now honestly say${p.assisted ? " (passed with help)" : ""}</p><p class="claim__text">“${esc(level.claimAfter)}”</p>
      <p class="claim__note">${p.assisted ? "You'd seen this variant's key before passing it. Pass the other variant cold to make the claim fully yours." : "That was a cold pass, under the clock."}${next ? ` ${esc(next.label)} is unlocked.` : ""}</p></section>` : "";
  }

  paint();
  return { update, submit, destroy() { teardown(); host.innerHTML = ""; }, get running() { return !!draft.current; } };
}
