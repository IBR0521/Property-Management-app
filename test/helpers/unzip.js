/* A ZIP reader, for the tests only.

   Written from the other end of the specification on purpose. Verifying the
   writer with a reader that shares its code proves the two agree and nothing
   else — the first archive I wrote passed a check like that and was rejected
   by every real extractor, because the ZIP64 mask was being written as the
   test's own threshold rather than as 0xffffffff.

   So this walks the end-of-central-directory record, then the directory, and
   inflates each entry's data from its own local header. Where the format has
   two places to say the same thing, this reads the one the writer did not. */
import { inflateRawSync } from "node:zlib";

const EOCD_SIG = 0x06054b50;
const ZIP64_LOCATOR_SIG = 0x07064b50;
const ZIP64_EOCD_SIG = 0x06064b50;
const CENTRAL_SIG = 0x02014b50;
const LOCAL_SIG = 0x04034b50;

export function readZip(buf) {
  /* The end record is last, but a comment may follow the fixed part of it, so
     it is found by scanning back for the signature. */
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) { eocd = i; break; }
  }
  if (eocd === -1) throw new Error("no end-of-central-directory record");

  let count = buf.readUInt16LE(eocd + 10);
  let cdOffset = buf.readUInt32LE(eocd + 16);

  /* ZIP64: the 32-bit fields are masked and the real ones live in a second
     end record, found through a locator that sits just before this one. */
  if (count === 0xffff || cdOffset === 0xffffffff) {
    const locator = eocd - 20;
    if (buf.readUInt32LE(locator) !== ZIP64_LOCATOR_SIG) throw new Error("no zip64 locator");
    const at = Number(buf.readBigUInt64LE(locator + 8));
    if (buf.readUInt32LE(at) !== ZIP64_EOCD_SIG) throw new Error("no zip64 end record");
    count = Number(buf.readBigUInt64LE(at + 32));
    cdOffset = Number(buf.readBigUInt64LE(at + 48));
  }

  const entries = new Map();
  let p = cdOffset;

  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== CENTRAL_SIG) throw new Error(`entry ${n}: not a directory record`);
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16);
    let compressed = buf.readUInt32LE(p + 20);
    let uncompressed = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    let localAt = buf.readUInt32LE(p + 42);
    const name = buf.slice(p + 46, p + 46 + nameLen).toString("utf8");

    /* The 64-bit extra field carries only the values whose 32-bit slot was
       masked, in a fixed order — reading them positionally is what catches a
       writer that emits them unconditionally. */
    if (uncompressed === 0xffffffff || compressed === 0xffffffff || localAt === 0xffffffff) {
      const extra = buf.slice(p + 46 + nameLen, p + 46 + nameLen + extraLen);
      let e = 0, wide = null;
      while (e + 4 <= extra.length) {
        const headerId = extra.readUInt16LE(e);
        const size = extra.readUInt16LE(e + 2);
        if (headerId === 0x0001) { wide = extra.slice(e + 4, e + 4 + size); break; }
        e += 4 + size;
      }
      if (!wide) throw new Error(`${name}: masked size with no zip64 extra field`);
      let w = 0;
      if (uncompressed === 0xffffffff) { uncompressed = Number(wide.readBigUInt64LE(w)); w += 8; }
      if (compressed === 0xffffffff) { compressed = Number(wide.readBigUInt64LE(w)); w += 8; }
      if (localAt === 0xffffffff) { localAt = Number(wide.readBigUInt64LE(w)); w += 8; }
    }

    if (buf.readUInt32LE(localAt) !== LOCAL_SIG) throw new Error(`${name}: no local header`);
    const localNameLen = buf.readUInt16LE(localAt + 26);
    const localExtraLen = buf.readUInt16LE(localAt + 28);
    const start = localAt + 30 + localNameLen + localExtraLen;
    const raw = buf.slice(start, start + compressed);
    const data = method === 0 ? raw : inflateRawSync(raw);

    if (data.length !== uncompressed) {
      throw new Error(`${name}: says ${uncompressed} bytes, holds ${data.length}`);
    }
    if (crc32(data) !== crc) throw new Error(`${name}: CRC does not match`);

    entries.set(name, { name, data, method, utf8: Boolean(flags & 0x0800), uncompressed });
    p += 46 + nameLen + extraLen + commentLen;
  }

  return entries;
}

/* Its own implementation, not the one under test. */
function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
  }
  return (c ^ -1) >>> 0;
}
