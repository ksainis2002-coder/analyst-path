/* progress.test.js: run with `node js/progress.test.js` */
import { createProgressStore, levelStates, detectStorage, STORE_KEY } from "./progress.js";
import { createSuite, eq, assert } from "./testkit.js";

const s = createSuite("progress");

/** In-memory stand-in for localStorage. Shared across stores to simulate a page reload. */
function fakeStorage(seed = {}) {
  const m = new Map(Object.entries(seed));
  return {
    getItem: k => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: k => m.delete(k),
    _map: m,
  };
}
const throwing = { getItem() { throw new Error("SecurityError"); }, setItem() { throw new Error("SecurityError"); }, removeItem() {} };

// Mirrors content/curriculum.json gating (ids only).
const LEVELS = [
  { id: "level-0", requires: null, gate: { taskId: "l0-checkpoint" } },
  { id: "level-1", requires: "l0-checkpoint", gate: { taskId: "a1-sales-summary" } },
  { id: "level-2", requires: "a1-sales-summary", gate: { taskId: "a2-enrich-orders" } },
  { id: "level-3", requires: "a2-enrich-orders", gate: { taskId: "a3-messy-export" } },
  { id: "capstone", requires: "a3-messy-export", gate: { taskId: "mock-test" } },
];

s.group("persistence");
s.test("a pass survives a reload (new store, same storage)", () => {
  const st = fakeStorage();
  createProgressStore({ storage: st, now: () => 1000 }).recordPass("l0-checkpoint", { score: 5 });
  const reloaded = createProgressStore({ storage: st });
  assert(reloaded.persistent, "should be persistent");
  assert(reloaded.isPassed("l0-checkpoint"), "pass should persist");
  eq(reloaded.getPass("l0-checkpoint"), { score: 5, at: 1000, attempts: 1 });
});
s.test("details can't overwrite the timestamp or attempts", () => {
  const p = createProgressStore({ storage: fakeStorage(), now: () => 7 });
  p.recordPass("t", { at: 1, attempts: 99 });
  eq(p.getPass("t"), { at: 7, attempts: 1 });
});
s.test("replaying a passed task keeps the first date and counts attempts", () => {
  let t = 1; const p = createProgressStore({ storage: fakeStorage(), now: () => t });
  p.recordPass("a1-sales-summary"); t = 2; p.recordPass("a1-sales-summary");
  eq(p.getPass("a1-sales-summary"), { at: 1, attempts: 2, lastAt: 2 });
});
s.test("last route is saved and restored", () => {
  const st = fakeStorage();
  createProgressStore({ storage: st }).setLastRoute("#/level-2");
  eq(createProgressStore({ storage: st }).getLastRoute(), "#/level-2");
});
s.test("reset clears passes and the saved copy", () => {
  const st = fakeStorage(); const p = createProgressStore({ storage: st });
  p.recordPass("l0-checkpoint"); p.reset();
  assert(!createProgressStore({ storage: st }).isPassed("l0-checkpoint"), "reset should persist");
});
s.test("data is stored under the v2 key as JSON", () => {
  const st = fakeStorage(); createProgressStore({ storage: st }).recordPass("x");
  assert(JSON.parse(st.getItem(STORE_KEY)).passed.x, "expected passed.x in storage");
});

s.test("drafts survive a reload, are copies, and never count as progress", () => {
  const st = fakeStorage(); const p = createProgressStore({ storage: st });
  const d = { answers: { t1: "=SUM(F2:F25)" }, attempts: 1 };
  p.setDraft("a1", d); d.attempts = 99;                         // caller mutating its object must not change the store
  const r = createProgressStore({ storage: st });
  eq(r.getDraft("a1"), { answers: { t1: "=SUM(F2:F25)" }, attempts: 1 });
  eq(r.passedIds(), []); eq(r.isPassed("a1"), false);
});
s.test("clearDraft and reset remove drafts", () => {
  const p = createProgressStore({ storage: fakeStorage() });
  p.setDraft("a", { x: 1 }); p.setDraft("b", { x: 2 }); p.clearDraft("a");
  eq([p.getDraft("a"), p.getDraft("b")], [null, { x: 2 }]); p.reset(); eq(p.getDraft("b"), null);
});
s.test("saving a draft doesn't notify subscribers (typing isn't progress)", () => {
  const p = createProgressStore({ storage: fakeStorage() }); let n = 0; p.subscribe(() => n++);
  p.setDraft("a", { x: 1 }); eq(n, 0);
});
s.test("older saved data without drafts still loads", () => {
  const p = createProgressStore({ storage: fakeStorage({ [STORE_KEY]: JSON.stringify({ schema: 2, passed: { x: { at: 1 } }, lastRoute: null }) }) });
  assert(p.isPassed("x") && p.getDraft("y") === null && !p.recovered, "loads");
});

