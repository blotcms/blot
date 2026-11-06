var User = require("models/user");
var format = require("url").format;
var config = require("config");

if (require.main === module) {
  var email = process.argv[2];
  var subscription = {};
  var paypal = {};
  var password = process.argv[3];

  if (password) {
    User.hashPassword(password, function (err, passwordHash) {
      if (err) throw err;

      User.create(email, passwordHash, subscription, paypal, function (err) {
        if (err) throw err;

        console.log("Created user", email);
        process.exit();
      });
    });
  } else {
    const expires = 60 * 60 * 24 * 180; // 180 days time
    User.generateAccessToken({ expires }, function (err, token) {
      if (err) throw err;

      // The full one-time log-in link to be sent to the user
      var url = format({
        protocol: "https",
        host: config.host,
        pathname: `/sign-up/paid/${token}`,
      });

      console.log(
        `The link will expire ${require("moment")()
          .add(expires, "seconds")
          .fromNow()}`
      );
      console.log(
        "It can be clicked multiple times but can only be used once."
      );

      console.log();
      console.log("To automate the creation of 20 accounts:");
      console.log(
        "seq 20 | xargs -I{} node scripts/user/create.js | grep https://"
      );

      console.log();
      console.log("Use this link to create an account:");
      console.log(url);

      process.exit();
    });
  }
}
