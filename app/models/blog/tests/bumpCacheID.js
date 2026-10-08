describe("Blog.bumpCacheID", function () {
  const { SimpleError } = require("redis");
  const setPath = require.resolve("../set");
  const bumpCacheIDPath = require.resolve("../bumpCacheID");

  let originalSet, originalBumpCacheID, bumpCacheID, set, replies;

  function unavailable() {
    return new SimpleError("NOREPLICAS Not enough good replicas to write.");
  }

  beforeEach(function () {
    // Each call to set answers with the next reply, then succeeds
    replies = [];
    set = jasmine
      .createSpy("set")
      .and.callFake(function (blogID, updates, callback) {
        callback(replies.length ? replies.shift() : null);
      });

    originalSet = require.cache[setPath];
    originalBumpCacheID = require.cache[bumpCacheIDPath];
    require.cache[setPath] = {
      id: setPath,
      filename: setPath,
      loaded: true,
      exports: set,
    };
    delete require.cache[bumpCacheIDPath];
    bumpCacheID = require("../bumpCacheID");

    jasmine.clock().install();
    jasmine.clock().mockDate(new Date("2026-01-01T00:00:00Z"));
  });

  afterEach(function () {
    jasmine.clock().uninstall();

    if (originalSet) require.cache[setPath] = originalSet;
    else delete require.cache[setPath];

    if (originalBumpCacheID) require.cache[bumpCacheIDPath] = originalBumpCacheID;
    else delete require.cache[bumpCacheIDPath];
  });

  it("bumps the cacheID", function () {
    const callback = jasmine.createSpy("callback");

    bumpCacheID("blog_test", callback);

    expect(set).toHaveBeenCalledTimes(1);
    expect(set).toHaveBeenCalledWith(
      "blog_test",
      { cacheID: jasmine.any(Number) },
      jasmine.any(Function)
    );
    expect(callback).toHaveBeenCalledTimes(1);
    expect(callback).toHaveBeenCalledWith(null);
  });

  it("retries while Redis is unavailable, without holding the callback", function () {
    const callback = jasmine.createSpy("callback");
    const onRetried = jasmine.createSpy("onRetried");
    const error = unavailable();

    replies = [error, unavailable()];
    bumpCacheID("blog_test", callback, onRetried);

    expect(callback).toHaveBeenCalledTimes(1);
    expect(callback).toHaveBeenCalledWith(error);
    expect(set).toHaveBeenCalledTimes(1);

    jasmine.clock().tick(5 * 1000);
    expect(set).toHaveBeenCalledTimes(2);
    expect(onRetried).not.toHaveBeenCalled();

    jasmine.clock().tick(5 * 1000);
    expect(set).toHaveBeenCalledTimes(3);
    expect(onRetried).toHaveBeenCalledTimes(1);

    jasmine.clock().tick(60 * 1000);
    expect(set).toHaveBeenCalledTimes(3);
    expect(callback).toHaveBeenCalledTimes(1);
  });

  it("gives up after about a minute", function () {
    const onRetried = jasmine.createSpy("onRetried");

    replies = Array.from({ length: 100 }, unavailable);
    bumpCacheID("blog_test", function () {}, onRetried);

    jasmine.clock().tick(5 * 60 * 1000);

    // The first attempt, then one every 5s for 60s
    expect(set).toHaveBeenCalledTimes(13);
    expect(onRetried).not.toHaveBeenCalled();
  });

  it("does not retry other errors", function () {
    const callback = jasmine.createSpy("callback");
    const error = new Error("Something else went wrong");

    replies = [error];
    bumpCacheID("blog_test", callback);

    expect(callback).toHaveBeenCalledTimes(1);
    expect(callback).toHaveBeenCalledWith(error);

    jasmine.clock().tick(60 * 1000);
    expect(set).toHaveBeenCalledTimes(1);
  });

  it("stops retrying if a retry fails for another reason", function () {
    const onRetried = jasmine.createSpy("onRetried");

    replies = [unavailable(), new Error("Something else went wrong")];
    bumpCacheID("blog_test", function () {}, onRetried);

    jasmine.clock().tick(60 * 1000);
    expect(set).toHaveBeenCalledTimes(2);
    expect(onRetried).not.toHaveBeenCalled();
  });
});
