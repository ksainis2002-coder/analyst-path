/* =========================================================================
   ui/report.js: the Readiness report (spec §3, §9)
   -------------------------------------------------------------------------
   "The app must never encourage claiming un-demonstrated skills; the
   Readiness report is the guardrail." (spec §13)

   Rules (enforced in buildReport, tested in report.test.js):
     • A skill is DEMONSTRATED only when its evidence (a level gate, the mock
       test, or a case study: content/skills.json) was passed WITHOUT help.
     • Passed with help (answer key opened, solution revealed) → "with help":
       listed apart, with wording that says so, and never in the CV lines.
       A later pass without help upgrades it (progress.js); the report then
       says "solo, after an earlier pass with help".
     • Passes simulated for testing (source "dev", seeded by browser tests) are never counted, and the report says how
       many there were.
     • Drills, lessons and checkpoints are PRACTICE. They're reported (alone
       vs with help), but practice alone never demonstrates a skill.
     • Everything comes from this browser's progress store. Nothing is
       inferred, and nothing is rounded up.

   PURE: evidenceState(pass), buildReport(input) → model
   DOM:  renderReport(host, { report, hrefs }) → { destroy() }
   ========================================================================= */

import { drillTaskId, checkpointTaskId } from "../content.js";
import { formatClock } from "./timer.js";

const esc = v => String(v ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fmtDate = ts => new Date(ts).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });

/** "none" | "simulated" (seeded by tests) | "helped" | "solo" */
export function evidenceState(pass) {
  if (!pass) return "none";
  if (pass.source === "dev") return "simulated";
  return pass.assisted ? "helped" : "solo";
}

/**
 * @param {{ curriculum, lessonsByLevel: {[levelId]: lesson[]}, skills, cases?: {id,title,content}[],
 *           getPass(id), getDraft(id), now?: number }} input
 */
