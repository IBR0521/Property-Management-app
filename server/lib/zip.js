/* A ZIP file, written by hand.

   There is one reason this exists rather than a dependency: a customer's
   right to leave with their data should not rest on a package I have not
   read. The format is thirty years old, documented, and small enough to fit
   in one file — local header, data, central directory, end record.

   ## What it does and does not do

   It deflates with `node:zlib`, which is in the platform. It writes UTF-8
   names, marked as such with the flag that says so, because addresses and
   people's names are not ASCII and an archive that mangles them is not a
   copy of anything.

   It writes **ZIP64** when it has to — an archive over 4GB, an entry over
   4GB, or more than 65,535 of them. A portfolio with ten years of repair
   photos reaches all three eventually, and the failure mode without it is
   not an error: it is an archive that opens and is quietly missing files.
   The threshold is a parameter so a test can cross it without building four
   gigabytes.

   It does **not** encrypt, and it does not write data descriptors. Sizes are
   known before each header is written because each entry is compressed in
   full before it is emitted, which is also what keeps memory to one entry at
   a time rather than the whole archive. */
import { deflateRawSync } from "node:zlib";

/* --- CRC-32 ---------------------------------------------------------------- */

let TABLE = null;

function table() {
  if (TABLE) return TABLE;
  TABLE = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    TABLE[n] = c;
  }
  return TABLE;
}

/* Resumable, so a caller compressing a table in batches can accumulate the
   checksum over chunks it no longer holds. Called with one argument it is the
   ordinary whole-buffer CRC; called with the previous result it continues
   where that left off. */
