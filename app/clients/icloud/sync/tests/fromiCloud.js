const { join } = require("path");
const folder = require("storage/folder");

const fromiCloudPath = require.resolve("../fromiCloud");
const remoteRecursiveListPath = require.resolve("../util/remoteRecursiveList");
const remoteReaddirPath = require.resolve("../util/remoteReaddir");
const localReaddirPath = require.resolve("../util/localReaddir");
const downloadPath = require.resolve("../util/download");
const checkWeCanContinuePath = require.resolve("../util/checkWeCanContinue");
const databasePath = require.resolve("../../database");
const countChanges = require("clients/util/countChanges");

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
    // Other icloud specs (e.g. getHealth) require the client module, which
    // caches fromiCloud with its real dependencies. Drop that so each test
    // can inject mocks before loading fromiCloud.
    delete require.cache[fromiCloudPath];
  });

  afterEach(async () => {
    restoreModules();
    await folder.removeAll(blogID);
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

    const stat = await folder.stat(blogID, join("/", remoteFile.name));

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
    const localFile = join("/", remoteFile.name);

    await folder.write(blogID, localFile, "existing local content");

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

    const stat = await folder.stat(blogID, localFile);

    expect(stat.size).toBe(0);
    expect(summary.skipped).toBe(1);
    expect(summary.placeholdersCreated).toBe(1);
  });

  it("replaces a placeholder when the file in iCloud is now really empty", async () => {
    const localFile = "/was-huge.mov";
    await folder.writePlaceholder(blogID, localFile, {
      code: "SYNC_TOO_LARGE",
      size: 1000 * 1000 * 1000,
      limit: 100,
    });

    mockModule(remoteRecursiveListPath, async () => {});
    mockModule(remoteReaddirPath, async () => [
      { name: "was-huge.mov", size: 0, isDirectory: false },
    ]);
    mockModule(downloadPath, async (id, path) => {
      await folder.write(id, path, "");
    });
    mockModule(checkWeCanContinuePath, () => async () => {});
    mockModule(databasePath, {
      store: async () => {},
      get: async () => ({ setupComplete: true }),
    });

    await require(fromiCloudPath)(
      blogID,
      () => {},
      async () => {}
    );

    expect(await folder.isPlaceholder(blogID, localFile)).toBe(false);
    expect(await folder.exists(blogID, localFile)).toBe(true);
  });

  describe("oversized remote files", () => {
    const remoteFile = {
      name: "huge.mov",
      size: 1000 * 1000 * 1000,
      isDirectory: false,
    };

    const run = async () => {
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

      const updated = [];
      const summary = await require(fromiCloudPath)(
        blogID,
        () => {},
        async (path) => {
          updated.push(path);
        }
      );

      return { summary, updated };
    };

    it("registers a newly written placeholder with update", async () => {
      const { summary, updated } = await run();

      expect((await folder.stat(blogID, join("/", remoteFile.name))).size).toBe(
        0
      );
      expect(summary.placeholdersCreated).toBe(1);
      expect(updated).toEqual(["/huge.mov"]);
    });

    it("leaves an existing empty placeholder in place, flagging it if it isn't", async () => {
      const localFile = join("/", remoteFile.name);
      await folder.write(blogID, localFile, "");
      const write = spyOn(folder, "write").and.callThrough();
      const writePlaceholder = spyOn(
        folder,
        "writePlaceholder"
      ).and.callThrough();

      const { summary, updated } = await run();

      expect(write).not.toHaveBeenCalled();
      expect(writePlaceholder).not.toHaveBeenCalled();
      expect((await folder.stat(blogID, localFile)).placeholder).toBe(true);
      expect(updated).toEqual([]);
      expect(summary.skipped).toBe(0);
      expect(summary.placeholdersCreated).toBe(0);
      expect(summary.failed).toBe(0);
    });

    it("truncates a non-empty local file to a placeholder and registers it", async () => {
      const localFile = join("/", remoteFile.name);
      await folder.write(blogID, localFile, "existing local content");

      const { summary, updated } = await run();

      expect((await folder.stat(blogID, localFile)).size).toBe(0);
      expect(summary.placeholdersCreated).toBe(1);
      expect(updated).toEqual(["/huge.mov"]);
    });

    it("counts a failed update as a failure", async () => {
      mockModule(remoteRecursiveListPath, async () => {});
      mockModule(remoteReaddirPath, async () => [remoteFile]);
      mockModule(checkWeCanContinuePath, () => async () => {});
      mockModule(databasePath, {
        store: async () => {},
        get: async () => ({ setupComplete: true }),
      });

      const summary = await require(fromiCloudPath)(
        blogID,
        () => {},
        async () => {
          throw new Error("update failed");
        }
      );

      expect(summary.failed).toBe(1);
      expect(summary.firstError).toBe("update failed");
    });
  });

  it("does not remove local files when remoteReaddir fails (partial/unconfirmed listing)", async () => {
    const localFile = join("/", "post.txt");
    await folder.write(blogID, localFile, "hello world");

    mockModule(remoteRecursiveListPath, async () => {});
    mockModule(remoteReaddirPath, async () => {
      throw new Error(
        "Directory listing unavailable: iCloud has not synced it yet"
      );
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

    const stat = await folder.stat(blogID, localFile);

    expect(stat.isDirectory).toBe(false);
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
        error: "Something unexpected",
        errorCode: "SYNC_ERROR",
        errorSince: Date.now() - 60 * 1000,
      }),
    });

    const fromiCloud = require(fromiCloudPath);
    await fromiCloud(
      blogID,
      () => {},
      async () => {}
    );

    expect(store).toHaveBeenCalledWith(blogID, { error: null });
  });

  async function storeCallsForWalk(account) {
    const store = jasmine.createSpy("store").and.returnValue(Promise.resolve());

    mockModule(remoteRecursiveListPath, async () => {});
    mockModule(remoteReaddirPath, async () => []);
    mockModule(downloadPath, async () => {});
    mockModule(checkWeCanContinuePath, () => async () => {});
    mockModule(databasePath, { store, get: async () => account });

    const fromiCloud = require(fromiCloudPath);
    await fromiCloud(
      blogID,
      () => {},
      async () => {}
    );

    return store;
  }

  it("does not clear SOURCE_MISSING after a successful walk", async () => {
    const store = await storeCallsForWalk({
      setupComplete: true,
      error: "Blog directory deleted",
      errorCode: "SOURCE_MISSING",
      errorSince: Date.now() - 60 * 1000,
    });

    expect(store).not.toHaveBeenCalled();
  });

  it("does not clear an error recorded after the walk began", async () => {
    const store = await storeCallsForWalk({
      setupComplete: true,
      error: "Something unexpected",
      errorCode: "SYNC_ERROR",
      errorSince: Date.now() + 1000,
    });

    expect(store).not.toHaveBeenCalled();
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
    await fromiCloud(
      blogID,
      () => {},
      async () => {}
    );

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
    await fromiCloud(
      blogID,
      () => {},
      async () => {}
    );

    expect(store).not.toHaveBeenCalled();
  });

  it("excludes a download modified around or after the walk started from modifiedDuringWalk", async () => {
    const remoteFile = {
      name: "live-edit.txt",
      size: 5,
      isDirectory: false,
      // Within the 30s grace period before the walk started
      modifiedTime: new Date(Date.now() - 3000).toISOString(),
    };

    mockModule(remoteRecursiveListPath, async () => {});
    mockModule(remoteReaddirPath, async () => [remoteFile]);
    mockModule(downloadPath, async () => {});
    mockModule(checkWeCanContinuePath, () => async () => {});
    mockModule(databasePath, { store: async () => {} });

    const fromiCloud = require(fromiCloudPath);
    const summary = await fromiCloud(
      blogID,
      () => {},
      async () => {}
    );

    expect(summary.downloaded).toBe(1);
    expect(summary.modifiedDuringWalk).toBe(1);
  });

  it("counts a download modified well before the walk started as a missed change", async () => {
    const remoteFile = {
      name: "missed-change.txt",
      size: 5,
      isDirectory: false,
      modifiedTime: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
    };

    mockModule(remoteRecursiveListPath, async () => {});
    mockModule(remoteReaddirPath, async () => [remoteFile]);
    mockModule(downloadPath, async () => {});
    mockModule(checkWeCanContinuePath, () => async () => {});
    mockModule(databasePath, { store: async () => {} });

    const fromiCloud = require(fromiCloudPath);
    const summary = await fromiCloud(
      blogID,
      () => {},
      async () => {}
    );

    expect(summary.downloaded).toBe(1);
    expect(summary.modifiedDuringWalk).toBe(0);
  });

  function mockWalk(remoteContents) {
    mockModule(remoteRecursiveListPath, async () => {});
    mockModule(remoteReaddirPath, async () => remoteContents);
    mockModule(downloadPath, async () => {});
    mockModule(checkWeCanContinuePath, () => async () => {});
    mockModule(databasePath, { store: async () => {}, get: async () => ({}) });
  }

  const remoteFile = (name) => ({ name, size: 1, isDirectory: false });

  describe("failure signal", () => {
    it("reports no failures for a clean walk", async () => {
      mockWalk([]);

      const summary = await require(fromiCloudPath)(
        blogID,
        () => {},
        async () => {}
      );

      expect(summary.failed).toBe(0);
      expect(summary.firstError).toBeNull();
    });

    it("counts a failed folder tree listing without stopping the walk", async () => {
      mockWalk([]);
      mockModule(remoteRecursiveListPath, async () => {
        throw new Error("macserver unreachable");
      });
      spyOn(console, "error");

      const summary = await require(fromiCloudPath)(
        blogID,
        () => {},
        async () => {}
      );

      expect(summary.failed).toBe(1);
      expect(summary.firstError).toBe("macserver unreachable");
    });

    it("counts every failed download and keeps the first message", async () => {
      mockWalk([remoteFile("a.txt"), remoteFile("b.txt"), remoteFile("c.txt")]);
      let calls = 0;
      mockModule(downloadPath, async () => {
        calls += 1;
        if (calls < 3) throw new Error("download " + calls + " failed");
      });

      const summary = await require(fromiCloudPath)(
        blogID,
        () => {},
        async () => {}
      );

      expect(summary.failed).toBe(2);
      expect(summary.firstError).toBe("download 1 failed");
      expect(summary.downloaded).toBe(1);
    });

    it("counts an oversized-file placeholder that could not be written", async () => {
      mockWalk([
        { name: "huge.mov", size: 1000 * 1000 * 1000, isDirectory: false },
      ]);
      spyOn(folder, "writePlaceholder").and.callFake(async () => {
        throw new Error("disk full");
      });

      const summary = await require(fromiCloudPath)(
        blogID,
        () => {},
        async () => {}
      );

      expect(summary.placeholdersCreated).toBe(0);
      expect(summary.failed).toBe(1);
      expect(summary.firstError).toBe("disk full");
    });

    it("counts a directory listing that fails", async () => {
      mockWalk([]);
      mockModule(remoteReaddirPath, async () => {
        throw new Error("Directory listing unavailable");
      });

      const summary = await require(fromiCloudPath)(
        blogID,
        () => {},
        async () => {}
      );

      expect(summary.failed).toBe(1);
      expect(summary.firstError).toBe("Directory listing unavailable");
    });
  });
  describe("removals and created directories in a directory modified around the walk", () => {
    const recent = () => new Date(Date.now() - 3000).toISOString();
    const anHourAgo = () => new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const dir = (name, modifiedTime) => ({
      name,
      isDirectory: true,
      modifiedTime,
    });

    // listings maps a directory path to what the macserver reports for it
    async function walk(listings) {
      mockModule(remoteRecursiveListPath, async () => {});
      mockModule(remoteReaddirPath, async (_, path) => listings[path] || []);
      mockModule(downloadPath, async () => {});
      mockModule(checkWeCanContinuePath, () => async () => {});
      mockModule(databasePath, {
        store: async () => {},
        get: async () => ({}),
      });

      return require(fromiCloudPath)(
        blogID,
        () => {},
        async () => {}
      );
    }

    // A rename (untitled folder -> inactive) in /pages/projects, which
    // updates that directory's mtime
    const renameIn = (projectsModifiedTime) => ({
      "/": [dir("pages", anHourAgo())],
      "/pages": [dir("projects", projectsModifiedTime)],
      "/pages/projects": [dir("inactive", recent())],
    });

    beforeEach(async () => {
      await folder.mkdir(blogID, "/pages/projects/untitled folder");
    });

    it("excludes a rename in a directory modified around the walk", async () => {
      const summary = await walk(renameIn(recent()));

      expect(summary.removed).toBe(1);
      expect(summary.createdDirs).toBe(1);
      expect(summary.changedDuringWalk).toBe(2);
      expect(countChanges(summary)).toBe(0);
    });

    it("counts a rename in a directory modified well before the walk", async () => {
      const summary = await walk(renameIn(anHourAgo()));

      expect(summary.removed).toBe(1);
      expect(summary.createdDirs).toBe(1);
      expect(summary.changedDuringWalk).toBe(0);
      expect(countChanges(summary)).toBe(2);
    });

    it("counts a rename when the macserver reports no directory modified time", async () => {
      const summary = await walk(renameIn(undefined));

      expect(summary.changedDuringWalk).toBe(0);
      expect(countChanges(summary)).toBe(2);
    });

    it("counts a removal in the root, which has no modified time", async () => {
      await folder.write(blogID, "/gone.txt", "hello");

      const summary = await walk({
        "/": [dir("pages", anHourAgo())],
        "/pages": [dir("projects", anHourAgo())],
        "/pages/projects": [dir("untitled folder", anHourAgo())],
      });

      expect(summary.removed).toBe(1);
      expect(summary.changedDuringWalk).toBe(0);
      expect(countChanges(summary)).toBe(1);
    });

    it("excludes both halves of a file replaced by a directory", async () => {
      await folder.write(blogID, "/pages/projects/inactive", "x");

      const summary = await walk({
        "/": [dir("pages", anHourAgo())],
        "/pages": [dir("projects", recent())],
        "/pages/projects": [
          dir("untitled folder", anHourAgo()),
          dir("inactive", recent()),
        ],
      });

      expect(summary.removed).toBe(1);
      expect(summary.createdDirs).toBe(1);
      expect(summary.changedDuringWalk).toBe(2);
      expect(countChanges(summary)).toBe(0);
    });

    it("does not excuse removing an ignored local file", async () => {
      await folder.write(blogID, "/pages/projects/.DS_Store", "x");

      const summary = await walk({
        "/": [dir("pages", anHourAgo())],
        "/pages": [dir("projects", recent())],
        "/pages/projects": [dir("untitled folder", recent())],
      });

      expect(summary.removed).toBe(1);
      expect(summary.changedDuringWalk).toBe(0);
      expect(countChanges(summary)).toBe(1);
    });

    describe("a non-empty directory renamed into the directory", () => {
      const file = (name, modifiedTime) => ({
        name,
        isDirectory: false,
        size: 1,
        modifiedTime,
      });

      // Renaming old -> new touches neither new's own mtime nor its files'
      const renamedTree = (pagesModifiedTime, aModifiedTime = anHourAgo()) => ({
        "/": [dir("pages", pagesModifiedTime)],
        "/pages": [dir("new", anHourAgo())],
        "/pages/new": [file("a.md", aModifiedTime), dir("sub", anHourAgo())],
        "/pages/new/sub": [file("b.md", anHourAgo())],
      });

      beforeEach(async () => {
        await folder.remove(blogID, "/pages/projects");
        await folder.write(blogID, "/pages/old/a.md", "a");
      });

      it("excludes its files and subdirectories when the parent was modified around the walk", async () => {
        const summary = await walk(renamedTree(recent()));

        expect(summary.removed).toBe(1);
        expect(summary.createdDirs).toBe(2);
        expect(summary.downloaded).toBe(2);
        expect(countChanges(summary)).toBe(0);
      });

      it("counts them all when the parent was modified well before the walk", async () => {
        const summary = await walk(renamedTree(anHourAgo()));

        expect(summary.changedDuringWalk).toBe(0);
        expect(countChanges(summary)).toBe(5);
      });

      it("counts a download with a recent modified time once", async () => {
        const summary = await walk(renamedTree(recent(), recent()));

        expect(summary.downloaded).toBe(2);
        expect(summary.modifiedDuringWalk).toBe(1);
        expect(summary.changedDuringWalk).toBe(4);
        expect(summary.changedDuringWalk + summary.modifiedDuringWalk).toBe(
          summary.downloaded + summary.removed + summary.createdDirs
        );
        expect(countChanges(summary)).toBe(0);
      });
    });
  });

  describe("downloads", () => {
    const file = (name, size = 1) => ({ name, size, isDirectory: false });

    // Each download waits until the spec lets it finish, so the spec can see
    // how many run at once
    function mockDownloads(remoteContents) {
      const downloads = { running: 0, maxRunning: 0, started: [], waiting: [] };
      mockModule(remoteRecursiveListPath, async () => {});
      mockModule(remoteReaddirPath, async (_, path) =>
        typeof remoteContents === "function"
          ? remoteContents(path)
          : remoteContents
      );
      mockModule(downloadPath, async (_, path) => {
        downloads.started.push(path);
        downloads.running += 1;
        downloads.maxRunning = Math.max(
          downloads.maxRunning,
          downloads.running
        );
        await new Promise((resolve) => downloads.waiting.push(resolve));
        downloads.running -= 1;
        if (path.endsWith("fails.txt")) throw new Error("download failed");
      });
      mockModule(checkWeCanContinuePath, () => async () => {});
      mockModule(databasePath, {
        store: async () => {},
        get: async () => ({}),
      });
      return downloads;
    }

    // Finishes the waiting downloads one at a time until the walk is done,
    // first holding them all until holdUntilRunning are running at once (or
    // a second has passed)
    async function drain(downloads, walking, holdUntilRunning = 0) {
      let done = false;
      walking.then(
        () => (done = true),
        () => (done = true)
      );
      for (
        let waited = 0;
        !done && downloads.running < holdUntilRunning && waited < 1000;
        waited += 5
      ) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      while (!done) {
        await new Promise((resolve) => setTimeout(resolve, 5));
        const next = downloads.waiting.shift();
        if (next) next();
      }
      return walking;
    }

    it("downloads several files at once, applying them in order", async () => {
      await folder.write(blogID, "/gone.txt", "x");
      const names = ["a", "b", "c", "d", "e", "f", "g"].map((n) => n + ".txt");
      const downloads = mockDownloads(names.map((name) => file(name)));
      const updated = [];
      let removedBeforeDownloads = null;

      const walking = require(fromiCloudPath)(
        blogID,
        () => {},
        async (path) => {
          if (path === "/gone.txt")
            removedBeforeDownloads = downloads.started.length === 0;
          updated.push(path);
        }
      );
      const summary = await drain(downloads, walking, 4);

      expect(downloads.maxRunning).toBe(4);
      expect(downloads.started).toEqual(names.map((name) => "/" + name));
      expect(updated).toEqual(["/gone.txt", ...names.map((n) => "/" + n)]);
      expect(removedBeforeDownloads).toBe(true);
      expect(summary.downloaded).toBe(7);
      expect(summary.removed).toBe(1);
      expect(summary.failed).toBe(0);
    });

    it("downloads a directory's files while it walks a subdirectory", async () => {
      const downloads = mockDownloads((path) =>
        path === "/"
          ? [{ name: "sub", isDirectory: true }, file("a.txt"), file("b.txt")]
          : [file("c.txt"), file("d.txt")]
      );
      const updated = [];

      const walking = require(fromiCloudPath)(
        blogID,
        () => {},
        async (path) => updated.push(path)
      );
      const summary = await drain(downloads, walking, 4);

      expect(downloads.maxRunning).toBe(4);
      // The directory is created before anything is written into it
      expect(updated).toEqual([
        "/sub",
        "/sub/c.txt",
        "/sub/d.txt",
        "/a.txt",
        "/b.txt",
      ]);
      expect(summary.createdDirs).toBe(1);
      expect(summary.downloaded).toBe(4);
    });

    it("counts a failed download in its place, without stopping the others", async () => {
      const downloads = mockDownloads([
        file("a.txt"),
        file("fails.txt"),
        file("c.txt"),
      ]);
      const updated = [];

      const walking = require(fromiCloudPath)(
        blogID,
        () => {},
        async (path) => updated.push(path)
      );
      const summary = await drain(downloads, walking);

      expect(updated).toEqual(["/a.txt", "/c.txt"]);
      expect(summary.downloaded).toBe(2);
      expect(summary.failed).toBe(1);
      expect(summary.firstError).toBe("download failed");
    });

    it("waits for running downloads before returning from a failed walk", async () => {
      const downloads = mockDownloads((path) => {
        if (path === "/broken") throw new Error("listing failed");
        return [
          { name: "broken", isDirectory: true },
          file("a.txt"),
          file("b.txt"),
        ];
      });

      const walking = require(fromiCloudPath)(
        blogID,
        () => {},
        async () => {}
      );
      const summary = await drain(downloads, walking);

      expect(downloads.running).toBe(0);
      expect(summary.firstError).toBe("listing failed");
      // Not applied: the walk stopped at the directory before them
      expect(summary.downloaded).toBe(0);
    });

    it("downloads a file too large to share the limit on its own", async () => {
      const downloads = mockDownloads([
        file("a.txt"),
        file("big.mov", 50 * 1000 * 1000),
        file("c.txt"),
      ]);
      const runningWithBig = [];
      const original = require.cache[downloadPath].exports;
      mockModule(downloadPath, async (blog, path) => {
        if (path === "/big.mov") runningWithBig.push(downloads.running);
        return original(blog, path);
      });

      const walking = require(fromiCloudPath)(
        blogID,
        () => {},
        async () => {}
      );
      const summary = await drain(downloads, walking);

      expect(runningWithBig).toEqual([0]);
      expect(summary.downloaded).toBe(3);
    });
  });

  it("matches a directory of thousands of files without comparing every pair", async () => {
    const count = 5000;
    const names = Array.from({ length: count }, (_, i) => `post-${i}.md`);
    // The same name in NFD in iCloud and NFC locally is the same file
    names.push("cafe\u0301.md");
    const remote = names.map((name) => ({ name, size: 1, isDirectory: false }));
    const local = names.map((name) => ({
      name: name.normalize("NFC"),
      size: 1,
      isDirectory: false,
    }));

    mockModule(remoteRecursiveListPath, async () => {});
    mockModule(remoteReaddirPath, async () => remote);
    mockModule(localReaddirPath, async () => local);
    mockModule(downloadPath, async () => {
      throw new Error("no file should be downloaded");
    });
    mockModule(checkWeCanContinuePath, () => async () => {});
    mockModule(databasePath, {
      store: async () => {},
      get: async () => ({}),
    });

    // Matching each name against the whole other listing normalized names
    // tens of millions of times here and blocked the event loop for seconds
    const { normalize } = String.prototype;
    let normalizations = 0;
    String.prototype.normalize = function (...args) {
      normalizations += 1;
      return normalize.apply(this, args);
    };
    let summary;
    try {
      summary = await require(fromiCloudPath)(
        blogID,
        () => {},
        async () => {}
      );
    } finally {
      String.prototype.normalize = normalize;
    }

    expect(normalizations).toBeLessThan(10 * names.length);
    expect(summary.downloaded).toBe(0);
    expect(summary.removed).toBe(0);
    expect(summary.failed).toBe(0);
  });

  describe("folder tree listing", () => {
    afterEach(() => jasmine.clock().uninstall());

    it("says the listing is still going while it waits", async () => {
      let listed;
      let listing;
      const listingStarted = new Promise((resolve) => (listing = resolve));
      mockModule(remoteRecursiveListPath, () => {
        listing();
        return new Promise((resolve) => (listed = resolve));
      });
      mockModule(remoteReaddirPath, async () => []);
      mockModule(downloadPath, async () => {});
      mockModule(checkWeCanContinuePath, () => async () => {});
      mockModule(databasePath, {
        store: async () => {},
        get: async () => ({}),
      });

      const published = [];
      jasmine.clock().install();
      const walking = require(fromiCloudPath)(
        blogID,
        (...args) => published.push(args.join(" ")),
        async () => {}
      );
      await listingStarted;
      jasmine.clock().tick(11 * 1000);
      listed();
      jasmine.clock().uninstall();
      await walking;

      expect(published.slice(0, 4)).toEqual([
        "Syncing folder tree",
        "Syncing folder tree (5s)",
        "Syncing folder tree (10s)",
        "Synced folder tree",
      ]);
    });
  });
});
