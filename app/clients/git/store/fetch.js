// Fetch: what a client which already has part of the repository needs, worked
// out from the commits it says it has (its `have` lines) and the manifest.
//
// A fetch is sent the packs newer than the newest ref snapshot the client
// provably has. The manifest keeps the refs as they were after every push (a
// snapshot, with the seq of its push). A client has a snapshot when it has
// every tip in it, and then it has everything that was reachable from the refs
// at that push. What it lacks is reachable now and was not then, and every pack
// of a later push holds what that push added, which is all that was not
// reachable from the refs before it (a client builds a push's pack against the
// refs it was shown, and Blot's own commits add only what is new). So the
// packs with a seq above the snapshot's hold everything the client lacks, and
// those are sent whole. They can also hold objects the client has; that is
// accepted. A force push needs no special case: an older snapshot is still
// the refs the client may have.
//
// Two ways to know the client has a snapshot's tips:
//
//   - Its haves list them. This needs only the manifest. A client sends its
//     ref tips first, so a client one push behind is found in its first round.
//   - A tip is an ancestor of a have. That is a walk of the commit graph from
//     the haves, and the graph is the history pieces and the history pack, read
//     whole (history.js), so it costs a request for each of them however long
//     the history is, and no request for each commit. The walk is bounded
//     (`maxWalk`): a walk which stops early has only seen ancestors, so what it
//     proves is still true, and it proves less.
//
// If neither proves a snapshot, everything is sent, as a clone does. That is
// the answer for a client with an unrelated history, and for one which lacks
// a tip that has been in the refs since the start (an old tag it never
// fetched): every snapshot has that tip, so none is provable. It is also the
// answer when the history is too big to read (`maxHistory`).
//
// A snapshot's tag refs are proven by the commits the tags point at (the
// manifest's `peeled`), which does not prove the client has the tag objects
// themselves. A client which lacks one and asks for it must get it, so every
// annotated tag asked for is checked to be in the packs chosen, and if it is
// not, everything is sent. A tag pushed after the snapshot is in a pack of a
// later push, so the usual case costs a few reads.
//
// Negotiation is stateless, as it has to be over HTTP: each request carries
// the wants and the haves the client has had acknowledged, and the answer comes
// from that request alone. So the commits acknowledged as common are
// the ones the next request carries, and they must be enough to reach the same
// proof. Every have which is a commit of this repository is acknowledged
// (when the proof is a snapshot's tips listed in the haves, only the haves that
// are tips of some snapshot are, which is all it needs and costs no history).
const { readHistory } = require("./history");
const createReader = require("./reader");
const { parseTag } = require("./objects");

// The most commits a walk visits
const MAX_WALK = 500000;

// How many tags deep a tag is followed to check it is in the packs chosen
const MAX_TAG_CHAIN = 16;

const hasOwn = (object, key) => Object.prototype.hasOwnProperty.call(object, key);

// The object a ref value stands for in a snapshot: a commit, or for an
// annotated tag the object it finally points at
const tipOf = (manifest, oid) => (manifest.peeled && manifest.peeled[oid]) || oid;

// The seq of the newest snapshot whose tips all satisfy `has`, or 0
function newestProvable(manifest, has) {
  for (let i = manifest.snapshots.length - 1; i >= 0; i--) {
    const snapshot = manifest.snapshots[i];
    if (Object.values(snapshot.refs).every((oid) => has(tipOf(manifest, oid)))) return snapshot.seq;
  }
  return 0;
}

// The commits reachable from `starts` (itself included), up to `limit` of them
function ancestors(graph, starts, limit) {
  const seen = new Set(starts);
  const queue = [...seen];

  for (let at = 0; at < queue.length && seen.size < limit; at++) {
    for (const parent of graph.parents(queue[at]) || []) {
      if (!seen.has(parent)) {
        seen.add(parent);
        queue.push(parent);
      }
    }
  }
  return seen;
}

