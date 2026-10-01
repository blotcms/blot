const fs = require("fs-extra");
const { join } = require("path");
const localPath = require("helper/localPath");

const fromiCloudPath = require.resolve("../fromiCloud");
const remoteRecursiveListPath = require.resolve("../util/remoteRecursiveList");
const remoteReaddirPath = require.resolve("../util/remoteReaddir");
const downloadPath = require.resolve("../util/download");
const checkWeCanContinuePath = require.resolve("../util/checkWeCanContinue");
const databasePath = require.resolve("../../database");

describe("icloud fromiCloud sync", function () {
  test.timeout(10000);

  const originals = new Map();

  const mockModule = (modulePath, exportsValue) => {
    if (!originals.has(modulePath)) {
      const cached = require.cache[modulePath];
      originals.set(modulePath, cached ? cached.exports : undefined);
    }

    require.cache[modulePath] = {
      id: modulePath,
      filename: modulePath,
      loaded: true,
      exports: exportsValue,
    };
  };

  const restoreModules = () => {
    for (const [modulePath, exportsValue] of originals.entries()) {
      if (typeof exportsValue === "undefined") {
        delete require.cache[modulePath];
      } else if (require.cache[modulePath]) {
        require.cache[modulePath].exports = exportsValue;
      } else {
        require.cache[modulePath] = {
          id: modulePath,
          filename: modulePath,
          loaded: true,
          exports: exportsValue,
        };
      }
    }

    originals.clear();
    delete require.cache[fromiCloudPath];
  };

  let blogID;

  beforeEach(async () => {
    blogID = `icloud-test-${Date.now()}-${Math.floor(Math.random() * 10000)}`;
    await fs.ensureDir(localPath(blogID, "/"));
    // Other icloud specs (e.g. getHealth) require the client module, which
    // caches fromiCloud with its real dependencies. Drop that so each test
    // can inject mocks before loading fromiCloud.
    delete require.cache[fromiCloudPath];
  });

  afterEach(async () => {
    restoreModules();
    await fs.remove(localPath(blogID, "/"));
  });

  it("creates a 0-byte placeholder when an oversized remote file is missing locally", async () => {
    const remoteFile = {
      name: "huge.mov",
      size: 1000 * 1000 * 1000,
      isDirectory: false,
    };

    mockModule(remoteRecursiveListPath, async () => {});
    mockModule(remoteReaddirPath, async () => [remoteFile]);
    mockModule(downloadPath, async () => {
      throw new Error("download should not be called for oversized files");
    });
    mockModule(checkWeCanContinuePath, () => async () => {});
    mockModule(databasePath, {
      store: async () => {},
      get: async () => ({ setupComplete: true }),
    });

    const fromiCloud = require(fromiCloudPath);
    const published = [];
    const summary = await fromiCloud(
      blogID,
      (...args) => published.push(args.join(" ")),
      async () => {}
    );

    const oversizedPath = localPath(blogID, join("/", remoteFile.name));
    const stat = await fs.stat(oversizedPath);

    expect(stat.size).toBe(0);
    expect(summary.skipped).toBe(1);
    expect(summary.placeholdersCreated).toBe(1);
    expect(
      published.some((line) =>
        line.includes("Created placeholder for oversized file")
      )
    ).toBe(true);
    expect(published).toContain(
      "(1/1) File too large /huge.mov (1000000000 bytes > 100000000 byte limit)"
    );
    expect(published).toContain("(1/1) Finished processing folder");
  });

  it("replaces mismatched local content with a 0-byte placeholder for oversized remote files", async () => {
    const remoteFile = {
      name: "archive.zip",
      size: 1000 * 1000 * 1000,
      isDirectory: false,
    };
    const localFile = localPath(blogID, join("/", remoteFile.name));

    await fs.outputFile(localFile, "existing local content");

    mockModule(remoteRecursiveListPath, async () => {});
    mockModule(remoteReaddirPath, async () => [remoteFile]);
    mockModule(downloadPath, async () => {
      throw new Error("download should not be called for oversized files");
    });
    mockModule(checkWeCanContinuePath, () => async () => {});
    mockModule(databasePath, {
      store: async () => {},
      get: async () => ({ setupComplete: true }),
    });

    const fromiCloud = require(fromiCloudPath);
    const summary = await fromiCloud(
      blogID,
      () => {},
      async () => {}
    );

    const stat = await fs.stat(localFile);

    expect(stat.size).toBe(0);
    expect(summary.skipped).toBe(1);
    expect(summary.placeholdersCreated).toBe(1);
  });

  it("does not remove local files when remoteReaddir fails (partial/unconfirmed listing)", async () => {
    const localFile = localPath(blogID, join("/", "post.txt"));
    await fs.outputFile(localFile, "hello world");

    mockModule(remoteRecursiveListPath, async () => {});
    mockModule(remoteReaddirPath, async () => {
      throw new Error("Directory listing unavailable: iCloud has not synced it yet");
    });
    mockModule(checkWeCanContinuePath, () => async () => {});
    mockModule(databasePath, {
      store: async () => {},
      get: async () => ({ setupComplete: true }),
    });

    const fromiCloud = require(fromiCloudPath);
    const published = [];
    const summary = await fromiCloud(
      blogID,
      (...args) => published.push(args.join(" ")),
      async () => {}
    );

    const stat = await fs.stat(localFile);

    expect(stat.isFile()).toBe(true);
    expect(summary.removed).toBe(0);
    expect(published.some((line) => line.includes("Sync failed"))).toBe(true);
  });

  it("clears a stored error after a successful sync of a set-up blog", async () => {
    const store = jasmine.createSpy("store").and.returnValue(Promise.resolve());

    mockModule(remoteRecursiveListPath, async () => {});
    mockModule(remoteReaddirPath, async () => []);
    mockModule(downloadPath, async () => {});
    mockModule(checkWeCanContinuePath, () => async () => {});
    mockModule(databasePath, {
      store,
      get: async () => ({
        setupComplete: true,
        error: "Blog directory deleted",
      }),
    });

    const fromiCloud = require(fromiCloudPath);
    await fromiCloud(blogID, () => {}, async () => {});

    expect(store).toHaveBeenCalledWith(blogID, { error: null });
  });

  it("does not clear a stored error when setup is incomplete", async () => {
    const store = jasmine.createSpy("store").and.returnValue(Promise.resolve());

    mockModule(remoteRecursiveListPath, async () => {});
    mockModule(remoteReaddirPath, async () => []);
    mockModule(downloadPath, async () => {});
    mockModule(checkWeCanContinuePath, () => async () => {});
    mockModule(databasePath, {
      store,
      get: async () => ({
        setupComplete: false,
        error: "Transfer failed",
      }),
    });

    const fromiCloud = require(fromiCloudPath);
    await fromiCloud(blogID, () => {}, async () => {});

    expect(store).not.toHaveBeenCalled();
  });

  it("does not clear a stored error when sync fails", async () => {
    const store = jasmine.createSpy("store").and.returnValue(Promise.resolve());

    mockModule(remoteRecursiveListPath, async () => {});
    mockModule(remoteReaddirPath, async () => {
      throw new Error("Folder does not exist");
    });
    mockModule(downloadPath, async () => {});
    mockModule(checkWeCanContinuePath, () => async () => {});
    mockModule(databasePath, {
      store,
      get: async () => ({
        setupComplete: true,
        error: "Blog directory deleted",
      }),
    });

    const fromiCloud = require(fromiCloudPath);
    await fromiCloud(blogID, () => {}, async () => {});

    expect(store).not.toHaveBeenCalled();
  });
});
