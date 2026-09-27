/* workbench.dom.test.js: browser tests for the Level 3 components and their wiring,
   driven by the REAL Level 3 content (lessons + Assignment 3 + key).
   Runs from dev/test.html. In Node it only prints a skip notice. */
import { createWorkbench } from "./workbench.js";
import { renderLesson } from "./lesson.js";
import { renderAssignment } from "./assignment.js";
import { createProgressStore, levelStates } from "../progress.js";
import { drillTaskId } from "../content.js";
import { DATASETS } from "../data.js";
import { createSuite, eq, assert } from "../testkit.js";

export const done = run();

async function run() {
  if (typeof document === "undefined") { console.log("— workbench (DOM) —\nskipped in Node: open dev/test.html in a browser"); return null; }
  const s = createSuite("workbench (DOM)");
  const base = new URL("../../content/", import.meta.url);
  const get = async p => (await fetch(new URL(p, base))).json();
  const curriculum = await get("curriculum.json");
  const L3 = curriculum.levels.find(l => l.id === "level-3"), CAP = curriculum.levels.find(l => l.id === "capstone");
  const lessons = await Promise.all(L3.lessons.map(id => get(`lessons/${id}.json`)));
  const A = await get(L3.gate.content), KEY = await get(A.key);
  const M = DATASETS["aegean-messy"], C = DATASETS.aegean;

  const stage = document.createElement("div");
  stage.style.cssText = "position:absolute;left:-10000px;top:0;width:1200px";
  document.body.append(stage);
  const host = () => { const h = document.createElement("div"); stage.append(h); return h; };
  const click = (root, sel) => root.querySelector(sel).click();
  const setVal = (el, v) => { el.value = v; el.dispatchEvent(new Event("input", { bubbles: true })); el.dispatchEvent(new Event("change", { bubbles: true })); };
  const tool = (root, id) => click(root, `[data-tool="${id}"]`);
  const f = (root, name) => root.querySelector(`[data-panel] [data-f="${name}"]`);
  const msg = root => root.querySelector("[data-msg]").textContent;

  s.group("cleaning lab");
  s.test("renders the export with 182 rows, tools, and the green text-number corners", () => {
    const h = host(), wb = createWorkbench(h, { dataset: M, panels: ["cleaning"] });
    eq(h.querySelectorAll("[data-tool]").length, 7);
    eq(h.querySelectorAll("td.is-textnum").length, 2);
    assert(h.querySelector('td[data-cell="A183"]'), "last export row");
    eq(wb.submission().cleaning.fixed, []);
  });
  s.test("Remove Duplicates → message, history, audit; Undo reverts", () => {
    const h = host(), wb = createWorkbench(h, { dataset: M, panels: ["cleaning"] });
    tool(h, "dedupe"); click(h, "[data-apply]");
    assert(msg(h).startsWith("2 duplicate rows removed"), msg(h));
    eq(wb.submission().cleaning.fixed, ["dup-o1034", "dup-o1121"]);
    assert(h.querySelector("[data-history-sum]").textContent.includes("(1)"), "history");
    click(h, "[data-undo]"); eq(wb.submission().cleaning.fixed, []); eq(wb.cleaning.ops(), []);
  });
  s.test("Formula fill needs a target column; Test previews and highlights; errors change nothing", () => {
    const h = host(), wb = createWorkbench(h, { dataset: M, panels: ["cleaning"] });
    tool(h, "fill"); setVal(f(h, "formula"), "TRIM(PROPER(D2))"); click(h, "[data-apply]");
    assert(msg(h).includes("Choose the column"), msg(h));
    setVal(f(h, "row"), "13"); click(h, "[data-test]");
    assert(h.querySelector("[data-result]").textContent.includes('"Attica"'), h.querySelector("[data-result]").textContent);
    assert(h.querySelector("td.cell--return"), "source cell highlighted");
    setVal(f(h, "formula"), "VLOOKUP(E2,P2:R8,3,FALSE)"); f(h, "column").value = "D"; click(h, "[data-apply]");
    assert(msg(h).includes("#N/A") && msg(h).includes("nothing was filled"), msg(h));
    eq(wb.cleaning.ops(), []);
  });
  s.test("clicking an export cell opens Edit with its value; Enter applies", () => {
    const h = host(), wb = createWorkbench(h, { dataset: M, panels: ["cleaning"] });
    h.querySelector('td[data-cell="D59"]').click();
    eq(f(h, "cell").value, "D59"); eq(f(h, "value").value, "");
    setVal(f(h, "value"), "Macedonia"); click(h, "[data-apply]");
    assert(wb.submission().cleaning.fixed.includes("blank-region-o1057"), "fixed by typing");
  });
  s.test("a draft of moves is replayed on mount; a broken draft falls back to the raw export", () => {
    const wb = createWorkbench(host(), { dataset: M, panels: ["cleaning"], draft: { ops: [{ op: "dedupe" }, { op: "convert", column: "G" }] } });
    eq(wb.submission().cleaning.fixed.length, 4);
    const bad = createWorkbench(host(), { dataset: M, panels: ["cleaning"], draft: { ops: [{ op: "nope" }] } });
    eq(bad.cleaning.ops(), []);
  });
  s.test("locked: moves aren't applied", () => {
    const h = host(), wb = createWorkbench(h, { dataset: M, panels: ["cleaning"], locked: true });
    tool(h, "dedupe"); click(h, "[data-apply]"); eq(wb.cleaning.ops(), []); assert(msg(h).includes("locked"), msg(h));
  });

  s.group("pivot builder");
  s.test("clean-data lab: pivot is ready to use; fields build the table", () => {
    const h = host(), wb = createWorkbench(h, { dataset: C, panels: ["pivot"] });
    assert(h.querySelector("[data-insert-box]").hidden, "already inserted");
    setVal(h.querySelector('[data-k="rows"]'), "Region"); setVal(h.querySelector('[data-k="value"]'), "Revenue");
    eq([...h.querySelectorAll(".pivot__table tbody th")].map(x => x.textContent), ["Attica", "Crete", "Macedonia", "Peloponnese", "Thessaly", "Grand Total"]);
    eq(wb.submission().pivot.rows, "Region"); eq(wb.submission().pivot.stale, false);
  });
  s.test("OrderID in Values switches Sum to Count (Excel's default for text)", () => {
    const h = host(), wb = createWorkbench(h, { dataset: C, panels: ["pivot"] });
    setVal(h.querySelector('[data-k="rows"]'), "Rep"); setVal(h.querySelector('[data-k="value"]'), "OrderID");
    eq(wb.submission().pivot.agg, "count"); eq(wb.submission().pivot.totals["Grand Total"], 180);
  });
  s.test("filter checklist: untick items → the pivot shrinks; the field's items come from the data", () => {
    const h = host(), wb = createWorkbench(h, { dataset: C, panels: ["pivot"] });
    setVal(h.querySelector('[data-k="rows"]'), "Region"); setVal(h.querySelector('[data-k="value"]'), "Revenue");
    setVal(h.querySelector('[data-k="filterField"]'), "Channel");
    const boxes = [...h.querySelectorAll("[data-items-list] input")]; eq(boxes.map(b => b.value), ["Field", "Online", "Partner"]);
    boxes[0].checked = false; boxes[2].checked = false; boxes[0].dispatchEvent(new Event("change", { bubbles: true }));
    eq(wb.submission().pivot.filter, { field: "Channel", values: ["Online"] });
    assert(h.querySelector("[data-note]").textContent.includes("Filtered: Channel = Online"), "note");
  });
  s.test("THE GOTCHA: insert on the raw export, clean, and the pivot doesn't change until Refresh", () => {
    const h = host(), wb = createWorkbench(h, { dataset: M, panels: ["cleaning", "pivot"] });
    const pv = h.querySelector(".workbench__panel--pivot");
    assert(!pv.querySelector("[data-insert-box]").hidden, "not inserted yet");
    click(pv, "[data-insert]");
    setVal(pv.querySelector('[data-k="rows"]'), "Region"); setVal(pv.querySelector('[data-k="value"]'), "Revenue");
    const rows = () => [...pv.querySelectorAll(".pivot__table tbody th")].map(x => x.textContent);
    assert(rows().includes("(blank)"), rows().join());
    wb.cleaning.applySteps([{ op: "fill", formula: "=VLOOKUP(E2,$Q$2:$R$8,2,FALSE)", column: "D", scope: "blanks" }]);
    assert(rows().includes("(blank)"), "still the old snapshot"); eq(wb.submission().pivot.stale, true);
    click(pv, "[data-refresh]");
    assert(!rows().includes("(blank)"), "refreshed"); eq(wb.submission().pivot.stale, false);
  });
  s.test("a saved pivot comes back with its (stale) snapshot", () => {
    const draft = { ops: [{ op: "dedupe" }], pivot: { config: { rows: "Region", value: "Revenue", agg: "sum" }, inserted: true, cacheKey: "[]" } };
    const wb = createWorkbench(host(), { dataset: M, panels: ["cleaning", "pivot"], draft });
    eq(wb.submission().pivot.stale, true);
    const fresh = createWorkbench(host(), { dataset: M, panels: ["cleaning", "pivot"], draft: { ...draft, pivot: { ...draft.pivot, cacheKey: JSON.stringify(draft.ops) } } });
    eq(fresh.submission().pivot.stale, false);
  });

  s.group("chart & sentence");
  s.test("series come from the pivot; chart types draw; highlight is the one accent", () => {
    const h = host(), wb = createWorkbench(h, { dataset: C, panels: ["pivot", "chart"] });
    const pv = h.querySelector(".workbench__panel--pivot"), ch = h.querySelector(".workbench__panel--chart");
    setVal(pv.querySelector('[data-k="rows"]'), "Region"); setVal(pv.querySelector('[data-k="columns"]'), "Quarter"); setVal(pv.querySelector('[data-k="value"]'), "Revenue");
    eq([...ch.querySelectorAll('[data-s="series"] option')].map(o => o.textContent), ["Qtr1", "Qtr2", "Qtr3", "Qtr4", "Grand Total"]);
    for (const t of ["column", "bar", "line", "pie"]) { const r = ch.querySelector(`input[value="${t}"]`); r.checked = true; r.dispatchEvent(new Event("change", { bubbles: true })); assert(ch.querySelector("svg.chart"), t); }
    setVal(ch.querySelector('[data-s="highlight"]'), "Crete");
    eq(ch.querySelectorAll(".chart__mark.is-accent").length, 1);
    assert(ch.querySelector("svg.chart").getAttribute("aria-label").includes("Crete"), "accessible label lists the data");
    eq(wb.submission().story.chart, "pie");
  });
  s.test("typing in the title never re-renders the sentence (focus stays in the blank you're typing)", () => {
    const h = host(), wb = createWorkbench(h, { dataset: C, panels: ["pivot", "chart"], spec: { sentence: "{a} and {b}.", blanks: { a: { type: "number" }, b: { type: "number" } } } });
    const blank = h.querySelector('[data-blank="a"]');
    setVal(h.querySelector('[data-s="title"]'), "X leads");
    assert(h.querySelector('[data-blank="a"]') === blank, "same element");
    setVal(blank, "12"); eq(wb.submission().story.blanks.a, "12"); eq(wb.submission().story.title, "X leads");
  });

  s.group("Level 3 lessons (real content)");
  const L3pos = L3.lessons;
  const mount = (lesson, store = createProgressStore({ storage: null })) => {
    const h = host();
    const ctrl = renderLesson(h, { lesson, level: L3, order: lesson.order, total: L3pos.length, store, locked: false, hasGate: true, hrefs: { level: "#/level-3", lesson: n => `#/level-3/lesson-${n}`, gate: "#/level-3/assignment" } });
    store.subscribe(() => ctrl.update());
    return { h, store, ctrl, wb: ctrl.workbench };
  };
  const byId = id => lessons.find(l => l.id === id);
  s.test("every Level 3 lesson renders its workbench panels; no syntax section when it has none", () => {
    for (const l of lessons) {
      const { h } = mount(l);
      eq([...h.querySelectorAll(".workbench__panel")].map(x => [...x.classList].find(c => c.startsWith("workbench__panel--")).replace("workbench__panel--", "")), l.lab.panels);
      eq(!!h.querySelector("#syntax-h"), !!l.syntax, l.id);
    }
  });
  s.test("a formula drill is graded when you Test in the formula bar (count-dup)", () => {
    const l = byId("l3-duplicates-blanks"), { h, store, wb } = mount(l);
    assert(h.querySelector("[data-check]").hidden, "no Check button for a formula drill");
    wb.cleaning.test('=COUNTIF(A:A,"O1121")');
    assert(store.isPassed(drillTaskId(l, l.drills[0])), h.querySelector("[data-feedback]").textContent);
  });
  s.test("a cleaning drill: Check fails with the specific issue, passes after the move", () => {
    const l = byId("l3-duplicates-blanks"), { h, store, wb } = mount(l);
    h.querySelectorAll(".drill__dot")[2].click();
    assert(!h.querySelector("[data-check]").hidden, "Check shown");
    click(h, "[data-check]");
    assert(h.querySelector("[data-feedback]").textContent.includes("O1034 appears twice"), h.querySelector("[data-feedback]").textContent);
    eq(store.isPassed(drillTaskId(l, l.drills[2])), false);
    wb.cleaning.applySteps([{ op: "dedupe" }]); click(h, "[data-check]");
    assert(store.isPassed(drillTaskId(l, l.drills[2])), "passed");
  });
  s.test("revealing a workbench solution applies it, and the pass counts as solved with help", () => {
    const l = byId("l3-pivot-refresh"), { h, store } = mount(l);
    h.querySelectorAll(".drill__dot")[2].click();
    click(h, "[data-check]"); click(h, "[data-check]");
    const btn = h.querySelector("[data-solution]"); assert(!btn.hidden, "offered after 2 tries"); btn.click();
    eq(store.isPassed(drillTaskId(l, l.drills[2])), false, "revealing alone records nothing");
    click(h, "[data-check]");
    const p = store.getPass(drillTaskId(l, l.drills[2])); assert(p && p.assisted, JSON.stringify(p));
  });
  s.test("the worked pivot is only shown, never graded", () => {
    const l = byId("l3-pivot-build"), { h, store } = mount(l);
    click(h, "[data-run-worked]");
    eq(h.querySelector('[data-k="rows"]').value, "Region"); eq(store.passedIds(), []);
  });
  s.test("a chart drill with a sentence shows its blanks", () => {
    const l = byId("l3-story"), { h } = mount(l);
    h.querySelectorAll(".drill__dot")[2].click();
    eq(h.querySelectorAll("[data-blank]").length, 3);
    h.querySelectorAll(".drill__dot")[0].click();
    assert(h.querySelector("[data-sentence]").hidden, "no sentence for the trend drill");
  });

  s.group("Assignment 3 (real content)");
  const mountA = (store = createProgressStore({ storage: null })) => {
    for (const id of ["l0-checkpoint", "a1-sales-summary", "a2-enrich-orders"]) if (!store.isPassed(id)) store.recordPass(id);
    const h = host();
    let t = 1_000_000;
    const ctrl = renderAssignment(h, { assignment: A, level: L3, store, locked: false, next: CAP, hrefs: { level: "#/level-3", next: "#/capstone" }, loadKey: async () => KEY, now: () => (t += 60_000) });
    store.subscribe(() => ctrl.update());
    return { h, store, wb: ctrl.workbench };
  };
  const submit = h => h.querySelector("[data-tasks]").requestSubmit();
  const doKey = (wb, { refresh = true } = {}) => {
    wb.pivot.insert();
    for (const t of A.tasks) { const sol = KEY.solutions[t.id]; if (sol.steps) wb.cleaning.applySteps(sol.steps); }
    wb.pivot.setConfig(KEY.solutions.pivot.pivot, { source: "user" });
    if (refresh) wb.pivot.refresh();
    wb.story.setState({ ...KEY.solutions.chart.story, blanks: KEY.solutions.insight.story.blanks });
  };
  s.test("no formula boxes: all 8 tasks are checked from the workspace", () => {
    const { h } = mountA();
    eq(h.querySelectorAll(".task").length, 8); eq(h.querySelectorAll("[data-input]").length, 0);
    submit(h); assert(h.querySelector("[data-result]").textContent.startsWith("0/8"), h.querySelector("[data-result]").textContent);
  });
  s.test("the key's moves with a STALE pivot: 7/8, the pivot task says Refresh; capstone stays locked", () => {
    const { h, store, wb } = mountA(); doKey(wb, { refresh: false }); submit(h);
    assert(h.querySelector("[data-result]").textContent.includes("7/8"), h.querySelector("[data-result]").textContent);
    assert(h.querySelector('[data-verdict="pivot"]').textContent.includes("Refresh"), "refresh hint");
    eq(levelStates(curriculum.levels, id => store.isPassed(id)).at(-1).status, "locked");
  });
  s.test("the key's moves, refreshed: 8/8 → Level 3 complete, capstone open; draft survives a re-mount", () => {
    const store = createProgressStore({ storage: null });
    const { h, wb } = mountA(store); doKey(wb); submit(h);
    assert(h.querySelector("[data-result]").textContent.includes("8/8"), h.querySelector("[data-result]").textContent);
    eq(levelStates(curriculum.levels, id => store.isPassed(id)).map(x => x.status), ["complete", "complete", "complete", "complete", "open"]);
    eq(store.getPass(A.id).assisted, false);
    const again = mountA(store);
    eq(again.wb.cleaning.ops().length, wb.cleaning.ops().length); eq(again.wb.submission().pivot.stale, false);
    eq(again.wb.submission().story.blanks.top, "Macedonia");
  });

  const summary = await s.report();
  stage.remove();
  return summary;
}
