/* =========================================================================
   content.js: loads and validates course content (spec §5.2, §5.3)
   -------------------------------------------------------------------------
   Content is DATA. Every lesson is content/lessons/<id>.json, listed by id in
   content/curriculum.json → levels[].lessons. A level's gate (checkpoint or
   assignment) points at its file with gate.content. Adding a lesson means
   adding a JSON file and its id. No code changes.

   LESSON SCHEMA (spec §5.3, with the fields this build adds marked +):
   {
     "id": "l1-sumifs",               slug, unique across the course
     "level": 1, "order": 3,          must match its place in curriculum.json
     "title": "…", "estMinutes": 12,
     "dataset": "v1-sample",          + which data.js dataset the console loads
     "concept": "markdown",           what it does and WHEN to reach for it
     "syntax": { "signature": "=SUMIFS(sum_range, range1, criteria1, …)",
                 "args": [{ "name": "sum_range", "desc": "…" }] }   (or an array of these)
     "worked": { "prompt": "…", "formula": "=…", "explain": "markdown", "expect": 74 },   + expect is test-checked
     "mistakes": ["markdown", …],
     "drills": [{
        "id": "north-total",          + unique within the lesson; progress id is "<lesson>:<drill>"
        "ask": "markdown", "starter": "",
        "answerCheck": { "type": "value", "expect": 74 } | [ …checks… ],   (see grader.js)
        "hint": "markdown",           + shown when the answer is wrong (spec §8: specific hints)
        "solution": "=SUMIFS(…)"      + test-verified; shown only after 2 wrong tries
     }],
     "checkpoint": { "type": "quiz", "passMark": 2, "questions": [QUESTION…] },
     "claimAfter": "…", "notYet": "…"
   }
   + LEVEL 3 WORKBENCH LESSONS (ui/workbench.js): "lab": { "panels": ["cleaning" | "pivot" | "chart", …] }
     replaces the console with the cleaning lab / pivot builder / chart. Then:
       syntax is optional; worked has a formula (tried in the cleaning lab's formula bar)
       or a pivot config ("pivot": {…}, plus "story" for a chart);
       a drill whose checks are value/formula-uses is graded when you Test a formula;
       any other drill is graded when you press Check;
       solution is a formula, or { steps: [cleaning moves], pivot: {…}, story: {…}, explain };
       "story": { "sentence": "In Q4, {top} …", "blanks": { top: { type: "choice", options: […] } | { type: "number" } } }
         is the insight sentence a chart drill asks for.
     Assignments can have a "lab" too; their key solutions may then be objects.

   MOCK TEST (Phase 7): content/assignments/mock-test.json
   { "id": "mock-test", "kind": "mock-test", "level": null, "title", "intro", "minutes": 45, "passMark": 8,
     "dataset": "aegean-messy", "lab": {…}, "key": "assignments/mock-test.key.json",
     "pool": [TASK + { "slot": "sumifs", "dataset"?: "aegean" }],      a task's own dataset overrides the test's
     "variants": [{ "id": "A", "label", "tasks": [poolTaskId, …] }] }  one task per slot; every variant covers the same slots
   CASE STUDY (Phase 7): content/cases/<id>.json, listed in curriculum.json → cases[]
   { "id", "kind": "case", "title", "intro", "estMinutes", "requires", "dataset", "lab",
     "steps": [{ "id", "title", "ask", "answerCheck", "hint", "solution", "story"? }], "claimAfter" }
     A formula step runs against the learner's CURRENT working data; its solution may use {row:O1088}
     for "the row that order is on now".
   QUESTION: { "id", "prompt", "options": [..], "answer": <index>, "explain", "hint"?,
               "verify"?: "=FORMULA" (+ the test checks options[answer] equals what the engine returns) }

   GATE SCHEMAS: content/assignments/<id>.json  (id = the level's gate.taskId)
   checkpoint: { "id": "l0-checkpoint", "kind": "checkpoint", "level": 0, "title", "intro",
                 "passMark": 4, "questions": [QUESTION…] }
   assignment: { "id": "a1-sales-summary", "kind": "assignment", "level": 1, "title",
                 "intro": "markdown brief", "dataset": "v1-sample", "passMark": 8,
                 "key": "assignments/a1-sales-summary.key.json",
                 "tasks": [{ "id", "ask": "markdown", "answerCheck": …, "hint": "markdown" }] }
     No solutions in the task file. They live in the key file, which the app
     fetches only after a submission attempt (spec §8 no-cheese):
     { "id": "a1-sales-summary", "solutions": { taskId: "=…" }, "explain": { taskId: "markdown" } }
   ========================================================================= */

