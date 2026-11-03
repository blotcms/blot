// New-folder setup for a blog served from the git store (#2259): create.js's
// path when a blog connects to git while it is switched (BLOT_GIT_STORE_SERVE
// is "all", or names it). The blog folder becomes the first commit of a new
// repository in the store, and the EBS bare repository is made from the same
// commit, for the rollback.
//
// The folder may have no copy on local disk (#2258: S3 as a blog's primary
// store), so it is never git's work tree and is never brought to disk whole.
// It is read through storage/folder alone:
//
//   1. walk() lists the files; shouldIgnoreFile drops what Blot ignores, as
//      today.
//   2. The folder's .gitignore files (small) are copied into a scratch
//      directory at their paths, and `git check-ignore --no-index --stdin`
//      there says which of the files git would refuse to add, as `git add`
//      did with the folder as the work tree.
//   3. One `git fast-import` into a scratch bare repository makes one commit
//      of the rest, each file streamed from storage/folder in turn
//      (createReadStream) with its size from stat(), so memory does not
//      depend on the size of a file (fast-import streams a blob over
//      core.bigFileThreshold, which the git limiter sets) or of the folder.
//   4. importRepo puts it in the store, with pack.window 0 (measured 3 Nov
//      2026: 1.4 to 2.3 times faster on large folders, about 9 times on
//      folders of many files).
//   5. The EBS bare repository (which create.js has made the directory of)
//      is made with `git init --bare` and a fetch of master from the scratch
//      repository.
//
// Scratch is a directory of its own (setup-XXXXXX) in the store's scratch
// directory, on the instance store in production, outside the cache's
// budget, as a backfill's import is: a folder can be larger than the cache.
// store/leftovers.js clears what a killed setup leaves.
//
// Resolves with the commit. On failure the store's copy is removed if this
// made it (not one that was already there, which importRepo refuses), and
// the EBS repository is left for create.js to remove.
const fs = require("fs-extra");
const path = require("path");
// Called through the module, so a spec can make one command fail
const childProcess = require("child_process");
const config = require("config");
const storage = require("storage/folder");
const shouldIgnoreFile = require("clients/util/shouldIgnoreFile");
const limiter = require("../limiter");
const importRepo = require("../store/import");
const removeRepo = require("../store/remove");
const context = require("./context");
const log = require("./log");

const IDENTITY = { name: "Your Name", email: "you@example.com" };
const STDERR_BYTES = 4096;
const GIT_TIMEOUT_MS = 6 * 60 * 60 * 1000;

function scratchDirectory() {
  return path.dirname(config.git_store.cache_directory);
}

// Runs git once there is a place in the background lane. options: cwd, env,
// input, feed (a function given stdin, returning a promise of the writing,
// handled at once), ok (exit codes which are not failures).
function git(args, options = {}) {
  return limiter.run("background", () => new Promise((resolve, reject) => {
    const child = childProcess.spawn("git", limiter.args(args), {
      cwd: options.cwd,
      env: Object.assign({}, process.env, { GIT_TERMINAL_PROMPT: "0" }, options.env),
      stdio: ["pipe", "pipe", "pipe"],
      timeout: GIT_TIMEOUT_MS,
      killSignal: "SIGKILL",
    });
    const stdout = [];
    let stderr = "";
    let fed = Promise.resolve(null);

    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => {
      if (stderr.length < STDERR_BYTES) stderr += chunk;
    });
    child.stdin.on("error", () => {});
    child.on("error", reject);
    child.on("close", (code, signal) => {
      fed.then((fedError) => {
        const ok = options.ok || [0];
        if (fedError) return reject(fedError);
        if (signal || ok.indexOf(code) === -1) return reject(new Error("git " + args[0] + " failed: " + stderr.trim()));
        resolve(Buffer.concat(stdout));
      });
    });

    if (options.feed) {
      fed = new Promise((settle) => settle(options.feed(child.stdin))).then(
        () => null,
        (err) => {
          child.kill("SIGKILL");
          return err || new Error("feeding git failed");
        }
      );
    } else {
      child.stdin.end(options.input);
    }
  }));
}

// Writes to a stream, waiting while it is full
function write(stream, chunk) {
  if (stream.destroyed) return Promise.reject(new Error("git stopped reading"));
  if (stream.write(chunk)) return Promise.resolve();
  return new Promise((resolve, reject) => {
    function done() {
      stream.off("drain", done);
      stream.off("close", closed);
      resolve();
    }
    function closed() {
      stream.off("drain", done);
      reject(new Error("git stopped reading"));
    }
    stream.once("drain", done);
    stream.once("close", closed);
  });
}

