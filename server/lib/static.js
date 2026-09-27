/* Static file serving.

   Two roots only: the marketing site at the project root, and the uploads
   directory. Paths are resolved and then checked to be inside their root, so
   a traversal attempt lands outside and is refused rather than served. */
import { createReadStream, statSync } from "node:fs";
import { join, resolve, extname, normalize, sep } from "node:path";
import { ROOT } from "./db.js";
import { UPLOAD_DIR } from "./files.js";

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  /* Not application/json: a manifest served as JSON is fetched and then
     ignored, and the browser says nothing about why. */
  ".webmanifest": "application/manifest+json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".heic": "image/heic",
  ".pdf": "application/pdf",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
};

function within(root, candidate) {
  const base = resolve(root);
  const full = resolve(base, "." + normalize("/" + String(candidate || "")));
  /* `startsWith(base)` alone treats `/data/uploads-secret` as inside
     `/data/uploads`. The separator makes the boundary a directory. */
  if (full !== base && !full.startsWith(base + sep)) return null;
  if (full === base) return null;
  return full;
}

export function serveFile(res, root, relPath, { download = null, cache = "no-cache" } = {}) {
  const full = within(root, relPath);
  if (!full) return false;

  let st;
  try {
    st = statSync(full);
  } catch {
    return false;
  }
  if (!st.isFile()) return false;

  const headers = {
    "Content-Type": TYPES[extname(full).toLowerCase()] || "application/octet-stream",
    "Content-Length": st.size,
    "Cache-Control": cache,
    "X-Content-Type-Options": "nosniff",
  };
  if (download) headers["Content-Disposition"] = `attachment; filename="${download.replace(/"/g, "")}"`;

  res.writeHead(200, headers);
  createReadStream(full).pipe(res);
  return true;
}

export const serveFromRoot = (res, rel, opts) => serveFile(res, ROOT, rel, opts);
export const serveUpload = (res, rel, opts) =>
  // Uploads are tenant photos and applicant documents: never cached by a
  // shared cache, and always served from the uploads root only.
  serveFile(res, UPLOAD_DIR, rel, { cache: "private, max-age=600", ...opts });
