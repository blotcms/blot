var User = require("models/user");
var get = require("../get/user");

var handle = process.argv[2];

if (!handle) throw "Please pass the user's handle as an argument.";

get(handle, function (err, user) {
  if (err || !user) throw err || "No user";

  User.enable(user, function (err) {
    if (err) throw err;

    console.log(
      user.email + "'s blot account (" + user.uid + ") has been enabled"
    );
    process.exit();
  });
});
