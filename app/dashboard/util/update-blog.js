const Blog = require("models/blog");

module.exports = (blogID, updates) => {
  return new Promise((resolve, reject) => {
    Blog.set(blogID, updates, function (errors, changes) {
      if (errors) {
        for (var i in errors)
          if (errors[i] instanceof Error) return reject(errors[i]);

        reject(errors);
      } else {
        resolve(changes);
      }
    });
  });
};
