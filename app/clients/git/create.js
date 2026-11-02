const { promisify } = require("util");
const fs = require("fs-extra");
const Git = require("./git");
const database = require("./database");
const storage = require("storage/folder");
const repos = require("./repo");
const plumbing = require("./plumbing");
const limiter = require("./limiter");
const clfdate = require("helper/clfdate");
const sync = require("sync");
const shouldIgnoreFile = require("clients/util/shouldIgnoreFile");

const GC_INTERVAL = 100;
const COMMIT_BATCH_SIZE = 25;
const COMMIT_RETRY_DELAYS_MS = [1000, 2000, 3000];

// We apply this configuration because there is a bug with git version 2.54.0
// which allows for multiple concurrent automatic git gc operations. This caused
// memory issues and so to resolve, we manually gc during the create process.
const TEMPORARY_GIT_GC_CONFIG = [
  ["gc.auto", "0"],
  ["gc.autoDetach", "false"],
  ["maintenance.auto", "false"],
  ["maintenance.autoDetach", "false"],
];
const setStatus = promisify(database.setStatus.bind(database));
const setApplied = promisify(database.setApplied.bind(database));
const createToken = promisify(database.createToken.bind(database));

function delay(ms) {
  return new Promise(function (resolve) {
    setTimeout(resolve, ms);
  });
}

function isTransientCommitError(err) {
  const msg = String(err && err.message);
  return (
    /is not a valid object/i.test(msg) ||
    /nonexistent object [0-9a-f]{40}/i.test(msg)
  );
}

async function configureTemporaryGitGc(repo) {
  for (const [key, value] of TEMPORARY_GIT_GC_CONFIG) {
    await repo.raw(["config", "--local", key, value]);
  }
}

async function unsetTemporaryGitGc(repo) {
  const results = await Promise.allSettled(
    TEMPORARY_GIT_GC_CONFIG.map(([key]) =>
      repo.raw(["config", "--local", "--unset", key])
    )
  );

  results.forEach((result, index) => {
    if (result.status === "rejected") {
      const [key] = TEMPORARY_GIT_GC_CONFIG[index];
      console.log(
        clfdate() +
          " Git: create: failed to unset temporary Git config " +
          key +
          ": " +
          (result.reason && result.reason.message
            ? result.reason.message
            : result.reason)
      );
    }
  });
}

// Writes a commit of what has been added to the index, on top of the last one,
// and retries if git reports an object it can't find (see the gc note above)
async function writeCommitWithRetries(index, parent, label, message) {
  for (let attempt = 0; ; attempt++) {
    try {
      console.log(
        clfdate() + " Git: create: Committing " + label + " to repository"
      );
      const tree = (await index.git(["write-tree"])).trim();
      const commit = await plumbing.commitTree(index, tree, parent, message);
      if (attempt > 0) {
        console.log(
          clfdate() +
            " Git: create: commit succeeded on attempt " +
            (attempt + 1) +
            " " +
            label
        );
      }
      return commit;
    } catch (err) {
      const delayMs = COMMIT_RETRY_DELAYS_MS[attempt];

      if (!delayMs || !isTransientCommitError(err)) {
        throw err;
      }

      console.log(
        clfdate() +
          " Git: create: commit retry " +
          (attempt + 1) +
          "/" +
          COMMIT_RETRY_DELAYS_MS.length +
          " in " +
          delayMs +
          "ms " +
          label +
          " err=" +
          err.message
      );
      await delay(delayMs);
    }
  }
}

module.exports = function create(blog, callback) {
  sync(blog.id, async function (err, folder, done) {
    if (err) return callback(err);

    const bareDirectory = repos.directory(blog.handle);

    // Outside the try below, because its cleanup removes this directory. If
    // it was already here it isn't ours to remove: it could be this blog's
    // connected repository, or one another blog left at this handle.
    try {
      await fs.mkdir(bareDirectory);
    } catch (err) {
      return done(err, callback);
    }

    try {
      await createRepository(blog, folder);
      done(null, callback);
    } catch (err) {
      await cleanupFailedRepository(blog, bareDirectory);
      done(err, callback);
    }
  });
};

