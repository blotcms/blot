var User = require("models/user");
var Email = require("helper/email");
var format = require("url").format;
var NOTOKEN = "Could not generate a token";
var config = require("config");
var generateAccessToken = User.generateAccessToken;

module.exports = async function checkReset(req, res, next) {
  try {
    var user = req.user;
    var hasPassword = user.passwordHash !== "";
    var reset = req.body && req.body.reset !== undefined;

    // Some users have not yet set up a password
    // so we might need to send them a link even
    // if they did not click the reset button
    if (!reset && hasPassword) return next();

    await sendPasswordResetEmail(user.uid);

    res.locals.sent = true;
    res.locals.hasPassword = hasPassword;
    res.render("dashboard/log-in/reset");
  } catch (err) {
    return next(err);
  }
};

async function sendPasswordResetEmail(uid) {
  var url;

  const token = await generateAccessToken({ uid });

  if (!token) throw new Error(NOTOKEN);

  // The full one-time log-in link to be sent to the user
  url = format({
    protocol: "https",
    host: config.host,
    pathname: "/sites/log-in",
    query: {
      token: token,
      then: "/sites/account/password/set",
    },
  });

  await Email.SET_PASSWORD(uid, { url: url });
}