import { DATASETS, formatAs, formatOf } from "./data.js";
import { CHECK_TYPES } from "./grader.js";
import { evaluate } from "./engine.js";

/* ---------- live numbers in prose: {{=FORMULA}} ----------
   Any text field may contain {{=SUMIFS(G2:G181,D2:D181,"Attica")}}. When content
   loads, the token is replaced by the engine's result on that content's dataset,
   so a number quoted in prose can never drift from the data. Formula fields
   (formula, solution, starter, verify, answerCheck, key solutions) are never touched.
   The content tests fail if any template errors. */
const TEMPLATE = /\{\{=([^{}]+)\}\}/g;
const NO_TEMPLATE_KEYS = new Set(["formula", "solution", "starter", "verify", "answerCheck", "solutions", "id", "dataset", "key", "pivot", "steps"]);
export function templateValue(formula, dataset) {
  const r = evaluate(formula, dataset.cells);
  if (!r.ok) return { ok: false, text: `[${r.error.code || "error"} in {{=${formula}}}]`, error: r.error };
  const fmt = r.ref ? formatOf(dataset, r.ref) : null;
  const pretty = fmt ? formatAs(r.value, fmt) : null;
  const text = pretty ?? (typeof r.value === "number" ? r.value.toLocaleString("en-US", { maximumFractionDigits: 2 }) : String(r.value));
  return { ok: true, text };
}
/** Returns a deep copy of `obj` with every {{=…}} in its text fields replaced by live values. */
export function resolveTemplates(obj, dataset) {
  if (!dataset) return obj;
  const walk = (v, key) => {
    if (typeof v === "string") return NO_TEMPLATE_KEYS.has(key) ? v : v.replace(TEMPLATE, (_, f) => templateValue(f, dataset).text);
    if (Array.isArray(v)) return v.map(x => walk(x, key));
    if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, NO_TEMPLATE_KEYS.has(k) && k !== "solutions" ? x : walk(x, k)]));
    return v;
  };
  return walk(obj, "");
}
/** Every {{=…}} template in an object (for tests). */
export function findTemplates(obj, out = []) {
  if (typeof obj === "string") { for (const m of obj.matchAll(TEMPLATE)) out.push(m[1]); }
  else if (Array.isArray(obj)) obj.forEach(x => findTemplates(x, out));
  else if (obj && typeof obj === "object") for (const [k, v] of Object.entries(obj)) if (!NO_TEMPLATE_KEYS.has(k) || k === "solutions") findTemplates(k === "solutions" ? [] : v, out);
  return out;
}

const SLUG = /^[a-z0-9][a-z0-9-]*$/;
const isStr = v => typeof v === "string" && v.trim().length > 0;

