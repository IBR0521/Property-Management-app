/* Configuration validation.

   config.js reads the environment once, at module load, which is the whole
   point of it — so it cannot be tested by setting process.env and re-calling a
   function. Each case runs in its own process with its own environment, which
   is also exactly how it will fail in production. */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

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
