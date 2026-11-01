// Writing git objects, packs and version 2 pack indexes in plain Node, for the
// synthetic repository generator and for the harness's own commits.
const crypto = require("crypto");
const fs = require("fs");
const zlib = require("zlib");

const TYPE_CODES = { commit: 1, tree: 2, blob: 3, tag: 4 };
const OFS_DELTA = 6;
const REF_DELTA = 7;

const sha1 = (...parts) => {
  const hash = crypto.createHash("sha1");
  for (const part of parts) hash.update(part);
  return hash.digest();
};

function objectId(type, body) {
  return sha1(type + " " + body.length + "\0", body).toString("hex");
}

let crcTable;
function crc32(buffer, crc = 0) {
  if (!crcTable) {
    crcTable = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c;
    }
  }
  let c = ~crc;
  for (let i = 0; i < buffer.length; i++) c = crcTable[(c ^ buffer[i]) & 0xff] ^ (c >>> 8);
  return ~c >>> 0;
}

// Git sorts tree entries by name, with a directory compared as if its name
// ended in "/"
function serializeTree(entries) {
  const sorted = [...entries].sort((a, b) => {
    const x = Buffer.from(a.name + (a.mode === "40000" ? "/" : ""));
    const y = Buffer.from(b.name + (b.mode === "40000" ? "/" : ""));
    return Buffer.compare(x, y);
  });
  return Buffer.concat(
    sorted.map((e) => Buffer.concat([Buffer.from(e.mode + " " + e.name + "\0"), Buffer.from(e.oid, "hex")]))
  );
}

function parseTree(buffer) {
  const entries = [];
  let i = 0;
  while (i < buffer.length) {
    const space = buffer.indexOf(32, i);
    const nul = buffer.indexOf(0, space);
    entries.push({
      mode: buffer.toString("latin1", i, space),
      name: buffer.toString("utf8", space + 1, nul),
      oid: buffer.subarray(nul + 1, nul + 21).toString("hex"),
    });
    i = nul + 21;
  }
  return entries;
}

function serializeCommit({ tree, parents, time, message, name = "Blog Author", email = "author@example.com" }) {
  const who = name + " <" + email + "> " + time + " +0000";
  return Buffer.from(
    "tree " + tree + "\n" + parents.map((p) => "parent " + p + "\n").join("") + "author " + who + "\ncommitter " + who + "\n\n" + message + "\n"
  );
}

function parseCommit(buffer) {
  const text = buffer.toString("utf8");
  const head = text.slice(0, text.indexOf("\n\n"));
  return {
    tree: /^tree (\w{40})/m.exec(head)[1],
    parents: [...head.matchAll(/^parent (\w{40})/gm)].map((m) => m[1]),
  };
}

function varint(n) {
  const out = [];
  do {
    let byte = n & 0x7f;
    n = Math.floor(n / 128);
    if (n) byte |= 0x80;
    out.push(byte);
  } while (n);
  return Buffer.from(out);
}

// A delta turning `base` into `target` which keeps their common start and end
// and inserts what is between. Good for the localised edits the generator
// makes, and valid for anything.
function makeDelta(base, target) {
  let prefix = 0;
  const limit = Math.min(base.length, target.length);
  while (prefix < limit && base[prefix] === target[prefix]) prefix++;
  let suffix = 0;
  while (suffix < limit - prefix && base[base.length - 1 - suffix] === target[target.length - 1 - suffix]) suffix++;

  const parts = [varint(base.length), varint(target.length)];

  function copy(offset, size) {
    while (size > 0) {
      const take = Math.min(size, 0xffffff);
      const bytes = [];
      let flags = 0x80;
      for (let k = 0; k < 4; k++) {
        const byte = Math.floor(offset / 2 ** (8 * k)) & 0xff;
        if (byte) {
          flags |= 1 << k;
          bytes.push(byte);
        }
      }
      for (let k = 0; k < 3; k++) {
        const byte = (take >> (8 * k)) & 0xff;
        if (byte) {
          flags |= 16 << k;
          bytes.push(byte);
        }
      }
      parts.push(Buffer.from([flags, ...bytes]));
      offset += take;
      size -= take;
    }
  }

  function insert(data) {
    for (let at = 0; at < data.length; at += 127) {
      const chunk = data.subarray(at, at + 127);
      parts.push(Buffer.from([chunk.length]), chunk);
    }
  }

  if (prefix) copy(0, prefix);
  insert(target.subarray(prefix, target.length - suffix));
  if (suffix) copy(base.length - suffix, suffix);
  return Buffer.concat(parts);
}

function entryHeader(code, size) {
  const out = [];
  let byte = (code << 4) | (size & 15);
  size = Math.floor(size / 16);
  while (size) {
    out.push(byte | 0x80);
    byte = size & 0x7f;
    size = Math.floor(size / 128);
  }
  out.push(byte);
  return Buffer.from(out);
}

