var User = require("models/user");
var async = require("async");
var dailyUpdate = require("./daily");
var email = require("helper/email");
var clfdate = require("helper/clfdate");
const scheduler = require("node-schedule");
const lock = require("helper/lock");
const client = require("models/client");
var checkFeaturedSites = require("../documentation/featured/check");
var config = require("config");
var { isRedisUnavailableError } = require("helper/redisUnavailable");
const freeDiskSpace = require("./free-disk-space");
const os = require("os");
const fs = require("fs-extra");
const exec = require("child_process").exec;
const zombies = require("./zombies");
const checkCardTesters = require("./check-card-testers");
const subscriptionLifecycleJob = require("./subscription-lifecycle");
const checkSSLCertificates = require("./check-ssl-certificates");
const checkRedisHost = require("./check-redis-host");
const sweepGit = require("./sweep-git");
const pruneTmp = require("./prune-tmp");

// If any other disk has less than 2GB of space, we should notify the admin.
// The data disk is watched by percentage instead (free-disk-space.js).
const MINIMUM_DISK_SPACE_IN_K = 2 * 1024 * 1024;

// The warning emails are sent once per TTL across every process: each
// container runs the per-minute check below, and lock.once in Redis decides
// which one sends. Like the in-memory flags they replace, nothing resets when
// the disk recovers: the keys just expire.
const LOW_DISK_NOTIFIED_KEY = "notify:low-disk-space";
const DATA_DISK_NOTIFIED_KEY = "notify:data-disk-percent:";
const DISK_NOTIFY_TTL_MS = 24 * 60 * 60 * 1000;

function sendLowDiskEmail(disks, headline) {
  email.WARNING_LOW_DISK_SPACE(null, { disks, headline }, function (err) {
    if (err) console.log(clfdate(), err);
  });
}

// Emails about low disk space, at most once per DISK_NOTIFY_TTL_MS however
// many processes call this. The data disk emails once per alert level
// (90, 95, 99%), the other disks once for all of them. Never rejects.
async function notifyLowDisk(disks) {
  try {
    const lowDisk = disks.some(
      disk => disk.label !== "data" && disk.available_k < MINIMUM_DISK_SPACE_IN_K
    );

    if (lowDisk && (await lock.once(LOW_DISK_NOTIFIED_KEY, DISK_NOTIFY_TTL_MS))) {
      sendLowDiskEmail(disks, "Warning: Blot's disk is low on space");
    }

    const alert = freeDiskSpace.dataDiskAlert(disks);

    if (
      alert &&
      (await lock.once(DATA_DISK_NOTIFIED_KEY + alert.percent, DISK_NOTIFY_TTL_MS))
    ) {
      sendLowDiskEmail(disks, alert.headline);

      // Having emailed for this level, a later reading at a lower one (the
      // disk recovering a little) must not email again within the TTL.
      const lower = freeDiskSpace.DATA_DISK_ALERTS.filter(
        other => other.percent < alert.percent
      );
      if (lower.length) {
        const multi = client.multi();
        for (const other of lower) {
          multi.set(DATA_DISK_NOTIFIED_KEY + other.percent, "1", { PX: DISK_NOTIFY_TTL_MS });
        }
        await multi.exec();
      }
    }
  } catch (err) {
    console.error(clfdate(), "Error checking whether to send low disk space email", err);
  }
}

// The Redis host check measures "continuous" from the previous run, which may
// have been in another process, so when it last ran is kept in Redis (its
// alert state is at check-redis-host's STATE_KEY).
const REDIS_HOST_CHECKED_AT_KEY = "blot:redis-host:checked-at";

// If Redis is readable but refuses writes (OOM, MISCONF) the SET below fails
// and the stored time goes stale, so the last completed check is also kept in
// this process and the newer of the two is used.
let redisHostCheckedAtInMemory = null;