export function validateQuestions(questions, where, problems) {
  if (!Array.isArray(questions) || questions.length === 0) { problems.push(`${where}.questions must be a non-empty array`); return; }
  const ids = new Set();
  questions.forEach((q, i) => {
    const w = `${where}.questions[${i}]`;
    if (!SLUG.test(q.id || "")) problems.push(`${w}.id must be a slug`);
    if (ids.has(q.id)) problems.push(`${w}.id "${q.id}" is duplicated`); ids.add(q.id);
    if (!isStr(q.prompt)) problems.push(`${w}.prompt is required`);
    if (!Array.isArray(q.options) || q.options.length < 2 || !q.options.every(isStr)) problems.push(`${w}.options needs 2+ non-empty strings`);
    else if (new Set(q.options).size !== q.options.length) problems.push(`${w}.options has duplicates`);
    if (!Number.isInteger(q.answer) || q.answer < 0 || q.answer >= (q.options?.length || 0)) problems.push(`${w}.answer must index an option`);
    if (!isStr(q.explain)) problems.push(`${w}.explain is required (spec §8: explain, don't just mark)`);
  });
}

function validateChecks(check, where, problems) {
  const list = Array.isArray(check) ? check : [check];
  if (!list.length) problems.push(`${where} is empty`);
  list.forEach((c, i) => {
    if (!c || !CHECK_TYPES.includes(c.type)) problems.push(`${where}[${i}].type must be one of ${CHECK_TYPES.join(", ")} (got "${c?.type}")`);
    if (c?.type === "value" && !("expect" in c)) problems.push(`${where}[${i}] needs "expect"`);
    if (c?.type === "formula-uses" && !(c.functions?.length || c.oneOf?.length || c.absolute?.length || c.refs?.length || c.lockedRanges?.length || c.exactMatch)) problems.push(`${where}[${i}] needs "functions", "oneOf", "absolute", "refs", "lockedRanges" or "exactMatch"`);
    if (c?.type === "pivot-state" && !(c.expect && Object.keys(c.expect).length)) problems.push(`${where}[${i}] needs "expect" (the pivot layout)`);
    if (c?.type === "cleaning-done" && !(Array.isArray(c.defects) && c.defects.length)) problems.push(`${where}[${i}] needs "defects"`);
    if (c?.type === "timed" && !(c.maxSeconds > 0)) problems.push(`${where}[${i}] needs a positive "maxSeconds"`);
    if (c?.type === "story" && !(c.series || c.chart?.length || c.titleMentions?.length || (c.blanks && Object.keys(c.blanks).length))) problems.push(`${where}[${i}] needs "series", "chart", "titleMentions" or "blanks"`);
  });
}
const PANELS = ["cleaning", "pivot", "chart"];
const FORMULA_CHECKS = new Set(["value", "formula-uses"]);
const isFormulaCheck = check => (Array.isArray(check) ? check : [check]).every(c => FORMULA_CHECKS.has(c?.type));
function validateLab(lab, dataset, where, p) {
  if (lab === undefined) return;
  if (!lab || !Array.isArray(lab.panels) || !lab.panels.length || !lab.panels.every(x => PANELS.includes(x)) || new Set(lab.panels).size !== lab.panels.length) { p.push(`${where}: lab.panels must list some of ${PANELS.join(", ")}`); return; }
  if (lab.panels.includes("chart") && !lab.panels.includes("pivot")) p.push(`${where}: a chart needs a pivot (PivotChart), so "chart" needs "pivot"`);
  if (lab.panels.includes("cleaning") && !DATASETS[dataset]?.orders) p.push(`${where}: the cleaning lab needs a dataset with an export to clean (e.g. "aegean-messy")`);
}
function validateStorySpec(st, where, p) {
  if (st === undefined) return;
  if (!st || !isStr(st.sentence)) { p.push(`${where}.story.sentence is required`); return; }
  const names = [...st.sentence.matchAll(/\{([a-z][a-zA-Z0-9]*)\}/g)].map(m => m[1]);
  if (!names.length) p.push(`${where}.story.sentence has no {blanks}`);
  for (const n of names) {
    const b = st.blanks?.[n];
    if (!b || !["choice", "number"].includes(b.type)) p.push(`${where}.story.blanks.${n} needs type "choice" or "number"`);
    else if (b.type === "choice" && !(Array.isArray(b.options) && b.options.length >= 2)) p.push(`${where}.story.blanks.${n} needs 2+ options`);
  }
}
function validateSolution(sol, check, lab, where, p) {
  if (isFormulaCheck(check)) { if (!isStr(sol)) p.push(`${where}.solution must be a formula (every drill answer is test-verified)`); return; }
  if (!lab) { p.push(`${where}: a ${[].concat(check).map(c => c.type).join("+")} check needs a lesson "lab" (cleaning / pivot / chart)`); return; }
  if (!sol || typeof sol !== "object" || !(Array.isArray(sol.steps) || sol.pivot || sol.story)) p.push(`${where}.solution must be { steps | pivot | story } for a workbench drill`);
}