function ofsEncode(distance) {
  const bytes = [distance & 0x7f];
  while ((distance = Math.floor(distance / 128))) {
    distance--;
    bytes.unshift(0x80 | (distance & 0x7f));
  }
  return Buffer.from(bytes);
}

// Writes a pack to a file, entry by entry. Entries are
//   whole(type, oid, body)           an object stored whole
//   ofsDelta(oid, baseOffset, delta) a delta against an earlier entry
//   refDelta(oid, baseOid, delta)    a delta against any object
// each returning the entry's offset. finish() fixes the object count, adds
// the checksum and returns the pack's name, size and index bytes.
function createPackWriter(file) {
  const fd = fs.openSync(file, "w+");
  const header = Buffer.alloc(12);
  header.write("PACK");
  header.writeUInt32BE(2, 4);
  fs.writeSync(fd, header);

  let position = 12;
  const entries = [];
  let pending = [];
  let pendingSize = 0;

  function flush() {
    if (pending.length) fs.writeSync(fd, Buffer.concat(pending));
    pending = [];
    pendingSize = 0;
  }

  function write(oid, buffer) {
    const offset = position;
    entries.push({ oid, offset, crc: crc32(buffer) });
    pending.push(buffer);
    pendingSize += buffer.length;
    position += buffer.length;
    if (pendingSize > 4 * 1024 * 1024) flush();
    return offset;
  }

  // Already-compressed images gain nothing from deflate; storing them is the
  // same bytes git would write for a JPEG and costs no time.
  const deflate = (data, level) => zlib.deflateSync(data, { level });

  return {
    get size() {
      return position;
    },
    get count() {
      return entries.length;
    },
    whole(type, oid, body, level = 1) {
      return write(oid, Buffer.concat([entryHeader(TYPE_CODES[type], body.length), deflate(body, level)]));
    },
    ofsDelta(oid, baseOffset, delta) {
      const here = position;
      return write(
        oid,
        Buffer.concat([entryHeader(OFS_DELTA, delta.length), ofsEncode(here - baseOffset), deflate(delta, 1)])
      );
    },
    refDelta(oid, baseOid, delta) {
      return write(
        oid,
        Buffer.concat([entryHeader(REF_DELTA, delta.length), Buffer.from(baseOid, "hex"), deflate(delta, 1)])
      );
    },
    finish() {
      flush();
      const count = Buffer.alloc(4);
      count.writeUInt32BE(entries.length);
      fs.writeSync(fd, count, 0, 4, 8);

      const hash = crypto.createHash("sha1");
      const chunk = Buffer.alloc(4 * 1024 * 1024);
      for (let at = 0; at < position; ) {
        const n = fs.readSync(fd, chunk, 0, Math.min(chunk.length, position - at), at);
        hash.update(chunk.subarray(0, n));
        at += n;
      }
      const checksum = hash.digest();
      fs.writeSync(fd, checksum, 0, 20, position);
      fs.closeSync(fd);

      const name = "pack-" + checksum.toString("hex");
      return { name, size: position + 20, objects: entries.length, idx: createIndex(entries, checksum), entries };
    },
  };
}

// A version 2 index for `entries` ({ oid, offset, crc }) of a pack with
// checksum `packChecksum`
function createIndex(entries, packChecksum) {
  const sorted = [...entries].sort((a, b) => (a.oid < b.oid ? -1 : a.oid > b.oid ? 1 : 0));
  const n = sorted.length;
  const large = sorted.filter((e) => e.offset >= 0x80000000);
  const out = Buffer.alloc(8 + 1024 + n * 28 + large.length * 8 + 40);

  out.writeUInt32BE(0xff744f63, 0);
  out.writeUInt32BE(2, 4);

  const fanout = new Array(256).fill(0);
  for (const e of sorted) fanout[parseInt(e.oid.slice(0, 2), 16)]++;
  let total = 0;
  for (let i = 0; i < 256; i++) {
    total += fanout[i];
    out.writeUInt32BE(total, 8 + i * 4);
  }

  const ids = 8 + 1024;
  const crcs = ids + n * 20;
  const offsets = crcs + n * 4;
  const bigs = offsets + n * 4;
  let big = 0;
  sorted.forEach((e, i) => {
    Buffer.from(e.oid, "hex").copy(out, ids + i * 20);
    out.writeUInt32BE(e.crc, crcs + i * 4);
    if (e.offset >= 0x80000000) {
      out.writeUInt32BE(0x80000000 | big, offsets + i * 4);
      out.writeBigUInt64BE(BigInt(e.offset), bigs + big * 8);
      big++;
    } else {
      out.writeUInt32BE(e.offset, offsets + i * 4);
    }
  });

  const end = bigs + big * 8;
  packChecksum.copy(out, end);
  sha1(out.subarray(0, end + 20)).copy(out, end + 20);
  return out;
}

module.exports = {
  TYPE_CODES,
  sha1,
  objectId,
  crc32,
  serializeTree,
  parseTree,
  serializeCommit,
  parseCommit,
  makeDelta,
  createPackWriter,
  createIndex,
  entryHeader,
  ofsEncode,
  varint,
};
