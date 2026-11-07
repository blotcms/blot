// Wait until the folder watcher has finished syncing. Runs INSIDE the container.
//
//   docker exec blot-node-app-1 node scripts/development/translate/settle <blogID>
//
// `blog.cacheID` is bumped at the end of every sync (app/sync/index.js, "Updating
// cacheID of blog"), so it doubles as a "something just rebuilt" signal. We poll
// it and return once it has held still long enough.
//
// This matters because sync latency is variable: in testing, a single file
// appeared within the same second, while a delete took roughly half a minute —
// file events are queued per blog and each takes a lock on the folder.

const Blog = require("models/blog");

const getBlog = (by) => Blog.get(by);

const POLL_INTERVAL = 1000;
// How long cacheID must hold still before we call it settled. Two seconds is
// comfortably longer than the gap between queued syncs of a single batch.
const QUIET_PERIOD = 3000;
const DEFAULT_TIMEOUT = 120000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function settle(blogID, options = {}) {
  const timeout = options.timeout || DEFAULT_TIMEOUT;
  const quietPeriod = options.quietPeriod || QUIET_PERIOD;
  const onTick = options.onTick || (() => {});

  const started = Date.now();

  let previous = null;
  let lastChange = Date.now();
  let syncs = 0;

  while (true) {
    const blog = await getBlog({ id: blogID });

    if (!blog || !blog.id) throw new Error(`No blog with ID ${blogID}`);

    const cacheID = blog.cacheID || 0;

    if (previous === null) {
      previous = cacheID;
    } else if (cacheID !== previous) {
      previous = cacheID;
      lastChange = Date.now();
      syncs++;
      onTick(syncs);
    }

    const quietFor = Date.now() - lastChange;

    if (quietFor >= quietPeriod) {
      return { settled: true, syncs, cacheID, waited: Date.now() - started };
    }

    if (Date.now() - started > timeout) {
      // Not fatal — a folder that is still syncing is worth reporting, not
      // worth aborting over, since the caller may still want to proceed.
      return { settled: false, syncs, cacheID, waited: Date.now() - started };
    }

    await sleep(POLL_INTERVAL);
  }
}

if (require.main === module) {
  const blogID = process.argv[2];
  const timeout = process.argv[3] ? Number(process.argv[3]) : undefined;

  settle(blogID, { timeout })
    .then((result) => {
      console.log(`settled=${result.settled}`);
      console.log(`syncs=${result.syncs}`);
      console.log(`cacheID=${result.cacheID}`);
      console.log(`waited=${result.waited}`);
      process.exit(0);
    })
    .catch((err) => {
      console.error("[settle]", err.message);
      process.exit(2);
    });
}

module.exports = settle;
