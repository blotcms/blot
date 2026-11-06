const createRedisClient = require("models/redis");

async function redisKeys(pattern, iterator) {
  const client = createRedisClient();

  let cursor = "0";
  let complete = false;

  try {
    await client.connect();

    while (!complete) {
      const scanReply = await client.scan(cursor, {
        MATCH: pattern,
        COUNT: 1000,
      });
      const normalizedScanReply = normalizeScanReply(scanReply);
      cursor = normalizedScanReply.cursor;

      for (const result of normalizedScanReply.keys) {
        await iterator(result);
      }

      complete = cursor === "0";
    }
  } finally {
    if (client.isOpen) {
      await client.quit();
    }
  }
}

function normalizeScanReply(reply) {
  if (Array.isArray(reply)) {
    return {
      cursor: String(reply[0] || "0"),
      keys: Array.isArray(reply[1]) ? reply[1] : [],
    };
  }

  if (reply && typeof reply === "object") {
    const cursor = Object.prototype.hasOwnProperty.call(reply, "cursor")
      ? String(reply.cursor)
      : "0";

    const keys = Array.isArray(reply.keys)
      ? reply.keys
      : Array.isArray(reply.results)
        ? reply.results
        : [];

    return { cursor, keys };
  }

  return { cursor: "0", keys: [] };
}

module.exports = redisKeys;
