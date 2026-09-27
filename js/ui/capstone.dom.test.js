/* capstone.dom.test.js: browser tests for ui/timer.js, ui/mocktest.js and ui/case.js,
   driven by the REAL mock test (+ key) and Case A. Time is injected, so the 45 minutes pass instantly.
   Runs from dev/test.html. In Node it only prints a skip notice. */
import { createTimer } from "./timer.js";
import { renderMockTest, variantTasks, mockKeyWorkspace } from "./mocktest.js";
import { renderCase, stepTaskId, resolveRowRefs } from "./case.js";
import { createProgressStore, levelStates } from "../progress.js";
import { createSuite, eq, assert } from "../testkit.js";

export const done = run();
const wait = ms => new Promise(r => setTimeout(r, ms));

async function run() {
  if (typeof document === "undefined") { console.log("— capstone (DOM) —\nskipped in Node: open dev/test.html in a browser"); return null; }
  const s = createSuite("capstone (DOM)");
  const base = new URL("../../content/", import.meta.url);
  const get = async p => (await fetch(new URL(p, base))).json();
  const curriculum = await get("curriculum.json");
  const CAP = curriculum.levels.find(l => l.id === "capstone");
  const T = await get(CAP.gate.content), KEY = await get(T.key);
  const CASE = await get(curriculum.cases[0].content);
  const stage = document.createElement("div"); stage.style.cssText = "position:absolute;left:-10000px;top:0;width:1200px"; document.body.append(stage);
  const host = () => { const h = document.createElement("div"); stage.append(h); return h; };
  const unlockAll = store => { for (const id of ["l0-checkpoint", "a1-sales-summary", "a2-enrich-orders", "a3-messy-export"]) if (!store.isPassed(id)) store.recordPass(id); };

  s.group("timer");
  s.test("shows the time left, warns in the last 5 minutes, fires onExpire exactly once", async () => {
    let t = 0, fired = 0; const h = host();
    const tm = createTimer(h, { durationSec: 600, startedAt: 0, now: () => t, onExpire: () => fired++ });
    eq(h.querySelector("[data-clock]").textContent, "10:00");
    t = 301e3; tm.tick(); assert(h.querySelector(".timer").classList.contains("is-warning"), "warning");
    assert(h.querySelector("[data-announce]").textContent.includes("5 minutes"), h.querySelector("[data-announce]").textContent);
    t = 700e3; tm.tick(); tm.tick(); eq(fired, 1); eq(h.querySelector("[data-clock]").textContent, "0:00");
    tm.destroy();
  });

  s.group("mock test");
  const mount = (opts = {}) => {
    let loads = 0;
    const store = opts.store || createProgressStore({ storage: null }); if (opts.unlock !== false) unlockAll(store);
    const clock = opts.clock || { t: 1_000_000 };
    const h = host();
    const ctrl = renderMockTest(h, { test: T, level: CAP, store, locked: !!opts.locked, lockedReason: "Pass A3.", next: null, hrefs: { level: "#/capstone", next: "#/" }, loadKey: async () => { loads++; return KEY; }, now: () => clock.t });
    store.subscribe(() => ctrl.update());
    return { h, store, ctrl, clock, loads: () => loads };
  };
  const fillAll = (h, variant, { skip = [] } = {}) => {
    for (const t of variantTasks(T, variant)) {
      const sol = KEY.solutions[t.id]; if (typeof sol !== "string" || skip.includes(t.id)) continue;
      const el = h.querySelector(`[data-input="${t.id}"]`); el.value = sol.replace(/^=/, ""); el.dispatchEvent(new Event("input", { bubbles: true }));
    }
  };
  s.test("before Start: no tasks, no key fetched, the next attempt is Variant A", () => {
    const { h, loads } = mount();
    eq(h.querySelectorAll("[data-input]").length, 0); assert(h.querySelector("[data-start]"), "start button");
    assert(h.querySelector(".mock__next").textContent.includes("Variant A"), "variant A first"); eq(loads(), 0);
  });
  s.test("locked: can't start", () => { const { h } = mount({ unlock: false, locked: true }); assert(h.querySelector("[data-start]").disabled, "disabled"); });
  s.test("Start shows the clock at 45:00, 7 formula tasks + the workspace; drafts survive a re-mount (the clock keeps running)", () => {
    const store = createProgressStore({ storage: null }), clock = { t: 5_000_000 };
    const { h } = mount({ store, clock }); h.querySelector("[data-start]").click();
    eq(h.querySelector("[data-clock]").textContent, "45:00"); eq(h.querySelectorAll("[data-input]").length, 7); assert(h.querySelector(".workbench"), "workbench");
    fillAll(h, "A");
    clock.t += 10 * 60e3;
    const again = mount({ store, clock });
    eq(again.h.querySelector("[data-clock]").textContent, "35:00");
    eq(again.h.querySelector('[data-input="a-sumifs"]').value, KEY.solutions["a-sumifs"].replace(/^=/, ""));
  });
  s.test("submit needs a confirm; then ONE submission, results, and the key only on request", async () => {
    const { h, store, ctrl, loads } = mount();
    h.querySelector("[data-start]").click(); fillAll(h, "A");
    h.querySelector("[data-submit]").click();
    assert(h.querySelector("[data-submit]").textContent.includes("Confirm"), "asks to confirm"); assert(h.querySelector("[data-input]"), "still running");
    h.querySelector("[data-submit]").click();
    assert(!h.querySelector("[data-input]"), "tasks gone after submitting");
    const msg = h.querySelector("[data-result-msg]").textContent;
    assert(msg.startsWith("7/10") && msg.includes("Not passed"), msg);   // Part 2 untouched: 3 workspace tasks wrong
    eq(loads(), 0, "key not fetched by submitting");
    assert(h.querySelector('[data-verdict="a-clean-1"]').textContent.includes("still to fix"), "specific cleaning verdict");
    h.querySelector('[data-show-key="A"]').click(); await wait(30);
    eq(loads(), 1); eq(h.querySelectorAll(".key__list > li").length, 10);
    assert(h.querySelector(".mock__next").textContent.includes("Variant B"), "retake uses the other variant");
    eq(store.isPassed("mock-test"), false); eq(ctrl.running, false);
  });
  s.test("time's up → submitted automatically with what's there", async () => {
    const clock = { t: 0 }; const { h } = mount({ clock });
    h.querySelector("[data-start]").click(); fillAll(h, "A", { skip: ["a-logic"] });
    clock.t = 45 * 60e3 + 5e3; await wait(400);
    const msg = h.querySelector("[data-result-msg]")?.textContent || "";
    assert(msg.includes("submitted automatically") && msg.startsWith("6/10"), msg);
  });
  s.test("reopening after the deadline submits the saved answers at once (the clock doesn't stop for a closed tab)", () => {
    const store = createProgressStore({ storage: null }), clock = { t: 0 };
    const a = mount({ store, clock }); a.h.querySelector("[data-start]").click(); fillAll(a.h, "A"); a.ctrl.destroy();
    clock.t = 3 * 3600e3;
    const b = mount({ store, clock });
    assert(b.h.querySelector("[data-result-msg]").textContent.includes("submitted automatically"), "auto");
    eq(store.getDraft("mock-test").attempts[0].seconds, 45 * 60);
  });
  s.test("a full, correct attempt (formulas + the real workspace) passes in time → capstone complete; a pass on a variant whose key you'd seen is 'with help'", async () => {
    const store = createProgressStore({ storage: null }), clock = { t: 0 };
    const { h } = mount({ store, clock });
    // attempt 1 (A): submit empty, open A's key
    h.querySelector("[data-start]").click(); h.querySelector("[data-submit]").click(); h.querySelector("[data-submit]").click();
    h.querySelector('[data-show-key="A"]').click(); await wait(30);
    // attempt 2 (B): do it all, properly
    h.querySelector("[data-start]").click();
    fillAll(h, "B");
    assert(mockKeyWorkspace(T, KEY, "B").pivot, "key pivot");
    // Part 2: the key's moves as a saved workspace draft (the workbench itself is tested in workbench.dom.test.js); a re-mount restores it
    const cur = store.getDraft("mock-test").current;
    const sols = variantTasks(T, "B").map(t => KEY.solutions[t.id]).filter(x => x && typeof x === "object");
    cur.workspace = { ops: sols.flatMap(x => x.steps || []), pivot: { config: sols.find(x => x.pivot).pivot, inserted: true, cacheKey: JSON.stringify(sols.flatMap(x => x.steps || [])) }, story: sols.find(x => x.story).story };
    store.setDraft("mock-test", { ...store.getDraft("mock-test"), current: { ...cur, answers: store.getDraft("mock-test").current.answers } });
    clock.t += 20 * 60e3;
    const again = mount({ store, clock });   // re-mount restores the workspace from the draft
    again.h.querySelector("[data-submit]").click(); again.h.querySelector("[data-submit]").click();
    const msg = again.h.querySelector("[data-result-msg]").textContent;
    assert(msg.startsWith("10/10") && msg.includes("Passed"), msg);
    const p = store.getPass("mock-test"); eq([p.variant, p.assisted, p.submissions], ["B", false, 2]);
    eq(levelStates(curriculum.levels, id => store.isPassed(id)).at(-1).status, "complete");
  });
  s.test("passing a variant after opening its key is recorded as 'passed with help'", async () => {
    const store = createProgressStore({ storage: null }), clock = { t: 0 };
    const draft = { attempts: [{ n: 1, variant: "A", seconds: 60, score: 0, total: 10, passed: false, results: [], submittedAt: 0 }, { n: 2, variant: "B", seconds: 60, score: 0, total: 10, passed: false, results: [], submittedAt: 0 }], current: null, keysSeen: ["A"] };
    unlockAll(store); store.setDraft("mock-test", draft);
    const { h } = mount({ store, clock });
    assert(h.querySelector(".mock__next").textContent.includes("passed with help"), "warned before starting");
    h.querySelector("[data-start]").click(); fillAll(h, "A");
    const cur = store.getDraft("mock-test").current, sols = variantTasks(T, "A").map(t => KEY.solutions[t.id]).filter(x => x && typeof x === "object");
    cur.workspace = { ops: sols.flatMap(x => x.steps || []), pivot: { config: sols.find(x => x.pivot).pivot, inserted: true, cacheKey: JSON.stringify(sols.flatMap(x => x.steps || [])) }, story: sols.find(x => x.story).story };
    store.setDraft("mock-test", { ...store.getDraft("mock-test"), current: cur });
    const again = mount({ store, clock }); again.h.querySelector("[data-submit]").click(); again.h.querySelector("[data-submit]").click();
    eq(store.getPass("mock-test").assisted, true);
    assert(again.h.querySelector("[data-status]").textContent.includes("with help"), "status");
  });

  s.group("Case A");
  const mountCase = (store = createProgressStore({ storage: null }), locked = false) => {
    if (!locked) unlockAll(store);
    const h = host(); const ctrl = renderCase(h, { caseStudy: CASE, store, locked, lockedReason: "Pass A3.", hrefs: { back: "#/capstone" } });
    store.subscribe(() => ctrl.update()); return { h, store, ctrl, wb: ctrl.workbench };
  };
  const step = (h, id) => h.querySelector(`[data-step="${id}"]`);
  const run = (h, id, f) => { const el = step(h, id).querySelector("[data-input]"); el.value = f.replace(/^=/, ""); el.dispatchEvent(new Event("input", { bubbles: true })); step(h, id).querySelector("[data-run]").click(); };
  s.test("6 steps render; formula steps have their own box; the rest a Check button", () => {
    const { h } = mountCase();
    eq(h.querySelectorAll(".case-step").length, 6); eq(h.querySelectorAll(".case-step [data-input]").length, 2); eq(h.querySelectorAll(".case-step [data-check]").length, 4);
  });
  s.test("the O1088 lookup is #N/A on the raw export and right after cleaning (it runs on YOUR data)", () => {
    const { h, store, wb } = mountCase();
    const st = CASE.steps.find(x => x.id === "enrich");
    run(h, "enrich", resolveRowRefs(st.solution.formula, wb.rows()));
    assert(step(h, "enrich").textContent.includes("#N/A"), step(h, "enrich").querySelector("[data-feedback]").textContent);
    eq(store.isPassed(stepTaskId(CASE, st)), false);
    wb.cleaning.applySteps(CASE.steps[0].solution.steps);
    run(h, "enrich", resolveRowRefs(st.solution.formula, wb.rows()));
    assert(store.isPassed(stepTaskId(CASE, st)), step(h, "enrich").querySelector("[data-feedback]").textContent);
  });
  s.test("the whole case, step by step → every step recorded, case complete, deliverable assembled from your own chart and sentence", () => {
    const { h, store, wb } = mountCase();
    for (const st of CASE.steps) {
      const sol = st.solution;
      if (sol.steps) wb.cleaning.applySteps(sol.steps);
      if (sol.pivot) { wb.pivot.setConfig(sol.pivot, { source: "user" }); if (sol.refresh) wb.pivot.refresh(); }
      if (sol.story) wb.story.setState(sol.story);
      if (sol.formula) run(h, st.id, resolveRowRefs(sol.formula, wb.rows()));
      else step(h, st.id).querySelector("[data-check]").click();
      assert(store.isPassed(stepTaskId(CASE, st)), `${st.id}: ${step(h, st.id).querySelector("[data-feedback]").textContent}`);
    }
    assert(store.isPassed(CASE.id) && store.getPass(CASE.id).assisted === false, "case recorded");
    const d = h.querySelector(".deliverable"); assert(d, "deliverable");
    assert(d.querySelector("svg.chart") && d.textContent.includes("Giorgos Nikolaou is furthest behind"), d.textContent.slice(0, 200));
  });
  s.test("a wrong check twice offers a solution; using it marks the step (and the case) 'with help'", () => {
    const { h, store } = mountCase();
    const b = step(h, "clean").querySelector("[data-check]"); b.click(); b.click();
    const sol = step(h, "clean").querySelector("[data-solution]"); assert(!sol.hidden, "offered"); sol.click();
    eq(store.isPassed("case-a:clean"), false); b.click();
    eq(store.getPass("case-a:clean").assisted, true);
  });
  s.test("choosing the rep with the least revenue (not furthest behind target) is caught", () => {
    const { h, wb } = mountCase();
    const fin = CASE.steps.find(x => x.id === "finding");
    wb.story.setState({ ...fin.solution.story, blanks: { ...fin.solution.story.blanks, rep: fin.solution.story.blanks.lowest } });
    step(h, "finding").querySelector("[data-check]").click();
    assert(step(h, "finding").querySelector("[data-feedback]").textContent.includes("rep furthest behind target"), step(h, "finding").querySelector("[data-feedback]").textContent);
  });
  s.test("locked: steps check but nothing is recorded", () => {
    const { h, store, wb } = mountCase(createProgressStore({ storage: null }), true);
    wb.cleaning.applySteps(CASE.steps[0].solution.steps);
    step(h, "clean").querySelector("[data-check]").click(); eq(store.passedIds(), []);
  });

  const summary = await s.report(); stage.remove(); return summary;
}
