var getConfirmation = require("../util/getConfirmation");
var Blog = require("models/blog");
var User = require("models/user");
var validate = require("models/blog/validate/handle");
var access = require("./access");
var { promisify } = require("util");

if (require.main === module) {
  main(process.argv[2], process.argv[3]).then(
    () => process.exit(),
    (err) => {
      console.error("Error:", err.message);
      process.exit(1);
    }
  );
}

async function main(email, handle) {
  if (!email) {
    throw new Error("Pass email of user to add new blog to as first argument");
  }

  if (!handle) {
    throw new Error("Pass handle for new blog as second argument");
  }

  handle = await promisify(validate)("", handle);

  let user;
  try {
    user = await User.getByEmail(email);
  } catch (err) {
    user = null;
  }

  if (!user) {
    throw new Error("No user with email " + email + " found in database");
  }

  var message =
    "Email: " +
    user.email +
    "\nUser ID: " +
    user.uid +
    "\nHandle: " +
    handle +
    "\n\nCreate blog " +
    handle +
    "? (y/N)";

  const ok = await getConfirmation(message);
  if (!ok) throw new Error("User was not created");

  await Blog.create(user.uid, { handle: handle });

  const url = await promisify(access)(handle);

  console.log("Added new blog", handle, "to", email, ":");
  console.log(url);
}

module.exports = main;
