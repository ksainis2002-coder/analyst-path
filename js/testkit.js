/* testkit.js: the tiny no-framework harness shared by the router, progress
   and UI tests. (engine.test.js keeps its own harness from Phase 0.)
   Runs in Node or a browser. Tests may be async (return a promise). Every
   report is also pushed to globalThis.__TEST_REPORTS so dev/test.html can
   show all suites on one page. */
export function createSuite(title) {
  const results = [];
  const pending = [];
  let group = "";
  const record = (g, name, ok, err) => results.push({ group: g, name, ok, err });
  return {
    group(name) { group = name; },
    test(name, fn) {
      const g = group;
      try {
        const out = fn();
        if (out && typeof out.then === "function") {
          pending.push(out.then(() => record(g, name, true), e => record(g, name, false, e?.message || String(e))));
        } else record(g, name, true);
      } catch (e) { record(g, name, false, e.message || String(e)); }
    },
    /** Prints the summary. Returns the summary, or a promise of it if any test is async. */
    report() {
      const finish = () => {
        const groups = [...new Set(results.map(r => r.group))];
        const lines = [`— ${title} —`];
        for (const g of groups) {
          const rs = results.filter(r => r.group === g), pass = rs.filter(r => r.ok).length;
          lines.push(`${pass === rs.length ? "✓" : "✗"} ${g.padEnd(24)} ${pass}/${rs.length}`);
          rs.filter(r => !r.ok).forEach(r => lines.push(`    ✗ ${r.name}\n      ${r.err}`));
        }
        const failed = results.filter(r => !r.ok).length;
        lines.push(`${results.length - failed}/${results.length} passed · ${failed ? `FAIL (${failed})` : "ALL GREEN"}`);
        console.log(lines.join("\n"));
        if (failed && typeof process !== "undefined" && process.versions?.node) process.exitCode = 1;
        const summary = { title, total: results.length, failed, lines, results };
        (globalThis.__TEST_REPORTS ||= []).push(summary);
        return summary;
      };
      return pending.length ? Promise.all(pending).then(finish) : finish();
    },
  };
}
export function assert(cond, msg) { if (!cond) throw new Error(msg); }
export function eq(actual, expected, msg = "") {
  const a = JSON.stringify(actual), b = JSON.stringify(expected);
  if (a !== b) throw new Error(`${msg}${msg ? ": " : ""}expected ${b}, got ${a}`);
}
