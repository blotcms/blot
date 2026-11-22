const resumeTransfersPath = require.resolve("../resumeTransfers");
const initPath = require.resolve("../../init");
const databasePath = require.resolve("../../database");
const initialTransferPath = require.resolve("../initialTransfer");

// A deploy or crash can kill an initial transfer part way, leaving
// transferringToiCloud set. resumeTransfers runs those again, at startup and
// every hour.
describe("icloud resumeTransfers", function () {
  const originals = new Map();
  let accounts;
  let transfer;

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
    delete require.cache[resumeTransfersPath];
    delete require.cache[initPath];
    return require(resumeTransfersPath);
  }

  beforeEach(function () {
    spyOn(console, "log");
    spyOn(console, "error");
    transfer = jasmine.createSpy("initialTransfer").and.resolveTo();
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
      transferring: { transferringToiCloud: true },
      done: { setupComplete: true, transferringToiCloud: false },
    };

    const busy = await load()();

    expect(transfer.calls.allArgs()).toEqual([["transferring"]]);
    expect(busy).toBe(0);
  });

  it("counts a locked transfer and carries on with the rest", async function () {
    accounts = {
      locked: { transferringToiCloud: true },
      failing: { transferringToiCloud: true },
      next: { transferringToiCloud: true },
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

  describe("at startup", function () {
    it("doesn't count as done while a transfer was locked", async function () {
      accounts = { locked: { transferringToiCloud: true } };
      transfer.and.rejectWith(new Error("Failed to acquire folder lock"));
      load();
      const init = require(initPath);

      await expectAsync(init.resumeInitialTransfers()).toBeRejected();
    });

    it("counts as done once every transfer was resumed", async function () {
      accounts = { transferring: { transferringToiCloud: true } };
      load();
      const init = require(initPath);

      await expectAsync(init.resumeInitialTransfers()).toBeResolved();
    });
  });
});
