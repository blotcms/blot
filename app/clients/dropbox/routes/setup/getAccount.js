const config = require("config");
const fetch = require("node-fetch");
const { Dropbox } = require("dropbox");

module.exports = async function getAccount(account) {
  const { code, full_access, redirectUri } = account;

  const clientId = full_access
    ? config.dropbox.full.key
    : config.dropbox.app.key;

  const clientSecret = full_access
    ? config.dropbox.full.secret
    : config.dropbox.app.secret;

  const dropbox = new Dropbox({ fetch, clientId, clientSecret });

  const {
    result: { access_token, refresh_token },
  } = await dropbox.auth.getAccessTokenFromCode(redirectUri, code);

  const client = new Dropbox({ fetch: fetch });

  client.auth.setAccessToken(access_token);

  const {
    result: { account_id, email },
  } = await client.usersGetCurrentAccount();

  account.account_id = account_id;
  account.email = email;
  account.error_code = 0;
  account.last_sync = Date.now();
  account.access_token = access_token;
  account.refresh_token = refresh_token;
  account.client = client;
  account.cursor = "";

  return account;
};
