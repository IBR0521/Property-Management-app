/* Redirect targets and the request door. No database. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { sameOriginPath } from "../server/lib/http.js";

test("a sign-in return path stays on this site", () => {
  assert.equal(sameOriginPath("/app/listings", "/app"), "/app/listings");
  assert.equal(sameOriginPath("/app", "/app"), "/app");
  assert.equal(sameOriginPath("/app?m=ok", "/app"), "/app?m=ok");
});

test("a return path cannot leave the site", () => {
  for (const bad of [
    "https://evil.example",
    "//evil.example",
    "/app//evil.example",
    "/app\\evil.example",
    "/application",
    "/app@evil.example",
    "javascript:alert(1)",
    "/app/\nSet-Cookie:x",
  ]) {
    assert.equal(sameOriginPath(bad, "/app"), null, bad);
  }
});
