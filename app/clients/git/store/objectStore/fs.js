// The object store interface (see memory.js) over a local directory, for
// trying the store out by hand (scripts/git/import-repo.js into a folder) and
// for specs. Not meant for production use: it does not fsync, and it is only
// as atomic as the filesystem's rename and hard link, which is enough for the
// one conditional write the store needs.
//
// A key is a path under `root`. An object is written to a temporary file under
// `root/.tmp` and renamed into place, so a reader never sees half of one and a
// stream which fails leaves nothing. putIfAbsent links the finished temporary
// file to the key, which fails if the key exists. lastModified is the file's
// modification time.
const crypto = require("crypto");
const fsp = require("fs/promises");
const path = require("path");
const { Readable } = require("stream");
const { NotFoundError, TooLargeError } = require("../errors");

const CHUNK = 1024 * 1024;
const TMP = ".tmp";

// FileHandle.write may write less than it was given; this writes it all
async function writeAll(handle, buffer) {
  let at = 0;
  while (at < buffer.length) {
    const { bytesWritten } = await handle.write(buffer, at, buffer.length - at);
    if (!bytesWritten) throw new Error("A write made no progress");
    at += bytesWritten;
  }
  return buffer.length;
}

function createFsStore({ root }) {
  if (!root) throw new Error("createFsStore needs a root directory");
  root = path.resolve(root);
  const id = "fs:" + root;

  function file(key) {
    const target = path.resolve(root, key);
    if (!target.startsWith(root + path.sep) || key.split("/").includes(TMP)) throw new Error("Invalid key: " + key);
    return target;
  }

  async function open(key) {
    try {
      return await fsp.open(file(key), "r");
    } catch (err) {
      if (err.code === "ENOENT" || err.code === "ENOTDIR") throw new NotFoundError("No such key: " + key);
      throw err;
    }
  }

  async function head(key) {
    try {
      const stat = await fsp.stat(file(key));
      return stat.isFile() ? { size: stat.size, lastModified: Math.floor(stat.mtimeMs) } : null;
    } catch (err) {
      if (err.code === "ENOENT" || err.code === "ENOTDIR") return null;
      throw err;
    }
  }

  async function read(key, offset, length) {
    const handle = await open(key);
    try {
      const { size } = await handle.stat();
      const wanted = Math.max(0, Math.min(length, size - offset));
      const buffer = Buffer.alloc(wanted);
      const { bytesRead } = await handle.read(buffer, 0, wanted, offset);
      return buffer.subarray(0, bytesRead);
    } finally {
      await handle.close();
    }
  }

  async function get(key, { maxBytes = Infinity } = {}) {
    const handle = await open(key);
    try {
      const { size } = await handle.stat();
      if (size > maxBytes) throw new TooLargeError(key + " is larger than " + maxBytes);
      return await handle.readFile();
    } finally {
      await handle.close();
    }
  }

  function stream(key, offset = 0, length = Infinity) {
    async function* chunks() {
      const handle = await open(key);
      try {
        const { size } = await handle.stat();
        let at = offset;
        const end = Math.min(size, length === Infinity ? size : offset + length);
        while (at < end) {
          const buffer = Buffer.alloc(Math.min(CHUNK, end - at));
          const { bytesRead } = await handle.read(buffer, 0, buffer.length, at);
          if (!bytesRead) break;
          yield buffer.subarray(0, bytesRead);
          at += bytesRead;
        }
      } finally {
        await handle.close();
      }
    }
    return Readable.from(chunks(), { objectMode: false });
  }

  // Writes `body` to a new temporary file and resolves with its path
  async function stage(body) {
    await fsp.mkdir(path.join(root, TMP), { recursive: true });
    const tmp = path.join(root, TMP, crypto.randomBytes(8).toString("hex"));
    const handle = await fsp.open(tmp, "wx");
    let written = 0;
    try {
      for await (const chunk of Buffer.isBuffer(body) ? [body] : body) written += await writeAll(handle, Buffer.from(chunk));
      await handle.close();
      // Nothing is published that is not all on disk
      const { size } = await fsp.stat(tmp);
      if (size !== written) throw new Error("Wrote " + size + " of " + written + " bytes to " + tmp);
    } catch (err) {
      await handle.close().catch(() => {});
      await fsp.rm(tmp, { force: true });
      throw err;
    }
    return tmp;
  }

  async function put(key, body) {
    const target = file(key);
    const tmp = await stage(body);
    try {
      await fsp.mkdir(path.dirname(target), { recursive: true });
      await fsp.rename(tmp, target);
    } catch (err) {
      await fsp.rm(tmp, { force: true });
      throw err;
    }
  }

  async function putIfAbsent(key, buffer) {
    const target = file(key);
    const tmp = await stage(buffer);
    try {
      await fsp.mkdir(path.dirname(target), { recursive: true });
      await fsp.link(tmp, target);
      return true;
    } catch (err) {
      if (err.code === "EEXIST") return false;
      throw err;
    } finally {
      await fsp.rm(tmp, { force: true });
    }
  }

  async function remove(key) {
    await fsp.rm(file(key), { force: true });
  }

  async function* walk(dir, relative) {
    let names;
    try {
      names = await fsp.readdir(dir, { withFileTypes: true });
    } catch (err) {
      if (err.code === "ENOENT") return;
      throw err;
    }
    for (const entry of names.sort((a, b) => (a.name < b.name ? -1 : 1))) {
      if (relative === "" && entry.name === TMP) continue;
      const key = relative + entry.name;
      if (entry.isDirectory()) yield* walk(path.join(dir, entry.name), key + "/");
      else if (entry.isFile()) {
        const stat = await fsp.stat(path.join(dir, entry.name));
        yield { key, size: stat.size, lastModified: Math.floor(stat.mtimeMs) };
      }
    }
  }

  async function* list(prefix = "") {
    for await (const item of walk(root, "")) if (item.key.startsWith(prefix)) yield item;
  }

  return { id, head, read, get, stream, put, putIfAbsent, delete: remove, list };
}

module.exports = createFsStore;
