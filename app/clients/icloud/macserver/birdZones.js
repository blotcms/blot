// When bird last received anything from iCloud. bird keeps each shared
// folder's state (its "zone") in client_zones as an NSKeyedArchiver binary
// plist, with lastSyncDownDate: when it last fetched a change to that folder.
// The newest across every zone is when iCloud last delivered anything to this
// Mac. Unlike bird's change journal, the macserver's own downloads and
// evictions don't move it, so it goes stale when the link from iCloud to this
// Mac breaks (bird signed out, pushes no longer arriving).
//
// Like birdState.js this reads Apple's undocumented database, read-only and
// best effort: anything unexpected resolves to null.

import { database } from "./birdState.js";
import clfdate from "./util/clfdate.js";

// NSDate counts seconds from 2001-01-01
const APPLE_EPOCH_MS = Date.UTC(2001, 0, 1);

// A minimal reader of Apple's binary plist format ("bplist00"): ints, reals,
// dates, strings, data, arrays, dicts and UIDs, which is all NSKeyedArchiver
// writes for a zone
const readBplist = (buf) => {
  if (buf.toString("ascii", 0, 8) !== "bplist00") throw new Error("not bplist");
  const t = buf.length - 32;
  const offsetSize = buf[t + 6];
  const refSize = buf[t + 7];
  const count = Number(buf.readBigUInt64BE(t + 8));
  const top = Number(buf.readBigUInt64BE(t + 16));
  const tableAt = Number(buf.readBigUInt64BE(t + 24));
  const uint = (at, size) => buf.readUIntBE(at, size);
  const offset = (i) => uint(tableAt + i * offsetSize, offsetSize);

  const parse = (i, depth = 0) => {
    if (depth > 50 || i >= count) throw new Error("bad plist");
    let at = offset(i);
    const marker = buf[at];
    const type = marker >> 4;
    let n = marker & 0xf;
    const length = () => {
      if (n !== 0xf) return n;
      const size = 1 << (buf[at + 1] & 0xf);
      const value = uint(at + 2, size);
      at += 1 + size;
      return value;
    };
    switch (type) {
      case 0x0:
        return marker === 0x09 ? true : marker === 0x08 ? false : null;
      case 0x1:
        return 1 << n <= 6
          ? uint(at + 1, 1 << n)
          : Number(buf.readBigInt64BE(at + 1));
      case 0x2:
        return n === 2 ? buf.readFloatBE(at + 1) : buf.readDoubleBE(at + 1);
      case 0x3:
        return { date: buf.readDoubleBE(at + 1) };
      case 0x4: {
        const len = length();
        return buf.subarray(at + 1, at + 1 + len);
      }
      case 0x5: {
        const len = length();
        return buf.toString("ascii", at + 1, at + 1 + len);
      }
      case 0x6: {
        const len = length();
        // swap16 works in place, so on a copy of the slice
        return Buffer.from(buf.subarray(at + 1, at + 1 + len * 2))
          .swap16()
          .toString("utf16le");
      }
      case 0x8:
        return { uid: uint(at + 1, n + 1) };
      case 0xa: {
        const len = length();
        const out = [];
        for (let k = 0; k < len; k++)
          out.push(parse(uint(at + 1 + k * refSize, refSize), depth + 1));
        return out;
      }
      case 0xd: {
        const len = length();
        const out = {};
        for (let k = 0; k < len; k++) {
          const key = parse(uint(at + 1 + k * refSize, refSize), depth + 1);
          out[key] = parse(
            uint(at + 1 + (len + k) * refSize, refSize),
            depth + 1
          );
        }
        return out;
      }
      default:
        throw new Error(`unsupported plist type ${type}`);
    }
  };

  return parse(top);
};

// The archived root's lastSyncDownDate, as ms since the epoch, or null
const lastSyncDown = (blob) => {
  const archive = readBplist(blob);
  const objects = archive.$objects;
  const resolve = (v) => (v && typeof v.uid === "number" ? objects[v.uid] : v);
  const root = resolve(archive.$top && archive.$top.root);
  if (!root) return null;

  let value;
  if (Array.isArray(root["NS.keys"])) {
    const keys = root["NS.keys"].map(resolve);
    const i = keys.indexOf("lastSyncDownDate");
    if (i !== -1) value = resolve(root["NS.objects"][i]);
  } else {
    value = resolve(root.lastSyncDownDate);
  }

  const seconds =
    value && typeof value["NS.time"] === "number"
      ? value["NS.time"]
      : value && typeof value.date === "number"
        ? value.date
        : null;
  return seconds === null ? null : APPLE_EPOCH_MS + seconds * 1000;
};

// Read again at most every five minutes: it changes slowly, and /stats is
// asked every minute
const REFRESH_MS = 5 * 60_000;
let cached = { at: 0, value: null };

// Resolves to ms since the epoch of the newest sync-down across bird's zones,
// or null when the database can't be read
const lastDeliveryFromiCloud = async (now = Date.now()) => {
  if (now - cached.at < REFRESH_MS) return cached.value;
  let newest = null;
  try {
    const db = await database();
    if (db) {
      for (const { plist } of db
        .prepare("select zone_plist plist from client_zones")
        .all()) {
        if (!plist) continue;
        let when = null;
        try {
          when = lastSyncDown(Buffer.from(plist));
        } catch {
          continue;
        }
        if (when !== null && (newest === null || when > newest)) newest = when;
      }
    }
  } catch (error) {
    console.warn(clfdate(), "birdZones: could not read zones:", error.message);
    newest = null;
  }
  cached = { at: now, value: newest };
  return newest;
};

export { lastDeliveryFromiCloud, lastSyncDown, readBplist };