// Imports the blog folder into a new bare repository. There is no clone: the
// folder's files are added to a temporary index of the bare repository, which
// takes the folder as its work tree, and committed from there.
async function createRepository(blog, folder) {
  const bareDirectory = repos.directory(blog.handle);

  report(folder, "Creating token");
  await prepareMetadata(blog);

  // git reads the files it adds from its work tree itself, so the import
  // needs the blog folder on local disk. Only read from, as ensureLocal asks.
  const blogDirectory = await storage.ensureLocal(blog.id, "/");

  const bareRepo = Git(bareDirectory);

  report(folder, "Creating bare repository", "initing bareRepo");
  await bareRepo.raw(["init", "--bare", "--initial-branch=master"]);

  const index = await plumbing.openIndex(bareDirectory, {
    workTree: blogDirectory,
  });
  const progress = {
    filesAdded: 0,
    total: 0,
    pendingFiles: [],
    head: null,
  };

  try {
    report(folder, "Configuring temporary Git GC settings");
    await configureTemporaryGitGc(bareRepo);

    await addFolder(blog, folder, index, bareRepo, progress);
  } finally {
    await Promise.all([index.close(), unsetTemporaryGitGc(bareRepo)]);
  }

  // Everything in the folder is already in the repository, and Blot already
  // has the folder's entries, so the first sync starts from this commit.
  // An old value would be from an earlier connection: this replaces it.
  await setApplied(blog.id, progress.head);

  await setStatus(blog.owner, "createComplete");

  console.log(clfdate() + " Git: create: done");
  // The delay ensures the page reloads – for empty folders this function returns
  // immediately and the page which displays the status message doesn't reload in
  // time.
  await delay(1000);
  folder.status("Repository created successfully");
}

async function prepareMetadata(blog) {
  await Promise.all([
    setStatus(blog.owner, "createInProgress"),
    createToken(blog.owner),
    assertDirectoryOwnership(blog.id),
    assertNoLiveClone(blog.id),
  ]);
}

// A sync takes a .git directory in the blog folder for a live clone (see
// sync.js) and would point its remote at the new repository, so one that is
// not ours is not left to be taken for one. Disconnecting removes ours.
async function assertNoLiveClone(blogID) {
  if (await storage.exists(blogID, "/.git")) {
    throw new Error("The blog folder already has a .git directory");
  }
}

// The owner of the folder on disk, which storage/folder has no notion of, so
// this reads the real directory. It goes with the import's work tree when the
// folder leaves the disk.
async function assertDirectoryOwnership(blogID) {
  const stats = await fs.stat(await storage.ensureLocal(blogID, "/"));

  if (stats.uid !== process.getuid()) {
    throw new Error(
      "The blog directory is not owned by the current user. uid: " +
        stats.uid +
        " process.getuid(): " +
        process.getuid() +
        " process.getgid(): " +
        process.getgid()
    );
  }
}

// Only the repository this create made. The blog folder is not touched: it has
// no clone of ours to remove, and a .git directory in it is not ours to remove.
async function cleanupFailedRepository(blog, bareDirectory) {
  await Promise.allSettled([
    fs.remove(bareDirectory),
    setStatus(blog.owner, "createFailed"),
  ]);
}

function report(folder, message, logMessage = message) {
  console.log(`${clfdate()} Git: create: ${logMessage}`);
  folder.status(message);
}

// git add exits non-zero for paths matched by a .gitignore rule; rather than
// spawning a separate `git check-ignore` per entry (slow: one subprocess per
// file, and this repo runs one git command at a time), we just try
// to add the file and skip it if git refuses it as ignored.
function isGitIgnoreAddError(err) {
  return /ignored by one of your \.gitignore files/i.test(
    String((err && err.message) || err)
  );
}

// The files of the blog folder to add, as paths relative to it ("a/b.txt"),
// spelled as they are on disk, which is how git add must be given them. A
// file in an ignored directory is skipped, as is an ignored file, and links
// are not files.
async function* filesToAdd(blogID) {
  for await (const file of storage.walk(blogID, "/")) {
    if (!shouldIgnoreFile(file)) yield file.slice(1);
  }
}

async function countFiles(blogID) {
  let total = 0;

  // eslint-disable-next-line no-unused-vars
  for await (const file of filesToAdd(blogID)) total += 1;

  return total;
}