// What a request's haves prove. Resolves
//
//   floor     the seq of the newest snapshot the client has, or 0
//   commons   the haves to acknowledge, in the order they came, once each
//   ready     whether the server can stop negotiating: a snapshot was proven
//   walked    commits the walk visited (0 if there was none)
//   graph()   resolves the commit graph (history.js), or null if it is too big;
//             read at most once
//
// `limiter` (clone.js's createLimiter) is held while history is read, because
// that is a lot of memory for a request to hold.
async function negotiate({ store, cache, manifest, haves, limiter = null, maxWalk = MAX_WALK, maxHistory }) {
  let loading = null;
  const graph = () => {
    if (!loading) {
      loading = (async () => {
        const release = limiter ? await limiter.acquire() : () => {};
        try {
          return await readHistory({ store, cache, manifest, maxBytes: maxHistory });
        } finally {
          release();
        }
      })();
    }
    return loading;
  };

  const had = new Set(haves);
  const once = (list) => [...new Set(list)];

  const direct = newestProvable(manifest, (oid) => had.has(oid));
  if (direct || !haves.length) {
    const tips = new Set();
    for (const snapshot of manifest.snapshots) for (const oid of Object.values(snapshot.refs)) tips.add(tipOf(manifest, oid));
    return settled({ floor: direct, commons: once(haves.filter((oid) => tips.has(oid))), walked: 0, graph });
  }

  const history = await graph();
  if (!history) return { floor: 0, commons: [], ready: false, walked: 0, graph };

  const commons = once(haves.filter((oid) => history.has(oid)));
  const reached = ancestors(history, commons, maxWalk);
  const floor = newestProvable(manifest, (oid) => reached.has(oid));
  return settled({ floor, commons, walked: reached.size, graph });
}

// A snapshot with no refs is proven by any haves at all, even none. That is
// true (the client has all of nothing) but there is no common commit to
// acknowledge, so the server could not say what it is ready on, and the client
// has not shown it has anything. Without a common commit the floor is 0.
function settled(found) {
  if (!found.commons.length) found.floor = 0;
  return { ...found, ready: found.floor > 0 };
}

// Whether the annotated tags in `wants` are in `packs`, with what they point
// at unless that is a commit (which the client has, or is in a pack of a later
// push as every new commit is)
async function tagsAreSent({ store, cache, manifest, packs, wants, negotiation }) {
  let isTag;
  if (manifest.peeled) {
    isTag = (oid) => hasOwn(manifest.peeled, oid);
  } else {
    // A manifest from before tags were peeled: whatever is not a commit
    const history = await negotiation.graph();
    if (!history) return false;
    isTag = (oid) => !history.has(oid);
  }

  const asked = wants.filter(isTag);
  if (!asked.length) return true;

  const reader = createReader({ store, cache, packs });
  for (let oid of asked) {
    for (let depth = 0; ; depth++) {
      if (depth > MAX_TAG_CHAIN) return false;

      const found = await reader.read(oid);
      if (!found) return false;
      if (found.type !== "tag") break;

      const tag = parseTag(found.data);
      if (tag.type === "commit") break;
      oid = tag.object;
    }
  }
  return true;
}

// The packs to send for a request whose haves were negotiated: those newer
// than `negotiation.floor`, or all of them when the floor is 0 or a tag asked
// for would not be sent. Resolves { packs, floor } with the floor used.
async function choosePacks({ store, cache, manifest, wants, negotiation }) {
  const all = manifest.packs;
  if (negotiation.floor === 0) return { packs: all, floor: 0 };

  const packs = all.filter((pack) => pack.seq > negotiation.floor);
  if (packs.length < all.length && !(await tagsAreSent({ store, cache, manifest, packs, wants, negotiation }))) {
    return { packs: all, floor: 0 };
  }
  return { packs, floor: negotiation.floor };
}

module.exports = { negotiate, choosePacks, ancestors, MAX_WALK };
