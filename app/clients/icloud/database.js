const client = require("models/client");
const { normalizeErrorFields } = require("./error");

const PREFIX = 'blot:clients:icloud-drive:'

module.exports = {
  _key(blogID) {
    return `${PREFIX}blogs:${blogID}`;
  },

  _globalSetKey() {
    return `${PREFIX}blogs`;
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
