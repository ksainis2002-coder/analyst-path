/* ui.dom.test.js: browser tests for ui/sheet.js and ui/console.js.
   Needs a real DOM: open dev/test.html through the local server (it runs every suite).
   In Node this file only prints a skip notice. */
import { createConsole } from "./console.js";
import { createSheet } from "./sheet.js";
import { V1_SAMPLE, toCells } from "../data.js";
import { evaluate } from "../engine.js";
import { createSuite, eq, assert } from "../testkit.js";

export const done = run();

async function run() {
  if (typeof document === "undefined") { console.log("— ui (DOM) —\nskipped in Node: open dev/test.html in a browser"); return null; }
  const s = createSuite("ui (DOM)");
  const stage = document.createElement("div");
  stage.style.cssText = "position:absolute;left:-10000px;top:0;width:1100px";
  document.body.append(stage);
  const mount = () => { const d = document.createElement("div"); stage.append(d); return d; };
  const roles = (lab, key) => [...lab.sheet.cell(key).classList].filter(c => c.startsWith("cell--")).map(c => c.slice(6));
  const quiet = { animate: false };

  s.group("sheet renders");
  s.test("v1 sample: 25 rows × A–J, headers, values, sticky heads", () => {
    const host = mount(); const sh = createSheet(host, { cells: V1_SAMPLE.cells, range: V1_SAMPLE.range });
    eq(host.querySelectorAll("tbody tr").length, 25);
    eq([...host.querySelectorAll("thead th.sheet__colhead")].map(t => t.textContent).join(""), "ABCDEFGHIJ");
    eq([sh.cell("A1").textContent, sh.cell("I7").textContent, sh.cell("F2").textContent], ["OrderID", "Webcam", "3"]);
    assert(host.querySelector("tr.is-header"), "row 1 styled as header");
    assert(sh.cell("G5").classList.contains("is-gap"), "empty column G drawn as a gap");
    assert(sh.cell("F2").classList.contains("is-num"), "numbers right-aligned");
  });
  s.test("range defaults to the data's extent", () => {
    const sh = createSheet(mount(), { cells: { B2: 1, C3: 2 } }); eq(sh.range, "A1:C3");
  });
  s.test("cell text is escaped, never parsed as HTML", () => {
    const sh = createSheet(mount(), { cells: { A1: "<img src=x onerror=alert(1)>" } });
    eq(sh.cell("A1").textContent, "<img src=x onerror=alert(1)>"); assert(!sh.cell("A1").querySelector("img"), "no element created");
  });
  s.test("sheet is a keyboard-focusable, labelled scroll region", () => {
    const sh = createSheet(mount(), { cells: V1_SAMPLE.cells, label: "Orders" });
    eq([sh.el.getAttribute("tabindex"), sh.el.getAttribute("role")], ["0", "region"]);
    assert(sh.el.getAttribute("aria-label").includes("Orders"), "label");
  });

  s.group("sheet applies engine highlights");
  s.test("exactly the engine's cells, with the engine's roles", () => {
    const sh = createSheet(mount(), { cells: V1_SAMPLE.cells });
    const r = evaluate("VLOOKUP(C2,H2:J9,2,FALSE)", V1_SAMPLE.cells);
    sh.highlight(r.highlights, quiet);
    eq(sh.state(), { C2: ["search"], H2: ["scan"], H3: ["scan"], H4: ["scan"], H5: ["scan"], H6: ["scan"], H7: ["scan", "match"], I7: ["return"] });
  });
  s.test("a new run clears the previous highlights", () => {
    const sh = createSheet(mount(), { cells: V1_SAMPLE.cells });
    sh.highlight(evaluate("VLOOKUP(C2,H2:J9,2,FALSE)", V1_SAMPLE.cells).highlights, quiet);
    sh.highlight(evaluate("INDEX(H2:H9,3)", V1_SAMPLE.cells).highlights, quiet);
    eq(sh.state(), { H4: ["return"] });
  });
  s.test("highlights outside the drawn range are ignored, not errors", () => {
    const sh = createSheet(mount(), { cells: V1_SAMPLE.cells, range: "A1:J5" });
    sh.highlight([{ cell: "H30", role: "match" }, { cell: "A2", role: "scan" }], quiet); eq(sh.state(), { A2: ["scan"] });
  });
  s.test("animated playback ends in the same state as instant", async () => {
    const sh = createSheet(mount(), { cells: V1_SAMPLE.cells });
    const r = evaluate('SUMIFS(F2:F25,D2:D25,"North")', V1_SAMPLE.cells);
    await sh.highlight(r.highlights, { animate: true });
    const animated = sh.state(); sh.highlight(r.highlights, quiet);
    eq(animated, sh.state());
  });
  s.test("a newer run cancels an animation still in progress", async () => {
    const sh = createSheet(mount(), { cells: V1_SAMPLE.cells });
    const slow = sh.highlight(evaluate('COUNTIF(D2:D25,"North")', V1_SAMPLE.cells).highlights, { animate: true });
    sh.highlight(evaluate("INDEX(H2:H9,3)", V1_SAMPLE.cells).highlights, quiet);
    await slow; await new Promise(r => setTimeout(r, 60));
    eq(sh.state(), { H4: ["return"] });
  });
  s.test("reveal scrolls the sheet (not the page) to a far cell", () => {
    const host = mount(); const cells = toCells([{ origin: "A1", rows: Array.from({ length: 200 }, (_, i) => [i + 1]) }]);
    const sh = createSheet(host, { cells, headerRows: 0 }); const pageY = window.scrollY;
    sh.highlight([{ cell: "A180", role: "match" }], quiet);
    assert(sh.el.scrollTop > 0, "sheet scrolled"); eq(window.scrollY, pageY, "page did not scroll");
  });

  s.test("when the search→match→return cells fit, all of them are scrolled into view", () => {
    const host = mount(); host.style.width = "1000px"; // two-column lab: sheet column ≈ 510px, H:J ≈ 300px fits
    const lab = createConsole(host, { dataset: V1_SAMPLE, animate: false, starter: "INDEX(H2:H9,MATCH(190,J2:J9,0))" });
    const w = lab.sheet.el, rowHead = w.querySelector(".sheet__rowhead").offsetWidth;
    const inView = k => { const td = lab.sheet.cell(k); return td.offsetLeft >= w.scrollLeft + rowHead - 1 && td.offsetLeft + td.offsetWidth <= w.scrollLeft + w.clientWidth + 1; };
    assert(w.scrollWidth > w.clientWidth, "precondition: the sheet is wider than its box");
    assert(inView("J3") && inView("H3"), `match J3 and return H3 both visible (scrollLeft ${w.scrollLeft})`);
  });

  s.group("console: run → result → highlight");
  s.test("trace's last dot is red on an error, green on a result", () => {
    const host = mount(); const lab = createConsole(host, { dataset: V1_SAMPLE, animate: false });
    lab.run('VLOOKUP("P999",H2:J9,2,FALSE)'); assert(host.querySelector(".trace").classList.contains("trace--err"), "error trace");
    lab.run("INDEX(H2:H9,3)"); assert(!host.querySelector(".trace").classList.contains("trace--err"), "ok trace");
  });
  s.test("starter runs on mount: result, source cell, trace, highlights", () => {
    const lab = createConsole(mount(), { dataset: V1_SAMPLE, starter: "VLOOKUP(C2,H2:J9,2,FALSE)", animate: false });
    const host = lab.sheet.el.closest(".lab");
    eq(host.querySelector(".rbox__value").textContent, "Webcam");
    assert(host.querySelector(".rbox__label").textContent.includes("I7"), "shows where the value came from");
    assert(host.querySelectorAll(".trace li").length >= 2, "trace steps listed");
    eq(roles(lab, "I7"), ["return"]); eq(roles(lab, "C2"), ["search"]);
  });
  s.test("typing + Enter (form submit) runs the formula", () => {
    const host = mount(); const lab = createConsole(host, { dataset: V1_SAMPLE, animate: false });
    const input = host.querySelector(".fx__input"); input.value = 'SUMIFS(F2:F25,D2:D25,"North")';
    host.querySelector("form").requestSubmit();
    eq(host.querySelector(".rbox__value").textContent, "74");
    eq(Object.values(lab.sheet.state()).filter(r => r.includes("return")).length, 7);
  });
  s.test("a leading = is accepted", () => {
    const host = mount(); createConsole(host, { dataset: V1_SAMPLE, animate: false, starter: "=SUM(F2:F25)" });
    eq(host.querySelector(".rbox__value").textContent, "241"); eq(host.querySelector(".fx__input").value, "SUM(F2:F25)");
  });
  s.test("rounded results say so and give the exact value", () => {
    const host = mount(); createConsole(host, { dataset: V1_SAMPLE, animate: false, starter: "AVERAGE(F2:F25)" });
    eq(host.querySelector(".rbox__value").textContent, "10.04");
    assert(host.querySelector(".rbox__note").textContent.includes("10.041666"), "exact value shown");
  });
  s.test("errors: code, engine message, specific hint; scanned cells still shown", () => {
    const host = mount(); const lab = createConsole(host, { dataset: V1_SAMPLE, animate: false, starter: 'VLOOKUP("P999",H2:J9,2,FALSE)' });
    eq(host.querySelector(".rbox__code").textContent, "#N/A");
    assert(host.querySelector(".rbox__msg").textContent.includes("P999"), "engine message");
    assert(host.querySelector(".rbox__hint").textContent.includes("FALSE"), "hint mentions FALSE");
    eq(Object.keys(lab.sheet.state()).length, 8, "all 8 IDs were scanned");
  });
  s.test("#NAME? and #DIV/0! hints", () => {
    const host = mount(); const lab = createConsole(host, { dataset: V1_SAMPLE, animate: false });
    lab.run("CONCAT(A1,B1)"); assert(host.querySelector(".rbox__hint").textContent.includes("misspelled"), "#NAME? hint");
    lab.run("F2/G2"); eq(host.querySelector(".rbox__code").textContent, "#DIV/0!");
  });
  s.test("empty formula asks for one, without an error code", () => {
    const host = mount(); const lab = createConsole(host, { dataset: V1_SAMPLE, animate: false });
    lab.run(""); assert(!host.querySelector(".rbox__code") && host.querySelector(".rbox__hint").textContent.includes("Type a formula"), "prompt");
  });
  s.test("Escape clears the formula, result and highlights", () => {
    const host = mount(); const lab = createConsole(host, { dataset: V1_SAMPLE, animate: false, starter: "INDEX(H2:H9,3)" });
    host.querySelector(".fx__input").dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    eq([host.querySelector(".fx__input").value, host.querySelector("[data-result]").innerHTML, JSON.stringify(lab.sheet.state())], ["", "", "{}"]);
  });
  s.test("example chips load the formula and run it", () => {
    const host = mount(); createConsole(host, { dataset: V1_SAMPLE, animate: false, examples: [{ formula: "COUNTA(A2:A25)", note: "orders" }, { formula: "=XLOOKUP(\"P002\",H2:H9,I2:I9)" }] });
    host.querySelectorAll(".example")[1].click();
    eq([host.querySelector(".fx__input").value, host.querySelector(".rbox__value").textContent], ['XLOOKUP("P002",H2:H9,I2:I9)', "Monitor"]);
    eq(document.activeElement, host.querySelector(".fx__input"), "focus returns to the formula box");
  });
  s.test("onResult receives the engine's result (the drill/grader hook)", () => {
    const seen = []; const lab = createConsole(mount(), { dataset: V1_SAMPLE, animate: false, onResult: (r, f) => seen.push([f, r.ok, r.value]) });
    lab.run("SUM(F2:F3)"); lab.run("FOO()");
    eq(seen, [["SUM(F2:F3)", true, 10], ["FOO()", false, null]]);
  });
  s.test("a throwing onResult doesn't break the console", () => {
    const orig = console.error; console.error = () => {};
    try {
      const host = mount(); const lab = createConsole(host, { dataset: V1_SAMPLE, animate: false, onResult: () => { throw new Error("x"); } });
      lab.run("SUM(F2:F3)"); eq(host.querySelector(".rbox__value").textContent, "10");
    } finally { console.error = orig; }
  });

  s.group("console: embedding");
  s.test("two consoles on one page are independent (different data, ids, highlights)", () => {
    const tiers = { cells: toCells([{ origin: "A1", header: ["MinSales", "Tier"], rows: [[0, "Bronze"], [100, "Silver"], [500, "Gold"]] }]) };
    const h1 = mount(), h2 = mount();
    const a = createConsole(h1, { dataset: V1_SAMPLE, animate: false, starter: "INDEX(H2:H9,3)" });
    const b = createConsole(h2, { dataset: tiers, animate: false, starter: "VLOOKUP(250,A2:B4,2,TRUE)" });
    eq([h1.querySelector(".rbox__value").textContent, h2.querySelector(".rbox__value").textContent], ["P003", "Silver"]);
    eq(a.sheet.state(), { H4: ["return"] }); eq(Object.keys(b.sheet.state()).includes("B3"), true);
    const ids = [...document.querySelectorAll(".fx__input")].map(i => i.id);
    eq(new Set(ids).size, ids.length, "unique input ids");
  });
  s.test("the console never mutates the dataset", () => {
    const before = JSON.stringify(V1_SAMPLE.cells);
    const lab = createConsole(mount(), { dataset: V1_SAMPLE, animate: false });
    ["VLOOKUP(C2,H2:J9,2,FALSE)", 'SUMIFS(F2:F25,D2:D25,"North")', "G2"].forEach(f => lab.run(f));
    eq(JSON.stringify(V1_SAMPLE.cells), before);
  });
  s.test("form controls are labelled", () => {
    const host = mount(); createConsole(host, { dataset: V1_SAMPLE });
    const input = host.querySelector(".fx__input");
    assert(host.querySelector(`label[for="${input.id}"]`), "input has a label");
    eq(host.querySelector("[data-result]").getAttribute("aria-live"), "polite");
  });
  s.test("destroy() empties the host", () => { const h = mount(); createConsole(h, { dataset: V1_SAMPLE }).destroy(); eq(h.innerHTML, ""); });

  const summary = await s.report();
  stage.remove();
  return summary;
}
