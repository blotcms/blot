const fetch = require("node-fetch");
const config = require("config");
const redirectUri = require("./redirectUri");
const {
  AUTHORIZE_URL,
  TOKEN_URL,
  GRAPH_URL,
  SCOPES,
} = require("./constants");

// The URL to send the user to so they can consent on Microsoft's site.
function authorizeUrl(state) {
  const params = new URLSearchParams({
    client_id: config.onedrive.client_id,
    response_type: "code",
    redirect_uri: redirectUri(),
    response_mode: "query",
    scope: SCOPES.join(" "),
    state,
    prompt: "select_account",
  });

  return AUTHORIZE_URL + "?" + params.toString();
}

async function requestToken(params) {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: config.onedrive.client_id,
      client_secret: config.onedrive.client_secret,
      scope: SCOPES.join(" "),
      ...params,
    }),
  });

  const body = await res.json();

  if (!res.ok) {
    const err = new Error(
      "OneDrive token request failed: " + (body.error_description || body.error)
    );
    // e.g. "invalid_grant" when the refresh token has expired or was revoked
    err.code = body.error;
    err.status = res.status;
    throw err;
  }

  return {
    access_token: body.access_token,
    refresh_token: body.refresh_token,
    expires_at: Date.now() + body.expires_in * 1000,
  };
}

// Swap the code Microsoft sent to our redirect URI for tokens.
function exchangeCode(code) {
  return requestToken({
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri(),
  });
}

// Microsoft rotates the refresh token on every use, so callers must
// store the refresh_token returned here.
function refresh(refreshToken) {
  return requestToken({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
  });
}

// Identifies the connected Microsoft account.
async function getProfile(accessToken) {
  const res = await fetch(GRAPH_URL + "/me", {
    headers: { Authorization: "Bearer " + accessToken },
  });

  if (!res.ok) {
    const err = new Error("OneDrive profile request failed: " + res.status);
    err.status = res.status;
    throw err;
  }

  const profile = await res.json();

  return {
    account_id: profile.id,
    email: profile.mail || profile.userPrincipalName || "",
  };
}

module.exports = { authorizeUrl, exchangeCode, refresh, getProfile };
