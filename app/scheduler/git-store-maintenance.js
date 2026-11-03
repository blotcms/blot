// The git store's daily upkeep (#2259): for every blog on git, the store's
// sweep and the cheap check of its copy, a deep check (a whole clone) of a
// few blogs in turn and the git test blog, on the first of the month deleting
// <blogID>/git/ prefixes left behind by blogs no longer on git, and clearing
// the scratch directories a killed import or verify left (older than 12
// hours). See app/clients/git/served/maintenance.js.
//
// It does nothing unless there is a storage bucket. The scheduler runs it in
// one process (lock.cron). Emails the admin once, with every finding, only if
// something was found.
const config = require("config");
const clfdate = require("helper/clfdate");

const NAME = "git-store-maintenance";

// options: sendEmail(view), and what maintenance.daily takes
async function run(options = {}) {
  if (!(config.storage && config.storage.bucket)) return { skipped: true, sent: false };

  const maintenance = require("clients/git/served/maintenance");

  if (!maintenance.configured()) return { skipped: true, sent: false };

  const { sendEmail, ...dailyOptions } = options;
  const report = await maintenance.daily(dailyOptions);
  const { sweeps, orphans, findings } = report;

  console.log(
    clfdate(),
    "Git store:",
    "blogs=" + report.blogs,
    "swept=" + sweeps.ok,
    "sweepErrors=" + sweeps.errors,
    "packsDeleted=" + sweeps.packsDeleted,
    "manifestsDeleted=" + sweeps.manifestsDeleted,
    "bytesFreed=" + sweeps.bytesFreed,
    "deepChecked=" + report.deepChecked,
    "findings=" + findings.length,
    "orphanPrefixes=" + (orphans ? orphans.prefixes : "-"),
    "orphansRemoved=" + (orphans ? orphans.removed : "-"),
    "orphansSpared=" + (orphans ? orphans.spared : "-"),
    "orphanErrors=" + (orphans ? orphans.errors : "-"),
    "scratchRemoved=" + report.scratch.removed,
    "scratchBytes=" + report.scratch.bytes,
    "ms=" + report.ms
  );

  if (!findings.length) return { skipped: false, sent: false, report };

  await sendEmail(view(report));

  return { skipped: false, sent: true, report };
}

const plural = (n, word) => n + " " + word + (n === 1 ? "" : /(s|sh|ch)$/.test(word) ? "es" : "s");

// The alert email's view: what was found, by kind, blog IDs only
function view(report) {
  const { findings } = report;
  const count = (kind) => findings.filter((f) => f.kind === kind).length;
  const blogs = new Set(findings.map((f) => f.blog)).size;
  const summary = [
    count("missing") && plural(count("missing"), "missing file"),
    count("mismatch") && plural(count("mismatch"), "mismatch"),
    count("error") && plural(count("error"), "error"),
    count("orphan") && plural(count("orphan"), "leftover"),
  ]
    .filter(Boolean)
    .join(", ");

  return {
    summary: summary + " in " + plural(blogs, "blog"),
    checked: report.blogs,
    deepChecked: report.deepChecked,
    findings: findings.map((f) => ({ blog: f.blog, kind: f.kind, check: f.check, detail: f.detail })),
    hasMissing: count("missing") > 0,
    hasMismatch: count("mismatch") > 0,
    hasErrors: count("error") > 0,
    hasOrphans: count("orphan") > 0,
  };
}

// What the scheduler calls when the job fires (a property, so specs can spy)
async function job() {
  const email = require("helper/email");

  const { sent, skipped } = await module.exports.run({
    sendEmail: (locals) => new Promise((resolve, reject) => email.GIT_STORE_ALERT(null, locals, (err) => (err ? reject(err) : resolve()))),
  });

  if (skipped) console.log(clfdate(), "Git store: no storage bucket, nothing to look after");
  if (sent) console.log(clfdate(), "Sent git store alert email");
}

module.exports = { NAME, run, view, job };
