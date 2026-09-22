/* Configuration validation.

   config.js reads the environment once, at module load, which is the whole
   point of it — so it cannot be tested by setting process.env and re-calling a
   function. Each case runs in its own process with its own environment, which
   is also exactly how it will fail in production. */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";

const CONFIG = fileURLToPath(new URL("../server/lib/config.js", import.meta.url));

/* Returns { ok, message } from a child process with exactly this environment
   and nothing inherited — so a stray DATABASE_URL in the developer's shell
   cannot make a failing case pass. */
function load(env) {
  const script = `
    import * as c from ${JSON.stringify(CONFIG)};
    try {
      c.assertConfig({ exitOnFailure: false });
      process.stdout.write(JSON.stringify({ ok: true, summary: c.configSummary() }));
    } catch (e) {
      process.stdout.write(JSON.stringify({ ok: false, message: e.message }));
    }
  `;
  const out = execFileSync(process.execPath, ["--input-type=module", "-e", script], {
    env: { PATH: process.env.PATH, HOME: process.env.HOME, ...env },
    encoding: "utf8",
  });
  return JSON.parse(out);
}

describe("config refuses to start on a broken environment", () => {
  test("no DATABASE_URL at all", () => {
    const r = load({});
    assert.equal(r.ok, false);
    assert.match(r.message, /DATABASE_URL is not set/);
    assert.match(r.message, /Transaction pooler/, "the message must say where to get one");
  });

  test("NODE_ENV=test with no TEST_DATABASE_URL", () => {
    const r = load({ NODE_ENV: "test", DATABASE_URL: "postgresql://localhost:5432/prod" });
    assert.equal(r.ok, false);
    assert.match(r.message, /TEST_DATABASE_URL is not set/);
  });

  test("the test database may never be the real one", () => {
    const same = "postgresql://localhost:5432/same";
    const r = load({ NODE_ENV: "test", DATABASE_URL: same, TEST_DATABASE_URL: same });
    assert.equal(r.ok, false);
    assert.match(r.message, /identical/i);
    assert.match(r.message, /drops the public schema/,
      "the message must say why this is refused, because the cost is the dataset");
  });

  test("an encryption key of the wrong length", () => {
    const short = Buffer.alloc(16).toString("base64");
    const r = load({ DATABASE_URL: "postgresql://localhost:5432/x", APP_ENCRYPTION_KEY: short });
    assert.equal(r.ok, false);
    assert.match(r.message, /decodes to 16 bytes/);
    assert.match(r.message, /randomBytes\(32\)/, "the message must carry the fix");
  });

  test("a deployed environment with no CRON_SECRET", () => {
    const r = load({ VERCEL: "1", DATABASE_URL: "postgresql://u:p@h:6543/x" });
    assert.equal(r.ok, false);
    assert.match(r.message, /CRON_SECRET/);
    assert.match(r.message, /open trigger/);
  });

  test("every problem is reported at once, not one per restart", () => {
    const r = load({ VERCEL: "1", APP_ENCRYPTION_KEY: "tooshort" });
    assert.equal(r.ok, false);
    assert.match(r.message, /DATABASE_URL/);
    assert.match(r.message, /CRON_SECRET/);
  });
});

describe("config accepts a usable environment", () => {
  test("a local development setup", () => {
    const r = load({ DATABASE_URL: "postgresql://localhost:5432/dev" });
    assert.equal(r.ok, true);
    assert.equal(r.summary.serverless, false);
    assert.equal(r.summary.delivery, "off");
  });

  test("a test setup with a distinct database", () => {
    const r = load({
      NODE_ENV: "test",
      DATABASE_URL: "postgresql://localhost:5432/prod",
      TEST_DATABASE_URL: "postgresql://localhost:5432/propops_test",
    });
    assert.equal(r.ok, true);
    assert.equal(r.summary.nodeEnv, "test");
  });

  test("a deployed setup", () => {
    const r = load({
      VERCEL: "1", CRON_SECRET: "x".repeat(32),
      DATABASE_URL: "postgresql://u:p@h.pooler.supabase.com:6543/postgres",
      APP_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
    });
    assert.equal(r.ok, true);
    assert.equal(r.summary.serverless, true);
    assert.equal(r.summary.encryption, "configured");
  });
});

