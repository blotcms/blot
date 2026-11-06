var customerID = process.argv[2];
var User = require("models/user");

async function main() {
  var uids = await User.getAllIds();

  await Promise.all(
    uids.map(async function (uid) {
      var user;

      try {
        user = await User.getById(uid);
      } catch {
        // Ignored before: a user that fails to load is just not a match
        return;
      }

      if (
        user &&
        user.subscription &&
        user.subscription.customer === customerID
      ) {
        console.log("MATCH", user.email, user.blogs);
      }
    })
  );
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  }
);