// A path as fast-import reads it: C-style quoted, which any path may be
function quote(file) {
  let out = '"';
  for (const byte of Buffer.from(file, "utf8")) {
    if (byte === 0x22) out += '\\"';
    else if (byte === 0x5c) out += "\\\\";
    else if (byte === 0x0a) out += "\\n";
    else if (byte < 0x20 || byte === 0x7f) out += "\\" + byte.toString(8).padStart(3, "0");
    else out += String.fromCharCode(byte);
  }
  // The non-ASCII bytes above were kept as latin1 characters: back to bytes
  return Buffer.from(out + '"', "latin1");
}

// The files of the folder to add, as relative paths ("a/b.txt")
async function candidates(blogID) {
  const files = [];
  for await (const file of storage.walk(blogID, "/")) {
    if (!shouldIgnoreFile(file)) files.push(file.slice(1));
  }
  return files;
}

// Which of the files the folder's .gitignore files exclude, as git add would
async function gitIgnored(blogID, files, dir) {
  const rules = files.filter((file) => path.posix.basename(file) === ".gitignore");
  if (!rules.length) return new Set();

  const workTree = path.join(dir, "ignore");
  for (const file of rules) await fs.outputFile(path.join(workTree, file), await storage.read(blogID, "/" + file));

  const output = await git(["--git-dir=" + path.join(dir, "repo.git"), "--work-tree=" + workTree, "check-ignore", "--no-index", "--stdin", "-z"], {
    cwd: workTree,
    input: files.map((file) => file + "\0").join(""),
    // 1: nothing is ignored
    ok: [0, 1],
  });

  return new Set(output.toString("utf8").split("\0").filter(Boolean));
}

// One commit of the files, streamed into fast-import
async function fastImport(blogID, files, gitDir, folder) {
  const seconds = Math.floor(Date.now() / 1000);
  const message = files.length ? "Add files" : "Initial commit";
  let added = 0;

  await git(["fast-import", "--quiet", "--done"], {
    env: { GIT_DIR: gitDir },
    feed: async (stdin) => {
      await write(stdin, "commit refs/heads/master\ncommitter " + IDENTITY.name + " <" + IDENTITY.email + "> " + seconds + " +0000\ndata " + Buffer.byteLength(message) + "\n" + message + "\n");

      for (const file of files) {
        const { size } = await storage.stat(blogID, "/" + file);
        const body = storage.createReadStream(blogID, "/" + file);
        let sent = 0;

        await write(stdin, Buffer.concat([Buffer.from("M 100644 inline "), quote(file), Buffer.from("\ndata " + size + "\n")]));

        for await (const chunk of body) {
          sent += chunk.length;
          if (sent > size) break;
          await write(stdin, chunk);
        }

        body.destroy();
        if (sent !== size) throw new Error("A file changed while the folder was being read: " + file);

        await write(stdin, "\n");

        if (++added % 100 === 0) folder.status("Adding files (" + added + "/" + files.length + ")");
      }

      await write(stdin, "done\n");
      stdin.end();
    },
  });

  return (await git(["rev-parse", "--verify", "refs/heads/master^{commit}"], { env: { GIT_DIR: gitDir } })).toString().trim();
}

// folder is the sync lock's ({ status, log }); ebsDirectory the empty
// directory create.js made for the bare repository
async function create(blog, folder, ebsDirectory) {
  const started = Date.now();
  const blogID = blog.id;
  const store = context.storeFor(blogID);
  const cache = context.cache();
  const base = scratchDirectory();

  await fs.mkdirp(base);
  const dir = await fs.mkdtemp(path.join(base, "setup-"));
  const gitDir = path.join(dir, "repo.git");
  let imported = false;

  try {
    await git(["init", "-q", "--bare", "--initial-branch=master", gitDir]);

    folder.status("Reading your folder");
    const found = await candidates(blogID);
    const ignored = await gitIgnored(blogID, found, dir);
    const files = found.filter((file) => !ignored.has(file));

    folder.status("Adding " + files.length + " files");
    const commit = await fastImport(blogID, files, gitDir, folder);

    folder.status("Saving your repository");
    await importRepo({ store, cache, lock: context.refLock(blogID), gitDir, scratchDir: base, pack: { "pack.window": "0" }, gate: limiter.gate("background") });
    imported = true;

    await git(["init", "-q", "--bare", "--initial-branch=master", ebsDirectory]);
    await git(["fetch", "-q", "--no-tags", gitDir, "refs/heads/master:refs/heads/master"], { env: { GIT_DIR: ebsDirectory } });

    log({ blog: blogID, op: "create", outcome: "ok", ms: Date.now() - started, files: files.length, ignored: ignored.size });
    return commit;
  } catch (err) {
    log({ blog: blogID, op: "create", outcome: "error", ms: Date.now() - started, detail: (err && (err.code || err.message)) || "error" });

    if (imported) await removeRepo({ store: context.objectStoreFor(blogID) }).catch(() => {});
    throw err;
  } finally {
    await fs.remove(dir).catch(() => {});
  }
}

module.exports = create;
module.exports._quote = quote;
