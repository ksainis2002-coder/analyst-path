/* =========================================================================
   app.js: bootstraps the app (shell: Phase 1 · lessons & gates: Phase 3)
   -------------------------------------------------------------------------
   Loads content/curriculum.json, creates the progress store, starts the
   hash router and renders the views: home, level, lesson (ui/lesson.js),
   level gate (the Level 0 checkpoint quiz, or an assignment: ui/assignment.js)
   and not-found. Passing a gate records its task id, which unlocks the next
   level (progress.levelStates). All level and lesson text
   comes from content/*.json; nothing about a specific level or lesson is
   hard-coded here.

   URL flag (query string, before the #):
     ?nostorage  force memory-only progress, to see the no-localStorage mode.
   The Phase 1–8 developer panel (?dev) was removed in Phase 9. Tests seed
   progress directly instead; any pass tagged { source: "dev" } is still
   never counted by the readiness report.
   ========================================================================= */

import { createRouter, href, parseHash } from "./router.js";
import { createProgressStore, levelStates } from "./progress.js";
import { loadLesson, loadLevelLessons, loadGate, loadKey, loadCase, loadSkills, loadCheatsheet, prefetchContent, lessonProgress } from "./content.js";
import { buildReport, renderReport } from "./ui/report.js";
import { renderCheatsheet, validateCheatsheet } from "./ui/cheatsheet.js";
import { renderLesson, renderGate } from "./ui/lesson.js";
import { renderAssignment } from "./ui/assignment.js";
import { renderMockTest } from "./ui/mocktest.js";
import { renderCase } from "./ui/case.js";

const CURRICULUM_URL = "content/curriculum.json";
const flags = new URLSearchParams(location.search);

const $ = sel => document.querySelector(sel);
const esc = v => String(v ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const LOCK_SVG = `<svg class="level-nav__lock" viewBox="0 0 12 12" aria-hidden="true" focusable="false"><path fill="currentColor" d="M3.5 5V3.75a2.5 2.5 0 0 1 5 0V5h.25c.41 0 .75.34.75.75v4.5c0 .41-.34.75-.75.75h-5.5a.75.75 0 0 1-.75-.75v-4.5c0-.41.34-.75.75-.75h.25Zm1.25 0h2.5V3.75a1.25 1.25 0 0 0-2.5 0V5Z"/></svg>`;
const STATUS_TEXT = { open: "Open", complete: "Complete", locked: "Locked" };
const fmtDate = ts => new Date(ts).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });

let curriculum, store, router;

/* ---------- boot ---------- */
boot();

async function boot() {
  store = createProgressStore(flags.has("nostorage") ? { storage: null } : {});
  try {
    curriculum = validate(await loadCurriculum());
  } catch (err) {
    renderLoadError(err);
    return;
  }
  renderFooter();
  store.subscribe(() => { renderChrome(); rerender(); });
  $("[data-skip]").addEventListener("click", e => { e.preventDefault(); $("#main").focus(); });
  router = createRouter(onRoute);
  // Warm the content cache once the first page is up, so the rest of the course works offline (spec §5.2).
  (globalThis.requestIdleCallback || (fn => setTimeout(fn, 1500)))(() => prefetchContent(curriculum).then(ok => { document.documentElement.dataset.contentReady = ok.length; }));
}

async function loadCurriculum() {
  const res = await fetch(CURRICULUM_URL, { cache: "no-cache" });
  if (!res.ok) throw new Error(`${CURRICULUM_URL} returned HTTP ${res.status}`);
  return res.json();
}

/** Minimal shape check, so a content typo fails loudly instead of rendering nonsense. */
function validate(c) {
  const problems = [];
  if (!c || !Array.isArray(c.levels) || c.levels.length === 0) problems.push("`levels` must be a non-empty array");
  const ids = new Set(), gates = new Set();
  (c?.levels || []).forEach((l, i) => {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(l.id || "")) problems.push(`levels[${i}].id "${l.id}" must be a lowercase slug`);
    if (ids.has(l.id)) problems.push(`duplicate level id "${l.id}"`);
    ids.add(l.id);
    if (!l.title) problems.push(`levels[${i}] needs a title`);
    if (!l.gate?.taskId) problems.push(`levels[${i}] needs gate.taskId`);
    if (l.requires && !gates.has(l.requires)) problems.push(`levels[${i}].requires "${l.requires}" must be an earlier level's gate`);
    if (l.gate?.taskId) gates.add(l.gate.taskId);
    if (!Array.isArray(l.lessons)) problems.push(`levels[${i}].lessons must be an array (of lesson ids)`);
    else if (l.lessons.some(id => !/^[a-z0-9][a-z0-9-]*$/.test(id))) problems.push(`levels[${i}].lessons must be lesson id slugs`);
    if (l.lessons?.length && !Number.isInteger(l.number)) problems.push(`levels[${i}] needs a numeric "number" (lessons declare their level by it)`);
  });
  (c?.cases || []).forEach((k, i) => {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(k.id || "")) problems.push(`cases[${i}].id must be a slug`);
    if (!k.title || !k.content) problems.push(`cases[${i}] needs title and content`);
    if (k.requires && !gates.has(k.requires)) problems.push(`cases[${i}].requires "${k.requires}" must be a level's gate`);
  });
  if (problems.length) throw new Error("curriculum.json is invalid: " + problems.join("; "));
  return c;
}

