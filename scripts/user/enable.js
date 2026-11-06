var User = require("models/user");
var get = require("../get/user");

var handle = process.argv[2];

if (!handle) throw "Please pass the user's handle as an argument.";

function getUser(handle) {
  return new Promise(function (resolve, reject) {
    get(handle, function (err, user) {
      if (err || !user) return reject(err || "No user");
      resolve(user);
    });
  });
}

async function run() {
  var user = await getUser(handle);

  await new Promise(function (resolve, reject) {
    User.enable(user, function (err) {
      if (err) return reject(err);
      resolve();
    });
  });

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
