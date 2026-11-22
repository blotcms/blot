const fs = require("fs");
const vm = require("vm");

// Loads routes/setup.js with its dependencies stubbed, around one stored
// account. lockErrors are what each attempt to take the folder lock throws,
// in turn, before one succeeds.
function load({ account, lockErrors = [], draining = false }) {
  const module = { exports: {} };
  const accounts = { blog_a: account };
  const events = [];

  const stubs = {
    "helper/clfdate": () => "",
    "helper/drain": { isDraining: () => draining },
    config: { google_drive: { service_accounts: [] } },
    "../sync/resetToDrive": async () => {
      events.push("copy");
    },
    "sync/establishSyncLock": async () => {
      if (lockErrors.length) {
        events.push("lock busy");
        throw lockErrors.shift();
      }
      events.push("lock");
      return {
        folder: { status() {} },
        done: async () => events.push("release"),
      };
    },
    "../serviceAccount/createDriveClient": async () => ({
      files: {
        list: async () => {
          events.push("list");
          return { data: { files: [] } };
        },
      },
    }),
    "models/blog": { get: async ({ id }) => ({ id }) },
    "../database": {
      blog: {
        get: async (id) => accounts[id] && { ...accounts[id] },
        update: async (id, data) => {
          if (!accounts[id]) return false;
          events.push("store " + Object.keys(data).join(","));
          Object.assign(accounts[id], data);
          return true;
        },
        iterate: async (fn) => {
          for (const id of Object.keys(accounts)) await fn(id, accounts[id]);
        },
      },
    },
  };

  vm.runInNewContext(
    fs.readFileSync(require.resolve("../routes/setup"), "utf8"),
    {
      module,
      exports: module.exports,
      console: { log() {}, error() {} },
      setTimeout,
      require: (name) =>
        Object.prototype.hasOwnProperty.call(stubs, name)
          ? stubs[name]
          : require(name),
    }
  );

  return { setup: module.exports, accounts, events };
}

// A setup that had its folder and was copying the site's files into it
const copying = () => ({
  email: "a@example.com",
  serviceAccountId: "sa",
  preparing: true,
  startedSetup: Date.now(),
  folderId: "f1",
  folderName: "Blog",
});

const lockError = () =>
  new Error("Failed to acquire folder lock", {
    cause: Object.assign(new Error("Shutting down"), { code: "ELOCKED" }),
  });

describe("google drive setup across a restart", function () {
  it("resumes a copy a restart interrupted, keeping its folder", async function () {
    const { setup, accounts, events } = load({ account: copying() });

    await setup.restartSetupProcesses();

    // The folder isn't looked for again: it is no longer empty
    expect(events).toEqual(["lock", "copy", "store preparing", "release"]);
    expect(accounts.blog_a.preparing).toBe(false);
    expect(accounts.blog_a.folderId).toBe("f1");
  });

  it("leaves the setup for the next process when this one is draining", async function () {
    const account = copying();
    const before = { ...account };
    const { setup, accounts, events } = load({
      account,
      lockErrors: [lockError()],
      draining: true,
    });

    await setup({ id: "blog_a" }, await stubDrive(), "a@example.com", "sa");

    expect(events).toEqual(["lock busy"]);
    expect(accounts.blog_a).toEqual(before);
  });

  it("leaves the account alone when a newer setup has replaced this one", async function () {
    const account = { ...copying(), email: "b@example.com" };
    const { setup, accounts, events } = load({ account });

    await setup({ id: "blog_a" }, await stubDrive(), "a@example.com", "sa");

    expect(events).toEqual([]);
    expect(accounts.blog_a.folderId).toBe("f1");
    expect(accounts.blog_a.error).toBeUndefined();
  });

  it("stops without writing once another process has finished the setup", async function () {
    const account = { ...copying(), preparing: false };
    const { setup, accounts, events } = load({ account });

    await setup({ id: "blog_a" }, await stubDrive(), "a@example.com", "sa");

    expect(events).toEqual([]);
    expect(accounts.blog_a.folderId).toBe("f1");
  });

  it("marks connected a blog an old setup left preparing, which has synced since", async function () {
    // Before #2922 syncs ignored preparing, so this blog synced for days
    const startedSetup = Date.UTC(2026, 10, 17);
    const account = { ...copying(), startedSetup, lastSync: Date.now() };
    const { setup, accounts, events } = load({ account });

    await setup.restartSetupProcesses();

    expect(events).toEqual([
      "store preparing,nonEmptyFolderShared,nonEditorPermissions",
    ]);
    expect(accounts.blog_a.preparing).toBe(false);
    expect(accounts.blog_a.folderId).toBe("f1");
    expect(accounts.blog_a.folderName).toBe("Blog");
    expect(accounts.blog_a.error).toBeUndefined();
  });

  it("resumes the copy of a setup started since #2922, whatever its lastSync", async function () {
    // The hot doc poller could stamp lastSync during setup until #2930
    const startedSetup = Date.UTC(2026, 10, 22, 11);
    const account = { ...copying(), startedSetup, lastSync: startedSetup + 1 };
    const { setup, accounts, events } = load({ account });

    await setup.restartSetupProcesses();

    expect(events).toEqual(["lock", "copy", "store preparing", "release"]);
    expect(accounts.blog_a.folderId).toBe("f1");
  });

  it("keeps resuming a copy that has never synced, however old", async function () {
    // A lastSync from before this setup started is the old folder's
    const startedSetup = Date.now() - 5 * 24 * 3600e3;
    const account = {
      ...copying(),
      startedSetup,
      lastSync: startedSetup - 1000,
    };
    const { setup, accounts, events } = load({ account });

    await setup.restartSetupProcesses();

    expect(events).toEqual(["lock", "copy", "store preparing", "release"]);
    expect(accounts.blog_a.preparing).toBe(false);
    expect(accounts.blog_a.folderId).toBe("f1");
    expect(accounts.blog_a.error).toBeUndefined();
  });

  it("still fails a setup that timed out waiting for a folder", async function () {
    const account = {
      ...copying(),
      folderId: null,
      folderName: null,
      startedSetup: Date.now() - 3 * 3600e3,
    };
    const { setup, accounts } = load({ account });

    await setup({ id: "blog_a" }, await stubDrive(), "a@example.com", "sa");

    expect(accounts.blog_a.error).toBeTruthy();
    expect(accounts.blog_a.folderId).toBe(null);
  });

  it("times out the wait for a folder, never the copy", function () {
    const { timedOut } = load({ account: copying() }).setup;
    const longAgo = Date.now() - 30 * 24 * 3600e3;
    expect(timedOut({ startedSetup: longAgo })).toBe(true);
    expect(timedOut({ startedSetup: longAgo, folderId: "f1" })).toBe(false);
  });
});

async function stubDrive() {
  return { files: { list: async () => ({ data: { files: [] } }) } };
}