/* ---------- state helpers ---------- */
const states = () => levelStates(curriculum.levels, id => store.isPassed(id));
const statusOf = id => states().find(s => s.id === id)?.status;
const levelById = id => curriculum.levels.find(l => l.id === id);
const levelByGate = taskId => curriculum.levels.find(l => l.gate.taskId === taskId);
const caseById = id => (curriculum.cases || []).find(k => k.id === id);
const caseLocked = k => !!k.requires && !store.isPassed(k.requires);
/** Is the page this route shows locked right now? (drives "update in place" vs "rebuild") */
function routeLocked(route) {
  if (route?.name === "case") { const k = caseById(route.params.case); return k ? caseLocked(k) : false; }
  const lvl = route?.params?.level && levelById(route.params.level);
  return lvl ? statusOf(lvl.id) === "locked" : false;
}

/** Where "Continue" goes: the last route, if it's in a level you can actually work in (not locked)
 *  and points at something that exists. Otherwise the first open level. */
function continueTarget() {
  const last = store.getLastRoute();
  const r = last && parseHash(last);
  const lvl = r && r.params.level && levelById(r.params.level);
  const exists = lvl && (r.name === "level" || r.name === "gate" || (r.name === "lesson" && r.params.lesson <= lvl.lessons.length));
  if (exists && statusOf(lvl.id) !== "locked") return { hash: last, level: lvl };
  const next = curriculum.levels.find(l => statusOf(l.id) === "open") || curriculum.levels[0];
  return { hash: href.level(next.id), level: next };
}

/* ---------- routing ---------- */
let currentRoute = null;
let controller = null;   // live view (lesson / gate) that updates itself instead of being re-rendered
let routeToken = 0;      // guards against a slow async load painting over a newer route

async function onRoute(route, { initial }) {
  currentRoute = route;
  const token = ++routeToken;
  renderChrome();
  const title = await renderView(route, token);
  if (token !== routeToken) return;
  document.title = title ? `${title} · The Analyst Path` : "The Analyst Path";
  // Remember where you were for "Continue". Home isn't a place to resume, so it never overwrites this.
  if (route.params.level && levelById(route.params.level) && title !== "Not found") store.setLastRoute(location.hash);
  if (!initial) {
    window.scrollTo(0, 0);
    ($("#main h1") || $("#main")).focus({ preventScroll: true });
  }
}

/** On a progress change: live views update in place (so a console mid-drill is never rebuilt); static views re-render.
 *  Exception: if the page's level just changed lock status (e.g. it unlocked while you were on it), rebuild it. */
function rerender() {
  if (!currentRoute) return;
  const lockedNow = routeLocked(currentRoute);
  if (controller && controller.lockedAtRender === lockedNow) controller.update();
  else renderView(currentRoute, routeToken);
}

