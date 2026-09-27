/* =========================================================================
   ui/story.js: one chart, one sentence (ported from v1 buildStory)
   -------------------------------------------------------------------------
   v1 drew a fixed, pre-sorted bar chart with a ready-made insight. v2 makes
   the learner take the three decisions a hiring test marks:
     1. the right chart for the question (compare categories → bars;
        change over time → a line; a pie only for a few parts of one whole),
     2. an order that makes the point (largest first; time stays in order),
     3. a title that states the finding, and a one-sentence insight whose
        numbers come from their own pivot.
   The chart is a PivotChart: it plots one series (a column of the pivot, or
   its Grand Total) over the pivot's row labels, so a wrong pivot gives a
   wrong chart, as in Excel.

   PURE part: CHART_TYPES, seriesOptions(result), chartData(result, series, sort),
   parseAnswerNumber(text), fillSentence(template, blanks).
   DOM part: createStoryBuilder(host, opts), further down.
   ========================================================================= */

export const CHART_TYPES = Object.freeze({ column: "Clustered Column", bar: "Clustered Bar", line: "Line", pie: "Pie" });
export const SORTS = Object.freeze({ none: "As in the pivot", desc: "Largest first", asc: "Smallest first" });
export const GRAND = "Grand Total";

/** The series a PivotChart can show: each pivot column, plus the Grand Total. */
export function seriesOptions(result) {
  if (!result?.ready) return [];
  return result.colKeys.length ? [...result.colKeys, GRAND] : [GRAND];
}

/** [{label, value}] for one series, in the chosen order. value is null where the pivot cell is empty. */
export function chartData(result, series, sort = "none") {
  if (!result?.ready) return [];
  const pts = result.rowKeys.map(label => {
    const v = series === GRAND || !result.colKeys.length ? result.rowTotals[label] : result.cells[label]?.[series];
    return { label, value: typeof v === "number" ? v : null };
  });
  if (sort === "desc" || sort === "asc") {
    const dir = sort === "desc" ? -1 : 1;
    pts.sort((a, b) => (a.value === null) - (b.value === null) || dir * ((a.value ?? 0) - (b.value ?? 0)));
  }
  return pts;
}

/** "€48,781.80" / "42.9%" → a number (NaN if it isn't one): the grader's own rule, so the preview can't disagree with the verdict. */
export { parseAnswerNumber } from "../grader.js";

/** Split "In Q4, {top} led with €{amount}." into text and blank parts. */
export function sentenceParts(template) {
  const parts = []; let last = 0;
  for (const m of String(template).matchAll(/\{([a-z][a-zA-Z0-9]*)\}/g)) {
    if (m.index > last) parts.push({ text: template.slice(last, m.index) });
    parts.push({ blank: m[1] });
    last = m.index + m[0].length;
  }
  if (last < template.length) parts.push({ text: template.slice(last) });
  return parts;
}
/** The sentence with the learner's answers filled in (for display and the key). */
export function fillSentence(template, blanks = {}) {
  return sentenceParts(template).map(p => (p.text !== undefined ? p.text : String(blanks[p.blank] ?? "____"))).join("");
}

/* =========================================================================
   DOM: createStoryBuilder(host, opts)
   opts: {
     getResult(): pivot result     the PivotChart's source (computePivot output)
     spec: { sentence, blanks }    the drill/task's insight sentence (optional):
                                   blanks: { name: { type: "choice", options: [...], label } | { type: "number", label } }
     state                         saved answers { series, chart, sort, highlight, title, blanks }
     locked, onChange(storyState)
   }
   Returns { state(), refresh(), setSpec(spec), setState(s), destroy() }
   The chart is one series: plum marks, one clay accent on the highlighted
   item (clay = "the thing to look at"). Values are labelled directly, every
   mark has a hover title, and a data table sits underneath.
   ========================================================================= */
