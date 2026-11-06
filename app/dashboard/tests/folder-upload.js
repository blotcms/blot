const uploadRoutePath = require.resolve("../site/folder/upload");

const setModuleMock = (moduleName, exportsValue, touched) => {
  const resolved = require.resolve(moduleName);
  touched.push({ resolved, previous: require.cache[resolved] });
  require.cache[resolved] = {
    id: resolved,
    filename: resolved,
    loaded: true,
    exports: exportsValue,
  };
};

const restoreModuleMocks = (touched) => {
  touched.reverse().forEach(({ resolved, previous }) => {
    if (previous) {
      require.cache[resolved] = previous;
    } else {
      delete require.cache[resolved];
    }
  });
};

describe("dashboard folder upload sync lock", function () {
  let touched;

  beforeEach(function () {
    touched = [];
    delete require.cache[uploadRoutePath];
  });

  afterEach(function () {
    delete require.cache[uploadRoutePath];
    restoreModuleMocks(touched);
  });

  it("acquires one lock per request, updates changed paths, and releases the lock", async function () {
    const lockState = {
      update: jasmine.createSpy("update").and.returnValue(Promise.resolve()),
      done: jasmine.createSpy("done").and.returnValue(Promise.resolve()),
    };

    const establishSyncLock = jasmine
      .createSpy("establishSyncLock")
      .and.returnValue(
        Promise.resolve({
          folder: { update: lockState.update },
          done: lockState.done,
        })
      );

    const fs = {
      readFile: jasmine
        .createSpy("readFile")
        .and.callFake(async (filePath) => Buffer.from(`content:${filePath}`)),
      remove: jasmine.createSpy("remove").and.returnValue(Promise.resolve()),
    };

    const storage = {
      NotFoundError: require("../../storage/folder/errors").NotFoundError,
      exists: jasmine
        .createSpy("exists")
        .and.callFake(async (blogID, filePath) =>
          filePath.endsWith("skip.txt")
        ),
      stat: jasmine.createSpy("stat").and.returnValue(Promise.resolve({})),
      writeFrom: jasmine
        .createSpy("writeFrom")
        .and.returnValue(Promise.resolve()),
    };

    const clients = {
      mockClient: {
        write: (blogID, filePath, contents, cb) => {
          if (filePath === "client-fail.txt")
            return cb(new Error("client failed"));
          cb(null);
        },
      },
    };

    setModuleMock("sync/establishSyncLock", establishSyncLock, touched);
    setModuleMock("fs-extra", fs, touched);
    setModuleMock("clients", clients, touched);
    setModuleMock("storage/folder", storage, touched);
    setModuleMock("clients/util/shouldIgnoreFile", () => false, touched);

    const handler = require("../site/folder/upload");

    const req = {
      blog: { id: "blog-1", client: "mockClient" },
      body: {},
      query: {},
      files: {
        upload: [
          { path: "/tmp/1", originalFilename: "changed.txt" },
          { path: "/tmp/2", originalFilename: "skip.txt" },
          { path: "/tmp/3", originalFilename: "fail.txt" },
          { path: "/tmp/4", originalFilename: "client-fail.txt" },
        ],
      },
    };

    const res = {
      json: jasmine.createSpy("json"),
    };

    const next = jasmine.createSpy("next");

    await handler(req, res, next);

    expect(establishSyncLock).toHaveBeenCalledTimes(1);
    expect(establishSyncLock).toHaveBeenCalledWith("blog-1");

    expect(lockState.update).toHaveBeenCalledWith("/changed.txt");

    expect(lockState.done).toHaveBeenCalledTimes(1);
    expect(next).not.toHaveBeenCalled();
  });

  it("releases the lock when an error occurs after acquiring it", async function () {
    const folderUpdateError = new Error("update failed");

    const lockState = {
      update: jasmine.createSpy("update").and.callFake(async () => {
        throw folderUpdateError;
      }),
      done: jasmine.createSpy("done").and.returnValue(Promise.resolve()),
    };

    const establishSyncLock = jasmine
      .createSpy("establishSyncLock")
      .and.returnValue(
        Promise.resolve({
          folder: { update: lockState.update },
          done: lockState.done,
        })
      );

    const fs = {
      remove: jasmine.createSpy("remove").and.returnValue(Promise.resolve()),
    };

    const storage = {
      exists: jasmine
        .createSpy("exists")
        .and.returnValue(Promise.resolve(false)),
      writeFrom: jasmine
        .createSpy("writeFrom")
        .and.returnValue(Promise.resolve()),
    };

    setModuleMock("sync/establishSyncLock", establishSyncLock, touched);
    setModuleMock("fs-extra", fs, touched);
    setModuleMock("clients", {}, touched);
    setModuleMock("storage/folder", storage, touched);
    setModuleMock("clients/util/shouldIgnoreFile", () => false, touched);

    const handler = require("../site/folder/upload");

    const req = {
      blog: { id: "blog-2" },
      body: {},
      query: {},
      files: {
        upload: [{ path: "/tmp/1", originalFilename: "broken.txt" }],
      },
    };

    const res = {
      json: jasmine.createSpy("json"),
    };

    const next = jasmine.createSpy("next");

    await handler(req, res, next);

    expect(establishSyncLock).toHaveBeenCalledTimes(1);
    expect(lockState.done).toHaveBeenCalledTimes(1);
    expect(next).toHaveBeenCalledWith(folderUpdateError);
    expect(res.json).not.toHaveBeenCalled();
  });
});

describe("dashboard folder upload prefixed relative paths", function () {
  let touched;

  beforeEach(function () {
    touched = [];
    delete require.cache[uploadRoutePath];
  });

  afterEach(function () {
    delete require.cache[uploadRoutePath];
    restoreModuleMocks(touched);
  });

  it("writes files into the expected subfolder when relative paths are prefixed", async function () {
    const fs = {
      remove: jasmine.createSpy("remove").and.returnValue(Promise.resolve()),
    };

    const storage = {
      exists: jasmine
        .createSpy("exists")
        .and.returnValue(Promise.resolve(false)),
      writeFrom: jasmine
        .createSpy("writeFrom")
        .and.returnValue(Promise.resolve()),
    };

    const establishSyncLock = jasmine
      .createSpy("establishSyncLock")
      .and.returnValue(
        Promise.resolve({
          folder: {
            update: jasmine
              .createSpy("update")
              .and.returnValue(Promise.resolve()),
          },
          done: jasmine.createSpy("done").and.returnValue(Promise.resolve()),
        })
      );

    setModuleMock("sync/establishSyncLock", establishSyncLock, touched);
    setModuleMock("fs-extra", fs, touched);
    setModuleMock("clients", {}, touched);
    setModuleMock("storage/folder", storage, touched);
    setModuleMock("clients/util/shouldIgnoreFile", () => false, touched);

    const handler = require("../site/folder/upload");

    const req = {
      blog: { id: "blog-prefixed" },
      body: {
        relativePaths: JSON.stringify([
          {
            field: "upload",
            index: 0,
            relativePath: "subfolder/nested/file.md",
          },
        ]),
      },
      query: {},
      files: {
        upload: [{ path: "/tmp/prefixed", originalFilename: "file.md" }],
      },
    };

    const res = { json: jasmine.createSpy("json") };
    const next = jasmine.createSpy("next");

    await handler(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(storage.writeFrom).toHaveBeenCalledWith(
      "blog-prefixed",
      "/subfolder/nested/file.md",
      "/tmp/prefixed"
    );
  });
});
