describe("cdn/purgeQueue", function () {
  global.test.blog();

  const config = require("config");
  const client = require("models/client");
  const folder = require("storage/folder");
  const contentVersion = require("helper/contentVersion");
  const { folderCdnPath } = require("blog/render/replaceFolderLinks/shared");

  const purgePath = require.resolve("helper/purgeCdnUrls");
  const queuePath = require.resolve("cdn/purgeQueue");
  const originalEnvironment = config.environment;
  const originalSecret = config.bunny.secret;

  let purgeQueue;
  let purged;
  let failing;

  // purgeQueue with helper/purgeCdnUrls swapped for a fake that records
  // each URL and fails those in `failing`
  beforeEach(async function () {
    purged = [];
    failing = new Set();

    require(purgePath);
    this.realPurgeExports = require.cache[purgePath].exports;
    require.cache[purgePath].exports = async (urls) => {
      purged.push(...urls);
      return urls.every((url) => !failing.has(url));
    };
    delete require.cache[queuePath];
    purgeQueue = require(queuePath);

    config.environment = "production";
    config.bunny.secret = "test-secret";

    await client.del([purgeQueue.KEY, purgeQueue.FAILURES]);
  });

  afterEach(async function () {
    config.environment = originalEnvironment;
    config.bunny.secret = originalSecret;
    require.cache[purgePath].exports = this.realPurgeExports;
    delete require.cache[queuePath];
    await client.del([purgeQueue.KEY, purgeQueue.FAILURES]);
  });

  const queued = async () => (await client.sMembers(purgeQueue.KEY)).sort();

  it("queues URLs without purging them", async function () {
    expect(await purgeQueue.add(["https://cdn/a", "https://cdn/b"])).toBe(true);

    expect(await queued()).toEqual(["https://cdn/a", "https://cdn/b"]);
    expect(purged).toEqual([]);
  });

  it("queues nothing outside production", async function () {
    config.environment = "development";

    await purgeQueue.add(["https://cdn/a"]);

    expect(await queued()).toEqual([]);
  });

  it("queues a deleted blog as a wildcard", async function () {
    await purgeQueue.blog("blog_abc");

    expect(await queued()).toEqual([config.cdn.origin + "/blog_abc/*"]);
  });

  it("queues a folder file's old URL, in both forms, when a write replaces it", async function () {
    const blogID = this.blog.id;

    await folder.write(blogID, "/a.txt", "one");
    const before = await require("models/file").get(blogID, "/a.txt");
    const version = contentVersion.fromFolderRecord(before);

    await folder.write(blogID, "/a.txt", "two");

    expect(await queued()).toEqual(
      [
        config.cdn.origin + folderCdnPath(blogID, version, "/a.txt"),
        config.cdn.origin + "/folder/v-" + version + "/" + blogID + "/a.txt",
      ].sort()
    );
  });

  it("queues nothing for a record that isn't a file", async function () {
    await purgeQueue.folderFile("blog_abc", "/dir", { type: "directory" });

    expect(await queued()).toEqual([]);
  });

  it("purges what is queued and empties the queue", async function () {
    await purgeQueue.add(["https://cdn/a", "https://cdn/b"]);

    await purgeQueue.drain();

    expect(purged.sort()).toEqual(["https://cdn/a", "https://cdn/b"]);
    expect(await queued()).toEqual([]);
  });

  it("keeps a URL whose purge failed, and counts the failure", async function () {
    failing.add("https://cdn/b");
    await purgeQueue.add(["https://cdn/a", "https://cdn/b"]);

    await purgeQueue.drain();

    expect(await queued()).toEqual(["https://cdn/b"]);
    expect(await client.hGet(purgeQueue.FAILURES, "https://cdn/b")).toBe("1");

    failing.clear();
    await purgeQueue.drain();

    expect(await queued()).toEqual([]);
    expect(await client.hLen(purgeQueue.FAILURES)).toBe(0);
  });

  it("gives up on a URL after its last attempt", async function () {
    spyOn(console, "error");
    failing.add("https://cdn/a");
    await purgeQueue.add(["https://cdn/a"]);
    await client.hSet(
      purgeQueue.FAILURES,
      "https://cdn/a",
      String(purgeQueue.MAX_ATTEMPTS - 1)
    );

    await purgeQueue.drain();

    expect(await queued()).toEqual([]);
    expect(await client.hLen(purgeQueue.FAILURES)).toBe(0);
  });

  it("removes a deleted blog's Perma-Cache directory", async function () {
    const permaCache = require("cdn/permaCache");
    spyOn(permaCache, "removeBlog").and.returnValue(Promise.resolve(true));
    await purgeQueue.blog("blog_abc");

    await purgeQueue.drain();

    expect(permaCache.removeBlog).toHaveBeenCalledWith("blog_abc");
    expect(purged).toEqual([]);
    expect(await queued()).toEqual([]);
  });

  it("stops once its signal aborts", async function () {
    await purgeQueue.add(["https://cdn/a"]);

    await purgeQueue.drain({ aborted: true });

    expect(purged).toEqual([]);
    expect(await queued()).toEqual(["https://cdn/a"]);
  });
});