export function crc32(buf, previous = 0) {
  const t = table();
  let c = ~previous;
  for (let i = 0; i < buf.length; i++) c = t[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

/* --- the format ------------------------------------------------------------ */

const LOCAL_SIG = 0x04034b50;
const CENTRAL_SIG = 0x02014b50;
const EOCD_SIG = 0x06054b50;
const ZIP64_EOCD_SIG = 0x06064b50;
const ZIP64_LOCATOR_SIG = 0x07064b50;

/* Bit 11: the name is UTF-8. Without it a reader is entitled to decode the
   name as code page 437, and "Müller" becomes something else. */
const UTF8_FLAG = 0x0800;

const STORE = 0;
const DEFLATE = 8;

/* The 32-bit ceilings the format was written against.

   Two roles, and conflating them is a real bug: they are the *thresholds* at
   which a number no longer fits, and they are also the *masks* written into
   the slot that cannot hold it. The thresholds are parameters so the ZIP64
   path can be exercised by a test that does not have four gigabytes to
   spare; the masks are fixed by the format and are never anything else. */
const U32_MAX = 0xffffffff;
const U16_MAX = 0xffff;
const U32_MASK = 0xffffffff;
const U16_MASK = 0xffff;

/* MS-DOS packed date and time, which is what the format stores. Two-second
   resolution and nothing before 1980, neither of which matters here. */
function dosDateTime(date) {
  const d = date instanceof Date ? date : new Date(date || Date.now());
  const year = Math.max(1980, d.getFullYear());
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
    date: ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

/* --- writing --------------------------------------------------------------- */

/* Entries are `{ name, data }` or `{ name, read() }`, where `read` returns a
   Buffer and is called once, when the entry's turn comes — so an export of a
   thousand photographs holds one photograph.

   Yields Buffers in order. The caller writes them to a response or
   concatenates them; this never holds the archive. */
export async function* zipStream(entries, {
  now = () => new Date(),
  /* Overridable so the ZIP64 branch is reachable in a test. */
  limits: { u32 = U32_MAX, u16 = U16_MAX } = {},
} = {}) {
  const central = [];
  let offset = 0;

  for (const entry of entries) {
    const name = Buffer.from(String(entry.name), "utf8");
    const { time, date } = dosDateTime(entry.date || now());

    let method, body, crc, size;

    if (entry.deflated) {
      /* Already compressed by the caller, which is how the export avoids
         holding a table's rows, its CSV and its compressed form at the same
         time: it deflates as it reads and hands the result over, keeping only
         the compressed bytes. The caller owes the CRC and the original size,
         since neither can be recovered from compressed data. */
      method = DEFLATE;
      body = toBuffer(entry.deflated);
      crc = entry.crc;
      size = entry.size;
      if (typeof crc !== "number" || typeof size !== "number") {
        throw new Error("A pre-deflated entry has to carry its crc and its size.");
      }
    } else {
      const data = entry.data != null ? toBuffer(entry.data) : toBuffer(await entry.read());

      /* Deflate unless it makes the entry bigger, which it does for anything
         already compressed — a JPEG, a PNG, a PDF that was compressed on the
         way in. Storing those is both smaller and faster. */
      method = DEFLATE;
      body = entry.store ? data : deflateRawSync(data, { level: 6 });
      if (entry.store || body.length >= data.length) {
        method = STORE;
        body = data;
      }
      crc = crc32(data);
      size = data.length;
    }

    /* ZIP64 on this entry if any of the three numbers it carries will not fit
       in thirty-two bits. The local header then holds 0xffffffff in their
       place and the real values in an extra field. */
    const needs64 = size > u32 || body.length > u32 || offset > u32;
    const localExtra = needs64 ? zip64Extra([size, body.length]) : Buffer.alloc(0);

    const header = Buffer.alloc(30);
    header.writeUInt32LE(LOCAL_SIG, 0);
    header.writeUInt16LE(needs64 ? 45 : 20, 4);       // version needed
    header.writeUInt16LE(UTF8_FLAG, 6);
    header.writeUInt16LE(method, 8);
    header.writeUInt16LE(time, 10);
    header.writeUInt16LE(date, 12);
    header.writeUInt32LE(crc, 14);
    header.writeUInt32LE(needs64 ? U32_MASK : body.length, 18);
    header.writeUInt32LE(needs64 ? U32_MASK : size, 22);
    header.writeUInt16LE(name.length, 26);
    header.writeUInt16LE(localExtra.length, 28);

    yield header;
    yield name;
    if (localExtra.length) yield localExtra;
    yield body;

    central.push({
      name, method, time, date, crc,
      compressed: body.length, uncompressed: size,
      offset, needs64,
    });
    offset += 30 + name.length + localExtra.length + body.length;
  }

  /* --- the central directory ---------------------------------------------- */

  const cdOffset = offset;
  let cdSize = 0;

  for (const e of central) {
    /* An entry needs the 64-bit form here if any of its three numbers does,
       and the offset is only known now — an entry written below 4GB in an
       archive that grew past it still needs its offset widened. */
    const fields = [];
    if (e.uncompressed > u32) fields.push(e.uncompressed);
    if (e.compressed > u32) fields.push(e.compressed);
    if (e.offset > u32) fields.push(e.offset);
    const wide = fields.length > 0;
    /* The order in the extra field is fixed by the format: uncompressed,
       compressed, offset — each present only if its 32-bit slot is masked. */
    const extra = wide ? zip64Extra([
      ...(e.uncompressed > u32 ? [e.uncompressed] : []),
      ...(e.compressed > u32 ? [e.compressed] : []),
      ...(e.offset > u32 ? [e.offset] : []),
    ]) : Buffer.alloc(0);

    const record = Buffer.alloc(46);
    record.writeUInt32LE(CENTRAL_SIG, 0);
    record.writeUInt16LE(wide ? 45 : 20, 4);          // version made by
    record.writeUInt16LE(wide ? 45 : 20, 6);          // version needed
    record.writeUInt16LE(UTF8_FLAG, 8);
    record.writeUInt16LE(e.method, 10);
    record.writeUInt16LE(e.time, 12);
    record.writeUInt16LE(e.date, 14);
    record.writeUInt32LE(e.crc, 16);
    record.writeUInt32LE(e.compressed > u32 ? U32_MASK : e.compressed, 20);
    record.writeUInt32LE(e.uncompressed > u32 ? U32_MASK : e.uncompressed, 24);
    record.writeUInt16LE(e.name.length, 28);
    record.writeUInt16LE(extra.length, 30);
    record.writeUInt16LE(0, 32);                      // comment length
    record.writeUInt16LE(0, 34);                      // disk number
    record.writeUInt16LE(0, 36);                      // internal attributes
    record.writeUInt32LE(0, 38);                      // external attributes
    record.writeUInt32LE(e.offset > u32 ? U32_MASK : e.offset, 42);

    yield record;
    yield e.name;
    if (extra.length) yield extra;
    cdSize += 46 + e.name.length + extra.length;
  }

  /* --- the end records ----------------------------------------------------- */

  const wideEnd = central.length > u16 || cdSize > u32 || cdOffset > u32;

  if (wideEnd) {
    /* The 64-bit end record, then the locator that points a reader at it.
       Both go before the ordinary end record, which stays behind with its
       fields masked — that is what makes the archive readable by something
       that does not know about ZIP64 right up to the point where it is not. */
    const z64 = Buffer.alloc(56);
    z64.writeUInt32LE(ZIP64_EOCD_SIG, 0);
    writeU64(z64, 44, 4);                             // size of this record - 12
    z64.writeUInt16LE(45, 12);                        // version made by
    z64.writeUInt16LE(45, 14);                        // version needed
    z64.writeUInt32LE(0, 16);                         // this disk
    z64.writeUInt32LE(0, 20);                         // disk with the directory
    writeU64(z64, central.length, 24);
    writeU64(z64, central.length, 32);
    writeU64(z64, cdSize, 40);
    writeU64(z64, cdOffset, 48);
    yield z64;

    const locator = Buffer.alloc(20);
    locator.writeUInt32LE(ZIP64_LOCATOR_SIG, 0);
    locator.writeUInt32LE(0, 4);                      // disk with the 64-bit record
    writeU64(locator, cdOffset + cdSize, 8);
    locator.writeUInt32LE(1, 16);                     // total disks
    yield locator;
  }

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(EOCD_SIG, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(central.length > u16 ? U16_MASK : central.length, 8);
  eocd.writeUInt16LE(central.length > u16 ? U16_MASK : central.length, 10);
  eocd.writeUInt32LE(cdSize > u32 ? U32_MASK : cdSize, 12);
  eocd.writeUInt32LE(cdOffset > u32 ? U32_MASK : cdOffset, 16);
  eocd.writeUInt16LE(0, 20);                          // comment length
  yield eocd;
}

/* The whole archive in memory. For tests and for anything small enough that
   the convenience is worth more than the memory. */
export async function zipBuffer(entries, opts) {
  const parts = [];
  for await (const chunk of zipStream(entries, opts)) parts.push(chunk);
  return Buffer.concat(parts);
}

/* Header id 0x0001, then each value that the 32-bit slot could not hold, in
   the order the format fixes. */
function zip64Extra(values) {
  const buf = Buffer.alloc(4 + values.length * 8);
  buf.writeUInt16LE(0x0001, 0);
  buf.writeUInt16LE(values.length * 8, 2);
  values.forEach((v, i) => writeU64(buf, v, 4 + i * 8));
  return buf;
}

/* Node's writeBigUInt64LE wants a BigInt, and every number that reaches here
   came from a Buffer length or an offset. */
function writeU64(buf, value, at) {
  buf.writeBigUInt64LE(BigInt(value), at);
}

function toBuffer(value) {
  if (Buffer.isBuffer(value)) return value;
  if (value == null) return Buffer.alloc(0);
  if (value instanceof Uint8Array) return Buffer.from(value);
  return Buffer.from(String(value), "utf8");
}
