const { promisify } = require("util");
const fs = require("fs-extra");
const Git = require("simple-git");
const database = require("./database");
const localPath = require("helper/localPath");
const dataDir = require("./dataDir");
const clfdate = require("helper/clfdate");
const sync = require("sync");
const shouldIgnoreFile = require("clients/util/shouldIgnoreFile");
const path = require("path");

const GC_INTERVAL = 100;
const COMMIT_BATCH_SIZE = 25;
const PUSH_COMMIT_BATCH_SIZE = 5;
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

async function createEmptyCommit(repo, message) {
  await repo.commit(message, { "--allow-empty": true });
}

async function pushMaster(repo, message) {
  console.log(
    clfdate() +
      " Git: create: " +
      (message || "Pushing commits to repository")
  );

  await repo.push(["-u", "origin", "master"]);
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

async function commitBatchWithRetries(repo, label, message) {
  for (let attempt = 0; ; attempt++) {
    try {
      console.log(
        clfdate() + " Git: create: Committing " + label + " to repository"
      );
      await repo.raw(["commit", "--allow-empty", "-m", message]);
      if (attempt > 0) {
        console.log(
          clfdate() +
            " Git: create: commit succeeded on attempt " +
            (attempt + 1) +
            " " +
            label
        );
      }
      return;
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

    const liveDirectory = localPath(blog.id, "/");
    const bareDirectory = `${dataDir}/${blog.handle}.git`;

    try {
      await createRepository(blog, folder);
      done(null, callback);
    } catch (err) {
      await cleanupFailedRepository(blog, liveDirectory, bareDirectory);
      done(err, callback);
    }
  });
};

async function createRepository(blog, folder) {
  const liveDirectory = localPath(blog.id, "/");
  const bareDirectory = `${dataDir}/${blog.handle}.git`;

  report(folder, "Making bare repository directory and creating token");
  await prepareDirectoriesAndMetadata(blog, liveDirectory, bareDirectory);

  const bareRepo = Git(bareDirectory, { maxConcurrentProcesses: 1 });
  const liveRepo = Git(liveDirectory, { maxConcurrentProcesses: 1 });

  report(folder, "Creating bare repository", "initing bareRepo");
  await bareRepo.init(true);

  report(folder, "Creating live repository", "initing liveRepo");
  await liveRepo.init();

  try {
    report(folder, "Configuring temporary Git GC settings");
    await configureTemporaryGitGc(bareRepo);
    await configureTemporaryGitGc(liveRepo);

    report(
      folder,
      "Adding remote to live repository",
      "adding remote to liveRepo"
    );
    await liveRepo.addRemote("origin", bareDirectory);

    const progress = {
      filesAdded: 0,
      total: 0,
      pendingFiles: [],
      unpushedCommits: 0,
    };
    await addFolder(folder, liveRepo, bareRepo, progress);
  } finally {
    await Promise.all([
      unsetTemporaryGitGc(bareRepo),
      unsetTemporaryGitGc(liveRepo),
    ]);
  }

  await setStatus(blog.owner, "createComplete");

  console.log(clfdate() + " Git: create: done");
  // The delay ensures the page reloads – for empty folders this function returns
  // immediately and the page which displays the status message doesn't reload in
  // time.
  await delay(1000);
  folder.status("Repository created successfully");
}

async function prepareDirectoriesAndMetadata(blog, liveDirectory, bareDirectory) {
  await Promise.all([
    fs.mkdir(bareDirectory),
    setStatus(blog.owner, "createInProgress"),
    createToken(blog.owner),
    assertDirectoryOwnership(liveDirectory),
  ]);
}

async function assertDirectoryOwnership(liveDirectory) {
  const stats = await fs.stat(liveDirectory);

  if (stats.uid !== process.getuid()) {
    throw new Error(
      "The live repository directory is not owned by the current user. uid: " +
        stats.uid +
        " process.getuid(): " +
        process.getuid() +
        " process.getgid(): " +
        process.getgid()
    );
  }
}

async function cleanupFailedRepository(blog, liveDirectory, bareDirectory) {
  const liveRepo = Git(liveDirectory, { maxConcurrentProcesses: 1 });

  await unsetTemporaryGitGc(liveRepo);

  await Promise.allSettled([
    fs.remove(bareDirectory),
    fs.remove(`${liveDirectory}/.git`),
    setStatus(blog.owner, "createFailed"),
  ]);
}

function report(folder, message, logMessage = message) {
  console.log(`${clfdate()} Git: create: ${logMessage}`);
  folder.status(message);
}

// git add exits non-zero for paths matched by a .gitignore rule; rather than
// spawning a separate `git check-ignore` per entry (slow: one subprocess per
// file, and this repo runs git with maxConcurrentProcesses: 1), we just try
// to add the file and skip it if git refuses it as ignored.
function isGitIgnoreAddError(err) {
  return /ignored by one of your \.gitignore files/i.test(
    String((err && err.message) || err)
  );
}

async function countFiles(dir) {
  const entries = (await fs.readdir(dir, { withFileTypes: true })).filter(
    (entry) => !shouldIgnoreFile(entry.name)
  );

  let total = 0;

  for (const entry of entries) {
    const entryPath = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      total += await countFiles(entryPath);
    } else if (entry.isFile()) {
      total += 1;
    }
  }

  return total;
}

