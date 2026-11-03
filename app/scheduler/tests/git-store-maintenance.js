describe("scheduler git-store-maintenance", function () {
  const schedule = require("node-schedule");
  const lock = require("helper/lock");
  const User = require("models/user");
  const config = require("config");
  const gitStoreMaintenance = require("../git-store-maintenance");

  const indexPath = require.resolve("../index");

  beforeEach(function () {
    this.registered = {};
    this.jobs = [];

    const scheduleJob = schedule.scheduleJob.bind(schedule);
    spyOn(schedule, "scheduleJob").and.callFake((rule, fn) => {
      const job = scheduleJob(rule, fn);
      this.jobs.push(job);
      return job;
    });

    // Keep each job's function, without scheduling it
    spyOn(lock, "cron").and.callFake((name, rule, fn) => {
      this.registered[name] = fn;
      return { cancel() {} };
    });

    spyOn(User, "getAllIds").and.callFake((callback) => callback(null, []));
    delete require.cache[indexPath];
  });

  afterEach(function () {
    this.jobs.forEach((job) => job.cancel());
    delete require.cache[indexPath];
  });

  it("runs in one process when every process fires it", async function () {
    require("../index")();

    const fn = this.registered[gitStoreMaintenance.NAME];
    expect(typeof fn).toBe("function");

    spyOn(gitStoreMaintenance, "job").and.returnValue(Promise.resolve());

    // Four processes fire the same run; a fire date of its own for this spec
    const fireDate = new Date(Date.UTC(2000, 0, 1) + Math.floor(Math.random() * 1e12));
    const fire = () => lock.cron._fire(gitStoreMaintenance.NAME, fireDate, fn);
    const ran = await Promise.all([fire(), fire(), fire(), fire()]);

    expect(ran.filter(Boolean).length).toBe(1);
    expect(gitStoreMaintenance.job).toHaveBeenCalledTimes(1);
  });

  it("does nothing without a bucket", async function () {
    const sendEmail = jasmine.createSpy("sendEmail");
    const bucket = config.storage.bucket;

    try {
      config.storage.bucket = "";
      expect((await gitStoreMaintenance.run({ sendEmail })).skipped).toBe(true);
    } finally {
      config.storage.bucket = bucket;
    }

    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("summarises the findings for the email, by blog ID", function () {
    const view = gitStoreMaintenance.view({
      blogs: 3,
      deepChecked: 1,
      findings: [
        { blog: "blog_a", check: "cheap", kind: "missing", detail: "packs/pack-x.pack" },
        { blog: "blog_a", check: "cheap", kind: "mismatch", detail: "refs differ" },
        { blog: "blog_b", check: "deep", kind: "mismatch", detail: "fsck failed" },
      ],
    });

    expect(view.summary).toBe("1 missing file, 2 mismatches in 2 blogs");
    expect(view.findings.length).toBe(3);
    expect(view.hasMissing).toBe(true);
    expect(view.hasErrors).toBe(false);
  });
});