/** Returns a list of problems (empty = valid). */
export function validateLesson(l, { level, order } = {}) {
  const p = [];
  if (!l || typeof l !== "object") return ["lesson is not an object"];
  const w = `lesson "${l.id}"`;
  if (!SLUG.test(l.id || "")) p.push(`${w}: id must be a slug`);
  if (level !== undefined && l.level !== level) p.push(`${w}: level is ${l.level} but it's listed under level ${level}`);
  if (order !== undefined && l.order !== order) p.push(`${w}: order is ${l.order} but it's lesson ${order} in curriculum.json`);
  for (const k of ["title", "concept", "claimAfter", "notYet"]) if (!isStr(l[k])) p.push(`${w}: "${k}" is required`);
  if (!(l.estMinutes > 0)) p.push(`${w}: estMinutes must be a positive number`);
  if (!DATASETS[l.dataset]) p.push(`${w}: dataset "${l.dataset}" isn't in data.js DATASETS`);
  validateLab(l.lab, l.dataset, w, p);
  const syn = l.syntax === undefined && l.lab ? [] : Array.isArray(l.syntax) ? l.syntax : [l.syntax];
  syn.forEach((s, i) => {
    if (!s || !isStr(s.signature)) p.push(`${w}: syntax[${i}].signature is required`);
    if (s && s.args && !(Array.isArray(s.args) && s.args.every(a => isStr(a.name) && isStr(a.desc)))) p.push(`${w}: syntax[${i}].args must be [{name, desc}]`);
  });
  if (!l.worked || !isStr(l.worked.prompt) || !isStr(l.worked.explain)) p.push(`${w}: worked needs prompt and explain`);
  else if (!l.lab && !isStr(l.worked.formula)) p.push(`${w}: worked needs a formula`);
  else if (l.lab && !isStr(l.worked.formula) && !l.worked.pivot) p.push(`${w}: worked needs a formula or a pivot`);
  if (!Array.isArray(l.mistakes) || !l.mistakes.every(isStr)) p.push(`${w}: mistakes must be an array of strings`);
  if (!Array.isArray(l.drills)) p.push(`${w}: drills must be an array`);
  else {
    const ids = new Set();
    l.drills.forEach((d, i) => {
      const dw = `${w} drills[${i}]`;
      if (!SLUG.test(d.id || "")) p.push(`${dw}.id must be a slug`);
      if (ids.has(d.id)) p.push(`${dw}.id "${d.id}" is duplicated`); ids.add(d.id);
      if (!isStr(d.ask)) p.push(`${dw}.ask is required`);
      if (!isStr(d.hint)) p.push(`${dw}.hint is required (spec §8: specific hints)`);
      validateChecks(d.answerCheck, `${dw}.answerCheck`, p);
      validateSolution(d.solution, d.answerCheck, l.lab, dw, p);
      validateStorySpec(d.story, dw, p);
    });
  }
  if (l.checkpoint) {
    if (l.checkpoint.type !== "quiz") p.push(`${w}: checkpoint.type must be "quiz"`);
    validateQuestions(l.checkpoint.questions, `${w}: checkpoint`, p);
    const pm = l.checkpoint.passMark ?? l.checkpoint.questions?.length;
    if (!(pm >= 1 && pm <= (l.checkpoint.questions?.length || 0))) p.push(`${w}: checkpoint.passMark out of range`);
  }
  return p;
}

