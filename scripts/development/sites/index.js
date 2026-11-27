// Development only: sets up and tears down the local test sites. Run in the
// dev container through `npm run folder` (scripts/development/folder.sh).
//
//   node scripts/development/sites up [handle...]
//     Builds the demo folder sites (app/templates/folders) and the test sites
//     below. Each test site's module generates its files into its Local
//     client source directory, data/local-sources/{handle}, mostly from the
//     demo folders' material (see material.js). Only files that changed are
//     rewritten, so running it again is cheap. A new blog gets the module's
//     template; an existing one keeps whatever template it was switched to.
//     With handles, only those test sites (no demo folders).
//
//   node scripts/development/sites down [handle...]
//     Deletes the demo folder blogs and the test site blogs, and the test
//     sites' generated source directories. The demo folders themselves are
//     in the checkout and are left alone, as is every other blog, including
//     the scratchpad blog, local.

const fs = require("fs-extra");
const { join, relative } = require("path");
const config = require("config");
const Blog = require("models/blog");
const client = require("models/client");
const setupUser = require("templates/demo/setupUser");
const source = require("clients/local/source");
const material = require("./material");
const setProfileImage = require("./profile-image");

// app/clients/local/init.js listens here to start watching a blog's source
const LOCAL_CLIENT_CHANNEL = "clients:local:new-folder";

// The scratchpad blog. Never built, never removed.
const SCRATCHPAD = "local";

// Each test site is a module next to this file exporting { settings, build },
// except empty, which has no files and no title, for templates' empty states.
const SITES = {
  empty: {
    settings: { title: "", template: "SITE:blog" },
    build: async () => {},
  },
  tiny: "./tiny",
  huge: "./huge",
  torture: "./torture",
  arabic: "./arabic",
  japanese: "./japanese",
};

function load(handle) {
  const site = SITES[handle];
  if (typeof site !== "string") return site;
  try {
    return require(site);
  } catch (err) {
    console.warn("Skipping", handle + ":", "unable to load", site, err.message);
  }
}

function demoFolderHandles() {
  return fs
    .readdirSync(material.FOLDERS, { withFileTypes: true })
    .filter((item) => item.isDirectory() && /^[a-z0-9]/i.test(item.name))
    .map((item) => item.name);
}

// Every file and directory under dir, as paths relative to it
async function entries(dir) {
  const files = new Map();
  const dirs = new Set();
  async function visit(path) {
    for (const item of await fs.readdir(path, { withFileTypes: true })) {
      const full = join(path, item.name);
      const rel = relative(dir, full);
      if (item.isDirectory()) {
        dirs.add(rel);
        await visit(full);
      } else {
        files.set(rel, full);
      }
    }
  }
  if (await fs.pathExists(dir)) await visit(dir);
  return { files, dirs };
}

const sameBytes = async (a, b) =>
  (await fs.readFile(a)).equals(await fs.readFile(b));

// Makes dir match built: copies new and changed files, removes the rest.
// Writing only what changed keeps the Local client's watcher quiet on a re-run.
async function mirror(built, dir) {
  await fs.ensureDir(dir);
  const want = await entries(built);
  const have = await entries(dir);
  let changed = 0;

  for (const [rel, path] of want.files) {
    const target = join(dir, rel);
    if (have.files.has(rel) && (await sameBytes(path, target))) continue;
    await fs.ensureDir(join(target, ".."));
    await fs.copy(path, target);
    changed++;
  }

  for (const rel of want.dirs) await fs.ensureDir(join(dir, rel));

  for (const rel of have.files.keys()) {
    // Blot writes a preview file beside each draft (sync/update/drafts.js)
    if (want.files.has(rel) || rel.endsWith(".preview.html")) continue;
    await fs.remove(join(dir, rel));
    changed++;
  }

  // Deepest first, so a directory is empty by the time it's checked
  const extraDirs = [...have.dirs]
    .filter((rel) => !want.dirs.has(rel))
    .sort((a, b) => b.length - a.length);
  for (const rel of extraDirs) await fs.remove(join(dir, rel));

  return changed;
}

