// Diffs two trees by ranged reads of tree objects, and yields the files which
// differ one at a time. Where a tree has the same ID on both sides it is
// skipped without being read, so the cost of a diff follows the size of the
// change, not of the repository.
//
//   for await (const change of diffTrees({ reader, a, b })) ...
//
// `a` and `b` are tree IDs, or null for the empty tree. Each change is
//
//   { path, oldMode, oldOid, newMode, newOid, valid }
//
// for a file, a symbolic link or a submodule (never a directory). A file which
// was added has null for its old mode and ID, one which was removed has null
// for its new ones. `valid` is false if a name in the path is not UTF-8, in
// which case the path holds replacement characters and cannot name the file.
// Modes are as git writes them in a tree ("100644", "120000", "160000").
//
// Only one directory's entries, and a few of the directories below it, are held
// at once, so memory follows the width and depth of the tree and not its size.
//
// The order is one a sink can apply as it goes. Within a directory everything
// that goes away comes before anything that comes in: first the files which
// are gone or become a directory, and everything under directories which are
// gone or become a file, then the rest. So a file which turns into a directory
// (or the reverse) is removed before its replacement is written, and so are
// two names which differ only by case. Which of two directories that both
// change comes first is not defined, so a case-insensitive folder is only
// safe if the sink waits for earlier writes before each removal (materialize
// does).
const { CorruptError, NotFoundError } = require("./errors");

// What git calls the tree with nothing in it. It need not be stored.
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

const DEFAULT_CONCURRENCY = 8;

const DIRECTORY = "40000";

function normalize(oid) {
  return !oid || oid === EMPTY_TREE ? null : oid;
}

// The entries of a tree as Map(raw name -> { name, valid, mode, oid }). The
// names are kept as bytes (latin1 text) for matching, because parseTree
// decodes them as UTF-8 and so cannot tell two different invalid names apart.
function entriesOf(data) {
  const entries = new Map();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let at = 0;

  while (at < data.length) {
    const space = data.indexOf(32, at);
    const nul = space === -1 ? -1 : data.indexOf(0, space);
    if (nul === -1 || nul + 21 > data.length) throw new CorruptError("Invalid tree: an entry is cut short");

    const mode = data.toString("latin1", at, space).replace(/^0+/, "");
    if (!/^[0-7]{5,6}$/.test(mode)) throw new CorruptError("Invalid tree: an entry has the mode " + JSON.stringify(mode));

    const raw = data.subarray(space + 1, nul);
    let name = null;
    try {
      name = decoder.decode(raw);
    } catch (err) {
      name = raw.toString("utf8");
    }

    entries.set(raw.toString("latin1"), {
      name,
      valid: Buffer.from(name, "utf8").equals(raw),
      mode,
      oid: data.toString("hex", nul + 1, nul + 21),
    });
    at = nul + 21;
  }

  return entries;
}

async function load(reader, oid) {
  oid = normalize(oid);
  if (!oid) return new Map();

  const tree = await reader.read(oid);
  if (!tree) throw new NotFoundError("Tree " + oid + " is not in the repository");
  if (tree.type !== "tree") throw new CorruptError("Object " + oid + " is a " + tree.type + ", not a tree");

  return entriesOf(tree.data);
}

// A function which gives the loaded pair of trees for each of `pairs` ([a, b]
// IDs) in order, having started on the next few before they are asked for.
// Whatever is not asked for is never held: a failed read nobody awaits is
// ignored, and the rest are garbage collected with the iterator.
function readAhead(reader, pairs, concurrency) {
  const started = [];

  function start(i) {
    if (i >= pairs.length || started[i]) return;
    started[i] = Promise.all([load(reader, pairs[i][0]), load(reader, pairs[i][1])]);
    started[i].catch(function () {});
  }

  return function get(i) {
    for (let k = i; k < i + concurrency; k++) start(k);
    const pair = started[i];
    started[i] = null;
    return pair;
  };
}

function change(prefix, valid, left, right) {
  const entry = right || left;
  return {
    path: prefix + entry.name,
    oldMode: left ? left.mode : null,
    oldOid: left ? left.oid : null,
    newMode: right ? right.mode : null,
    newOid: right ? right.oid : null,
    valid: valid && entry.valid,
  };
}

const isTree = (entry) => !!entry && entry.mode === DIRECTORY;

async function* walk(reader, left, right, prefix, valid, concurrency) {
  const gone = []; // directories which go away, or become a file
  const later = []; // the second half in order: { file } or { pair: [a, b, entry] }

  for (const key of new Set([...left.keys(), ...right.keys()])) {
    const l = left.get(key) || null;
    const r = right.get(key) || null;

    if (l && r && l.mode === r.mode && l.oid === r.oid) continue;

    if (isTree(l) && !isTree(r)) gone.push(l);
    else if (l && !isTree(l) && (!r || isTree(r))) yield change(prefix, valid, l, null);

    if (isTree(r)) later.push({ pair: [isTree(l) ? l.oid : null, r.oid, r] });
    else if (r) later.push({ file: change(prefix, valid, l && !isTree(l) ? l : null, r) });
  }

  // Directories which go away, with everything in them, before anything else
  const goneAhead = readAhead(reader, gone.map((entry) => [entry.oid, null]), concurrency);
  for (let i = 0; i < gone.length; i++) {
    const [l, r] = await goneAhead(i);
    yield* walk(reader, l, r, prefix + gone[i].name + "/", valid && gone[i].valid, concurrency);
  }

  const pairs = later.filter((item) => item.pair).map((item) => item.pair);
  const ahead = readAhead(reader, pairs, concurrency);
  let next = 0;

  for (const item of later) {
    if (item.file) {
      yield item.file;
      continue;
    }

    const entry = item.pair[2];
    const [l, r] = await ahead(next++);
    yield* walk(reader, l, r, prefix + entry.name + "/", valid && entry.valid, concurrency);
  }
}

async function* diffTrees({ reader, a = null, b = null, concurrency = DEFAULT_CONCURRENCY }) {
  if (normalize(a) === normalize(b)) return;

  const [left, right] = await Promise.all([load(reader, a), load(reader, b)]);
  yield* walk(reader, left, right, "", true, concurrency);
}

// Every change, as an array. For the specs and small trees: the generator is
// what keeps memory bounded.
async function collect(options) {
  const changes = [];
  for await (const item of diffTrees(options)) changes.push(item);
  return changes;
}

module.exports = { diffTrees, collect, EMPTY_TREE };
