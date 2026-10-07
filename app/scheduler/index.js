var User = require("models/user");
var async = require("async");
var dailyUpdate = require("./daily");
var email = require("helper/email");
var clfdate = require("helper/clfdate");
const scheduler = require("node-schedule");
var checkFeaturedSites = require("../documentation/featured/check");
var config = require("config");
var publishScheduledEntries = require("./publish-scheduled-entries");
const freeDiskSpace = require("./free-disk-space");
const os = require("os");
const fs = require("fs-extra");
const exec = require("child_process").exec;
const zombies = require("./zombies");
const checkCardTesters = require("./check-card-testers");
const subscriptionLifecycleJob = require("./subscription-lifecycle");
const checkSSLCertificates = require("./check-ssl-certificates");

// If any disk has less than 2GB of space, we should notify the admin
const MINIMUM_DISK_SPACE_IN_K = 2 * 1024 * 1024;

// If the data disk has less than 10GB of space, we should notify the admin
const DATA_DISK_MINIMUM_DISK_SPACE_IN_K = 10 * 1024 * 1024;

let NOTIFIED_LOW_DISK_SPACE = false;

module.exports = function () {
  // Log useful system information, once per minute
  scheduler.scheduleJob("* * * * *", function () {
    // Detect any zombie processes
    zombies(function (err) {
      if (err) throw err;
    });

    freeDiskSpace(function (err, disks) {
      let shouldNotify = false;

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

      if (disks.some(disk => disk.available_k < MINIMUM_DISK_SPACE_IN_K)) {
        shouldNotify = true;
      }

      if (
        disks.find(disk => disk.label === "data") &&
        disks.find(disk => disk.label === "data").available_k <
          DATA_DISK_MINIMUM_DISK_SPACE_IN_K
      ) {
        shouldNotify = true;
      }

      if (shouldNotify && !NOTIFIED_LOW_DISK_SPACE) {
        NOTIFIED_LOW_DISK_SPACE = true;
        email.WARNING_LOW_DISK_SPACE(null, { disks }, function (err) {
          if (err) console.log(clfdate(), err);
        });
      }
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

  // Bash the cache for scheduled posts
  publishScheduledEntries(function (err) {
    if (err) throw err;
    console.log(clfdate(), "Scheduled entries for future publication");
  });

  // Warn users about impending subscriptions
  User.getAllIds(function (err, uids) {
    if (err) {
      console.error("Error fetching user ids for scheduling:", err);
      return;
    }

    async.each(uids, User.scheduleSubscriptionEmail, function (err) {
      if (err) {
        console.error("Error scheduling subscription emails:", err);
      } else {
        console.log(clfdate(), "Scheduled emails for renewals and expiries!");
      }
    });

    async.each(
      uids,
      function (uid, next) {
        User.scheduleWelcomeEmail(uid, function (err) {
          if (err) console.error("Error scheduling welcome email for", uid, err);
          next();
        });
      },
      function (err) {
        if (err) {
          console.error("Error scheduling welcome emails:", err);
        } else {
          console.log(clfdate(), "Scheduled welcome emails where needed!");
        }
      }
    );
  });

  console.log(clfdate(), "Scheduled daily check of storage disk usage");
  scheduler.scheduleJob({ hour: 10, minute: 0 }, function () {
    console.log(clfdate(), "Scheduler: Checking available disk space");

    exec("df -h", function (err, stdout) {
      if (err) throw err;

      var disk = stdout.split("\n")[1].replace(/\s+/g, " ").split(" ");
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
  scheduler.scheduleJob({ hour: 9, minute: 0 }, function () {
    console.log(clfdate(), "Processing subscription lifecycle changes");
    subscriptionLifecycleJob(function (err) {
      if (err) console.log(clfdate(), "Error processing subscription lifecycle", err);
    });
  });

  console.log(clfdate(), "Scheduled daily check of suspected fraudulent users");
  scheduler.scheduleJob({ hour: 11, minute: 0 }, async function () {
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
  scheduler.scheduleJob({ hour: 13, minute: 0 }, async function () {
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

  console.log(clfdate(), "Scheduled daily check of featured sites");
  scheduler.scheduleJob({ hour: 8, minute: 0 }, function () {
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
  scheduler.scheduleJob({ hour: 12, minute: 0 }, function () {
    console.log(clfdate(), "Generating daily update email...");
    dailyUpdate(function () {
      console.log(clfdate(), "Daily update email update was sent.");
    });
  });
};
