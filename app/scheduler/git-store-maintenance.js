// The git store's daily upkeep in shadow mode (#2259): for every shadowed
// blog, the store's sweep and the cheap check of its copy against the
// repository on disk, a deep check (a whole clone) of a few blogs in turn and
// the git test blog, and deleting git/<blogID>/ prefixes left behind by blogs
// no longer on git. See app/clients/git/shadow/maintenance.js.
//
// It does nothing unless shadow mode is set (BLOT_GIT_STORE_SHADOW) and there
// is a storage bucket. The scheduler runs it in one process (lock.cron).
// Emails the admin once, with every finding, only if something was found.
const config = require("config");
const clfdate = require("helper/clfdate");

const NAME = "git-store-maintenance";

// options: sendEmail(view), and what maintenance.daily takes
async function run(options = {}) {
  const shadowSetting = String((config.git_store && config.git_store.shadow) || "").trim();

  if (!shadowSetting || !(config.storage && config.storage.bucket)) {
    return { skipped: true, sent: false };
  }

  const maintenance = require("clients/git/shadow/maintenance");

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
    "orphanPrefixes=" + orphans.prefixes,
    "orphansRemoved=" + orphans.removed,
    "orphansSpared=" + orphans.spared,
    "orphanErrors=" + orphans.errors,
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
  };
}

// What the scheduler calls when the job fires (a property, so specs can spy)
async function job() {
  const email = require("helper/email");

  const { sent, skipped } = await module.exports.run({
    sendEmail: (locals) => new Promise((resolve, reject) => email.GIT_STORE_ALERT(null, locals, (err) => (err ? reject(err) : resolve()))),
  });

  if (skipped) console.log(clfdate(), "Git store: shadow mode is off, nothing to look after");
  if (sent) console.log(clfdate(), "Sent git store alert email");
}

module.exports = { NAME, run, view, job };
