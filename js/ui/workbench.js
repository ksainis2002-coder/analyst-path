/* =========================================================================
   ui/workbench.js: cleaning lab → pivot → chart, as one workspace (Level 3)
   -------------------------------------------------------------------------
   Level 3 lessons and Assignment 3 use any combination of three panels:
     "cleaning"  the working copy of the messy export (ui/cleaning.js)
     "pivot"     a pivot table over that data (ui/pivot.js)
     "chart"     a PivotChart + title + one-sentence insight (ui/story.js)
   The panels are chained the way Excel chains them: the pivot reads the
   cleaned data (as of its last Refresh), the chart reads the pivot.

   createWorkbench(host, {
     dataset,                     AEGEAN_MESSY (with cleaning) or AEGEAN (clean)
     panels: ["cleaning", "pivot", "chart"],
     draft,                       { ops, pivot: { config, inserted, cacheKey }, story } to restore
     spec,                        the chart's insight sentence { sentence, blanks }
     locked,
     onChange(info),              any change; info.source says what happened
     onTest(result, formula, o),  a formula tested in the cleaning lab's formula bar
   }) → { submission(), draft(), cleaning, pivot, story, setSpec(spec), destroy() }

   submission() is exactly what grader.grade() reads: { cleaning, pivot, story }.
   ========================================================================= */
import { createCleaningLab, replay, cleaningSubmission, cellsOf } from "./cleaning.js";
import { createPivotBuilder, deriveRows, computePivot, pivotState } from "./pivot.js";
import { createStoryBuilder } from "./story.js";

const esc = v => String(v ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
export const PANEL_TITLES = Object.freeze({ cleaning: "Clean the export", pivot: "Pivot table", chart: "Chart and insight" });

export function createWorkbench(host, opts = {}) {
  const { dataset, panels = [], locked = false, onChange, onTest } = opts;
  const draft = opts.draft || {};
  const has = p => panels.includes(p);
  const cleanRows = dataset.raw?.orders; // the documented clean log (AEGEAN_MESSY shares AEGEAN's raw tables via the generator)
  host.innerHTML = `<div class="workbench">${panels.map((p, i) => `
    <section class="workbench__panel workbench__panel--${p}" aria-labelledby="${p}-h-${i}">
      <h3 class="workbench__title" id="${p}-h-${i}"><span class="workbench__num" aria-hidden="true">${panels.length > 1 ? i + 1 : ""}</span>${esc(PANEL_TITLES[p])}</h3>
      <div data-panel-host="${p}"></div>
    </section>`).join("")}</div>`;
  const slot = p => host.querySelector(`[data-panel-host="${p}"]`);

  let cleaning = null, pivot = null, story = null;
  const baseRows = () => (dataset.orders?.rows || dataset.raw?.orders || []);
  const currentOps = () => (cleaning ? cleaning.ops() : []);
  const sourceKey = () => JSON.stringify(currentOps());
  const recordsFor = ops => deriveRows(has("cleaning") ? replay(dataset, ops).rows : baseRows(), dataset);

  if (has("cleaning")) {
    cleaning = createCleaningLab(slot("cleaning"), {
      dataset, ops: draft.ops || [], locked,
      onChange: (state, ops, info) => { pivot?.sourceChanged(); onChange?.({ source: "cleaning", ...info }); },
      onTest: (r, f, o) => onTest?.(r, f, o),
    });
  }
  if (has("pivot")) {
    let cache = null;
    if (draft.pivot?.inserted && draft.pivot.cacheKey != null) {
      try { cache = { key: draft.pivot.cacheKey, records: recordsFor(JSON.parse(draft.pivot.cacheKey)) }; } catch { cache = null; }
    }
    pivot = createPivotBuilder(slot("pivot"), {
      getRecords: () => recordsFor(currentOps()), sourceKey, locked,
      inserted: !has("cleaning") || !!cache, cache, config: draft.pivot?.config,
      onChange: (config, result, info) => { story?.refresh(); onChange?.({ source: "pivot", ...info }); },
    });
  }
  if (has("chart")) {
    story = createStoryBuilder(slot("chart"), {
      getResult: () => pivot?.result() || null, spec: opts.spec, state: draft.story, locked,
      onChange: () => onChange?.({ source: "story" }),
    });
  }

  return {
    cleaning, pivot, story,
    submission() {
      const sub = {};
      if (cleaning && cleanRows) sub.cleaning = cleaningSubmission(cleaning.state(), dataset, cleanRows);
      if (pivot) sub.pivot = pivot.state();
      if (story) sub.story = story.state();
      return sub;
    },
    draft() {
      return { ops: currentOps(), pivot: pivot ? pivot.serialize() : undefined, story: story ? story.state() : undefined };
    },
    setSpec(spec) { story?.setSpec(spec); },
    /** The sheet as it is now (the working export + reference tables), for formulas typed against it. */
    cells() { return cleaning ? cellsOf(cleaning.state(), dataset) : dataset.cells; },
    rows() { return cleaning ? cleaning.state().rows : baseRows(); },
    destroy() { cleaning?.destroy(); pivot?.destroy(); story?.destroy(); host.innerHTML = ""; },
  };
}

/**
 * Pure: the submission a workspace WOULD produce, from its moves, pivot layout and chart answers
 * (the pivot freshly refreshed after the moves). Used to check answer keys and solutions in the tests.
 */
export function workbenchSubmission(dataset, panels, { ops = [], pivot, story } = {}) {
  const sub = {};
  const rows = panels.includes("cleaning") ? replay(dataset, ops).rows : (dataset.orders?.rows || dataset.raw?.orders || []);
  if (panels.includes("cleaning")) sub.cleaning = cleaningSubmission(replay(dataset, ops), dataset, dataset.raw.orders);
  if (panels.includes("pivot") && pivot) sub.pivot = pivotState(pivot, computePivot(deriveRows(rows, dataset), pivot), { stale: false });
  if (panels.includes("chart") && story) sub.story = story;
  return sub;
}
