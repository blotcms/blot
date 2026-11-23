const client = require("models/client");
const { normalizeErrorFields } = require("./error");

const PREFIX = "blot:clients:icloud-drive:";

// How long a path stays marked as uploading. An upload is marked only while
// it runs (seconds), so this only bounds a mark left by a crash, which the
// macserver's retry clears long before.
const PENDING_UPLOAD_TTL_MS = 7 * 24 * 60 * 60 * 1000;

module.exports = {
  _key(blogID) {
    return `${PREFIX}blogs:${blogID}`;
  },

  _globalSetKey() {
    return `${PREFIX}blogs`;
  },

  _pendingUploadsKey(blogID) {
    return `${PREFIX}pending-uploads:${blogID}`;
  },

  // The upload route writes a file and then builds it. A crash between the
  // two leaves the file current on disk with nothing built, and the
  // macserver's retry would find it up to date and stop. The path is marked
  // before the write and cleared once the build is done, so the retry knows
  // to build it.
  async markUploadPending(blogID, path) {
    const key = this._pendingUploadsKey(blogID);
    await client
      .multi()
      .sAdd(key, path)
      .pExpire(key, PENDING_UPLOAD_TTL_MS)
      .exec();
  },

  async clearUploadPending(blogID, path) {
    await client.sRem(this._pendingUploadsKey(blogID), path);
  },

  async isUploadPending(blogID, path) {
    return Boolean(
      await client.sIsMember(this._pendingUploadsKey(blogID), path)
    );
  },

  async store(blogID, data) {
    const key = this._key(blogID);

    if (typeof data !== "object" || data === null) {
      throw new Error("Data must be a non-null object");
    }

    const currentData = await this.get(blogID);
    const toWrite = Object.assign({}, data);

    // Keep error / errorCode / errorSince in lockstep so getHealth never
    // sees a free-text error without a code, and a cleared error cannot
    // leave a stale code behind.
    if (Object.prototype.hasOwnProperty.call(toWrite, "error")) {
      Object.assign(toWrite, normalizeErrorFields(toWrite, currentData));
    }

    // Serialize and save fields
    for (const [field, value] of Object.entries(toWrite)) {
      const serializedValue = JSON.stringify(value);
      await client.hSet(key, field, serializedValue);
    }

    // Add blog ID to the global set
    await client.sAdd(this._globalSetKey(), blogID);
  },

  // The last time the macserver pushed a change for this blog (/upload,
  // /delete, /mkdir or a requested resync). A single-field write, because it
  // happens on every file the watcher uploads. Not part of store(): the sweep
  // that reads it must never be able to refresh it by accident. Only stamps
  // an existing account: a push that raced a disconnect must not re-create
  // the hash, or a later walk would treat the blog as still connected.
  async stampLastSync(blogID) {
    await client.eval(
      "if redis.call('EXISTS', KEYS[1]) == 1 then return redis.call('HSET', KEYS[1], ARGV[1], ARGV[2]) end return 0",
      {
        keys: [this._key(blogID)],
        arguments: ["lastSync", JSON.stringify(Date.now())],
      }
    );
  },

  async get(blogID) {
    const key = this._key(blogID);
    const result = await client.hGetAll(key);

    if (!result || !Object.keys(result).length) {
      return null;
    }

    const deserializedResult = {};
    for (const [field, value] of Object.entries(result)) {
      try {
        deserializedResult[field] = JSON.parse(value);
      } catch (e) {
        deserializedResult[field] = value;
      }
    }

    return deserializedResult;
  },

  async delete(blogID) {
    const key = this._key(blogID);

    // Remove the Redis hash
    await client.del(key);
    await client.del(this._pendingUploadsKey(blogID));

    // Remove blog ID from the global set
    await client.sRem(this._globalSetKey(), blogID);
  },

  async list() {
    return await client.sMembers(this._globalSetKey());
  },

  async iterate(callback) {
    const blogIDs = await this.list();

    for (const blogID of blogIDs) {
      const blogData = await this.get(blogID);
      if (blogData) {
        await callback(blogID, blogData);
      }
    }
  },
};
