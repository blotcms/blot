const config = require("config");
const fetch = require("node-fetch");
const { Dropbox } = require("dropbox");
const promisify = require("util").promisify;
const database = require("clients/dropbox/database");

const listBlogs = promisify(database.listBlogs);
const get = promisify(database.get);

// When a blog that already has a Dropbox account authorizes again (e.g.
// switching between app folder and full Dropbox permission), Dropbox issues
// a brand new token and the old one stays valid until it is revoked. Call
// this after the new account is saved to revoke the old token with Dropbox.
// It never throws: a failure to revoke must not block setup.
//
// The old token is left alone if another blog's account row still holds it.
async function revokePreviousToken(previous, current) {
  try {
    if (!previous || !previous.access_token) return false;

    const sameToken = (a, b) =>
      a.access_token === b.access_token ||
      (a.refresh_token && a.refresh_token === b.refresh_token);

    if (sameToken(previous, current)) return false;

    for (const blog of await listBlogs(previous.account_id)) {
      if (blog.id === current.blogID) continue;
      const other = await get(blog.id);
      if (other && sameToken(previous, other)) return false;
    }

    const app = previous.full_access ? config.dropbox.full : config.dropbox.app;
    const client = new Dropbox({ fetch });

    client.auth.setAccessToken(previous.access_token);

    if (previous.refresh_token) {
      client.auth.setClientId(app.key);
      client.auth.setClientSecret(app.secret);
      client.auth.setRefreshToken(previous.refresh_token);
      // The old access token has likely expired (they last 4 hours)
      await client.auth.checkAndRefreshAccessToken();
    }

    await client.authTokenRevoke();
    return true;
  } catch (err) {
    // Revoking an already-revoked token errors too
    console.log("Dropbox: failed to revoke previous token", err);
    return false;
  }
}

module.exports = revokePreviousToken;
