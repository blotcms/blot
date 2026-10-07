// Collects what an hourly sync-verification sweep found, per blog, so a client
// can send the operator ONE digest email per sweep instead of one per problem.
// Client-agnostic: the Dropbox, Google Drive and iCloud sweeps all use it.
//
//   const report = syncReport.create();
//   syncReport.recordChanges(report, blog, summary);   // walk summary
//   syncReport.recordFix(report, blog, finalReport);   // Fix()'s report
//   syncReport.recordError(report, blog, "walk", err); // a phase that threw
//   await syncReport.recordBusy(report, blog);         // couldn't get the lock
//   syncReport.send(report, email.DROPBOX_SYNC_ISSUE, "Dropbox:");
//
// A sweep can record every blog unconditionally: a blog only appears in the
// digest if it has changeCount > 0, a non-empty Fix() report, an error or a
// stuck lock, and send() does nothing when no blog qualifies.
//
// Fix() never emails on its own - it only returns its report - so this is
// also where that report gets formatted (formatFix) for the digests and for
// the dashboard's resync email.
const countChanges = require("clients/util/countChanges");
const clfdate = require("helper/clfdate");

// Cap how many repair items from a single check get quoted in an email - a
// big repair (eg. thousands of stale tag entries) would otherwise produce an
// email too large to be useful.
const SAMPLE_SIZE = 10;

// Some errors carry whole response bodies; keep the email readable.
const MAX_ERROR_MESSAGE_LENGTH = 300;

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

// A sweep that can't get a blog's folder lock skips it silently: a running
// sync will pick up whatever changed. But the lock's heartbeat keeps it alive
// for as long as the holding process lives, so a lock held for more than
// STUCK_LOCK_THRESHOLD_MS means a sync hung inside a live process (a crashed
// process's lock expires within seconds). That's worth reporting; a lock held
// for less is the normal case. Resolves to true if the blog was reported.
// The lookup is best effort - if it fails the blog stays a silent skip.
const STUCK_LOCK_THRESHOLD_MS = 60 * 60 * 1000;

function formatDuration(ms) {
  const minutes = Math.floor(ms / 60000);
  return Math.floor(minutes / 60) + "h " + (minutes % 60) + "m";
}

async function recordBusy(report, blog) {
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
//   createdDirs, modifiedDuringWalk,
//   hasRepairs, checks: [{ name, count, countPlural, sample, hasMore,
//     moreCount }],
//   hasStuckLock, lockHeldFor ("1h 5m"),
//   hasErrors, errors: [{ phase, message }] }.
function view(report) {
  return { blogs: issues(report) };
}

// sendEmail is an email function (eg. email.DROPBOX_SYNC_ISSUE) or the name
// of one on helper/email. Fire-and-forget: a failed send is logged with the
// client's log prefix (eg. "Dropbox:") and never thrown into the sweep.
function send(report, sendEmail, logPrefix) {
  if (!hasIssues(report)) return;

  if (typeof sendEmail === "string") {
    sendEmail = require("helper/email")[sendEmail];
  }

  sendEmail(null, view(report), function (err) {
    if (err) {
      console.error(clfdate(), logPrefix, "Failed to send issue email", err);
    } else {
      console.log(clfdate(), logPrefix, "Sent sync issue report email");
    }
  });
}

module.exports = {
  create,
  recordChanges,
  recordFix,
  recordError,
  recordBusy,
  hasIssues,
  view,
  send,
  formatChanges,
  formatFix,
  summarize,
  STUCK_LOCK_THRESHOLD_MS,
};
