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
      error: "Transfer failed",
    });

    await database.store(this.blog.id, { error: null });

    const stored = await database.get(this.blog.id);

    expect(stored.error).toBeNull();
    expect(stored.errorCode).toBeNull();
    expect(stored.errorSince).toBeNull();
  });

  it("preserves errorSince when rewriting the same issue", async function () {
    await database.store(this.blog.id, {
      setupComplete: true,
      error: "Transfer failed",
    });
    const first = await database.get(this.blog.id);

    await database.store(this.blog.id, { error: "Transfer failed again" });
    const second = await database.get(this.blog.id);

    expect(second.errorCode).toBe("SYNC_ERROR");
    expect(second.errorSince).toBe(first.errorSince);
    expect(second.error).toBe("Transfer failed again");
  });
});
