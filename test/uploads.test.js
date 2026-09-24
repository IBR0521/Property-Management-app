/* What can be uploaded, and what happens to what cannot.

   A browser will label anything `image/jpeg`. The declared type is a hint and
   the first bytes are the evidence, so every path that accepts a file sniffs
   it — and this file is the collection of things somebody would try when the
   sniff is the only thing standing between them and storing a script on
   somebody else's origin.

   The interesting one is SVG. It is an image by every ordinary definition and
   it is also a document that can carry `<script>`; served from our origin it
   would run there. It is not in `IMAGE_TYPES` and there is no magic number
   for it, so it fails for two reasons, and a test says so rather than leaving
   it to be rediscovered by whoever adds "just let them upload SVGs". */
import { test, describe, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { freshDatabase, truncateAll, closeDb, all, get } from "./helpers/db.js";
import { startApp, client } from "./helpers/http.js";
import * as f from "./helpers/factories.js";
import { id } from "../server/lib/ids.js";
import { storeUpload, IMAGE_TYPES, DOC_TYPES } from "../server/lib/files.js";
import { LIMITS } from "../server/lib/http.js";

let app, world;

before(async () => {
  await freshDatabase();
  await truncateAll();
  app = await startApp();
});
after(async () => { await app.close(); await closeDb(); });
beforeEach(async () => {
  await truncateAll();
  world = await f.makeWorld({ name: "Uploads Co" });
});

/* Real magic bytes, because the sniff is the point of this file. */
const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(64, 0x11),
]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64, 0x22)]);
const PDF = Buffer.concat([Buffer.from("%PDF-1.4\n", "ascii"), Buffer.alloc(64, 0x20)]);

const file = (name, mime, data) => ({
  field: "f", filename: name, mime, bytes: data.length, data,
});

describe("what the bytes say, not what the name says", () => {
  test("a real image is accepted", async () => {
    const stored = await storeUpload(file("photo.png", "image/png", PNG));
    assert.match(stored.path, /\.png$/);
    assert.equal(stored.mime, "image/png");
  });

  test("a script wearing a .jpg is refused", async () => {
    const php = Buffer.from("<?php system($_GET['c']); ?>" + " ".repeat(64), "utf8");
    await assert.rejects(
      () => storeUpload(file("innocent.jpg", "image/jpeg", php)),
      /not a readable image or PDF/);
  });

  test("and so is one wearing a correct-looking content type", async () => {
    /* The browser said image/png. The bytes did not. */
    const html = Buffer.from("<html><script>alert(1)</script></html>" + " ".repeat(64), "utf8");
    await assert.rejects(
      () => storeUpload(file("photo.png", "image/png", html)),
      /not a readable image or PDF/);
  });

  test("an SVG is refused, and that is not an oversight", async () => {
    /* An image by every ordinary definition, and a document that can carry a
       script. Served from our origin it would run there. */
    const svg = Buffer.from(
      `<svg xmlns="http://www.w3.org/2000/svg"><script>fetch('/app/staff')</script></svg>`
      + " ".repeat(64), "utf8");
    await assert.rejects(
      () => storeUpload(file("logo.svg", "image/svg+xml", svg)),
      /not a readable image or PDF/);

    assert.equal(IMAGE_TYPES.has("image/svg+xml"), false,
      "and it is not on the list either, so both the sniff and the allow-list refuse it");
    assert.equal(DOC_TYPES.has("image/svg+xml"), false);
  });

  test("a PDF where only an image is wanted is refused by the allow-list", async () => {
    /* The bytes are a real PDF. The caller asked for an image. */
    await assert.rejects(
      () => storeUpload(file("scan.pdf", "application/pdf", PDF), { allow: IMAGE_TYPES }),
      /which is not accepted here/);

    /* And the same file goes through where documents are wanted. */
    const stored = await storeUpload(file("scan.pdf", "application/pdf", PDF),
      { allow: DOC_TYPES });
    assert.equal(stored.mime, "application/pdf");
  });

  test("something too short to identify is refused rather than guessed at", async () => {
    await assert.rejects(
      () => storeUpload(file("tiny.png", "image/png", Buffer.from([0x89, 0x50]))),
      /not a readable image or PDF/);
  });

  test("an empty file is refused", async () => {
    await assert.rejects(
      () => storeUpload(file("nothing.png", "image/png", Buffer.alloc(0))),
      /not a readable image or PDF/);
  });

  test("something over the cap is refused before it is sniffed", async () => {
    const huge = Buffer.concat([PNG, Buffer.alloc(LIMITS.file + 1, 0)]);
    await assert.rejects(
      () => storeUpload(file("big.png", "image/png", huge)),
      /is over/);
  });

  test("the stored name is ours, so nothing a person typed becomes a path", async () => {
    /* The filename arrives from a browser and is never used to build one. */
    const stored = await storeUpload(
      file("../../../etc/passwd.png", "image/png", PNG));
    assert.doesNotMatch(stored.path, /\.\./);
    assert.doesNotMatch(stored.path, /passwd/);
    assert.match(stored.path, /^\d{4}-\d{2}\/[A-Za-z0-9]+\.png$/,
      "a month folder and an id we generated");
  });

  test("the extension follows the bytes, not the name", async () => {
    const stored = await storeUpload(file("pretend.png", "image/png", JPEG));
    assert.match(stored.path, /\.jpg$/,
      "a JPEG called .png is stored as a JPEG — the served type has to match the bytes");
  });
});

