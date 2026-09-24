/* WCAG contrast, computed from the stylesheets rather than eyeballed.

   The ratio is defined in WCAG 2.1 as (L1 + 0.05) / (L2 + 0.05), where L is
   relative luminance with the sRGB channels linearised. Both parts are here
   because the linearisation is the bit people leave out, and leaving it out
   makes mid-tones look better than they are — which is precisely the range
   where a secondary-text grey lives. */

export function parseHex(hex) {
  const h = hex.trim().replace(/^#/, "");
  const full = h.length === 3 ? h.split("").map((c) => c + c).join("") : h;
  if (!/^[0-9a-f]{6}$/i.test(full)) return null;
  return [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16));
}

export function luminance([r, g, b]) {
  const lin = [r, g, b].map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2];
}

export function contrast(fgHex, bgHex) {
  const fg = parseHex(fgHex), bg = parseHex(bgHex);
  if (!fg || !bg) return null;
  const a = luminance(fg), b = luminance(bg);
  const [hi, lo] = a > b ? [a, b] : [b, a];
  return (hi + 0.05) / (lo + 0.05);
}

/* Custom properties declared on :root, across however many stylesheets, with
   var() references resolved. Later files win, which is the order they are
   linked in. */
export function tokensFrom(sources) {
  const tokens = {};
  for (const css of sources) {
    for (const block of css.matchAll(/:root\s*\{([^}]*)\}/g)) {
      for (const m of block[1].matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/gi)) {
        tokens[m[1]] = m[2].trim();
      }
    }
  }
  for (let pass = 0; pass < 5; pass += 1) {
    for (const [name, value] of Object.entries(tokens)) {
      const m = value.match(/^var\((--[a-z0-9-]+)\)$/i);
      if (m && tokens[m[1]]) tokens[name] = tokens[m[1]];
    }
  }
  return tokens;
}

/* `#fff` and `var(--ink)` both resolve; anything else returns null so a pair
   naming a colour this cannot read fails loudly instead of passing. */
export function resolve(value, tokens) {
  const v = String(value).trim();
  const m = v.match(/^var\((--[a-z0-9-]+)\)$/i);
  if (m) return tokens[m[1]] ? resolve(tokens[m[1]], tokens) : null;
  return parseHex(v) ? v : null;
}
