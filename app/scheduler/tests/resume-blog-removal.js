describe("scheduler resume-blog-removal", function () {
  const resume = require("../resume-blog-removal");
  const Blog = require("models/blog");
  const client = require("models/client");
  const discover = require("models/discover");
  const redisSearch = require("helper/redisSearch");

  const MINUTE = 60 * 1000;

  global.test.user();

  beforeEach(async function () {
    this.blog = await Blog.create(this.user.uid, { handle: "resumeblog" });
    spyOn(console, "log");
    spyOn(console, "error");

    // The kill: removal stops after the owner's list is updated
    this.kill = spyOn(discover, "removeBlog").and.rejectWith(
      new Error("killed")
    );
    await expectAsync(Blog.remove(this.blog.id)).toBeRejected();
    this.kill.and.callThrough();
  });

  afterEach(async function () {
    await client.zRem(Blog.key.removing, this.blog.id);
    await client.hDel(Blog.key.removalAttempts, this.blog.id);
  });

  it("finishes a removal a kill interrupted, once it is overdue", async function () {
    const result = await resume({ now: Date.now() + 11 * MINUTE });

    expect(result.resumed).toEqual([this.blog.id]);
    expect(await Blog.get({ id: this.blog.id })).toBeUndefined();
    expect(await client.zScore(Blog.key.removing, this.blog.id)).toBeNull();
    expect(await redisSearch(this.blog.id)).toEqual([]);
  });

  it("leaves a removal alone while it may still be running", async function () {
    const result = await resume({ now: Date.now() + MINUTE });

    expect(result).toEqual({ resumed: [], failed: [], gaveUp: [] });
    expect(await Blog.get({ id: this.blog.id })).toBeDefined();
  });

  it("waits longer after each failed attempt and gives up after too many", async function () {
    this.kill.and.rejectWith(new Error("still failing"));

    let now = Date.now() + 11 * MINUTE;
    let result = await resume({ now });

    expect(result.failed).toEqual([this.blog.id]);

    // Not due again straight away
    expect(await resume({ now: now + MINUTE })).toEqual({
      resumed: [],
      failed: [],
      gaveUp: [],
    });

    await client.hSet(
      Blog.key.removalAttempts,
      this.blog.id,
      String(resume.MAX_ATTEMPTS)
    );

    now += 2 * 24 * 60 * MINUTE;
    this.kill.calls.reset();
    result = await resume({ now });

    expect(result.gaveUp).toEqual([this.blog.id]);
    expect(this.kill).not.toHaveBeenCalled();
    expect(
      await client.zScore(Blog.key.removing, this.blog.id)
    ).toBeGreaterThan(now);
  });
});
