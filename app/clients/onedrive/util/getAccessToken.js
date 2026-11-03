const { promisify } = require("util");
const database = require("../database");
const oauth = require("./oauth");
const { persistError, clearError } = require("./persistError");
const { SOURCES } = require("./classifyError");
const { EXPIRY_MARGIN_MS } = require("./constants");

const getAccount = promisify(database.get);
const setAccount = promisify(database.set);

// Returns a valid access token for the blog's OneDrive account,
// refreshing (and saving the rotated tokens) when it is about to expire.
// If Microsoft rejects the refresh token the account is flagged with
// error_code 401 (REAUTH_REQUIRED) so the dashboard can ask the user to reconnect.
module.exports = async function getAccessToken(blogID) {
  const account = await getAccount(blogID);

  if (!account) throw new Error("No OneDrive account for blog " + blogID);

  if (
    account.access_token &&
    account.expires_at - Date.now() > EXPIRY_MARGIN_MS
  ) {
    return account.access_token;
  }

  let tokens;

  try {
    tokens = await oauth.refresh(account.refresh_token);
  } catch (err) {
    // Persists REAUTH_REQUIRED for invalid_grant; ignores transient errors
    await persistError(blogID, err, SOURCES.AUTH);
    throw err;
  }

  await setAccount(blogID, {
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token || account.refresh_token,
    expires_at: tokens.expires_at,
  });

  // A working refresh token proves auth is healthy again
  if (account.error_code === 401) await clearError(blogID);

  return tokens.access_token;
};
