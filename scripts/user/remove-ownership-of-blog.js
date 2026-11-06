var userID = process.argv[2];
var blogID = process.argv[3];

if (!userID) throw new Error("Please pass userID as first argument");
if (!blogID) throw new Error("Please pass blogID as second argument");

var User = require("models/user");
var { promisify } = require("util");

async function main() {
  var user = await User.getById(userID);

  if (!user) throw new Error("No user with userID " + userID);

  if (user.blogs.indexOf(blogID) === -1)
    throw new Error("User " + userID + " does not have blog " + blogID);

  var before = user.blogs.slice();

  user.blogs = user.blogs.filter(function (otherBlogID) {
    return otherBlogID !== blogID;
  });

  console.log("BEFORE", before, "AFTER", user.blogs);

  await promisify(User.set)(userID, { blogs: user.blogs });

  console.log(
    "Warning! This will not affect the user's subscription settings to make sure to adjust their bill"
  );
  console.log("Done!");
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  }
);