export function buildReport({ curriculum, lessonsByLevel = {}, skills, cases = [], getPass, getDraft = () => null, now = Date.now() }) {
  const lessonsById = new Map(Object.values(lessonsByLevel).flat().map(l => [l.id, l]));
  const drillState = (l, d) => evidenceState(getPass(drillTaskId(l, d)));
  const practiceOf = lessonIds => {
    const ls = lessonIds.map(id => lessonsById.get(id)).filter(Boolean);
    const drills = ls.flatMap(l => l.drills.map(d => drillState(l, d)));
    const checkpoints = ls.filter(l => l.checkpoint).map(l => evidenceState(getPass(checkpointTaskId(l))));
    return { drillsTotal: drills.length, drillsSolo: drills.filter(x => x === "solo").length, drillsHelped: drills.filter(x => x === "helped").length,
      checkpointsTotal: checkpoints.length, checkpointsPassed: checkpoints.filter(x => x === "solo" || x === "helped").length };
  };

  const skillRows = skills.skills.map(sk => {
    const pass = getPass(sk.evidence), state = evidenceState(pass);
    const evidenceLabel = curriculum.levels.find(l => l.gate.taskId === sk.evidence)?.gate.label || cases.find(c => c.id === sk.evidence)?.title || sk.evidence;
    return { ...sk, state, pass, evidenceLabel, afterHelp: state === "solo" && !!pass.helpedBefore, practice: practiceOf(sk.practice || []) };
  });

  const states = levelChain(curriculum.levels, id => { const st = evidenceState(getPass(id)); return st === "solo" || st === "helped"; });
  const levels = curriculum.levels.map((lv, i) => {
    const pass = getPass(lv.gate.taskId), state = evidenceState(pass);
    const ls = (lessonsByLevel[lv.id] || []).map(l => {
      const dr = l.drills.map(d => drillState(l, d)), cp = l.checkpoint ? evidenceState(getPass(checkpointTaskId(l))) : "solo";
      const complete = dr.every(x => x === "solo" || x === "helped") && (cp === "solo" || cp === "helped");
      return { id: l.id, title: l.title, drillsTotal: dr.length, drillsSolo: dr.filter(x => x === "solo").length, drillsHelped: dr.filter(x => x === "helped").length,
        checkpoint: l.checkpoint ? cp : null, complete, helped: complete && dr.includes("helped"), claimAfter: l.claimAfter, notYet: l.notYet };
    });
    const sum = k => ls.reduce((n, l) => n + l[k], 0);
    return { id: lv.id, label: lv.label, title: lv.title, gateLabel: lv.gate.label, gateKind: lv.gate.kind, state, pass, status: states[i], claimAfter: lv.claimAfter,
      lessons: ls, drillsTotal: sum("drillsTotal"), drillsSolo: sum("drillsSolo"), drillsHelped: sum("drillsHelped") };
  });

  // Capstone detail from the mock test's own record of attempts (a draft: evidence of effort, not of skill).
  const mockLevel = curriculum.levels.find(l => l.gate.kind === "mock-test");
  const mockDraft = mockLevel ? getDraft(mockLevel.gate.taskId) : null;
  const attempts = (mockDraft?.attempts || []).map(a => ({ n: a.n, variant: a.variant, score: a.score, total: a.total, seconds: a.seconds, passed: a.passed, assisted: !!a.assisted, auto: !!a.auto, at: a.submittedAt }));
  // best: a pass, then a pass WITHOUT help, then score, then time
  const best = attempts.slice().sort((a, b) => (b.passed - a.passed) || ((a.passed && a.assisted) - (b.passed && b.assisted)) || (b.score - a.score) || (a.seconds - b.seconds))[0] || null;
  const capstone = mockLevel ? { label: mockLevel.gate.label, state: evidenceState(getPass(mockLevel.gate.taskId)), pass: getPass(mockLevel.gate.taskId), attempts, best } : null;

  const caseRows = cases.map(c => ({ id: c.id, title: c.title, state: evidenceState(getPass(c.id)), pass: getPass(c.id) }));

  const solo = skillRows.filter(s => s.state === "solo"), helped = skillRows.filter(s => s.state === "helped"), gaps = skillRows.filter(s => s.state === "none" || s.state === "simulated");
  const allIds = [...curriculum.levels.map(l => l.gate.taskId), ...cases.map(c => c.id), ...Object.values(lessonsByLevel).flat().flatMap(l => [...l.drills.map(d => drillTaskId(l, d)), checkpointTaskId(l)])];
  const simulated = allIds.filter(id => evidenceState(getPass(id)) === "simulated");
  const levelsSolo = levels.filter(l => l.gateKind !== "mock-test" && l.state === "solo").length, levelsTotal = levels.filter(l => l.gateKind !== "mock-test").length;

  let verdict;
  if (capstone?.state === "solo") verdict = { key: "ready", headline: "Test-ready: you've passed a timed, mixed Excel test without help.", detail: "That's the thing a practical hiring test measures. The lines below are yours to use." };
  else if (capstone?.state === "helped") verdict = { key: "ready-with-help", headline: "Nearly: you passed the mock test, but on a variant whose answer key you'd seen.", detail: "Pass the other variant cold before telling an employer you're ready for a timed Excel test." };
  else if (solo.length || helped.length) verdict = { key: "in-progress", headline: `Not test-ready yet: ${levelsSolo} of ${levelsTotal} levels demonstrated without help.`, detail: "Claim only what's under “What you can honestly claim”. Everything else is a gap until its assignment or the mock test is passed." };
  else verdict = { key: "not-started", headline: "Nothing demonstrated yet.", detail: "Skills appear here when you pass a checkpoint, an assignment or the mock test, not when you read a lesson." };

  return {
    generatedAt: now, verdict, skills: skillRows, solo, helped, gaps, levels, capstone, cases: caseRows,
    cvLines: solo.map(s => s.claim), fallback: skills.fallback, outOfScope: skills.outOfScope || [], simulatedCount: simulated.length,
    totals: { drills: levels.reduce((n, l) => n + l.drillsTotal, 0), drillsSolo: levels.reduce((n, l) => n + l.drillsSolo, 0), drillsHelped: levels.reduce((n, l) => n + l.drillsHelped, 0) },
  };
}

