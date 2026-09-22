/* Encrypting a web push payload — RFC 8291, `aes128gcm`.

   This is the kind of code that looks right and is wrong, so it is written
   against the published test vectors in RFC 8291 §5 rather than against a
   description of the algorithm. The RFC gives the input keys, the salt and
   the exact expected ciphertext; the test either reproduces that byte for
   byte or the implementation is broken. That is a better check than any
   amount of sending messages and seeing whether a phone buzzes.

   Everything here is `node:crypto`. The steps, in order:

     1. ECDH between our ephemeral key and the subscription's `p256dh`
     2. HKDF with the subscription's `auth` secret to get an IKM
     3. HKDF again with the salt to get a content key and a nonce
     4. AES-128-GCM over the payload plus a padding delimiter
     5. a header carrying the salt, the record size and our public key

   The header is the part people get wrong: it is part of the body, not a set
   of HTTP headers, and its byte order matters. */
import { createECDH, createHmac, randomBytes, createCipheriv } from "node:crypto";

const KEY_LENGTH = 16;      // AES-128
const NONCE_LENGTH = 12;
const SALT_LENGTH = 16;
const PUBLIC_KEY_LENGTH = 65;   // uncompressed P-256 point
const DEFAULT_RECORD_SIZE = 4096;

export function fromBase64Url(value) {
  return Buffer.from(String(value).replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

export function toBase64Url(buf) {
  return Buffer.from(buf).toString("base64")
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/* HKDF, the two halves kept separate because the web push spec uses extract
   on its own in one place and the pair in another. Node has `hkdfSync`, but
   spelling it out costs four lines and makes the RFC steps line up with the
   code, which is the whole point of this file. */
function hkdfExtract(salt, ikm) {
  return createHmac("sha256", salt).update(ikm).digest();
}

function hkdfExpand(prk, info, length) {
  /* One block is enough: nothing here asks for more than 32 bytes. */
  const out = createHmac("sha256", prk)
    .update(Buffer.concat([info, Buffer.from([1])]))
    .digest();
  return out.subarray(0, length);
}

/* "WebPush: info" || 0x00 || receiver public key || sender public key.

   The order is receiver first. Getting it the other way round produces a
   perfectly valid ciphertext that the browser cannot open, which is exactly
   the failure the test vectors catch. */
function authInfo(receiverPublicKey, senderPublicKey) {
  return Buffer.concat([
    Buffer.from("WebPush: info\0", "utf8"),
    receiverPublicKey,
    senderPublicKey,
  ]);
}

function contentInfo(label) {
  return Buffer.from(`Content-Encoding: ${label}\0`, "utf8");
}

/* The encrypted body a push service forwards verbatim.

   `salt` and `senderKeys` are parameters only so the RFC vectors can be
   reproduced; in real use both are generated fresh for every message, which
   is what makes the encryption safe. */
export function encryptPayload({
  payload, p256dh, auth,
  salt = randomBytes(SALT_LENGTH),
  senderPrivateKey = null,
  recordSize = DEFAULT_RECORD_SIZE,
}) {
  const receiverPublicKey = Buffer.isBuffer(p256dh) ? p256dh : fromBase64Url(p256dh);
  const authSecret = Buffer.isBuffer(auth) ? auth : fromBase64Url(auth);
  const plaintext = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload), "utf8");

  if (receiverPublicKey.length !== PUBLIC_KEY_LENGTH) {
    throw new Error(`A subscription key should be ${PUBLIC_KEY_LENGTH} bytes, not ${receiverPublicKey.length}.`);
  }
  if (authSecret.length !== 16) {
    throw new Error(`An auth secret should be 16 bytes, not ${authSecret.length}.`);
  }

  const ecdh = createECDH("prime256v1");
  if (senderPrivateKey) {
    ecdh.setPrivateKey(Buffer.isBuffer(senderPrivateKey)
      ? senderPrivateKey : fromBase64Url(senderPrivateKey));
  } else {
    ecdh.generateKeys();
  }
  const senderPublicKey = ecdh.getPublicKey();
  const sharedSecret = ecdh.computeSecret(receiverPublicKey);

  /* Step 2: mix the shared secret with the subscription's auth secret. This
     is what binds the ciphertext to this subscription rather than merely to
     this key pair. */
  const ikm = hkdfExpand(
    hkdfExtract(authSecret, sharedSecret),
    authInfo(receiverPublicKey, senderPublicKey),
    32);

  /* Step 3: the salt turns that into a key and a nonce for this one message. */
  const prk = hkdfExtract(salt, ikm);
  const contentKey = hkdfExpand(prk, contentInfo("aes128gcm"), KEY_LENGTH);
  const nonce = hkdfExpand(prk, contentInfo("nonce"), NONCE_LENGTH);

  /* A single record, so the delimiter is 0x02 — "this is the last one".
     0x01 would say another record follows and the browser would wait for it. */
  const record = Buffer.concat([plaintext, Buffer.from([2])]);

  const overhead = SALT_LENGTH + 4 + 1 + PUBLIC_KEY_LENGTH + 16;
  if (record.length + overhead > recordSize) {
    throw new Error(
      `That payload is ${payload.length} bytes and will not fit in one record. `
      + `Push payloads are short by design — send an identifier, not a document.`);
  }

  const cipher = createCipheriv("aes-128-gcm", contentKey, nonce);
  const ciphertext = Buffer.concat([
    cipher.update(record), cipher.final(), cipher.getAuthTag(),
  ]);

  /* The header, which is part of the body:
       salt (16) | record size (4, big endian) | key length (1) | key (65) */
  const header = Buffer.alloc(SALT_LENGTH + 4 + 1);
  salt.copy(header, 0);
  header.writeUInt32BE(recordSize, SALT_LENGTH);
  header.writeUInt8(PUBLIC_KEY_LENGTH, SALT_LENGTH + 4);

  return {
    body: Buffer.concat([header, senderPublicKey, ciphertext]),
    salt, senderPublicKey,
  };
}
