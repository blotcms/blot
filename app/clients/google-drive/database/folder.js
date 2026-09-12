const client = require("models/client");

const PREFIX = require("./prefix");

function folder(folderId, blogID) {

  if (!(this instanceof folder)) {
    return new folder(folderId, blogID);
  }

  if (!folderId) {
    throw new Error("Folder ID is required");
  }

  // Redis keys
  this.key = `${PREFIX}${folderId}:folder`; // ID ↔ Path mapping
  this.reverseKey = `${PREFIX}${folderId}:path`; // Path ↔ ID mapping
  this.contentKey = `${PREFIX}${folderId}:verified-content${blogID ? ":" + blogID : ""}`;
  this.metadataKey = `${PREFIX}${folderId}:metadata`; // File metadata

  this.migrationCursorKey = `${this.contentKey}:cursor`;
  this.getMigrationCursor = async () => (await client.get(this.migrationCursorKey)) || "";
  this.setMigrationCursor = async (path) => client.set(this.migrationCursorKey, path);

  // Content verification is independent of mutable metadata written by set().
  // Fetch a directory in one Redis request, rather than one request per file.
  this.getVerifiedContents = async (ids) => {
    if (!ids.length) return [];
    return (await client.hmGet(this.contentKey, ids)).map(value => {
      try {
        const record = value && JSON.parse(value);
        return record && [record.path, record.checksum, record.fingerprint]
          .every(field => typeof field === "string" && field.length) ? record : null;
      } catch (_) { return null; }
    });
  };

  this.setVerifiedContent = async (id, value) => {
    await client.hSet(this.contentKey, id, JSON.stringify(value));
  };

  // Only manual mapping resets need this cleanup. Scan in batches so old
  // verified IDs removed while mappings were absent do not accumulate forever.
  this.pruneVerifiedContents = async () => {
    let cursor = "0";
    do {
      const page = await client.hScan(this.contentKey, cursor, { COUNT: 256 });
      cursor = page.cursor;
      const ids = page.entries.map(entry => entry.field);
      if (!ids.length) continue;
      const paths = await client.hmGet(this.key, ids);
      const removed = ids.filter((id, i) => !paths[i]);
      if (removed.length) await client.hDel(this.contentKey, removed);
    } while (cursor !== "0");
  };

  // Set a mapping (ID → Path) and store metadata
  this.set = async (id, path, metadata = {}) => {
    if (!id || !path || typeof id !== "string" || typeof path !== "string") {
      throw new Error("ID and path must be non-empty strings");
    }

    if (metadata && typeof metadata !== "object") {
      throw new Error("Metadata must be a valid object");
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
      multi.hDel(this.contentKey, previousId);
    }

    // Add the new ID ↔ Path mapping
    multi.hSet(this.key, id, path);
    multi.hSet(this.reverseKey, path, id);

    // Update metadata if provided
    if (metadata && Object.keys(metadata).length > 0) {
      multi.hSet(this.metadataKey, id, JSON.stringify(metadata));
    }

    // Execute the transaction
    await multi.exec();
  };

  // Get the path for a given ID
  this.get = async (id) => {
    if (!id) return null;
    return await client.hGet(this.key, id);
  };

  // Get the ID for a given path
  this.getByPath = async (path) => {
    if (!path) return null;
    return await client.hGet(this.reverseKey, path);
  };

  // Get metadata for a given ID
  this.getMetadata = async (id) => {
    const metadata = await client.hGet(this.metadataKey, id);
    return metadata ? JSON.parse(metadata) : null;
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
      const metadata = (await this.getMetadata(id)) || {}; // Default to empty metadata

      // Remove old reverse mapping and add new mappings in transaction
      multi.hDel(this.reverseKey, from);
      multi.hSet(this.reverseKey, to, id);
      multi.hSet(this.key, id, to);
      multi.hSet(this.metadataKey, id, JSON.stringify(metadata));

      movedPaths.push({ from, to });

      // Execute the transaction and return the result
      await multi.exec();
      return movedPaths;
    }

    // For folders, update all child paths
    const START_CURSOR = "0";
    let cursor = START_CURSOR;

    do {
      const { cursor: nextCursor, entries } = await client.hScan(this.key, cursor);
      cursor = nextCursor;

      for (const entry of entries) {
        const currentId = entry.field;
        const currentPath = entry.value;

        // Check if the current path is affected by the move
        if (currentPath === from || currentPath.startsWith(`${from}/`)) {
          const newPath = to + currentPath.slice(from.length);
          const metadata = (await this.getMetadata(currentId)) || {}; // Default to empty metadata

          // Queue all changes in the transaction
          multi.hDel(this.reverseKey, currentPath); // Remove old reverse mapping
          multi.hSet(this.reverseKey, newPath, currentId); // Add new reverse mapping
          multi.hSet(this.key, currentId, newPath); // Update the path mapping
          multi.hSet(this.metadataKey, currentId, JSON.stringify(metadata)); // Update metadata

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
      const { cursor: nextCursor, entries } = await client.hScan(this.key, cursor);
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
          multi.hDel(this.contentKey, currentId);
          multi.hDel(this.metadataKey, currentId); // Delete metadata
          removedPaths.push(currentPath);
        }
      }
    } while (cursor !== START_CURSOR);

    // Execute the transaction
    await multi.exec();

    return removedPaths;
  };

  // Reset all mappings and metadata
  this.reset = async ({ preserveVerifiedContent = false } = {}) => {
    const multi = client.multi();
    multi.del(this.key);
    multi.del(this.reverseKey);
    multi.del(this.metadataKey);
    if (!preserveVerifiedContent) {
      multi.del(this.contentKey);
      multi.del(this.migrationCursorKey);
    }
    await multi.exec();
  };

  this.readdir = async (dir) => {
    if (!dir || typeof dir !== "string") {
      throw new Error("Directory path must be a non-empty string");
    }

    // Normalize the directory path to ensure it ends with a "/"
    const basePath = dir.endsWith("/") ? dir : dir + "/";

    const START_CURSOR = "0";
    let cursor = START_CURSOR;
    let entries = [];

    do {
      // Scan the folder key
      const { cursor: nextCursor, entries: scannedEntries } = await client.hScan(this.key, cursor);
      cursor = nextCursor;

      for (const entry of scannedEntries) {
        const id = entry.field;
        const path = entry.value;

        // Check if the path is an immediate child of the given directory
        if (
          path.startsWith(basePath) &&
          path !== basePath && // Exclude the directory itself
          !path.slice(basePath.length).includes("/") // Exclude paths inside subdirectories of the directory
        ) {
          const metadata = await this.getMetadata(id);
          entries.push({ id, path, metadata });
        }
      }
    } while (cursor !== START_CURSOR);

    // Sort entries alphabetically by path
    entries.sort((a, b) => a.path.localeCompare(b.path));

    return entries;
  };

  // List all files and folders with metadata
  this.listAll = async () => {
    const START_CURSOR = "0";
    let cursor = START_CURSOR;
    let results = [];

    do {
      const { cursor: nextCursor, entries } = await client.hScan(this.key, cursor);
      cursor = nextCursor;

      for (const entry of entries) {
        const id = entry.field;
        const path = entry.value;
        const metadata = await this.getMetadata(id);
        results.push({ id, path, metadata });
      }
    } while (cursor !== START_CURSOR);

    return results;
  };

  return this;
}

module.exports = folder;