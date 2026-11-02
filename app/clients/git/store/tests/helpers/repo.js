// A repository for the treediff and materialize specs, built with the real
// `git` binary by plumbing (no work tree is read), plus the oracles to check
// the store against: `git diff-tree` and `git checkout`. Not a spec itself.
//
//   const repo = makeRepo();
//   const first = repo.commit({ "a.txt": "A", "run.sh": { contents: "#!/bin/sh", mode: "100755" } });
//   const second = repo.commit({ "a.txt": null, "dir/b.txt": "B" });   // null removes
//   const { reader, store } = await repo.reader();                      // over the repo, packed
//   repo.remove();
const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const fx = require("./fixture");
const createReader = require("../../reader");
const createMemoryStore = require("../../objectStore/memory");

const ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_AUTHOR_NAME: "Test",
  GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "Test",
  GIT_COMMITTER_EMAIL: "test@example.com",
};

const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

function makeRepo() {
  const root = fx.tempDir();
  const dir = path.join(root, "repo");
  const elsewhere = path.join(root, "elsewhere");
  const index = path.join(root, "index");
  let head = null;

  fs.mkdirSync(elsewhere);
  fs.mkdirSync(dir);
  git(["init", "-q", "--bare"]);

  function git(args, input, env) {
    const result = spawnSync("git", args, {
      cwd: dir,
      env: { ...ENV, GIT_DIR: dir, ...env },
      input,
      maxBuffer: 1 << 30,
    });
    if (result.status !== 0) throw new Error("git " + args.join(" ") + " failed: " + result.stderr.toString());
    return result.stdout;
  }

  const text = (args, input, env) => git(args, input, env).toString().trim();

  function commitTree(tree) {
    const commit = text(["commit-tree", tree, "-m", "commit"].concat(head ? ["-p", head] : []));
    head = commit;
    return commit;
  }

  // A commit on top of the last one made, from changes to its files:
  //
  //   { "a.txt": "contents", "gone.txt": null,
  //     "run.sh": { contents: "#!/bin/sh", mode: "100755" } }
  //
  // A directory in the way of a file, or the reverse, is replaced.
  function commit(changes) {
    // update-index wants a work tree, though it does not read it here
    const env = { GIT_INDEX_FILE: index, GIT_WORK_TREE: elsewhere };

    for (const name of Object.keys(changes)) {
      const change = changes[name];

      if (change === null) {
        git(["update-index", "--force-remove", "-z", "--stdin"], name + "\0", env);
        continue;
      }

      const mode = change.mode || "100644";
      const contents = change.contents === undefined ? change : change.contents;
      const oid = text(["hash-object", "-w", "--stdin"], contents);

      git(["update-index", "--add", "--replace", "-z", "--index-info"], mode + " " + oid + "\t" + name + "\0", env);
    }

    return commitTree(text(["write-tree"], "", env));
  }

  // A commit of exactly the tree described, for names which `update-index`
  // refuses. A tree is { name: contents-or-tree }; an entry may also be
  // { contents, mode } for a mode other than 100644, or { oid, mode } for a submodule. Names are latin1, so
  // "b\xff" is a name which is not UTF-8.
  function commitExactly(tree) {
    function build(entries) {
      const records = [];

      for (const name of Object.keys(entries)) {
        const entry = entries[name];
        const isTree = typeof entry === "object" && !Buffer.isBuffer(entry) && entry.contents === undefined && !entry.oid;
        const mode = isTree ? "040000" : (entry.mode || "100644").padStart(6, "0");
        const oid = isTree
          ? build(entry)
          : entry.oid || text(["hash-object", "-w", "--stdin"], entry.contents === undefined ? entry : entry.contents);
        const type = isTree ? " tree " : mode === "160000" ? " commit " : " blob ";

        records.push(Buffer.from(mode + type + oid + "\t"));
        records.push(Buffer.from(name, "latin1"));
        records.push(Buffer.from([0]));
      }

      return text(["mktree", "-z", "--missing"], Buffer.concat(records));
    }

    return commitTree(build(tree));
  }

  // The commit's tree
  const treeOf = (commitId) => text(["rev-parse", commitId + "^{tree}"]);

  // Packs everything into one pack (or with `refDeltas`, with deltas which name
  // their base by ID), uploads it, and returns a reader over it
  async function readerOf({ refDeltas = false, cache = null, maxSize, store = createMemoryStore() } = {}) {
    text(["update-ref", "refs/heads/master", head]);
    fx.repackAll(dir, { refDeltas });

    const entries = [];
    for (const pack of readPacks()) entries.push(await fx.upload(store, pack, 0));

    return { store, reader: createReader({ store, cache, packs: entries, maxSize }), entries, packs: readPacks() };
  }

  function readPacks() {
    const packDir = path.join(dir, "objects", "pack");
    return fs
      .readdirSync(packDir)
      .filter((file) => file.endsWith(".pack"))
      .map((file) => {
        const name = file.slice(0, -".pack".length);
        return {
          name,
          pack: fs.readFileSync(path.join(packDir, file)),
          idx: fs.readFileSync(path.join(packDir, name + ".idx")),
        };
      });
  }

  // What `git diff-tree -r` says changed, as the same objects treediff yields
  // (without `valid`), in path order. Either side may be null.
  function diffTree(a, b) {
    const out = git(["diff-tree", "-r", "-z", "--raw", "--no-renames", "--no-abbrev", a || EMPTY_TREE, b || EMPTY_TREE]);
    const fields = [];
    let start = 0;

    for (let end = out.indexOf(0); end !== -1; end = out.indexOf(0, start)) {
      fields.push(out.subarray(start, end));
      start = end + 1;
    }

    const changes = [];
    for (let i = 0; i + 1 < fields.length; i += 2) {
      const meta = fields[i].toString().slice(1).split(" ");
      const zero = (value) => (/^0+$/.test(value) ? null : value);
      changes.push({
        path: fields[i + 1].toString("utf8"),
        oldMode: meta[0] === "000000" ? null : meta[0],
        oldOid: zero(meta[2]),
        newMode: meta[1] === "000000" ? null : meta[1],
        newOid: zero(meta[3]),
      });
    }

    return changes.sort(byPath);
  }

  // The files `git checkout` makes for a commit, as { path: { contents, mode } }
  // with mode "755" or "644" (a link is { link: target })
  function checkout(commitId) {
    const work = fs.mkdtempSync(path.join(root, "checkout-"));
    const env = { GIT_INDEX_FILE: path.join(work, ".index"), GIT_WORK_TREE: work };

    git(["read-tree", commitId], "", env);
    git(["checkout-index", "-a", "-f"], "", env);
    fs.rmSync(env.GIT_INDEX_FILE);

    return listFiles(work);
  }

  function remove() {
    fx.remove(root);
  }

  return { dir, root, git: text, commit, commitExactly, treeOf, reader: readerOf, diffTree, checkout, remove };
}

function byPath(x, y) {
  return x.path < y.path ? -1 : x.path > y.path ? 1 : 0;
}

// Everything below a directory as { "relative/path": { contents, mode } } for
// files, { link } for symbolic links and true for empty directories
function listFiles(directory, prefix = "") {
  const found = {};

  for (const name of fs.readdirSync(directory)) {
    const file = path.join(directory, name);
    const stat = fs.lstatSync(file);

    if (stat.isDirectory()) {
      const inner = listFiles(file, prefix + name + "/");
      if (Object.keys(inner).length) Object.assign(found, inner);
      else found[prefix + name + "/"] = true;
    } else if (stat.isSymbolicLink()) {
      found[prefix + name] = { link: fs.readlinkSync(file) };
    } else {
      found[prefix + name] = { contents: fs.readFileSync(file), mode: stat.mode & 0o111 ? "755" : "644" };
    }
  }

  return found;
}

module.exports = { makeRepo, listFiles, byPath, EMPTY_TREE };
