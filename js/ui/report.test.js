/* report.test.js: the readiness report never overstates (spec §3, §13).
   Run with `node js/ui/report.test.js`. Uses the REAL curriculum, lessons and skill map,
   and a real progress store, driven into specific states. */
import { readFileSync } from "node:fs";
import { buildReport, evidenceState } from "./report.js";
import { createProgressStore } from "../progress.js";
import { validateSkills, drillTaskId, checkpointTaskId } from "../content.js";
import { createSuite, eq, assert } from "../testkit.js";

const root = new URL("../../content/", import.meta.url);
const J = p => JSON.parse(readFileSync(new URL(p, root), "utf8"));
const curriculum = J("curriculum.json"), skills = J("skills.json");
const lessonsByLevel = Object.fromEntries(curriculum.levels.filter(l => l.lessons.length).map(l => [l.id, l.lessons.map(id => J(`lessons/${id}.json`))]));
const s = createSuite("readiness report");
const report = (store, now = 1_700_000_000_000) => buildReport({ curriculum, lessonsByLevel, skills, cases: curriculum.cases, getPass: id => store.getPass(id), getDraft: id => store.getDraft(id), now });
const fresh = () => createProgressStore({ storage: null, now: () => 1_700_000_000_000 });
const GATES = curriculum.levels.map(l => l.gate.taskId);
const ids = r => r.map(x => x.id);

s.group("the skill map (content/skills.json)");
s.test("valid against the curriculum: every evidence can be passed, every gate and case proves some skill", () => eq(validateSkills(skills, curriculum), []));
s.test("the validator catches evidence that can't be passed and lessons that don't exist", () => {
  const bad = { ...skills, skills: [{ ...skills.skills[0], evidence: "nope", practice: ["missing-lesson"] }, ...skills.skills.slice(1)] };
  const p = validateSkills(bad, curriculum); assert(p.some(x => x.includes('"nope"')) && p.some(x => x.includes("missing-lesson")), p.join("; "));
});

s.group("evidence states");
s.test("none · simulated (test-seeded) · helped · solo", () => {
  eq([evidenceState(null), evidenceState({ source: "dev" }), evidenceState({ assisted: true }), evidenceState({ assisted: false }), evidenceState({})], ["none", "simulated", "helped", "solo", "solo"]);
  eq(evidenceState({ source: "dev", assisted: false }), "simulated", "dev is never evidence, whatever else it says");
});

