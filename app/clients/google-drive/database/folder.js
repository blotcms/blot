const client = require("models/client");

const PREFIX = require("./prefix");
const refuseAfterAbort = require("./refuseAfterAbort");

function folder(folderId, blogID) {
  if (!(this instanceof folder)) {
    return new folder(folderId, blogID);
  }

  // "undefined" and "null" too: a folder ID that reached here as that text
  // once left blot:google-drive:undefined:* and null:* mappings, which no
  // account reads
  if (!folderId || folderId === "undefined" || folderId === "null") {
    throw new Error("Folder ID is required");
  }

  // Redis keys
  this.key = `${PREFIX}${folderId}:folder`; // ID ↔ Path mapping
  this.reverseKey = `${PREFIX}${folderId}:path`; // Path ↔ ID mapping
  // Per file ID, the Drive modifiedTime of the version last written to the
  // blog folder plus the SHA-1 of what was written. Only written after a
  // successful download, and kept across mapping resets, so change detection
  // never depends on the file's mtime. Files with an md5Checksum are matched
  // by content instead (util/hashes.js).
  this.appliedKey = `${PREFIX}${folderId}:applied-modified-time${blogID ? ":" + blogID : ""}`;

  const parseApplied = (value) => {
    try {
      const record = value && JSON.parse(value);
      return record && typeof record.modifiedTime === "string" ? record : null;
    } catch (_) {
      return null;
    }
  };

  this.getApplied = async (id) =>
    parseApplied(await client.hGet(this.appliedKey, id));
  this.getAllApplied = async () => {
    const all = (await client.hGetAll(this.appliedKey)) || {};
    return new Map(
      Object.entries(all).map(([id, value]) => [id, parseApplied(value)])
    );
  };
  // { modifiedTime, sha1 }: Drive's modifiedTime of the version Blot wrote,
  // and the SHA-1 of the file it wrote (util/localState.js). The SHA-1 may be
  // missing if the file couldn't be read, in which case the record is never
  // trusted.
  this.setApplied = async (id, { modifiedTime, sha1 }) => {
    if (!modifiedTime) return;
    const record = { modifiedTime };
    if (sha1) record.sha1 = sha1;
    await client.hSet(this.appliedKey, id, JSON.stringify(record));
  };

  // Only manual mapping resets need this cleanup. Scan in batches so applied
  // records of IDs removed while mappings were absent do not accumulate.
  this.pruneApplied = async () => {
    let cursor = "0";
    do {
      const page = await client.hScan(this.appliedKey, cursor, { COUNT: 256 });
      cursor = page.cursor;
      const ids = page.entries.map((entry) => entry.field);
      if (!ids.length) continue;
      const paths = await client.hmGet(this.key, ids);
      const removed = ids.filter((id, i) => !paths[i]);
      if (removed.length) await client.hDel(this.appliedKey, removed);
    } while (cursor !== "0");
  };

  // Set a mapping (ID → Path)
  this.set = async (id, path) => {
    if (!id || !path || typeof id !== "string" || typeof path !== "string") {
      throw new Error("ID and path must be non-empty strings");
    }

    const multi = client.multi(); // Start a Redis transaction

    const previousPath = await client.hGet(this.key, id);
    if (previousPath && previousPath !== path) {
      // Remove the old reverse mapping for the previous path
      multi.hDel(this.reverseKey, previousPath);
    }

    const previousId = await client.hGet(this.reverseKey, path);
    if (previousId && previousId !== id) {
      // Remove the old mapping for the previous ID
      multi.hDel(this.key, previousId);
      multi.hDel(this.appliedKey, previousId);
    }

    // Add the new ID ↔ Path mapping
    multi.hSet(this.key, id, path);
    multi.hSet(this.reverseKey, path, id);

    // Execute the transaction
    await multi.exec();
  };

  // Get the path for a given ID
  this.get = async (id) => {
    if (!id) return null;
    return await client.hGet(this.key, id);
  };

  // The paths of several IDs in one request, null for one not mapped
  this.getPaths = async (ids) => {
    if (!ids.length) return [];
    return await client.hmGet(this.key, ids);
  };

  // The IDs of several paths in one request, null for one not mapped
  this.getIds = async (paths) => {
    if (!paths.length) return [];
    return await client.hmGet(this.reverseKey, paths);
  };

  // Get the ID for a given path
  this.getByPath = async (path) => {
    if (!path) return null;
    return await client.hGet(this.reverseKey, path);
  };

  this.move = async (id, to) => {
    if (id === "/" || to === "/") {
      throw new Error("Cannot move to or from root");
    }

    const from = await this.get(id);
    if (!from) throw new Error(`No file or folder found for ID: ${id}`);

    // Ensure the target path is not a subfolder of the source path
    if (to.startsWith(from + "/")) {
      throw new Error("Cannot move a folder to a subfolder of itself");
    }

    // Check if 'to' already exists
    const existingId = await this.getByPath(to);
    if (existingId) {
      throw new Error(`Target path already exists: ${to}`);
    }

    const multi = client.multi(); // Start a Redis transaction
    let movedPaths = [];

    // If `from` is the exact path of the file, treat it as a file move
    if (from === to || !from.startsWith("/")) {
      // Remove old reverse mapping and add new mappings in transaction
      multi.hDel(this.reverseKey, from);
      multi.hSet(this.reverseKey, to, id);
      multi.hSet(this.key, id, to);

      movedPaths.push({ from, to });

      // Execute the transaction and return the result
      await multi.exec();
      return movedPaths;
    }

    // For folders, update all child paths
    const START_CURSOR = "0";
    let cursor = START_CURSOR;

    do {
      const { cursor: nextCursor, entries } = await client.hScan(
        this.key,
        cursor
      );
      cursor = nextCursor;

      for (const entry of entries) {
        const currentId = entry.field;
        const currentPath = entry.value;

        // Check if the current path is affected by the move
        if (currentPath === from || currentPath.startsWith(`${from}/`)) {
          const newPath = to + currentPath.slice(from.length);

          // Queue all changes in the transaction
          multi.hDel(this.reverseKey, currentPath); // Remove old reverse mapping
          multi.hSet(this.reverseKey, newPath, currentId); // Add new reverse mapping
          multi.hSet(this.key, currentId, newPath); // Update the path mapping

          movedPaths.push({ from: currentPath, to: newPath });
        }
      }
    } while (cursor !== START_CURSOR);

    // Execute the transaction
    await multi.exec();

    // Return all the affected paths
    return movedPaths;
  };

  // Remove a file or folder and its children
  this.remove = async (id) => {
    const from = await this.get(id);

    if (!from) {
      console.log("Warning: No file or folder found for ID: ", id);
      return [];
    }

    const multi = client.multi(); // Start a Redis transaction
    let removedPaths = [];

    // Scan and delete all affected paths
    const START_CURSOR = "0";
    let cursor = START_CURSOR;

    do {
      const { cursor: nextCursor, entries } = await client.hScan(
        this.key,
        cursor
      );
      cursor = nextCursor;

      for (const entry of entries) {
        const currentId = entry.field;
        const currentPath = entry.value;

        // Check if the current path is affected by the removal
        if (
          from === "/" ||
          currentPath === from ||
          currentPath.startsWith(`${from}/`)
        ) {
          multi.hDel(this.key, currentId); // Delete ID ↔ Path mapping
          multi.hDel(this.reverseKey, currentPath); // Delete Path ↔ ID mapping
          multi.hDel(this.appliedKey, currentId);
          removedPaths.push(currentPath);
        }
      }
    } while (cursor !== START_CURSOR);

    // Execute the transaction
    await multi.exec();

    return removedPaths;
  };

  // Reset the mapping, and the applied records unless keepApplied (a resync
  // rebuilding the mapping keeps them, then prunes: pruneApplied)
  this.reset = async ({ keepApplied = false } = {}) => {
    const multi = client.multi();
    multi.del(this.key);
    multi.del(this.reverseKey);
    if (!keepApplied) multi.del(this.appliedKey);
    await multi.exec();
  };

  // Deletes only this blog's records of the folder's files, leaving the
  // mapping, which another blog on the same folder still uses
  this.forgetOwn = async () => {
    await client.del(this.appliedKey);
  };

  refuseAfterAbort(this, [
    "setApplied",
    "pruneApplied",
    "set",
    "move",
    "remove",
    "reset",
    "forgetOwn",
  ]);

  return this;
}

module.exports = folder;
