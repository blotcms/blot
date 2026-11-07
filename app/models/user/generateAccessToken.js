var crypto = require("crypto");
var { promisify } = require("util");
var client = require("models/client");
var key = require("./key");

var randomBytes = promisify(crypto.randomBytes);
var TOKEN_LENGTH = 16; // characters long

// We can store anything against the generated access
// token – in the case we want to use this token
// to authenticate the log in of an existing user, we
// might store that user's UID. In the case we want to use
// this token to create a new user account, we just store
// a non-empty value, in this case '1', so the validation code
// in checkAccessToken works.
module.exports = async function generateAccessToken(options) {
  const { uid, expires } = options;
  const value = uid || 1;
  const seconds = expires || 60 * 60 * 24; // one day

  const token = (await randomBytes(TOKEN_LENGTH)).toString("hex");

  await client.setEx(key.accessToken(token), seconds, value);

  return token;
};
