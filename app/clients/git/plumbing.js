// Commits made to a blog's bare repository with git's plumbing, for Blot's own
// writes (repo.commit) and the first import of a folder (create.js). There is
// no checkout to commit in: a file is hashed into the repository, a temporary
// index (a file of its own, never the repository's) is changed to hold it, and
// the tree and commit written from the index move master with a compare and
// swap on the commit it started from.
//
// Callers hold the ref lock (repo.holdRefLock) around a commit. The swap still
// names the old commit, so that if master moves some other way (a lock which
// expired under a stalled process, or code which doesn't take it), the commit
// is refused and never replaces a push.
const { spawn } = require("child_process");
const fs = require("fs-extra");
const path = require("path");
const tempDir = require("helper/tempDir");
const pathNormalizer = require("helper/pathNormalizer");
const limiter = require("./limiter");
const gc = require("./gc");

const ZERO = "0".repeat(40);
const MASTER = "refs/heads/master";

// What the Docker image configures as the identity of any commit made on the
// server, and so who the commits made with `git commit` were by. It is set here
// so that commits do not depend on the host's git configuration.
const IDENTITY = {
  GIT_AUTHOR_NAME: "Your Name",
  GIT_AUTHOR_EMAIL: "you@example.com",
  GIT_COMMITTER_NAME: "Your Name",
  GIT_COMMITTER_EMAIL: "you@example.com",
};

const TIMEOUT_MS = 2 * 60 * 1000;

// A commit made over a master which moved is made again on the new master,
// this many times
const ATTEMPTS = 3;

const STDERR_BYTES = 4096;

// Runs git in the bare repository. Resolves with { code, stdout, stderr }
// (stdout a Buffer) whatever the exit code is. Rejects if git can't be run.
//
// Blot's commits and the import of a new repository are background work (see
// limiter.js).
function run(directory, args, options) {
  options = options || {};

  return limiter.run("background", function () {
    return spawnGit(directory, limiter.args(args), options);
  });
}

function spawnGit(directory, args, options) {
  return new Promise(function (resolve, reject) {
    const child = spawn("git", args, {
      cwd: options.cwd || directory,
      env: Object.assign({}, process.env, { GIT_DIR: directory }, options.env),
      stdio: ["pipe", "pipe", "pipe"],
      timeout: options.timeout || TIMEOUT_MS,
      killSignal: "SIGKILL",
    });
    const stdout = [];
    let stderr = "";

    child.stdout.on("data", function (chunk) {
      stdout.push(chunk);
    });
    child.stderr.on("data", function (chunk) {
      if (stderr.length < STDERR_BYTES) stderr += chunk;
    });
    child.stdin.on("error", function () {});
    child.on("error", reject);
    child.on("close", function (code, signal) {
      resolve({
        code: signal ? 1 : code,
        stdout: Buffer.concat(stdout),
        stderr: signal ? "git was stopped: " + signal : stderr,
      });
    });

    child.stdin.end(options.input);
  });
}

function failure(args, result) {
  return new Error("git " + args[0] + " failed: " + result.stderr.trim());
}

// The commit master points to, or null if the repository has none yet
async function head(directory) {
  const args = ["rev-parse", "--verify", "--quiet", MASTER + "^{commit}"];
  const result = await run(directory, args);

  // Exits 1 with no output if there is no such ref
  if (result.code === 1 && !result.stderr) return null;
  if (result.code) throw failure(args, result);

  return result.stdout.toString().trim();
}

// A temporary index for the repository, kept in a directory of its own so
// that two commits never share one, and removed by close(). With options.workTree
// `git add` in it adds files from that folder, as it would in a checkout.
//
//   index.git(args, { input, env })  resolves with git's stdout, a string
//   index.close()                    removes the index
async function openIndex(directory, options) {
  options = options || {};

  const folder = await fs.mkdtemp(path.join(tempDir(), "git-index-"));
  const env = {
    GIT_INDEX_FILE: path.join(folder, "index"),
    // A file is named exactly, a name like "[draft].md" is not a pattern
    GIT_LITERAL_PATHSPECS: "1",
  };

  if (options.workTree) env.GIT_WORK_TREE = options.workTree;

  return {
    git: async function (args, more) {
      more = more || {};

      const result = await run(directory, args, {
        input: more.input,
        cwd: options.workTree,
        env: Object.assign({}, env, more.env),
      });

      if (result.code) throw failure(args, result);

      return result.stdout.toString();
    },
    close: function () {
      return fs.remove(folder);
    },
  };
}

// Writes a commit of the tree on top of parent (null for the first commit),
// with master untouched. Resolves with its ID.
async function commitTree(index, tree, parent, message) {
  const args = ["commit-tree", tree, "-m", message];

  if (parent) args.push("-p", parent);

  return (await index.git(args, { env: IDENTITY })).trim();
}

// Moves master from parent (null if there is none) to commit, only if it is
// still at parent. Rejects with code EMOVED if it is not.
async function moveMaster(directory, commit, parent) {
  const args = ["update-ref", MASTER, commit, parent || ZERO];
  const result = await run(directory, args);

  if (!result.code) return;

  const err = failure(args, result);

  if ((await head(directory)) !== parent) err.code = "EMOVED";

  throw err;
}