async function upSite(user, handle) {
  const site = load(handle);
  if (!site) return;

  let blog = await Blog.get({ handle });

  if (blog && blog.owner !== user.uid) {
    console.warn("Skipping", handle + ":", "owned by another account");
    return;
  }

  const dir = join(source.base(), handle);
  const built = dir + ".building";

  // Built beside the source directory, then mirrored into it. A build that
  // fails leaves the site as it was.
  await fs.emptyDir(built);
  try {
    await site.build(built);
    const changed = await mirror(built, dir);
    console.log("Built", handle + ":", changed, "files changed");
  } catch (err) {
    console.error("Unable to build", handle + ":", err);
    return;
  } finally {
    await fs.remove(built);
  }

  const { template, ...settings } = site.settings || {};

  if (!blog) {
    blog = await Blog.create(user.uid, { handle });
    if (template) settings.template = template;
    console.log("Created blog", handle);
  }

  // The source directory exists by now, so the Local client reconciles the
  // blog against it rather than seeding it from the blog's folder.
  await Blog.set(blog.id, { ...settings, forceSSL: false, client: "local" });
  await setProfileImage(await Blog.get({ id: blog.id }));
  await client.publish(
    LOCAL_CLIENT_CHANNEL,
    JSON.stringify({ blogID: blog.id })
  );

  console.log("https://" + handle + "." + config.host);
}

async function up(handles) {
  const { user, url } = await setupUser();

  if (!handles.length) {
    // The demo folder build puts their blogs on no client while it syncs
    // them; apply() puts them back on the Local client, and the message
    // starts each one's watcher in the running server
    await require("templates/demo")();
    await require("templates/demo/local").apply();
    for (const handle of demoFolderHandles()) {
      const blog = await Blog.get({ handle });
      if (blog && blog.owner === user.uid) await setProfileImage(blog);
      if (blog && blog.owner === user.uid && blog.client === "local") {
        await client.publish(
          LOCAL_CLIENT_CHANNEL,
          JSON.stringify({ blogID: blog.id })
        );
      }
    }
    handles = Object.keys(SITES);
  }

  for (const handle of handles) {
    if (handle === SCRATCHPAD) continue;
    if (!SITES[handle]) {
      console.warn("No test site called", handle);
      continue;
    }
    await upSite(user, handle);
  }

  if (url) console.log("Dashboard:\n" + url);
}

async function down(only) {
  const { user } = await setupUser();
  const all = [...new Set([...demoFolderHandles(), ...Object.keys(SITES)])];
  const handles = (only.length ? all.filter((h) => only.includes(h)) : all)
    .filter((handle) => handle !== SCRATCHPAD)
    .sort();

  for (const handle of handles) {
    const blog = await Blog.get({ handle });

    if (blog && blog.owner !== user.uid) {
      // Its source directory is that blog's too, so leave both alone
      console.warn("Leaving", handle + ":", "owned by another account");
      continue;
    }

    if (blog) {
      await Blog.remove(blog.id);
      console.log("Removed blog", handle);
    }

    // Only the test sites' source directories are generated. A demo folder's
    // source is the folder in the checkout.
    if (SITES[handle]) await fs.remove(join(source.base(), handle));
  }

  const left = [];
  for (const blogID of user.blogs || []) {
    const blog = await Blog.get({ id: blogID });
    if (blog && !handles.includes(blog.handle)) left.push(blog.handle);
  }
  if (left.length && !only.length)
    console.log("Left in place:", left.sort().join(", "));
}

async function main() {
  const [command = "up", ...handles] = process.argv.slice(2);
  if (command === "up") return up(handles);
  if (command === "down") return down(handles);
  throw new Error(
    "Usage: node scripts/development/sites [up|down] [handle...]"
  );
}

if (config.environment !== "development") {
  console.error("The test sites are for development only");
  process.exit(1);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
