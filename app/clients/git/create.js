const { promisify } = require("util");
const database = require("./database");
const storage = require("storage/folder");
const clfdate = require("helper/clfdate");
const sync = require("sync");

const setStatus = promisify(database.setStatus.bind(database));
const setApplied = promisify(database.setApplied.bind(database));
const createToken = promisify(database.createToken.bind(database));

function delay(ms) {
  return new Promise(function (resolve) {
    setTimeout(resolve, ms);
  });
}

// Sets up a blog's repository from its folder, in the git store
// (served/create.js), inside the sync's folder lock
module.exports = function create(blog, callback) {
  sync(blog.id, async function (err, folder, done) {
    if (err) return callback(err);

    // Outside the try below, whose cleanup marks the setup failed: a
    // repository the blog already has is not this setup's
    try {
      await require("./served/create").assertEmpty(blog.id);
    } catch (err) {
      return done(err, callback);
    }

    try {
      await createRepository(blog, folder);
      done(null, callback);
    } catch (err) {
      await setStatus(blog.owner, "createFailed").catch(function () {});
      done(err, callback);
    }
  });
};

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
    await setApplied(blog.id, made.commit);
    await setStatus(blog.owner, "createComplete");
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
  await Promise.all([setStatus(blog.owner, "createInProgress"), createToken(blog.owner), assertNoLiveClone(blog.id)]);
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
