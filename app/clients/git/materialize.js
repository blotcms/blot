// Brings a blog folder from one commit to another by reading the bare
// repository: `diff-tree` says which paths changed and `cat-file --batch`
// streams the new contents of the files that did. The folder has no checkout
// to maintain, only the files at the changed paths are touched.
//
// Files are written as the raw committed bytes, so .gitattributes rules such
// as eol and ident do not apply, and without the committed mode: the blog
// folder has no executable bit (storage/folder). Directories that a removal
// leaves empty are removed too, as `git reset --hard` would, but empty
// directories nothing here emptied are left alone.
//
// Every read and write of the folder goes through storage/folder, which names
// a file by its path in NFC. A name committed in another form (NFD, say) is
// therefore written under its NFC name, and a later change or removal of the
// same name in git acts on that same file. The paths materialize resolves
// with are in NFC too, as Blot knows them.
//
// Paths come from history which may predate the checks a push goes through now,
// so a path is only used if it is safe: no empty, "." or ".." component, and
// no ".git" component, so nothing is written outside the folder and the
// folder's own .git directory is never touched. A symbolic link or file in the
// way of a path is replaced, never followed.
const { spawn } = require("child_process");
const { PassThrough } = require("stream");
const storage = require("storage/folder");
const limiter = require("./limiter");

// What git calls the tree with nothing in it. It is known to every repository,
// so it can be the commit to compare from when nothing has been applied yet.
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

// The modes of the files written, a regular file and an executable one
const MODES = { "100644": true, "100755": true };

const SYMLINK = "120000";

// A line of `cat-file --batch` output (an object ID, its type and size) is
// about 60 bytes, so this much without a newline is not one
const MAX_HEADER_BYTES = 256;

const STDERR_BYTES = 4096;

// A sync is background work (see limiter.js)
function run(directory, args) {
  return limiter.run("background", function () {
    return spawnGit(directory, args);
  });
}

