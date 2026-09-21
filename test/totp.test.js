/* TOTP.

   The important test here is the first one. Everything else in this suite
   checks that our code agrees with itself; this checks that it agrees with
   RFC 6238's published vectors, which is what determines whether a code from
   Google Authenticator will actually work. An implementation that round-trips
   perfectly against its own output and disagrees with the spec is worse than
   no implementation, because it fails only in the hands of real users. */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  generateSecret, base32Encode, base32Decode, codeForStep, currentCode,
  verify, stepFor, provisioningUri, generateRecoveryCodes, normaliseRecoveryCode,
  STEP_SECONDS, DIGITS, WINDOW,
} from "../server/lib/totp.js";

/* The RFC's SHA-1 test key is the ASCII string "12345678901234567890". */
const RFC_SECRET = base32Encode(Buffer.from("12345678901234567890", "ascii"));

describe("agreement with RFC 6238", () => {
  /* The RFC prints eight-digit codes; a six-digit implementation is the same
     truncation taken modulo a smaller power of ten, so these are the last six
     digits of each published value. */
  const vectors = [
    [59,          "287082"],
    [1111111109,  "081804"],
    [1111111111,  "050471"],
    [1234567890,  "005924"],
    [2000000000,  "279037"],
    [20000000000, "353130"],
  ];

  for (const [unixTime, expected] of vectors) {
    test(`t=${unixTime} produces ${expected}`, () => {
      const step = Math.floor(unixTime / STEP_SECONDS);
      assert.equal(codeForStep(RFC_SECRET, step), expected);
    });
  }
});

describe("base32", () => {
  test("round-trips arbitrary bytes", () => {
    for (let n = 1; n <= 24; n++) {
      const buf = Buffer.alloc(n, n);
      assert.deepEqual(base32Decode(base32Encode(buf)), buf, `${n} bytes`);
    }
  });

  test("ignores the spacing and casing people type", () => {
    const secret = generateSecret();
    const mangled = secret.toLowerCase().replace(/(.{4})/g, "$1 ");
    assert.deepEqual(base32Decode(mangled), base32Decode(secret),
      "a secret read off a screen arrives with spaces in it");
  });
});

describe("verification", () => {
  const secret = generateSecret();
  const now = 1_780_000_000_000;

  test("the current code is accepted", () => {
    const code = currentCode(secret, now);
    assert.equal(verify(secret, code, { atMs: now }), stepFor(now));
  });

  test("a wrong code is not", () => {
    assert.equal(verify(secret, "000000", { atMs: now }), null);
    assert.equal(verify(secret, "", { atMs: now }), null);
    assert.equal(verify(secret, "12345", { atMs: now }), null);
  });

  test("one step of drift either way is tolerated", () => {
    /* Phone clocks drift and people type slowly. Ninety seconds of tolerance
       costs one extra guess per attempt, which the rate limiter bounds. */
    for (const drift of [-1, 0, 1]) {
      const code = codeForStep(secret, stepFor(now) + drift);
      assert.ok(verify(secret, code, { atMs: now }) !== null, `drift ${drift}`);
    }
  });

  test("two steps away is not", () => {
    for (const drift of [-2, 2]) {
      const code = codeForStep(secret, stepFor(now) + drift);
      assert.equal(verify(secret, code, { atMs: now }), null, `drift ${drift}`);
    }
  });

  test("a code cannot be used twice", () => {
    /* Otherwise a code read over somebody's shoulder stays good for the rest
       of its window. */
    const code = currentCode(secret, now);
    const step = verify(secret, code, { atMs: now });
    assert.ok(step !== null);
    assert.equal(verify(secret, code, { atMs: now, usedSteps: [step] }), null);
  });

  test("a formatted code is accepted", () => {
    const code = currentCode(secret, now);
    const spaced = `${code.slice(0, 3)} ${code.slice(3)}`;
    assert.ok(verify(secret, spaced, { atMs: now }) !== null,
      "authenticator apps display codes in groups and people copy the space");
  });

  test("another secret's code is refused", () => {
    const other = generateSecret();
    assert.equal(verify(secret, currentCode(other, now), { atMs: now }), null);
  });
});

describe("the provisioning URI", () => {
  test("carries what an authenticator app needs", () => {
    const uri = provisioningUri({
      secret: "JBSWY3DPEHPK3PXP",
      account: "dana@leafridge.test",
      issuer: "Leafridge Property Management",
    });
    assert.match(uri, /^otpauth:\/\/totp\//);
    assert.match(uri, /secret=JBSWY3DPEHPK3PXP/);
    assert.match(uri, /digits=6/);
    assert.match(uri, /period=30/);
    assert.ok(uri.includes(encodeURIComponent("Leafridge Property Management:dana@leafridge.test")),
      "the issuer prefixes the label as well as being a parameter, because apps read different ones");
  });
});

describe("recovery codes", () => {
  test("enough of them, and all different", () => {
    const codes = generateRecoveryCodes(10);
    assert.equal(codes.length, 10);
    assert.equal(new Set(codes).size, 10);
  });

  test("no characters that are misread off paper", () => {
    /* Somebody typing these has already lost their phone. O/0 and I/1 are the
       last thing they need. */
    for (const code of generateRecoveryCodes(40)) {
      assert.ok(!/[O0I1]/.test(code), `${code} contains an ambiguous character`);
    }
  });

  test("typed back in any shape", () => {
    const [code] = generateRecoveryCodes(1);
    assert.equal(normaliseRecoveryCode(code.toLowerCase()), normaliseRecoveryCode(code));
    assert.equal(normaliseRecoveryCode(code.replace("-", " ")), normaliseRecoveryCode(code));
    assert.equal(normaliseRecoveryCode(code.replace("-", "")), normaliseRecoveryCode(code));
  });

  test("enough entropy to be worth having", () => {
    /* Ten characters from a 32-symbol alphabet is 50 bits. A recovery code is
       a password that bypasses the second factor, so it has to be one. */
    const [code] = generateRecoveryCodes(1);
    assert.equal(normaliseRecoveryCode(code).length, 10);
  });
});
