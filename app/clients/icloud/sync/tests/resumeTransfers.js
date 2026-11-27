const resumeTransfersPath = require.resolve("../resumeTransfers");
const initPath = require.resolve("../../init");
const databasePath = require.resolve("../../database");
const initialTransferPath = require.resolve("../initialTransfer");
const blogPath = require.resolve("models/blog");

// A deploy or crash can kill an initial transfer part way, leaving
// transferringToiCloud set. resumeTransfers runs those again, at startup and
// every hour.
const LINK = "https://www.icloud.com/iclouddrive/abc#Blog";

describe("icloud resumeTransfers", function () {
  const originals = new Map();
  let accounts;
  let transfer;
  // Blogs Blog.get finds, by ID; any other is on iCloud
  let blogs;

  function mockModule(modulePath, exportsValue) {
    if (!originals.has(modulePath))
      originals.set(modulePath, require.cache[modulePath]);
    require.cache[modulePath] = {
      id: modulePath,
      filename: modulePath,
      loaded: true,
      exports: exportsValue,
    };
  }

  function load() {
    mockModule(databasePath, {
      iterate: async (callback) => {
        for (const [blogID, account] of Object.entries(accounts))
          await callback(blogID, account);
      },
    });
    mockModule(initialTransferPath, transfer);
    mockModule(blogPath, {
      ...require(blogPath),
      get: async ({ id }) =>
        id in blogs ? blogs[id] : { id, client: "icloud" },
    });
    delete require.cache[resumeTransfersPath];
    delete require.cache[initPath];
    return require(resumeTransfersPath);
  }

  beforeEach(function () {
    spyOn(console, "log");
    spyOn(console, "error");
    blogs = {};
    transfer = jasmine
      .createSpy("initialTransfer")
      .and.callFake(async () => {});
  });

  afterEach(function () {
    originals.forEach(function (cached, modulePath) {
      if (cached) require.cache[modulePath] = cached;
      else delete require.cache[modulePath];
    });
    originals.clear();
    delete require.cache[resumeTransfersPath];
    delete require.cache[initPath];
  });

  it("runs again only the transfers an account marks as running", async function () {
    accounts = {
      transferring: { sharingLink: LINK, transferringToiCloud: true },
      done: { setupComplete: true, transferringToiCloud: false },
    };

    const busy = await load()();

    expect(transfer.calls.allArgs()).toEqual([["transferring"]]);
    expect(busy).toBe(0);
  });

  it("counts a locked transfer and carries on with the rest", async function () {
    accounts = {
      locked: { sharingLink: LINK, transferringToiCloud: true },
      failing: { sharingLink: LINK, transferringToiCloud: true },
      next: { sharingLink: LINK, transferringToiCloud: true },
    };
    transfer.and.callFake(async (blogID) => {
      if (blogID === "locked") throw new Error("Failed to acquire folder lock");
      if (blogID === "failing") throw new Error("macserver down");
    });

    const busy = await load()();

    expect(transfer.calls.allArgs()).toEqual([
      ["locked"],
      ["failing"],
      ["next"],
    ]);
    expect(busy).toBe(1);
  });

  it("leaves alone a transfer whose blog is no longer connected", async function () {
    accounts = {
      // A disconnect deleted the account, then something wrote part of it back
      ghost: { transferringToiCloud: true },
      removed: { sharingLink: LINK, transferringToiCloud: true },
      switched: { sharingLink: LINK, transferringToiCloud: true },
      connected: { sharingLink: LINK, transferringToiCloud: true },
    };
    blogs = { removed: null, switched: { id: "switched", client: "dropbox" } };

    const busy = await load()();

    expect(transfer.calls.allArgs()).toEqual([["connected"]]);
    expect(busy).toBe(0);
  });

  describe("at startup", function () {
    it("doesn't count as done while a transfer was locked", async function () {
      accounts = { locked: { sharingLink: LINK, transferringToiCloud: true } };
      transfer.and.callFake(async () => {
        throw new Error("Failed to acquire folder lock");
      });
      load();
      const init = require(initPath);

      await expectAsync(init.resumeInitialTransfers()).toBeRejected();
    });

    it("counts as done once every transfer was resumed", async function () {
      accounts = {
        transferring: { sharingLink: LINK, transferringToiCloud: true },
      };
      load();
      const init = require(initPath);

      await expectAsync(init.resumeInitialTransfers()).toBeResolved();
    });
  });
});
