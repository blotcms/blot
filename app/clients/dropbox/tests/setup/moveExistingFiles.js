describe("dropbox createFolder moveExistingFiles", function () {
  const createFolderPath = require.resolve("../../routes/setup/createFolder");
  const syncPath = require.resolve("sync");

  let originalSync;

  beforeEach(function () {
    originalSync = require.cache[syncPath];
  });

  afterEach(function () {
    delete require.cache[createFolderPath];
    if (originalSync) {
      require.cache[syncPath] = originalSync;
    } else {
      delete require.cache[syncPath];
    }
  });

  it("rejects with the lock error instead of throwing when the sync lock can't be acquired", async function () {
    require.cache[syncPath] = {
      id: syncPath,
      filename: syncPath,
      loaded: true,
      exports: function (blogID, callback) {
        callback(new Error("Failed to acquire folder lock"));
      },
    };

    delete require.cache[createFolderPath];
    const { moveExistingFiles } = require("../../routes/setup/createFolder");

    await expectAsync(
      moveExistingFiles({}, { id: "blog-1", title: "Other blog" })
    ).toBeRejectedWith(new Error("Failed to acquire folder lock"));
  });
});
