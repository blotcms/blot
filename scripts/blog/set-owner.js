var get = require("../get/blog");
var Blog = require("models/blog");
var User = require("models/user");

async function main() {
  console.log("Switching blog", process.argv[2], "to user", process.argv[3]);

  const blog = await new Promise((resolve, reject) => {
    get(process.argv[2], (err, user, blog) =>
      err ? reject(err) : resolve(blog)
    );
  });

  // A failed lookup is ignored, so newOwner is undefined and the next line
  // throws, as it always has
  let newOwner;
  try {
    newOwner = await User.getById(process.argv[3]);
  } catch (err) {}

  newOwner.blogs.push(blog.id);

  // A failed User.set is ignored, as before
  try {
    await User.set(newOwner.uid, { blogs: newOwner.blogs });
  } catch (err) {}

  await Blog.set(blog.id, { owner: newOwner.uid });

  console.log("Stored", newOwner.uid, "as owner of", blog.id);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
