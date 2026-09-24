const { promisify } = require("util");
const health = require("clients/health");
const database = require("../database");
const { MESSAGES } = require("../error");

describe("git database status", function () {
  global.test.blogs(2);

  const setStatus = promisify(database.setStatus.bind(database));
  const getStatus = promisify(database.getStatus.bind(database));
  const getRecord = promisify(database.getRecord.bind(database));
  const getRecordForBlog = promisify(database.getRecordForBlog.bind(database));
  const setIssue = promisify(database.setIssue.bind(database));
  const clearIssue = promisify(database.clearIssue.bind(database));
  const removeStatus = promisify(database.removeStatus.bind(database));
  const client = require("models/client");

  it("stores create status per blog, not per user", async function () {
    const a = this.blogs[0];
    const b = this.blogs[1];

    await setStatus(a.id, database.STATUSES.CREATE_FAILED);
    await setStatus(b.id, database.STATUSES.CREATE_COMPLETE);

    expect(await getStatus(a.id)).toBe(database.STATUSES.CREATE_FAILED);
    expect(await getStatus(b.id)).toBe(database.STATUSES.CREATE_COMPLETE);
    expect(await client.get(database.legacyStatusKey(a.owner))).toBeNull();
  });

  it("records a SYNC_ERROR issue when create fails", async function () {
    await setStatus(this.blogs[0].id, database.STATUSES.CREATE_FAILED);

    const record = await getRecord(this.blogs[0].id);

    expect(record.issue.code).toBe(health.CODES.SYNC_ERROR);
    expect(record.issue.message).toBe(MESSAGES.SETUP_FAILED);
    expect(typeof record.issue.since).toBe("number");
    expect(typeof record.statusSince).toBe("number");
  });

  it("clears a persisted issue on createComplete", async function () {
    await setStatus(this.blogs[0].id, database.STATUSES.CREATE_FAILED);
    await setStatus(this.blogs[0].id, database.STATUSES.CREATE_COMPLETE);

    const record = await getRecord(this.blogs[0].id);
    expect(record.status).toBe(database.STATUSES.CREATE_COMPLETE);
    expect(record.issue).toBeUndefined();
  });

  it("keeps the original since when the same issue is recorded again", async function () {
    await setIssue(this.blogs[0].id, {
      code: health.CODES.SOURCE_MISSING,
      message: MESSAGES.SOURCE_MISSING,
      since: 1758000000000,
    });

    await setIssue(this.blogs[0].id, {
      code: health.CODES.SOURCE_MISSING,
      message: MESSAGES.SOURCE_MISSING,
    });

    const record = await getRecord(this.blogs[0].id);
    expect(record.issue.since).toBe(1758000000000);
  });

  it("clears a persisted issue", async function () {
    await setIssue(this.blogs[0].id, {
      code: health.CODES.SYNC_ERROR,
      message: "fetch failed",
    });
    await clearIssue(this.blogs[0].id);

    const record = await getRecord(this.blogs[0].id);
    expect(record.issue).toBeUndefined();
  });

  it("falls back to the legacy user-keyed status", async function () {
    await client.set(
      database.legacyStatusKey(this.blogs[0].owner),
      database.STATUSES.CREATE_IN_PROGRESS
    );

    const record = await getRecordForBlog(this.blogs[0]);
    expect(record.status).toBe(database.STATUSES.CREATE_IN_PROGRESS);
  });

  it("prefers the per-blog record over the legacy user key", async function () {
    await client.set(
      database.legacyStatusKey(this.blogs[0].owner),
      database.STATUSES.CREATE_FAILED
    );
    await setStatus(this.blogs[0].id, database.STATUSES.CREATE_COMPLETE);

    const record = await getRecordForBlog(this.blogs[0]);
    expect(record.status).toBe(database.STATUSES.CREATE_COMPLETE);
  });

  it("parses legacy string values", function () {
    expect(database.parseRecord("createFailed")).toEqual({
      status: "createFailed",
    });
    expect(
      database.parseRecord(
        JSON.stringify({ status: "createComplete", statusSince: 1 })
      )
    ).toEqual({ status: "createComplete", statusSince: 1 });
    expect(database.parseRecord(null)).toBeNull();
  });

  it("removeStatus only deletes the per-blog key", async function () {
    await setStatus(this.blogs[0].id, database.STATUSES.CREATE_FAILED);
    await client.set(
      database.legacyStatusKey(this.blogs[0].owner),
      database.STATUSES.CREATE_FAILED
    );

    await removeStatus(this.blogs[0].id);

    expect(await getRecord(this.blogs[0].id)).toBeNull();
    expect(await client.get(database.legacyStatusKey(this.blogs[0].owner))).toBe(
      database.STATUSES.CREATE_FAILED
    );
  });
});
