// Records, for every blog on the git client, the commit its entries were last
// built from (clients/git/database: getApplied), starting each blog's next sync
// from where its live clone is now. Run it once after deploying the code that
// reads the commit; until a blog has one, its syncs diff from the clone's HEAD
// before the pull, as they always did, so there is no hurry.
//
// Older code kept the paths that a Redis outage kept it from applying in
// .git/blot-unapplied-paths.json in the live clone, and the current code does
// not read that file. For a blog that has one, with --write this applies those
// paths first (under the blog's sync lock, like a sync), then deletes the file.
// If any path fails, the file is left and the blog is not seeded: run it again.
//
// Default is a dry run. The commit is set with SET NX, so the script never
// replaces a commit that a sync has recorded, and it is safe to run again.
//
// Usage:
//   node scripts/git/seed-applied-commit.js [--write] [blog-identifier]
//
// Runs unattended: no confirmation prompt, even across all blogs. Exits 1 if
// any blog failed.

const write = process.argv.slice(2).includes("--write");
process.argv = process.argv.filter((arg, i) => i < 2 || arg !== "--write");

const fs = require("fs-extra");
const { promisify } = require("util");
const storage = require("storage/folder");
const Git = require("clients/git/git");
const database = require("clients/git/database");
const Sync = require("sync");
const { isRedisUnavailableError } = require("helper/redisUnavailable");
const eachBlogOrOneBlog = require("../each/eachBlogOrOneBlog");

const getApplied = promisify(database.getApplied);
const setAppliedIfMissing = promisify(database.setAppliedIfMissing);

const counts = {
  gitBlogs: 0,
  seeded: 0,
  alreadySet: 0,
  noClone: 0,
  withPendingPaths: 0,
  appliedPaths: 0,
  failed: 0,
};

const label = (blog) => `${blog.handle || "no handle"} ${blog.id}`;

// Resolves to [] when there is no file. Rejects if it cannot be read, because
// carrying on as if nothing were waiting would lose those paths.
async function readPending(file) {
  try {
    const paths = await fs.readJson(file);
    if (!Array.isArray(paths)) throw new Error("not a list");
    return paths;
  } catch (err) {
    if (err.code === "ENOENT") return [];
    throw new Error(`Cannot read ${file}: ${err.message}`);
  }
}

// Applies the waiting paths and seeds the commit under the blog's sync lock,
// so a sync cannot move HEAD in between. Rejects if a path could not be applied.
function seedLocked(blog, pending, file, head) {
  return new Promise((resolve, reject) => {
    Sync(blog.id, async function (err, folder, done) {
      if (err) return reject(err);

      let result;

      try {
        // In series, like a sync
        for (const path of pending) {
          try {
            await promisify(folder.update.bind(folder))(path);
          } catch (err) {
            // As in a sync, only Redis being unavailable stops the rest
            if (isRedisUnavailableError(err)) throw err;
            console.error(`${label(blog)}: ${path}: ${err.message}`);
          }
        }

        await fs.remove(file);
        await fs.remove(file + ".tmp");
        await setAppliedIfMissing(blog.id, head);
      } catch (error) {
        result = error;
      }

      done(result, function () {
        result ? reject(result) : resolve();
      });
    });
  });
}

async function seed(blog) {
  if (blog.client !== "git") return;

  counts.gitBlogs++;

  const directory = await storage.path(blog.id, "/");
  const file = directory + "/.git/blot-unapplied-paths.json";

  if (!(await fs.pathExists(directory + "/.git"))) {
    counts.noClone++;
    console.log(`${label(blog)}: no live clone, skipped`);
    return;
  }

  const pending = await readPending(file);
  const applied = await getApplied(blog.id);

  if (applied && !pending.length) {
    counts.alreadySet++;
    return;
  }

  const head = (await Git(directory).raw(["rev-parse", "HEAD"])).trim();

  if (pending.length) {
    counts.withPendingPaths++;
    console.log(
      `${label(blog)}: ${pending.length} paths left by an earlier sync` +
        (write ? ", applying" : "")
    );
  }

  if (!write) {
    if (!applied) console.log(`${label(blog)}: would record ${head}`);
    return;
  }

  await seedLocked(blog, pending, file, head);

  counts.appliedPaths += pending.length;
  if (!applied) counts.seeded++;
  console.log(`${label(blog)}: recorded ${head}`);
}

eachBlogOrOneBlog(
  async (blog) => {
    try {
      await seed(blog);
    } catch (err) {
      counts.failed++;
      console.error(`${label(blog)}: failed: ${err.message}`);
    }
  },
  { confirm: false }
)
  .catch((err) => {
    counts.failed++;
    console.error(err.message);
  })
  .then(() => {
    console.log(write ? "Done." : "Dry run, nothing written. Use --write.");
    console.log(counts);
    process.exit(counts.failed ? 1 : 0);
  });