export function validateGate(g, { taskId, level } = {}) {
  const p = [];
  if (!g || typeof g !== "object") return ["gate content is not an object"];
  const w = `gate "${g.id}"`;
  if (taskId !== undefined && g.id !== taskId) p.push(`${w}: id must equal the level's gate.taskId "${taskId}"`);
  if (level !== undefined && g.level !== level) p.push(`${w}: level is ${g.level}, expected ${level}`);
  for (const k of ["title", "intro"]) if (!isStr(g[k])) p.push(`${w}: "${k}" is required`);
  if (g.kind === "checkpoint") {
    if (g.dataset !== undefined && !DATASETS[g.dataset]) p.push(`${w}: dataset "${g.dataset}" isn't in data.js DATASETS`);
    validateQuestions(g.questions, w, p);
    if (!(g.passMark >= 1 && g.passMark <= (g.questions?.length || 0))) p.push(`${w}: passMark out of range`);
  } else if (g.kind === "assignment") {
    if (!DATASETS[g.dataset]) p.push(`${w}: dataset "${g.dataset}" isn't in data.js DATASETS`);
    validateLab(g.lab, g.dataset, w, p);
    if (!isStr(g.key) || !/^assignments\/[a-z0-9-]+\.key\.json$/.test(g.key)) p.push(`${w}: "key" must be "assignments/<id>.key.json" (answers live apart from the tasks: spec §8 no-cheese)`);
    if (!Array.isArray(g.tasks) || g.tasks.length === 0) p.push(`${w}: tasks must be a non-empty array`);
    else {
      const ids = new Set();
      g.tasks.forEach((t, i) => {
        const tw = `${w} tasks[${i}]`;
        if (!SLUG.test(t.id || "")) p.push(`${tw}.id must be a slug`);
        if (ids.has(t.id)) p.push(`${tw}.id "${t.id}" is duplicated`); ids.add(t.id);
        if (!isStr(t.ask)) p.push(`${tw}.ask is required`);
        if (!isStr(t.hint)) p.push(`${tw}.hint is required (spec §8: specific feedback)`);
        if ("solution" in t) p.push(`${tw} must not contain its solution. It belongs in the key file`);
        validateChecks(t.answerCheck, `${tw}.answerCheck`, p);
        if (!isFormulaCheck(t.answerCheck) && !g.lab) p.push(`${tw}: a ${[].concat(t.answerCheck).map(c => c.type).join("+")} task needs the assignment's "lab"`);
        validateStorySpec(t.story, tw, p);
      });
    }
    const pm = g.passMark ?? g.tasks?.length;
    if (!(pm >= 1 && pm <= (g.tasks?.length || 0))) p.push(`${w}: passMark out of range`);
  } else if (g.kind === "mock-test") {
    if (!DATASETS[g.dataset]) p.push(`${w}: dataset "${g.dataset}" isn't in data.js DATASETS`);
    validateLab(g.lab, g.dataset, w, p);
    if (!(g.minutes > 0)) p.push(`${w}: minutes must be a positive number`);
    if (!isStr(g.key) || !/^assignments\/[a-z0-9-]+\.key\.json$/.test(g.key)) p.push(`${w}: "key" must be "assignments/<id>.key.json"`);
    validateTasks(g, g.pool, `${w} pool`, p);
    const byId = new Map((g.pool || []).map(t => [t.id, t]));
    for (const t of g.pool || []) {
      if (!SLUG.test(t.slot || "")) p.push(`${w} pool "${t.id}": needs a "slot" (the skill it tests)`);
      if (t.dataset !== undefined && !DATASETS[t.dataset]) p.push(`${w} pool "${t.id}": dataset "${t.dataset}" isn't in DATASETS`);
    }
    if (!Array.isArray(g.variants) || g.variants.length < 2) p.push(`${w}: needs at least 2 variants (spec §7: retake without memorising)`);
    const slotSets = [];
    (g.variants || []).forEach((v, i) => {
      const vw = `${w} variants[${i}]`;
      if (!isStr(v.id) || !isStr(v.label)) p.push(`${vw} needs id and label`);
      if (!Array.isArray(v.tasks) || v.tasks.length < 8 || v.tasks.length > 10) p.push(`${vw}: 8–10 tasks (spec §7)`);
      const missing = (v.tasks || []).filter(id => !byId.has(id)); if (missing.length) p.push(`${vw}: unknown pool tasks ${missing.join(", ")}`);
      const slots = (v.tasks || []).map(id => byId.get(id)?.slot);
      if (new Set(slots).size !== slots.length) p.push(`${vw}: two tasks share a slot`);
      slotSets.push(slots.slice().sort().join());
      if (!(g.passMark >= 1 && g.passMark <= (v.tasks?.length || 0))) p.push(`${vw}: passMark out of range`);
    });
    if (new Set(slotSets).size > 1) p.push(`${w}: every variant must test the same slots`);
    const [a, b] = g.variants || [];
    if (a && b) { const shared = (a.tasks || []).filter(id => (b.tasks || []).includes(id)); if (shared.length) p.push(`${w}: variants share tasks ${shared.join(", ")}: a retake would repeat answers`); }
  } else p.push(`${w}: kind must be "checkpoint", "assignment" or "mock-test"`);
  return p;
}