async function renderView(route, token) {
  const main = $("#main");
  const paint = html => { if (token === routeToken) { controller?.destroy?.(); controller = null; main.innerHTML = html; } return token === routeToken; };
  if (route.name === "home") { paint(viewHome()); return ""; }
  if (route.name === "cheatsheet") {
    try {
      const sheet = await loadCheatsheet(), problems = validateCheatsheet(sheet);
      if (problems.length) throw new Error("content/cheatsheet.json is invalid:\n- " + problems.join("\n- "));
      if (!paint("")) return "";
      controller = renderCheatsheet(main, { sheet, hrefs: { home: "#/" } }); controller.lockedAtRender = false;
      return "Cheat-sheet";
    } catch (err) { paint(viewContentError(err)); return "Content error"; }
  }
  if (route.name === "report") {
    try {
      const withLessons = curriculum.levels.filter(l => l.lessons.length);
      const [skills, ...lessonLists] = await Promise.all([loadSkills(curriculum), ...withLessons.map(l => loadLevelLessons(l, l.number))]);
      const lessonsByLevel = Object.fromEntries(withLessons.map((l, i) => [l.id, lessonLists[i]]));
      const report = buildReport({ curriculum, lessonsByLevel, skills, cases: curriculum.cases || [], getPass: id => store.getPass(id), getDraft: id => store.getDraft(id), now: Date.now() });
      if (!paint("")) return "";
      const cap = curriculum.levels.find(l => l.gate.kind === "mock-test");
      controller = renderReport(main, { report, hrefs: { home: "#/", mock: cap ? href.gate(cap.id, "mock-test") : "#/" } });
      controller.lockedAtRender = false;
      return "Readiness report";
    } catch (err) { paint(viewContentError(err)); return "Content error"; }
  }
  if (route.name === "case") {
    const k = caseById(route.params.case);
    if (!k) { paint(viewNotFound()); return "Not found"; }
    try {
      const c = await loadCase(k);
      if (!paint("")) return "";
      const req = levelByGate(k.requires), home = curriculum.levels.find(l => l.requires === k.requires);
      controller = renderCase(main, { caseStudy: c, store, locked: caseLocked(k),
        lockedReason: req ? `Pass <strong>${esc(req.gate.label)}</strong> in <a href="${href.level(req.id)}">${esc(req.label)}</a> to unlock this case.` : "",
        hrefs: { back: home ? href.level(home.id) : "#/" } });
      controller.lockedAtRender = caseLocked(k);
      return c.title;
    } catch (err) { paint(viewContentError(err)); return "Content error"; }
  }
  const level = levelById(route.params.level);
  if (!level) { paint(viewNotFound()); return "Not found"; }
  try {
    if (route.name === "level") {
      const [lessons, gate] = await Promise.all([loadLevelLessons(level, level.number), loadGate(level, level.number)]);
      paint(viewLevel(level, lessons, gate));
      return `${level.label}: ${level.title}`;
    }
    if (route.name === "lesson") {
      const n = route.params.lesson;
      if (n > level.lessons.length) { paint(viewLessonMissing(level, n)); return "Not found"; }
      const [lesson, gate] = await Promise.all([loadLesson(level, level.number, n), loadGate(level, level.number)]);
      if (!paint("")) return "";
      const lessonLocked = statusOf(level.id) === "locked";
      controller = renderLesson(main, {
        lesson, level, order: n, total: level.lessons.length, store,
        locked: statusOf(level.id) === "locked", lockedReason: lockedReason(level),
        hasGate: !!gate, hrefs: { level: href.level(level.id), lesson: k => href.lesson(level.id, k), gate: href.gate(level.id, level.gate.kind) },
      });
      controller.lockedAtRender = lessonLocked;
      return `${lesson.title} · ${level.label}`;
    }
    if (route.name === "gate") {
      const gate = route.params.kind === level.gate.kind ? await loadGate(level, level.number) : null;
      if (!gate) { paint(viewGateMissing(level)); return "Not found"; }
      if (!paint("")) return "";
      const next = curriculum.levels[curriculum.levels.indexOf(level) + 1] || null;
      const common = { level, store, locked: statusOf(level.id) === "locked", lockedReason: lockedReason(level), next,
        hrefs: { level: href.level(level.id), next: next ? href.level(next.id) : "#/" } };
      controller = gate.kind === "assignment" ? renderAssignment(main, { ...common, assignment: gate, loadKey: () => loadKey(gate) })
        : gate.kind === "mock-test" ? renderMockTest(main, { ...common, test: gate, loadKey: () => loadKey(gate) })
        : renderGate(main, { ...common, gate });
      controller.lockedAtRender = common.locked;
      return `${gate.title} · ${level.label}`;
    }
  } catch (err) {
    paint(viewContentError(err));
    return "Content error";
  }
  paint(viewNotFound());
  return "Not found";
}

function lockedReason(level) {
  const req = level.requires ? levelByGate(level.requires) : null;
  return req ? `Pass <strong>${esc(req.gate.label)}</strong> in <a href="${href.level(req.id)}">${esc(req.label)}</a> to unlock this level.` : "";
}

