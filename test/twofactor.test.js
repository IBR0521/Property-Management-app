/* The second factor, end to end.

   The failures worth testing here are the ones that lock somebody out of their
   own company, because the person locked out is usually the administrator and
   there is nobody above them to help. Enrolment that enables before proving a
   code works, a company-wide requirement turned on by somebody who has not
   enrolled, a recovery code that cannot be used — each of those is
   unrecoverable from inside the product. */
import { test, describe, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";

process.env.NODE_ENV = "test";
process.env.TEST_DATABASE_URL = process.env.TEST_DATABASE_URL || "postgresql://localhost:5432/propops_test";
process.env.DATABASE_URL = "postgresql://unused:unused@example.invalid:6543/unused";
/* TOTP secrets are sealed, so the encryption key has to exist for this path
   to be exercised at all rather than skipped. */
process.env.APP_ENCRYPTION_KEY = Buffer.alloc(32, 9).toString("base64");

const { freshDatabase, truncateAll, closeDb, all, get, run } = await import("./helpers/db.js");
const { startApp, client } = await import("./helpers/http.js");
const f = await import("./helpers/factories.js");
const { currentCode, generateSecret } = await import("../server/lib/totp.js");
const { tryOpen } = await import("../server/lib/crypto.js");

let app, world;

before(async () => {
  await freshDatabase();
  await truncateAll();
  app = await startApp();
});
after(async () => { await app.close(); await closeDb(); });

beforeEach(async () => {
  await truncateAll();
  await run("DELETE FROM rate_hit");
  world = await f.makeWorld({ name: "Factor Co", staffRoles: ["admin", "manager"] });
});

/* Walks a signed-in client through enrolment and returns the secret.

   Confirming consumes the current 30-second step — that is the replay guard
   working, and it has its own test below. Here it would mean every subsequent
   sign-in in the same second is refused, so the step is cleared to stand in
   for half a minute passing. */
async function enrol(c, { releaseStep = true } = {}) {
  await c.post("/app/account/2fa/start", {}, { csrfFrom: "/app/account/2fa" });
  const staff = await get("SELECT * FROM staff WHERE email = ?", world.staff.admin.email);
  const secret = tryOpen(staff.totp_secret_enc);
  await c.post("/app/account/2fa/confirm", { code: currentCode(secret) },
    { csrfFrom: "/app/account/2fa" });
  if (releaseStep) {
    await run("UPDATE staff SET totp_last_step = NULL WHERE id = ?", staff.id);
  }
  return secret;
}

describe("enrolment proves the code works before enabling", () => {
  test("starting stores a secret but enforces nothing", async () => {
    const c = client(app.origin);
    await c.signIn(world.staff.admin.email, f.PASSWORD);
    await c.post("/app/account/2fa/start", {}, { csrfFrom: "/app/account/2fa" });

    const staff = await get("SELECT * FROM staff WHERE email = ?", world.staff.admin.email);
    assert.ok(staff.totp_secret_enc, "a secret exists");
    assert.equal(staff.totp_confirmed_at, null, "and nothing is enforced yet");

    // Still able to move around: a half-finished setup must not lock anyone out.
    assert.equal((await c.get("/app")).status, 200);
  });

  test("the secret is sealed, not stored in the clear", async () => {
    const c = client(app.origin);
    await c.signIn(world.staff.admin.email, f.PASSWORD);
    const secret = await enrol(c);
    const staff = await get("SELECT totp_secret_enc FROM staff WHERE email = ?", world.staff.admin.email);
    assert.ok(!staff.totp_secret_enc.includes(secret),
      "a TOTP secret in the clear is a second password sitting next to the first");
    assert.equal(tryOpen(staff.totp_secret_enc), secret);
  });

  test("a wrong code during enrolment enables nothing", async () => {
    const c = client(app.origin);
    await c.signIn(world.staff.admin.email, f.PASSWORD);
    await c.post("/app/account/2fa/start", {}, { csrfFrom: "/app/account/2fa" });
    await c.post("/app/account/2fa/confirm", { code: "000000" }, { csrfFrom: "/app/account/2fa" });

    const staff = await get("SELECT totp_confirmed_at FROM staff WHERE email = ?", world.staff.admin.email);
    assert.equal(staff.totp_confirmed_at, null,
      "enabling on the strength of 'I scanned it' locks out everyone who scanned the wrong thing");
  });

  test("confirming issues recovery codes, hashed", async () => {
    const c = client(app.origin);
    await c.signIn(world.staff.admin.email, f.PASSWORD);
    const secret = await enrol(c);

    const staff = await get("SELECT * FROM staff WHERE email = ?", world.staff.admin.email);
    assert.ok(staff.totp_confirmed_at);

    const codes = await all("SELECT * FROM staff_recovery_code WHERE staff_id = ?", staff.id);
    assert.equal(codes.length, 10);
    for (const row of codes) {
      assert.match(row.code_hash, /^scrypt\$/, "a recovery code bypasses the second factor, so it is a password");
    }
  });
});

describe("the challenge at sign-in", () => {
  test("a password alone no longer reaches the app", async () => {
    const setup = client(app.origin);
    await setup.signIn(world.staff.admin.email, f.PASSWORD);
    const secret = await enrol(setup);

    const c = client(app.origin);
    const res = await c.signIn(world.staff.admin.email, f.PASSWORD);
    assert.match(res.location, /\/app\/2fa/, "sign-in sends them to the challenge");

    const blocked = await c.get("/app");
    assert.equal(blocked.status, 303);
    assert.match(blocked.headers.get("location"), /\/app\/2fa/,
      "a session with a password but no second factor is half authenticated");

    const ok = await c.post("/app/2fa", { code: currentCode(secret) }, { csrfFrom: "/app/2fa" });
    assert.equal(ok.status, 303);
    assert.equal((await c.get("/app")).status, 200);
  });

  test("a code cannot be replayed, even into a different session", async () => {
    /* The attack that matters is somebody who watched the code typing it into
       their own browser, not into yours. */
    const setup = client(app.origin);
    await setup.signIn(world.staff.admin.email, f.PASSWORD);
    const secret = await enrol(setup);
    const code = currentCode(secret);

    const first = client(app.origin);
    await first.signIn(world.staff.admin.email, f.PASSWORD);
    await first.post("/app/2fa", { code }, { csrfFrom: "/app/2fa" });
    assert.equal((await first.get("/app")).status, 200);

    const attacker = client(app.origin);
    await attacker.signIn(world.staff.admin.email, f.PASSWORD);
    await attacker.post("/app/2fa", { code }, { csrfFrom: "/app/2fa" });
    const after = await attacker.get("/app");
    assert.equal(after.status, 303, "the same code must not open a second session");
  });

  test("a wrong code is refused and rate limited", async () => {
    const setup = client(app.origin);
    await setup.signIn(world.staff.admin.email, f.PASSWORD);
    await enrol(setup);

    const c = client(app.origin);
    await c.signIn(world.staff.admin.email, f.PASSWORD);

    let limited = false;
    for (let i = 0; i < 11; i++) {
      const res = await c.post("/app/2fa", { code: "000000" }, { csrfFrom: "/app/2fa" });
      const { body } = await c.follow(res);
      if (/too many/i.test(body)) { limited = true; break; }
    }
    assert.ok(limited, "six digits is a million guesses and three windows — without a limit it is an afternoon's work");
    await run("DELETE FROM rate_hit");
  });

  test("a POST while half authenticated is refused rather than dropped", async () => {
    const setup = client(app.origin);
    await setup.signIn(world.staff.admin.email, f.PASSWORD);
    await enrol(setup);

    const c = client(app.origin);
    await c.signIn(world.staff.admin.email, f.PASSWORD);
    const res = await c.post("/app/portfolio/new", { line1: "1 Nowhere" }, { csrf: "x" });
    assert.ok(res.status >= 400, "a write must not be silently lost on the way to a challenge");
  });
});

describe("recovery codes", () => {
  test("one works in place of the phone, and only once", async () => {
    const setup = client(app.origin);
    await setup.signIn(world.staff.admin.email, f.PASSWORD);
    await enrol(setup);

    const staff = await get("SELECT id FROM staff WHERE email = ?", world.staff.admin.email);
    /* The plaintext codes are shown once and hashed at rest, so the test
       replaces them with a known set rather than trying to read them back —
       which is the property being relied on. */
    const { generateRecoveryCodes, normaliseRecoveryCode } = await import("../server/lib/totp.js");
    const { hashPassword } = await import("../server/lib/auth.js");
    const { id } = await import("../server/lib/ids.js");
    const known = generateRecoveryCodes(2);
    await run("DELETE FROM staff_recovery_code WHERE staff_id = ?", staff.id);
    for (const code of known) {
      await run(
        "INSERT INTO staff_recovery_code (id, staff_id, code_hash, created_at) VALUES (?, ?, ?, ?)",
        id(), staff.id, hashPassword(normaliseRecoveryCode(code)), new Date().toISOString());
    }

    const c = client(app.origin);
    await c.signIn(world.staff.admin.email, f.PASSWORD);
    await c.post("/app/2fa", { code: known[0] }, { csrfFrom: "/app/2fa" });
    assert.equal((await c.get("/app")).status, 200, "a lost phone must not mean a lost account");

    const second = client(app.origin);
    await second.signIn(world.staff.admin.email, f.PASSWORD);
    await second.post("/app/2fa", { code: known[0] }, { csrfFrom: "/app/2fa" });
    assert.equal((await second.get("/app")).status, 303, "each code works once");
  });
});

describe("the company-wide requirement", () => {
  test("cannot be turned on by somebody who has not enrolled", async () => {
    /* Otherwise they are locked out on the very next request, and they are
       the administrator. */
    const c = client(app.origin);
    await c.signIn(world.staff.admin.email, f.PASSWORD);
    const res = await c.post("/app/company/require-2fa", { require: "yes" },
      { csrfFrom: "/app/account/2fa" });
    assert.match(res.headers.get("location") || "", /account\/2fa/);

    const company = await get("SELECT require_2fa FROM company WHERE id = ?", world.companyId);
    assert.equal(company.require_2fa, 0);
  });

  test("once on, staff without it are walked through enrolment rather than blocked", async () => {
    const admin = client(app.origin);
    await admin.signIn(world.staff.admin.email, f.PASSWORD);
    await enrol(admin);
    await admin.post("/app/company/require-2fa", { require: "yes" }, { csrfFrom: "/app/account/2fa" });

    const manager = client(app.origin);
    await manager.signIn(world.staff.manager.email, f.PASSWORD);
    const res = await manager.get("/app");
    assert.equal(res.status, 303);
    assert.match(res.headers.get("location"), /account\/2fa\?required=1/,
      "bouncing them to a challenge they cannot answer would lock out everyone at once");
  });

  test("it cannot be turned off individually while the company requires it", async () => {
    const admin = client(app.origin);
    await admin.signIn(world.staff.admin.email, f.PASSWORD);
    await enrol(admin);
    await admin.post("/app/company/require-2fa", { require: "yes" }, { csrfFrom: "/app/account/2fa" });

    await admin.post("/app/account/2fa/disable", { password: f.PASSWORD },
      { csrfFrom: "/app/account/2fa" });
    const staff = await get("SELECT totp_confirmed_at FROM staff WHERE email = ?", world.staff.admin.email);
    assert.ok(staff.totp_confirmed_at, "a company requirement is not a personal preference");
  });

  test("turning it off needs the password again", async () => {
    const c = client(app.origin);
    await c.signIn(world.staff.admin.email, f.PASSWORD);
    await enrol(c);

    await c.post("/app/account/2fa/disable", { password: "wrong" }, { csrfFrom: "/app/account/2fa" });
    let staff = await get("SELECT totp_confirmed_at FROM staff WHERE email = ?", world.staff.admin.email);
    assert.ok(staff.totp_confirmed_at, "turning this off from an open session is what a found laptop does");

    await c.post("/app/account/2fa/disable", { password: f.PASSWORD }, { csrfFrom: "/app/account/2fa" });
    staff = await get("SELECT totp_confirmed_at, totp_secret_enc FROM staff WHERE email = ?", world.staff.admin.email);
    assert.equal(staff.totp_confirmed_at, null);
    assert.equal(staff.totp_secret_enc, null);
  });
});

describe("one address at two companies", () => {
  test("signing in asks which, rather than picking one", async () => {
    /* staff is unique on (company_id, email), so the same person may
       legitimately work for two management firms. */
    const other = await f.makeCompany("Second Firm");
    await f.makeStaff(other, { email: world.staff.admin.email, role: "manager" });

    const c = client(app.origin);
    const res = await c.post("/app/sign-in",
      { email: world.staff.admin.email, password: f.PASSWORD },
      { csrfFrom: "/app/sign-in" });

    assert.equal(res.status, 200, "it asks instead of redirecting");
    const body = await res.text();
    assert.match(body, /Which company/i);
    assert.match(body, /Factor Co/);
    assert.match(body, /Second Firm/);
  });

  test("choosing one signs into that one", async () => {
    const other = await f.makeCompany("Second Firm");
    await f.makeStaff(other, { email: world.staff.admin.email, role: "manager" });

    const c = client(app.origin);
    await c.post("/app/sign-in",
      { email: world.staff.admin.email, password: f.PASSWORD, company_id: other },
      { csrfFrom: "/app/sign-in" });

    const { body } = await c.text("/app");
    assert.match(body, /Second Firm/);
    assert.ok(!body.includes("Factor Co"));
  });
});
