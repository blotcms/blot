// Every process registers the ten minute service account refresh (init.js),
// and watchChanges checks for a channel and then creates one, so two
// processes renewing at once could create duplicate channels and webhooks.
// These specs fire the job the way node-schedule does in each process, against
// the real Redis behind helper/lock.
describe("google drive service account refresh", function () {
  const { randomUUID } = require("crypto");
  const config = require("config");
  const client = require("models/client");
  const lock = require("helper/lock");
  const { exclusive } = require("clients/util/scheduleExclusive");

  const stubbed = [
    "./createDriveClient",
    "./fetchStorageInfo",
    "./watchChanges",
  ].map((name) => require.resolve("../" + name.slice(2)));
  const refreshPath = require.resolve("../refreshServiceAccounts");
  const originals = {};
  let originalAccounts;
  let names;
  let watched;
  let gate;

  const stub = (path, exports) => {
    require.cache[path] = { id: path, filename: path, loaded: true, exports };
  };

  beforeEach(function () {
    [...stubbed, refreshPath].forEach(
      (path) => (originals[path] = require.cache[path])
    );
    originalAccounts = config.google_drive.service_accounts;
    config.google_drive.service_accounts = [{ client_id: "test-account" }];
    names = [];
    watched = [];
    gate = null;

    stub(stubbed[0], async () => ({}));
    stub(stubbed[1], async () => {});
    stub(stubbed[2], async (serviceAccountId) => {
      watched.push(serviceAccountId);
      if (gate) await gate;
    });
    delete require.cache[refreshPath];
    spyOn(console, "log");
  });

  afterEach(async function () {
    config.google_drive.service_accounts = originalAccounts;
    [...stubbed, refreshPath].forEach((path) => {
      if (originals[path]) require.cache[path] = originals[path];
      else delete require.cache[path];
    });
    for (const name of names) {
      const found = await client.keys("cron:" + name + ":*");
      if (found.length) await client.del(found);
    }
  });

  const newName = () => {
    const name = "test-google-drive-service-accounts-" + randomUUID();
    names.push(name);
    return name;
  };

  it("renews the watch channel once when two processes fire the same tick", async function () {
    const refresh = require("../refreshServiceAccounts");
    const name = newName();
    const fn = exclusive(name, refresh);
    const fireDate = new Date("2030-01-01T00:10:00.000Z");

    const results = await Promise.all([
      lock.cron._fire(name, fireDate, fn),
      lock.cron._fire(name, fireDate, fn),
    ]);

    expect(results.sort()).toEqual([false, true]);
    expect(watched).toEqual(["test-account"]);
  });

  it("skips a tick while the previous run is still going in another process", async function () {
    const refresh = require("../refreshServiceAccounts");
    const name = newName();
    const fn = exclusive(name, refresh);
    let release;
    gate = new Promise((resolve) => (release = resolve));

    const first = lock.cron._fire(
      name,
      new Date("2030-01-01T00:10:00.000Z"),
      fn
    );
    await new Promise((resolve) => setTimeout(resolve, 100));
    await lock.cron._fire(name, new Date("2030-01-01T00:20:00.000Z"), fn);
    release();
    await first;

    expect(watched).toEqual(["test-account"]);

    // Once the first run is over the lock is free again
    gate = null;
    await lock.cron._fire(name, new Date("2030-01-01T00:30:00.000Z"), fn);
    expect(watched).toEqual(["test-account", "test-account"]);
  });
});
