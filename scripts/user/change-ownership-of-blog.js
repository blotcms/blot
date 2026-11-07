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

async function findBlog(identifier) {
  const { user, blog, url } = await getBlog(identifier);

  if (!user || !blog) throw new Error("No blog with identifer " + identifier);

  return { user: user, blog: blog, url: url };
}

async function setBlogs(uid, blogs) {
  await User.set(uid, { blogs: blogs });
}

async function main() {
  var found = await findBlog(blogID);
  var user = found.user;
  var blog = found.blog;
  var url = found.url;

  var newOwner = await getUser(addToUserID);

  if (!user) throw new Error("No user with identifer " + addToUserID);

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
