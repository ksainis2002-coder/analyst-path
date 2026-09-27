/* lesson.dom.test.js: browser tests for ui/lesson.js + ui/quiz.js, driven by the REAL content JSON.
   Runs from dev/test.html. In Node it only prints a skip notice. */
import { renderLesson, renderGate } from "./lesson.js";
import { createProgressStore } from "../progress.js";
import { drillTaskId, checkpointTaskId, validateLesson } from "../content.js";
import { createSuite, eq, assert } from "../testkit.js";
import { evaluate } from "../engine.js";
import { DATASETS } from "../data.js";
import { formatValue } from "./console.js";

export const done = run();

async function run() {
  if (typeof document === "undefined") { console.log("— lesson (DOM) —\nskipped in Node: open dev/test.html in a browser"); return null; }
  const s = createSuite("lesson (DOM)");
  const base = new URL("../../content/", import.meta.url);
  const get = async p => (await fetch(new URL(p, base))).json();
  const curriculum = await get("curriculum.json");
  const L1 = curriculum.levels.find(l => l.id === "level-1");
  const L0 = curriculum.levels.find(l => l.id === "level-0");
  const sumifs = await get("lessons/l1-sumif-sumifs.json");
  const cells = DATASETS[sumifs.dataset].cells;
  const shown = f => formatValue(evaluate(f, cells).value).text;
  const iferror = await get("lessons/l1-iferror.json");
  const gate = await get("assignments/l0-checkpoint.json");

  const stage = document.createElement("div");
  stage.style.cssText = "position:absolute;left:-10000px;top:0;width:1200px";
  document.body.append(stage);
  const hrefs = { level: "#/level-1", lesson: n => `#/level-1/lesson-${n}`, gate: "#/level-1/assignment" };
  const mount = (lesson, opts = {}) => {
    const host = document.createElement("div"); stage.append(host);
    const store = opts.store || createProgressStore({ storage: null });
    const ctrl = renderLesson(host, { lesson, level: L1, order: lesson.order, total: 5, store, locked: !!opts.locked, lockedReason: "Pass A1.", hasGate: false, hrefs });
    store.subscribe(() => ctrl.update());
    return { host, store, ctrl, lab: ctrl.console };
  };
  const type = (host, f) => { const i = host.querySelector(".fx__input"); i.value = f; host.querySelector(".fx").requestSubmit(); };
  const fb = host => host.querySelector("[data-feedback]").textContent;

  s.group("renders every section from JSON");
  s.test("the content under test is valid", () => eq(validateLesson(sumifs, { level: 1, order: 3 }), []));
  s.test("concept, syntax, worked, mistakes, practice, checkpoint, claim, pager", () => {
    const { host } = mount(sumifs);
    eq(host.querySelector("h1").textContent, sumifs.title);
    assert(host.querySelector(".prose .callout--warn"), "concept callout rendered from Markdown");
    eq(host.querySelectorAll(".syntax").length, 2);
    assert(host.querySelector(".syntax__sig .syn-arg--1").textContent === "range", "SUMIF first arg coloured");
    assert(host.querySelector(".worked__formula").textContent === sumifs.worked.formula, "worked formula");
    eq(host.querySelectorAll(".mistakes li").length, sumifs.mistakes.length);
    assert(host.querySelector(".lab .drill"), "drill panel inside the console column");
    eq(host.querySelectorAll(".drill__dot").length, sumifs.drills.length);
    eq(host.querySelectorAll(".quiz__q").length, sumifs.checkpoint.questions.length);
    assert(host.querySelector("[data-claim]").textContent.includes(sumifs.claimAfter), "claimAfter shown");
    assert(host.querySelector("[data-claim]").textContent.includes(sumifs.notYet), "notYet shown");
  });

  s.group("drills run live in the console");
  s.test("a correct typed formula passes, is recorded, and highlights the sheet", () => {
    const { host, store, lab } = mount(sumifs);
    const d = sumifs.drills[0];
    type(host, d.solution);
    assert(fb(host).includes("Correct"), fb(host));
    assert(store.isPassed(drillTaskId(sumifs, d)), "recorded");
    assert(Object.keys(lab.sheet.state()).length > 0, "sheet highlighted");
    assert(host.querySelector(".drill__dot").classList.contains("is-done"), "dot shows done");
  });
  s.test("a wrong answer gets the engine's result + the drill's own hint, and isn't recorded", () => {
    const { host, store } = mount(sumifs);
    const wrong = '=SUMIF(D2:D181,"Attica",G2:G181)'; // right function, wrong region
    type(host, wrong);
    assert(fb(host).includes("Not yet") && fb(host).includes(String(evaluate(wrong, cells).value)), fb(host));
    assert(host.querySelector(".drill__hint").textContent.length > 10, "specific hint shown");
    eq(store.passedIds(), []);
  });
  s.test("right number, wrong function → 'Right answer, but…'", () => {
    const { host } = mount(sumifs);
    host.querySelectorAll(".drill__dot")[1].click(); // the SUMIFS drill
    type(host, '=SUMIF(D2:D181,"Crete",G2:G181)');
    assert(fb(host).includes("Right answer, but") && fb(host).includes("SUMIFS"), fb(host));
  });
  s.test("typing the number itself is refused", () => {
    const { host } = mount(sumifs); type(host, "48");
    assert(fb(host).includes("typed in"), fb(host));
  });
  s.test("after 2 wrong tries a solution can be revealed; running it counts as 'solved with help'", () => {
    const { host, store } = mount(sumifs);
    assert(host.querySelector("[data-solution]").hidden, "hidden at first");
    type(host, "=SUM(F2:F25)"); type(host, "=SUM(F2:F24)");
    const btn = host.querySelector("[data-solution]"); assert(!btn.hidden, "offered after 2 tries");
    btn.click();
    eq(host.querySelector(".fx__input").value, sumifs.drills[0].solution.replace(/^=/, ""));
    eq(store.passedIds(), [], "revealing alone records nothing");
    host.querySelector(".fx").requestSubmit();
    const p = store.getPass(drillTaskId(sumifs, sumifs.drills[0]));
    assert(p && p.assisted === true, "recorded as assisted");
    assert(host.querySelector(".drill__dot").classList.contains("is-helped"), "dot shows helped");
  });
  s.test("running the worked example never counts as solving a drill", () => {
    const { host, store } = mount(sumifs);
    host.querySelector("[data-run-worked]").click();
    eq(store.passedIds(), []); eq(fb(host), "");
    eq(host.querySelector(".rbox__value").textContent, shown(sumifs.worked.formula));
  });
  s.test("a drill starter is loaded but not run, and doesn't pass by itself", () => {
    const { host, store } = mount(iferror);
    eq(host.querySelector(".fx__input").value, iferror.drills[0].starter);
    host.querySelector(".fx").requestSubmit();
    assert(fb(host).includes("#DIV/0!"), "running the starter shows the error it's meant to show");
    eq(store.passedIds(), []);
  });
  s.test("dots navigate between drills and load each starter", () => {
    const { host } = mount(sumifs);
    host.querySelectorAll(".drill__dot")[3].click();
    assert(host.querySelector("[data-ask]").textContent.includes("Wireless Mice"), "drill 4 asks about the Wireless Mice");
    assert(host.querySelector("[data-drill-label]").textContent.startsWith("Drill 4 of"), "label");
  });

  s.group("checkpoint quiz");
  const answer = (host, picks) => { picks.forEach((j, i) => host.querySelectorAll(".quiz__q")[i].querySelectorAll("input")[j].click()); host.querySelector(".quiz").requestSubmit(); };
  s.test("passing records the lesson checkpoint; explanations shown", () => {
    const { host, store } = mount(sumifs);
    answer(host, sumifs.checkpoint.questions.map(q => q.answer));
    assert(store.isPassed(checkpointTaskId(sumifs)), "recorded");
    assert(host.querySelector(".quiz__feedback").textContent.length > 10, "explanation");
    assert(host.querySelector("[data-checkpoint-note]").textContent.includes("Passed"), "note updated");
  });
  s.test("failing records nothing; retry resets", () => {
    const { host, store } = mount(sumifs);
    answer(host, sumifs.checkpoint.questions.map(q => (q.answer + 1) % q.options.length));
    eq(store.passedIds(), []);
    host.querySelector("[data-retry]").click();
    eq(host.querySelectorAll(".quiz input:checked").length, 0);
  });
  s.test("submitting with a blank question asks you to answer it", () => {
    const { host, store } = mount(sumifs);
    host.querySelector(".quiz").requestSubmit();
    assert(host.querySelector(".quiz__msg").textContent.includes("question 1"), "prompt"); eq(store.passedIds(), []);
  });

  s.group("honesty");
  s.test("claim becomes 'You can now honestly say' only when every drill AND the checkpoint pass", () => {
    const { host, store } = mount(sumifs);
    sumifs.drills.forEach(d => store.recordPass(drillTaskId(sumifs, d)));
    assert(!host.querySelector(".claim").classList.contains("is-earned"), "drills alone aren't enough");
    store.recordPass(checkpointTaskId(sumifs));
    assert(host.querySelector(".claim").classList.contains("is-earned") && host.querySelector(".claim").textContent.includes("You can now honestly say"), "earned");
    assert(host.querySelector("[data-status]").textContent.includes("Lesson complete"), "status");
  });
  s.test("locked level: you can try drills, but nothing is recorded and the quiz is disabled", () => {
    const { host, store } = mount(sumifs, { locked: true });
    assert(host.querySelector(".notice--locked"), "locked notice");
    type(host, sumifs.drills[0].solution);
    assert(fb(host).includes("Not recorded"), fb(host));
    eq(store.passedIds(), []);
    assert(host.querySelector(".quiz button[type=submit]").disabled, "quiz disabled");
  });

  s.group("level gate (Level 0 checkpoint)");
  const mountGate = (opts = {}) => {
    const host = document.createElement("div"); stage.append(host);
    const store = createProgressStore({ storage: null });
    const ctrl = renderGate(host, { gate, level: L0, store, locked: false, next: L1, hrefs: { level: "#/level-0", next: "#/level-1" }, ...opts });
    store.subscribe(() => ctrl.update());
    return { host, store };
  };
  s.test("a failed attempt shows hints, not the answers (so a retake still tests you)", () => {
    const { host, store } = mountGate();
    answer(host, gate.questions.map(q => (q.answer + 1) % q.options.length));
    eq(store.passedIds(), []);
    eq(host.querySelectorAll(".quiz__option.is-answer").length, 0, "no answers revealed");
    assert(host.querySelector(".quiz__feedback").textContent.includes(gate.questions[0].hint), "hint shown");
  });
  s.test(`${gate.passMark}/${gate.questions.length} passes: records the gate, reveals explanations, unlocks the next level`, () => {
    const { host, store } = mountGate();
    const picks = gate.questions.map(q => q.answer); picks[0] = (picks[0] + 1) % gate.questions[0].options.length; // one wrong
    answer(host, picks);
    assert(store.isPassed(gate.id), "gate recorded");
    assert(host.querySelectorAll(".quiz__option.is-answer").length === gate.questions.length, "answers revealed after passing");
    assert(host.querySelector('[data-after] a[href="#/level-1"]'), "link to the unlocked level");
  });

  const summary = await s.report();
  stage.remove();
  return summary;
}
