/* Upload storage.

   Files land in data/uploads/<yyyy-mm>/<id><ext> so a directory never grows
   without bound, and the stored name is ours — never the client's filename,
   which is attacker-controlled. */
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { UPLOAD_DIR } from "./db.js";
import { id } from "./ids.js";
import { IMAGE_TYPES, DOC_TYPES, LIMITS, BadRequest } from "./http.js";

const EXT = {
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp",
  "image/heic": ".heic",
  "image/heif": ".heic",
  "application/pdf": ".pdf",
};

/* Magic-byte check. A browser will happily label anything image/jpeg, so the
   declared type is a hint and the first bytes are the evidence. */
function sniff(buf) {
  if (buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
  if (buf.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (buf.slice(0, 4).toString("ascii") === "RIFF" && buf.slice(8, 12).toString("ascii") === "WEBP") return "image/webp";
  if (buf.slice(4, 8).toString("ascii") === "ftyp") {
    const brand = buf.slice(8, 12).toString("ascii");
    if (brand.startsWith("heic") || brand.startsWith("heix") || brand.startsWith("mif1")) return "image/heic";
  }
  if (buf.slice(0, 5).toString("ascii") === "%PDF-") return "application/pdf";
  return null;
}

export function storeUpload(file, { allow = IMAGE_TYPES } = {}) {
  if (file.bytes > LIMITS.file) {
    throw new BadRequest(`${file.filename} is over ${Math.round(LIMITS.file / 1048576)}MB`);
  }
  const actual = sniff(file.data);
  if (!actual) throw new BadRequest(`${file.filename} is not a readable image or PDF`);
  if (!allow.has(actual)) throw new BadRequest(`${file.filename} is a ${actual}, which is not accepted here`);

  const month = new Date().toISOString().slice(0, 7);
  mkdirSync(join(UPLOAD_DIR, month), { recursive: true });
  const rel = `${month}/${id()}${EXT[actual] || ".bin"}`;
  writeFileSync(join(UPLOAD_DIR, rel), file.data);
  return { path: rel, mime: actual, bytes: file.bytes };
}

/* Stores whatever image files came in on a field, quietly skipping empty file
   inputs. Returns what was stored plus any per-file complaints, so a bad
   third photo never loses the first two or the request itself. */
export function storeMany(files, field, opts) {
  const stored = [];
  const problems = [];
  for (const f of files) {
    if (field && f.field !== field) continue;
    if (!f.bytes) continue;
    try {
      stored.push(storeUpload(f, opts));
    } catch (err) {
      problems.push(err.message);
    }
  }
  return { stored, problems };
}

export { IMAGE_TYPES, DOC_TYPES };
