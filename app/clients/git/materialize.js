// Brings a blog folder from one commit to another by reading the bare
// repository: `diff-tree` says which paths changed and `cat-file --batch`
// streams the new contents of the files that did. The folder has no checkout
// to maintain, only the files at the changed paths are touched.
//
// Files are written as the raw committed bytes (their mode is 0644 or 0755),
// so .gitattributes rules such as eol and ident do not apply. Directories that
// a removal leaves empty are removed too, as `git reset --hard` would, but
// empty directories nothing here emptied are left alone.
//
// Paths come from history which may predate the checks a push goes through now,
// so a path is only used if it is safe: no empty, "." or ".." component, and
// no ".git" component, so nothing is written outside the folder and the
// folder's own .git directory is never touched. A symbolic link or file in the
// way of a path is replaced, never followed.
const { spawn } = require("child_process");
const fs = require("fs-extra");
const path = require("path");

// What git calls the tree with nothing in it. It is known to every repository,
// so it can be the commit to compare from when nothing has been applied yet.
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

const MODES = { "100644": 0o644, "100755": 0o755 };

// A line of `cat-file --batch` output (an object ID, its type and size) is
// about 60 bytes, so this much without a newline is not one
const MAX_HEADER_BYTES = 256;

const STDERR_BYTES = 4096;

function run(directory, args) {
  return new Promise(function (resolve, reject) {
    const child = spawn("git", args, {
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

async function lstat(file) {
  try {
    return await fs.lstat(file);
  } catch (err) {
    if (err.code === "ENOENT" || err.code === "ENOTDIR") return null;
    throw err;
  }
}

// The folder's directory for the first parts of a path, with each directory
// made if it is missing. Something else in its place (a file, or a symbolic
// link, which is not followed) is removed to make room.
async function ensureDirectory(root, parts) {
  let current = root;

  for (const part of parts) {
    current = path.join(current, part);

    const stat = await lstat(current);

    if (stat && stat.isDirectory()) continue;
    if (stat) await fs.remove(current);

    await fs.mkdir(current);
  }

  return current;
}

// Removes a file, then the directories that this leaves empty. A directory in
// its place, or a symbolic link on the way to it, is not something to remove.
async function removeFile(root, parts) {
  let directory = root;

  for (const part of parts.slice(0, -1)) {
    directory = path.join(directory, part);

    const stat = await lstat(directory);

    if (!stat || !stat.isDirectory()) return;
  }

  const file = path.join(directory, parts[parts.length - 1]);
  const stat = await lstat(file);

  if (!stat || stat.isDirectory()) return;

  await fs.unlink(file);

  for (let i = parts.length - 1; i > 0; i--) {
    try {
      await fs.rmdir(path.join(root, ...parts.slice(0, i)));
    } catch (err) {
      // Not empty, so it and the directories above it stay
      if (err.code === "ENOTEMPTY" || err.code === "EEXIST" || err.code === "ENOENT") return;
      throw err;
    }
  }
}

// Opens the file a blob is written to, in place of whatever is there now. A new
// file is opened exclusively so a symbolic link cannot be written through.
async function openFile(root, parts, mode) {
  const directory = await ensureDirectory(root, parts.slice(0, -1));
  const file = path.join(directory, parts[parts.length - 1]);

  if (await lstat(file)) await fs.remove(file);

  return fs.promises.open(file, "wx", mode);
}

async function writeAll(handle, buffer) {
  let offset = 0;

  while (offset < buffer.length) {
    const result = await handle.write(buffer, offset, buffer.length - offset);
    offset += result.bytesWritten;
  }
}

// Writes the blobs, one after another and in the order given, to the files
// open(i) gives. A blob is passed on a chunk at a time, waiting for each
// chunk to be written before taking the next, so a large blob is never held
// in memory. Each blob in the output is
//
//   <id> blob <size> NL <contents> NL
//
// or "<id> missing" NL if the repository does not have it.
async function writeBlobs(directory, oids, open) {
  const child = spawn("git", ["cat-file", "--batch"], {
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

          if (part.length) await writeAll(handle, part);

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
    if (handle) await handle.close().catch(function () {});
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
// order git lists them. folder is { path, log } as given by the sync lock.
async function materialize(directory, folder, from, to) {
  const root = folder.path;
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
      writes.push({ parts: parts, mode: MODES[change.newMode], oid: change.oid });
    } else if (change.oldMode in MODES) {
      // Gone, or something we do not write (a link or submodule) in its place
      removals.push(parts);
    } else {
      continue;
    }

    paths.push(change.path);
  }

  // Removals first: a file may become a directory of the same name, or the
  // reverse, and names may differ only by case
  for (const parts of removals) await removeFile(root, parts);

  if (writes.length)
    await writeBlobs(
      directory,
      writes.map((write) => write.oid),
      (i) => openFile(root, writes[i].parts, writes[i].mode)
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