/* ---------- chrome: nav, meter, notices ---------- */
function renderChrome() {
  const st = states();
  const activeLevel = currentRoute?.params?.level;

  $("#level-nav").innerHTML = `<ol class="level-nav__list" role="list">${curriculum.levels.map((l, i) => {
    const s = st[i].status;
    const current = l.id === activeLevel ? ' aria-current="page"' : "";
    return `<li><a class="level-nav__link is-${s}" href="${href.level(l.id)}"${current}
      aria-label="${esc(`${l.label}: ${l.title} (${STATUS_TEXT[s].toLowerCase()})`)}">
      <span class="level-nav__badge" aria-hidden="true">${esc(l.badge)}</span>${esc(l.label)}${s === "locked" ? LOCK_SVG : ""}</a></li>`;
  }).join("")}</ol>`;

  const done = st.filter(s => s.status === "complete").length;
  const meterHTML = `<span class="meter__track" aria-hidden="true">${st.map(s => `<span class="meter__seg is-${s.status}"></span>`).join("")}</span>
    <span class="meter__label"><span aria-hidden="true">${done}/${st.length}</span><span class="visually-hidden">${done} of ${st.length} levels complete</span></span>`;
  const meter = $("#progress-meter");
  if (meter.dataset.key !== String(done) + st.map(s => s.status).join()) { meter.innerHTML = meterHTML; meter.dataset.key = String(done) + st.map(s => s.status).join(); }

  const notices = [];
  if (!store.persistent) notices.push(`<div class="notice notice--warn"><div><span class="notice__tag">Progress won't be saved</span>
    This browser isn't letting the app store data (private mode, blocked storage, or storage is full). Everything still works, but your progress resets when you close this tab.</div></div>`);
  if (store.recovered) notices.push(`<div class="notice"><div><span class="notice__tag">Progress reset</span>
    Saved progress in this browser couldn't be read, so the app started fresh.</div></div>`);
  $("#notices").innerHTML = notices.join("");
}

/* ---------- views ---------- */
function statusPill(status) {
  return `<span class="pill pill--${status}">${status === "locked" ? LOCK_SVG : ""}${STATUS_TEXT[status]}</span>`;
}

function viewHome() {
  const st = states();
  const cont = continueTarget();
  const anyProgress = store.passedIds().length > 0 || store.getLastRoute() === cont.hash;
  const ctaLabel = anyProgress ? `Continue: ${cont.level.label}` : `Start with ${cont.level.label}`;
  return `
  <section class="hero">
    <div class="hero__grid" aria-hidden="true">
      <span class="hero__cell hero__cell--search"></span><span class="hero__cell hero__cell--match"></span><span class="hero__cell hero__cell--return"></span>
    </div>
    <div class="container hero__inner stack">
      <p class="eyebrow">Excel test prep · beginner → job-ready</p>
      <h1 tabindex="-1">Get <em>genuinely</em> ready for the Excel test.</h1>
      <p class="lede">Four levels and a timed mock test, built around the functions hiring tests actually use. You unlock each level by passing its checkpoint or assignment, not by scrolling past it.</p>
      <div class="cluster"><a class="btn btn--primary" href="${esc(cont.hash)}">${esc(ctaLabel)} →</a><a class="btn btn--secondary" href="${href.report()}" data-report-link>Readiness report</a></div>
      <div class="cluster legend-row">
        <span id="legend-label">Every formula you run shows its work:</span>
        <ul class="legend" role="list" aria-labelledby="legend-label">
          <li><span class="legend__swatch legend__swatch--search" aria-hidden="true"></span>searching</li>
          <li><span class="legend__swatch legend__swatch--match" aria-hidden="true"></span>matched</li>
          <li><span class="legend__swatch legend__swatch--return" aria-hidden="true"></span>returned</li>
        </ul>
      </div>
    </div>
  </section>
  <div class="container view stack stack-lg">
    <section>
      <h2 class="section-title">The path</h2>
      <ol class="level-list" role="list">${curriculum.levels.map((l, i) => `
        <li><a class="level-card is-${st[i].status}" href="${href.level(l.id)}">
          <span class="level-card__num" aria-hidden="true">${esc(l.badge)}</span>
          <span><span class="level-card__title">${esc(l.label)} · ${esc(l.title)}</span>
            <span class="level-card__meta">${esc(l.estimate)} · ends with ${esc(l.gate.label)}</span></span>
          ${statusPill(st[i].status)}
        </a></li>`).join("")}
      </ol>
    </section>
    ${casesHTML(curriculum.cases || [], "Case studies")}
    <div class="notice"><div><span class="notice__tag">What counts as progress</span>
      Only passing a checkpoint, an assignment or the mock test moves your progress. Reading a lesson doesn't. That way, anything the app says you can do is true.</div></div>
  </div>`;
}

