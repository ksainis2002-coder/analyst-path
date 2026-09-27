/* =========================================================================
   ui/md.js: a deliberately small, safe Markdown subset for lesson text
   -------------------------------------------------------------------------
   Content JSON (spec §5.3) stores prose as Markdown. Supported:
     blocks:  paragraphs · "- " bullet lists · "1. " numbered lists ·
              "> " callouts, optionally typed: "> [!warn]", "> [!tip]", "> [!excel]"
     inline:  **bold** · *italic* · `code` (formulas and cell refs, shown in mono)
   Everything is HTML-escaped FIRST, so content can never inject markup.
   Pure string → string; no DOM.
   ========================================================================= */

const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

/** Inline Markdown → HTML (escaped). */
export function inline(src) {
  const codes = [];
  // Pull code spans out first so * and _ inside formulas are left alone.
  let s = esc(src).replace(/`([^`]+)`/g, (_, c) => { codes.push(c); return `\u0000${codes.length - 1}\u0000`; });
  s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
       .replace(/(^|[^*\w])\*([^*\s][^*]*?)\*(?![*\w])/g, "$1<em>$2</em>");
  return s.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code class="fx-chip">${codes[Number(i)]}</code>`);
}

const CALLOUT_TAGS = { warn: "Watch out", tip: "Tip", excel: "In Excel & Sheets", note: "Note" };

/** Block Markdown → HTML (escaped). */
export function markdown(src) {
  const lines = String(src ?? "").replace(/\r\n?/g, "\n").split("\n");
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }
    if (/^\s*[-*]\s+/.test(line)) {
      const items = [];
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) items.push(lines[i++].replace(/^\s*[-*]\s+/, ""));
      out.push(`<ul>${items.map(t => `<li>${inline(t)}</li>`).join("")}</ul>`);
    } else if (/^\s*\d+[.)]\s+/.test(line)) {
      const items = [];
      while (i < lines.length && /^\s*\d+[.)]\s+/.test(lines[i])) items.push(lines[i++].replace(/^\s*\d+[.)]\s+/, ""));
      out.push(`<ol>${items.map(t => `<li>${inline(t)}</li>`).join("")}</ol>`);
    } else if (/^\s*>/.test(line)) {
      const buf = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) buf.push(lines[i++].replace(/^\s*>\s?/, ""));
      let text = buf.join(" ").trim(), kind = "note";
      const m = /^\[!(\w+)\]\s*/.exec(text);
      if (m && CALLOUT_TAGS[m[1].toLowerCase()]) { kind = m[1].toLowerCase(); text = text.slice(m[0].length); }
      out.push(`<div class="callout callout--${kind}"><span class="callout__tag">${CALLOUT_TAGS[kind]}</span>${inline(text)}</div>`);
    } else {
      const buf = [];
      while (i < lines.length && lines[i].trim() && !/^\s*([-*]\s+|\d+[.)]\s+|>)/.test(lines[i])) buf.push(lines[i++].trim());
      out.push(`<p>${inline(buf.join(" "))}</p>`);
    }
  }
  return out.join("\n");
}
