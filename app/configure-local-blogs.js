const User = require("models/user");
const Blog = require("models/blog");
const config = require("config");
const format = require("url").format;

const email = "example@example.com";
const password = "password";

function establishTestUser() {
  return new Promise((resolve, reject) => {
    User.getByEmail(email, function (err, user) {
      if (err) return reject(err);
      if (user) return resolve(user);
      User.hashPassword(password, function (err, passwordHash) {
        if (err) return reject(err);
        User.create(email, passwordHash, {}, {}, function (err, newUser) {
          if (err) return reject(err);
          resolve(newUser);
        });
      });
    });
  });
}

function establishTestBlog(user) {
  return new Promise((resolve, reject) => {
    if (user.blogs.length > 0) return resolve(user);

    Blog.create(user.uid, { handle: "example" }, (err, blog) => {
      if (err) return reject(err);
      user.blogs.push(blog.id);
      resolve(user);
    });
  });
}

const configureBlog = (blogID) => {
  return new Promise((resolve, reject) => {
    Blog.get({ id: blogID }, (err, blog) => {
      if (err) return reject(err);

      const client = !blog.client ? "local" : blog.client;

      Blog.set(blogID, { forceSSL: false, client }, (err) => {
        if (err) return reject(err);
        resolve(blog);
      });
    });
  });
};

function configureBlogs(user) {
  return new Promise((resolve, reject) => {
    const configureAllBlogs = async () => {
      let blog;

      for (const blogID of user.blogs) {
        blog = await configureBlog(blogID);
      }

      return blog;
    };

    configureAllBlogs()
      .then((blog) => {
        User.generateAccessToken({ uid: user.uid }, (err, token) => {
          if (err) return reject(err);

          const url = format({
            protocol: "https",
            host: config.host,
            pathname: "/sites/log-in",
            query: { token: token },
          });

          console.log("Local server capabilities:");
          console.log("- markdown with pandoc  " + !!config.pandoc.bin);
          console.log("- .docx conversion  " + !!config.pandoc.bin);
          console.log("- .odt conversion  " + !!config.pandoc.bin);
          console.log("- dropbox client " + !!config.dropbox.app.key);
          console.log(
            "- persistent dashboard sessions  " + !!config.session.secret
          );

          console.log();
          console.log(`Visit your dashboard:`);
          console.log(url);
          console.log();

          console.log(`Visit your blog:`);
          console.log(`https://${blog.handle}.${config.host}`);
          console.log();

          console.log(`Open your blog's folder:`);
          console.log("./data/local-sources/" + blog.handle);
          console.log();

          resolve(user);
        });
      })
      .catch(reject);
  });
}

const main = async function () {
  const user = await establishTestUser();
  await establishTestBlog(user);
  await configureBlogs(user);
};

module.exports = config.environment === "development" ? main : () => {};
