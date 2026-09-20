/* Identifiers.
   - id():    sortable-ish opaque row id. Time prefix keeps inserts roughly in
              order on disk without leaking a countable sequence.
   - token(): unguessable link secret for tenant/owner/applicant URLs. These
              stand in for a password, so 32 bytes, not 8.
   - ref():   short human handle for a work order, spoken aloud on the phone.
              Excludes vowels and lookalikes so WO-B8K4 is never misheard. */
import { randomBytes, randomInt } from "node:crypto";

const SAFE = "BCDFGHJKLMNPQRSTVWXZ23456789";

export function id() {
  return Date.now().toString(36) + randomBytes(8).toString("hex");
}

export function token() {
  return randomBytes(32).toString("base64url");
}

export function ref(prefix = "WO") {
  let out = "";
  for (let i = 0; i < 4; i++) out += SAFE[randomInt(SAFE.length)];
  return `${prefix}-${out}`;
}
