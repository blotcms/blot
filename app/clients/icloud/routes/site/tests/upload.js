const fs = require("fs-extra");
const localPath = require("helper/localPath");

const uploadPath = require.resolve("../upload");
const establishSyncLockPath = require.resolve("sync/establishSyncLock");

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

  const fakeReq = ({ blogID, filePath, body, modifiedTime }) => ({
    header(name) {
      if (name === "blogID") return blogID;
      if (name === "pathBase64") return Buffer.from(filePath).toString("base64");
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
    blogID = `icloud-upload-test-${Date.now()}-${Math.floor(
      Math.random() * 10000
    )}`;
    await fs.ensureDir(localPath(blogID, "/"));

    let updateCalls = [];
    mockModule(establishSyncLockPath, async () => ({
      folder: {
        status: () => {},
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
    await fs.remove(localPath(blogID, "/"));
  });

  it("treats identical contents as already current regardless of mtime, without setting mtime", async () => {
    const filePath = "/post.txt";
    const contents = "hello world";
    const pathOnDisk = localPath(blogID, filePath);
    await fs.outputFile(pathOnDisk, contents);

    const before = await fs.stat(pathOnDisk);

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

    const after = await fs.stat(pathOnDisk);
    expect(after.mtime.getTime()).toBe(before.mtime.getTime());
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

    const pathOnDisk = localPath(blogID, filePath);
    const stat = await fs.stat(pathOnDisk);

    expect((await fs.readFile(pathOnDisk)).toString()).toBe(contents);
    // The file was written just now; it must not have been backdated to
    // the modifiedTime header.
    expect(stat.mtime.getTime()).toBeGreaterThanOrEqual(beforeUpload - 1000);
  });
});
