// Collects what an hourly sync-verification sweep found, per blog, so a client
// can send the operator ONE digest email per sweep instead of one per problem.
// Client-agnostic: the Dropbox, Google Drive and iCloud sweeps all use it.
//
// The digest exists to surface possible code bugs and sync-integrity problems
// for the operator to resolve. It never reports what a user is free to do
// (deleting or unsharing their folder, revoking access, running out of
// storage), and it reports an ongoing problem once, not every hour.
//
// The contract every client's sweep follows, so they stay alike:
//
//  1. Scheduled hourly on master at a staggered minute (Dropbox :00, Drive
//     :30, iCloud :45), with a re-entrancy guard, walking blogs one at a time.
//  2. Per blog of the client: skip a disabled or missing blog; skip silently
//     on a user-side health issue; check for a stuck lock (held >= 1h) for
//     EVERY blog, before the recency filter; only then require a real sync
//     within the last hour, using a timestamp only real syncs stamp and the
//     sweep never refreshes.
//  3. Walk under the blog's folder lock. After acquiring it, re-check
//     eligibility (setup or transfer in progress, stored error) and treat a
//     refusal as "nothing happened". A busy lock is a silent skip. Pass the
//     walk's error to done(error).
//  4. A walk that fails, or skipped files (summary.failed), is reported as a
//     "walk" error and Fix() is skipped. A walk records its changes with live
//     edits excluded (countChanges), even a partial one.
//  5. Fix() runs after a successful walk, outside the lock. Repairs and errors
//     are recorded.
//  6. Client-specific follow-up only where justified, with the reason in a
//     comment (eg. Dropbox's catch-up sync: its cursor-based delta never
//     revisits a webhook sync dropped while the sweep held the lock).
//  7. One digest per run, through this module: the pre-send user-side drop and
//     once-per-occurrence suppression of errors and stuck locks.
//  8. Per-blog event-loop lag and duration logging.
//  9. The templates have the same sections and wording apart from the client
//     name, including the live-edit exclusion in the breakdown.
//
//   const report = syncReport.create();
//   // per blog of the client, before walking it:
//   if (await syncReport.hasUserSideIssue(blog.id, getHealth)) continue;
//   if (await syncReport.recordStuckLock(report, blog)) continue;
//   // then, as the sweep learns things:
//   if (!syncReport.recordWalk(report, blog, summary)) continue; // skip Fix
//   syncReport.recordFix(report, blog, finalReport);   // Fix()'s report
//   syncReport.recordError(report, blog, "walk", err); // a phase that threw
//   // after the last blog:
//   await syncReport.send(report, email.DROPBOX_SYNC_ISSUE, "Dropbox:", {
//     client: "dropbox",
//     getHealth,
//   });
//
// A sweep can record every blog unconditionally: a blog only appears in the
// digest if it has changeCount > 0, a non-empty Fix() report, an error or a
// stuck lock, and send() does nothing when no blog qualifies.
//
// Changes and Fix() repairs are events: the sweep fixes them itself, so they
// are reported every time. Errors and stuck locks are states that persist
// until someone intervenes, so send() reports one when it first appears,
// stays quiet while it continues, and reports it again only after it has
// cleared and come back (see reportedKey).
//
// Fix() never emails on its own - it only returns its report - so this is
// also where that report gets formatted (formatFix) for the digests and for
// the dashboard's resync email.
const countChanges = require("clients/util/countChanges");
const clfdate = require("helper/clfdate");
const health = require("clients/health");

// Cap how many repair items from a single check get quoted in an email - a
// big repair (eg. thousands of stale tag entries) would otherwise produce an
// email too large to be useful.
const SAMPLE_SIZE = 10;

// Some errors carry whole response bodies; keep the email readable.
const MAX_ERROR_MESSAGE_LENGTH = 300;

// Health issues that are the user's own doing, which they are free to cause at
// any time: revoking access, deleting or unsharing the folder, filling their
// storage. They are not bugs, so a blog with one is left out of the sweep and
// of the digest. TRANSFER_INCOMPLETE and SYNC_ERROR stay reportable: Blot
// failing on its own is what the operator needs to see.
const USER_SIDE_CODES = [
  health.CODES.REAUTH_REQUIRED,
  health.CODES.SOURCE_MISSING,
  health.CODES.QUOTA_EXCEEDED,
];

function create() {
  return { blogs: new Map() };
}

function entry(report, blog) {
  if (!report.blogs.has(blog.id)) {
    report.blogs.set(blog.id, {
      id: blog.id,
      handle: blog.handle,
      truncatedId: blog.id.slice(0, 12),
      hasChanges: false,
      changeCount: 0,
      changeCountPlural: true,
      downloaded: 0,
      removed: 0,
      createdDirs: 0,
      modifiedDuringWalk: 0,
      excluded: 0,
      hasRepairs: false,
      checks: [],
      hasStuckLock: false,
      lockHeldFor: "",
      hasErrors: false,
      errors: [],
    });
  }

  return report.blogs.get(blog.id);
}

