var Blog = require("models/blog");
var getConfirmation = require("../util/getConfirmation");

// A failed lookup counts as no match
async function lookup(by) {
  try {
    return await Blog.get(by);
  } catch (err) {
    return undefined;
  }
}

// We don't use get() since it throws an error if the user does not
// exist and sometimes with want to be able to clean up blogs
async function main() {
  const blogFromHandle = await lookup({ handle: process.argv[2] });
  const blogFromDomain = await lookup({ domain: process.argv[2] });
  const blogFromID = await lookup({ id: process.argv[2] });

  var blog = blogFromID || blogFromHandle || blogFromDomain;

  if (!blog || !blog.id) throw new Error("No blog: " + process.argv[2]);

  const ok = await getConfirmation(
    "Delete " + blog.id + " " + blog.handle + "? (y/N)"
  );

  if (!ok) throw new Error("Not ok!");

  await Blog.remove(blog.id);
  console.log("Deleted", blog.id, blog.handle);
  process.exit();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
