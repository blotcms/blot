// After a disaster restore (config/host/cycle.sh restore), Redis is newer than
// the data volume: the volume comes from a snapshot, Redis from a backup that
// is at most about an hour old. Entries can point at files the volume never
// got. This works out which blogs to resync from their source, in what order
// and at what rate, and runs the resyncs. Run it inside a unit, so it uses the
// unit's Redis and sync clients, as the app's user: as root it would leave
// root-owned files in the blog folders and the state file.
//
//   docker exec --user 1000:1000 -e HOME=/home/node blot-blue node scripts/host-cycle/reconcile.js --since <ISO time> [options]
//
//   --since TIME       when the snapshot started (restore prints it). Required.
//   --margin MINUTES   look this far before --since as well (default 15)
//   --all              every blog with a sync client, whether or not it changed
//   --go               resync. Without it this only prints the plan
//   --concurrency N    blogs in flight at once (default 2)
//   --per-client N     blogs in flight per client, for its API limits (default 1)
//   --pause SECONDS    each worker waits this long after a blog (default 2)
//   --state FILE       finished blogs, so a second run skips them
//                      (default <data directory>/reconcile-state.txt)
//   --restart          forget the state file
//
// Which blogs: a blog's cacheID is set to the time of any sync that changed
// something, and of template and setting changes (a few too many is only a
// wasted resync). A blog with no cacheID is included, as it cannot be ruled out.
// Git blogs have no source to resync from: they are listed with the time of
// their last change, because their owners push again or the content is
// recovered from the old data volume. Most recently changed first, so the
// visible breakage is shortest. Each resync takes the blog's normal sync lock;
// one that cannot get it is left unfinished for the next run.
//
// Drive only verifies the content of a few old equal-size files per walk (see
// clients/google-drive/sync/util/migrationBudget.js), so one edited to exactly
// the same size since the snapshot stays stale here until its next edit. Drive
// still holds the current copy, and verifying them all would mean downloading
// every such file in the middle of a recovery.
//
// It prints blog IDs and counts, no handles or emails.

const fs = require("fs");

const RESYNCABLE = ["dropbox", "google-drive", "icloud"];
const RATE_LIMITED = /429|rate limit|too many requests/i;
const BACKOFF_MS = 60 * 1000;

// resync: the blogs to resync and the git blogs to tell about, from
// [{ id, client, cacheID, isDisabled }].
function select(blogs, { since, marginMs = 0, all = false }) {
  const cutoff = since - marginMs;
  const changed = (blog) => !blog.cacheID || blog.cacheID >= cutoff;
  const recent = (a, b) => (b.cacheID || 0) - (a.cacheID || 0) || (a.id < b.id ? -1 : 1);
  const live = blogs.filter((blog) => !blog.isDisabled);

  const resync = live
    .filter((blog) => RESYNCABLE.includes(blog.client) && (all || changed(blog)))
    .sort(recent);
  const git = live.filter((blog) => blog.client === "git" && changed(blog)).sort(recent);

  return {
    resync,
    git,
    unchanged: live.filter((blog) => RESYNCABLE.includes(blog.client)).length - resync.length,
  };
}

// The state file: "since <time>" and then one finished blog ID per line. One for
// another snapshot is refused, not reused, because it would skip blogs that
// need work.
function readState(file, since) {
  if (!file || !fs.existsSync(file)) return new Set();
  const [header, ...ids] = fs.readFileSync(file, "utf8").split("\n").filter(Boolean);
  if (header !== "since " + since.toISOString()) {
    throw new Error(`${file} is for another --since (${header}): delete it, or pass --restart`);
  }
  return new Set(ids);
}

function startState(file, since) {
  fs.writeFileSync(file, "since " + since.toISOString() + "\n");
}

