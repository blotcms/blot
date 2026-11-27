const folder = require("storage/folder");
const client = require("models/client");
const database = require("../../../database");

const uploadPath = require.resolve("../upload");
const establishSyncLockPath = require.resolve("sync/establishSyncLock");
const stillConnectedPath = require.resolve("../stillConnected");
const liveLagPath = require.resolve("../../../util/liveLag");

describe("icloud upload route", function () {
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
    delete require.cache[uploadPath];
  };

  let blogID;
  let updateCalls;
  // What the route finds once it holds the lock
  let connected;

  const fakeReq = ({
    blogID,
    filePath,
    body,
    modifiedTime,
    fromDirectoryWalk,
  }) => ({
    header(name) {
      if (name === "fromDirectoryWalk") return fromDirectoryWalk;
      if (name === "blogID") return blogID;
      if (name === "pathBase64")
        return Buffer.from(filePath).toString("base64");
      if (name === "modifiedTime") return modifiedTime;
      if (name === "x-placeholder") return undefined;
      if (name === "x-original-size") return undefined;
      return undefined;
    },
    body,
  });

  const fakeRes = () => {
    const res = {
      statusCode: null,
      body: null,
      status(code) {
        res.statusCode = code;
        return res;
      },
      send(body) {
        res.body = body;
        return res;
      },
      sendStatus(code) {
        res.statusCode = code;
        return res;
      },
    };
    return res;
  };

  beforeEach(async () => {
    // routes/site/index.js may already have loaded the upload route (bound to
    // the real establishSyncLock) in an earlier spec; reload it with the mock.
    delete require.cache[uploadPath];

    blogID = `icloud-upload-test-${Date.now()}-${Math.floor(
      Math.random() * 10000
    )}`;

    updateCalls = [];
    connected = true;
    mockModule(stillConnectedPath, async () => connected);
    mockModule(establishSyncLockPath, async () => ({
      folder: {
        status: () => {},
        signal: new AbortController().signal,
        run: (fn) => fn(),
        drainDependents: async () => {},
        update: async (path) => {
          updateCalls.push(path);
        },
        updateCalls,
      },
      done: async () => {},
    }));
  });

  afterEach(async () => {
    restoreModules();
    await folder.removeAll(blogID);
    await client.del(database._pendingUploadsKey(blogID));
  });

  it("builds a file already on disk whose earlier upload never built it", async () => {
    const filePath = "/post.txt";
    const contents = "hello world";
    // The process died after writing the file and before building it
    await database.markUploadPending(blogID, filePath);
    await folder.write(blogID, filePath, contents);

    const res = fakeRes();
    await require(uploadPath)(
      fakeReq({ blogID, filePath, body: Buffer.from(contents) }),
      res
    );

    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("successfully uploaded");
    expect(updateCalls).toEqual([filePath]);
    expect(await database.isUploadPending(blogID, filePath)).toBe(false);
  });

  it("marks an upload only until it is built", async () => {
    const filePath = "/new.txt";
    let pendingDuringUpdate = null;
    mockModule(establishSyncLockPath, async () => ({
      folder: {
        status: () => {},
        signal: new AbortController().signal,
        run: (fn) => fn(),
        drainDependents: async () => {},
        update: async (path) => {
          pendingDuringUpdate = await database.isUploadPending(blogID, path);
          updateCalls.push(path);
        },
      },
      done: async () => {},
    }));

    const res = fakeRes();
    await require(uploadPath)(
      fakeReq({ blogID, filePath, body: Buffer.from("new") }),
      res
    );

    expect(res.statusCode).toBe(200);
    expect(pendingDuringUpdate).toBe(true);
    expect(updateCalls).toEqual([filePath]);
    expect(await database.isUploadPending(blogID, filePath)).toBe(false);
  });

  it("leaves the mark when the build fails, so a retry builds the file", async () => {
    const filePath = "/fails.txt";
    mockModule(establishSyncLockPath, async () => ({
      folder: {
        status: () => {},
        signal: new AbortController().signal,
        run: (fn) => fn(),
        drainDependents: async () => {},
        update: async () => {
          throw new Error("process died");
        },
      },
      done: async () => {},
    }));

    const res = fakeRes();
    await require(uploadPath)(
      fakeReq({ blogID, filePath, body: Buffer.from("x") }),
      res
    );

    expect(res.statusCode).toBe(500);
    expect(await database.isUploadPending(blogID, filePath)).toBe(true);
  });

  it("writes nothing for a blog disconnected while it waited for the lock", async function () {
    const filePath = "/late.txt";
    connected = false;

    const res = fakeRes();
    await require(uploadPath)(
      fakeReq({ blogID, filePath, body: Buffer.from("late") }),
      res
    );

    expect(res.statusCode).toBe(410);
    expect(updateCalls).toEqual([]);
    expect(await folder.exists(blogID, filePath)).toBe(false);
  });

  it("treats identical contents as already current regardless of mtime, without setting mtime", async () => {
    const filePath = "/post.txt";
    const contents = "hello world";
    await folder.write(blogID, filePath, contents);

    const before = await folder.stat(blogID, filePath);

    const upload = require(uploadPath);
    const req = fakeReq({
      blogID,
      filePath,
      body: Buffer.from(contents),
      // A modifiedTime far in the past used to force a re-write via
      // fs.utimes and could make an already-current file look stale.
      modifiedTime: "2000-01-01T00:00:00.000Z",
    });
    const res = fakeRes();

    await upload(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("already up to date");
    expect(updateCalls).toEqual([]);

    const after = await folder.stat(blogID, filePath);
    expect(after.modified).toBe(before.modified);
  });

  it("writes new contents without setting a specific mtime", async () => {
    const filePath = "/new-file.txt";
    const contents = "fresh contents";

    const upload = require(uploadPath);
    const req = fakeReq({
      blogID,
      filePath,
      body: Buffer.from(contents),
      modifiedTime: "2000-01-01T00:00:00.000Z",
    });
    const res = fakeRes();

    const beforeUpload = Date.now();
    await upload(req, res);

    expect(res.statusCode).toBe(200);

    const stat = await folder.stat(blogID, filePath);

    expect((await folder.read(blogID, filePath)).toString()).toBe(contents);
    // The file was written just now; it must not have been backdated to
    // the modifiedTime header.
    expect(stat.modified).toBeGreaterThanOrEqual(beforeUpload - 1000);
  });

  describe("live lag", function () {
    let recorded;

    beforeEach(function () {
      recorded = [];
      mockModule(liveLagPath, {
        record: async (modifiedTime) => recorded.push(modifiedTime),
      });
    });

    const push = async (fromDirectoryWalk) => {
      const res = fakeRes();
      await require(uploadPath)(
        fakeReq({
          blogID,
          filePath: "/post.txt",
          body: Buffer.from("hello"),
          modifiedTime: "2026-11-23T14:00:00.000Z",
          fromDirectoryWalk,
        }),
        res
      );
      expect(res.statusCode).toBe(200);
    };

    it("records the delay of a file the watcher saw change", async function () {
      await push(undefined);

      expect(recorded).toEqual(["2026-11-23T14:00:00.000Z"]);
    });

    // A folder moved or copied in: its files keep the mtimes they had
    it("leaves out a file pushed by the walk of a directory that appeared", async function () {
      await push("true");

      expect(recorded).toEqual([]);
    });
  });
});
