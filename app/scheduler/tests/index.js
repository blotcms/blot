describe("scheduler", function () {
  const schedule = require("node-schedule");
  const lock = require("helper/lock");
  const client = require("models/client");
  const email = require("helper/email");
  const User = require("models/user");

  const indexPath = require.resolve("../index");
  const publishPath = require.resolve("../publish-scheduled-entries");

  const JOBS = [
    "disk-usage-report",
    "subscription-lifecycle",
    "check-card-testers",
    "check-ssl-certificates",
    "check-redis-host",
    "sweep-git",
    "prune-tmp",
    "check-featured-sites",
    "daily-update",
    "subscription-emails",
    "welcome-email-reconcile",
  ];

  describe("registering jobs", function () {
    beforeEach(function () {
      this.jobs = [];

      // lock.cron calls node-schedule itself, so wrap scheduleJob to collect
      // every job created (to cancel them) while still calling through.
      const scheduleJob = schedule.scheduleJob.bind(schedule);
      spyOn(schedule, "scheduleJob").and.callFake((rule, fn) => {
        const job = scheduleJob(rule, fn);
        this.jobs.push(job);
        return job;
      });
      spyOn(lock, "cron").and.callThrough();

      // Startup tasks: don't scan blogs or users
      spyOn(User, "getAllIds").and.callFake((callback) => callback(null, []));
      require("../publish-scheduled-entries");
      this.originalPublish = require.cache[publishPath].exports;
      require.cache[publishPath].exports = (callback) => callback(null);
      delete require.cache[indexPath];
    });

    afterEach(function () {
      this.jobs.forEach((job) => job.cancel());
      require.cache[publishPath].exports = this.originalPublish;
      delete require.cache[indexPath];
    });

    it("registers each cron job through lock.cron exactly once", function () {
      require("../index")();

      const names = lock.cron.calls.allArgs().map((args) => args[0]);
      expect(names.slice().sort()).toEqual(JOBS.slice().sort());
    });

    it("keeps the every-minute diagnostics job as a plain per-process job", function () {
      require("../index")();

      // Every lock.cron job makes one scheduleJob call, plus the minute job
      const rules = schedule.scheduleJob.calls.allArgs().map((args) => args[0]);
      expect(rules.length).toEqual(JOBS.length + 1);
      expect(rules.filter((rule) => rule === "* * * * *").length).toEqual(1);
      expect(
        lock.cron.calls.allArgs().some((args) => args[1] === "* * * * *")
      ).toBe(false);
    });
  });

  describe("notifyLowDisk", function () {
    const KEYS = [
      "notify:low-disk-space",
      "notify:data-disk-percent:90",
      "notify:data-disk-percent:95",
      "notify:data-disk-percent:99",
    ];
    const GB = 1024 * 1024;
    const disk = (label, available_k, used_percent) => ({
      label,
      available_k,
      used_percent,
      available_human: "x",
    });

    beforeEach(async function () {
      this.notifyLowDisk = require("../index").notifyLowDisk;
      await client.del(KEYS);
      spyOn(email, "WARNING_LOW_DISK_SPACE").and.callFake((uid, locals, cb) =>
        cb()
      );
    });

    afterAll(async function () {
      await client.del(KEYS);
    });

    it("sends one email for a low disk however many times it is called", async function () {
      const disks = [disk("data", 100 * GB, 10), disk("root", 1 * GB, 90)];

      await Promise.all([
        this.notifyLowDisk(disks),
        this.notifyLowDisk(disks),
        this.notifyLowDisk(disks),
      ]);
      await this.notifyLowDisk(disks);

      expect(email.WARNING_LOW_DISK_SPACE.calls.count()).toEqual(1);
      expect(email.WARNING_LOW_DISK_SPACE.calls.argsFor(0)[1].headline).toEqual(
        "Warning: Blot's disk is low on space"
      );
    });

    it("sends nothing when there is room", async function () {
      await this.notifyLowDisk([
        disk("data", 100 * GB, 10),
        disk("root", 10 * GB, 50),
      ]);

      expect(email.WARNING_LOW_DISK_SPACE).not.toHaveBeenCalled();
    });

    it("sends one email per data disk alert level", async function () {
      const at = (percent) => [disk("data", 100 * GB, percent)];

      await this.notifyLowDisk(at(91));
      await this.notifyLowDisk(at(91));
      await this.notifyLowDisk(at(96));
      await this.notifyLowDisk(at(91));
      await this.notifyLowDisk(at(96));

      const headlines = email.WARNING_LOW_DISK_SPACE.calls
        .allArgs()
        .map((args) => args[1].headline);
      expect(headlines.length).toEqual(2);
      expect(headlines[0]).toContain("90%");
      expect(headlines[1]).toContain("95%");
    });

    it("does not email for a lower level after a higher one", async function () {
      const at = (percent) => [disk("data", 100 * GB, percent)];

      await this.notifyLowDisk(at(96));
      await this.notifyLowDisk(at(91));

      expect(email.WARNING_LOW_DISK_SPACE.calls.count()).toEqual(1);
      expect(email.WARNING_LOW_DISK_SPACE.calls.argsFor(0)[1].headline).toContain("95%");
      // The lower level's marker expires like the others
      expect(await client.pTTL("notify:data-disk-percent:90")).toBeGreaterThan(0);
    });
  });
});
