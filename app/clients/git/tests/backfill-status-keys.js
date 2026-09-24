const { promisify } = require("util");
const client = require("models/client");
const database = require("../database");
const backfill = require("../../../../scripts/git/backfill-status-keys");

describe("git status key backfill", function () {
  global.test.blog();

  const setStatus = promisify(database.setStatus.bind(database));
  const getRecord = promisify(database.getRecord.bind(database));
  const Blog = require("models/blog");
  const setBlog = promisify(Blog.set);

  it("copies a legacy user-keyed status onto the per-blog key", async function () {
    await setBlog(this.blog.id, { client: "git" });
    await client.set(
      database.legacyStatusKey(this.blog.owner),
      database.STATUSES.CREATE_FAILED
    );

    const plan = await backfill.collectPlan();
    expect(plan.copies.length).toBeGreaterThan(0);
    expect(plan.copies.some((item) => item.blogID === this.blog.id)).toBe(true);

    await backfill.applyPlan(plan);

    const record = await getRecord(this.blog.id);
    expect(record.status).toBe(database.STATUSES.CREATE_FAILED);
    expect(await client.get(database.legacyStatusKey(this.blog.owner))).toBeNull();
  });

  it("does not overwrite an existing per-blog status", async function () {
    await setBlog(this.blog.id, { client: "git" });
    await setStatus(this.blog.id, database.STATUSES.CREATE_COMPLETE);
    await client.set(
      database.legacyStatusKey(this.blog.owner),
      database.STATUSES.CREATE_FAILED
    );

    const plan = await backfill.collectPlan();
    expect(plan.copies.some((item) => item.blogID === this.blog.id)).toBe(false);

    await backfill.applyPlan(plan);

    const record = await getRecord(this.blog.id);
    expect(record.status).toBe(database.STATUSES.CREATE_COMPLETE);
    expect(await client.get(database.legacyStatusKey(this.blog.owner))).toBeNull();
  });
});