// The unsynced-change fields of a walk summary, in the shape the templates
// use. What counts (and what is excluded as a live edit) lives in
// countChanges.
function formatChanges(summary) {
  summary = summary || {};
  const changeCount = countChanges(summary);

  return {
    hasChanges: changeCount > 0,
    changeCount,
    changeCountPlural: changeCount !== 1,
    downloaded: summary.downloaded || 0,
    removed: summary.removed || 0,
    createdDirs: summary.createdDirs || 0,
    modifiedDuringWalk: summary.modifiedDuringWalk || 0,
    // Everything countChanges left out as a live edit, so the breakdown above
    // adds up to changeCount: the raw totals alone would overstate it.
    excluded:
      (summary.modifiedDuringWalk || 0) + (summary.changedDuringWalk || 0),
  };
}

// Fix()'s report ({ [checkName]: items[] }) as template rows: one per check,
// with up to SAMPLE_SIZE items quoted as JSON.
function formatFix(finalReport) {
  return Object.keys(finalReport || {}).map(function (name) {
    const items = finalReport[name];
    const sample = items.slice(0, SAMPLE_SIZE).map(function (item) {
      try {
        return JSON.stringify(item);
      } catch (e) {
        return String(item);
      }
    });

    return {
      name: name,
      count: items.length,
      countPlural: items.length !== 1,
      sample: sample,
      moreCount: Math.max(0, items.length - sample.length),
      hasMore: items.length > sample.length,
    };
  });
}

// One line for callers that only log Fix()'s report, eg.
// "entry-ghosts=3 tag-ghosts=1". Empty when Fix() repaired nothing.
function summarize(finalReport) {
  return Object.keys(finalReport || {})
    .map(function (name) {
      return name + "=" + finalReport[name].length;
    })
    .join(" ");
}

function recordChanges(report, blog, summary) {
  Object.assign(entry(report, blog), formatChanges(summary));
}

// Records a finished walk's summary and says whether the walk was complete.
// The walks carry on past a file they can't download or remove (summary.failed
// counts them, summary.firstError samples one), so a partial walk is recorded
// as a "walk" error together with the changes it did apply. The sweep should
// skip Fix() for a walk that didn't complete.
function recordWalk(report, blog, summary) {
  recordChanges(report, blog, summary);

  if (!summary || !summary.failed) return true;

  recordError(
    report,
    blog,
    "walk",
    summary.failed + " file(s) failed to sync, eg. " + summary.firstError
  );
  return false;
}

function recordFix(report, blog, finalReport) {
  const record = entry(report, blog);
  record.checks = formatFix(finalReport);
  record.hasRepairs = record.checks.length > 0;
}

// phase says where it failed, eg. "walk", "fix", "catch-up sync".
function recordError(report, blog, phase, err) {
  const record = entry(report, blog);
  let message = String((err && err.message) || err);

  if (message.length > MAX_ERROR_MESSAGE_LENGTH) {
    message = message.slice(0, MAX_ERROR_MESSAGE_LENGTH) + "...";
  }

  record.errors.push({ phase: phase, message: message });
  record.hasErrors = true;
}

// A sync holding a blog's folder lock is normally brief, and a sweep that
// can't get the lock skips that blog silently: the running sync picks up
// whatever changed. But the lock's heartbeat keeps it alive for as long as the
// holding process lives, so a lock held for more than STUCK_LOCK_THRESHOLD_MS
// means a sync hung inside a live process (a crashed process's lock expires
// within seconds). That is worth reporting. Sweeps check this for every blog
// of the client, before the recency filter: a stuck lock was taken (and
// last_sync stamped) more than an hour ago, so the blog would otherwise never
// look "recently synced". Resolves to true if the blog was recorded, so the
// sweep should skip it. The lookup is best effort - if it fails the blog is
// treated as not stuck.
const STUCK_LOCK_THRESHOLD_MS = 60 * 60 * 1000;

function formatDuration(ms) {
  const minutes = Math.floor(ms / 60000);
  return Math.floor(minutes / 60) + "h " + (minutes % 60) + "m";
}

async function recordStuckLock(report, blog) {
  let since;

  try {
    since = await require("sync/lock").heldSince(blog.id);
  } catch (err) {
    console.error(clfdate(), "Failed to read lock age for", blog.id, err);
    return false;
  }

  if (since === null || Date.now() - since < STUCK_LOCK_THRESHOLD_MS) {
    return false;
  }

  const record = entry(report, blog);
  record.hasStuckLock = true;
  record.lockHeldFor = formatDuration(Date.now() - since);
  return true;
}

// Whether the blog's health has an issue the user caused (USER_SIDE_CODES).
// getHealth is the client's getHealth(blogID). A failed lookup is logged and
// answers false: not knowing must not hide a real problem.
async function hasUserSideIssue(blogID, getHealth) {
  try {
    const result = await getHealth(blogID);

    return Boolean(
      result &&
        (result.issues || []).some(function (issue) {
          return USER_SIDE_CODES.includes(issue.code);
        })
    );
  } catch (err) {
    console.error(clfdate(), "Failed to read health for", blogID, err);
    return false;
  }
}

