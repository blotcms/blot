const clfdate = require("helper/clfdate");

// One GoogleAuth per service account and set of scopes, kept for the life of
// the process, with its access token refreshed in the background (#2847).
//
// Why: each GoogleAuth fetches its own access token, a round trip to Google's
// token endpoint, on its first request. A Drive client was created for every
// sync (sync/sync.js), so every sync's first request, the folder lookup,
// waited for a new token first. Kept, the token is reused by every sync, and
// refreshing it before it is due means no request waits for that either:
// google-auth-library refreshes a token on the request that finds it within
// EAGER_REFRESH_MS of expiring, and the timer below makes that request its
// own, every REFRESH_EVERY_MS, so it is never a sync's.
//
// Connections themselves are already reused between requests: Node 24's
// global HTTPS agent keeps them alive, and gaxios uses it.
const EAGER_REFRESH_MS = 15 * 60 * 1000;
const REFRESH_EVERY_MS = 5 * 60 * 1000;

const cache = new Map();

const prefix = () => `${clfdate()} Google Drive auth:`;

module.exports = function cachedAuth(GoogleAuth, credentials, scopes) {
  // A new key for the same account (rotated in the config) gets a new auth
  const key = [
    credentials.client_id,
    credentials.private_key_id || "",
    [].concat(scopes).join(" "),
    GoogleAuth.name,
  ].join("|");
  if (cache.has(key)) return cache.get(key);

  const auth = new GoogleAuth({
    credentials,
    scopes,
    clientOptions: { eagerRefreshThresholdMillis: EAGER_REFRESH_MS },
  });
  cache.set(key, auth);

  const refresh = async () => {
    try {
      await auth.getAccessToken();
    } catch (err) {
      console.error(
        prefix(),
        `client_id=${credentials.client_id} refresh failed:`,
        err.message
      );
    }
  };
  const timer = setInterval(refresh, REFRESH_EVERY_MS);
  timer.unref?.();

  return auth;
};

module.exports.cache = cache;
