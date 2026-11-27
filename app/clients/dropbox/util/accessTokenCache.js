const crypto = require("crypto");
const redis = require("models/client");

// A minute short of the token's expiry, so a cached token is never handed out
// in its last moments
const MARGIN_MS = 60 * 1000;

// Dropbox access tokens are short lived (4 hours) and the account row only
// holds the token, not when it expires, so without this every createClient
// asks Dropbox for a new one (about 330ms). The token is kept here with its
// expiry and the refresh token it was issued for, so reconnecting a blog
// (a new refresh token) never picks up the old connection's token.
// A hash, so the cache never holds a second copy of the long-lived secret
function fingerprint(refreshToken) {
  return crypto.createHash("sha256").update(String(refreshToken)).digest("hex");
}

function key(blogID) {
  return "blog:" + blogID + ":dropbox:access-token";
}

// Resolves { access_token, expires_at } for the account, or null
async function get(blogID, account) {
  let cached;

  try {
    cached = JSON.parse(await redis.get(key(blogID)));
  } catch (err) {
    return null;
  }

  if (
    !cached ||
    cached.refresh_token_hash !== fingerprint(account.refresh_token) ||
    typeof cached.access_token !== "string" ||
    typeof cached.expires_at !== "number" ||
    cached.expires_at - MARGIN_MS <= Date.now()
  ) {
    return null;
  }

  return cached;
}

async function set(blogID, account, accessToken, expiresAt) {
  const ttl = expiresAt - MARGIN_MS - Date.now();
  if (ttl <= 0) return;

  await redis.set(
    key(blogID),
    JSON.stringify({
      access_token: accessToken,
      expires_at: expiresAt,
      refresh_token_hash: fingerprint(account.refresh_token),
    }),
    { PX: Math.floor(ttl) }
  );
}

async function drop(blogID) {
  await redis.del(key(blogID));
}

module.exports = { get, set, drop, key };