/** Case studies unlock with a gate; they're listed on the page of the level that the same gate opens. */
function casesHTML(list, heading) {
  if (!list.length) return "";
  return `<section><h2 class="section-title">${heading}</h2><ol class="lesson-list" role="list">${list.map(k => {
    const locked = caseLocked(k), pass = store.getPass(k.id);
    return `<li><a class="lesson-row${pass ? " is-complete" : ""}" href="${href.case(k.id)}">
      <span class="lesson-row__num" aria-hidden="true">${pass ? "✓" : "A"}</span>
      <span class="lesson-row__body"><span class="lesson-row__title">${esc(k.title)}</span>
        <span class="lesson-row__meta">${esc(k.estimate)} · ${esc(k.summary)}</span></span>
      ${locked ? statusPill("locked") : pass ? `<span class="pill pill--complete">Complete${pass.assisted ? " · with help" : ""}</span>` : statusPill("open")}
    </a></li>`; }).join("")}</ol></section>`;
}

function viewLevel(level, lessons, gate) {
  const status = statusOf(level.id);
  const idx = curriculum.levels.indexOf(level);
  const prev = curriculum.levels[idx - 1], next = curriculum.levels[idx + 1];
  const pass = store.getPass(level.gate.taskId);

  const locked = status === "locked" ? `
    <div class="notice notice--locked"><div><span class="notice__tag">Locked</span>
      ${lockedReason(level)} You can read the lessons and try the console, but drills and checkpoints won't count until then.</div></div>` : "";

  const lessonList = lessons.length
    ? `<ol class="lesson-list" role="list">${lessons.map((ls, i) => {
        const pr = lessonProgress(ls, id => store.isPassed(id));
        const bits = [pr.drillsTotal ? `${pr.drillsDone}/${pr.drillsTotal} drills` : "", pr.hasCheckpoint ? (pr.checkpoint ? "checkpoint ✓" : "checkpoint") : ""].filter(Boolean).join(" · ");
        return `<li><a class="lesson-row${pr.complete ? " is-complete" : ""}" href="${href.lesson(level.id, i + 1)}">
          <span class="lesson-row__num" aria-hidden="true">${pr.complete ? "✓" : i + 1}</span>
          <span class="lesson-row__body"><span class="lesson-row__title">${esc(ls.title)}</span>
            <span class="lesson-row__meta">${esc(ls.estMinutes)} min · ${esc(bits)}${pr.complete ? " · complete" : ""}</span></span>
        </a></li>`;
      }).join("")}</ol>`
    : `<div class="empty-state">No lessons in this level yet.</div>`;

  const gateStatus = status === "locked" ? statusPill("locked")
    : pass ? `<span class="pill pill--complete">Passed ${esc(fmtDate(pass.at))}</span>`
    : `<span class="pill pill--open">Not passed yet</span>`;
  const gateNote = (next ? `Passing it completes ${esc(level.label)} and unlocks ${esc(next.label)}.` : "Passing it completes the path.")
    + (gate ? "" : " It isn't available in this build yet.");
  const gateLabel = gate ? `<a href="${href.gate(level.id, level.gate.kind)}">${esc(level.gate.label)}</a>` : esc(level.gate.label);

  const earned = status === "complete";
  const claim = level.claimAfter ? `
    <section class="claim${earned ? " is-earned" : ""}">
      <p class="claim__q">${earned ? "You can now honestly say" : "Once you pass, you'll be able to honestly say"}</p>
      <p class="claim__text">“${esc(level.claimAfter)}”</p>
      ${earned ? "" : `<p class="claim__note">Not before. Reading the lessons doesn't count; passing the ${esc(level.gate.kind.replace("-", " "))} does.</p>`}
    </section>` : "";

  return `
  <div class="container view stack stack-lg">
    <header class="level-head">
      <span class="level-head__ghost" aria-hidden="true">${esc(level.badge)}</span>
      <div class="level-head__meta"><span class="eyebrow">${esc(level.label)} · ${esc(level.estimate)}</span>${statusPill(status)}</div>
      <h1 tabindex="-1">${esc(level.title)}</h1>
      <p class="lede">${esc(level.summary)}</p>
    </header>
    ${locked}
    ${lessons.length || !(curriculum.cases || []).some(k => k.requires === level.requires) ? `<section><h2 class="section-title">Lessons</h2>${lessonList}</section>` : ""}
    ${casesHTML((curriculum.cases || []).filter(k => level.requires && k.requires === level.requires), "Case study: practise the whole job first")}
    <section><h2 class="section-title">To complete this level</h2>
      <div class="card gate"><span class="gate__label">${gateLabel}</span>${gateStatus}<p class="gate__note">${gateNote}</p></div>
    </section>
    ${claim}
    ${level.gate.kind === "mock-test" ? `<section class="card report-link"><h2 class="section-title">Readiness report</h2><p>What you can honestly claim so far, what you passed with help, and what's still a gap, in CV-safe wording.</p><p><a class="btn btn--secondary" href="${href.report()}" data-report-link>Open the readiness report →</a></p></section>` : ""}
    <nav class="pager" aria-label="Levels">
      ${prev ? `<a class="btn btn--secondary" href="${href.level(prev.id)}">← ${esc(prev.label)}</a>` : "<span></span>"}
      ${next ? `<a class="btn btn--primary" href="${href.level(next.id)}">${esc(next.label)} →</a>` : ""}
    </nav>
  </div>`;
}

function viewLessonMissing(level, n) {
  return `
    <div class="container view stack">
      <p class="eyebrow">${esc(level.label)}</p>
      <h1 tabindex="-1">Lesson ${n} isn't here</h1>
      <p class="lede">${esc(level.label)} has ${level.lessons.length === 0 ? "no lessons yet" : `${level.lessons.length} lesson${level.lessons.length === 1 ? "" : "s"}`}.</p>
      <p><a class="btn btn--secondary" href="${href.level(level.id)}">← Back to ${esc(level.label)}</a></p>
    </div>`;
}

function viewGateMissing(level) {
  return `
    <div class="container view stack">
      <p class="eyebrow">${esc(level.label)}</p>
      <h1 tabindex="-1">${esc(level.gate.label)} isn't available yet</h1>
      <p class="lede">It arrives in a later build. Your progress on the lessons is saved.</p>
      <p><a class="btn btn--secondary" href="${href.level(level.id)}">← Back to ${esc(level.label)}</a></p>
    </div>`;
}

function viewContentError(err) {
  return `
    <div class="container view stack">
      <p class="eyebrow">Content error</p>
      <h1 tabindex="-1">This page's content couldn't be loaded</h1>
      <p class="lede">A lesson file is missing or doesn't match the schema. The details below say which file and what's wrong.</p>
      <div class="notice notice--warn"><div><span class="notice__tag">Details</span><pre class="mono" style="white-space:pre-wrap;margin:0">${esc(err.message)}</pre></div></div>
    </div>`;
}

function viewNotFound() {
  return `
  <div class="container view stack">
    <p class="eyebrow">#N/A</p>
    <h1 tabindex="-1">That page doesn't exist</h1>
    <p class="lede">The link may be old, or mistyped. Nothing was lost; your progress is where you left it.</p>
    <p><a class="btn btn--primary" href="#/">Go to the path</a></p>
  </div>`;
}

function renderFooter() {
  $("#footer").innerHTML = `
    <p>Your progress is stored only in this browser. Nothing is sent anywhere. <button class="btn btn--quiet" type="button" data-reset>Reset progress</button></p>
    <p><a href="${href.cheatsheet()}">One-page cheat-sheet</a> · <a href="${href.report()}">Readiness report</a></p>
    <p>The order of functions follows a senior data analyst's public "don't learn 50 formulas, follow a path" roadmap.</p>`;
  $("[data-reset]").addEventListener("click", () => {
    if (confirm("Reset all progress? Passed checkpoints and assignments will be cleared from this browser.")) store.reset();
  });
}

function renderLoadError(err) {
  const fileProtocol = location.protocol === "file:";
  $("#main").innerHTML = `
  <div class="container view stack">
    <p class="eyebrow">Couldn't start</p>
    <h1 tabindex="-1">The course outline didn't load</h1>
    ${fileProtocol
      ? `<p class="lede">It looks like index.html was opened straight from your disk. Browsers block that for apps built from several files. Start a local web server in the project folder (for example <code>python3 -m http.server 8000</code>), then open <code>http://localhost:8000</code>.</p>`
      : `<p class="lede">Check that <code>${esc(CURRICULUM_URL)}</code> exists and is valid JSON, then reload.</p>`}
    <div class="notice notice--warn"><div><span class="notice__tag">Details</span><code>${esc(err.message)}</code></div></div>
  </div>`;
}