/** Level lock chain on genuine passes (dev-simulated passes don't open anything in the REPORT's eyes). */
function levelChain(levels, genuinelyPassed) {
  let open = true;
  return levels.map(l => { const unlocked = open && (!l.requires || genuinelyPassed(l.requires)); open = unlocked; return !unlocked ? "locked" : genuinelyPassed(l.gate.taskId) ? "complete" : "open"; });
}

/* ---------- DOM ---------- */
const STATE_PILL = {
  solo: `<span class="pill pill--complete">Demonstrated</span>`,
  helped: `<span class="pill report__pill--helped">With help</span>`,
  simulated: `<span class="pill report__pill--sim">Simulated for testing, not counted</span>`,
  none: `<span class="pill pill--open">Not yet</span>`,
};
function evidenceText(s) {
  const p = s.pass;
  if (s.state === "none") return `Not passed yet: ${esc(s.evidenceLabel)}.`;
  if (s.state === "simulated") return `${esc(s.evidenceLabel)} was only simulated for testing, not actually passed.`;
  const bits = [`${esc(s.evidenceLabel)} passed ${esc(fmtDate(s.afterHelp ? p.soloAt : p.at))}`];
  if (p.score !== undefined && p.total) bits.push(`${p.score}/${p.total}`);
  if (p.seconds) bits.push(`in ${formatClock(p.seconds)}`);
  if (p.submissions) bits.push(`${p.submissions} ${s.evidence === "mock-test" ? "attempt" : "submission"}${p.submissions === 1 ? "" : "s"}`);
  if (p.variant) bits.push(`variant ${esc(p.variant)}`);
  return bits.join(" · ") + (s.state === "helped" ? " · with help (answer key or solution used)" : s.afterHelp ? " · without help, after an earlier pass with help" : " · no help");
}
const pct = (a, b) => (b ? Math.round((a / b) * 100) : 0);

