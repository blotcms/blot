// The macserver stats check runs in one process per minute, but which
// notifications have gone out is remembered in Redis, so a second call (from
// this or any other process) must not email again, and a recovery must reset
// the "down" marker so the next outage notifies.
describe("icloud monitorMacServerStats", function () {
  const paths = {
    monitor: require.resolve("../util/monitorMacServerStats"),
    fetch: require.resolve("../util/rateLimitedFetchWithRetriesAndTimeout"),
    email: require.resolve("helper/email"),
    redis: require.resolve("models/client"),
    lockHelper: require.resolve("helper/lock"),
    scheduleExclusive: require.resolve("clients/util/scheduleExclusive"),
  };
  const originals = {};
  const config = require("config");

  let keys, sent, response;

  const stub = (name, exports) => {
    require.cache[paths[name]] = {
      id: paths[name],
      filename: paths[name],
      loaded: true,
      exports,
    };
  };

  beforeEach(function () {
    Object.keys(paths).forEach((name) => (originals[name] = require.cache[paths[name]]));
    keys = new Set();
    sent = [];
    response = null;

    // Fake of the two Redis commands used: SET NX and DEL
    stub("redis", {
      del: async (key) => (keys.delete(key) ? 1 : 0),
    });
    stub("lockHelper", {
      once: async (key) => {
        if (keys.has(key)) return false;
        keys.add(key);
        return true;
      },
    });
    stub("scheduleExclusive", { schedule: () => ({ cancel() {} }) });
    stub("fetch", async () => {
      if (response instanceof Error) throw response;
      return Buffer.from(JSON.stringify(response ?? null));
    });
    const record = (name) => (...args) => sent.push(name);
    stub("email", {
      ICLOUD_SERVER_DOWN: record("down"),
      ICLOUD_SERVER_RECOVERED: record("recovered"),
      ICLOUD_DISK_LIMIT: record("disk-limit"),
      ICLOUD_APPROACHING_DISK_LIMIT: record("disk-warning"),
      ICLOUD_QUOTA_LIMIT: record("quota-limit"),
      ICLOUD_APPROACHING_QUOTA_LIMIT: record("quota-warning"),
    });

    delete require.cache[paths.monitor];
    spyOn(console, "log");
    spyOn(console, "error");
  });

  afterEach(function () {
    Object.keys(paths).forEach((name) => {
      if (originals[name]) require.cache[paths[name]] = originals[name];
      else delete require.cache[paths[name]];
    });
  });

  const healthy = () => ({
    disk_bytes_available: config.icloud.diskSpaceWarning * 10,
    icloud_bytes_available: config.icloud.iCloudSpaceWarning * 10,
  });

  it("emails a low-disk warning once across repeated checks", async function () {
    const { check } = require("../util/monitorMacServerStats");
    response = Object.assign(healthy(), {
      disk_bytes_available: config.icloud.diskSpaceLimit / 2,
    });

    await check();
    await check();

    expect(sent).toEqual(["disk-limit"]);
  });

  it("emails the warning tier and the quota tier independently", async function () {
    const { check } = require("../util/monitorMacServerStats");
    response = {
      disk_bytes_available: (config.icloud.diskSpaceLimit + config.icloud.diskSpaceWarning) / 2,
      icloud_bytes_available: config.icloud.iCloudSpaceLimit / 2,
    };

    await check();
    await check();

    expect(sent.sort()).toEqual(["disk-warning", "quota-limit"]);
  });

  it("emails server down once, then recovery once, then down again for the next outage", async function () {
    const { check } = require("../util/monitorMacServerStats");

    response = new Error("connection refused");
    await check();
    await check();
    expect(sent).toEqual(["down"]);

    response = healthy();
    await check();
    await check();
    expect(sent).toEqual(["down", "recovered"]);

    response = new Error("connection refused");
    await check();
    expect(sent).toEqual(["down", "recovered", "down"]);
  });

  it("does not email server down when the macserver could not read the iCloud quota", async function () {
    const { check } = require("../util/monitorMacServerStats");
    response = Object.assign(healthy(), { icloud_bytes_available: null });

    await check();

    expect(sent).toEqual([]);
  });

  it("still announces recovery when the first good reply has no iCloud quota", async function () {
    const { check } = require("../util/monitorMacServerStats");

    response = new Error("connection refused");
    await check();
    response = Object.assign(healthy(), { icloud_bytes_available: null });
    await check();

    expect(sent).toEqual(["down", "recovered"]);
  });

  it("does not email server down when /stats is fine but Redis fails", async function () {
    stub("redis", {
      del: async () => {
        throw new Error("redis unavailable");
      },
    });
    delete require.cache[paths.monitor];
    const monitor = require("../util/monitorMacServerStats");
    response = healthy();

    await monitor.check();

    expect(sent).toEqual([]);
  });

  it("registers a per-minute cron job", function () {
    let registered;
    stub("scheduleExclusive", {
      schedule: (name, rule) => {
        registered = { name, rule };
        return { cancel() {} };
      },
    });
    delete require.cache[paths.monitor];

    require("../util/monitorMacServerStats")();

    expect(registered).toEqual({
      name: "icloud-macserver-stats",
      rule: "* * * * *",
    });
  });
});
