const client = require("models/client");

const PREFIX = require("./prefix");

// Channel operations
const channel = {
  // Generate Redis keys for channels
  _key(channelId) {
    return `${PREFIX}channels:${channelId}`;
  },
  _globalSetKey() {
    return `${PREFIX}channels`;
  },
  _serviceAccountKey(serviceAccountId) {
    return `${PREFIX}serviceAccounts:${serviceAccountId}:channels`;
  },
  _fileKey(serviceAccountId, fileId) {
    return `${PREFIX}serviceAccounts:${serviceAccountId}:files:${fileId}:channels`;
  },

  // Create or update a channel, associating it with the appropriate IDs
  async store(channelId, data) {
    const { type, serviceAccountId, fileId } = data;

    if (!type || !serviceAccountId) {
      throw new Error(
        "type and serviceAccountId are required to associate a channel."
      );
    }

    const key = this._key(channelId);
    const globalSetKey = this._globalSetKey();
    const serviceAccountKey = this._serviceAccountKey(serviceAccountId);

    // Store each field of the data object in the Redis hash
    for (const [field, value] of Object.entries(data)) {
      await client.hSet(key, field, value);
    }

    // Track the channel globally
    await client.sAdd(globalSetKey, channelId);

    // Track the channel under the serviceAccountId
    await client.sAdd(serviceAccountKey, channelId);

    // If this is a `files.watch` channel, associate it with the fileId
    if (type === "files.watch" && fileId) {
      const fileKey = this._fileKey(serviceAccountId, fileId);
      await client.sAdd(fileKey, channelId);
    }
  },

  // Retrieve a channel by its ID
  async get(channelId) {
    const key = this._key(channelId);
    const data = await client.hGetAll(key);
    return data && Object.keys(data).length ? data : null;
  },

  // Delete a channel by its ID, untracking it globally and from its associations
  async delete(channelId) {
    const key = this._key(channelId);
    const globalSetKey = this._globalSetKey();

    // Get the channel data to find associations
    const data = await this.get(channelId);
    if (!data) return;

    const { type, serviceAccountId, fileId } = data;

    if (serviceAccountId) {
      const serviceAccountKey = this._serviceAccountKey(serviceAccountId);
      await client.sRem(serviceAccountKey, channelId);

      if (type === "files.watch" && fileId) {
        const fileKey = this._fileKey(serviceAccountId, fileId);
        await client.sRem(fileKey, channelId);
      }
    }

    // Remove the channel from Redis
    await client.del(key);

    // Remove the channel from the global channel set
    await client.sRem(globalSetKey, channelId);
  },

  // List all channels globally
  async list() {
    const globalSetKey = this._globalSetKey();
    return await client.sMembers(globalSetKey);
  },

  // List all channels associated with a serviceAccountId
  async listByServiceAccount(serviceAccountId) {
    const serviceAccountKey = this._serviceAccountKey(serviceAccountId);
    return await client.sMembers(serviceAccountKey);
  },

  // List all channels associated with a serviceAccountId and fileId
  async listByFile(serviceAccountId, fileId) {
    const fileKey = this._fileKey(serviceAccountId, fileId);
    return await client.sMembers(fileKey);
  },

  // Iterate over all channels globally
  async iterate(callback) {
    const globalSetKey = this._globalSetKey();
    let cursor = "0";
    do {
      const { cursor: nextCursor, members: channelIds } = await client.sScan(
        globalSetKey,
        cursor
      );
      for (const channelId of channelIds) {
        const data = await this.get(channelId);
        if (data && Object.keys(data).length) {
          await callback(data);
        }
      }
      cursor = nextCursor;
    } while (cursor !== "0");
  },

  // Iterate over all channels associated with a serviceAccountId
  async iterateByServiceAccount(serviceAccountId, callback) {
    const serviceAccountKey = this._serviceAccountKey(serviceAccountId);
    let cursor = "0";
    do {
      const { cursor: nextCursor, members: channelIds } = await client.sScan(
        serviceAccountKey,
        cursor
      );
      for (const channelId of channelIds) {
        const data = await this.get(channelId);
        if (data && Object.keys(data).length) {
          await callback(data);
        }
      }
      cursor = nextCursor;
    } while (cursor !== "0");
  },

  // Iterate over all channels associated with a serviceAccountId and fileId
  async iterateByFile(serviceAccountId, fileId, callback) {
    const fileKey = this._fileKey(serviceAccountId, fileId);
    let cursor = "0";
    do {
      const { cursor: nextCursor, members: channelIds } = await client.sScan(
        fileKey,
        cursor
      );
      for (const channelId of channelIds) {
        const data = await this.get(channelId);
        if (data && Object.keys(data).length) {
          await callback(data);
        }
      }
      cursor = nextCursor;
    } while (cursor !== "0");
  },
};

module.exports = channel;
