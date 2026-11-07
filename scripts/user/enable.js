var User = require("models/user");
var get = require("../get/user");

var handle = process.argv[2];

if (!handle) throw "Please pass the user's handle as an argument.";

async function getUser(handle) {
  const { user } = await get(handle);
  if (!user) throw "No user";
  return user;
}

async function run() {
  var user = await getUser(handle);

  await User.enable(user);

  console.log(
    user.email + "'s blot account (" + user.uid + ") has been enabled"
  );
  process.exit();
}

run().then(
  function () {
    process.exit(0);
  },
  function (err) {
    console.error(err);
    process.exit(1);
  }
);
