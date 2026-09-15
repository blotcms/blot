const EventEmitter = require("events");

describe("sse", function () {
  const ssePath = require.resolve("helper/sse");
  const subscriberPath = require.resolve("helper/redisSubscriber");
  let originalSubscriber;

  function mockSubscriber(exports) {
    require.cache[subscriberPath] = { exports: exports };
    delete require.cache[ssePath];
  }

  beforeEach(function () {
    originalSubscriber = require.cache[subscriberPath];
    jasmine.clock().install();
  });

  afterEach(function () {
    jasmine.clock().uninstall();
    delete require.cache[ssePath];
    if (originalSubscriber) require.cache[subscriberPath] = originalSubscriber;
    else delete require.cache[subscriberPath];
  });

  ["aborted", "close"].forEach(function (signal) {
    it("cleans up once on request " + signal + " and response close", function () {
      const cleanup = jasmine.createSpy("cleanup");
      let onMessage;
      mockSubscriber(function (options) {
        onMessage = options.onMessage;
        return { cleanup, setupPromise: Promise.resolve() };
      });

      const req = new EventEmitter();
      req.socket = { setTimeout: jasmine.createSpy("setTimeout") };
      const res = new EventEmitter();
      res.writeHead = jasmine.createSpy("writeHead");
      res.write = jasmine.createSpy("write");
      res.flushHeaders = jasmine.createSpy("flushHeaders");
      res.end = jasmine.createSpy("end");
      require("helper/sse")({ channel: function () { return "test"; } })(req, res);
      res.write.calls.reset();

      req.emit(signal);
      req.emit("close");
      res.emit("close");
      onMessage("late");
      jasmine.clock().tick(20000);

      expect(cleanup).toHaveBeenCalledTimes(1);
      expect(res.write).not.toHaveBeenCalled();
      expect(res.end).not.toHaveBeenCalled();
    });
  });

  it("ends the response when Redis setup fails", async function () {
    let rejectSetup;
    const cleanup = jasmine.createSpy("cleanup");
    const setupPromise = new Promise(function (_, reject) {
      rejectSetup = reject;
    });
    mockSubscriber(function () {
      return { cleanup, setupPromise };
    });

    const req = new EventEmitter();
    req.socket = { setTimeout: jasmine.createSpy("setTimeout") };
    const res = new EventEmitter();
    res.writeHead = jasmine.createSpy("writeHead");
    res.write = jasmine.createSpy("write");
    res.flushHeaders = jasmine.createSpy("flushHeaders");
    res.end = jasmine.createSpy("end");
    require("helper/sse")({ channel: function () { return "test"; } })(req, res);

    rejectSetup(new Error("connect failed"));
    await Promise.resolve();
    await Promise.resolve();

    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(res.end).toHaveBeenCalledTimes(1);
  });

  it("keeps preview-compatible ten-second heartbeats", function () {
    mockSubscriber(function () {
      return { cleanup: function () {}, setupPromise: Promise.resolve() };
    });
    const sse = require("helper/sse");
    expect(sse.HEARTBEAT_INTERVAL_MS).toBe(10000);
  });
});
