describe("entry.get", function () {
  require("./setup")();

  var get = require("../get");
  var redis = require("models/client");

  var original = get.BATCH_SIZE;
  var paths = ["/a.txt", "/b.txt", "/c.txt", "/d.txt", "/e.txt"];

  var getMany = function (blogID, ids) {
    return new Promise(function (resolve) {
      get(blogID, ids, function (entries, err) {
        resolve({ entries: entries, err: err });
      });
    });
  };

  afterEach(function () {
    get.BATCH_SIZE = original;
  });

  it("reads entries in batches, preserving order and skipping missing ones", async function () {
    for (var path of paths) await this.set(path, "Hello from " + path);

    get.BATCH_SIZE = 2;
    spyOn(redis, "mGet").and.callThrough();

    var ids = ["/a.txt", "/b.txt", "/missing.txt", "/c.txt", "/d.txt", "/e.txt"];
    var result = await getMany(this.blog.id, ids);

    expect(redis.mGet).toHaveBeenCalledTimes(3);
    expect(result.err).toBeUndefined();
    expect(result.entries.map((entry) => entry.path)).toEqual(paths);
  });

  it("yields to the event loop between batches", async function () {
    for (var path of paths) await this.set(path, "Hello from " + path);

    get.BATCH_SIZE = 2;

    var ticks = 0;
    var interval = setInterval(function () {
      ticks++;
    }, 0);

    var result = await getMany(this.blog.id, paths);
    clearInterval(interval);

    expect(result.entries.length).toEqual(paths.length);
    expect(ticks).toBeGreaterThan(0);
  });

  it("returns an empty list and the error if any batch fails", async function () {
    for (var path of paths) await this.set(path, "Hello from " + path);

    get.BATCH_SIZE = 2;
    var calls = 0;
    var mGet = redis.mGet.bind(redis);
    spyOn(console, "error");
    spyOn(redis, "mGet").and.callFake(function (keys) {
      return ++calls === 2 ? Promise.reject(new Error("boom")) : mGet(keys);
    });

    var result = await getMany(this.blog.id, paths);

    expect(result.entries).toEqual([]);
    expect(result.err.message).toEqual("boom");
  });

  it("still resolves a single path to one entry, or nothing", async function () {
    await this.set("/a.txt", "Hello");

    var found = await this.get("/a.txt");
    var missing = await this.get("/missing.txt");

    expect(found.path).toEqual("/a.txt");
    expect(missing).toBeUndefined();
  });
});
