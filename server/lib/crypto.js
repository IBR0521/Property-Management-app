/* Sealed fields.

   Two things in this database would turn a leaked backup into somebody else's
   emergency rather than ours: a bank aggregator access token, and a
   contractor's taxpayer identification number. Both are stored sealed, so a
   dump, a stolen snapshot, or a read-only SQL injection yields ciphertext.

   AES-256-GCM, because it authenticates as well as encrypts: a tampered
   ciphertext fails to open rather than decrypting to something plausible. The
   key lives in the environment and never in this database — storing it
   alongside the data it protects would be an elaborate way of storing
   plaintext.

   Format:  v1.<iv>.<tag>.<ciphertext>   each part base64url

   The version prefix is there so the format can change without a migration
   that has to guess what it is looking at. */
import { createCipheriv, createDecipheriv, randomBytes, createHash, timingSafeEqual } from "node:crypto";
import { APP_ENCRYPTION_KEY } from "./config.js";

const ALGO = "aes-256-gcm";
const IV_BYTES = 12;          // 96 bits, the size GCM is specified for
const KEY_BYTES = 32;

let cached;

/* The key, as 32 raw bytes. Accepts base64 or hex so that whatever the host's
   secret manager produces can be pasted in without a conversion step. */
function key() {
  if (cached) return cached;
  const raw = APP_ENCRYPTION_KEY;
  if (!raw) {
    throw new Error(
      "APP_ENCRYPTION_KEY is not set. Generate one with:\n" +
      "  node -e \"console.log(require('crypto').randomBytes(32).toString('base64'))\""
    );
  }
  const buf = /^[0-9a-f]{64}$/i.test(raw.trim())
    ? Buffer.from(raw.trim(), "hex")
    : Buffer.from(raw.trim(), "base64");
  if (buf.length !== KEY_BYTES) {
    throw new Error(`APP_ENCRYPTION_KEY must be ${KEY_BYTES} bytes; got ${buf.length}`);
  }
  cached = buf;
  return cached;
}

/* Whether sealing is available at all. Pages use this to say "encryption is not
   configured" instead of throwing a 500 at somebody who only wanted to look at
   a list. */
export function sealingAvailable() {
  try { key(); return true; } catch { return false; }
}

export function seal(plaintext) {
  if (plaintext == null || plaintext === "") return null;
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGO, key(), iv);
  const body = Buffer.concat([cipher.update(String(plaintext), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ["v1", b64(iv), b64(tag), b64(body)].join(".");
}

export function open(sealed) {
  if (sealed == null || sealed === "") return null;
  const parts = String(sealed).split(".");
  if (parts.length !== 4 || parts[0] !== "v1") {
    throw new Error("sealed value is not in the expected format");
  }
  const [, iv, tag, body] = parts;
  const decipher = createDecipheriv(ALGO, key(), unb64(iv));
  decipher.setAuthTag(unb64(tag));
  // Throws if the ciphertext or the tag was altered, which is the point.
  return Buffer.concat([decipher.update(unb64(body)), decipher.final()]).toString("utf8");
}

/* Open without throwing, for read paths that should degrade rather than fail:
   a vendor list should still render if one TIN was sealed under a rotated key. */
export function tryOpen(sealed) {
  try { return open(sealed); } catch { return null; }
}

/* --- hashes --------------------------------------------------------------- */

export function sha256(value) {
  return createHash("sha256").update(String(value), "utf8").digest("hex");
}

/* Compare two hex digests without leaking where they diverge. */
export function hashesMatch(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

const b64 = (buf) => buf.toString("base64url");
const unb64 = (s) => Buffer.from(s, "base64url");
