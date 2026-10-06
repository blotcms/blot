const fs = require("fs");
const vm = require("vm");

const TRASHED =
  "The Google Drive folder for this site was moved to the trash. Please select a new folder.";

function load(accounts, syncResult) {
  const module = { exports: {} };
  const calls = { sync: [], prune: 0 };

  vm.runInNewContext(
    fs.readFileSync(require.resolve("../sync/resetFromDrive"), "utf8"),
    {
      module,
      exports: module.exports,
      require: function (name) {
        if (name === "../database") {
          return {
            blog: {
              get: async function () {
                return accounts.length > 1 ? accounts.shift() : accounts[0];
              },
            },
            folder: function () {
              return {
                pruneVerifiedContents: async function () {
                  calls.prune++;
                },
              };
            },
          };
        }
        if (name === "./sync") {
          return async function () {
            calls.sync.push(Array.prototype.slice.call(arguments));
            return syncResult;
          };
        }
        if (name === "../database/error") return require("../database/error");
        if (name === "clients/health") return require("clients/health");
        return require(name);
      },
    }
  );

  return { resetFromDrive: module.exports, calls: calls };
}

async function rejection(promise) {
  try {
    await promise;
  } catch (err) {
    return err;
  }
  throw new Error("Expected promise to reject");
}

describe("google drive resetFromDrive", function () {
  it("throws a folder-missing error without syncing when there is no folderId", async function () {
    const t = load(
      [
        {
          folderId: null,
          error: TRASHED,
          errorCode: "SOURCE_MISSING",
        },
      ],
      { ok: true }
    );

    const err = await rejection(t.resetFromDrive("blog"));

    expect(err.code).toBe("GOOGLE_DRIVE_FOLDER_MISSING");
    expect(err.code).toBe(t.resetFromDrive.FOLDER_MISSING);
    expect(err.message).toBe(TRASHED);
    expect(t.calls.sync.length).toBe(0);
  });

  it("returns the summary and prunes after a successful reset sync", async function () {
    const summary = { changed: 2 };
    const t = load([{ folderId: "folder" }], summary);

    expect(await t.resetFromDrive("blog")).toBe(summary);
    expect(t.calls.prune).toBe(1);
    expect(t.calls.sync.length).toBe(1);
    expect(t.calls.sync[0][0]).toBe("blog");
    expect(t.calls.sync[0][3]).toEqual({ reset: true });
  });

  it("throws folder-missing when the failed sync found the folder gone", async function () {
    const t = load(
      [
        { folderId: "folder" },
        { folderId: null, error: TRASHED, errorCode: "SOURCE_MISSING" },
      ],
      false
    );

    const err = await rejection(t.resetFromDrive("blog"));

    expect(err.code).toBe("GOOGLE_DRIVE_FOLDER_MISSING");
    expect(err.message).toBe(TRASHED);
    expect(t.calls.prune).toBe(0);
  });

  it("resolves false without throwing on a transient sync failure", async function () {
    const t = load([{ folderId: "folder" }], false);

    expect(await t.resetFromDrive("blog")).toBe(false);
    expect(t.calls.prune).toBe(0);
  });
});
