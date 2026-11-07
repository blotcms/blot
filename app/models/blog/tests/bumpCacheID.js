describe("Blog.bumpCacheID", function () {
  const { SimpleError } = require("redis");
  const setPath = require.resolve("../set");
  const bumpCacheIDPath = require.resolve("../bumpCacheID");

  let originalSet, originalBumpCacheID, bumpCacheID, set, replies;

  function unavailable() {
    return new SimpleError("NOREPLICAS Not enough good replicas to write.");
  }

  // The mocked clock leaves promises alone: let the settled set() calls
  // reach bumpCacheID's handlers
  function flush() {
    return new Promise((resolve) => setImmediate(resolve));
  }

  beforeEach(function () {
    // Each call to set answers with the next reply, then succeeds
    replies = [];
    set = jasmine.createSpy("set").and.callFake(async function () {
      const reply = replies.length ? replies.shift() : null;
      if (reply) throw reply;
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

    if (originalBumpCacheID)
      require.cache[bumpCacheIDPath] = originalBumpCacheID;
    else delete require.cache[bumpCacheIDPath];
  });

  it("bumps the cacheID", async function () {
    await bumpCacheID("blog_test");

    expect(set).toHaveBeenCalledTimes(1);
    expect(set).toHaveBeenCalledWith("blog_test", {
      cacheID: jasmine.any(Number),
    });
  });

  it("retries while Redis is unavailable, rejecting after the first attempt", async function () {
    const onRetried = jasmine.createSpy("onRetried");
    const error = unavailable();

    replies = [error, unavailable()];
    await expectAsync(bumpCacheID("blog_test", onRetried)).toBeRejectedWith(
      error
    );
    expect(set).toHaveBeenCalledTimes(1);

    jasmine.clock().tick(5 * 1000);
    await flush();
    expect(set).toHaveBeenCalledTimes(2);
    expect(onRetried).not.toHaveBeenCalled();

    jasmine.clock().tick(5 * 1000);
    await flush();
    expect(set).toHaveBeenCalledTimes(3);
    expect(onRetried).toHaveBeenCalledTimes(1);

    jasmine.clock().tick(60 * 1000);
    await flush();
    expect(set).toHaveBeenCalledTimes(3);
  });

  it("gives up after about a minute", async function () {
    const onRetried = jasmine.createSpy("onRetried");

    replies = Array.from({ length: 100 }, unavailable);
    await bumpCacheID("blog_test", onRetried).catch(function () {});

    // Each retry is scheduled once the previous attempt has settled
    for (let i = 0; i < 60; i++) {
      jasmine.clock().tick(5 * 1000);
      await flush();
    }

    // The first attempt, then one every 5s for 60s
    expect(set).toHaveBeenCalledTimes(13);
    expect(onRetried).not.toHaveBeenCalled();
  });

  it("does not retry other errors", async function () {
    const error = new Error("Something else went wrong");

    replies = [error];
    await expectAsync(bumpCacheID("blog_test")).toBeRejectedWith(error);

    jasmine.clock().tick(60 * 1000);
    await flush();
    expect(set).toHaveBeenCalledTimes(1);
  });

  it("stops retrying if a retry fails for another reason", async function () {
    const onRetried = jasmine.createSpy("onRetried");

    replies = [unavailable(), new Error("Something else went wrong")];
    await bumpCacheID("blog_test", onRetried).catch(function () {});

    jasmine.clock().tick(60 * 1000);
    await flush();
    expect(set).toHaveBeenCalledTimes(2);
    expect(onRetried).not.toHaveBeenCalled();
  });
});