s.group("graceful degradation");
s.test("storage: null → memory only, everything still works", () => {
  const p = createProgressStore({ storage: null });
  assert(!p.persistent, "should report not persistent");
  p.recordPass("l0-checkpoint"); p.setLastRoute("#/level-1");
  assert(p.isPassed("l0-checkpoint") && p.getLastRoute() === "#/level-1", "memory state should work");
});
s.test("storage that throws (blocked) → memory only, no crash", () => {
  const p = createProgressStore({ storage: throwing });
  assert(!p.persistent, "should fall back");
  p.recordPass("t"); assert(p.isPassed("t"), "should still record in memory");
});
s.test("quota exceeded mid-session → switches to memory, keeps the pass", () => {
  const st = fakeStorage(); const p = createProgressStore({ storage: st });
  st.setItem = () => { throw new Error("QuotaExceededError"); };
  p.recordPass("t");
  assert(!p.persistent && p.isPassed("t"), "should keep going in memory");
});
s.test("corrupted JSON → clean start, flagged as recovered", () => {
  const p = createProgressStore({ storage: fakeStorage({ [STORE_KEY]: "{not json" }) });
  assert(p.recovered && p.passedIds().length === 0, "should recover to empty");
});
s.test("wrong schema → clean start", () => {
  const p = createProgressStore({ storage: fakeStorage({ [STORE_KEY]: JSON.stringify({ schema: 1, passed: { x: {} } }) }) });
  assert(p.recovered && !p.isPassed("x"), "should ignore old schema");
});
s.test("v1 self-marked completions are NOT imported (honesty rule)", () => {
  const p = createProgressStore({ storage: fakeStorage({ "analystPath.completed.v1": "[0,1,2,3,4,5]" }) });
  eq(p.passedIds(), []);
});
s.test("detectStorage rejects null and throwing storage", () => {
  assert(detectStorage(null) === null && detectStorage(throwing) === null, "should be null");
  assert(detectStorage(fakeStorage()) !== null, "fake storage should work");
});

s.group("subscribers");
s.test("notified on pass and reset, not on route changes", () => {
  const p = createProgressStore({ storage: fakeStorage() }); let n = 0;
  const off = p.subscribe(() => n++);
  p.recordPass("t"); p.setLastRoute("#/x"); p.reset(); off(); p.recordPass("u");
  eq(n, 2);
});
s.test("a throwing listener doesn't break the store", () => {
  const p = createProgressStore({ storage: fakeStorage() });
  p.subscribe(() => { throw new Error("boom"); });
  p.recordPass("t"); assert(p.isPassed("t"), "pass recorded");
});

s.group("level gating");
const statuses = passed => levelStates(LEVELS, id => passed.includes(id)).map(x => x.status);
s.test("fresh start: only Level 0 is open", () => eq(statuses([]), ["open", "locked", "locked", "locked", "locked"]));
s.test("L0 checkpoint passed → L0 complete, L1 open", () => eq(statuses(["l0-checkpoint"]), ["complete", "open", "locked", "locked", "locked"]));
s.test("A1 passed → Level 2 unlocks", () => eq(statuses(["l0-checkpoint", "a1-sales-summary"]), ["complete", "complete", "open", "locked", "locked"]));
s.test("full chain → capstone open, then complete", () => {
  const all = ["l0-checkpoint", "a1-sales-summary", "a2-enrich-orders", "a3-messy-export"];
  eq(statuses(all), ["complete", "complete", "complete", "complete", "open"]);
  eq(statuses([...all, "mock-test"]).at(-1), "complete");
});
s.test("a gate passed on a still-locked level doesn't count as complete", () =>
  eq(statuses(["a2-enrich-orders"]), ["open", "locked", "locked", "locked", "locked"]));

s.group("with help → solo (Phase 8)");
s.test("a later pass without help upgrades a 'with help' pass; the first date stays, the help is remembered", () => {
  let t = 100; const st = createProgressStore({ storage: null, now: () => t });
  st.recordPass("a2", { assisted: true, score: 8 }); t = 200;
  st.recordPass("a2", { assisted: false, score: 8 });
  const p = st.getPass("a2"); eq([p.assisted, p.helpedBefore, p.at, p.soloAt, p.attempts], [false, true, 100, 200, 2]);
});
s.test("a replay with help never downgrades a solo pass; a solo replay of a solo pass changes nothing but the count", () => {
  const st = createProgressStore({ storage: null });
  st.recordPass("x", { assisted: false }); st.recordPass("x", { assisted: true }); eq(st.getPass("x").assisted, false);
  st.recordPass("x", { assisted: false }); eq([st.getPass("x").helpedBefore, st.getPass("x").attempts], [undefined, 3]);
});
s.test("a replay without an assisted flag doesn't upgrade (only an explicit solo pass does)", () => {
  const st = createProgressStore({ storage: null }); st.recordPass("y", { assisted: true }); st.recordPass("y", {}); eq(st.getPass("y").assisted, true);
});

s.report();
