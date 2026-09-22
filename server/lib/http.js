/* Request and response plumbing.

   Hand-rolled rather than pulled from npm: the whole surface this app needs is
   a form parser, a multipart parser, cookies and a few send helpers. That is a
   few hundred lines I can read, against a dependency tree I cannot. */
import { randomBytes, timingSafeEqual } from "node:crypto";

/* Caps exist so a single request cannot exhaust memory. Photos from a phone
   are routinely 3-6MB, so the per-file ceiling has to be generous. */
export const LIMITS = {
  body: 30 * 1024 * 1024,
  file: 10 * 1024 * 1024,
  files: 8,
};

export const IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/heic", "image/heif"]);
export const DOC_TYPES = new Set([...IMAGE_TYPES, "application/pdf"]);

export function readBody(req, limit = LIMITS.body) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > limit) {
        reject(new PayloadTooLarge(`body over ${Math.round(limit / 1048576)}MB`));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

/* Parses application/x-www-form-urlencoded into a plain object. Repeated keys
   collapse into an array, which is what checkbox groups post. */
export function parseUrlEncoded(buf) {
  const out = Object.create(null);
  const params = new URLSearchParams(buf.toString("utf8"));
  for (const [k, v] of params) {
    if (k in out) out[k] = [].concat(out[k], v);
    else out[k] = v;
  }
  return out;
}

/* Minimal multipart/form-data parser.

   Splits on the boundary, then each part at the header/body break. Kept
   deliberately strict: anything that does not look like a well-formed part is
   skipped rather than guessed at. */
export function parseMultipart(buf, contentType) {
  const match = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType || "");
  if (!match) throw new BadRequest("multipart without boundary");
  const boundary = Buffer.from(`--${(match[1] || match[2]).trim()}`);

  const fields = Object.create(null);
  const files = [];

  let pos = buf.indexOf(boundary);
  if (pos === -1) throw new BadRequest("multipart boundary not found in body");
  pos += boundary.length;

  while (pos < buf.length) {
    // "--" straight after a boundary marks the end of the payload.
    if (buf[pos] === 0x2d && buf[pos + 1] === 0x2d) break;
    if (buf[pos] === 0x0d && buf[pos + 1] === 0x0a) pos += 2;

    const next = buf.indexOf(boundary, pos);
    const end = next === -1 ? buf.length : next;

    const headerEnd = buf.indexOf("\r\n\r\n", pos);
    if (headerEnd === -1 || headerEnd > end) break;

    const headers = buf.slice(pos, headerEnd).toString("utf8");
    // Parts end with CRLF before the next boundary; that CRLF is not content.
    let bodyEnd = end;
    if (buf[bodyEnd - 2] === 0x0d && buf[bodyEnd - 1] === 0x0a) bodyEnd -= 2;
    const body = buf.slice(headerEnd + 4, bodyEnd);

    const nameMatch = /name="([^"]*)"/i.exec(headers);
    const fileMatch = /filename="([^"]*)"/i.exec(headers);
    const typeMatch = /content-type:\s*([^\r\n;]+)/i.exec(headers);

    if (nameMatch) {
      const name = nameMatch[1];
      if (fileMatch && fileMatch[1]) {
        if (body.length > 0 && files.length < LIMITS.files) {
          files.push({
            field: name,
            filename: fileMatch[1],
            mime: (typeMatch ? typeMatch[1].trim() : "application/octet-stream"),
            bytes: body.length,
            data: body,
          });
        }
      } else {
        const value = body.toString("utf8");
        if (name in fields) fields[name] = [].concat(fields[name], value);
        else fields[name] = value;
      }
    }

    if (next === -1) break;
    pos = next + boundary.length;
  }

  return { fields, files };
}

export async function parseRequestBody(req) {
  const type = req.headers["content-type"] || "";
  const buf = await readBody(req);
  if (type.startsWith("multipart/form-data")) return parseMultipart(buf, type);
  if (type.startsWith("application/json")) {
    try {
      return { fields: buf.length ? JSON.parse(buf.toString("utf8")) : {}, files: [] };
    } catch {
      throw new BadRequest("invalid JSON body");
    }
  }
  return { fields: parseUrlEncoded(buf), files: [] };
}

/* --- cookies -------------------------------------------------------------- */

