/* QR codes, rendered as SVG.

   Printed on a sticker rather than shown on a screen, which drives two
   choices. Error correction is 'Q' (~25% recoverable) because a label above a
   kitchen sink gets splashed, scuffed and painted over, and a code that stops
   scanning at the first scratch is a support call. And the output is SVG, not
   PNG: it stays sharp at whatever size a printer runs it, it is a string so it
   inlines into the page with no second request, and it needs no image library.

   One <path> for every dark module rather than one <rect> each. A 33x33 code
   is ~500 dark modules; as rects that is 500 elements a print renderer has to
   lay out, as a single path it is one. */
import qrcode from "qrcode-generator";

/* Quiet zone. The spec says four modules of blank margin on every side and
   scanners genuinely do fail without it — this is the most common reason a
   hand-made QR code does not scan. */
const QUIET = 4;

export function qrSvg(text, { size = 160, label = "QR code" } = {}) {
  const qr = qrcode(0, "Q");          // 0 = pick the smallest version that fits
  qr.addData(String(text));
  qr.make();

  const n = qr.getModuleCount();
  const span = n + QUIET * 2;

  /* Walk each row and emit one horizontal run per unbroken stretch of dark
     modules, which is far fewer path commands than one per module. */
  let d = "";
  for (let y = 0; y < n; y++) {
    let x = 0;
    while (x < n) {
      if (!qr.isDark(y, x)) { x++; continue; }
      let run = 1;
      while (x + run < n && qr.isDark(y, x + run)) run++;
      d += `M${x + QUIET} ${y + QUIET}h${run}v1h-${run}z`;
      x += run;
    }
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${span} ${span}" `
    + `width="${size}" height="${size}" role="img" aria-label="${escapeAttr(label)}" `
    + `shape-rendering="crispEdges">`
    + `<rect width="${span}" height="${span}" fill="#fff"/>`
    + `<path d="${d}" fill="#000"/>`
    + `</svg>`;
}

function escapeAttr(v) {
  return String(v).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");
}