function validateTasks(g, tasks, where, p) {
  if (!Array.isArray(tasks) || tasks.length === 0) { p.push(`${where} must be a non-empty array`); return; }
  const ids = new Set();
  tasks.forEach((t, i) => {
    const tw = `${where}[${i}]`;
    if (!SLUG.test(t.id || "")) p.push(`${tw}.id must be a slug`);
    if (ids.has(t.id)) p.push(`${tw}.id "${t.id}" is duplicated`); ids.add(t.id);
    if (!isStr(t.ask)) p.push(`${tw}.ask is required`);
    if (!isStr(t.hint)) p.push(`${tw}.hint is required (spec §8: specific feedback)`);
    if ("solution" in t) p.push(`${tw} must not contain its solution. It belongs in the key file`);
    validateChecks(t.answerCheck, `${tw}.answerCheck`, p);
    if (!isFormulaCheck(t.answerCheck) && !g.lab) p.push(`${tw}: a ${[].concat(t.answerCheck).map(c => c.type).join("+")} task needs a "lab"`);
    validateStorySpec(t.story, tw, p);
  });
}

/** A case study (spec §9): ordered steps, each with its own answerCheck. Solutions are inline (it's practice, like drills). */
export function validateCase(c, { id } = {}) {
  const p = [];
  if (!c || typeof c !== "object") return ["case is not an object"];
  const w = `case "${c.id}"`;
  if (id !== undefined && c.id !== id) p.push(`${w}: id must be "${id}" (as listed in curriculum.json)`);
  if (c.kind !== "case") p.push(`${w}: kind must be "case"`);
  for (const k of ["title", "intro", "claimAfter"]) if (!isStr(c[k])) p.push(`${w}: "${k}" is required`);
  if (!(c.estMinutes > 0)) p.push(`${w}: estMinutes must be positive`);
  if (!DATASETS[c.dataset]) p.push(`${w}: dataset "${c.dataset}" isn't in DATASETS`);
  validateLab(c.lab, c.dataset, w, p);
  if (!Array.isArray(c.steps) || c.steps.length < 2) { p.push(`${w}: steps must list at least 2 steps`); return p; }
  const ids = new Set();
  c.steps.forEach((st, i) => {
    const sw = `${w} steps[${i}]`;
    if (!SLUG.test(st.id || "")) p.push(`${sw}.id must be a slug`);
    if (ids.has(st.id)) p.push(`${sw}.id "${st.id}" is duplicated`); ids.add(st.id);
    for (const k of ["title", "ask", "hint"]) if (!isStr(st[k])) p.push(`${sw}.${k} is required`);
    validateChecks(st.answerCheck, `${sw}.answerCheck`, p);
    if (isFormulaCheck(st.answerCheck)) { if (!isStr(st.solution?.formula)) p.push(`${sw}.solution.formula is required for a formula step`); }
    else if (!st.solution || typeof st.solution !== "object" || !(Array.isArray(st.solution.steps) || st.solution.pivot || st.solution.story)) p.push(`${sw}.solution must be { steps | pivot | story }`);
    validateStorySpec(st.story, sw, p);
  });
  return p;
}

