/* A small HTML reader, for the accessibility tests.

   Not a parser in any respectable sense: it finds tags and their attributes,
   and it tracks enough nesting to answer "is this input inside a label". That
   is all the checks here need, and it avoids adding a dependency to a project
   that has deliberately not taken any.

   It is deliberately literal about what it does not know. `textOf` reads the
   raw text between a tag and its close, so an element whose accessible name
   comes from a CSS pseudo-element will read as nameless — which is the right
   answer for a screen reader too. */

const VOID = new Set([
  "area", "base", "br", "col", "embed", "hr", "img", "input", "link",
  "meta", "param", "source", "track", "wbr",
]);

/* Attributes off one tag's source text. Handles quoted, single-quoted and
   bare values, and boolean attributes with no value at all. */
export function attrsOf(tagSource) {
  const attrs = {};
  const re = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)(\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
  let m;
  let first = true;
  while ((m = re.exec(tagSource))) {
    if (first) { first = false; continue; } // the tag name itself
    const name = m[1].toLowerCase();
    attrs[name] = m[4] ?? m[5] ?? m[6] ?? "";
  }
  return attrs;
}

/* Every element of the given names, in document order, with its attributes,
   its source offset, and the stack of ancestor tag names above it. */
export function elements(html, names) {
  const want = new Set(names.map((n) => n.toLowerCase()));
  const out = [];
  const stack = [];
  const re = /<(\/?)([a-zA-Z][a-zA-Z0-9-]*)((?:"[^"]*"|'[^']*'|[^>"'])*)>/g;
  let m;
  while ((m = re.exec(html))) {
    const closing = m[1] === "/";
    const name = m[2].toLowerCase();
    const selfClosing = /\/\s*$/.test(m[3]) || VOID.has(name);

    if (closing) {
      for (let i = stack.length - 1; i >= 0; i -= 1) {
        if (stack[i].name === name) { stack.length = i; break; }
      }
      continue;
    }

    if (want.has(name)) {
      out.push({
        name,
        attrs: attrsOf(m[0]),
        start: m.index,
        end: m.index + m[0].length,
        ancestors: stack.map((s) => s.name),
        ancestorAttrs: stack.map((s) => s.attrs),
        source: m[0],
      });
    }
    if (!selfClosing) stack.push({ name, attrs: attrsOf(m[0]) });
  }
  return out;
}

/* The text inside an element, tags stripped, entities loosened. Used for
   accessible names, so `aria-hidden` subtrees are dropped: a screen reader
   would not read them either. */
export function textOf(html, el) {
  if (VOID.has(el.name)) return "";
  const close = new RegExp(`</${el.name}\\s*>`, "gi");
  close.lastIndex = el.end;
  let depth = 1;
  const open = new RegExp(`<${el.name}[\\s>]`, "gi");
  let cursor = el.end;
  let endAt = html.length;
  while (depth > 0) {
    close.lastIndex = cursor;
    const c = close.exec(html);
    if (!c) break;
    open.lastIndex = cursor;
    let o = open.exec(html);
    while (o && o.index < c.index) {
      depth += 1;
      open.lastIndex = o.index + 1;
      o = open.exec(html);
    }
    depth -= 1;
    cursor = c.index + c[0].length;
    endAt = c.index;
  }
  return html.slice(el.end, endAt)
    .replace(/<[^>]*aria-hidden=["']?true[^>]*>[\s\S]*?<\/[a-zA-Z]+>/g, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&[a-z]+;|&#\d+;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/* Does this control have a name a screen reader would announce? */
export function accessibleName(html, el, ids) {
  const a = el.attrs;
  if (a["aria-label"]?.trim()) return a["aria-label"].trim();
  if (a["aria-labelledby"]?.trim()) {
    const named = a["aria-labelledby"].split(/\s+/).filter((r) => ids.has(r));
    if (named.length) return named.join(" ");
  }
  if (a.title?.trim()) return a.title.trim();
  if (el.name === "input") {
    const type = (a.type || "text").toLowerCase();
    if (type === "submit" || type === "button" || type === "reset") return (a.value || "").trim();
    if (type === "image") return (a.alt || "").trim();
  }
  const text = textOf(html, el);
  if (text) return text;
  return "";
}

/* Every id in the document, so `for=` and `aria-labelledby` can be checked
   against something real rather than assumed to point somewhere. */
export function idsIn(html) {
  const ids = new Set();
  const re = /\sid\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/g;
  let m;
  while ((m = re.exec(html))) ids.add(m[2] ?? m[3] ?? m[4]);
  return ids;
}

/* Form controls that need a label. Hidden inputs and buttons are excluded:
   the first is not perceivable at all, the second is named by its own text. */
export function labelableControls(html) {
  return elements(html, ["input", "select", "textarea"]).filter((el) => {
    const type = (el.attrs.type || "text").toLowerCase();
    if (el.name === "input" && ["hidden", "submit", "button", "reset"].includes(type)) return false;
    return true;
  });
}

/* Which control each <label for=...> points at. */
export function labelTargets(html) {
  const targets = new Map();
  for (const el of elements(html, ["label"])) {
    const target = el.attrs.for;
    if (target) targets.set(target, textOf(html, el));
  }
  return targets;
}
