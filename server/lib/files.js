/* Upload storage.

   Two backends behind one function, chosen by whether a blob token is present:

     local   data/uploads/<yyyy-mm>/<id><ext>   — development, and any host
                                                  with a persistent disk
     blob    Vercel Blob                        — serverless, where the
                                                  filesystem does not survive
                                                  the request

   The stored name is always ours, never the client's filename, which is
   attacker-controlled. What goes in the database is a path for local storage
   or an absolute https URL for blob storage; fileUrl() below resolves either,
   so nothing else in the app has to know which backend is running. */
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "./db.js";

/* Local disk. On a serverless host this is replaced by blob storage — see
   storeUpload below. */
export const DATA_DIR = join(ROOT, "data");
export const UPLOAD_DIR = join(DATA_DIR, "uploads");

/* Deliberately NOT created at import time. On a serverless host the filesystem
   is read-only, so an mkdir here throws during module load and takes the whole
   function down before it can report why. The directory is created on the
   first local write instead, which is the only time it is needed. */
import { id } from "./ids.js";
import { IMAGE_TYPES, DOC_TYPES, LIMITS, BadRequest } from "./http.js";
import { BLOB_READ_WRITE_TOKEN, IS_SERVERLESS } from "./config.js";

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

const BLOB_TOKEN = BLOB_READ_WRITE_TOKEN;
export const USING_BLOB = Boolean(BLOB_TOKEN);
const SERVERLESS = IS_SERVERLESS;

/* Resolves what is stored in the database to something a browser can fetch. */
export function fileUrl(stored) {
  if (!stored) return "";
  return /^https?:\/\//.test(stored) ? stored : `/uploads/${stored}`;
}

export async function storeUpload(file, { allow = IMAGE_TYPES } = {}) {
  if (file.bytes > LIMITS.file) {
    throw new BadRequest(`${file.filename} is over ${Math.round(LIMITS.file / 1048576)}MB`);
  }
  const actual = sniff(file.data);
  if (!actual) throw new BadRequest(`${file.filename} is not a readable image or PDF`);
  if (!allow.has(actual)) throw new BadRequest(`${file.filename} is a ${actual}, which is not accepted here`);

  const month = new Date().toISOString().slice(0, 7);
  const rel = `${month}/${id()}${EXT[actual] || ".bin"}`;

  /* No blob store on a host with no writable disk: say so, and let the caller
     keep the rest of the submission. storeMany collects these per file, so a
     tenant's repair request is still filed even when its photo cannot be. */
  if (!USING_BLOB && SERVERLESS) {
    throw new BadRequest(
      "Photo uploads are not configured yet, so this image was not saved. " +
      "The rest of your request was received."
    );
  }

  if (USING_BLOB) {
    // addRandomSuffix is off because the name is already unguessable, and a
    // stable name means the URL in the database keeps working.
    const { put } = await import("@vercel/blob");
    const blob = await put(`uploads/${rel}`, file.data, {
      access: "public",
      contentType: actual,
      token: BLOB_TOKEN,
      addRandomSuffix: false,
    });
    return { path: blob.url, mime: actual, bytes: file.bytes };
  }

  mkdirSync(join(UPLOAD_DIR, month), { recursive: true });
  writeFileSync(join(UPLOAD_DIR, rel), file.data);
  return { path: rel, mime: actual, bytes: file.bytes };
}

/* Stores whatever image files came in on a field, quietly skipping empty file
   inputs. Returns what was stored plus any per-file complaints, so a bad
   third photo never loses the first two or the request itself. */
export async function storeMany(files, field, opts) {
  const stored = [];
  const problems = [];
  for (const f of files) {
    if (field && f.field !== field) continue;
    if (!f.bytes) continue;
    try {
      stored.push(await storeUpload(f, opts));
    } catch (err) {
      problems.push(err.message);
    }
  }
  return { stored, problems };
}

export { IMAGE_TYPES, DOC_TYPES };
