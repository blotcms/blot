var User = require("models/user");
var authenticate = require("./authenticate");
var LogInError = require("./logInError");
var { isRedisUnavailableError } = require("helper/redisUnavailable");

// The purpose of this function is to check to see if the
// user has requested the log in page with a one-time access
// token. If so, validate it, then redirect the user to the
// appropriate page: the dashboard homepage or somewhere specified
// in the query 'then'.
module.exports = function checkToken(req, res, next) {
  var token, then;

  // There is no token,  then proceed to the next middleware.
  if (!req.query || !req.query.token) return next();

  token = req.query.token;

  // I had previously introduced a bug caused by the fact
  // decodeURIComponent(undefined) === 'undefined'
  // First check that there is 'then' query before attempting to decode
  // We check 'amp;then' because I click links in my terminal which
  // does something (or doesn't do something) to ampersands.
  if (req.query.then || req.query["amp;then"])
    then = decodeURIComponent(req.query.then || req.query["amp;then"]);

  // First we make sure that the access token passed is valid.
  User.checkAccessToken(token, function (err, uid) {
    // An outage is not a bad token, let it reach the 503 handler
    if (isRedisUnavailableError(err)) return next(err);
    if (err) return next(new LogInError("BADTOKEN"));

    // Then we load the user associated with the access token.
    // Tokens are stored against UIDs in the database.
    User.getById(uid, function (err, user) {
      if (isRedisUnavailableError(err)) return next(err);
      if (err || !user) return next(new LogInError("NOUSER"));

      // You used to be able to disable your account
      // but this is no longer possible. Once all
      // users with isDisabled:true are removed you
      // can delete this check safely.
      if (user.isDisabled) return res.redirect("/disabled");

      // Store the valid user'd ID in the session.
      authenticate(req, res, user);

      // If the user does not need to be redirected to another page
      // send them to the dashboard's homepage. Users will be redirected
      // elsewhere when they attempt to visit private pages, or when they
      // request a link to reset their password.
      if (then !== "/sites/account/password/set") {
        return res.redirect("/sites");
      }

      User.generateAccessToken({ uid }, function (err, token) {
        if (err) return next(err);

        // This token is used to authenticate a password change
        // without an existing password. It's stored in the user's
        // session instead of a query string to keep the URLs tidy.
        req.session.passwordSetToken = token;
        res.redirect(then);
      });
    });
  });
};
