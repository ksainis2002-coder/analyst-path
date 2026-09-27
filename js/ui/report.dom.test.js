/* report.dom.test.js: the readiness report page, rendered from real content and a real progress store.
   Runs from dev/test.html. In Node it only prints a skip notice. */
import { buildReport, renderReport } from "./report.js";
import { createProgressStore } from "../progress.js";
import { drillTaskId } from "../content.js";
import { createSuite, eq, assert } from "../testkit.js";

export const done = run();
async function run() {
  if (typeof document === "undefined") { console.log("— report (DOM) —\nskipped in Node: open dev/test.html in a browser"); return null; }
  const s = createSuite("report (DOM)");
  const base = new URL("../../content/", import.meta.url);
  const get = async p => (await fetch(new URL(p, base))).json();
  const curriculum = await get("curriculum.json"), skills = await get("skills.json");
  const lessonsByLevel = Object.fromEntries(await Promise.all(curriculum.levels.filter(l => l.lessons.length).map(async l => [l.id, await Promise.all(l.lessons.map(id => get(`lessons/${id}.json`)))])));
  const stage = document.createElement("div"); stage.style.cssText = "position:absolute;left:-10000px;top:0;width:1200px"; document.body.append(stage);
  const mount = store => { const h = document.createElement("div"); stage.append(h);
    renderReport(h, { report: buildReport({ curriculum, lessonsByLevel, skills, cases: curriculum.cases, getPass: id => store.getPass(id), getDraft: id => store.getDraft(id) }), hrefs: { home: "#/", mock: "#/capstone/mock-test" } }); return h; };

  s.test("empty: 'Nothing demonstrated yet', no CV lines, the fallback line, 8 gaps", () => {
    const h = mount(createProgressStore({ storage: null }));
    assert(h.querySelector("[data-verdict]").textContent.includes("Nothing demonstrated yet"), "verdict");
    eq(h.querySelectorAll("[data-cv] li").length, 0); assert(h.querySelector("[data-cv-fallback]"), "fallback");
    eq(h.querySelectorAll("[data-gaps] > li").length, skills.skills.length);
  });
  s.test("solo vs with help vs simulated are three different things on the page", () => {
    const st = createProgressStore({ storage: null });
    st.recordPass("l0-checkpoint", { assisted: false }); st.recordPass("a1-sales-summary", { assisted: true }); st.recordPass("a2-enrich-orders", { source: "dev" });
    const l = lessonsByLevel["level-1"][0]; st.recordPass(drillTaskId(l, l.drills[0]), { assisted: true });
    const h = mount(st);
    eq([...h.querySelectorAll("[data-solo] > li")].map(x => x.dataset.skill), ["sheet-basics"]);
    eq([...h.querySelectorAll("[data-helped] > li")].map(x => x.dataset.skill), ["aggregates"]);
    assert(h.querySelector('[data-helped] [data-skill="aggregates"]').textContent.includes("with help"), "labelled with help");
    assert(h.querySelector('[data-gaps] [data-skill="lookups"]').textContent.includes("Simulated"), "simulated shown as not counted");
    assert(h.querySelector("[data-simulated]").textContent.includes("1 pass was simulated"), "notice");
    eq([...h.querySelectorAll("[data-cv] li")].map(x => x.textContent), [skills.skills[0].claim]);
    assert(h.querySelector('[data-level="level-1"]').textContent.includes("1 with help"), "drill help counted");
  });
  s.test("the copy text holds exactly the CV lines", () => {
    const st = createProgressStore({ storage: null }); st.recordPass("l0-checkpoint", { assisted: false }); st.recordPass("a1-sales-summary", { assisted: false });
    const h = mount(st);
    eq(h.querySelector("[data-cv-text]").value, `• ${skills.skills[0].claim}\n• ${skills.skills[1].claim}`);
  });
  s.test("capstone section lists attempts from the mock test's record", () => {
    const st = createProgressStore({ storage: null });
    st.setDraft("mock-test", { attempts: [{ n: 1, variant: "A", score: 6, total: 10, seconds: 2700, passed: false, auto: true, submittedAt: 1 }], current: null, keysSeen: [] });
    const h = mount(st); const c = h.querySelector("[data-capstone]").textContent;
    assert(c.includes("Not passed yet") && c.includes("6/10") && c.includes("time ran out"), c);
  });
  const summary = await s.report(); stage.remove(); return summary;
}
