// One "process" of the build crash loop spike (see spike.js): takes the blog's
// folder lock and updates one path, as a sync would, then exits 0. A build
// that blocks the event loop past the lock's lease loses the lock, and
// sync/hold.js's onCompromised crashes this process, as it does a unit's.
const establishSyncLock = require("sync/establishSyncLock");

async function main(blogID, path) {
  const startedAt = Date.now();
  const { folder, done } = await establishSyncLock(blogID);
  let syncError;
  try {
    await folder.run(() => folder.update(path));
  } catch (err) {
    syncError = err;
    console.log("worker: update rejected", err.code, err.message);
  }
  await done(syncError);
  console.log("worker: finished in", Date.now() - startedAt, "ms");
}

main(process.argv[2], process.argv[3]).then(
  () => process.exit(0),
  (err) => {
    console.error("worker: failed", err);
    process.exit(2);
  }
);
