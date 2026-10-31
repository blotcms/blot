// Runs inside the Blot app container (which sets NODE_PATH so "models/blog"
// resolves), like seed-blog.js. Usage:
//
//   node seed-git.js <owner-email> [handle]
//   node seed-git.js rename <blogID> <new-handle>
//
// First form: creates a blog owned by the given user, connects it to the git
// client and runs the same repository setup the dashboard's create route runs
// (app/clients/git/routes.js: set client "git", then clients/git/create),
// waiting for it to finish. The blog's folder holds one post first, so the
// repository is created with something in it. Prints a single line,
// SEED_GIT_RESULT={"handle":"...","host":"...","blogID":"...","email":"...",
// "token":"..."}, which the workflow greps (other libraries log freely to
// stdout) and hands to proxy/e2e/git-checks.js. The token is the throwaway
// CI user's; it means nothing outside the job.
//
// Second form: changes a git blog's handle the way the dashboard does
// (models/blog/set, which also moves the repository), for the handle-rename
// check in git-checks.js.
//
// Only core modules and NODE_PATH-resolved app modules - the script is copied
// to /tmp inside the container, so it cannot see the app's node_modules.
const { promisify } = require("util");
const fs = require("fs");
const path = require("path");

const User = require("models/user");
const Blog = require("models/blog");
const setBlog = promisify(require("models/blog/set"));
const localPath = require("helper/localPath");
const config = require("config");
const gitDatabase = require("clients/git/database");

const POST_TITLE = "Seeded git post";

async function rename(blogID, newHandle) {
  if (!blogID || !newHandle) throw new Error("usage: rename <blogID> <handle>");
  await setBlog(blogID, { handle: newHandle, client: "git" });
  console.log("SEED_GIT_RENAMED=" + JSON.stringify({ blogID, handle: newHandle }));
}

async function seed(email, handle) {
  const user = await promisify(User.getByEmail)(email);
  if (!user) throw new Error("no user found for " + email);

  const created = await new Promise((resolve, reject) => {
    Blog.create(user.uid, { handle }, (err, blog) => {
      if (err) return reject(new Error(err.handle || JSON.stringify(err)));
      resolve(blog);
    });
  });

  // Same as the dashboard's create route: connect the client, then set the
  // repository up.
  await promisify(Blog.set)(created.id, { client: "git" });
  const blog = await promisify(Blog.get)({ id: created.id });

  const post =
    [
      "Title: " + POST_TITLE,
      "Date: 2020-01-01",
      "",
      "This repository was created by the real git client setup.",
    ].join("\n") + "\n";

  const postPath = localPath(blog.id, "/seeded.txt");
  await fs.promises.mkdir(path.dirname(postPath), { recursive: true });
  await fs.promises.writeFile(postPath, post);

  // Resolves when the repository is complete (the callback create.js gives
  // the sync lock's done).
  await promisify(require("clients/git/create"))(blog);

  const token = await promisify(gitDatabase.getToken)(blog.owner);
  if (!token) throw new Error("no git token after create");

  console.log(
    "SEED_GIT_RESULT=" +
      JSON.stringify({
        handle: blog.handle,
        host: blog.handle + "." + config.host,
        blogID: blog.id,
        email,
        token,
        title: POST_TITLE,
      })
  );
}

(async () => {
  if (process.argv[2] === "rename") {
    await rename(process.argv[3], process.argv[4]);
  } else {
    const email = process.argv[2];
    if (!email) {
      console.error(
        "usage: node seed-git.js <owner-email> [handle] | rename <blogID> <handle>"
      );
      process.exit(1);
    }
    await seed(email, process.argv[3] || "e2egit");
  }
  process.exit(0);
})().catch((err) => {
  console.error("seed-git failed:", err);
  process.exit(1);
});
