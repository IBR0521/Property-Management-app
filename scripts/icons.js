/* The PWA icons, generated rather than committed as opaque binaries.

   A home-screen icon has to be a PNG: SVG is accepted by some platforms and
   quietly ignored by the ones that matter most for installing. Rather than
   add an image library for four small squares, this writes the PNGs directly
   — a PNG is a signature, three chunks and a CRC, and `zlib` does the only
   hard part.

   The mark is the one already in the app: a ring with a dot at its centre.
   Two variants, because they are used differently:

     any        the icon as drawn, edge to edge
     maskable   the same mark inside a safe zone, because Android crops icons
                to whatever shape the launcher uses and a design that reaches
                the edge loses its corners

   Run with: npm run icons */
import { deflateSync } from "node:zlib";
import { writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, "..", "app-assets", "icons");

/* The app's own indigo, taken from the stylesheet rather than invented. */
const BRAND = [27, 24, 78];   // --brand-deep, #1b184e
const INK = [255, 255, 255];

function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = c ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

/* Truecolour, 8 bits a channel, no alpha — every launcher fills the square
   anyway and opaque avoids the halo a badly composited alpha channel gives. */
function png(width, height, pixels) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.writeUInt8(8, 8);      // bit depth
  ihdr.writeUInt8(2, 9);      // colour type: truecolour
  // compression, filter, interlace all 0

  /* Each scanline is prefixed with its filter type. Zero — "none" — because
     these images are flat colour and filtering would not repay the code. */
  const stride = width * 3;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    pixels.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/* The mark: a ring and a centre dot, on the brand colour.

   `safeZone` shrinks it for the maskable variant. Android may crop up to 20%
   from every edge, so the drawing stays inside the middle 60% and the corners
   are the launcher's to cut. */
function drawMark(size, { safeZone = 1 } = {}) {
  const pixels = Buffer.alloc(size * size * 3);
  const centre = (size - 1) / 2;
  const outer = (size * 0.34) * safeZone;
  const inner = (size * 0.25) * safeZone;
  const dot = (size * 0.11) * safeZone;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = x - centre;
      const dy = y - centre;
      const r = Math.sqrt(dx * dx + dy * dy);

      /* Anti-aliased by measuring how far into the band this pixel is, which
         at these sizes is the difference between a clean mark and a jagged
         one. */
      const ring = coverage(r, inner, outer);
      const middle = r <= dot ? 1 : r <= dot + 1 ? dot + 1 - r : 0;
      const ink = Math.min(1, Math.max(ring, middle));

      const at = (y * size + x) * 3;
      for (let c = 0; c < 3; c++) {
        pixels[at + c] = Math.round(BRAND[c] * (1 - ink) + INK[c] * ink);
      }
    }
  }
  return pixels;
}

/* How much of a pixel at radius `r` falls inside the band between `inner` and
   `outer`, softened by one pixel at each edge. */
function coverage(r, inner, outer) {
  if (r < inner - 1 || r > outer + 1) return 0;
  const rising = Math.min(1, Math.max(0, r - (inner - 1)));
  const falling = Math.min(1, Math.max(0, (outer + 1) - r));
  return Math.min(rising, falling);
}

mkdirSync(OUT, { recursive: true });

const made = [];
for (const [name, size, opts] of [
  ["icon-192.png", 192, {}],
  ["icon-512.png", 512, {}],
  ["maskable-192.png", 192, { safeZone: 0.62 }],
  ["maskable-512.png", 512, { safeZone: 0.62 }],
]) {
  const bytes = png(size, size, drawMark(size, opts));
  writeFileSync(join(OUT, name), bytes);
  made.push(`${name} — ${size}×${size}, ${bytes.length} bytes`);
}

console.log("Wrote to app-assets/icons:");
for (const line of made) console.log(`  ${line}`);
