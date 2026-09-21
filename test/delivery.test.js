/* Delivery honesty.

   This is an invariant in the roadmap and it had no test, which is how a
   config default change silently turned the dashboard warning off and the
   Setup chip green while 39 messages sat undelivered. The app spent that whole
   time claiming everything was fine.

   The rule: the UI never implies a message was delivered unless a provider
   actually accepted it for a real recipient. Three of the four modes send
   nothing to anyone, and only one of them may go quiet. */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { reachesRecipients, drains, describe as describeMode, MODES } from "../server/lib/delivery/mode.js";
import { readFileSync } from "node:fs";

describe("delivery honesty", () => {
  test("only live mode counts as reaching anyone", () => {
    assert.equal(reachesRecipients("live"), true);
    for (const mode of ["off", "log", "sandbox"]) {
      assert.equal(reachesRecipients(mode), false,
        `${mode} does not put a message in front of a human and must not claim to`);
    }
  });

  test("every non-live mode produces a visible warning", () => {
    for (const mode of MODES.filter((m) => m !== "live")) {
      const d = describeMode(mode, 5);
      assert.notEqual(d.tone, "ok", `${mode} must not render as a green chip`);
      assert.match(d.title + " " + d.detail, /nothing|not delivered|discard/i,
        `${mode} must say plainly that nothing arrives`);
    }
  });

  test("an unknown mode fails closed, loudly", () => {
    /* A typo in an environment variable must not read as success. This is the
       exact shape of the bug: a mode nobody compared against correctly. */
    const d = describeMode("enabled", 3);
    assert.equal(d.tone, "danger");
    assert.equal(reachesRecipients("enabled"), false);
  });

  test("off is the default and drains nothing", () => {
    assert.equal(drains("off"), false);
    for (const mode of ["log", "sandbox", "live"]) {
      assert.equal(drains(mode), true);
    }
  });

  test("the mode is never compared against a string literal outside mode.js", () => {
    /* The regression was three copies of `DELIVERY.mode === "none"`. When the
       default changed, all three went false at once and nothing failed. This
       test is why that cannot happen again silently. */
    const files = [
      "../server/lib/scheduler.js",
      "../server/features/queue.js",
      "../server/features/setup.js",
    ];
    for (const rel of files) {
      const src = readFileSync(new URL(rel, import.meta.url), "utf8");
      const literals = src.match(/\.mode\s*===\s*["'][a-z]+["']/g) || [];
      assert.deepEqual(literals, [],
        `${rel} compares the delivery mode against a literal: ${literals.join(", ")}`);
    }
  });
});
