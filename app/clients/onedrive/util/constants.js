// v1 supports personal Microsoft accounts only, so we use the "consumers"
// authority. To add work/school accounts later, switch this to "common"
// (and change the app registration's supported account types to match).
const AUTHORITY = "consumers";

module.exports = {
  AUTHORIZE_URL:
    "https://login.microsoftonline.com/" + AUTHORITY + "/oauth2/v2.0/authorize",
  TOKEN_URL:
    "https://login.microsoftonline.com/" + AUTHORITY + "/oauth2/v2.0/token",
  GRAPH_URL: "https://graph.microsoft.com/v1.0",

  // offline_access is what makes Microsoft return a refresh token.
  SCOPES: ["Files.ReadWrite.AppFolder", "offline_access", "User.Read"],

  // Refresh access tokens this long before they actually expire.
  EXPIRY_MARGIN_MS: 60 * 1000,
};
