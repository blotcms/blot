var client = require("models/client");
var withCallback = require("helper/withCallback");

async function main(string) {
  var types = {};
  var result = [];
  var allKeys = [];

  await redisKeys("*", async function (keys) {
    for (const key of keys) {
      allKeys.push(key);

      if (key.indexOf(string) > -1)
        result.push({ key: key, value: "KEY ITSELF", type: "KEY" });
    }
  });

  for (const key of allKeys) {
    const type = await client.type(key);

    types[type] = types[type] || [];
    types[type].push(key);
  }

  for (const type in types) {
    const keysByType = types[type];

    if (type === "string") {
      await stringSearch(string, keysByType, result);
    } else if (type === "hash") {
      await hashSearch(string, keysByType, result);
    } else if (type === "list") {
      await listSearch(string, keysByType, result);
    } else if (type === "set") {
      await setSearch(string, keysByType, result);
    } else if (type === "zset") {
      await sortedSetSearch(string, keysByType, result);
    } else {
      throw new Error("No handlers for strings of type: " + type);
    }
  }

  const dedupedResult = [];
  const seen = new Set();

  for (const entry of result) {
    const signature = `${entry.type}:${entry.key}:${entry.value}`;
    if (seen.has(signature)) continue;

    seen.add(signature);
    dedupedResult.push(entry);
  }

  return dedupedResult;
}

async function stringSearch(string, keys, result) {
  for (const key of keys) {
    const value = await client.get(key);

    if (!value) continue;
    if (value.indexOf(string) === -1) continue;

    result.push({ key: key, type: "STRING", value: value });
  }
}

async function listSearch(string, keys, result) {
  for (const key of keys) {
    const items = await client.lRange(key, 0, -1);
    if (!items) continue;

    items.forEach(function (item) {
      if (item.indexOf(string) > -1)
        result.push({ key: key, type: "LIST", value: item });
    });
  }
}

async function hashSearch(string, keys, result) {
  for (const key of keys) {
    const res = await client.hGetAll(key);
    if (!res) continue;

    for (var property in res)
      if (res[property].indexOf(string) > -1 || property.indexOf(string) > -1)
        result.push({
          key: key,
          type: "HASH",
          value: property + " " + res[property],
        });
  }
}

async function setSearch(string, keys, result) {
  for (const key of keys) {
    const members = await client.sMembers(key);
    if (!members) continue;

    members.forEach(function (member) {
      if (member.indexOf(string) > -1)
        result.push({ key: key, type: "SET", value: member });
    });
  }
}

async function sortedSetSearch(string, keys, result) {
  for (const key of keys) {
    const members = await client.zRange(key, 0, -1);
    if (!members) continue;

    members.forEach(function (member) {
      if (member.indexOf(string) > -1)
        result.push({ key: key, type: "ZSET", value: member });
    });
  }
}

async function redisKeys(pattern, fn) {
  var complete;
  var cursor = "0";

  while (!complete) {
    const scanReply = await client.scan(cursor, {
      MATCH: pattern,
      COUNT: 1000,
    });
    const normalizedScanReply = normalizeScanReply(scanReply);

    cursor = normalizedScanReply.cursor;
    await fn(normalizedScanReply.keys);

    complete = cursor === "0";
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

module.exports = withCallback(main);
