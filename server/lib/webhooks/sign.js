/* Signing a webhook, and refusing to send one somewhere it must not go.

   ## The signature

   Standard Webhooks, because there is a specification and several libraries
   that already implement the verifying half — which is the half a customer
   has to write. Three headers:

       webhook-id           the delivery's own id
       webhook-timestamp    unix seconds
       webhook-signature    v1,<base64 HMAC-SHA256>

   and what is signed is `id.timestamp.body`.

   The id is in there deliberately. Signing only `timestamp.body` — which is
   what this was going to do — lets a capture of one delivery be replayed as
   a *different* delivery within the timestamp window, because nothing in the
   signed material says which one it is. With the id in it, a replay is
   recognisable as the delivery it actually was, and a receiver that records
   ids can refuse it.

   ## The address check, and why it happens at send time

   A webhook URL is a request this application makes on somebody else's
   instruction, from inside our network. That is server-side request forgery
   with a form in front of it, and the interesting targets are the addresses
   only we can reach: the cloud metadata service on 169.254.169.254, anything
   on loopback, anything on a private range.

   Checking the URL when it is saved is not enough and it is worth being
   precise about why. A hostname is resolved by DNS, DNS answers can change,
   and an attacker who controls a domain can point it at a public address on
   Tuesday and at 169.254.169.254 on Wednesday. So the name is resolved
   **every time something is about to be sent**, every address it resolves to
   is checked, and the connection is then pinned to the address that was
   checked — otherwise the name would be resolved a second time by the HTTP
   client and could answer differently in between. That second resolution is
   the whole of the DNS rebinding attack and skipping the pin leaves it open.

   ## https only

   The payload is a customer's data and the signature is a shared secret's
   output. Neither belongs on a plaintext connection, and "we will allow http
   for testing" is how that becomes permanent. */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/* --- the secret ------------------------------------------------------------- */

/* Prefixed the way the specification's examples are, so a receiver's library
   recognises it and a human recognises it in a config file. The prefix is not
   part of the key material. */
export function newSecret() {
  return `whsec_${randomBytes(24).toString("base64")}`;
}

function keyOf(secret) {
  const raw = String(secret || "").replace(/^whsec_/, "");
  /* Base64 if it decodes cleanly and round-trips; otherwise the bytes of the
     string as written. A secret somebody pasted by hand should still work. */
  try {
    const buf = Buffer.from(raw, "base64");
    if (buf.length && buf.toString("base64").replace(/=+$/, "") === raw.replace(/=+$/, "")) {
      return buf;
    }
  } catch { /* fall through */ }
  return Buffer.from(raw, "utf8");
}

/* --- signing ---------------------------------------------------------------- */

export function signaturePayload(id, timestamp, body) {
  return `${id}.${timestamp}.${body}`;
}

export function sign({ id, timestamp, body, secret }) {
  const mac = createHmac("sha256", keyOf(secret))
    .update(signaturePayload(id, timestamp, body), "utf8")
    .digest("base64");
  return `v1,${mac}`;
}

export function signedHeaders({ id, timestamp, body, secret }) {
  return {
    "webhook-id": String(id),
    "webhook-timestamp": String(timestamp),
    "webhook-signature": sign({ id, timestamp, body, secret }),
  };
}

/* The verifying half, which a customer writes and we do not need — except
   that having it here means the test can check a real receiver's work rather
   than our own arithmetic, and the documentation can show something that has
   been run. */
export function verify({ id, timestamp, body, secret, header, now = () => Date.now(), toleranceSeconds = 300 }) {
  const age = Math.abs(Math.floor(now() / 1000) - Number(timestamp));
  if (!Number.isFinite(age) || age > toleranceSeconds) {
    return { ok: false, reason: "timestamp outside the tolerance" };
  }
  const expected = sign({ id, timestamp, body, secret });
  /* A header may carry several versions, space separated, so a receiver can
     accept a key that is being rotated. */
  for (const candidate of String(header || "").split(/\s+/).filter(Boolean)) {
    if (equal(candidate, expected)) return { ok: true };
  }
  return { ok: false, reason: "no signature matched" };
}

function equal(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  if (x.length !== y.length) return false;
  return timingSafeEqual(x, y);
}

/* --- where it may be sent ---------------------------------------------------- */

export class WebhookRefused extends Error {
  constructor(message) {
    super(message);
    this.name = "WebhookRefused";
  }
}

/* Shape and scheme. Checked when a URL is saved so a person finds out then,
   and again before every send because saving is not sending. */