describe("the config summary never carries a secret", () => {
  test("no value from the environment appears in it", () => {
    const secret = "SUPERSECRETVALUE1234567890";
    const r = load({
      VERCEL: "1", CRON_SECRET: secret,
      DATABASE_URL: `postgresql://user:${secret}@h.pooler.supabase.com:6543/postgres`,
      APP_ENCRYPTION_KEY: Buffer.alloc(32, 3).toString("base64"),
      SENTRY_DSN: `https://${secret}@sentry.io/1`,
    });
    assert.equal(r.ok, true);
    const serialised = JSON.stringify(r.summary);
    assert.ok(!serialised.includes(secret),
      "configSummary is rendered on /health, which is public");
  });
});

describe("web push keys", () => {
  const BASE = {
    VERCEL: "1", CRON_SECRET: "x".repeat(32),
    DATABASE_URL: "postgresql://u:p@h.pooler.supabase.com:6543/postgres",
    APP_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
  };

  test("none of them is a working state — push is simply off", () => {
    assert.equal(load(BASE).ok, true);
  });

  test("all three together is fine", () => {
    assert.equal(load({
      ...BASE,
      VAPID_PUBLIC_KEY: "a-public-key", VAPID_PRIVATE_KEY: "a-private-key",
      VAPID_SUBJECT: "mailto:ops@example.test",
    }).ok, true);
  });

  test("half of a pair is refused at boot, not at three in the morning", () => {
    /* A public key with no private one hands browsers a subscription nothing
       can ever send to, and that failure is otherwise completely silent —
       every device subscribes, every send fails, nothing says why. */
    for (const half of [
      { VAPID_PUBLIC_KEY: "only-this" },
      { VAPID_PRIVATE_KEY: "only-this" },
      { VAPID_PUBLIC_KEY: "a", VAPID_PRIVATE_KEY: "b" },  // no subject
    ]) {
      const r = load({ ...BASE, ...half });
      assert.equal(r.ok, false, JSON.stringify(half));
      assert.match(r.message, /half configured/);
      assert.match(r.message, /npm run vapid/, "the message must say how to fix it");
    }
  });
});


/* --- and that somebody can find out what to set --------------------------- */

describe("every variable is written down", () => {
  /* This rule had quietly broken. Twenty-three variables — every Stripe key,
     both Twilio credentials, the inbound-email secret — were read at boot and
     documented nowhere, so the only way to find out what to set was to read
     config.js. That is fine for the person who wrote it and useless to anyone
     else, and it is exactly the kind of debt that never gets paid off by
     intention. So it is a test. */
  const CONFIG_SOURCE = readFileSync(CONFIG, "utf8");
  const README = readFileSync(
    fileURLToPath(new URL("../server/README.md", import.meta.url)), "utf8");

  /* Read out of the source rather than listed here, so a variable added
     tomorrow is caught without anybody remembering to update this. */
  const VARIABLES = [...new Set(
    [...CONFIG_SOURCE.matchAll(/raw\("([A-Z0-9_]+)"\)|process\.env\.([A-Z0-9_]+)/g)]
      .map((m) => m[1] || m[2]))].sort();

  test("config.js reads a plausible number of them", () => {
    /* A guard on the guard: if the regex above stops matching, every
       assertion below passes vacuously. */
    assert.ok(VARIABLES.length > 30, `only found ${VARIABLES.length}`);
  });

  test("each one appears in the environment table", () => {
    const missing = VARIABLES.filter((v) => !README.includes(`\`${v}\``));
    assert.deepEqual(missing, [],
      "read at boot and documented nowhere — add it to Environment in server/README.md");
  });

  test("the table says whether each one is required", () => {
    /* A name in prose is not documentation. Every variable has to be in a
       row of the table, where the middle column says what happens without
       it. */
    const rows = [...README.matchAll(/^\|(.+)\|(.+)\|(.+)\|$/gm)]
      .map((m) => ({ names: m[1], required: m[2].trim() }));

    for (const name of VARIABLES) {
      if (name === "VERCEL" || name === "AWS_LAMBDA_FUNCTION_NAME") continue; // never set by hand
      const row = rows.find((r) => r.names.includes(`\`${name}\``));
      assert.ok(row, `${name} is mentioned but is not in a table row`);
      assert.ok(row.required.length > 0, `${name}'s row does not say whether it is required`);
    }
  });
});
