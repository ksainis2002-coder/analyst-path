/* assignment.dom.test.js: browser tests for ui/assignment.js with the REAL Assignment 1 + key.
   Runs from dev/test.html. In Node it only prints a skip notice. */
import { renderAssignment } from "./assignment.js";
import { createProgressStore, levelStates } from "../progress.js";
import { createSuite, eq, assert } from "../testkit.js";
import { evaluate } from "../engine.js";
import { DATASETS } from "../data.js";

export const done = run();

async function run() {
  if (typeof document === "undefined") { console.log("— assignment (DOM) —\nskipped in Node: open dev/test.html in a browser"); return null; }
  const s = createSuite("assignment (DOM)");
  const base = new URL("../../content/", import.meta.url);
  const get = async p => (await fetch(new URL(p, base))).json();
  const curriculum = await get("curriculum.json");
  const L1 = curriculum.levels.find(l => l.id === "level-1"), L2 = curriculum.levels.find(l => l.id === "level-2");
  const A = await get(L1.gate.content);
  const KEY = await get(A.key);
  const cells = DATASETS[A.dataset].cells, val = f => evaluate(f, cells).value;

  const stage = document.createElement("div");
  stage.style.cssText = "position:absolute;left:-10000px;top:0;width:1200px";
  document.body.append(stage);
  let keyLoads = 0; // total, for the "not fetched before a submission" check (sync tests only)
  const mount = (opts = {}) => {
    let myLoads = 0;
    const host = document.createElement("div"); stage.append(host);
    const store = opts.store || createProgressStore({ storage: null });
    if (opts.unlockL1 !== false && !store.isPassed("l0-checkpoint")) store.recordPass("l0-checkpoint");
    let t = 1_000_000;
    const ctrl = renderAssignment(host, { assignment: A, level: L1, store, locked: !!opts.locked, lockedReason: "Pass L0.", next: L2,
      hrefs: { level: "#/level-1", next: "#/level-2" }, loadKey: async () => { keyLoads++; myLoads++; return KEY; }, now: () => (t += 60_000) });
    store.subscribe(() => ctrl.update());
    return { host, store, loads: () => myLoads };
  };
  const fill = (host, answers) => { for (const [id, f] of Object.entries(answers)) { const el = host.querySelector(`[data-input="${id}"]`); el.value = f.replace(/^=/, ""); el.dispatchEvent(new Event("input", { bubbles: true })); } };
  const submit = host => host.querySelector("[data-tasks]").requestSubmit();
  const status = store => levelStates(curriculum.levels, id => store.isPassed(id)).map(x => x.status);
  const allRight = () => ({ ...KEY.solutions });
  const WRONG_BIG = '=COUNTIF(G2:G181,">=12")';
  const oneWrong = () => ({ ...KEY.solutions, "big-orders": WRONG_BIG });

  s.group("before submitting");
  s.test("brief + one formula box per task; no verdicts, no key", () => {
    const { host } = mount();
    eq(host.querySelectorAll(".task").length, A.tasks.length);
    assert(host.querySelector(".prose").textContent.includes("The brief"), "brief rendered");
    eq(host.querySelectorAll("[data-verdict]:not([hidden])").length, 0);
    assert(!host.querySelector("[data-show-key]"), "no key before a submission");
    eq(keyLoads, 0, "key file not even fetched");
  });
  s.test("running a task shows its result and lights the sheet, but not whether it's right", async () => {
    const { host } = mount();
    fill(host, { "total-region": KEY.solutions["total-region"] });
    host.querySelector('[data-run="total-region"]').click();
    // Highlights play in, in order; other tests run meanwhile, so wait for the playback rather than a fixed delay.
    const want = val('COUNTIF(D2:D181,"Macedonia")');
    for (let t = 0; t < 50 && host.querySelectorAll("td.cell--return").length < want; t++) await new Promise(r => setTimeout(r, 100));
    assert(host.querySelector('[data-value="total-region"]').textContent.includes(val(KEY.solutions["total-region"]).toLocaleString("en-US")), "result shown");
    eq(host.querySelectorAll("td.cell--return").length, val('COUNTIF(D2:D181,"Macedonia")'), "every Macedonia quantity highlighted");
    assert(host.querySelector('[data-verdict="total-region"]').hidden, "no verdict yet");
  });
  s.test("Enter inside a task runs it; it doesn't submit the assignment", () => {
    const { host, store } = mount();
    const el = host.querySelector('[data-input="orders-partner"]'); el.value = 'COUNTIF(F2:F181,"Partner")';
    el.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    assert(host.querySelector('[data-value="orders-partner"]').textContent.includes(String(val('COUNTIF(F2:F181,"Partner")'))), "ran");
    eq(host.querySelector("[data-result]").textContent, ""); eq(store.passedIds(), ["l0-checkpoint"]);
  });

  s.test("editing a task clears its old result; submitting shows results for exactly the graded formulas", () => {
    const { host } = mount();
    fill(host, { "rep-target": '=IF(COUNTIF(E2:E181,"Maria Ioannou")>=550,"Target met","Below target")' });
    host.querySelector('[data-run="rep-target"]').click();
    assert(host.querySelector('[data-value="rep-target"]').textContent.includes("Below target"), "old result shown");
    fill(host, { "rep-target": KEY.solutions["rep-target"] });
    eq(host.querySelector('[data-value="rep-target"]').textContent, "", "stale result cleared on edit");
    submit(host);
    assert(host.querySelector('[data-value="rep-target"]').textContent.includes("Target met"), "result matches the graded formula");
  });

  s.group("a wrong submission is rejected with specific feedback");
  s.test("7/8: not passed, Level 2 stays locked, nothing recorded", () => {
    const { host, store } = mount();
    fill(host, oneWrong()); submit(host);
    assert(host.querySelector("[data-result]").textContent.includes(`${A.tasks.length - 1}/${A.tasks.length}`) && host.querySelector("[data-result]").textContent.includes("Not passed"), "score + verdict");
    assert(!store.isPassed(A.id), "no pass");
    eq(status(store).slice(0, 3), ["complete", "open", "locked"]);
  });
  s.test("the wrong task says what it returned AND gives its own hint; right tasks are ticked", () => {
    const { host } = mount();
    fill(host, oneWrong()); submit(host);
    const v = host.querySelector('[data-verdict="big-orders"]').textContent;
    assert(v.includes(`returned ${val(WRONG_BIG)}`) && v.includes("More than 12"), v);
    assert(host.querySelector('[data-task="big-orders"]').classList.contains("is-fail"), "marked ✗");
    eq(host.querySelectorAll(".task.is-pass").length, A.tasks.length - 1);
    eq(document.activeElement, host.querySelector('[data-input="big-orders"]'), "focus jumps to the first wrong task");
  });
  s.test("a typed-in number is rejected even when it's the right number", () => {
    const { host } = mount();
    fill(host, { ...KEY.solutions, "total-region": `=${val(KEY.solutions["total-region"])}` }); submit(host);
    assert(host.querySelector('[data-verdict="total-region"]').textContent.includes("typed in"), "hard-code refused");
  });
  s.test("right number, wrong method → 'Right answer, but…'", () => {
    const { host } = mount();
    fill(host, { ...KEY.solutions, "total-region": `=G2*0+${val(KEY.solutions["total-region"])}` }); submit(host);
    const v = host.querySelector('[data-verdict="total-region"]').textContent;
    assert(v.includes("Right answer, but") && v.includes("SUMIF or SUMIFS"), v);
  });
  s.test("blank tasks are named, not silently skipped", () => {
    const { host } = mount(); submit(host);
    assert(host.querySelector('[data-verdict="total-region"]').textContent.includes("No formula yet"), "blank flagged");
    assert(host.querySelector("[data-result]").textContent.startsWith("0/"), "0 score");
  });

  s.group("passing unlocks Level 2");
  s.test("8/8 records the gate → Level 1 complete, Level 2 open; claim + link", () => {
    const { host, store } = mount();
    fill(host, allRight()); submit(host);
    const p = store.getPass(A.id);
    assert(p && p.score === A.tasks.length && p.assisted === false && p.submissions === 1, JSON.stringify(p));
    eq(status(store).slice(0, 3), ["complete", "complete", "open"]);
    assert(host.querySelector(".claim.is-earned").textContent.includes(L1.claimAfter), "level claim earned");
    assert(host.querySelector('[data-after] a[href="#/level-2"]'), "link to Level 2");
    assert(typeof p.seconds === "number" && p.seconds > 0, "time recorded");
  });
  s.test("fail, fix, resubmit: the pass records 2 attempts", () => {
    const { host, store } = mount();
    fill(host, oneWrong()); submit(host);
    fill(host, allRight()); submit(host);
    eq(store.getPass(A.id).submissions, 2);
  });
  s.test("a worse resubmission after passing never removes the pass", () => {
    const { host, store } = mount();
    fill(host, allRight()); submit(host); fill(host, oneWrong()); submit(host);
    assert(store.isPassed(A.id), "still passed");
  });

  s.group("answer key (no-cheese)");
  s.test("key offered only after a submission; opening it before passing → 'passed with help'", async () => {
    const { host, store, loads } = mount();
    fill(host, oneWrong()); submit(host);
    eq(loads(), 0, "not fetched by submitting");
    const btn = host.querySelector("[data-show-key]"); assert(btn, "offered after an attempt");
    assert(host.querySelector(".key-offer").textContent.includes("passed with help"), "warns first");
    btn.click(); await new Promise(r => setTimeout(r, 30));
    eq(loads(), 1, "key fetched only now");
    eq(host.querySelectorAll(".key__list li").length, A.tasks.length);
    fill(host, allRight()); submit(host);
    eq(store.getPass(A.id).assisted, true);
    assert(host.querySelector("[data-status]").textContent.includes("with help"), "status says so");
  });
  s.test("opening the key after passing doesn't change the pass", async () => {
    const { host, store } = mount();
    fill(host, allRight()); submit(host);
    host.querySelector("[data-show-key]").click(); await new Promise(r => setTimeout(r, 30));
    eq(store.getPass(A.id).assisted, false);
  });

  s.group("drafts & locking");
  s.test("answers, attempts and last verdicts survive a re-render (reload)", () => {
    const store = createProgressStore({ storage: null });
    const first = mount({ store }); fill(first.host, oneWrong()); submit(first.host);
    const second = mount({ store });
    eq(second.host.querySelector('[data-input="big-orders"]').value, WRONG_BIG.replace(/^=/, ""));
    assert(second.host.querySelector('[data-task="big-orders"]').classList.contains("is-fail"), "verdict restored");
    assert(second.host.querySelector("[data-status]").textContent.includes("1 submission"), "attempt count restored");
  });
  s.test("key opened before a reload still counts as help after it", async () => {
    const store = createProgressStore({ storage: null });
    const a = mount({ store }); fill(a.host, oneWrong()); submit(a.host);
    a.host.querySelector("[data-show-key]").click(); await new Promise(r => setTimeout(r, 30));
    const b = mount({ store }); fill(b.host, allRight()); submit(b.host);
    eq(store.getPass(A.id).assisted, true);
  });
  s.test("locked level: submit disabled, nothing recorded", () => {
    const { host, store } = mount({ locked: true, unlockL1: false });
    assert(host.querySelector('[data-tasks] button[type="submit"]').disabled, "disabled");
    fill(host, allRight()); submit(host);
    eq(store.passedIds(), []); assert(host.querySelector(".notice--locked"), "locked notice");
  });

  const summary = await s.report();
  stage.remove();
  return summary;
}