/** The answer key: { id, solutions: { taskId: "=…" }, explain: { taskId: "markdown" } } */
export function validateKey(key, assignment) {
  const p = [];
  if (!key || key.id !== assignment.id) p.push(`key id must be "${assignment.id}"`);
  for (const t of assignment.tasks || assignment.pool || []) {
    const sol = key?.solutions?.[t.id];
    if (!(isStr(sol) || (sol && typeof sol === "object" && (Array.isArray(sol.steps) || sol.pivot || sol.story)))) p.push(`key has no solution for task "${t.id}"`);
    if (!isStr(key?.explain?.[t.id])) p.push(`key has no explanation for task "${t.id}"`);
  }
  return p;
}

/* ---------- loading (browser) ---------- */
const cache = new Map();
async function getJSON(path) {
  if (!cache.has(path)) {
    cache.set(path, fetch(path, { cache: "no-cache" }).then(r => {
      if (!r.ok) throw new Error(`${path} returned HTTP ${r.status}`);
      return r.json();
    }).catch(e => { cache.delete(path); throw e; }));
  }
  return cache.get(path);
}

export class ContentError extends Error {
  constructor(path, problems) { super(`${path} is invalid:\n- ${problems.join("\n- ")}`); this.problems = problems; this.path = path; }
}

/** Load + validate lesson number `order` (1-based) of a curriculum level. */
export async function loadLesson(levelEntry, levelNumber, order) {
  const id = levelEntry.lessons[order - 1];
  const path = `content/lessons/${id}.json`;
  const lesson = await getJSON(path);
  const problems = validateLesson(lesson, { level: levelNumber, order });
  if (problems.length) throw new ContentError(path, problems);
  return resolveTemplates(lesson, DATASETS[lesson.dataset]);
}

/** Load every lesson of a level (for the level page's lesson list). */
export function loadLevelLessons(levelEntry, levelNumber) {
  return Promise.all(levelEntry.lessons.map((_, i) => loadLesson(levelEntry, levelNumber, i + 1)));
}

export async function loadGate(levelEntry, levelNumber) {
  if (!levelEntry.gate?.content) return null;
  const path = `content/${levelEntry.gate.content}`;
  const gate = await getJSON(path);
  const problems = validateGate(gate, { taskId: levelEntry.gate.taskId, level: levelNumber });
  if (problems.length) throw new ContentError(path, problems);
  return resolveTemplates(gate, DATASETS[gate.dataset]);
}

/** Load + validate a case study listed in curriculum.json → cases[]. */
export async function loadCase(entry) {
  const path = `content/${entry.content}`;
  const c = await getJSON(path);
  const problems = validateCase(c, { id: entry.id });
  if (problems.length) throw new ContentError(path, problems);
  return resolveTemplates(c, DATASETS[c.dataset]);
}

/**
 * The readiness report's skill map (content/skills.json). Every skill's evidence must be something that
 * can actually be passed (a level gate or a case), and every practice lesson must exist.
 */
