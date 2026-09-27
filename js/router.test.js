/* router.test.js: run with `node js/router.test.js` */
import { parseHash, href, createRouter } from "./router.js";
import { createSuite, eq, assert } from "./testkit.js";

const s = createSuite("router");

s.group("parseHash: home");
s.test("empty hash", () => eq(parseHash(""), { name: "home", params: {}, path: "/" }));
s.test("#/", () => eq(parseHash("#/"), { name: "home", params: {}, path: "/" }));
s.test("# alone", () => eq(parseHash("#"), { name: "home", params: {}, path: "/" }));
s.test("undefined", () => eq(parseHash(undefined).name, "home"));

s.group("parseHash: levels");
s.test("#/level-0", () => eq(parseHash("#/level-0"), { name: "level", params: { level: "level-0" }, path: "/level-0" }));
s.test("#/capstone", () => eq(parseHash("#/capstone").params, { level: "capstone" }));
s.test("trailing slash", () => eq(parseHash("#/level-2/").params, { level: "level-2" }));
s.test("case-insensitive", () => eq(parseHash("#/Level-1").params, { level: "level-1" }));

s.group("parseHash: lessons");
s.test("#/level-1/lesson-2 (spec example)", () =>
  eq(parseHash("#/level-1/lesson-2"), { name: "lesson", params: { level: "level-1", lesson: 2 }, path: "/level-1/lesson-2" }));
s.test("lesson-0 is not a lesson", () => eq(parseHash("#/level-1/lesson-0").name, "not-found"));
s.test("lesson-abc is not a lesson", () => eq(parseHash("#/level-1/lesson-abc").name, "not-found"));

s.group("parseHash: gates");
s.test("#/level-0/checkpoint", () => eq(parseHash("#/level-0/checkpoint"), { name: "gate", params: { level: "level-0", kind: "checkpoint" }, path: "/level-0/checkpoint" }));
s.test("#/capstone/mock-test", () => eq(parseHash("#/capstone/mock-test").params, { level: "capstone", kind: "mock-test" }));
s.test("unknown second segment is not found", () => eq(parseHash("#/level-0/quiz").name, "not-found"));
s.test("href.gate round-trips", () => eq(parseHash(href.gate("level-1", "assignment")).params, { level: "level-1", kind: "assignment" }));

s.group("parseHash: not routes / not found");
s.test("plain anchor #main is not a route", () => eq(parseHash("#main"), null));
s.test("too deep", () => eq(parseHash("#/a/b/c").name, "not-found"));
s.test("bad characters", () => eq(parseHash("#/level_1").name, "not-found"));
s.test("malformed percent-encoding doesn't throw", () => eq(parseHash("#/%E0%A4%A").name, "not-found"));

s.group("href round-trips");
s.test("home", () => eq(parseHash(href.home()).name, "home"));
s.test("level", () => eq(parseHash(href.level("level-3")).params, { level: "level-3" }));
s.test("lesson", () => eq(parseHash(href.lesson("level-1", 4)).params, { level: "level-1", lesson: 4 }));

s.group("createRouter (fake window)");
s.test("routes initial hash, then hashchange; ignores #main", () => {
  const listeners = {};
  const win = { location: { hash: "#/level-1" }, addEventListener: (t, f) => (listeners[t] = f), removeEventListener: t => delete listeners[t] };
  const seen = [];
  const r = createRouter((route, { initial }) => seen.push([route.name, route.params.level ?? null, initial]), win);
  win.location.hash = "#main"; listeners.hashchange();
  win.location.hash = "#/capstone"; listeners.hashchange();
  eq(seen, [["level", "level-1", true], ["level", "capstone", false]]);
  eq(r.current().params.level, "capstone");
  r.stop(); assert(!listeners.hashchange, "stop() removes the listener");
});

s.group("case studies (Phase 7)");
s.test("#/cases/case-a → case route; href round-trips", () => { eq(parseHash("#/cases/case-a"), { name: "case", params: { case: "case-a" }, path: "/cases/case-a" }); eq(parseHash(href.case("case-a")).params.case, "case-a"); });
s.test("#/cases alone or with junk is not found", () => { eq(parseHash("#/cases").name, "not-found"); eq(parseHash("#/cases/a/b").name, "not-found"); eq(parseHash("#/cases/Bad_Id!").name, "not-found"); });
s.test("#/report → report route (reserved, not a level)", () => { eq(parseHash("#/report").name, "report"); eq(parseHash(href.report()).name, "report"); eq(parseHash("#/report/x").name, "not-found"); });
s.test("#/cheatsheet → cheatsheet route (reserved)", () => { eq(parseHash(href.cheatsheet()).name, "cheatsheet"); eq(parseHash("#/cheatsheet/x").name, "not-found"); });
s.report();
