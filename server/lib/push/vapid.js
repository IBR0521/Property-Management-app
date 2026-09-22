/* VAPID — RFC 8292.

   The half of web push that says *who is sending*. A push service will not
   forward a message from an unidentified sender, so every request carries a
   short-lived JWT signed with an ECDSA P-256 key, plus that key's public half.

   Two details are worth stating because both are easy to get subtly wrong and
   neither fails loudly:

   **The signature format.** JOSE wants a raw 64-byte `r || s`, and ECDSA
   signing produces DER by default — `r` and `s` wrapped in ASN.1 with length
   prefixes and sometimes a leading zero byte. Sending DER produces a JWT that
   every push service rejects with an unhelpful message about the signature.
   Node will emit the JOSE form directly given `dsaEncoding: "ieee-p1363"`,
   which is why there is no conversion code here; writing one by hand is the
   usual way this is solved and it is unnecessary.

   **The audience.** It is the *origin* of the push endpoint, not the endpoint
   itself. `https://fcm.googleapis.com`, never
   `https://fcm.googleapis.com/fcm/send/abc…`. A JWT with the full path is
   refused, and the error says "invalid audience" without saying why. */
import {
  createSign, createVerify, createPrivateKey, createPublicKey, generateKeyPairSync,
} from "node:crypto";
import { toBase64Url, fromBase64Url } from "./encrypt.js";

/* Twelve hours. The spec allows twenty-four; shorter costs nothing because a
   token is minted per request anyway, and it bounds what a captured one is
   worth. */
export const TOKEN_TTL_SECONDS = 12 * 60 * 60;

/* --- keys -------------------------------------------------------------------

   Generated once and put in the environment. The public half is also handed to
   the browser when it subscribes, which is what ties a subscription to this
   sender: a message signed by anybody else is refused for that subscription. */
export function generateVapidKeys() {
  const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const pubRaw = publicKey.export({ type: "spki", format: "der" }).subarray(-65);
  const privJwk = privateKey.export({ format: "jwk" });
  return {
    publicKey: toBase64Url(pubRaw),
    privateKey: privJwk.d,        // already base64url in a JWK
  };
}

/* The private key arrives as a bare base64url scalar, which is the form every
   tool prints and no crypto API accepts. Rebuilt as a JWK, which is the least
   fiddly route into a KeyObject. */
function privateKeyObject(privateKeyBase64Url, publicKeyBase64Url) {
  const pub = fromBase64Url(publicKeyBase64Url);
  if (pub.length !== 65 || pub[0] !== 0x04) {
    throw new Error("VAPID_PUBLIC_KEY should be a 65-byte uncompressed P-256 point.");
  }
  return createPrivateKey({
    key: {
      kty: "EC", crv: "P-256",
      d: privateKeyBase64Url,
      x: toBase64Url(pub.subarray(1, 33)),
      y: toBase64Url(pub.subarray(33, 65)),
    },
    format: "jwk",
  });
}

/* --- the token --------------------------------------------------------------

   `subject` identifies a human a push service can contact if our messages
   become a problem. A mailto: or an https: URL, and they mean it. */
export function signToken({ audience, subject, publicKey, privateKey, now = Date.now() }) {
  if (!audience || !/^https?:\/\//.test(audience)) {
    throw new Error(`"${audience}" is not an origin.`);
  }
  if (!subject || !/^(mailto:|https:\/\/)/.test(subject)) {
    throw new Error("VAPID_SUBJECT must be a mailto: or https: URL a person can be reached at.");
  }

  const header = { typ: "JWT", alg: "ES256" };
  const claims = {
    aud: audience,
    exp: Math.floor(now / 1000) + TOKEN_TTL_SECONDS,
    sub: subject,
  };

  const signingInput = [header, claims]
    .map((part) => toBase64Url(Buffer.from(JSON.stringify(part), "utf8")))
    .join(".");

  const signer = createSign("SHA256");
  signer.update(signingInput);
  const signature = signer.sign({
    key: privateKeyObject(privateKey, publicKey),
    dsaEncoding: "ieee-p1363",
  });

  return `${signingInput}.${toBase64Url(signature)}`;
}

/* The origin of an endpoint, which is what the token's audience has to be. */
export function audienceFor(endpoint) {
  const url = new URL(endpoint);
  return `${url.protocol}//${url.host}`;
}

/* The header a push service reads. `t` is the token and `k` is the public key
   it should be checked against. */
export function authorizationHeader({ endpoint, subject, publicKey, privateKey, now }) {
  const token = signToken({
    audience: audienceFor(endpoint), subject, publicKey, privateKey, now,
  });
  return `vapid t=${token}, k=${publicKey}`;
}

/* Exported so a test can verify a token we signed rather than trusting that
   signing succeeded — the failure this guards against is a signature that is
   well-formed and wrong. */
export function verifyToken({ token, publicKey }) {
  const [headerPart, claimsPart, signaturePart] = String(token).split(".");
  if (!headerPart || !claimsPart || !signaturePart) return { ok: false, reason: "not three parts" };

  const signature = fromBase64Url(signaturePart);
  if (signature.length !== 64) return { ok: false, reason: "signature is not 64 bytes" };

  const pub = fromBase64Url(publicKey);
  const key = createPublicKey({
    key: {
      kty: "EC", crv: "P-256",
      x: toBase64Url(pub.subarray(1, 33)),
      y: toBase64Url(pub.subarray(33, 65)),
    },
    format: "jwk",
  });

  const verifier = createVerify("SHA256");
  verifier.update(`${headerPart}.${claimsPart}`);
  const ok = verifier.verify(
    { key, dsaEncoding: "ieee-p1363" }, signature);

  return {
    ok,
    reason: ok ? null : "signature does not verify",
    claims: JSON.parse(fromBase64Url(claimsPart).toString("utf8")),
  };
}
