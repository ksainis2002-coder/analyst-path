/* =========================================================================
   progress.js: progress state, persistence and level unlocking (spec §8)
   -------------------------------------------------------------------------
   Honesty rule (spec §3): progress is EARNED BY DOING. The only way to
   complete anything is recordPass(taskId), which the grader calls (Phase 4)
   when a checkpoint or assignment is actually passed. Nothing here records
   "viewed" or "visited" as progress. The last route is saved only so the
   app can resume where you left off.

   Persistence: localStorage under STORE_KEY. If storage is missing, blocked
   (private mode, disabled cookies, sandboxed iframe) or full, the store falls
   back to memory. The app keeps working. `persistent` becomes false and
   subscribers are told, so the UI can say that progress won't be saved.

   Drafts (unfinished assignment answers) are stored alongside but never count.

   The v1 key "analystPath.completed.v1" is deliberately NOT imported. v1
   let you tick stages complete by hand, which is exactly the "viewing counts
   as progress" pattern v2 rules out.
   ========================================================================= */

export const STORE_KEY = "analystPath.progress.v2";
const SCHEMA = 2;

const emptyState = () => ({ schema: SCHEMA, passed: {}, lastRoute: null, drafts: {} });

/** Return a working Storage, or null if storage is unavailable or throws. */
export function detectStorage(candidate) {
  try {
    const s = candidate === undefined ? globalThis.localStorage : candidate;
    if (!s) return null;
    const k = "__analystPath_probe__";
    s.setItem(k, "1");
    s.removeItem(k);
    return s;
  } catch {
    return null;
  }
}

function load(storage) {
  if (!storage) return { state: emptyState(), recovered: false };
  let raw;
  try { raw = storage.getItem(STORE_KEY); } catch { return { state: emptyState(), recovered: false }; }
  if (raw == null) return { state: emptyState(), recovered: false };
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || parsed.schema !== SCHEMA || typeof parsed.passed !== "object" || parsed.passed === null) {
      return { state: emptyState(), recovered: true };
    }
    const drafts = parsed.drafts && typeof parsed.drafts === "object" ? { ...parsed.drafts } : {};
    return { state: { schema: SCHEMA, passed: { ...parsed.passed }, lastRoute: typeof parsed.lastRoute === "string" ? parsed.lastRoute : null, drafts }, recovered: false };
  } catch {
    return { state: emptyState(), recovered: true }; // corrupted JSON: start clean rather than crash
  }
}

/**
 * @param {{storage?: Storage|null, now?: () => number}} [opts]
 *   storage: omit to use localStorage when it works. Pass null to force memory-only.
 */
export function createProgressStore(opts = {}) {
  let storage = "storage" in opts ? detectStorage(opts.storage ?? null) : detectStorage();
  const now = opts.now || (() => Date.now());
  const { state: initial, recovered } = load(storage);
  let state = initial;
  const listeners = new Set();

  const emit = () => { for (const fn of listeners) { try { fn(api); } catch (e) { /* a broken listener must not break the store */ } } };

  function save() {
    if (!storage) return;
    try { storage.setItem(STORE_KEY, JSON.stringify(state)); }
    catch { storage = null; } // quota exceeded / revoked mid-session: keep going in memory
  }

  const api = {
    get persistent() { return storage !== null; },
    /** True if saved data was unreadable and has been reset. */
    recovered,

    isPassed(taskId) { return Object.prototype.hasOwnProperty.call(state.passed, taskId); },
    getPass(taskId) { return api.isPassed(taskId) ? { ...state.passed[taskId] } : null; },
    passedIds() { return Object.keys(state.passed); },

    /**
     * Record that a task was genuinely passed. Called by the grader (Phase 4).
     * The first pass is kept (its date is when the skill was first shown);
     * `attempts` counts passes including replays, and is owned by the store.
     * One exception to "first pass is kept": a pass with { assisted: false } after a
     * "with help" pass upgrades it (assisted → false, helpedBefore: true, soloAt).
     * `attempts` is owned by the store:
     * callers must not pass their own `attempts` or `at` in `details` (use e.g.
     * `submissions` / `tries` instead).
     */
    recordPass(taskId, details = {}) {
      if (typeof taskId !== "string" || !taskId) throw new TypeError("recordPass needs a task id");
      const prev = state.passed[taskId];
      if (prev && prev.assisted && details.assisted === false) {
        // Phase 8: a later pass WITHOUT help upgrades a "with help" pass. The first date is kept, and
        // helpedBefore records that help was used earlier (the readiness report shows both).
        const { at, attempts, ...rest } = details;
        state.passed[taskId] = { ...prev, ...rest, assisted: false, helpedBefore: true, soloAt: now(), attempts: (prev.attempts || 1) + 1, lastAt: now() };
      } else state.passed[taskId] = prev
        ? { ...prev, attempts: (prev.attempts || 1) + 1, lastAt: now() }
        : { ...details, at: now(), attempts: 1 };
      save(); emit();
    },

    getLastRoute() { return state.lastRoute; },
    setLastRoute(hash) {
      if (state.lastRoute === hash) return;
      state.lastRoute = hash; save();       // not a progress change, so no emit
    },

    /**
     * Drafts: work in progress (e.g. an assignment's typed formulas, attempts,
     * whether the answer key was opened) so a reload doesn't lose it.
     * A draft is never progress: nothing unlocks from a draft.
     */
    getDraft(id) { const d = state.drafts[id]; return d ? JSON.parse(JSON.stringify(d)) : null; },
    setDraft(id, data) { state.drafts[id] = JSON.parse(JSON.stringify(data)); save(); }, // no emit: typing isn't progress
    clearDraft(id) { delete state.drafts[id]; save(); },

    reset() { state = emptyState(); save(); emit(); },

    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
  };
  return api;
}

/**
 * Work out each level's status from the curriculum and what has been passed.
 * A level is:
 *   "locked"   if its `requires` task hasn't been passed,
 *   "complete" if its gate task (checkpoint / assignment) has been passed,
 *   "open"     otherwise.
 * Levels are in curriculum order, so unlocking follows the chain
 * L0 checkpoint → L1 → A1 → L2 → A2 → L3 → A3 → Capstone.
 */
export function levelStates(levels, isPassed) {
  let prevUnlocked = true; // unlocking is a chain: a level can't open while the one before it is locked
  return levels.map(level => {
    const unlocked = prevUnlocked && (!level.requires || isPassed(level.requires));
    prevUnlocked = unlocked;
    const complete = unlocked && !!level.gate && isPassed(level.gate.taskId);
    return { id: level.id, status: !unlocked ? "locked" : complete ? "complete" : "open" };
  });
}