export function cookies(req) {
  const out = Object.create(null);
  const raw = req.headers.cookie;
  if (!raw) return out;
  for (const part of raw.split(";")) {
    const i = part.indexOf("=");
    if (i === -1) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export function setCookie(res, name, value, opts = {}) {
  const bits = [`${name}=${encodeURIComponent(value)}`, "Path=/", "HttpOnly", "SameSite=Lax"];
  if (opts.maxAge != null) bits.push(`Max-Age=${opts.maxAge}`);
  if (opts.expires) bits.push(`Expires=${opts.expires.toUTCString()}`);
  // Secure is set by the caller in production; localhost over http would
  // silently drop the cookie otherwise.
  if (opts.secure) bits.push("Secure");
  const existing = res.getHeader("Set-Cookie");
  res.setHeader("Set-Cookie", existing ? [].concat(existing, bits.join("; ")) : bits.join("; "));
}

export function clearCookie(res, name) {
  res.setHeader("Set-Cookie", `${name}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}

/* --- responses ------------------------------------------------------------ */

/* Content-Security-Policy for pages this handler renders. None of them carry
   an inline <script>, so script-src stays at 'self' and an injected <script>
   tag has nothing to execute. Inline STYLE is allowed because the app uses
   style attributes throughout; style injection is a far smaller problem than
   script injection, and every interpolation is escaped anyway.

   frame-ancestors 'none' stops clickjacking, form-action 'self' stops an
   injected form posting credentials to another origin, and object-src 'none'
   removes the plugin surface entirely. */
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com",
  "img-src 'self' data: blob: https://*.public.blob.vercel-storage.com",
  "connect-src 'self'",
  /* The install metadata and the service worker. Both default to
     default-src, which is already 'self' — named explicitly so that
     narrowing default-src later cannot silently break installing. */
  "manifest-src 'self'",
  "worker-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "object-src 'none'",
].join("; ");

const SECURITY_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "X-Frame-Options": "DENY",
  "Content-Security-Policy": CSP,
  "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
  "Cross-Origin-Opener-Policy": "same-origin",
};

/* HSTS only over HTTPS. Sending it on a plaintext response is meaningless and
   on localhost it would pin the developer's browser to https for a year. */
export function securityHeaders(req) {
  return isHttps(req)
    ? { ...SECURITY_HEADERS, "Strict-Transport-Security": "max-age=31536000; includeSubDomains" }
    : SECURITY_HEADERS;
}

/* Behind Vercel the socket is plain HTTP and the real scheme arrives in a
   header. Getting this wrong is how the session cookie ends up without its
   Secure flag in production. */
export function isHttps(req) {
  const proto = req.headers["x-forwarded-proto"];
  if (typeof proto === "string" && proto.length) return proto.split(",")[0].trim() === "https";
  return Boolean(req.socket && req.socket.encrypted);
}

export function sendHtml(res, html, status = 200, extra = {}) {
  res.writeHead(status, {
    "Content-Type": "text/html; charset=utf-8",
    "Content-Length": Buffer.byteLength(html),
    ...(res.req ? securityHeaders(res.req) : SECURITY_HEADERS),
    ...extra,
  });
  res.end(html);
}

export function sendJson(res, data, status = 200) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    ...(res.req ? securityHeaders(res.req) : SECURITY_HEADERS),
  });
  res.end(body);
}

export function redirect(res, location, status = 303) {
  res.writeHead(status, { Location: location, ...SECURITY_HEADERS });
  res.end();
}

export function sendText(res, text, status = 200) {
  res.writeHead(status, { "Content-Type": "text/plain; charset=utf-8", ...SECURITY_HEADERS });
  res.end(text);
}

/* --- csrf ----------------------------------------------------------------- */

/* Double-submit token. The cookie is readable by our own pages only; a
   cross-site POST cannot set the matching form field. */
export function csrfToken(req, res) {
  const jar = cookies(req);
  if (jar.csrf) return jar.csrf;
  const value = randomBytes(24).toString("base64url");
  setCookie(res, "csrf", value, { maxAge: 60 * 60 * 12 });
  return value;
}

export function checkCsrf(req, fields) {
  const jar = cookies(req);
  const sent = fields && fields._csrf;
  if (!jar.csrf || typeof sent !== "string") return false;
  return timingSafeCompare(jar.csrf, sent);
}

/* Length is compared first because timingSafeEqual throws on a mismatch, and
   the length of a CSRF token is not a secret. */
export function timingSafeCompare(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  if (x.length !== y.length) return false;
  return timingSafeEqual(x, y);
}

/* --- errors --------------------------------------------------------------- */

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
export class BadRequest extends HttpError {
  constructor(m = "bad request") { super(400, m); }
}
export class Unauthorized extends HttpError {
  constructor(m = "sign in required") { super(401, m); }
}
export class Forbidden extends HttpError {
  constructor(m = "not allowed") { super(403, m); }
}
export class PayloadTooLarge extends HttpError {
  constructor(m = "too large") { super(413, m); }
}