export function checkUrl(raw) {
  let url;
  try {
    url = new URL(String(raw || ""));
  } catch {
    return { ok: false, reason: "That is not a URL." };
  }
  if (url.protocol !== "https:") {
    return { ok: false,
      reason: "A webhook URL has to be https. The payload is your data and the signature "
        + "is a shared secret's output; neither belongs on a plaintext connection." };
  }
  if (url.username || url.password) {
    return { ok: false, reason: "Credentials in the URL are not accepted. Use the signature." };
  }
  /* A literal address short-circuits DNS, so it is classified here as well —
     otherwise https://169.254.169.254/ would pass a check that only looks at
     the scheme. */
  const literal = classify(url.hostname.replace(/^\[|\]$/g, ""));
  if (literal && !literal.public) {
    return { ok: false, reason: `That address is ${literal.why}, which this will not send to.` };
  }
  return { ok: true, url };
}

/* Every address a name resolves to has to be public. One bad answer among
   several is enough to refuse: a name that resolves to a public address and
   to 127.0.0.1 is a name whose owner is trying something. */
export async function resolveAndCheck(hostname, { lookup = defaultLookup } = {}) {
  const bare = String(hostname).replace(/^\[|\]$/g, "");

  const literal = classify(bare);
  if (literal) {
    if (!literal.public) {
      throw new WebhookRefused(`${bare} is ${literal.why}, which this will not send to.`);
    }
    return [{ address: bare, family: literal.family }];
  }

  let answers;
  try {
    answers = await lookup(bare);
  } catch (err) {
    throw new WebhookRefused(`${bare} does not resolve (${err.code || err.message}).`);
  }
  if (!answers.length) throw new WebhookRefused(`${bare} does not resolve to anything.`);

  for (const a of answers) {
    const verdict = classify(a.address);
    if (!verdict || !verdict.public) {
      throw new WebhookRefused(
        `${bare} resolves to ${a.address}, which is ${verdict ? verdict.why : "not an address "
        + "this understands"}. This will not send there.`);
    }
  }
  return answers;
}

async function defaultLookup(hostname) {
  const { lookup } = await import("node:dns/promises");
  return await lookup(hostname, { all: true, verbatim: true });
}

/* What an address is. Returns null when it is not an IP literal at all.

   The ranges are written out rather than pulled from a package because this
   is the list that decides whether a request reaches a cloud metadata
   service, and it should be readable by whoever is asking that question. */
export function classify(address) {
  const value = String(address || "").trim();

  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(value)) return classifyV4(value);
  if (value.includes(":")) return classifyV6(value);
  return null;
}

function classifyV4(value) {
  const parts = value.split(".").map(Number);
  if (parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
  const [a, b] = parts;
  const family = 4;

  if (a === 0) return { public: false, family, why: "the unspecified range" };
  if (a === 10) return { public: false, family, why: "a private range" };
  if (a === 127) return { public: false, family, why: "loopback" };
  if (a === 169 && b === 254) {
    /* 169.254.169.254 is the cloud metadata service on every major provider,
       and reaching it from inside a host hands over that host's credentials.
       The whole /16 is link-local and none of it is somewhere to send. */
    return { public: false, family, why: "link-local — this is where cloud metadata lives" };
  }
  if (a === 172 && b >= 16 && b <= 31) return { public: false, family, why: "a private range" };
  if (a === 192 && b === 168) return { public: false, family, why: "a private range" };
  if (a === 100 && b >= 64 && b <= 127) return { public: false, family, why: "carrier-grade NAT" };
  if (a === 192 && b === 0) return { public: false, family, why: "reserved" };
  if (a === 198 && (b === 18 || b === 19)) return { public: false, family, why: "benchmarking" };
  if (a === 198 && b === 51) return { public: false, family, why: "documentation" };
  if (a === 203 && b === 0) return { public: false, family, why: "documentation" };
  if (a >= 224 && a <= 239) return { public: false, family, why: "multicast" };
  if (a >= 240) return { public: false, family, why: "reserved" };

  return { public: true, family };
}

function classifyV6(value) {
  const lower = value.toLowerCase().split("%")[0];
  const family = 6;

  /* An IPv4-mapped address is an IPv4 address wearing a hat, and treating it
     as opaque IPv6 is how ::ffff:127.0.0.1 gets through. */
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(lower);
  if (mapped) return classifyV4(mapped[1]);
  const mappedHex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(lower);
  if (mappedHex) {
    const hi = parseInt(mappedHex[1], 16);
    const lo = parseInt(mappedHex[2], 16);
    return classifyV4(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
  }

  if (lower === "::" ) return { public: false, family, why: "the unspecified address" };
  if (lower === "::1") return { public: false, family, why: "loopback" };

  const head = parseInt(lower.split(":")[0] || "0", 16);
  if ((head & 0xfe00) === 0xfc00) return { public: false, family, why: "a unique local address" };
  if ((head & 0xffc0) === 0xfe80) return { public: false, family, why: "link-local" };
  if ((head & 0xff00) === 0xff00) return { public: false, family, why: "multicast" };
  /* 64:ff9b::/96 is NAT64, which translates to an arbitrary IPv4 address and
     is therefore a way round every rule above. */
  if (lower.startsWith("64:ff9b:")) return { public: false, family, why: "a NAT64 prefix" };

  return { public: true, family };
}