// run: resync the blogs, at most `concurrency` at a time and `perClient` of one
// client. A worker takes the first blog (so the most recent) whose client has
// room. resync(blog) resolves for done or skipped and rejects for a failure,
// which is not recorded as finished.
async function run(blogs, { concurrency, perClient, pauseMs, resync, finished, sleep, log = () => {} }) {
  const pending = blogs.slice();
  const inFlight = {};
  const result = { done: 0, failed: 0, failures: [] };

  async function worker() {
    while (pending.length) {
      const i = pending.findIndex((blog) => (inFlight[blog.client] || 0) < perClient);
      if (i === -1) {
        await sleep(100);
        continue;
      }
      const [blog] = pending.splice(i, 1);
      inFlight[blog.client] = (inFlight[blog.client] || 0) + 1;
      let backoff = false;
      try {
        await resync(blog);
        finished(blog.id);
        result.done++;
      } catch (err) {
        const message = (err && err.message) || String(err);
        result.failed++;
        result.failures.push({ id: blog.id, client: blog.client, message });
        log(`${blog.id} (${blog.client}) failed: ${message}`);
        backoff = RATE_LIMITED.test(message);
      }
      // The slot is held through the pause: a rate-limit backoff is for the
      // client's API, so no other worker may start on that client meanwhile.
      try {
        await sleep(backoff ? BACKOFF_MS : pauseMs);
      } finally {
        inFlight[blog.client]--;
      }
    }
  }

  await Promise.all(Array.from({ length: concurrency }, worker));
  return result;
}

// ---- Redis and the clients (only loaded when run) --------------------------

async function loadBlogs() {
  const { promisify } = require("util");
  const Blog = require("models/blog");
  const getAllIDs = promisify(Blog.getAllIDs);
  const get = promisify((id, cb) => Blog.get({ id }, cb));
  const ids = await getAllIDs();
  const blogs = [];
  for (let i = 0; i < ids.length; i += 50) {
    const batch = await Promise.all(ids.slice(i, i + 50).map((id) => get(id).catch(() => null)));
    for (const blog of batch) {
      if (blog) blogs.push({ id: blog.id, client: blog.client, cacheID: blog.cacheID, isDisabled: blog.isDisabled });
    }
  }
  return blogs;
}

// A client's resync resolves with a summary even when downloads failed without
// stopping the walk. Those blogs are incomplete, so they must be retried.
function assertComplete(summary) {
  if (!summary || !(summary.failed > 0)) return summary;
  const sample = summary.firstError ? `, the first: ${summary.firstError}` : "";
  throw new Error(`${summary.failed} files failed to sync${sample}`);
}

// The same resyncs as scripts/<client>/resync.js, which log and swallow their
// errors; these throw, so a failed blog is not recorded as finished.
async function resyncBlog(blog) {
  const { promisify } = require("util");
  const establishSyncLock = require("sync/establishSyncLock");
  const fix = promisify(require("sync/fix"));
  const full = await new Promise((resolve, reject) =>
    require("models/blog").get({ id: blog.id }, (err, b) => (err || !b ? reject(err || new Error("no blog")) : resolve(b)))
  );
  const { folder, done } = await establishSyncLock(blog.id);
  try {
    // A blog created after the snapshot has no folder on this volume, and each
    // client counts the local files before it starts.
    await require("fs-extra").ensureDir(require("helper/localPath")(blog.id, "/"));
    if (blog.client === "dropbox") {
      assertComplete(await require("clients/dropbox/sync/reset-to-blot")(blog.id, () => {}, folder.update));
      await fix(full);
    } else if (blog.client === "google-drive") {
      const summary = await require("clients/google-drive/sync/resetFromDrive")(blog.id, folder.status, folder.update);
      if (!summary) throw new Error("the walk of the Drive folder did not finish");
      assertComplete(summary);
      await fix(full);
    } else if (blog.client === "icloud") {
      const resync = require("clients/icloud/resync");
      try {
        assertComplete(await resync(blog.id, folder.status, folder.update));
        await fix(full);
      } catch (err) {
        // Nothing to resync from: not a failure to retry.
        if (err.code !== resync.FOLDER_MISSING && err.code !== resync.SETUP_INCOMPLETE) throw err;
      }
    }
  } finally {
    await done();
  }
}

