/* Document templating, for text that becomes a legal instrument.

   scheduler.js has a one-line {{placeholder}} swap for SMS reminders. This is
   the same idea held to a higher standard, because the output is a lease:

     - Compiling reports which tokens went unresolved. A reminder with a stray
       {{name}} is embarrassing; a lease with a stray {{rent_amount}} is
       unenforceable, so the caller is told and can refuse to send it.
     - Markdown renders through an escape-first pipeline. The values come from
       tenant and owner records, which are typed by people, so a name
       containing a < would otherwise become markup inside a signed document.
     - No expressions, no conditionals, no loops. A template language in a
       lease is a way to produce a clause nobody reviewed. */

const TOKEN = /\{\{\s*([a-z0-9_]+)\s*\}\}/gi;

/* Returns the compiled text plus every token that had no value, so the caller
   decides what an incomplete document is worth. */
export function compile(body, vars) {
  const missing = new Set();
  const text = String(body ?? "").replace(TOKEN, (match, key) => {
    const k = key.toLowerCase();
    if (!Object.prototype.hasOwnProperty.call(vars, k)) { missing.add(k); return match; }
    const v = vars[k];
    if (v === null || v === undefined || v === "") { missing.add(k); return match; }
    return String(v);
  });
  return { text, missing: [...missing] };
}

/* Every token a template may use, listed so the editor can show them rather
   than leaving an author to guess and discover the gap at signing time. */
export function tokenList(vars) {
  return Object.keys(vars).sort();
}

export function tokensUsed(body) {
  const out = new Set();
  String(body ?? "").replace(TOKEN, (m, k) => { out.add(k.toLowerCase()); return m; });
  return [...out];
}

/* --- markdown ------------------------------------------------------------- */

/* A deliberately small subset: headings, bold, italic, lists, rules, and
   paragraphs. Everything else passes through as text.

   HTML is escaped first and never unescaped, so nothing in the source or in a
   substituted value can introduce a tag. That ordering is the whole security
   property of this function. */
export function markdownToHtml(md) {
  const lines = escapeHtml(String(md ?? "")).split(/\r?\n/);
  const out = [];
  let para = [];
  let list = null;                 // "ul" | "ol" | null

  const closeParagraph = () => {
    if (para.length) { out.push(`<p>${inline(para.join(" "))}</p>`); para = []; }
  };
  const closeList = () => { if (list) { out.push(`</${list}>`); list = null; } };

  for (const raw of lines) {
    const line = raw.trimEnd();

    if (!line.trim()) { closeParagraph(); closeList(); continue; }

    const heading = line.match(/^(#{1,4})\s+(.*)$/);
    if (heading) {
      closeParagraph(); closeList();
      const level = heading[1].length;
      out.push(`<h${level}>${inline(heading[2])}</h${level}>`);
      continue;
    }

    if (/^(-{3,}|\*{3,}|_{3,})$/.test(line.trim())) {
      closeParagraph(); closeList();
      out.push("<hr />");
      continue;
    }

    const ol = line.match(/^\s*\d+[.)]\s+(.*)$/);
    const ul = line.match(/^\s*[-*+]\s+(.*)$/);
    if (ol || ul) {
      closeParagraph();
      const want = ol ? "ol" : "ul";
      if (list !== want) { closeList(); out.push(`<${want}>`); list = want; }
      out.push(`<li>${inline((ol || ul)[1])}</li>`);
      continue;
    }

    closeList();
    para.push(line.trim());
  }
  closeParagraph(); closeList();
  return out.join("\n");
}

/* Bold, italic and inline code, applied to already-escaped text. */
function inline(s) {
  return s
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^*])\*([^*]+)\*/g, "$1<em>$2</em>")
    .replace(/`([^`]+)`/g, "<code>$1</code>");
}

function escapeHtml(s) {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