async function addFolder(blog, folder, index, bareRepo, progress) {
  try {
    report(folder, "Counting files...");
    progress.total = await countFiles(blog.id);
    console.log(
      clfdate() + " Git: create: counted " + progress.total + " files to add"
    );

    for await (const relativePath of filesToAdd(blog.id)) {
      await stageFile(folder, index, bareRepo, progress, relativePath);

      if (progress.pendingFiles.length >= COMMIT_BATCH_SIZE) {
        await commitPendingFiles(blog, index, progress);
      }
    }

    await commitPendingFiles(blog, index, progress);

    // Nothing was actually staged, either because the folder was empty or
    // because every file in it is gitignored: fall back to an initial commit
    // so the repository ends up with a HEAD instead of being left with none.
    if (progress.filesAdded === 0) {
      console.log(
        clfdate() +
          " Git: addFolder: no files added, creating initial commit"
      );
      return handleEmptyFolder(blog, folder, index, progress);
    }
  } catch (err) {
    throw new Error("Error while adding files to repository: " + err.message);
  }
}

async function handleEmptyFolder(blog, folder, index, progress) {
  folder.status("Initial commit to repository");

  await saveCommit(blog, index, progress, "Initial commit", "Initial commit");

  folder.status("Created initial commit in empty repository");
}

// Makes a commit of the index on top of the one before and moves master to it.
// It holds the ref lock a user's push holds, so the two never move master at
// once, and moves it only from the commit this create made last (none, for the
// first). If a push got in meanwhile (the token exists from the start of the
// create) master is not where it was left and the create fails, as the push
// it used to make would have been refused, and the repository is removed.
async function saveCommit(blog, index, progress, label, message) {
  const commit = await writeCommitWithRetries(index, progress.head, label, message);

  // A place in the background lane before the ref lock, so the move never
  // waits for room with the lock held (see repo.commit)
  await limiter.run("background", async function () {
    const release = await repos.holdRefLock(blog.id);

    console.log(clfdate() + " Git: create: Moving master to " + label);

    try {
      await plumbing.moveMaster(repos.directory(blog.handle), commit, progress.head);
    } catch (err) {
      console.log("Failed to commit " + label + " to repository: " + err.message);
      throw err;
    } finally {
      await release().catch(function (err) {
        // The lock expires by itself
        console.log(clfdate() + " Git: create: could not release the ref lock: " + err.message);
      });
    }
  });

  progress.head = commit;
}

async function stageFile(folder, index, bareRepo, progress, relativePath) {
  const current = progress.filesAdded + 1;
  const untilGc =
    GC_INTERVAL - (progress.filesAdded % GC_INTERVAL || GC_INTERVAL);

  console.log(
    clfdate() +
      " Git: create: starting file #" +
      current +
      "/" +
      progress.total +
      " (" +
      untilGc +
      " successful files until gc)"
  );

  folder.status("(" + current + "/" + progress.total + ") Adding " + relativePath);

  try {
    await index.git(["add", "--", relativePath]);
  } catch (err) {
    if (isGitIgnoreAddError(err)) {
      console.log(
        clfdate() +
          " Git: create: skipping gitignored file " +
          relativePath
      );
      progress.total = Math.max(0, progress.total - 1);
      return;
    }

    console.log(
      "Failed to add file " + relativePath + " to repository: " + err.message
    );
    throw err;
  }

  progress.pendingFiles.push(relativePath);
  progress.filesAdded++;

  await gcIfNeeded(bareRepo, progress);
}

async function commitPendingFiles(blog, index, progress) {
  const batchSize = progress.pendingFiles.length;

  if (!batchSize) return;

  const label = batchSize === 1 ? progress.pendingFiles[0] : batchSize + " files";
  const message = batchSize === 1 ? "Add files" : "Add " + batchSize + " files";

  await saveCommit(blog, index, progress, label, message);

  progress.pendingFiles = [];
}

async function gcIfNeeded(bareRepo, progress) {
  if (progress.filesAdded % GC_INTERVAL === 0) {
    console.log(
      clfdate() +
        " Git: create: git gc before (file #" +
        progress.filesAdded +
        ")"
    );
    await bareRepo.raw(["gc"]);
    console.log(
      clfdate() +
        " Git: create: git gc after (file #" +
        progress.filesAdded +
        ")"
    );
  } else {
    const remaining = GC_INTERVAL - (progress.filesAdded % GC_INTERVAL);
    console.log(
      clfdate() +
        " Git: create: " +
        progress.filesAdded +
        " files done, " +
        remaining +
        " until gc"
    );
  }
}
