const Blog = require("models/blog");

module.exports = async (blogID, updates) => {
  let changes;

  try {
    changes = await Blog.set(blogID, updates);
  } catch (errors) {
    for (var i in errors) if (errors[i] instanceof Error) throw errors[i];

    throw errors;
  }

  return changes;
};
