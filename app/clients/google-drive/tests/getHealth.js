const fs = require("fs");
const vm = require("vm");
const health = require("clients/health");

function load(account) {
  const module = { exports: {} };

  vm.runInNewContext(fs.readFileSync(require.resolve("../getHealth"), "utf8"), {
    module,
    exports: module.exports,
    isFinite: isFinite,
    require: function (name) {
      if (name === "./database") {
        return {
          blog: {
            get: async function () {
              return account;
            },
          },
        };
      }
      if (name === "./database/error") return require("../database/error");
      if (name === "clients/health") return require("clients/health");
      return require(name);
    },
  });

  return module.exports;
}

describe("google drive getHealth", function () {
  it("is exported on the Google Drive client", function () {
    expect(typeof require("../index").getHealth).toBe("function");
  });

  it("returns ok when there is no account", async function () {
    expect(await load(null)("blog")).toEqual(health.ok());
  });

  it("returns ok for a connected folder with no error", async function () {
    expect(
      await load({
        folderId: "folder",
        folderName: "Site",
        preparing: false,
      })("blog")
    ).toEqual(health.ok());
  });

  it("returns syncing while setup is waiting for a shared folder", async function () {
    expect(
      await load({
        preparing: true,
        email: "user@example.com",
        folderId: null,
      })("blog")
    ).toEqual(health.syncing());
  });

  it("does not surface a setup failure as sync health", async function () {
    expect(
      await load({
        preparing: true,
        error: "Failed to set up account",
        folderId: null,
      })("blog")
    ).toEqual(health.syncing());

    expect(
      await load({
        preparing: false,
        error: "Failed to set up account",
        folderId: null,
      })("blog")
    ).toEqual(health.ok());
  });

  it("maps a stored SOURCE_MISSING code to an error", async function () {
    const result = await load({
      error:
        "The Google Drive folder used to sync this site has been deleted. Please select a new folder to continue syncing.",
      errorCode: health.CODES.SOURCE_MISSING,
      errorSince: 1758000000000,
      folderId: null,
    })("blog");

    expect(result).toEqual(
      health.error([
        {
          code: health.CODES.SOURCE_MISSING,
          message:
            "The Google Drive folder used to sync this site has been deleted. Please select a new folder to continue syncing.",
          since: 1758000000000,
        },
      ])
    );
  });

  it("lazily classifies legacy prose-only trash rows", async function () {
    const result = await load({
      error:
        "The Google Drive folder used to sync this site has been moved to the trash. Please select a new folder to continue syncing.",
      folderId: null,
    })("blog");

    expect(result.state).toBe(health.STATES.ERROR);
    expect(result.issues[0].code).toBe(health.CODES.SOURCE_MISSING);
    expect(result.issues[0].since).toBeUndefined();
  });

  it("uses the shared default copy when only errorCode is stored", async function () {
    const result = await load({
      errorCode: health.CODES.SOURCE_MISSING,
      folderId: null,
    })("blog");

    expect(result).toEqual(
      health.error([{ code: health.CODES.SOURCE_MISSING }])
    );
  });
});
