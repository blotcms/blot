describe("dropbox setup abort", function () {
  const setupPath = require.resolve("clients/dropbox/routes/setup");
  const syncPath = require.resolve("sync");
  const getAccountPath =
    require.resolve("clients/dropbox/routes/setup/getAccount");
  const createFolderPath =
    require.resolve("clients/dropbox/routes/setup/createFolder");
  const resetPath = require.resolve("clients/dropbox/sync/reset-from-blot");
  const resetToBlotPath = require.resolve("clients/dropbox/sync/reset-to-blot");
  const databasePath = require.resolve("clients/dropbox/database");
  const paths = [
    setupPath,
    syncPath,
    getAccountPath,
    createFolderPath,
    resetPath,
    resetToBlotPath,
    databasePath,
  ];

  const originals = {};
  let controller, events, saved;

  beforeEach(function () {
    paths.forEach((path) => (originals[path] = require.cache[path]));
    controller = new AbortController();
    events = [];
    saved = [];
  });

  afterEach(function () {
    paths.forEach((path) => {
      if (originals[path]) require.cache[path] = originals[path];
      else delete require.cache[path];
    });
  });

  // The sync stub hands setup a folder whose signal the spec aborts, as a
  // disconnect's seize (sync/seize.js) does
  function loadSetup(stubs = {}) {
    require.cache[syncPath] = {
      exports: async function (_blogID, fn) {
        try {
          return await fn({
            signal: controller.signal,
            status: () => {},
            update: async () => {},
          });
        } finally {
          events.push("released");
        }
      },
    };
    require.cache[getAccountPath] = {
      exports: stubs.getAccount || (async (account) => account),
    };
    require.cache[createFolderPath] = {
      exports: stubs.createFolder || (async (account) => account),
    };
    require.cache[resetPath] = { exports: async function () {} };
    require.cache[resetToBlotPath] = {
      exports: stubs.resetToBlot || async function () {},
    };
    require.cache[databasePath] = {
      exports: {
        get: async () => null,
        listBlogs: async () => [],
        set: async (blogID, changes) => saved.push(changes),
      },
    };
    delete require.cache[setupPath];
    return require("clients/dropbox/routes/setup");
  }

  it("finishes and clears the session", async function () {
    const setup = loadSetup();
    const session = { dropbox: {}, save: jasmine.createSpy("save") };

    await setup({ blog: { id: "blog_1" } }, session);

    expect(session.dropbox).toBeUndefined();
    expect(events).toEqual(["released"]);
  });

  it("stops straight away when the signal aborts during a step", async function () {
    let releaseAccount;
    const setup = loadSetup({
      getAccount: (account) =>
        new Promise((resolve) => (releaseAccount = () => resolve(account))),
    });
    const session = { dropbox: {}, save: () => {} };

    const result = setup({ blog: { id: "blog_1" } }, session).catch(
      (err) => err
    );

    await new Promise((resolve) => setTimeout(resolve, 0));
    controller.abort();

    const err = await result;
    expect(err.message).toBe("Dropbox setup aborted");
    expect(session.dropbox).toBeUndefined();
    // The step still running writes nothing once it ends
    releaseAccount();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(saved).toEqual([]);
  });

  it("keeps the lock until the reused folder's walk has stopped", async function () {
    let walkStarted, stopWalk;
    const started = new Promise((resolve) => (walkStarted = resolve));

    const setup = loadSetup({
      createFolder: async (account) =>
        Object.assign(account, { folder_id: "id:old", reused_folder: true }),
      resetToBlot: (blogID, publish, update, signal) =>
        new Promise(function (resolve, reject) {
          walkStarted();
          stopWalk = function () {
            events.push("walk stopped");
            const error = new Error("aborted");
            error.name = "AbortError";
            if (signal.aborted) reject(error);
            else resolve();
          };
        }),
    });

    let settled = false;
    const session = { dropbox: {}, save: () => {} };
    const result = setup({ blog: { id: "blog_1" } }, session).then(
      () => (settled = "resolved"),
      (err) => (settled = err.message)
    );

    await started;
    controller.abort();
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(settled).toBe(false);
    expect(events).toEqual([]);

    stopWalk();
    await result;

    expect(settled).toBe("Dropbox setup aborted");
    expect(events).toEqual(["walk stopped", "released"]);
    // So a retry of this transfer stays keepDropbox (createFolder.js)
    expect(saved[0].reused_folder).toBe(true);
  });
});
