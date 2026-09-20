/* HTML templating.

   A tagged template that escapes every interpolation by default. Nested
   html`` results and arrays of them pass through unescaped because they are
   already Safe; everything else — including anything a tenant typed — gets
   escaped. Escaping by default is the only version of this that stays safe
   once the file is long. */

class Safe {
  constructor(value) { this.value = value; }
  toString() { return this.value; }
}

export function raw(value) {
  return new Safe(String(value ?? ""));
}

export function escape(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function resolve(value) {
  if (value == null || value === false) return "";
  if (value instanceof Safe) return value.value;
  if (Array.isArray(value)) return value.map(resolve).join("");
  return escape(value);
}

export function html(strings, ...values) {
  let out = strings[0];
  for (let i = 0; i < values.length; i++) out += resolve(values[i]) + strings[i + 1];
  return new Safe(out);
}

export function doc(safe) {
  return `<!doctype html>\n${safe}`;
}

/* Conditional class helper: cls("btn", isOn && "btn--on") */
export function cls(...parts) {
  return parts.filter(Boolean).join(" ");
}

/* Attribute helper for optional attributes: attr("disabled", isDisabled) */
export function attr(name, value) {
  if (value === true) return raw(` ${name}`);
  if (value == null || value === false || value === "") return raw("");
  return raw(` ${name}="${escape(value)}"`);
}
