// The one way Blot's own code changes a blog's folder.
//
// When Blot itself writes or removes a file in a blog's folder (a template,
// a preview file, a file uploaded in the dashboard), the change must go
// through the blog's sync client, so the provider (Dropbox, Google Drive,
// iCloud, Git) and the client's own records see it. Every client's write and
// remove also change Blot's copy of the folder, so there is no need to touch
// storage/folder as well.
//
// A blog with no client (or one whose client is not available here) has no
// provider to tell, so its folder is changed directly through storage/folder.
//
// Pass either a blog ID or an already-loaded blog, which saves a lookup.
// Contents are a string or Buffer. Reads do not go through here: read the
// folder with storage/folder.
//
// scripts/tests/ci/check-folder-access.js fails if other code calls the
// mutating methods of storage/folder directly.

const { promisify } = require("util");

// Required lazily: clients load models/blog, which loads clients, and tests
// swap these modules out.
const getBlog = promisify((id, cb) =>
  require("models/blog").get({ id }, cb)
);

async function resolve(blog) {
  if (blog && typeof blog === "object") {
    if (!blog.id) throw new Error("Blog has no id");
    return blog;
  }

  const loaded = await getBlog(blog);
  if (!loaded) throw new Error("No blog with ID " + blog);
  return loaded;
}

function clientFor(blog) {
  return (blog.client && require("clients")[blog.client]) || null;
}

async function write(blog, path, contents) {
  blog = await resolve(blog);
  const client = clientFor(blog);

  if (!client) return require("storage/folder").write(blog.id, path, contents);

  return promisify(client.write)(blog.id, path, contents);
}

// Like write, from a file on disk. A blog with no client has the file copied
// straight in, which never holds it in memory; a client is handed the
// contents, so it is read into a Buffer. The source stays the caller's.
async function writeFrom(blog, path, sourcePath) {
  blog = await resolve(blog);
  const client = clientFor(blog);

  if (!client)
    return require("storage/folder").writeFrom(blog.id, path, sourcePath);

  const contents = await require("fs-extra").readFile(sourcePath);
  await promisify(client.write)(blog.id, path, contents);
}

async function remove(blog, path) {
  blog = await resolve(blog);
  const client = clientFor(blog);

  if (!client) return require("storage/folder").remove(blog.id, path);

  return promisify(client.remove)(blog.id, path);
}

module.exports = { write, writeFrom, remove };
