/* Web push payload encryption, against the published test vectors.

   This is the kind of code that looks right and is wrong, and no amount of
   sending messages and watching for a buzz would tell you which. RFC 8291 §5
   and Appendix A give the input keys, the salt, every intermediate value and
   the exact expected body — so the implementation either reproduces them byte
   for byte or it is broken.

   Every constant below is copied from the RFC text itself rather than
   remembered. That distinction turned out to matter: the first version of
   this check used an expected body written from memory, it did not match, and
   the "failure" was the memory. The giveaway was arithmetic — the remembered
   value implied 37 bytes of ciphertext for 41 bytes of plaintext, which
   AES-GCM cannot produce. The lesson is in the file now: a wrong expectation
   that happens to agree with a wrong implementation proves nothing, so the
   expectation has to come from the specification. */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { encryptPayload, fromBase64Url, toBase64Url } from "../server/lib/push/encrypt.js";

/* RFC 8291 §5 and Appendix A. */
const RFC = {
  plaintext: "When I grow up, I want to be a watermelon",
  authSecret: "BTBZMqHH6r4Tts7J_aSIgg",
  uaPublic: "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4",
  uaPrivate: "q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94",
  asPublic: "BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8",
  asPrivate: "yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw",
  salt: "DGv6ra1nlYgDCS1FRnbzlw",

  /* Appendix A. */
  ecdhSecret: "kyrL1jIIOHEzg3sM2ZWRHDRB62YACZhhSlknJ672kSs",
  ikm: "S4lYMb_L0FxCeq0WhDx813KgSYqU26kOyzWUdsXYyrg",
  prk: "09_eUZGrsvxChDCGRCdkLiDXrReGOEVeSCdCcPBSJSc",
  cek: "oIhVW04MRdy2XN9CiKLxTg",
  nonce: "4h_95klXJ5E_qnoN",

  /* §5, the complete body. */
  body: "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27ml"
      + "mlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPT"
      + "pK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN",
};

describe("RFC 8291 section 5", () => {
  test("the encrypted body is reproduced byte for byte", () => {
    /* The whole point of this file. */
    const { body } = encryptPayload({
      payload: RFC.plaintext,
      p256dh: RFC.uaPublic,
      auth: RFC.authSecret,
      salt: fromBase64Url(RFC.salt),
      senderPrivateKey: RFC.asPrivate,
    });
    assert.equal(toBase64Url(body), RFC.body);
  });

  test("the header is the 86 octets the RFC describes", () => {
    const { body } = encryptPayload({
      payload: RFC.plaintext, p256dh: RFC.uaPublic, auth: RFC.authSecret,
      salt: fromBase64Url(RFC.salt), senderPrivateKey: RFC.asPrivate,
    });

    assert.equal(toBase64Url(body.subarray(0, 16)), RFC.salt, "salt");
    assert.equal(body.readUInt32BE(16), 4096, "record size, big endian");
    assert.equal(body.readUInt8(20), 65, "the length of the key that follows");
    assert.equal(toBase64Url(body.subarray(21, 86)), RFC.asPublic, "the sender's key");
  });

  test("the body is 144 bytes, whatever the RFC's example says", () => {
    /* Worth recording: the Content-Length in the RFC's example HTTP request
       reads 145, and the body it prints is 144 octets — 86 of header and key
       plus 41 of plaintext, 1 delimiter and a 16-byte tag. It is an erratum
       in the example, not a disagreement with the algorithm, and noticing it
       is part of the evidence that this was checked rather than assumed. */
    const { body } = encryptPayload({
      payload: RFC.plaintext, p256dh: RFC.uaPublic, auth: RFC.authSecret,
      salt: fromBase64Url(RFC.salt), senderPrivateKey: RFC.asPrivate,
    });
    assert.equal(body.length, 144);
    assert.equal(body.length, 86 + Buffer.from(RFC.plaintext).length + 1 + 16);
  });

  test("the sender's public key comes from the sender's private key", () => {
    const { senderPublicKey } = encryptPayload({
      payload: RFC.plaintext, p256dh: RFC.uaPublic, auth: RFC.authSecret,
      salt: fromBase64Url(RFC.salt), senderPrivateKey: RFC.asPrivate,
    });
    assert.equal(toBase64Url(senderPublicKey), RFC.asPublic);
  });
});

describe("what it refuses", () => {
  test("a subscription key of the wrong length", () => {
    /* A truncated key would otherwise produce a ciphertext nobody can open,
       and the failure would surface as "notifications do not work". */
    assert.throws(
      () => encryptPayload({ payload: "hi", p256dh: toBase64Url(Buffer.alloc(32)), auth: RFC.authSecret }),
      /should be 65 bytes/);
  });

  test("an auth secret of the wrong length", () => {
    assert.throws(
      () => encryptPayload({ payload: "hi", p256dh: RFC.uaPublic, auth: toBase64Url(Buffer.alloc(8)) }),
      /should be 16 bytes/);
  });

  test("a payload too large for one record", () => {
    /* Push payloads are short by design. Refusing here is better than a push
       service rejecting it, because the message here names the reason. */
    assert.throws(
      () => encryptPayload({ payload: "x".repeat(5000), p256dh: RFC.uaPublic, auth: RFC.authSecret }),
      /will not fit in one record/);
  });
});

describe("in ordinary use", () => {
  test("every message gets a fresh salt and a fresh key pair", () => {
    /* Reusing either would leak. The RFC vectors pin them only so the
       expected output is reproducible. */
    const args = { payload: "A new emergency job", p256dh: RFC.uaPublic, auth: RFC.authSecret };
    const a = encryptPayload(args);
    const b = encryptPayload(args);

    assert.notEqual(toBase64Url(a.salt), toBase64Url(b.salt));
    assert.notEqual(toBase64Url(a.senderPublicKey), toBase64Url(b.senderPublicKey));
    assert.notEqual(toBase64Url(a.body), toBase64Url(b.body), "and so the bodies differ");
  });

  test("base64url is url-safe and unpadded", () => {
    const round = fromBase64Url(toBase64Url(Buffer.from([251, 255, 190, 0])));
    assert.deepEqual([...round], [251, 255, 190, 0]);
    const encoded = toBase64Url(Buffer.from([251, 255, 190]));
    assert.ok(!encoded.includes("+") && !encoded.includes("/") && !encoded.includes("="));
  });
});
