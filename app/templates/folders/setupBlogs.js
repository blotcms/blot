const { promisify } = require("util");

const Blog = require("models/blog");
const setBlog = promisify(Blog.set);
const getBlog = promisify(Blog.get);
const createBlog = promisify(Blog.create);

const config = require("./config");
const basename = require("path").basename;

module.exports = async function setupBlogs(user, folders) {
  const blogs = {};

  // Create/get blogs
  for (const path of folders) {
    const handle = basename(path);

    console.log('Setting up', handle);

    let blog = await getBlog({ handle });

    if (blog && blog.owner !== user.uid) {
      throw new Error(`${blog.handle} owned by another user`);
    }

    if (!blog) {
      console.log('Creating blog', handle);
      blog = await createBlog(user.uid, { handle });
    }

    const update = { ...(config[blog.handle] || {}) };

    if (update.plugins) {
      update.plugins = {...blog.plugins, ...update.plugins};
    }

    if (update.menu) {
      update.menu = mergeMenu(update.menu, blog.menu);
    }

    await setBlog(blog.id, { ...update, client: "" });

    blogs[blog.id] = { path, blog };
  }

  return blogs;
};

// The config decides which pages are in the menu and in what order, but each
// item's label, url and metadata are copied from its page entry by sync/fix.
// Keep those from the existing menu so rebuilding on every boot doesn't reset
// them and make Fix() report (and email about) the same repair each deploy.
function mergeMenu(configMenu, existingMenu = []) {
  return configMenu.map((item) => {
    const existing = existingMenu.find((other) => other.id === item.id);
    if (!existing) return item;
    const { label, url, metadata } = existing;
    return { ...item, label, url, metadata };
  });
}