const escS = v => String(v ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
let stUid = 0;
const short = (v, pct) => (v === null ? "" : pct ? `${(v * 100).toFixed(1)}%` : Math.abs(v) >= 1000 ? v.toLocaleString("en-US", { maximumFractionDigits: 0 }) : v.toLocaleString("en-US", { maximumFractionDigits: 2 }));

/** SVG for one series. Pure string (tested in the DOM suite by rendering it). */
export function chartSVG(points, { chart = "column", highlight = "", percent = false, label = "" } = {}) {
  const pts = points.filter(p => p.value !== null);
  if (!pts.length) return `<p class="chart__empty">Nothing to plot yet.</p>`;
  const W = 640, H = 300, cls = p => `chart__mark${highlight ? (p.label === highlight ? " is-accent" : " is-dim") : ""}`;
  const tip = p => `<title>${escS(p.label)}: ${escS(short(p.value, percent))}</title>`;
  const aria = `role="img" aria-label="${escS(label || "Chart")}: ${escS(pts.map(p => `${p.label} ${short(p.value, percent)}`).join("; "))}"`;
  const max = Math.max(...pts.map(p => p.value), 0), min = Math.min(...pts.map(p => p.value), 0), span = max - min || 1;
  if (chart === "pie") {
    const total = pts.reduce((s, p) => s + Math.max(0, p.value), 0) || 1;
    let a0 = -Math.PI / 2; const cx = 190, cy = 150, r = 120;
    const slices = pts.map(p => {
      const a1 = a0 + (Math.max(0, p.value) / total) * Math.PI * 2, mid = (a0 + a1) / 2, large = a1 - a0 > Math.PI ? 1 : 0;
      const path = `M${cx},${cy} L${cx + r * Math.cos(a0)},${cy + r * Math.sin(a0)} A${r},${r} 0 ${large} 1 ${cx + r * Math.cos(a1)},${cy + r * Math.sin(a1)} Z`;
      const lx = cx + (r + 16) * Math.cos(mid), ly = cy + (r + 16) * Math.sin(mid);
      const out = `<path class="${cls(p)} chart__slice" d="${path}">${tip(p)}</path><text class="chart__label" x="${lx.toFixed(1)}" y="${ly.toFixed(1)}" text-anchor="${Math.cos(mid) >= 0 ? "start" : "end"}" dominant-baseline="middle">${escS(p.label)} ${Math.round((Math.max(0, p.value) / total) * 100)}%</text>`;
      a0 = a1; return out;
    }).join("");
    return `<svg class="chart" viewBox="0 0 ${W} ${H}" ${aria}>${slices}</svg>`;
  }
  if (chart === "bar") {
    const left = 130, right = 70, rowH = Math.min(40, (H - 20) / pts.length), bw = rowH - 8, w = W - left - right;
    const x = v => left + ((v - min) / span) * w;
    const body = pts.map((p, i) => {
      const y = 10 + i * rowH, x0 = x(0), x1 = x(p.value), len = Math.max(1, Math.abs(x1 - x0)), rr = Math.min(4, len / 2);
      const d = `M${Math.min(x0, x1)},${y} h${len - rr} a${rr},${rr} 0 0 1 ${rr},${rr} v${bw - 2 * rr} a${rr},${rr} 0 0 1 -${rr},${rr} h-${len - rr} Z`;
      return `<path class="${cls(p)}" d="${d}">${tip(p)}</path><text class="chart__cat" x="${left - 8}" y="${y + bw / 2}" text-anchor="end" dominant-baseline="middle">${escS(p.label)}</text><text class="chart__val" x="${Math.max(x0, x1) + 6}" y="${y + bw / 2}" dominant-baseline="middle">${escS(short(p.value, percent))}</text>`;
    }).join("");
    return `<svg class="chart" viewBox="0 0 ${W} ${10 + pts.length * rowH + 10}" ${aria}><line class="chart__axis" x1="${x(0)}" x2="${x(0)}" y1="4" y2="${10 + pts.length * rowH}"/>${body}</svg>`;
  }
  const top = 28, bottom = 40, left = 20, right = 20, h = H - top - bottom, w = W - left - right, step = w / pts.length;
  const y = v => top + h - ((v - min) / span) * h;
  const base = `<line class="chart__axis" x1="${left}" x2="${W - right}" y1="${y(0)}" y2="${y(0)}"/>`;
  const cats = pts.map((p, i) => `<text class="chart__cat" x="${left + step * (i + 0.5)}" y="${H - bottom + 18}" text-anchor="middle">${escS(p.label)}</text>`).join("");
  if (chart === "line") {
    const xy = pts.map((p, i) => [left + step * (i + 0.5), y(p.value)]);
    const line = `<polyline class="chart__line${highlight ? " is-dim" : ""}" points="${xy.map(c => c.join(",")).join(" ")}"/>`;
    const dots = pts.map((p, i) => `<circle class="${cls(p)}" cx="${xy[i][0]}" cy="${xy[i][1]}" r="5">${tip(p)}</circle><text class="chart__val" x="${xy[i][0]}" y="${xy[i][1] - 12}" text-anchor="middle">${escS(short(p.value, percent))}</text>`).join("");
    return `<svg class="chart" viewBox="0 0 ${W} ${H}" ${aria}>${base}${line}${dots}${cats}</svg>`;
  }
  const bw = Math.min(64, step - 12);
  const bars = pts.map((p, i) => {
    const cx = left + step * (i + 0.5), y0 = y(0), y1 = y(p.value), len = Math.max(1, Math.abs(y0 - y1)), rr = Math.min(4, len / 2), x0 = cx - bw / 2, yt = Math.min(y0, y1);
    const d = `M${x0},${yt + len} v-${len - rr} a${rr},${rr} 0 0 1 ${rr},-${rr} h${bw - 2 * rr} a${rr},${rr} 0 0 1 ${rr},${rr} v${len - rr} Z`;
    return `<path class="${cls(p)}" d="${d}">${tip(p)}</path><text class="chart__val" x="${cx}" y="${yt - 8}" text-anchor="middle">${escS(short(p.value, percent))}</text>`;
  }).join("");
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" ${aria}>${base}${bars}${cats}</svg>`;
}

export function createStoryBuilder(host, opts = {}) {
  const { getResult, locked = false, onChange } = opts;
  const id = `story-${++stUid}`;
  let spec = opts.spec || null;
  let st = Object.assign({ series: "", chart: "", sort: "none", highlight: "", title: "", blanks: {} }, opts.state || {});
  host.innerHTML = `
  <div class="story" id="${id}">
    <div class="story__controls">
      <label class="pv-field"><span>Chart this series</span><select data-s="series"></select></label>
      <fieldset class="story__types"><legend>Chart type</legend>
        ${Object.entries(CHART_TYPES).map(([k, v]) => `<label><input type="radio" name="${id}-type" value="${k}" data-s="chart"> ${escS(v)}</label>`).join("")}</fieldset>
      <label class="pv-field"><span>Order</span><select data-s="sort">${Object.entries(SORTS).map(([k, v]) => `<option value="${k}">${escS(v)}</option>`).join("")}</select></label>
      <label class="pv-field"><span>Highlight</span><select data-s="highlight"></select></label>
    </div>
    <label class="story__title-field"><span>Chart title</span><input type="text" data-s="title" maxlength="90" spellcheck="true" autocomplete="off" placeholder="Say what the chart shows, not just what's on the axes"></label>
    <figure class="chart-frame">
      <figcaption class="chart-frame__title" data-title></figcaption>
      <div data-chart></div>
      <details class="chart-frame__data"><summary>Data</summary><div data-table></div></details>
    </figure>
    <div class="story__sentence" data-sentence hidden></div>
    <p class="clean__path"><span class="clean__app">Excel</span> Click the pivot ▸ PivotTable Analyze ▸ PivotChart; then Chart Design ▸ Change Chart Type, and click the title to type it<br><span class="clean__app">Sheets</span> Select the pivot ▸ Insert ▸ Chart; the Chart editor sets type and title</p>
  </div>`;
  const $ = s => host.querySelector(s);

  function options() {
    const res = getResult?.();
    const series = seriesOptions(res);
    if (!series.includes(st.series)) st.series = series.includes(GRAND) && !res?.colKeys?.length ? GRAND : series[0] || "";
    $('[data-s="series"]').innerHTML = series.length ? series.map(s => `<option${s === st.series ? " selected" : ""}>${escS(s)}</option>`).join("") : `<option value="">(build the pivot first)</option>`;
    const labels = res?.ready ? res.rowKeys : [];
    if (st.highlight && !labels.includes(st.highlight)) st.highlight = "";
    $('[data-s="highlight"]').innerHTML = `<option value="">(none)</option>` + labels.map(l => `<option${l === st.highlight ? " selected" : ""}>${escS(l)}</option>`).join("");
    return res;
  }
  function render() {
    const res = options();
    host.querySelectorAll('[data-s="chart"]').forEach(r => { r.checked = r.value === st.chart; r.disabled = locked; });
    $('[data-s="sort"]').value = st.sort; $('[data-s="title"]').value = st.title;
    host.querySelectorAll("select[data-s], input[data-s=title]").forEach(x => { x.disabled = locked; });
    $("[data-title]").textContent = st.title.trim() || "(untitled chart)";
    $("[data-title]").classList.toggle("is-empty", !st.title.trim());
    const pts = chartData(res, st.series, st.sort);
    $("[data-chart]").innerHTML = !st.chart ? `<p class="chart__empty">Pick a chart type.</p>` : chartSVG(pts, { chart: st.chart, highlight: st.highlight, percent: !!res?.percent, label: st.title || st.series });
    $("[data-table]").innerHTML = pts.length ? `<table class="pivot__table"><thead><tr><th scope="col">Item</th><th scope="col">${escS(st.series)}</th></tr></thead><tbody>${pts.map(p => `<tr><th scope="row">${escS(p.label)}</th><td>${escS(short(p.value, !!res?.percent))}</td></tr>`).join("")}</tbody></table>` : "";
    // The sentence is NOT rebuilt here: re-rendering it would steal focus from a blank you're typing in.
  }
  function renderSentence() {
    const box = $("[data-sentence]");
    if (!spec?.sentence) { box.hidden = true; box.innerHTML = ""; return; }
    box.hidden = false;
    const parts = sentenceParts(spec.sentence).map(p => {
      if (p.text !== undefined) return escS(p.text);
      const b = spec.blanks?.[p.blank] || { type: "number" }, v = st.blanks[p.blank] ?? "", lab = escS(b.label || p.blank);
      if (b.type === "choice") return `<select data-blank="${escS(p.blank)}" aria-label="${lab}"${locked ? " disabled" : ""}><option value="">(choose)</option>${(b.options || []).map(o => `<option${o === v ? " selected" : ""}>${escS(o)}</option>`).join("")}</select>`;
      return `<input type="text" inputmode="decimal" data-blank="${escS(p.blank)}" aria-label="${lab}" value="${escS(v)}" size="${b.size || 9}" autocomplete="off"${locked ? " disabled" : ""}>`;
    }).join("");
    box.innerHTML = `<p class="story__label">Your one-sentence insight</p><p class="story__line">${parts}</p>`;
  }
  const emit = () => onChange?.(api.state());
  host.addEventListener("change", e => {
    if (locked) return;
    const k = e.target.dataset?.s;
    if (k === "title") return; // handled on input; a re-render on blur would steal focus from the next field
    if (k) { st = { ...st, [k]: e.target.value }; render(); emit(); return; }
    if (e.target.dataset?.blank) { st = { ...st, blanks: { ...st.blanks, [e.target.dataset.blank]: e.target.value } }; emit(); }
  });
  host.addEventListener("input", e => {
    if (locked) return;
    if (e.target.dataset?.s === "title") { st = { ...st, title: e.target.value }; $("[data-title]").textContent = st.title.trim() || "(untitled chart)"; $("[data-title]").classList.toggle("is-empty", !st.title.trim()); emit(); }
    else if (e.target.dataset?.blank && e.target.tagName === "INPUT") { st = { ...st, blanks: { ...st.blanks, [e.target.dataset.blank]: e.target.value } }; emit(); }
  });
  const api = {
    state: () => ({ ...st, blanks: { ...st.blanks } }),
    refresh() { render(); },
    setSpec(s) { spec = s || null; renderSentence(); },
    setState(s) { st = Object.assign({ series: "", chart: "", sort: "none", highlight: "", title: "", blanks: {} }, s); render(); renderSentence(); emit(); },
    destroy() { host.innerHTML = ""; },
  };
  render();
  renderSentence();
  return api;
}
