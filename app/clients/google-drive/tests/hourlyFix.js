const fs = require("fs");
const vm = require("vm");

const MINUTE = 60 * 1000;

function load({ accounts, blogs, lastSync, onFix }) {
  const module = { exports: {} };
  const stubs = {
    "node-schedule": { scheduleJob() {} },
    "helper/clfdate": () => "",
    "sync/fix": (blog, callback) => {
      onFix(blog);
      callback(null);
    },
    "models/blog": {
      get: ({ id }, callback) => callback(null, blogs[id] || null),
      getStatuses: (blogID, options, callback) =>
        callback(null, {
          statuses: lastSync[blogID] ? [{ datestamp: lastSync[blogID] }] : [],
        }),
    },
    "./database": {
      blog: {
        iterate: async (callback) => {
          for (const [blogID, account] of Object.entries(accounts)) {
            await callback(blogID, account);
          }
        },
      },
    },
  };
  vm.runInNewContext(fs.readFileSync(require.resolve("../hourlyFix"), "utf8"), {
    module,
    exports: module.exports,
    console: { log() {}, error() {} },
    require: (name) =>
      Object.prototype.hasOwnProperty.call(stubs, name) ? stubs[name] : require(name),
  });
  return module.exports;
}

describe("Google Drive hourly fix", function () {
  it("fixes only Drive blogs that synced in the last hour", async function () {
    const fixed = [];
    const now = Date.now();
    const account = { folderId: "folder" };

    const { runHourlyFix } = load({
      accounts: {
        recent: account,
        stale: account,
        neverSynced: account,
        switchedClient: account,
        settingUp: { folderId: "folder", preparing: true },
        noFolder: {},
      },
      blogs: {
        recent: { id: "recent", client: "google-drive" },
        stale: { id: "stale", client: "google-drive" },
        neverSynced: { id: "neverSynced", client: "google-drive" },
        switchedClient: { id: "switchedClient", client: "dropbox" },
        settingUp: { id: "settingUp", client: "google-drive" },
        noFolder: { id: "noFolder", client: "google-drive" },
      },
      lastSync: {
        recent: now - 10 * MINUTE,
        stale: now - 90 * MINUTE,
        switchedClient: now,
        settingUp: now,
        noFolder: now,
      },
      onFix: (blog) => fixed.push(blog.id),
    });

    await runHourlyFix();

    expect(fixed).toEqual(["recent"]);
  });
});
