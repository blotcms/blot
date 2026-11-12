// Development only: keeps a blog whose handle matches a folder in
// app/templates/folders in step with it. The files come through the Local
// client, which is pointed at the folder in the checkout (see sourceFor,
// used by clients/local/source.js) instead of data/local-sources. The settings
// (title, template, menu, plugins) come from ./config.js, applied at start
// and again whenever that file changes. Only blogs which already exist are
// touched; `npm run folder` is what creates them.

const fs = require("fs");
const { join } = require("path");
const chokidar = require("chokidar");
const isEqual = require("lodash/isEqual");
const config = require("config");
const Blog = require("models/blog");
const clfdate = require("helper/clfdate");
const { settingsFor } = require("./setupBlogs");

const DIR = join(__dirname);
const prefix = () => clfdate() + " Demo folders:";

// The source folder for a handle, or undefined: not in development, or no
// such folder (names starting with . or - are not folders, as in index.js)
function sourceFor(handle) {
  if (config.environment !== "development") return;
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_]*$/.test(String(handle || ""))) return;

  const path = join(DIR, handle);
  try {
    if (fs.statSync(path).isDirectory()) return path;
  } catch (err) {
    return;
  }
}

function handles() {
  return fs
    .readdirSync(DIR, { withFileTypes: true })
    .filter((item) => item.isDirectory() && sourceFor(item.name))
    .map((item) => item.name);
}

// Sets each existing matching blog's settings from config.js, and puts it on
// the Local client, whose watcher then keeps its files in step. Only what
// differs is written, so a restart doesn't flush every blog's cache.
async function apply({ reload } = {}) {
  for (const handle of handles()) {
    const blog = await Blog.get({ handle });
    if (!blog) continue;

    const wanted = { ...settingsFor(blog, { reload }), client: "local" };
    const changed = Object.keys(wanted).filter(
      (key) => !isEqual(wanted[key], blog[key])
    );
    if (!changed.length) continue;

    const update = {};
    for (const key of changed) update[key] = wanted[key];
    await Blog.set(blog.id, update);
    console.log(prefix(), handle + ":", "updated", changed.join(", "));
  }
}

// Call before the Local client starts, so it finds these blogs on it. Resolves
// once the settings are applied; then watches config.js for edits.
async function start() {
  if (config.environment !== "development") return;

  await apply();

  let timer;
  chokidar
    .watch(join(DIR, "config.js"), { ignoreInitial: true })
    .on("all", () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        apply({ reload: true }).catch((err) =>
          console.error(prefix(), "Unable to apply config.js", err)
        );
      }, 100);
    });
}

module.exports = { start, apply, sourceFor };
