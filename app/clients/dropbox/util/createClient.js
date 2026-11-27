// This exists because requiring fetch
// and doing Dropbox.Dropbox is too upsetting
// in every single file. I wrap the constructor.

const { Dropbox } = require("dropbox");
const database = require("../database");
const config = require("config");
const accessTokenCache = require("./accessTokenCache");
const fetch = require("./fetch");
const guard = require("storage/folder/guard");

// Resolves to { error, client, account } and never rejects, since the caller
// sometimes needs the account even when there is an error with the client
// (during disconnection, say). client is null whenever there is an error.
// options.signal (an AbortSignal, the sync's folder.signal) goes into every
// request the client makes, the token refresh included, so a disconnect cuts
// off a transfer in flight. Once it has aborted, the refreshed token isn't
// saved: the account may have been dropped meanwhile. The same goes for a
// caller without the signal that runs inside a sync a disconnect has
// stopped, such as a dashboard write (storage/folder/guard.js).
module.exports = async function createClient(blogID, options = {}) {
  const { signal } = options;

  let account;

  try {
    account = await database.get(blogID);
  } catch (error) {
    return { error, client: null, account: undefined };
  }

  if (!account) {
    return {
      error: new Error("No Dropbox account"),
      client: null,
      account: undefined,
    };
  }

  const client = new Dropbox({
    fetch: signal ? (url, init) => fetch(url, { ...init, signal }) : fetch,
  });

  client.auth.setAccessToken(account.access_token);

  // Legacy Dropbox authentications (pre September 2021)
  // won't have refresh tokens.
  // Refresh tokens are used to recieve new access tokens
  // since new access tokens now expire after 4 hours
  if (!account.refresh_token) return { error: null, client, account };

  let clientId = account.full_access
    ? config.dropbox.full.key
    : config.dropbox.app.key;

  let clientSecret = account.full_access
    ? config.dropbox.full.secret
    : config.dropbox.app.secret;

  client.auth.setClientId(clientId);
  client.auth.setClientSecret(clientSecret);
  client.auth.setRefreshToken(account.refresh_token);

  // Use the access token cached with its expiry, if there is one, so the SDK
  // only asks Dropbox for a new one when it is near expiry
  const cached = await accessTokenCache.get(blogID, account);

  if (cached) {
    client.auth.setAccessToken(cached.access_token);
    client.auth.setAccessTokenExpiresAt(new Date(cached.expires_at));
  }

  try {
    await client.auth.checkAndRefreshAccessToken();
  } catch (error) {
    // We need the account information
    // during disconnection, even if there
    // is an error with the client
    return { error, client: null, account };
  }

  let latestToken = client.auth.getAccessToken();

  if (latestToken === (cached ? cached.access_token : account.access_token)) {
    return { error: null, client, account };
  }

  const expiresAt = client.auth.getAccessTokenExpiresAt();

  if (expiresAt) {
    await accessTokenCache
      .set(blogID, account, latestToken, expiresAt.getTime())
      .catch((err) => console.log("Could not cache Dropbox token", err));
  }

  account.access_token = latestToken;

  if (signal && signal.aborted) {
    return { error: signal.reason, client: null, account };
  }

  try {
    guard.check(blogID);
  } catch (error) {
    return { error, client: null, account };
  }

  try {
    await database.set(blogID, account);
  } catch (error) {
    return { error, client: null, account: undefined };
  }

  return { error: null, client, account };
};
