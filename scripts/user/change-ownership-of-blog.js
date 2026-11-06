var blogID = process.argv[2];
var addToUserID = process.argv[3];

var User = require("models/user");

var getUser = require("../get/user");
var getBlog = require("../get/blog");

if (!blogID) throw new Error("Please pass blog identifier as first argument");
if (!addToUserID)
  throw new Error(
    "Please pass user identifer to move the blog to as second argument"
  );

function findBlog(identifier) {
  return new Promise(function (resolve, reject) {
    getBlog(identifier, function (err, user, blog, url) {
      if (err || !user || !blog)
        return reject(err || new Error("No blog with identifer " + identifier));

      resolve({ user: user, blog: blog, url: url });
    });
  });
}

function setBlogs(uid, blogs) {
  return new Promise(function (resolve, reject) {
    User.set(uid, { blogs: blogs }, function (err) {
      if (err) return reject(err);
      resolve();
    });
  });
}

async function main() {
  var found = await findBlog(blogID);
  var user = found.user;
  var blog = found.blog;
  var url = found.url;

  var newOwner = await new Promise(function (resolve, reject) {
    getUser(addToUserID, function (err, newOwnerUser, newOwnerURL) {
      if (err || !user)
        return reject(
          err || new Error("No user with identifer " + addToUserID)
        );

      resolve({ user: newOwnerUser, url: newOwnerURL });
    });
  });
  var newOwnerUser = newOwner.user;
  var newOwnerURL = newOwner.url;

  if (user.blogs.indexOf(blog.id) === -1)
    throw new Error("User does not own this blog");

  if (newOwnerUser.blogs.indexOf(blog.id) !== -1)
    throw new Error("New user already owns this blog");

  // Remove blog from list of blogs controlled by existing owner
  user.blogs = user.blogs.filter(function (otherBlogID) {
    return otherBlogID !== blog.id;
  });

  // Add blog to list of blogs controlled by new owner
  newOwnerUser.blogs.push(blog.id);

  await setBlogs(user.uid, user.blogs);
  await setBlogs(newOwnerUser.uid, newOwnerUser.blogs);

  console.log("Migration complete!");
  console.log("Dashboard for:", user.email, url);
  console.log("Dashboard for:", newOwnerUser.email, newOwnerURL);
  console.log("");
  console.log("Warning!");
  console.log("This did not affect the user's subscription settings");
  console.log("Make sure to adjust their bill");

  process.exit();
}

main().then(
  function () {
    process.exit(0);
  },
  function (err) {
    console.error(err);
    process.exit(1);
  }
);
