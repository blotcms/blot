// Local (development container) half of `npm run fork`.
//
//   node scripts/development/fork create <handle> < settings.json
//     Creates a blog on example@example.com with the given handle (or the
//     first free variant of it), applies the production settings JSON read
//     from stdin (see scripts/blog/export-settings) and prints blogID=... and
//     handle=... lines.
//
//   node scripts/development/fork finish <blogID> [templateSlug]
//     Rebuilds the blog from its folder, builds the folder's templates, and
//     if a template slug is passed, switches the blog to that template, then
//     starts the folder watcher and prints url=...

var User = require("models/user");
var Blog = require("models/blog");
var Template = require("models/template");
var validate = require("models/blog/validate/handle");
var rebuild = require("sync/rebuild");
var client = require("models/client");
var config = require("config");
var fs = require("fs-extra");

// app/clients/local/init.js listens here to start watching a new folder
var LOCAL_CLIENT_CHANNEL = "clients:local:new-folder";

var EMAIL = "example@example.com";

function done(err) {
  if (err) {
    console.error("Error:", err.message);
    process.exit(1);
  }
  process.exit();
}

async function freeHandle(base, attempt) {
  var candidate = attempt ? base + attempt : base;

  try {
    return await validate("", candidate);
  } catch (err) {
    if (attempt >= 50) throw err;
    return freeHandle(base, attempt + 1);
  }
}

async function create(base, settings) {
  var user = await User.getByEmail(EMAIL).catch(function () {});

  if (!user) {
    throw new Error(
      EMAIL + " not found — start the local server first (npm start)"
    );
  }

  var handle = await freeHandle(
    base.toLowerCase().replace(/[^a-z0-9]/g, ""),
    0
  );
  var blog = await Blog.create(user.uid, { handle: handle });

  // Production settings first, then the same overrides
  // app/configure-local-blogs.js gives local blogs
  var changes = Object.assign({}, settings, {
    forceSSL: false,
    client: "local",
  });

  await Blog.set(blog.id, changes);

  console.log("blogID=" + blog.id);
  console.log("handle=" + blog.handle);
}

async function finish(blogID, slug) {
  // The folder was copied into the Local client's source directory; copy it
  // from there into the blog's folder, then rebuild
  await require("clients/local/setup").reconcileSource(blogID);
  await rebuild(blogID, {});

  // rebuild skips /Templates, so build the folder's templates explicitly
  await Template.buildFromFolder(blogID);

  if (slug) await activate(blogID, slug);

  await watch(blogID);
}

// Only after the folder is fully copied and built: the watcher ignores
// existing files, and starting it earlier races with the rsync and rebuild.
// It must start in the master process, which only hears about new folders
// through this channel (payload must be JSON).
async function watch(blogID) {
  await client.publish(
    LOCAL_CLIENT_CHANNEL,
    JSON.stringify({ blogID: blogID })
  );

  var blog = await Blog.get({ id: blogID });

  console.log("url=https://" + blog.handle + "." + config.host);
}

async function activate(blogID, slug) {
  var templateID = Template.makeID(blogID, slug);
  var template;

  try {
    template = await Template.getMetadata(templateID);
  } catch (err) {}

  if (!template) {
    throw new Error("Template " + templateID + " was not built");
  }

  await Blog.set(blogID, { template: templateID });
}

async function readSettings() {
  var input = await fs.readFile(0, "utf-8");

  try {
    return input.trim() ? JSON.parse(input) : {};
  } catch (e) {
    throw new Error("Settings on stdin are not valid JSON", { cause: e });
  }
}

async function main() {
  var command = process.argv[2];

  if (command === "create" && process.argv[3]) {
    await create(process.argv[3], await readSettings());
  } else if (command === "finish" && process.argv[3]) {
    await finish(process.argv[3], process.argv[4]);
  } else {
    throw new Error(
      "Usage: fork create <handle> | fork finish <blogID> [slug]"
    );
  }
}

main().then(() => done(), done);
