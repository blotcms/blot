const client = require("models/client");
const database = require("clients/icloud/database");

describe("icloud database", function () {
  global.test.blog();

  afterEach(async function () {
    await database.delete(this.blog.id);
  });

  it("returns null when no hash exists", async function () {
    const result = await database.get(this.blog.id);

    expect(result).toBeNull();
  });

  it("returns null for empty hash responses", async function () {
    spyOn(client, "hGetAll").and.returnValue(Promise.resolve({}));

    const result = await database.get(this.blog.id);

    expect(result).toBeNull();
  });

  it("tracks global set membership across store and delete", async function () {
    const data = {
      setupComplete: true,
      sharingLink: "https://example.com/shared",
      transferState: { active: false },
    };

    await database.store(this.blog.id, data);

    const stored = await database.get(this.blog.id);
    expect(stored).toEqual(data);

    const listedAfterStore = await database.list();
    expect(listedAfterStore).toContain(this.blog.id);

    const globalMembers = await client.sMembers(database._globalSetKey());
    expect(globalMembers).toContain(this.blog.id);

    await database.delete(this.blog.id);

    const listedAfterDelete = await database.list();
    expect(listedAfterDelete).not.toContain(this.blog.id);

    const globalMembersAfterDelete = await client.sMembers(database._globalSetKey());
    expect(globalMembersAfterDelete).not.toContain(this.blog.id);
  });

  it("classifies and stamps a stored error", async function () {
    await database.store(this.blog.id, {
      setupComplete: true,
      error: "Blog directory deleted",
    });

    const stored = await database.get(this.blog.id);

    expect(stored.error).toBe("Blog directory deleted");
    expect(stored.errorCode).toBe("SOURCE_MISSING");
    expect(typeof stored.errorSince).toBe("number");
  });

  it("clears errorCode and errorSince when error is null", async function () {
    await database.store(this.blog.id, {
      setupComplete: true,
      error: "Blog directory deleted",
    });

    await database.store(this.blog.id, { error: null });

    const stored = await database.get(this.blog.id);

    expect(stored.error).toBeNull();
    expect(stored.errorCode).toBeNull();
    expect(stored.errorSince).toBeNull();
  });

  it("stores the code written at the source", async function () {
    await database.store(this.blog.id, {
      setupComplete: false,
      error: "Invalid sharing link",
      errorCode: "SETUP_FAILED",
    });
    expect((await database.get(this.blog.id)).errorCode).toBe("SETUP_FAILED");

    await database.store(this.blog.id, {
      error: "Request failed",
      errorCode: "TRANSFER_INCOMPLETE",
    });
    expect((await database.get(this.blog.id)).errorCode).toBe(
      "TRANSFER_INCOMPLETE"
    );
  });

  it("classifies an error posted without a code from the stored row", async function () {
    await database.store(this.blog.id, { setupComplete: false });
    await database.store(this.blog.id, {
      acceptedSharingLink: false,
      error: "Invalid sharing link",
    });

    expect((await database.get(this.blog.id)).errorCode).toBe("SETUP_FAILED");
  });

  it("preserves errorSince when rewriting the same code", async function () {
    await database.store(this.blog.id, {
      setupComplete: true,
      error: "Blog directory deleted",
    });
    const first = await database.get(this.blog.id);

    await database.store(this.blog.id, {
      error: "Blog directory deleted",
      errorCode: "SOURCE_MISSING",
    });
    const second = await database.get(this.blog.id);

    expect(second.errorCode).toBe("SOURCE_MISSING");
    expect(second.errorSince).toBe(first.errorSince);
  });

  it("stamps lastSync as a number without touching the rest of the row", async function () {
    await database.store(this.blog.id, { setupComplete: true });
    const before = Date.now();

    await database.stampLastSync(this.blog.id);

    const stored = await database.get(this.blog.id);
    expect(stored.setupComplete).toBe(true);
    expect(typeof stored.lastSync).toBe("number");
    expect(stored.lastSync).toBeGreaterThanOrEqual(before);
  });

  it("resets errorSince when the code changes", async function () {
    await database.store(this.blog.id, {
      setupComplete: true,
      error: "Blog directory deleted",
      errorSince: 1000,
    });

    await database.store(this.blog.id, {
      error: "Transfer failed",
      errorCode: "TRANSFER_INCOMPLETE",
    });
    const stored = await database.get(this.blog.id);

    expect(stored.errorCode).toBe("TRANSFER_INCOMPLETE");
    expect(stored.errorSince).toBeGreaterThan(1000);
  });
});