// The up-front health check can go stale during the walk (eg. the user
// deleted their folder meanwhile, so the walk failed), so send() checks again
// and drops everything recorded for those blogs.
async function dropUserSide(report, getHealth) {
  for (const record of issues(report)) {
    if (await hasUserSideIssue(record.id, getHealth)) {
      report.blogs.delete(record.id);
    }
  }
}

// Identifiers of the ongoing problems (errors and stuck locks) in the report.
function ongoing(report) {
  const found = [];

  for (const record of issues(report)) {
    if (record.hasStuckLock) found.push(record.id + ":stuck-lock");

    for (const error of record.errors) {
      found.push(record.id + ":error:" + error.phase);
    }
  }

  return found;
}

// What the previous sweep saw, so an ongoing problem is emailed when it first
// appears and then stays quiet. Per client, a Redis set of ongoing()
// identifiers, replaced after every sweep with everything that sweep saw
// (including what it suppressed). "Cleared" simply means "not seen this
// sweep", which includes a blog that wasn't eligible this time (eg. its folder
// was deleted); if the problem returns it is reported again. That is
// accepted: the alternative is tracking why each blog went unseen.
function reportedKey(clientName) {
  return "sync:sweep:" + clientName + ":reported";
}

async function loadReported(clientName) {
  const client = require("models/client");
  return new Set(Array.from(await client.sMembers(reportedKey(clientName))));
}

async function saveReported(clientName, identifiers) {
  const client = require("models/client");
  const multi = client.multi().del(reportedKey(clientName));

  if (identifiers.length) multi.sAdd(reportedKey(clientName), identifiers);

  await multi.exec();
}

// Takes already-reported problems out of the report. A blog left with nothing
// to show falls out of issues() and so out of the email.
function suppress(report, previous) {
  for (const record of issues(report)) {
    if (previous.has(record.id + ":stuck-lock")) {
      record.hasStuckLock = false;
      record.lockHeldFor = "";
    }

    record.errors = record.errors.filter(function (error) {
      return !previous.has(record.id + ":error:" + error.phase);
    });
    record.hasErrors = record.errors.length > 0;
  }
}

function issues(report) {
  return Array.from(report.blogs.values()).filter(function (record) {
    return record.hasChanges ||
      record.hasRepairs ||
      record.hasErrors ||
      record.hasStuckLock;
  });
}

function hasIssues(report) {
  return issues(report).length > 0;
}

// The view the digest templates render: { blogs: [record, ...] }. A record is
// { id, handle, truncatedId,
//   hasChanges, changeCount, changeCountPlural, downloaded, removed,
//   createdDirs, modifiedDuringWalk, excluded,
//   hasRepairs, checks: [{ name, count, countPlural, sample, hasMore,
//     moreCount }],
//   hasStuckLock, lockHeldFor ("1h 5m"),
//   hasErrors, errors: [{ phase, message }] }.
function view(report) {
  return { blogs: issues(report) };
}

// Sends the digest, and resolves to how many blogs it listed.
//
// sendEmail is an email function (eg. email.DROPBOX_SYNC_ISSUE) or the name
// of one on helper/email. A failed send is logged with the client's log prefix
// (eg. "Dropbox:") and never thrown into the sweep.
//
// options.getHealth is the client's getHealth: blogs whose health now has a
// user-side issue are dropped first. options.client ("dropbox", ...) turns on
// the once-per-occurrence memory for errors and stuck locks. Redis or health
// trouble is logged and never suppresses the report.
async function send(report, sendEmail, logPrefix, options) {
  const { client: clientName, getHealth } = options || {};

  if (getHealth) await dropUserSide(report, getHealth);

  let previous = null;
  const current = ongoing(report);

  if (clientName) {
    try {
      previous = await loadReported(clientName);
      suppress(report, previous);
    } catch (err) {
      console.error(clfdate(), logPrefix, "Failed to read reported issues", err);
      previous = null;
    }
  }

  let sent = true;
  const listed = issues(report).length;

  if (listed) {
    if (typeof sendEmail === "string") {
      sendEmail = require("helper/email")[sendEmail];
    }

    sent = await new Promise(function (resolve) {
      sendEmail(null, view(report), function (err) {
        if (err) {
          console.error(clfdate(), logPrefix, "Failed to send issue email", err);
        } else {
          console.log(clfdate(), logPrefix, "Sent sync issue report email");
        }
        resolve(!err);
      });
    });
  }

  if (previous) {
    // A problem whose email failed was never reported, so it must not be
    // remembered as reported: it should be emailed again next sweep.
    const remembered = sent
      ? current
      : current.filter(function (id) {
          return previous.has(id);
        });

    try {
      await saveReported(clientName, remembered);
    } catch (err) {
      console.error(clfdate(), logPrefix, "Failed to save reported issues", err);
    }
  }

  return listed;
}

module.exports = {
  create,
  recordChanges,
  recordWalk,
  recordFix,
  recordError,
  recordStuckLock,
  hasUserSideIssue,
  hasIssues,
  view,
  send,
  formatChanges,
  formatFix,
  summarize,
  USER_SIDE_CODES,
  STUCK_LOCK_THRESHOLD_MS,
};
