/* The ZIP writer.

   Nothing here touches the database. What it is defending is the one property
   a hand-rolled archive format has to have: that something which is not this
   code can open it.

   So every archive is read back by `helpers/unzip.js`, which was written from
   the other end of the specification, and — where the machine has it — by
   Info-ZIP's own `unzip -t`, which checks every CRC. The first version of
   this writer passed a reader that shared its constants and was rejected by
   both: the ZIP64 mask was being written as the threshold value rather than
   as 0xffffffff, so every size in a large archive was nonsense. */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { crc32, zipBuffer } from "../server/lib/zip.js";
import { readZip } from "./helpers/unzip.js";

/* Info-ZIP is on macOS and on every Linux image this is likely to run on, but
   a missing binary must not fail the suite — it would be failing for the
   machine rather than for the code. The independent reader above runs either
   way, so nothing goes unchecked. */
function unzipTest(buf) {
  const dir = mkdtempSync(join(tmpdir(), "ziptest-"));
  const path = join(dir, "a.zip");
  writeFileSync(path, buf);
  try {
    execFileSync("unzip", ["-t", path], { stdio: "pipe" });
    return "checked";
  } catch (err) {
    if (err.code === "ENOENT") return "no unzip on this machine";
    throw new Error(`unzip rejected the archive: ${String(err.stderr || err.stdout || err)}`);
  }
}

const ENTRIES = [
  { name: "README.txt", data: "Hello — an export.\n".repeat(60) },
  { name: "data/owner.csv", data: "id,name\r\nO-1,Müller & Co\r\n" },
  { name: "files/photo.bin", data: Buffer.from([0xff, 0xd8, 0xff, 0x00, 0x01]) },
  { name: "files/deep/nested.json", read: () => Buffer.from('{"a":1}') },
  { name: "empty.txt", data: "" },
];

describe("CRC-32", () => {
  test("the check value every implementation quotes", () => {
    assert.equal(crc32(Buffer.from("123456789")), 0xcbf43926);
  });

  test("nothing hashes to the empty value", () => {
    assert.equal(crc32(Buffer.alloc(0)), 0);
  });
});

describe("an archive something else can open", () => {
  test("every entry comes back byte for byte", async () => {
    const buf = await zipBuffer(ENTRIES);
    const entries = readZip(buf);

    assert.equal(entries.size, ENTRIES.length);
    assert.equal(entries.get("README.txt").data.toString(), "Hello — an export.\n".repeat(60));
    assert.equal(entries.get("data/owner.csv").data.toString(), "id,name\r\nO-1,Müller & Co\r\n");
    assert.deepEqual([...entries.get("files/photo.bin").data], [0xff, 0xd8, 0xff, 0x00, 0x01]);
    assert.equal(entries.get("files/deep/nested.json").data.toString(), '{"a":1}');
    assert.equal(entries.get("empty.txt").data.length, 0);
  });

  test("Info-ZIP agrees", async () => {
    const result = unzipTest(await zipBuffer(ENTRIES));
    assert.ok(result === "checked" || result === "no unzip on this machine", result);
  });

  test("names are marked as UTF-8, or a name with an umlaut in it is mangled", async () => {
    const entries = readZip(await zipBuffer([
      { name: "owners/Müller & Co — 2026.csv", data: "x" },
    ]));
    const entry = [...entries.values()][0];
    assert.equal(entry.name, "owners/Müller & Co — 2026.csv");
    assert.equal(entry.utf8, true);
  });

  test("text is deflated and an already-compressed file is not", async () => {
    /* Genuinely random, not a pattern. The first version of this used
       `(i * 37) % 256`, which cycles every 256 bytes and deflates beautifully
       — so the test asserted the opposite of what it meant to. */
    const jpegish = randomBytes(4000);
    const entries = readZip(await zipBuffer([
      { name: "text.txt", data: "the same line over and over\n".repeat(200) },
      { name: "noise.bin", data: jpegish },
    ]));
    assert.equal(entries.get("text.txt").method, 8, "repetitive text should compress");
    assert.equal(entries.get("noise.bin").method, 0,
      "storing beats deflating when deflating makes it bigger");
  });

  test("an entry can insist on being stored", async () => {
    const entries = readZip(await zipBuffer([
      { name: "a.txt", data: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", store: true },
    ]));
    assert.equal(entries.get("a.txt").method, 0);
  });

  test("an empty archive is still a valid archive", async () => {
    /* Not run past Info-ZIP: it exits non-zero on an archive with nothing in
       it, which is a warning about the archive's usefulness rather than a
       complaint about its structure. The export always has tables in it, so
       this is about the writer rather than about anything it will produce. */
    const buf = await zipBuffer([]);
    assert.equal(readZip(buf).size, 0);
    assert.equal(buf.length, 22, "an end record and nothing else");
    assert.equal(buf.readUInt32LE(0), 0x06054b50);
  });

  test("read() is called once, when the entry's turn comes", async () => {
    let calls = 0;
    await zipBuffer([{ name: "x", read: () => { calls += 1; return Buffer.from("x"); } }]);
    assert.equal(calls, 1, "an export of a thousand photographs holds one photograph");
  });
});

/* --- the 64-bit form ---------------------------------------------------------

   Reached by lowering the ceilings rather than by building four gigabytes.
   The numbers the format writes are the same either way; what changes is
   which slot holds them. */
describe("ZIP64", () => {
  const tiny = { limits: { u32: 40, u16: 2 } };

  test("an archive over the ceilings still reads", async () => {
    const buf = await zipBuffer(ENTRIES, tiny);
    const entries = readZip(buf);
    assert.equal(entries.size, ENTRIES.length);
    assert.equal(entries.get("README.txt").data.toString(), "Hello — an export.\n".repeat(60));
    assert.equal(entries.get("data/owner.csv").data.toString(), "id,name\r\nO-1,Müller & Co\r\n");
  });

  test("Info-ZIP agrees about that too", async () => {
    const result = unzipTest(await zipBuffer(ENTRIES, tiny));
    assert.ok(result === "checked" || result === "no unzip on this machine", result);
  });

  test("the ordinary end record is masked, not merely wrong", async () => {
    const buf = await zipBuffer(ENTRIES, tiny);
    /* The last 22 bytes are the ordinary end record. Its count and offset
       must be the mask value: a reader that does not know about ZIP64 has to
       see that it cannot answer, rather than read a number that is a
       plausible lie. */
    const eocd = buf.length - 22;
    assert.equal(buf.readUInt32LE(eocd), 0x06054b50);
    assert.equal(buf.readUInt16LE(eocd + 10), 0xffff, "entry count");
    assert.equal(buf.readUInt32LE(eocd + 16), 0xffffffff, "directory offset");
  });

  test("below the ceilings it writes the plain form", async () => {
    const buf = await zipBuffer([{ name: "a.txt", data: "small" }]);
    const eocd = buf.length - 22;
    assert.equal(buf.readUInt16LE(eocd + 10), 1, "one entry, said plainly");
    assert.notEqual(buf.readUInt32LE(eocd + 16), 0xffffffff);
  });
});
