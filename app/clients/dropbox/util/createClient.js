// This exists because requiring fetch
// and doing Dropbox.Dropbox is too upsetting
// in every single file. I wrap the constructor.

const { Dropbox } = require("dropbox");
const database = require("../database");
const config = require("config");

// Resolves to { error, client, account } and never rejects, since the caller
// sometimes needs the account even when there is an error with the client
// (during disconnection, say).
async function attempt(blogID) {
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

  const client = new Dropbox();

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

  try {
    await client.auth.checkAndRefreshAccessToken();
  } catch (error) {
    // We need the account information
    // during disconnection, even if there
    // is an error with the client
    return { error, client: null, account };
  }

  let latestToken = client.auth.getAccessToken();

  if (latestToken === account.access_token) {
    return { error: null, client, account };
  }

  account.access_token = latestToken;

  try {
    await database.set(blogID, account);
  } catch (error) {
    return { error, client: null, account: undefined };
  }

  return { error: null, client, account };
}

// Calls back with (err, client, account): several results, so this keeps its
// callback form (util/loadClient.js wraps it for callers that await).
module.exports = function createClient(blogID, callback) {
  attempt(blogID).then(function ({ error, client, account }) {
    if (error) return callback(error, null, account);
    callback(null, client, account);
  });
};
