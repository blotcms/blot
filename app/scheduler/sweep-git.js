// The daily git housekeeping job: looks for git processes that have been
// running too long to be healthy, and emails the admin only if it found some.
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

// options: findStuck (defaults to the real one) and sendEmail(view)
module.exports = async function sweepGit(options) {
  const findStuck = options.findStuck || stuckProcesses;

  let stuck = [];

  try {
    stuck = await findStuck();
  } catch (err) {
    console.error("Git: could not look for stuck git processes", err);
  }

  if (!stuck.length) return { sent: false, stuck };

  await options.sendEmail({
    summary: plural(stuck.length, "stuck git process"),
    hasStuck: true,
    stuck: stuck.map((p) => ({
      pid: p.pid,
      age: formatAge(p.seconds),
      rss: formatSize(p.rssKb * 1024),
      args: p.args,
    })),
  });

  return { sent: true, stuck };
};
