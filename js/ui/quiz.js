/* =========================================================================
   ui/quiz.js: multiple-choice checks (lesson checkpoints + the Level 0 gate)
   -------------------------------------------------------------------------
   createQuiz(host, {
     id, questions: [{ id, prompt, options: [..], answer: <index>, explain, hint? }],
     passMark,        // number correct needed (default: all)
     reveal,          // "always": explanations after any submit (practice checks)
                      // "on-pass": after a failed attempt only hints for wrong answers,
                      //            so a retake still tests you (gates, spec §8 no-cheese)
     disabled,        // true in a locked level: visible but can't be submitted
     onSubmit(score, passed, answers)
   })
   The quiz scores itself (a pure function, scoreQuiz). Recording progress is
   the caller's job.
   ========================================================================= */

import { inline } from "./md.js";

/** Pure scoring. answers: array of chosen option indexes (or null). */
export function scoreQuiz(questions, answers, passMark = questions.length) {
  const correct = questions.map((q, i) => answers[i] === q.answer);
  const score = correct.filter(Boolean).length;
  return { score, total: questions.length, passed: score >= passMark, correct };
}

let uid = 0;

export function createQuiz(host, { id = `quiz-${++uid}`, title = "", questions, passMark = questions.length, reveal = "always", disabled = false, onSubmit } = {}) {
  const qid = `${id}-${++uid}`;
  host.innerHTML = `
    <form class="quiz" data-quiz novalidate>
      ${title ? `<h3 class="quiz__title">${inline(title)}</h3>` : ""}
      <p class="quiz__meta">${questions.length} question${questions.length === 1 ? "" : "s"} · pass with ${passMark}/${questions.length}</p>
      ${questions.map((q, i) => `
        <fieldset class="quiz__q" data-q="${i}">
          <legend class="quiz__prompt"><span class="quiz__num">${i + 1}.</span> ${inline(q.prompt)}</legend>
          <div class="quiz__options">
            ${q.options.map((o, j) => `
              <label class="quiz__option">
                <input type="radio" name="${qid}-q${i}" value="${j}"${disabled ? " disabled" : ""}>
                <span>${inline(o)}</span>
              </label>`).join("")}
          </div>
          <div class="quiz__feedback" data-feedback hidden></div>
        </fieldset>`).join("")}
      <div class="quiz__actions">
        <button class="btn btn--primary" type="submit"${disabled ? " disabled" : ""}>Check answers</button>
        <button class="btn btn--secondary" type="button" data-retry hidden>Try again</button>
      </div>
      <div class="quiz__result" data-result aria-live="polite"></div>
    </form>`;

  const form = host.querySelector("[data-quiz]");
  const resultEl = form.querySelector("[data-result]");
  const retry = form.querySelector("[data-retry]");
  const submitBtn = form.querySelector('button[type="submit"]');

  const chosen = () => questions.map((_, i) => {
    const el = form.querySelector(`input[name="${qid}-q${i}"]:checked`);
    return el ? Number(el.value) : null;
  });

  function lock(on) { form.querySelectorAll("input").forEach(el => (el.disabled = on || disabled)); submitBtn.hidden = on; retry.hidden = !on; }

  form.addEventListener("submit", e => {
    e.preventDefault();
    if (disabled) return;
    const answers = chosen();
    const missing = answers.findIndex(a => a === null);
    if (missing >= 0) {
      resultEl.innerHTML = `<p class="quiz__msg quiz__msg--warn">Answer every question first (question ${missing + 1} is empty).</p>`;
      form.querySelector(`input[name="${qid}-q${missing}"]`).focus();
      return;
    }
    const r = scoreQuiz(questions, answers, passMark);
    const showAll = reveal === "always" || r.passed;
    questions.forEach((q, i) => {
      const fs = form.querySelector(`[data-q="${i}"]`), fb = fs.querySelector("[data-feedback]");
      fs.classList.toggle("is-correct", r.correct[i]); fs.classList.toggle("is-wrong", !r.correct[i]);
      fs.querySelectorAll(".quiz__option").forEach((lab, j) => lab.classList.toggle("is-answer", showAll && j === q.answer));
      const text = r.correct[i] ? (showAll ? q.explain : "") : (showAll ? q.explain : (q.hint || "Not quite. Re-read the lesson section on this."));
      fb.hidden = !text && !(!r.correct[i]);
      fb.innerHTML = `<strong>${r.correct[i] ? "Correct." : "Not quite."}</strong> ${text ? inline(text) : ""}`;
    });
    resultEl.innerHTML = `<p class="quiz__msg ${r.passed ? "quiz__msg--pass" : "quiz__msg--warn"}">${r.score}/${r.total} correct. ${r.passed ? "Passed." : `You need ${passMark} to pass. ${reveal === "always" ? "Read the explanations, then try again." : "Check the hints, then try again."}`}</p>`;
    lock(true);
    if (typeof onSubmit === "function") onSubmit(r.score, r.passed, answers);
  });

  retry.addEventListener("click", () => {
    form.reset(); resultEl.innerHTML = "";
    form.querySelectorAll(".quiz__q").forEach(fs => { fs.classList.remove("is-correct", "is-wrong"); fs.querySelector("[data-feedback]").hidden = true; });
    form.querySelectorAll(".quiz__option").forEach(l => l.classList.remove("is-answer"));
    lock(false);
    form.querySelector("input")?.focus();
  });

  return { el: form, answers: chosen, destroy() { host.innerHTML = ""; } };
}