export function renderReport(host, { report: R, hrefs }) {
  const practice = s => s.practice.drillsTotal ? `<p class="report__practice">Practice: ${s.practice.drillsSolo} of ${s.practice.drillsTotal} drills solved alone${s.practice.drillsHelped ? `, ${s.practice.drillsHelped} with help` : ""}${s.practice.checkpointsTotal ? ` · ${s.practice.checkpointsPassed}/${s.practice.checkpointsTotal} checkpoints` : ""}.</p>` : "";
  const skill = (s, words) => `<li class="report-skill report-skill--${s.state}" data-skill="${esc(s.id)}">
      <div class="report-skill__head"><span class="report-skill__label">${esc(s.label)}</span>${STATE_PILL[s.state]}</div>
      <p class="report-skill__words">${words}</p>
      <p class="report-skill__evidence">${evidenceText(s)}</p>${practice(s)}</li>`;
  const cv = R.cvLines.length ? R.cvLines : [];
  const cvText = cv.length ? cv.map(l => `• ${l}`).join("\n") : R.fallback;

  host.innerHTML = `
  <article class="container view stack stack-lg report">
    <header class="lesson-head">
      <p class="eyebrow">Readiness report · ${esc(fmtDate(R.generatedAt))}</p>
      <h1 tabindex="-1">What you can honestly claim</h1>
      <p class="lede">Built only from what you've done in this browser: passed checkpoints, assignments, the mock test and the case study. Reading a lesson doesn't count, and neither does anything passed with the answer key open.</p>
      <p class="report__actions no-print"><button class="btn btn--secondary" type="button" data-print>Print / save as PDF</button></p>
    </header>

    <section class="report-verdict report-verdict--${R.verdict.key}" data-verdict aria-labelledby="verdict-h">
      <h2 class="report-verdict__headline" id="verdict-h">${esc(R.verdict.headline)}</h2>
      <p>${esc(R.verdict.detail)}</p>
      <ol class="report-levels" role="list" aria-label="Levels">${R.levels.map(l => `<li class="report-levels__item is-${l.state}" title="${esc(l.label)}: ${esc(l.state === "solo" ? "demonstrated" : l.state === "helped" ? "passed with help" : l.state === "simulated" ? "simulated, not counted" : "not passed")}">
        <span class="report-levels__name">${esc(l.label)}</span><span class="report-levels__state">${l.state === "solo" ? "✓ Demonstrated" : l.state === "helped" ? "◐ With help" : l.state === "simulated" ? "Simulated" : "Not yet"}</span></li>`).join("")}</ol>
    </section>
    ${R.simulatedCount ? `<div class="notice notice--warn" data-simulated><div><span class="notice__tag">Not counted</span>${R.simulatedCount} pass${R.simulatedCount === 1 ? " was" : "es were"} simulated for testing (not passed in the app). They unlock pages, but they are not evidence of anything, so this report ignores them.</div></div>` : ""}

    <section aria-labelledby="solo-h"><h2 class="section-title" id="solo-h">What you can honestly claim · ${R.solo.length}</h2>
      ${R.solo.length ? `<ul class="report-skills" role="list" data-solo>${R.solo.map(s => skill(s, `“${esc(s.claim)}”`)).join("")}</ul>` : `<p class="muted" data-solo-empty>Nothing yet. Pass the Level 0 checkpoint to make your first claim.</p>`}
    </section>

    ${R.helped.length ? `<section aria-labelledby="helped-h"><h2 class="section-title" id="helped-h">Passed with help · ${R.helped.length}</h2>
      <p class="muted">These count as practice, not as proof. Say it the way it is, and prove it cold${R.capstone && R.capstone.state !== "solo" ? " in the mock test" : ""} before claiming more.</p>
      <ul class="report-skills" role="list" data-helped>${R.helped.map(s => skill(s, `Say: “${esc(s.helped)}”`)).join("")}</ul></section>` : ""}

    <section aria-labelledby="gaps-h"><h2 class="section-title" id="gaps-h">Gaps: don't claim these yet · ${R.gaps.length}</h2>
      ${R.gaps.length ? `<ul class="report-skills" role="list" data-gaps>${R.gaps.map(s => skill(s, esc(s.gap))).join("")}</ul>` : `<p class="muted">None within this course. See “Not covered” below for what it doesn't teach.</p>`}
    </section>

    <section class="report-cv" aria-labelledby="cv-h">
      <h2 class="section-title" id="cv-h">CV and interview wording</h2>
      ${cv.length ? `<p class="muted">Only skills demonstrated without help. Copy them as they are; don't round them up.</p>
        <ul class="report-cv__lines" data-cv>${cv.map(l => `<li>${esc(l)}</li>`).join("")}</ul>`
        : `<p class="muted">Nothing demonstrated without help yet, so the honest line for now is:</p><p class="report-cv__fallback" data-cv-fallback>“${esc(R.fallback)}”</p>`}
      ${cv.length && R.gaps.length ? `<p class="report-cv__fallback-note">For everything else, until you've passed it: “${esc(R.fallback)}”</p>` : ""}
      <p class="no-print"><button class="btn btn--secondary" type="button" data-copy>Copy these lines</button> <span class="muted" data-copied aria-live="polite"></span></p>
      <textarea class="visually-hidden" data-cv-text aria-hidden="true" tabindex="-1" readonly>${esc(cvText)}</textarea>
    </section>

    ${R.capstone ? `<section aria-labelledby="cap-h"><h2 class="section-title" id="cap-h">The mock hiring test</h2>
      <div class="card report-cap" data-capstone>${R.capstone.attempts.length ? `
        <p><strong>${R.capstone.state === "solo" ? "Passed without help." : R.capstone.state === "helped" ? "Passed with help." : "Not passed yet."}</strong> ${R.capstone.attempts.length} attempt${R.capstone.attempts.length === 1 ? "" : "s"}. Best: ${R.capstone.best.score}/${R.capstone.best.total} in ${formatClock(R.capstone.best.seconds)} (variant ${esc(R.capstone.best.variant)}${R.capstone.best.passed && R.capstone.best.assisted ? ", with help" : ""}).</p>
        <table class="pivot__table report__table"><thead><tr><th scope="col">#</th><th scope="col">Variant</th><th scope="col">Score</th><th scope="col">Time</th><th scope="col">Result</th></tr></thead>
        <tbody>${R.capstone.attempts.map(a => `<tr><th scope="row">${a.n}</th><td>${esc(a.variant)}</td><td>${a.score}/${a.total}</td><td>${formatClock(a.seconds)}${a.auto ? " (time ran out)" : ""}</td><td>${a.passed ? (a.assisted ? "Passed with help" : "Passed") : "Not passed"}</td></tr>`).join("")}</tbody></table>`
        : `<p>Not attempted yet.${R.capstone.state === "simulated" ? " (A pass was simulated for testing; it isn't counted.)" : ""} <a href="${hrefs.mock}">About the mock test →</a></p>`}</div></section>` : ""}

    <section aria-labelledby="prac-h"><h2 class="section-title" id="prac-h">Practice record</h2>
      <p class="muted">${R.totals.drillsSolo} of ${R.totals.drills} drills solved alone (${pct(R.totals.drillsSolo, R.totals.drills)}%)${R.totals.drillsHelped ? `, ${R.totals.drillsHelped} with help` : ""}. Practice builds the skill; the assignments prove it.</p>
      <div class="report-practice">${R.levels.filter(l => l.lessons.length).map(l => `
        <details class="report-level" data-level="${esc(l.id)}"><summary><span class="report-level__name">${esc(l.label)} · ${esc(l.title)}</span>
          <span class="report-level__meta">${l.drillsSolo}/${l.drillsTotal} alone${l.drillsHelped ? ` · ${l.drillsHelped} with help` : ""} · ${esc(l.gateLabel)}: ${l.state === "solo" ? "passed" : l.state === "helped" ? "passed with help" : l.state === "simulated" ? "simulated" : "not passed"}</span></summary>
          <ul class="report-lessons">${l.lessons.map(ls => `<li><span class="report-lessons__title">${ls.complete ? "✓" : "○"} ${esc(ls.title)}</span>
            <span class="muted">${ls.drillsSolo}/${ls.drillsTotal} alone${ls.drillsHelped ? `, ${ls.drillsHelped} with help` : ""}${ls.checkpoint ? ` · checkpoint ${ls.checkpoint === "none" ? "to do" : "passed"}` : ""}</span>
            <span class="report-lessons__line">${ls.complete ? `${ls.helped ? "Practised (partly with help)" : "Practised"}: ${esc(ls.claimAfter)}` : `Not yet: ${esc(ls.notYet)}`}</span></li>`).join("")}</ul>
          <p class="report-level__claim">${l.state === "solo" ? `Level claim, earned: “${esc(l.claimAfter)}”` : l.state === "helped" ? `Level claim, with help: “${esc(l.claimAfter)}”` : `Level claim, not earned yet: “${esc(l.claimAfter)}”`}</p>
        </details>`).join("")}</div>
      ${R.cases.length ? `<p class="report-cases">${R.cases.map(c => `${esc(c.title)}: ${c.state === "solo" ? "complete" : c.state === "helped" ? "complete, with help" : "not done"}`).join(" · ")}</p>` : ""}
    </section>

    <section aria-labelledby="oos-h"><h2 class="section-title" id="oos-h">Not covered by this course</h2>
      <p class="muted">Nothing here demonstrates these, so don't imply it does: ${R.outOfScope.map(esc).join(" · ")}.</p></section>

    <nav class="pager no-print" aria-label="Back"><a class="btn btn--secondary" href="${hrefs.home}">← The path</a></nav>
  </article>`;

  host.querySelector("[data-print]").addEventListener("click", () => window.print());
  host.querySelector("[data-copy]").addEventListener("click", async () => {
    const text = host.querySelector("[data-cv-text]").value, out = host.querySelector("[data-copied]");
    try { await navigator.clipboard.writeText(text); out.textContent = "Copied."; }
    catch { const ta = host.querySelector("[data-cv-text]"); ta.classList.remove("visually-hidden"); ta.removeAttribute("aria-hidden"); ta.select(); out.textContent = "Select-all is done: press Ctrl+C (⌘C) to copy."; }
  });
  return { update() {}, destroy() { host.innerHTML = ""; } };
}
