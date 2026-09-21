/* Time-based one-time passwords, in node:crypto.

   RFC 6238, which is RFC 4226 counting time instead of events: HMAC-SHA1 over
   a 30-second counter, truncated to six digits. Every authenticator app
   implements the same thing, and the whole of it is the sixty lines below —
   which is why this is a file rather than a dependency in the path that
   protects sign-in.

   Three details that are easy to get wrong and expensive to get wrong.

   **A window, not an instant.** Phone clocks drift and people type slowly. One
   step either side of now is the accepted convention: ninety seconds of
   tolerance in exchange for one extra guess per attempt, which the rate
   limiter already bounds.

   **One use per step.** Without that, a code shoulder-surfed or captured in
   transit stays valid for the rest of its window. The caller records the step
   it accepted and refuses to accept the same one twice.

   **Constant-time comparison**, for the same reason as every other secret. */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export const STEP_SECONDS = 30;
export const DIGITS = 6;
/* One step either side. Two would be three minutes of validity for a code
   printed to be good for thirty seconds. */
export const WINDOW = 1;

/* Base32 without padding, as every authenticator app expects it. */
const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function generateSecret(bytes = 20) {
  return base32Encode(randomBytes(bytes));
}

export function base32Encode(buf) {
  let bits = 0, value = 0, out = "";
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(secret) {
  const clean = String(secret).toUpperCase().replace(/[^A-Z2-7]/g, "");
  let bits = 0, value = 0;
  const out = [];
  for (const ch of clean) {
    const idx = ALPHABET.indexOf(ch);
    if (idx === -1) continue;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

export function stepFor(atMs = Date.now()) {
  return Math.floor(atMs / 1000 / STEP_SECONDS);
}

/* The code for one counter value. Dynamic truncation per RFC 4226: the low
   nibble of the last byte picks where in the digest to read from, so an
   attacker cannot know in advance which bytes matter. */
export function codeForStep(secret, step) {
  const key = base32Decode(secret);
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));

  const digest = createHmac("sha1", key).update(counter).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const binary =
    ((digest[offset] & 0x7f) << 24) |
    ((digest[offset + 1] & 0xff) << 16) |
    ((digest[offset + 2] & 0xff) << 8) |
    (digest[offset + 3] & 0xff);

  return String(binary % 10 ** DIGITS).padStart(DIGITS, "0");
}

export function currentCode(secret, atMs = Date.now()) {
  return codeForStep(secret, stepFor(atMs));
}

/* Returns the step that matched, or null. The step is returned rather than a
   boolean so the caller can record it and refuse a replay — a code that stays
   valid for the rest of its window is a code somebody can reuse over your
   shoulder. */
export function verify(secret, submitted, { atMs = Date.now(), usedSteps = [] } = {}) {
  const code = String(submitted || "").replace(/\D/g, "");
  if (code.length !== DIGITS) return null;

  const now = stepFor(atMs);
  let matched = null;

  for (let drift = -WINDOW; drift <= WINDOW; drift++) {
    const step = now + drift;
    if (usedSteps.includes(step)) continue;
    /* Every candidate is compared, with no early exit, so the time taken does
       not reveal which step matched. */
    if (constantEquals(code, codeForStep(secret, step)) && matched === null) {
      matched = step;
    }
  }
  return matched;
}

function constantEquals(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  if (x.length !== y.length) return false;
  return timingSafeEqual(x, y);
}

/* The URI an authenticator app reads from a QR code. The issuer appears twice
   by convention — once as a prefix on the label and once as a parameter —
   because different apps read different ones. */
export function provisioningUri({ secret, account, issuer }) {
  const label = encodeURIComponent(`${issuer}:${account}`);
  const params = new URLSearchParams({
    secret,
    issuer,
    algorithm: "SHA1",
    digits: String(DIGITS),
    period: String(STEP_SECONDS),
  });
  return `otpauth://totp/${label}?${params}`;
}

/* --- recovery codes -------------------------------------------------------

   Without these, the failure mode of two-factor authentication is an
   administrator who changed phones and a support request nobody can satisfy.

   Formatted in groups because they are read off paper and typed by somebody
   who is already having a bad day. Ambiguous characters are excluded for the
   same reason the work-order reference excludes them. */
const RECOVERY_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export function generateRecoveryCodes(count = 10) {
  const codes = [];
  for (let i = 0; i < count; i++) {
    const bytes = randomBytes(10);
    let out = "";
    for (let j = 0; j < 10; j++) out += RECOVERY_ALPHABET[bytes[j] % RECOVERY_ALPHABET.length];
    codes.push(`${out.slice(0, 5)}-${out.slice(5)}`);
  }
  return codes;
}

export function normaliseRecoveryCode(code) {
  return String(code || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
}