function parseArgs(argv) {
  const options = { margin: 15, concurrency: 2, perClient: 1, pause: 2 };
  const number = (name, value, min) => {
    const n = Number(value);
    if (!Number.isFinite(n) || n < min) throw new Error(`${name} takes a number, at least ${min}`);
    return n;
  };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = () => {
      if (i + 1 >= argv.length) throw new Error(`${flag} needs a value`);
      return argv[++i];
    };
    if (flag === "--since") options.since = new Date(value());
    else if (flag === "--margin") options.margin = number(flag, value(), 0);
    else if (flag === "--concurrency") options.concurrency = number(flag, value(), 1);
    else if (flag === "--per-client") options.perClient = number(flag, value(), 1);
    else if (flag === "--pause") options.pause = number(flag, value(), 0);
    else if (flag === "--state") options.state = value();
    else if (flag === "--all") options.all = true;
    else if (flag === "--go") options.go = true;
    else if (flag === "--restart") options.restart = true;
    else if (flag === "--dry-run") options.dryRun = true;
    else throw new Error("unknown option " + flag);
  }
  if (!options.since || isNaN(options.since)) throw new Error("--since takes a time, e.g. 2026-11-01T03:05:00Z");
  if (options.go && options.dryRun) throw new Error("--go or --dry-run, not both");
  return options;
}

const iso = (ms) => (ms ? new Date(ms).toISOString() : "unknown");

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const state = options.state || require("config").data_directory + "/reconcile-state.txt";
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  const plan = select(await loadBlogs(), {
    since: options.since.getTime(),
    marginMs: options.margin * 60 * 1000,
    all: options.all,
  });

  if (options.restart && options.go && fs.existsSync(state)) fs.unlinkSync(state);
  const finished = readState(state, options.since);
  const todo = plan.resync.filter((blog) => !finished.has(blog.id));

  const byClient = {};
  todo.forEach((blog) => (byClient[blog.client] = (byClient[blog.client] || 0) + 1));
  console.log(`Since ${options.since.toISOString()} (and ${options.margin} minutes before it)${options.all ? ", all blogs" : ""}`);
  console.log(`To resync: ${todo.length} (${Object.keys(byClient).map((c) => `${c} ${byClient[c]}`).join(", ") || "none"}); already finished: ${plan.resync.length - todo.length}; unchanged, left alone: ${plan.unchanged}`);
  console.log(`Most recent first. Next: ${todo.slice(0, 5).map((blog) => `${blog.id} (${iso(blog.cacheID)})`).join(", ") || "none"}`);
  console.log(`\nGit blogs changed since then (${plan.git.length}). Their owners push again, or recover from the old data volume:`);
  plan.git.forEach((blog) => console.log(`  ${blog.id} last changed ${iso(blog.cacheID)}`));

  if (!options.go) {
    console.log("\nDry run. Add --go to resync.");
    return 0;
  }

  if (!fs.existsSync(state)) startState(state, options.since);
  const result = await run(todo, {
    concurrency: options.concurrency,
    perClient: options.perClient,
    pauseMs: options.pause * 1000,
    resync: resyncBlog,
    finished: (id) => fs.appendFileSync(state, id + "\n"),
    sleep,
    log: (line) => console.error(line),
  });
  console.log(`\nResynced ${result.done}, failed ${result.failed}.${result.failed ? " Run it again: finished blogs are skipped." : ""}`);
  return result.failed ? 1 : 0;
}

module.exports = { select, run, readState, startState, parseArgs, assertComplete };

if (require.main === module) {
  main().then(
    (code) => process.exit(code),
    (err) => {
      console.error("reconcile:", err.message || err);
      process.exit(1);
    }
  );
}
