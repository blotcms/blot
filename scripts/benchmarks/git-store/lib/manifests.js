// Reading and swapping manifests the way the coordinator's next foundation
// change does, which this branch does not have yet: immutable numbered
// objects, plus a hint.
//
//   manifests/<seq>.json     written once, with If-None-Match: *
//   manifest-hint.json       { "seq": N }, roughly the latest; rewritten after
//
// A read is the hint (one GET), then a HEAD for the next number (normally a
// miss, one HEAD), then a GET of the manifest itself, which is immutable and
// so can come from the cache. A swap is one conditional PUT, which is the
// compare-and-swap (it fails if that number exists), then one PUT of the hint.
//
// The numbers and sizes this produces are those of that design. The content
// of a manifest is still the foundation's (manifest.js), unchanged.
const { manifest, errors } = require("../../../../app/clients/git/store");

const HINT_KEY = "manifest-hint.json";
const key = (seq) => "manifests/" + seq + ".json";

function createManifests({ store, cache = null, lock = (fn) => fn() }) {
  const stats = { hintFailures: 0, retriedWrites: 0 };

  async function readHint() {
    try {
      const body = JSON.parse((await store.get(HINT_KEY, { maxBytes: 1024 })).toString("utf8"));
      return Number.isSafeInteger(body.seq) && body.seq >= 0 ? body.seq : 0;
    } catch (err) {
      if (err instanceof errors.NotFoundError || err instanceof SyntaxError) return 0;
      throw err;
    }
  }

  async function fetch(seq) {
    const cacheKey = store.id + "/" + key(seq);
    const hit = cache && (await cache.get(cacheKey));
    if (hit) {
      try {
        return manifest.parse(hit);
      } catch (err) {
        // damaged cache entry: fall through to the store
      }
    }
    const body = await store.get(key(seq), { maxBytes: 64 * 1024 * 1024 });
    const parsed = manifest.parse(body);
    if (cache) await cache.put(cacheKey, body);
    return parsed;
  }

  // The latest manifest, and how far past the hint it was found
  async function read() {
    let seq = await readHint();
    let ahead = 0;
    while (await store.head(key(seq + 1))) {
      seq++;
      ahead++;
    }
    if (seq === 0) return manifest.empty();
    const found = await fetch(seq);
    found.ahead = ahead;
    return found;
  }

  // Replaces `base` with `next` (next.seq === base.seq + 1). Throws
  // StaleManifestError, having changed nothing, if that number is taken.
  async function swap({ base, next }) {
    if (next.seq !== base.seq + 1) throw new errors.StaleManifestError("The new manifest does not follow the one it was built on");
    const body = manifest.serialize(next);

    return lock(async () => {
      try {
        await store.putIfAbsent(key(next.seq), body);
      } catch (err) {
        if (!(err instanceof errors.StaleManifestError)) throw err;
        // The number is taken. If what is there is exactly this manifest, an
        // earlier attempt of this same write landed and only its response was
        // lost (the SDK retries a request whose response never came): the
        // swap happened, and reporting a conflict would tell the pusher that
        // a push which is in the repository had failed.
        const there = await store.get(key(next.seq), { maxBytes: 64 * 1024 * 1024 }).catch(() => null);
        if (!there || !there.equals(body)) throw err;
        stats.retriedWrites++;
      }
      // This process knows what it wrote, and the next read of it is likely
      if (cache) await cache.put(store.id + "/" + key(next.seq), body).catch(() => {});
      try {
        await store.put(HINT_KEY, Buffer.from(JSON.stringify({ seq: next.seq })));
      } catch (err) {
        // The manifest is in: the push is durable and the next reader finds it
        // by looking forward from the hint, so this is not a failed push
        stats.hintFailures++;
      }
      return next;
    });
  }

  return { read, swap, stats, key, HINT_KEY };
}

module.exports = createManifests;
