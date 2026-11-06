const client = require("models/client");

const PREFIX = require("./prefix");

const blog = {
  _key(blogID) {
    return `${PREFIX}blogs:${blogID}`;
  },

  _globalSetKey() {
    return `${PREFIX}blogs`;
  },

  _serviceAccountSetKey(serviceAccountId) {
    return `${PREFIX}serviceAccountId:${serviceAccountId}`;
  },

  async store(blogID, data) {
    const key = this._key(blogID);

    if (typeof data !== "object" || data === null) {
      throw new Error("Data must be a non-null object");
    }

    const currentData = await this.get(blogID);
    const currentServiceAccountId = currentData?.serviceAccountId;

    // Serialize and save fields
    for (const [field, value] of Object.entries(data)) {
      const serializedValue = JSON.stringify(value);
      await client.hSet(key, field, serializedValue);
    }

    // Add blog ID to the global set
    await client.sAdd(this._globalSetKey(), blogID);

    // Manage serviceAccountId sets
    const newServiceAccountId = data.serviceAccountId;
    if (
      newServiceAccountId &&
      newServiceAccountId !== currentServiceAccountId
    ) {
      // Remove blog ID from the old serviceAccountId set
      if (currentServiceAccountId) {
        await client.sRem(
          this._serviceAccountSetKey(currentServiceAccountId),
          blogID
        );
      }
      // Add blog ID to the new serviceAccountId set
      if (newServiceAccountId) {
        await client.sAdd(
          this._serviceAccountSetKey(newServiceAccountId),
          blogID
        );
      }
    }
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

    // Get the current data to find the serviceAccountId
    const currentData = await this.get(blogID);
    const currentServiceAccountId = currentData?.serviceAccountId;

    // Remove the Redis hash
    await client.del(key);

    // Remove blog ID from the global set
    await client.sRem(this._globalSetKey(), blogID);

    // Remove blog ID from the serviceAccountId set if it exists
    if (currentServiceAccountId) {
      await client.sRem(
        this._serviceAccountSetKey(currentServiceAccountId),
        blogID
      );
    }
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

  async iterateByServiceAccountId(serviceAccountId, callback) {
    const setKey = this._serviceAccountSetKey(serviceAccountId);
    const blogIDs = await client.sMembers(setKey);

    for (const blogID of blogIDs) {
      const blogData = await this.get(blogID);
      if (blogData) {
        await callback(blogID, blogData);
      }
    }
  },
};

module.exports = blog;