s.group("scenarios");
s.test("nothing done: nothing claimed, every skill a gap, the honest fallback line", () => {
  const r = report(fresh());
  eq([r.verdict.key, r.solo.length, r.helped.length, r.gaps.length, r.cvLines], ["not-started", 0, 0, skills.skills.length, []]);
  assert(r.fallback.includes("building"), r.fallback);
});
s.test("every gate simulated (test-seeded): still nothing demonstrated, and the report says how many were simulated", () => {
  const st = fresh(); GATES.forEach(id => st.recordPass(id, { source: "dev" })); st.recordPass("case-a", { source: "dev" });
  const r = report(st);
  eq([r.verdict.key, r.solo.length, r.cvLines.length, r.simulatedCount], ["not-started", 0, 0, GATES.length + 1]);
  assert(r.gaps.every(g => g.state === "simulated"), "all simulated");
  eq(r.levels.map(l => l.status), ["open", "locked", "locked", "locked", "locked"]); // simulated passes don't open levels in the report's eyes
});
s.test("L0 and A1 solo, A2 with help: two claims; lookups listed as 'with help' and kept out of the CV lines", () => {
  const st = fresh(); st.recordPass("l0-checkpoint", { score: 5 }); st.recordPass("a1-sales-summary", { score: 8, total: 8, submissions: 2, seconds: 900, assisted: false }); st.recordPass("a2-enrich-orders", { score: 8, total: 8, assisted: true });
  const r = report(st);
  eq(ids(r.solo), ["sheet-basics", "aggregates"]); eq(ids(r.helped), ["lookups"]);
  eq(r.cvLines, [skills.skills[0].claim, skills.skills[1].claim]);
  assert(!r.cvLines.some(l => /VLOOKUP|INDEX/.test(l)), "no lookup claim");
  eq(r.verdict.key, "in-progress"); assert(r.verdict.headline.includes("2 of 4 levels"), r.verdict.headline);
});
s.test("practice alone never demonstrates: every Level 1 drill and checkpoint done, A1 not passed → still a gap", () => {
  const st = fresh(); st.recordPass("l0-checkpoint");
  for (const l of lessonsByLevel["level-1"]) { l.drills.forEach(d => st.recordPass(drillTaskId(l, d), { assisted: false })); st.recordPass(checkpointTaskId(l)); }
  const r = report(st), agg = r.skills.find(x => x.id === "aggregates");
  eq(agg.state, "none"); assert(ids(r.gaps).includes("aggregates"), "gap");
  eq([agg.practice.drillsSolo, agg.practice.drillsTotal, agg.practice.checkpointsPassed], [agg.practice.drillsTotal, lessonsByLevel["level-1"].reduce((n, l) => n + l.drills.length, 0), 5]);
  assert(r.levels[1].lessons.every(l => l.complete), "lessons complete as practice");
});
s.test("drills solved with help are counted apart from drills solved alone", () => {
  const st = fresh(), l = lessonsByLevel["level-2"][0];
  st.recordPass(drillTaskId(l, l.drills[0]), { assisted: true }); st.recordPass(drillTaskId(l, l.drills[1]), { assisted: false });
  const r = report(st), lv = r.levels.find(x => x.id === "level-2"), ls = lv.lessons[0];
  eq([ls.drillsSolo, ls.drillsHelped, lv.drillsSolo, lv.drillsHelped, r.totals.drillsSolo, r.totals.drillsHelped], [1, 1, 1, 1, 1, 1]);
});
s.test("a drill re-solved alone after 'with help' moves to 'alone'", () => {
  const st = fresh(), l = lessonsByLevel["level-1"][0], id = drillTaskId(l, l.drills[0]);
  st.recordPass(id, { assisted: true }); eq(report(st).totals.drillsHelped, 1);
  st.recordPass(id, { assisted: false }); eq([report(st).totals.drillsHelped, report(st).totals.drillsSolo], [0, 1]);
});
s.test("A3 solo proves cleaning, pivots and story; Case A proves end-to-end", () => {
  const st = fresh(); st.recordPass("a3-messy-export", { assisted: false }); st.recordPass("case-a", { assisted: false });
  eq(ids(report(st).solo), ["cleaning", "pivots", "story", "end-to-end"]);
});
s.test("mock test with help: 'nearly'; the timed claim is NOT in the CV lines; passing cold later upgrades it", () => {
  const st = fresh(); let t = 1_000; const st2 = createProgressStore({ storage: null, now: () => t });
  GATES.slice(0, 4).forEach(id => st2.recordPass(id, { assisted: false }));
  st2.recordPass("mock-test", { score: 9, total: 10, seconds: 2400, variant: "A", submissions: 3, assisted: true });
  let r = report(st2);
  eq(r.verdict.key, "ready-with-help"); assert(ids(r.helped).includes("timed") && !r.cvLines.some(l => l.includes("timed")), "not claimed");
  t = 2_000; st2.recordPass("mock-test", { score: 10, total: 10, seconds: 1800, variant: "B", submissions: 4, assisted: false });
  r = report(st2);
  eq(r.verdict.key, "ready"); assert(r.cvLines.some(l => l.includes("timed")), "now claimed");
  const timed = r.skills.find(x => x.id === "timed"); eq([timed.state, timed.afterHelp], ["solo", true]);
  void st;
});
s.test("capstone attempts come from the test's own record; best = a pass, without help, then score, then time", () => {
  const st = fresh();
  st.setDraft("mock-test", { attempts: [{ n: 1, variant: "A", score: 7, total: 10, seconds: 2700, passed: false, auto: true, submittedAt: 1 }, { n: 2, variant: "B", score: 8, total: 10, seconds: 2000, passed: true, submittedAt: 2 }, { n: 3, variant: "A", score: 10, total: 10, seconds: 2500, passed: true, assisted: true, submittedAt: 3 }], current: null, keysSeen: ["A"] });
  const c = report(st).capstone; eq(c.attempts.length, 3); eq([c.best.n, c.best.score], [2, 8], "a pass without help beats a higher score with help");
  eq(c.state, "none", "a draft is effort, not a pass: the gate itself wasn't recorded here");
});
s.test("between equal passes, the one without help is 'best'", () => {
  const st = fresh();
  st.setDraft("mock-test", { attempts: [{ n: 1, variant: "A", score: 10, total: 10, seconds: 900, passed: true, assisted: true, submittedAt: 1 }, { n: 2, variant: "B", score: 10, total: 10, seconds: 900, passed: true, assisted: false, submittedAt: 2 }] });
  eq(report(st).capstone.best.n, 2);
});
s.test("unknown or stale ids in the store are ignored", () => {
  const st = fresh(); st.recordPass("l9-nonsense"); st.recordPass("old-v1-stage-3");
  const r = report(st); eq(r.solo.length, 0); eq(r.simulatedCount, 0);
});

s.group("never overstates (property test over random progress)");
s.test("600 random progress states: every CV line is backed by a genuine, unassisted pass of its evidence", () => {
  let seed = 7; const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
  const evidence = [...GATES, "case-a"];
  for (let k = 0; k < 600; k++) {
    const st = fresh(), truth = {};
    for (const id of evidence) {
      const x = rnd();
      if (x < 0.25) continue;
      const detail = x < 0.45 ? { source: "dev" } : x < 0.7 ? { assisted: true } : { assisted: false };
      st.recordPass(id, detail); truth[id] = detail;
      if (detail.assisted && rnd() < 0.3) { st.recordPass(id, { assisted: false }); truth[id] = { assisted: false }; }
    }
    const r = report(st);
    const allowed = new Set(skills.skills.filter(sk => truth[sk.evidence] && !truth[sk.evidence].source && truth[sk.evidence].assisted === false).map(sk => sk.claim));
    for (const line of r.cvLines) assert(allowed.has(line), `overstated: ${line} (state ${JSON.stringify(truth)})`);
    eq(r.cvLines.length, allowed.size, "and nothing genuinely earned is left out");
    for (const h of r.helped) assert(!r.cvLines.includes(h.claim), "a with-help skill in the CV lines");
    if (r.verdict.key === "ready") assert(truth["mock-test"]?.assisted === false && !truth["mock-test"].source, "ready without a cold mock pass");
  }
});

export const done = s.report();