module.exports = function () {
  // Log useful system information, once per minute
  scheduler.scheduleJob("* * * * *", function () {
    // Detect any zombie processes
    zombies(function (err) {
      if (err) console.error(clfdate(), "Error checking for zombie processes", err);
    });

    freeDiskSpace(function (err, disks) {

      if (err || !disks) {
        console.error(clfdate(), "Error checking disk space", err);
        return;
      }

      console.log(
        clfdate(),
        "[STATS]",
        "Available disk space",
        disks.map(disk => disk.label + "=" + disk.available_human).join(", ")
      );

      notifyLowDisk(disks);
    });

    // Print most memory-intensive processes
    exec(
      "ps -eo pmem,pcpu,comm,args | sort -k 1 -nr | head -10",
      function (err, stdout) {
        if (err || !stdout) return;

        if (config.environment === "development") {
          // this is annoying in development
        } else {
          console.log(clfdate(), "[STATS]", "top");
          console.log(stdout);
        }
      }
    );

    // Print cpu and memory information
    fs.readFile("/proc/meminfo", "utf-8", function (err, contents) {
      // This won't work on MacOS
      if (err || !contents) return;

      let stats = {};

      contents
        .trim()
        .split("\n")
        .forEach(line => {
          stats[line.split(":")[0].trim()] = parseInt(
            line.split(":")[1].trim()
          );
        });

      let loadavg = os.loadavg()[0];
      let totalCPUs = os.cpus().length;
      let totalmem = stats.MemTotal;
      let freemem = stats.MemAvailable;
      let pretty = num => (100 * num).toFixed(3) + "%";

      console.log(
        clfdate(),
        "[STATS]",
        "cpuuse=" + pretty(loadavg / totalCPUs),
        "totalmem=" + stats.MemTotal,
        "totalcpus=" + totalCPUs,
        "memuse=" + pretty((totalmem - freemem) / totalmem)
      );
    });
  });

  // Warn users about impending renewals and expiries. The scan looks at every
  // user, and a Redis marker per user and billing period means each warning is
  // sent once however many processes run it.
  console.log(clfdate(), "Scheduled daily subscription renewal and expiry emails");
  lock.cron("subscription-emails", { hour: 14, minute: 0 }, async function () {
    const sent = await User.sendSubscriptionEmails();
    console.log(clfdate(), "Sent", sent, "subscription renewal and expiry emails");
  });

  // Repair users whose welcome email alarm was never set (the sign-up route
  // schedules it after the user is committed, and can fail)
  console.log(clfdate(), "Scheduled daily welcome email alarm reconcile");
  lock.cron("welcome-email-reconcile", { hour: 15, minute: 0 }, async function () {
    const scheduled = await User.scheduleWelcomeEmail.reconcile({ days: 7 });
    console.log(clfdate(), "Re-armed", scheduled, "welcome email alarms");
  });

  console.log(clfdate(), "Scheduled daily check of storage disk usage");
  // Checks one host's disk: scope "host" once BLOT_HOST_ID is set and there is
  // more than one host.
  lock.cron("disk-usage-report", { hour: 10, minute: 0 }, function () {
    console.log(clfdate(), "Scheduler: Checking available disk space");

    exec("df -h", function (err, stdout) {
      if (err) {
        console.error(clfdate(), "Scheduler: Error checking available disk space", err);
        return;
      }

      var disk = (stdout.split("\n")[1] || "").replace(/\s+/g, " ").split(" ");
      var usage = disk[4];
      var available = disk[3];

      if (parseInt(usage) < 90) {
        console.log(
          clfdate(),
          "Scheduler: Disk usage check passed! Usage:",
          usage,
          "Space available:",
          available
        );
        return;
      }

      console.log(
        clfdate(),
        "Scheduler: Disk usage check failed! Usage:",
        usage,
        "Space available:",
        available
      );
    });
  });

  // console.log(
  //   clfdate(),
  //   "Scheduled daily check of folders for sync abnormalities"
  // );
  // scheduler.scheduleJob({ hour: 8, minute: 0 }, function () {
  //   console.log(clfdate(), "Fix sync: checking folders");
  //   fix(function (err, report) {
  //     if (err) {
  //       console.log(clfdate(), "Fix sync: error checking folders", err);
  //     } else {
  //       email.SYNC_REPORT(null, { report: JSON.stringify(report) });
  //       console.log(clfdate(), "Fix sync: checked all folders");
  //     }
  //   });
  // });



  console.log(clfdate(), "Scheduled daily subscription lifecycle processing");
  lock.cron("subscription-lifecycle", { hour: 9, minute: 0 }, function () {
    console.log(clfdate(), "Processing subscription lifecycle changes");
    subscriptionLifecycleJob(function (err) {
      if (err) console.log(clfdate(), "Error processing subscription lifecycle", err);
    });
  });

  console.log(clfdate(), "Scheduled daily check of suspected fraudulent users");
  lock.cron("check-card-testers", { hour: 11, minute: 0 }, async function () {
    console.log(clfdate(), "Checking for potential fraudulent users");

    let customers;
    
    try {
      customers = await checkCardTesters();
    } catch (err) {
      console.log(clfdate(), "Error: Checking suspected fraudulent users", err);
    }

    if (!customers || customers.length === 0) {
      console.log(clfdate(), "No suspected fraudulent users found");
    } else {
      email.SUSPECTED_FRAUD(null, { customers });
    }
  });

  console.log(clfdate(), "Scheduled daily check of SSL certificates");
  lock.cron("check-ssl-certificates", { hour: 13, minute: 0 }, async function () {
    console.log(clfdate(), "Checking SSL certificates");

    try {
      const { sent } = await checkSSLCertificates({
        sendEmail: (view) =>
          new Promise((resolve, reject) =>
            email.SSL_CERTIFICATE_ISSUES(null, view, (err) =>
              err ? reject(err) : resolve()
            )
          ),
      });

      console.log(
        clfdate(),
        sent ? "Sent SSL certificate issues email" : "No new SSL certificate issues"
      );
    } catch (err) {
      console.log(clfdate(), "Error: Checking SSL certificates", err);
    }
  });

  // Two minutes after each of the Redis host's 5-minute samples. During a
  // Redis outage this only logs: /redis-health reports the outage itself.
  console.log(clfdate(), "Scheduled check of the Redis host's memory limits");
  lock.cron("check-redis-host", "2-59/5 * * * *", async function () {
    try {
      const checkedAt = await client.get(REDIS_HOST_CHECKED_AT_KEY);
      const stored = checkedAt === null ? null : Number(checkedAt);
      const redisHostCheckedAt =
        stored === null || Number.isNaN(stored)
          ? redisHostCheckedAtInMemory
          : Math.max(stored, redisHostCheckedAtInMemory || 0);
      const { sent, report } = await checkRedisHost({
        lastCheckAt: redisHostCheckedAt,
        sendEmail: (view) =>
          new Promise((resolve, reject) =>
            email.REDIS_HOST_ALERT(null, view, (err) =>
              err ? reject(err) : resolve()
            )
          ),
      });
      redisHostCheckedAtInMemory = report.now;
      try {
        await client.set(REDIS_HOST_CHECKED_AT_KEY, String(report.now));
      } catch (err) {
        console.log(clfdate(), "Error: Saving Redis host check time", err.message);
      }
      if (sent) console.log(clfdate(), "Sent Redis host alert email");
    } catch (err) {
      if (isRedisUnavailableError(err)) {
        console.log(clfdate(), "Redis host check skipped: Redis unavailable");
      } else {
        console.log(clfdate(), "Error: Checking Redis host", err);
      }
    }
  });

  // A push cut off by a crash or a deploy leaves its quarantine directory in
  // the bare repository, and git never removes it. It runs once a day across
  // all containers (lock.cron) and works from any of them because they share
  // the host's git data directory. Should become scope "host" once BLOT_HOST_ID
  // is set and there is more than one host.
  console.log(clfdate(), "Scheduled daily sweep of stale git push quarantine directories");
  lock.cron("sweep-git", { hour: 5, minute: 0 }, async function () {
    try {
      const { report, sent } = await sweepGit({
        sendEmail: (view) =>
          new Promise((resolve, reject) =>
            email.GIT_SWEEP_ALERT(null, view, (err) =>
              err ? reject(err) : resolve()
            )
          ),
      });

      console.log(
        clfdate(),
        "Git: swept " + report.repositories + " repositories, removed",
        report.removed,
        "stale push quarantine directories, freed",
        report.bytes,
        "bytes" + (report.errors ? ", " + report.errors + " errors" : "")
      );
      if (sent) console.log(clfdate(), "Sent git sweep alert email");
    } catch (err) {
      console.log(clfdate(), "Error: Sweeping git push quarantine directories", err);
    }
  });

  // config.tmp_directory is on the host's instance store and shared by every
  // container, so it is pruned once a day by whichever container wins the
  // lock.cron run. Should become scope "host" once BLOT_HOST_ID is set and
  // there is more than one host.
  console.log(clfdate(), "Scheduled daily prune of old files in the tmp directory");
  lock.cron("prune-tmp", { hour: 5, minute: 30 }, async function () {
    try {
      const report = await pruneTmp();

      console.log(
        clfdate(),
        "Tmp: removed",
        report.removed,
        "old entries, freed",
        report.bytes,
        "bytes" + (report.errors ? ", " + report.errors + " errors" : "")
      );
    } catch (err) {
      console.log(clfdate(), "Error: Pruning the tmp directory", err);
    }
  });

  // Hourly safety net: re-arms any missing or wrong publication alarm
  console.log(clfdate(), "Scheduled hourly reconcile of scheduled entry alarms");
  lock.cron("scheduled-entries-reconcile", "20 * * * *", async function () {
    try {
      const counts = await require("models/entry/scheduled").reconcile();

      if (counts.set || counts.failed)
        console.log(
          clfdate(),
          "Scheduled entries: reconciled",
          counts.blogs,
          "blogs, set",
          counts.set,
          "alarms" + (counts.failed ? ", " + counts.failed + " blogs failed" : "")
        );
    } catch (err) {
      console.log(clfdate(), "Error: Reconciling scheduled entry alarms", err);
    }
  });

  console.log(clfdate(), "Scheduled daily check of featured sites");
  lock.cron("check-featured-sites", { hour: 8, minute: 0 }, function () {
    console.log(clfdate(), "Checking featured sites");
    checkFeaturedSites(function (err) {
      if (err) {
        console.log(clfdate(), "Error: Checking featured sites", err);
      } else {
        console.log(clfdate(), "Checked featured sites");
      }
    });
  });

  // At some point I should check this doesnt consume too much memory
  console.log(clfdate(), "Scheduled daily update email");
  lock.cron("daily-update", { hour: 12, minute: 0 }, function () {
    console.log(clfdate(), "Generating daily update email...");
    dailyUpdate(function () {
      console.log(clfdate(), "Daily update email update was sent.");
    });
  });
};

module.exports.notifyLowDisk = notifyLowDisk;
