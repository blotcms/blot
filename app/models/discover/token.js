const crypto = require("crypto");
const client = require("models/client");
const ensure = require("helper/ensure");
const key = require("./key");

// An "Add to Discover" link in the maintainer's daily email lasts a day
const TTL_SECONDS = 24 * 60 * 60;

const VALID_TOKEN = /^[a-f0-9]{64}$/;

// Resolves to a new one-time token for the post
async function create(blogID, entryID) {
  ensure(blogID, "string").and(entryID, "string");

  const token = crypto.randomBytes(32).toString("hex");

  await client.set(key.token(token), JSON.stringify({ blogID, entryID }), {
    EX: TTL_SECONDS,
  });

  return token;
}

function parse(value) {
  if (!value) return null;

  try {
    const { blogID, entryID } = JSON.parse(value);
    if (typeof blogID !== "string" || typeof entryID !== "string") return null;
    return { blogID, entryID };
  } catch (err) {
    return null;
  }
}

// Resolves to { blogID, entryID }, or null for an unknown, expired or used
// token. Reading does not use the token up: mail scanners open links.
async function read(token) {
  if (typeof token !== "string" || !VALID_TOKEN.test(token)) return null;
  return parse(await client.get(key.token(token)));
}

// Like read, but deletes the token, so only one request can use it
async function consume(token) {
  if (typeof token !== "string" || !VALID_TOKEN.test(token)) return null;
  return parse(await client.getDel(key.token(token)));
}

module.exports = { create, read, consume, TTL_SECONDS };