export function validateSkills(sk, curriculum) {
  const p = [];
  if (!sk || !Array.isArray(sk.skills) || !sk.skills.length) return ["skills.json: skills must be a non-empty array"];
  const evidence = new Set([...curriculum.levels.map(l => l.gate.taskId), ...(curriculum.cases || []).map(c => c.id)]);
  const lessons = new Set(curriculum.levels.flatMap(l => l.lessons));
  const ids = new Set();
  sk.skills.forEach((x, i) => {
    const w = `skills[${i}] "${x.id}"`;
    if (!SLUG.test(x.id || "")) p.push(`${w}: id must be a slug`);
    if (ids.has(x.id)) p.push(`${w}: duplicated`); ids.add(x.id);
    for (const k of ["label", "claim", "helped", "gap"]) if (!isStr(x[k])) p.push(`${w}: "${k}" is required`);
    if (!evidence.has(x.evidence)) p.push(`${w}: evidence "${x.evidence}" isn't a level gate or case in curriculum.json`);
    for (const l of x.practice || []) if (!lessons.has(l)) p.push(`${w}: practice lesson "${l}" isn't in curriculum.json`);
  });
  if (!isStr(sk.fallback)) p.push(`skills.json: "fallback" (the honest line before anything is demonstrated) is required`);
  const covered = new Set(sk.skills.map(x => x.evidence));
  for (const e of evidence) if (!covered.has(e)) p.push(`skills.json: "${e}" can be passed but no skill uses it as evidence`);
  return p;
}
export async function loadSkills(curriculum) {
  const path = "content/skills.json", sk = await getJSON(path);
  const problems = validateSkills(sk, curriculum);
  if (problems.length) throw new ContentError(path, problems);
  return sk;
}

/** The printable cheat-sheet (content/cheatsheet.json). */
export async function loadCheatsheet() { return getJSON("content/cheatsheet.json"); }

/**
 * Spec §5.2: "everything works offline once loaded". After the first page, fetch every content file
 * into the in-memory cache in the background, so later pages open without the network.
 * Answer keys are deliberately NOT prefetched: they load only after a submission (spec §8 no-cheese).
 * Returns the list of paths it warmed (failures are ignored: the page will just fetch on demand).
 */
export async function prefetchContent(curriculum) {
  const paths = [
    ...curriculum.levels.flatMap(l => l.lessons.map(id => `content/lessons/${id}.json`)),
    ...curriculum.levels.filter(l => l.gate?.content).map(l => `content/${l.gate.content}`),
    ...(curriculum.cases || []).map(c => `content/${c.content}`),
    "content/skills.json", "content/cheatsheet.json",
  ];
  const ok = [];
  for (const path of paths) { try { await getJSON(path); ok.push(path); } catch { /* on demand later */ } }
  return ok;
}

/** Load an assignment's answer key. Only call this AFTER a submission attempt (spec §8). */
export async function loadKey(assignment) {
  const path = `content/${assignment.key}`;
  const key = await getJSON(path);
  const problems = validateKey(key, assignment);
  if (problems.length) throw new ContentError(path, problems);
  return resolveTemplates(key, DATASETS[assignment.dataset]);
}

export { isFormulaCheck };

/* Progress ids (shared by the UI and tests) */
export const drillTaskId = (lesson, drill) => `${lesson.id}:${drill.id}`;
export const checkpointTaskId = lesson => `${lesson.id}:checkpoint`;
/** Lesson status from the progress store: which drills and checkpoint are passed. */
export function lessonProgress(lesson, isPassed) {
  const drills = lesson.drills.map(d => isPassed(drillTaskId(lesson, d)));
  const checkpoint = lesson.checkpoint ? isPassed(checkpointTaskId(lesson)) : true;
  const done = drills.filter(Boolean).length;
  return { drillsDone: done, drillsTotal: drills.length, drills, checkpoint, hasCheckpoint: !!lesson.checkpoint, complete: done === drills.length && checkpoint };
}