/* --- the blob store, which the suite never reaches ------------------------------- */

describe("the two functions we depend on in @vercel/blob", () => {
  /* Uploads go to local disk in this suite, so nothing here exercises the
     blob path at runtime. What can be checked — and what matters after an
     upgrade — is that the two functions this application calls still exist
     and still take what it passes them.

     This is not the same as having run it against Vercel Blob, and the phase
     report says so. It is the difference between "the upgrade compiles" and
     "the upgrade silently changed an option name". */
  test("put and del are there, with the shape files.js and retain.js use", async () => {
    const blob = await import("@vercel/blob");

    assert.equal(typeof blob.put, "function");
    assert.equal(blob.put.length, 3, "put(pathname, body, options)");
    assert.equal(typeof blob.del, "function");
    assert.equal(blob.del.length, 2, "del(url, options)");
  });

  test("and the options we pass are still the documented ones", async () => {
    /* Read from the package's own types rather than asserted from memory: an
       option that was renamed would otherwise be silently ignored, and an
       ignored `contentType` means every file served as octet-stream. */
    const { readFileSync } = await import("node:fs");
    const types = readFileSync(
      new URL("../node_modules/@vercel/blob/dist/index.d.ts", import.meta.url), "utf8");

    for (const option of ["access", "contentType", "token", "addRandomSuffix"]) {
      assert.ok(types.includes(option), `put no longer documents ${option}`);
    }
  });
});

/* --- through a real form -------------------------------------------------------- */

describe("the same, through a public form", () => {
  /* A multipart POST, which the ordinary form helper does not do. */
  async function upload(agent, path, csrfFrom, fields, files) {
    const csrf = await agent.csrf(csrfFrom);
    const boundary = "----uploadtest" + id();
    const parts = [];
    const push = (s) => parts.push(Buffer.from(s, "utf8"));

    push(`--${boundary}\r\nContent-Disposition: form-data; name="_csrf"\r\n\r\n${csrf}\r\n`);
    for (const [k, v] of Object.entries(fields)) {
      push(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`);
    }
    for (const { field, name, type, data } of files) {
      push(`--${boundary}\r\nContent-Disposition: form-data; name="${field}"; `
        + `filename="${name}"\r\nContent-Type: ${type}\r\n\r\n`);
      parts.push(data);
      push("\r\n");
    }
    push(`--${boundary}--\r\n`);

    return await agent.raw(path, {
      method: "POST",
      headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
      body: Buffer.concat(parts),
    });
  }

  test("a tenant's repair photo that is not a photo is dropped, and the repair is kept",
    async () => {
      /* The whole point of collecting problems rather than throwing: somebody
         reporting a burst pipe should not lose the report because their photo
         was a screenshot in a format we do not take. */
      const unit = await get("SELECT report_token FROM unit WHERE id = ?", world.unitId);
      const visitor = client(app.origin);
      /* The form is the second step: the first picks a category, and only the
         step that can actually submit carries a token. */
      const path = `/report?u=${unit.report_token}&category=plumbing`;

      const res = await upload(visitor, "/report", path, {
        unit_token: unit.report_token, category: "plumbing", closest: "one_fixture",
        summary: "Water coming through the ceiling",
        name: "Ravi Bhatt", phone: "614-555-0110",
      }, [{
        field: "photos", name: "evil.jpg", type: "image/jpeg",
        data: Buffer.from("<?php echo 1; ?>" + " ".repeat(64), "utf8"),
      }]);

      assert.ok(res.status < 400, `the report itself should have been filed: ${res.status}`);
      const wo = await get("SELECT * FROM work_order WHERE company_id = ?", world.companyId);
      assert.ok(wo, "the repair was filed");
      const photos = await all(
        "SELECT * FROM work_order_photo WHERE work_order_id = ?", wo.id);
      assert.equal(photos.length, 0, "and the thing that was not a photograph was not stored");
    });
});
