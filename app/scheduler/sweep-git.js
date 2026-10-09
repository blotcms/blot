// The daily git housekeeping job: sweeps stale push quarantine directories,
// looks for git processes that have been running too long to be healthy, and
// emails the admin only if either found something or the sweep had errors.
const sweepQuarantine = require("../clients/git/sweepQuarantine");
const stuckProcesses = require("../clients/git/stuckProcesses");

const plural = (n, word) => n + " " + word + (n === 1 ? "" : "s");

function formatAge(seconds) {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);

  if (hours >= 48) return Math.floor(hours / 24) + " days";
  return hours ? hours + "h " + minutes + "m" : minutes + "m";
}

function formatSize(bytes) {
  const mb = bytes / (1024 * 1024);

  return mb >= 1024 ? (mb / 1024).toFixed(1) + " GB" : mb.toFixed(1) + " MB";
}

// options: sweep, findStuck (default to the real ones) and sendEmail(view)
module.exports = async function sweepGit(options) {
  const sweep = options.sweep || sweepQuarantine;
  const findStuck = options.findStuck || stuckProcesses;

  let report;
  let stuck = [];

  try {
    report = await sweep();
  } catch (err) {
    console.error("Git: could not sweep push quarantine directories", err);
    report = { repositories: 0, removed: 0, bytes: 0, errors: 1, directories: [] };
  }

  try {
    stuck = await findStuck();
  } catch (err) {
    console.error("Git: could not look for stuck git processes", err);
  }

  if (!stuck.length && !report.removed && !report.errors) {
    return { sent: false, report, stuck };
  }

  const summary = [];

  if (stuck.length) summary.push(plural(stuck.length, "stuck git process"));
  if (report.removed) {
    summary.push(
      "removed " +
        report.removed +
        " stale push " +
        (report.removed === 1 ? "directory" : "directories")
    );
  }
  if (report.errors) summary.push(plural(report.errors, "sweep error"));

  await options.sendEmail({
    summary: summary.join(", "),
    hasStuck: stuck.length > 0,
    stuck: stuck.map((p) => ({
      pid: p.pid,
      age: formatAge(p.seconds),
      rss: formatSize(p.rssKb * 1024),
      args: p.args,
    })),
    hasRemoved: report.removed > 0,
    removed: report.directories.map((d) => ({
      repository: d.repository,
      size: formatSize(d.bytes),
      age: formatAge(d.ageMs / 1000),
    })),
    freed: formatSize(report.bytes),
    hasErrors: report.errors > 0,
    errors: report.errors,
  });

  return { sent: true, report, stuck };
};
