describe("postgres entries", function () {
  require("models/entry/tests/setup")();

  const postgres = require("models/postgres");
  const entries = require("models/postgres/entries");
  const queries = require("models/postgres/queries");
  const verifyBlog = require("models/postgres/verify");
  const redis = require("models/client");
  const entryKey = require("models/entry/key").entry;
  const setEntry = require("util").promisify(require("models/entry/set"));

  // The test runners all set BLOT_POSTGRES_URL (scripts/tests/ci/run-lanes.sh,
  // scripts/tests/invoke.sh), so a spec that silently skipped would hide a
  // broken dual write
  it("is configured", function () {
    expect(postgres.enabled()).toBe(true);
  });

  if (!postgres.enabled()) return;

  async function row(blogID, path) {
    const { rows } = await postgres.query(
      "SELECT * FROM entries WHERE blog_id = $1 AND path = $2",
      [blogID, path]
    );
    return rows[0];
  }

  async function tagsOf(blogID, path) {
    const { rows } = await postgres.query(
      "SELECT tag, name FROM entry_tags WHERE blog_id = $1 AND path = $2 ORDER BY tag",
      [blogID, path]
    );
    return rows;
  }

  async function dependenciesOf(blogID, path) {
    const { rows } = await postgres.query(
      "SELECT dependency_key, dependency FROM entry_dependencies WHERE blog_id = $1 AND path = $2 ORDER BY dependency_key",
      [blogID, path]
    );
    return rows;
  }

  async function redisEntry(blogID, path) {
    return JSON.parse(await redis.get(entryKey(blogID, path)));
  }

  afterEach(function () {
    entries._resetBackoff();
  });

  it("writes the entry, its tags and its dependencies with Entry.set", async function () {
    await this.set("/a.txt", "Tags: Apple, Banana Split, apple\n\nHello <img src='/Pic.JPG'>");
    await setEntry(this.blog.id, "/a.txt", { dependencies: ["/Pic.JPG", "/pic.jpg", "/b.txt"] });

    const stored = await redisEntry(this.blog.id, "/a.txt");
    const result = await row(this.blog.id, "/a.txt");

    expect(result.data).toEqual(stored);
    expect(result.url).toEqual(stored.url);
    expect(result.date_stamp).toEqual(stored.dateStamp);
    expect(result.deleted).toBe(false);
    expect(result.expires_at).toBe(null);

    expect(await tagsOf(this.blog.id, "/a.txt")).toEqual([
      { tag: "apple", name: "Apple" },
      { tag: "banana-split", name: "Banana Split" },
    ]);

    expect(await dependenciesOf(this.blog.id, "/a.txt")).toEqual([
      { dependency_key: "/b.txt", dependency: "/b.txt" },
      { dependency_key: "/pic.jpg", dependency: "/Pic.JPG" },
    ]);

    expect(await queries.dependents(this.blog.id, "/pic.jpg")).toEqual(["/a.txt"]);
    expect(await queries.tagged(this.blog.id, "apple")).toEqual([stored.id]);
    expect(await queries.byUrl(this.blog.id, stored.url)).toEqual("/a.txt");
  });

  it("replaces the tags and dependencies when they change", async function () {
    await this.set("/a.txt", "Tags: one, two\n\nHello");
    await setEntry(this.blog.id, "/a.txt", { dependencies: ["/x.jpg"] });
    await setEntry(this.blog.id, "/a.txt", { tags: ["Three"], dependencies: ["/y.jpg"] });

    expect(await tagsOf(this.blog.id, "/a.txt")).toEqual([{ tag: "three", name: "Three" }]);
    expect(await dependenciesOf(this.blog.id, "/a.txt")).toEqual([
      { dependency_key: "/y.jpg", dependency: "/y.jpg" },
    ]);
  });

  it("keeps a deleted entry, without tags or dependencies, until Redis expires it", async function () {
    await this.set("/a.txt", "Tags: one\n\nHello");
    await setEntry(this.blog.id, "/a.txt", { dependencies: ["/x.jpg"] });
    await this.drop("/a.txt");

    const result = await row(this.blog.id, "/a.txt");
    const score = await redis.zScore("blog:" + this.blog.id + ":deleted", "/a.txt");

    expect(result.deleted).toBe(true);
    expect(result.deleted_at).toEqual(score);
    expect(result.expires_at).toBeGreaterThan(Date.now());
    expect(await tagsOf(this.blog.id, "/a.txt")).toEqual([]);
    expect(await dependenciesOf(this.blog.id, "/a.txt")).toEqual([]);
    expect((await queries.list(this.blog.id, "deleted")).map((r) => r.id)).toEqual(["/a.txt"]);

    // Redis expires the key
    await redis.del(entryKey(this.blog.id, "/a.txt"));
    await entries.syncBlog(this.blog.id);

    expect(await row(this.blog.id, "/a.txt")).toBeUndefined();
  });

  it("prunes deleted entries whose key has expired", async function () {
    await this.set("/a.txt", "Hello");
    await this.set("/b.txt", "Hello");
    await this.drop("/a.txt");
    await this.drop("/b.txt");

    // /a.txt's key expired two hours ago
    await postgres.query(
      "UPDATE entries SET expires_at = $2 WHERE blog_id = $1 AND path = '/a.txt'",
      [this.blog.id, Date.now() - 2 * 60 * 60 * 1000]
    );

    expect(await entries.pruneExpired()).toBe(1);
    expect(await row(this.blog.id, "/a.txt")).toBeUndefined();
    expect(await row(this.blog.id, "/b.txt")).toBeDefined();
  });

  it("matches the Redis lists", async function () {
    await this.set("/a.txt", "Date: 2020-01-01\n\nA");
    await this.set("/b.txt", "Date: 2021-01-01\n\nB");
    await this.set("/drafts/c.txt", "C");
    await this.set("/Pages/d.txt", "D");
    await this.set("/e.txt", "Date: 2999-01-01\n\nScheduled");
    await this.set("/f.txt", "F");
    await this.drop("/f.txt");

    for (const name of Object.keys(queries.LISTS)) {
      const fromRedis = await redis.zRangeWithScores("blog:" + this.blog.id + ":" + name, 0, -1);
      const fromPostgres = await queries.list(this.blog.id, name);
      expect(fromPostgres.map((r) => [r.id, r.score]))
        .withContext(name)
        .toEqual(fromRedis.map((r) => [r.value, r.score]));
    }

    const report = await verifyBlog(this.blog.id);
    expect(report.indexes).toEqual([]);
    expect(report.ok).toBe(true);
  });

  it("stores entries jsonb would refuse", async function () {
    await this.set("/a.txt", "Hello");
    await setEntry(this.blog.id, "/a.txt", { title: "Nul\u0000 and lone \ud800 surrogate" });

    const result = await row(this.blog.id, "/a.txt");
    expect(result.title).toEqual("Nul and lone � surrogate");
    expect((await verifyBlog(this.blog.id)).ok).toBe(true);
  });

  it("finds and fixes rows which differ from Redis", async function () {
    await this.set("/a.txt", "Hello");
    await this.set("/b.txt", "Hello");

    await postgres.query(
      "UPDATE entries SET data = data || '{\"title\": \"Wrong\"}' WHERE blog_id = $1 AND path = '/a.txt'",
      [this.blog.id]
    );
    await postgres.query("DELETE FROM entries WHERE blog_id = $1 AND path = '/b.txt'", [
      this.blog.id,
    ]);
    await postgres.query(
      `INSERT INTO entries (blog_id, path, id, date_stamp, created, updated, data)
       VALUES ($1, '/gone.txt', '/gone.txt', 0, 0, 0, '{}')`,
      [this.blog.id]
    );

    const report = await verifyBlog(this.blog.id);
    expect(report.ok).toBe(false);
    expect(report.entries.different).toEqual(["/a.txt"]);
    expect(report.entries.missing).toEqual(["/b.txt"]);
    expect(report.entries.extra).toEqual(["/gone.txt"]);

    await entries.syncPaths(this.blog.id, report.paths);

    expect((await verifyBlog(this.blog.id)).ok).toBe(true);
  });

  it("never fails the Redis write, and marks the blog for repair", async function () {
    await this.set("/a.txt", "Hello");

    spyOn(postgres, "transaction").and.callFake(() => Promise.reject(new Error("down")));
    spyOn(console, "error");

    await setEntry(this.blog.id, "/a.txt", { title: "Changed" });

    expect((await redisEntry(this.blog.id, "/a.txt")).title).toEqual("Changed");
    expect(await redis.sIsMember(entries.DIRTY_KEY, this.blog.id)).toBeTruthy();

    // Later saves skip Postgres while it is failing
    await setEntry(this.blog.id, "/a.txt", { title: "Again" });
    expect(postgres.transaction).toHaveBeenCalledTimes(1);

    postgres.transaction.and.callThrough();

    const result = await entries.repairDirty();

    expect(result.repaired).toBeGreaterThanOrEqual(1);
    expect(await redis.sIsMember(entries.DIRTY_KEY, this.blog.id)).toBeFalsy();
    expect((await row(this.blog.id, "/a.txt")).title).toEqual("Again");
  });

  it("removes the blog's rows when the blog is removed", async function () {
    await this.set("/a.txt", "Hello");
    expect(await row(this.blog.id, "/a.txt")).toBeDefined();

    await new Promise((resolve, reject) =>
      require("models/blog").remove(this.blog.id, (err) => (err ? reject(err) : resolve()))
    );

    const { rows } = await postgres.query("SELECT count(*)::int AS n FROM entries WHERE blog_id = $1", [
      this.blog.id,
    ]);
    expect(rows[0].n).toBe(0);
  });

  it("writes what Redis holds when saves race", async function () {
    await this.set("/a.txt", "Hello");

    // Two saves whose Postgres writes run in the opposite order to their
    // Redis writes: the later Redis value must win
    const key = entryKey(this.blog.id, "/a.txt");
    const entry = await redisEntry(this.blog.id, "/a.txt");
    await redis.set(key, JSON.stringify({ ...entry, title: "First" }));
    const first = entries.syncPaths(this.blog.id, ["/a.txt"]);
    await redis.set(key, JSON.stringify({ ...entry, title: "Second" }));
    await Promise.all([entries.syncPaths(this.blog.id, ["/a.txt"]), first]);

    expect((await row(this.blog.id, "/a.txt")).title).toEqual("Second");
  });
});
