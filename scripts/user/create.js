var User = require("models/user");
var format = require("url").format;
var config = require("config");

async function createWithPassword(email, password, subscription, paypal) {
  var passwordHash = await User.hashPassword(password);

  await User.create(email, passwordHash, subscription, paypal);

  console.log("Created user", email);
  process.exit();
}

async function createAccessLink() {
  const expires = 60 * 60 * 24 * 180; // 180 days time

  var token = await User.generateAccessToken({ expires });

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
  console.log("It can be clicked multiple times but can only be used once.");

  console.log();
  console.log("To automate the creation of 20 accounts:");
  console.log(
    "seq 20 | xargs -I{} node scripts/user/create.js | grep https://"
  );

  console.log();
  console.log("Use this link to create an account:");
  console.log(url);

  process.exit();
}

if (require.main === module) {
  var email = process.argv[2];
  var subscription = {};
  var paypal = {};
  var password = process.argv[3];

  var run = password
    ? createWithPassword(email, password, subscription, paypal)
    : createAccessLink();

  run.then(
    function () {
      process.exit(0);
    },
    function (err) {
      console.error(err);
      process.exit(1);
    }
  );
}
