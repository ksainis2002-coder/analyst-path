/* =========================================================================
   router.js: hash-based routing (spec §5.1)
   -------------------------------------------------------------------------
   Routes (the level slug comes from content/curriculum.json, so a new level
   needs no router change):
     #/                     → { name: "home" }
     #/<level>              → { name: "level",  params: { level } }            e.g. #/level-1, #/capstone
     #/<level>/lesson-<n>   → { name: "lesson", params: { level, lesson: n } } e.g. #/level-1/lesson-2
     #/<level>/<gate-kind>  → { name: "gate",   params: { level, kind } }      e.g. #/level-0/checkpoint
     #/cases/<id>           → { name: "case",   params: { case: id } }         e.g. #/cases/case-a  ("cases" is reserved)
     #/report               → { name: "report" }                           the readiness report ("report" is reserved)
     #/cheatsheet           → { name: "cheatsheet" }                       the printable cheat-sheet ("cheatsheet" is reserved)
     anything else under #/ → { name: "not-found" }
   A hash that doesn't start with "#/" (such as a plain in-page anchor) is
   not a route. parseHash returns null and the router ignores it.

   parseHash / href are pure, and the Node tests cover them. createRouter is
   the only part that touches window.
   ========================================================================= */

const SLUG = /^[a-z0-9][a-z0-9-]*$/;
/** A level's gate page: #/level-0/checkpoint, #/level-1/assignment, #/capstone/mock-test */
export const GATE_KINDS = Object.freeze(["checkpoint", "assignment", "mock-test"]);

/** Parse a location hash into a route, or null if it isn't an app route. */
export function parseHash(hash) {
  const raw = String(hash ?? "").replace(/^#/, "");
  if (raw === "" || raw === "/") return { name: "home", params: {}, path: "/" };
  if (!raw.startsWith("/")) return null;

  let segs;
  try { segs = raw.split("?")[0].split("/").filter(Boolean).map(s => decodeURIComponent(s).toLowerCase()); }
  catch { return { name: "not-found", params: {}, path: raw }; }
  const path = "/" + segs.join("/");

  if (segs.length === 0) return { name: "home", params: {}, path: "/" };
  if (segs[0] === "cheatsheet") return segs.length === 1 ? { name: "cheatsheet", params: {}, path } : { name: "not-found", params: {}, path };
  if (segs[0] === "report") return segs.length === 1 ? { name: "report", params: {}, path } : { name: "not-found", params: {}, path };
  if (segs[0] === "cases") return segs.length === 2 && SLUG.test(segs[1]) ? { name: "case", params: { case: segs[1] }, path } : { name: "not-found", params: {}, path };
  if (segs.length === 1 && SLUG.test(segs[0])) return { name: "level", params: { level: segs[0] }, path };
  if (segs.length === 2 && SLUG.test(segs[0])) {
    const m = segs[1].match(/^lesson-(\d{1,3})$/);
    if (m && Number(m[1]) >= 1) return { name: "lesson", params: { level: segs[0], lesson: Number(m[1]) }, path };
    if (GATE_KINDS.includes(segs[1])) return { name: "gate", params: { level: segs[0], kind: segs[1] }, path };
  }
  return { name: "not-found", params: {}, path };
}

/** Build hrefs so no view hand-writes a URL. */
export const href = {
  home: () => "#/",
  level: level => `#/${encodeURIComponent(level)}`,
  lesson: (level, n) => `#/${encodeURIComponent(level)}/lesson-${n}`,
  gate: (level, kind) => `#/${encodeURIComponent(level)}/${kind}`,
  case: id => `#/cases/${encodeURIComponent(id)}`,
  report: () => "#/report",
  cheatsheet: () => "#/cheatsheet",
};

/**
 * Start listening to hash changes. Calls onRoute(route, { initial }) for every
 * app route. Returns { go(hash), current(), stop() }.
 */
export function createRouter(onRoute, win = globalThis.window) {
  let current = null;
  const handle = initial => {
    const route = parseHash(win.location.hash);
    if (route === null) return;      // not an app route (e.g. #main): leave the current view alone
    current = route;
    onRoute(route, { initial });
  };
  const onChange = () => handle(false);
  win.addEventListener("hashchange", onChange);
  handle(true);
  return {
    go(hash) { if (win.location.hash === hash) handle(false); else win.location.hash = hash; },
    current: () => current,
    stop: () => win.removeEventListener("hashchange", onChange),
  };
}
