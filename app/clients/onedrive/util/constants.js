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

  // Graph's simple upload only handles small files; anything larger needs
  // an upload session. Chunks must be a multiple of 320 KiB.
  SIMPLE_UPLOAD_MAX_BYTES: 4 * 1000 * 1000,
  UPLOAD_CHUNK_BYTES: 32 * 320 * 1024,

  // Files bigger than this are not downloaded (an empty placeholder is
  // written instead), matching the Dropbox client.
  MAX_FILE_SIZE: 100 * 1024 * 1024,

  // Refresh access tokens this long before they actually expire.
  EXPIRY_MARGIN_MS: 60 * 1000,
};
