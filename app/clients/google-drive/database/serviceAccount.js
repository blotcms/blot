const client = require("models/client");

const PREFIX = require("./prefix");

// Service account operations
const serviceAccount = {
  // Generate Redis keys for service accounts
  _key(serviceAccountId) {
    return `${PREFIX}service-accounts:${serviceAccountId}`;
  },
  _globalSetKey() {
    return `${PREFIX}service-accounts`;
  },

  async store(serviceAccountId, data) {
    const key = this._key(serviceAccountId);
    const globalSetKey = this._globalSetKey();

    // Ensure data is an object
    if (typeof data !== "object" || data === null) {
      throw new Error("Data must be a non-null object");
    }

    // Serialize each field of the data object and store it in the Redis hash
    for (const [field, value] of Object.entries(data)) {
      const serializedValue = JSON.stringify(value); // Serialize value
      await client.hSet(key, field, serializedValue);
    }

    // Track the service account in the global set
    await client.sAdd(globalSetKey, serviceAccountId);
  },

  async get(serviceAccountId) {
    const key = this._key(serviceAccountId);

    // Retrieve all fields from the hash
    const result = await client.hGetAll(key);

    // Return null if the key does not exist
    if (!result || !Object.keys(result).length) {
      return null;
    }

    // Deserialize each field from a JSON string back to its original value
    const deserializedResult = {};
    for (const [field, value] of Object.entries(result)) {
      try {
        deserializedResult[field] = JSON.parse(value); // Deserialize value
      } catch (e) {
        // If deserialization fails, return the raw value (fallback)
        deserializedResult[field] = value;
      }
    }

    return deserializedResult;
  },

  async delete(serviceAccountId) {
    const key = this._key(serviceAccountId);
    const globalSetKey = this._globalSetKey();
    await client.del(key);
    await client.sRem(globalSetKey, serviceAccountId); // Remove from global service accounts set
  },

  async list() {
    const globalSetKey = this._globalSetKey();
    return await client.sMembers(globalSetKey); // Fetch all service accounts from the set
  },
};

module.exports = serviceAccount;