// The path of a file in the repository from the path Blot knows it by, which is
// the same file in the blog folder (pathNormalizer is what localPath applies).
// No empty component, "." or "..", no ".git" in any case and no NUL: Blot does
// not commit a path which materialize.js would then refuse to write.
function treePath(file) {
  const parts = pathNormalizer(file).slice(1).split("/");

  for (const part of parts) {
    if (
      !part ||
      part === "." ||
      part === ".." ||
      part.toLowerCase() === ".git" ||
      part.indexOf("\0") !== -1
    )
      throw new Error("Cannot commit a file at this path: " + JSON.stringify(file));
  }

  return parts.join("/");
}

// Lines of `ls-files --stage -z`: <mode> SP <id> SP <stage> TAB <path> NUL
function parseStage(output) {
  return output
    .split("\0")
    .filter(Boolean)
    .map(function (line) {
      const tab = line.indexOf("\t");
      const meta = line.slice(0, tab).split(" ");

      return { mode: meta[0], oid: meta[1], path: line.slice(tab + 1) };
    });
}

function toBuffer(contents) {
  if (Buffer.isBuffer(contents)) return contents;
  if (typeof contents === "string") return Buffer.from(contents, "utf8");
  if (ArrayBuffer.isView(contents))
    return Buffer.from(contents.buffer, contents.byteOffset, contents.byteLength);

  throw new Error("Cannot commit contents of this type");
}

// Changes master's tree in a temporary index so that file holds the blob, or
// so that it, or the files under it, are gone if oid is null. Resolves with the
// new tree, or null if nothing is there to change (a removal of a file which
// isn't in the tree).
async function changeTree(index, parent, file, oid) {
  if (parent) await index.git(["read-tree", parent]);

  // The file, and what a directory of that name holds
  const staged = parseStage(
    await index.git(["ls-files", "--stage", "-z", "--", file, file + "/"])
  );
  let lines;

  if (oid === null) {
    lines = staged.map(function (entry) {
      return "0 " + ZERO + "\t" + entry.path + "\0";
    });
  } else {
    // A file which is executable stays so
    const existing = staged.filter(function (entry) {
      return entry.path === file;
    })[0];
    const mode = existing && existing.mode === "100755" ? "100755" : "100644";

    lines = [mode + " " + oid + "\t" + file + "\0"];
  }

  if (!lines.length) return null;

  // --replace so a file can take the place of a directory, as it does in the
  // blog folder
  await index.git(["update-index", "-z", "--add", "--replace", "--index-info"], {
    input: lines.join(""),
  });

  return (await index.git(["write-tree"])).trim();
}

// Commits one change to master of the bare repository:
//
//   commitFile(directory, { path: "/a.txt", contents: "A" })
//
// contents is a string or buffer, or null to remove the file (or the files
// under a directory of that name). The commit is made on the master it finds,
// and master moves from it to the commit only if it is still there: if it moved
// meanwhile (a push the lock did not hold off) the change is made again on the
// new master, and a few failures in a row reject with code EMOVED. Nothing is
// lost either way: the other change is never replaced.
//
// Resolves with { parent, commit }: master before and after. commit is null if
// the change leaves the tree as it was (the same contents again, or a removal of
// a file which isn't there), and then master is not moved.
async function commitFile(directory, change) {
  const file = treePath(change.path);
  const removing = change.contents === null;
  const message = (removing ? "Removed " : "Updated ") + file;
  let oid = null;

  if (!removing) {
    const args = ["hash-object", "-w", "--no-filters", "--stdin"];
    const hashed = await run(directory, args, { input: toBuffer(change.contents) });

    if (hashed.code) throw failure(args, hashed);

    oid = hashed.stdout.toString().trim();
  }

  for (let attempt = 1; ; attempt++) {
    const parent = await head(directory);
    const index = await openIndex(directory);
    let commit = null;

    try {
      const tree = await changeTree(index, parent, file, oid);
      const before = parent
        ? (await index.git(["rev-parse", parent + "^{tree}"])).trim()
        : null;

      if (tree && tree !== before)
        commit = await commitTree(index, tree, parent, message);
    } finally {
      await index.close();
    }

    if (!commit) return { parent: parent, commit: null };

    try {
      await moveMaster(directory, commit, parent);
    } catch (err) {
      if (err.code === "EMOVED" && attempt < ATTEMPTS) continue;
      throw err;
    }

    return { parent: parent, commit: commit };
  }
}

// What a push does when it is done, in receivePack.js: a commit leaves loose
// objects, and a big upload is a commit per file, so without this a repository
// only Blot writes to would never be packed. Nothing waits on it, and a burst
// of commits makes one gc (gc.js).
function collect(directory) {
  gc.schedule(directory);
}

module.exports = {
  ZERO: ZERO,
  MASTER: MASTER,
  head: head,
  openIndex: openIndex,
  commitTree: commitTree,
  moveMaster: moveMaster,
  commitFile: commitFile,
  collect: collect,
  treePath: treePath,
};