function spawnGit(directory, args) {
  return new Promise(function (resolve, reject) {
    const child = spawn("git", limiter.args(args), {
      cwd: directory,
      env: Object.assign({}, process.env, { GIT_DIR: directory }),
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout = [];
    let stderr = "";

    child.stdout.on("data", function (chunk) {
      stdout.push(chunk);
    });
    child.stderr.on("data", function (chunk) {
      if (stderr.length < STDERR_BYTES) stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", function (code) {
      if (code) return reject(new Error("git " + args[0] + " failed: " + stderr.trim()));
      resolve(Buffer.concat(stdout));
    });
  });
}

// The paths that differ between two commits (or trees). The output is split
// on NUL bytes, so a name may hold anything but a NUL or a "/".
//
//   :100644 100755 <old id> <new id> M NUL path NUL
async function changes(directory, from, to) {
  const output = await run(directory, [
    "diff-tree", "-r", "-z", "--raw", "--no-renames", "--no-abbrev", from, to,
  ]);
  const fields = [];
  let start = 0;

  for (let end = output.indexOf(0); end !== -1; end = output.indexOf(0, start)) {
    fields.push(output.subarray(start, end));
    start = end + 1;
  }

  const found = [];

  for (let i = 0; i + 1 < fields.length; i += 2) {
    const meta = fields[i].toString().slice(1).split(" ");
    const name = fields[i + 1];
    const text = name.toString("utf8");

    found.push({
      oldMode: meta[0],
      newMode: meta[1],
      oid: meta[3],
      path: text,
      // A name which is not UTF-8 cannot be told to the rest of Blot
      valid: Buffer.from(text, "utf8").equals(name),
    });
  }

  return found;
}

function safeParts(file) {
  const parts = file.split("/");

  for (const part of parts) {
    if (!part || part === "." || part === "..") return null;
    if (part.toLowerCase() === ".git") return null;
  }

  return parts;
}

function noop() {}

// A blog-folder path from the parts of a path in the repository
function join(parts) {
  return "/" + parts.join("/");
}

// What is at a path: "directory", "file", "link" or null if nothing is. A
// link is reported as such only when the directories above the path are
// real ones, which the callers here have checked.
async function kind(blogID, file) {
  try {
    return (await storage.stat(blogID, file)).isDirectory ? "directory" : "file";
  } catch (err) {
    if (err.code === "ENOENT") return null;
    if (err.code === "ELOOP") return "link";
    throw err;
  }
}

// Makes the directory for the first parts of a path, with each directory made
// if it is missing. Something else in its place (a file, or a symbolic link,
// which is not followed) is removed to make room.
async function ensureDirectory(blogID, parts) {
  for (let i = 1; i <= parts.length; i++) {
    const directory = join(parts.slice(0, i));
    const found = await kind(blogID, directory);

    if (found === "directory") continue;
    if (found) await storage.remove(blogID, directory);

    await storage.mkdir(blogID, directory);
  }
}

// Removes a file, then the directories that this leaves empty. A directory in
// its place, or a symbolic link on the way to it, is not something to remove.
async function removeFile(blogID, parts) {
  if (parts.length > 1 && (await kind(blogID, join(parts.slice(0, -1)))) !== "directory") return;

  const found = await kind(blogID, join(parts));

  if (!found || found === "directory") return;

  await storage.remove(blogID, join(parts));

  for (let i = parts.length - 1; i > 0; i--) {
    const directory = join(parts.slice(0, i));
    let entries;

    try {
      entries = await storage.listNames(blogID, directory);
    } catch (err) {
      if (err.code === "ENOENT") return;
      throw err;
    }

    // Not empty, so it and the directories above it stay
    if (entries.length) return;

    await storage.rmdir(blogID, directory);
  }
}

// Resolves once the stream can take more, or has closed
function drained(stream) {
  return new Promise(function (resolve) {
    function done() {
      stream.off("drain", done);
      stream.off("close", done);
      resolve();
    }

    stream.on("drain", done);
    stream.on("close", done);
  });
}

// Starts writing the file a blob goes to, in place of whatever is there now
// (a symbolic link is removed, never written through). The blob is passed in
// a chunk at a time with write, which waits until the chunk can be taken, so
// a large blob is never held in memory. close resolves once the file is
// written; abort gives up on it.
async function openFile(blogID, parts) {
  await ensureDirectory(blogID, parts.slice(0, -1));

  const file = join(parts);

  if (await kind(blogID, file)) await storage.remove(blogID, file);

  const stream = new PassThrough();
  const written = storage.write(blogID, file, stream);

  // Awaited by write, close or abort; this keeps an early failure handled
  written.catch(noop);

  async function stopped() {
    await written;
    throw new Error("The write of " + file + " stopped");
  }

  return {
    write: async function (buffer) {
      if (!stream.write(buffer)) {
        await Promise.race([drained(stream), written]);
      }

      if (stream.destroyed) await stopped();
    },
    close: async function () {
      stream.end();
      await written;
    },
    abort: async function () {
      stream.destroy();
      await written.catch(noop);
    },
  };
}

// Writes the blobs, one after another and in the order given, to the files
// open(i) gives. A blob is passed on a chunk at a time, waiting for each
// chunk to be written before taking the next, so a large blob is never held
// in memory. Each blob in the output is
//
//   <id> blob <size> NL <contents> NL
//
// or "<id> missing" NL if the repository does not have it.
//
// cat-file holds its place in the background lane until it has closed.
function writeBlobs(directory, oids, open) {
  return limiter.run("background", function () {
    return streamBlobs(directory, oids, open);
  });
}

async function streamBlobs(directory, oids, open) {
  const child = spawn("git", limiter.args(["cat-file", "--batch"]), {
    cwd: directory,
    env: Object.assign({}, process.env, { GIT_DIR: directory }),
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stderr = "";
  let spawnError = null;
  const closed = new Promise(function (resolve) {
    child.on("error", function (err) {
      spawnError = err;
      resolve(1);
    });
    child.on("close", resolve);
  });

  child.stderr.on("data", function (chunk) {
    if (stderr.length < STDERR_BYTES) stderr += chunk;
  });
  child.stdin.on("error", function () {});
  child.stdin.end(oids.map((oid) => oid + "\n").join(""));

  let state = "header";
  let header = Buffer.alloc(0);
  let handle = null;
  let remaining = 0;
  let index = 0;

  try {
    for await (let chunk of child.stdout) {
      while (chunk.length) {
        if (state === "header") {
          const end = chunk.indexOf(10);

          header = Buffer.concat([header, end === -1 ? chunk : chunk.subarray(0, end)]);

          if (header.length > MAX_HEADER_BYTES) throw new Error("Unexpected output from git cat-file");
          if (end === -1) break;

          chunk = chunk.subarray(end + 1);

          const [oid, type, size] = header.toString().split(" ");

          header = Buffer.alloc(0);

          if (type !== "blob") throw new Error("Cannot read " + oid + " as a blob: " + type);

          remaining = Number(size);
          handle = await open(index);
          state = "body";
        }

        if (state === "body") {
          const part = chunk.subarray(0, remaining);

          if (part.length) await handle.write(part);

          remaining -= part.length;
          chunk = chunk.subarray(part.length);

          if (remaining) break;

          await handle.close();
          handle = null;
          state = "end";
        }

        if (state === "end" && chunk.length) {
          chunk = chunk.subarray(1);
          index++;
          state = "header";
        }
      }
    }
  } catch (err) {
    child.kill("SIGKILL");
    if (handle) await handle.abort();
    // Counted until it has gone
    await closed;
    throw err;
  }

  const code = await closed;

  if (spawnError) throw spawnError;
  if (code) throw new Error("git cat-file failed: " + stderr.trim());

  if (index !== oids.length || handle || header.length || state !== "header")
    throw new Error("git cat-file stopped after " + index + " of " + oids.length + " blobs");
}

// Applies the changes from one commit to the other to the folder, and
// resolves with the paths which changed (without a leading slash), in the
// order git lists them. folder is { blogID, log }, log as given by the sync
// lock.
async function materialize(directory, folder, from, to) {
  const blogID = folder.blogID;
  const removals = [];
  const writes = [];
  const paths = [];

  for (const change of await changes(directory, from, to)) {
    const parts = change.valid ? safeParts(change.path) : null;

    if (!parts) {
      folder.log("Skipping a path that is not safe to write: " + JSON.stringify(change.path));
      continue;
    }

    if (change.newMode in MODES) {
      writes.push({ parts: parts, oid: change.oid });
    } else if (change.oldMode in MODES || change.oldMode === SYMLINK) {
      // Gone, or something we do not write (a link or submodule) in its place.
      // A link can only be here from before pushes refused them.
      removals.push(parts);
    } else {
      continue;
    }

    paths.push(change.path.normalize("NFC"));
  }

  // Removals first: a file may become a directory of the same name, or the
  // reverse, and names may differ only by case
  for (const parts of removals) await removeFile(blogID, parts);

  if (writes.length)
    await writeBlobs(
      directory,
      writes.map((write) => write.oid),
      (i) => openFile(blogID, writes[i].parts)
    );

  return paths;
}

module.exports = function (directory, folder, from, to, callback) {
  materialize(directory, folder, from, to).then(
    function (paths) {
      process.nextTick(callback, null, paths);
    },
    function (err) {
      process.nextTick(callback, err);
    }
  );
};

module.exports.EMPTY_TREE = EMPTY_TREE;