async function addFolder(folder, liveRepo, bareRepo, progress) {
  async function walk(dir) {
    const entries = (await fs.readdir(dir, { withFileTypes: true }))
      .filter((entry) => !shouldIgnoreFile(entry.name))
      .sort((a, b) => a.name.localeCompare(b.name));

    for (const entry of entries) {
      const filePath = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        await walk(filePath);
      } else if (entry.isFile()) {
        await stageFile(folder, liveRepo, bareRepo, progress, filePath);

        if (progress.pendingFiles.length >= COMMIT_BATCH_SIZE) {
          await commitPendingFiles(liveRepo, progress);
          await pushIfNeeded(liveRepo, progress);
        }
      }
    }
  }

  try {
    report(folder, "Counting files...");
    progress.total = await countFiles(folder.path);
    console.log(
      clfdate() + " Git: create: counted " + progress.total + " files to add"
    );

    await walk(folder.path);
    await commitPendingFiles(liveRepo, progress);

    // Nothing was actually staged, either because the folder was empty or
    // because every file in it is gitignored: fall back to an initial commit
    // so the repository ends up with a HEAD instead of being left with none.
    if (progress.filesAdded === 0) {
      console.log(
        clfdate() +
          " Git: addFolder: no files added, creating initial commit"
      );
      return handleEmptyFolder(folder, liveRepo);
    }

    if (progress.unpushedCommits > 0) {
      await pushPendingCommits(liveRepo, progress);
    }
  } catch (err) {
    throw new Error("Error while adding files to repository: " + err.message);
  }
}

async function handleEmptyFolder(folder, liveRepo) {
  folder.status("Initial commit to repository");

  await createEmptyCommit(liveRepo, "Initial commit");
  folder.status("Pushing initial commit to repository");
  await pushMaster(liveRepo, "Pushing initial commit to repository");

  folder.status("Created initial commit in empty repository");
}

async function stageFile(folder, liveRepo, bareRepo, progress, filePath) {
  const relativePath = path.relative(folder.path, filePath);
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
    await liveRepo.add(filePath);
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

  await gcIfNeeded(liveRepo, bareRepo, progress);
}

async function commitPendingFiles(liveRepo, progress) {
  const batchSize = progress.pendingFiles.length;

  if (!batchSize) return;

  const label = batchSize === 1 ? progress.pendingFiles[0] : batchSize + " files";
  const message = batchSize === 1 ? "Add files" : "Add " + batchSize + " files";

  try {
    await commitBatchWithRetries(liveRepo, label, message);
  } catch (err) {
    console.log("Failed to commit " + label + " to repository: " + err.message);
    throw err;
  }

  progress.pendingFiles = [];
  progress.unpushedCommits++;
}

async function pushIfNeeded(liveRepo, progress) {
  if (progress.unpushedCommits >= PUSH_COMMIT_BATCH_SIZE) {
    await pushPendingCommits(liveRepo, progress);
  }
}

async function pushPendingCommits(liveRepo, progress) {
  const label =
    progress.unpushedCommits === 1
      ? "1 commit"
      : progress.unpushedCommits + " commits";

  try {
    await pushMaster(liveRepo, "Pushing " + label + " to repository");
  } catch (err) {
    console.log("Failed to push commits to repository: " + err.message);
    throw err;
  }

  progress.unpushedCommits = 0;
}

async function gcIfNeeded(liveRepo, bareRepo, progress) {
  if (progress.filesAdded % GC_INTERVAL === 0) {
    console.log(
      clfdate() +
        " Git: create: git gc before (file #" +
        progress.filesAdded +
        ")"
    );
    await liveRepo.raw(["gc"]);
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
