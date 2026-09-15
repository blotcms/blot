describe("local client init", function () {
  const initPath = require.resolve("clients/local/init");
  const subscriberPath = require.resolve("helper/redisSubscriber");
  const setupPath = require.resolve("clients/local/setup");
  const blogPath = require.resolve("models/blog");

  let originals;
  let addedListeners;

  function snapshotListeners() {
    return {
      SIGTERM: process.listeners("SIGTERM").slice(),
      SIGINT: process.listeners("SIGINT").slice(),
      exit: process.listeners("exit").slice(),
    };
  }

  function removeAddedListeners(before) {
    ["SIGTERM", "SIGINT", "exit"].forEach(function (event) {
      process.listeners(event).forEach(function (listener) {
        if (before[event].indexOf(listener) === -1) {
          process.removeListener(event, listener);
        }
      });
    });
  }

  function restore(path, original) {
    if (original) require.cache[path] = original;
    else delete require.cache[path];
  }

  beforeEach(function () {
    originals = {
      subscriber: require.cache[subscriberPath],
      setup: require.cache[setupPath],
      blog: require.cache[blogPath],
      init: require.cache[initPath],
    };
    addedListeners = snapshotListeners();
  });

  afterEach(function () {
    process.listeners("SIGTERM").forEach(function (listener) {
      if (addedListeners.SIGTERM.indexOf(listener) === -1) listener();
    });
    removeAddedListeners(addedListeners);
    delete require.cache[initPath];
    restore(subscriberPath, originals.subscriber);
    restore(setupPath, originals.setup);
    restore(blogPath, originals.blog);
    restore(initPath, originals.init);
  });

  it("subscribes through redisSubscriber and quits on SIGTERM", async function () {
    const cleanup = jasmine.createSpy("cleanup").and.returnValue(Promise.resolve());
    const setup = jasmine.createSpy("setup");
    let captured;

    require.cache[subscriberPath] = {
      exports: function (options) {
        captured = options;
        return { cleanup: cleanup, setupPromise: Promise.resolve() };
      },
    };
    require.cache[setupPath] = { exports: setup };
    require.cache[blogPath] = {
      exports: {
        getAllIDs: function (callback) {
          callback(null, []);
        },
        get: function () {},
      },
    };
    delete require.cache[initPath];

    await require("clients/local/init")();

    expect(captured.channel).toBe("clients:local:new-folder");
    captured.onMessage(JSON.stringify({ blogID: "blog_1" }), captured.channel);
    expect(setup).toHaveBeenCalledWith("blog_1", jasmine.any(Function));

    const shutdown = process.listeners("SIGTERM").find(function (listener) {
      return addedListeners.SIGTERM.indexOf(listener) === -1;
    });
    shutdown();
    expect(cleanup).toHaveBeenCalledTimes(1);
  });
});
