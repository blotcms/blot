var User = require("models/user");
var identifier = process.argv[2];

if (!identifier) throw "Please pass the user's email as an argument.";

async function main() {
  var user = await User.getByEmail(identifier);

  if (!user) throw new Error("No user");

  await User.set(user.uid, { passwordHash: "" });
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  }
);
