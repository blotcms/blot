const health = require("clients/health");
const database = require("clients/icloud/database");
const getHealth = require("clients/icloud/getHealth");
const { BLOG_DIRECTORY_DELETED } = require("clients/icloud/error");

describe("icloud getHealth", function () {
  global.test.blog();

  afterEach(async function () {
    await database.delete(this.blog.id);
  });

  it("is exported on the iCloud client", function () {
    expect(require("clients/icloud").getHealth).toBe(getHealth);
  });

  it("is healthy when there is no account", async function () {
    expect(await getHealth(this.blog.id)).toEqual(health.ok());
  });

  it("is healthy when setup is complete and there is no error", async function () {
    await database.store(this.blog.id, { setupComplete: true, error: null });

    expect(await getHealth(this.blog.id)).toEqual(health.ok());
  });

  it("is syncing during initial transfer and while waiting for the folder", async function () {
    await database.store(this.blog.id, {
      setupComplete: false,
      transferringToiCloud: true,
      sharingLink: "https://www.icloud.com/iclouddrive/abc",
    });
    expect(await getHealth(this.blog.id)).toEqual(health.syncing());

    await database.store(this.blog.id, { transferringToiCloud: false });
    expect(await getHealth(this.blog.id)).toEqual(health.syncing());
  });

  it("reports SOURCE_MISSING for a deleted blog directory", async function () {
    await database.store(this.blog.id, {
      setupComplete: true,
      error: BLOG_DIRECTORY_DELETED,
      errorCode: health.CODES.SOURCE_MISSING,
    });

    const result = await getHealth(this.blog.id);

    expect(result.state).toBe(health.STATES.ERROR);
    expect(result.issues[0].code).toBe(health.CODES.SOURCE_MISSING);
    expect(result.issues[0].message).toBe(
      health.ISSUES.SOURCE_MISSING.message
    );
    expect(typeof result.issues[0].since).toBe("number");
  });

  it("classifies a legacy deleted-folder string without a stored code", async function () {
    const key = database._key(this.blog.id);
    const client = require("models/client");
    await client.hSet(key, "setupComplete", JSON.stringify(true));
    await client.hSet(key, "error", JSON.stringify(BLOG_DIRECTORY_DELETED));
    await client.sAdd(database._globalSetKey(), this.blog.id);

    const result = await getHealth(this.blog.id);

    expect(result.issues[0].code).toBe(health.CODES.SOURCE_MISSING);
    expect(result.issues[0].since).toBeUndefined();
  });

  it("reports TRANSFER_INCOMPLETE when the initial transfer failed", async function () {
    await database.store(this.blog.id, {
      setupComplete: false,
      sharingLink: "https://www.icloud.com/iclouddrive/abc",
      error: "Request failed after 3 retries: http://macserver/upload",
      errorCode: health.CODES.TRANSFER_INCOMPLETE,
    });

    const result = await getHealth(this.blog.id);

    expect(result.state).toBe(health.STATES.ERROR);
    expect(result.issues[0]).toEqual(
      jasmine.objectContaining({
        code: health.CODES.TRANSFER_INCOMPLETE,
        message: health.ISSUES.TRANSFER_INCOMPLETE.message,
      })
    );
  });

  it("does not report a failed setup as a health issue", async function () {
    await database.store(this.blog.id, {
      setupComplete: false,
      sharingLink: "https://www.icloud.com/iclouddrive/abc",
      error: "Invalid sharing link",
      errorCode: "SETUP_FAILED",
    });

    expect(await getHealth(this.blog.id)).toEqual(health.ok());
  });

  it("does not report a setup failure from a macserver that sends no code", async function () {
    await database.store(this.blog.id, {
      setupComplete: false,
      sharingLink: "https://www.icloud.com/iclouddrive/abc",
    });
    // as posted by routes/site/status.js
    await database.store(this.blog.id, {
      acceptedSharingLink: false,
      error: "Invalid sharing link",
    });

    expect(await getHealth(this.blog.id)).toEqual(health.ok());
  });

  it("reports SYNC_ERROR for an unrecognised error on a set-up blog", async function () {
    await database.store(this.blog.id, {
      setupComplete: true,
      error: "Something unexpected",
    });

    const result = await getHealth(this.blog.id);

    expect(result.issues[0].code).toBe(health.CODES.SYNC_ERROR);
  });

  it("clears the issue once the stored error is removed", async function () {
    await database.store(this.blog.id, {
      setupComplete: true,
      error: BLOG_DIRECTORY_DELETED,
    });
    expect((await getHealth(this.blog.id)).state).toBe(health.STATES.ERROR);

    await database.store(this.blog.id, { error: null });
    expect(await getHealth(this.blog.id)).toEqual(health.ok());
  });

  it("is syncing, not an error, when setup is retried after the folder went missing", async function () {
    await database.store(this.blog.id, {
      setupComplete: true,
      error: BLOG_DIRECTORY_DELETED,
    });

    // routes/dashboard.js /set-up-folder
    await database.store(this.blog.id, {
      sharingLink: "https://www.icloud.com/iclouddrive/new",
      error: null,
      setupComplete: false,
    });

    expect(await getHealth(this.blog.id)).toEqual(health.syncing());
  });
});
