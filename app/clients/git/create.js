const database = require("./database");
const storage = require("storage/folder");
const clfdate = require("helper/clfdate");
const sync = require("sync");

function delay(ms) {
  return new Promise(function (resolve) {
    setTimeout(resolve, ms);
  });
}

// Sets up a blog's repository from its folder, in the git store
// (served/create.js), inside the sync's folder lock. While it runs the blog
// is marked as being set up (database.setCreating, which expires by itself),
// for the dashboard; the mark goes when the setup ends, however it ends.
async function create(blog) {
  try {
    await database.setCreating(blog.id);
  } catch (err) {
    // The dashboard shows the create page meanwhile: no reason to stop
    console.log(
      clfdate() +
        " Git: create: could not mark the setup as in progress: " +
        err.message
    );
  }

  // Settles when the sync engine calls finish, after it has released the
  // folder lock
  await new Promise(function (resolve, reject) {
    // A setup that cannot run (the folder is locked) leaves no mark behind
    function finish(err) {
      database
        .clearCreating(blog.id)
        .catch(function () {})
        .then(function () {
          if (err) return reject(err);
          resolve();
        });
    }

    sync(blog.id, async function (err, folder, done) {
      if (err) return finish(err);

      // Outside the try below, whose cleanup marks the setup failed: a
      // repository the blog already has is not this setup's
      try {
        await require("./served/create").assertEmpty(blog.id);
      } catch (err) {
        return done(err, finish);
      }

      try {
        await createRepository(blog, folder);
        done(null, finish);
      } catch (err) {
        await database
          .setStatus(blog.owner, "createFailed")
          .catch(function () {});
        done(err, finish);
      }
    });
  });
}

const promiseOnly = require("helper/promiseOnly");

module.exports = promiseOnly(create);

async function createRepository(blog, folder) {
  report(folder, "Creating token");
  await prepareMetadata(blog);

  const made = await require("./served/create")(blog, folder);

  // Everything in the folder is already in the repository, and Blot already
  // has the folder's entries, so the first sync starts from this commit. An
  // old value would be from an earlier connection: this replaces it. Until
  // both are recorded the store's copy is still the setup's to take back, so
  // a failure here leaves the store empty for a retry.
  try {
    // Looked up on the module each time, so a spec can make it fail
    await database.setApplied(blog.id, made.commit);
    await database.setStatus(blog.owner, "createComplete");
  } catch (err) {
    await made.rollback();
    throw err;
  }

  console.log(clfdate() + " Git: create: done");
  // The delay ensures the page reloads – for empty folders this function returns
  // immediately and the page which displays the status message doesn't reload in
  // time.
  await delay(1000);
  folder.status("Repository created successfully");
}

// The folder is not looked for on local disk: it may have no copy there
// (#2258)
async function prepareMetadata(blog) {
  await Promise.all([
    database.setStatus(blog.owner, "createInProgress"),
    database.createToken(blog.owner),
    assertNoLiveClone(blog.id),
  ]);
}

// A .git directory in the blog folder is what a live clone left, or one that
// is not ours, and disconnecting removes ours: setup refuses a folder which
// has one, rather than leave it to be taken for one.
async function assertNoLiveClone(blogID) {
  if (await storage.exists(blogID, "/.git")) {
    throw new Error("The blog folder already has a .git directory");
  }
}

function report(folder, message, logMessage = message) {
  console.log(`${clfdate()} Git: create: ${logMessage}`);
  folder.status(message);
}
