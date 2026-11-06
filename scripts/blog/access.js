var Blog = require("models/blog");
var User = require("models/user");
var format = require("url").format;
var config = require("../../config");

if (require.main === module) {
  cli().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

async function cli() {
  // A failed lookup is ignored: the argument is used as given
  const blog = await new Promise((resolve) => {
    require("../get/blog")(process.argv[2], (err, user, blog) => resolve(blog));
  });

  const url = await lookup((blog && blog.handle) || process.argv[2]);
  console.log(url);
  process.exit();
}

async function lookup(handle) {
  const userID = await User.getById(handle);
  const userEmail = await User.getByEmail(handle);
  const blog = await Blog.get({ handle: handle });

  const uid =
    (userEmail && userEmail.uid) ||
    (userID && userID.uid) ||
    (blog && blog.owner);

  if (!uid) throw new Error("No user with identifier " + handle);

  const token = await User.generateAccessToken({ uid });

  // The full one-time log-in link to be sent to the user
  return format({
    protocol: "https",
    host: config.host,
    pathname: "/sites/log-in",
    query: {
      token: token,
    },
  });
}

// Callback API, kept for get/blog, get/user, info, overdue-subscription and
// create, which pass a callback (or promisify this)
function main(handle, callback) {
  lookup(handle).then(
    (url) => callback(null, url),
    (err) => callback(err)
  );
}

module.exports = main;
